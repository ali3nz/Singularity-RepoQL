"""Deterministic tests for the native Ghost host using an in-memory scheduler.

These tests never query or mutate Windows Task Scheduler and never launch Codex.
Temporary ledgers and durable state are created under work/evidence/luna-b.
"""
from __future__ import annotations

from copy import deepcopy
from dataclasses import replace
from contextlib import redirect_stdout
from datetime import datetime, timedelta, timezone
import hashlib
import io
import json
import os
from pathlib import Path
import sys
import tempfile
import threading
import unittest
from urllib.error import HTTPError
from urllib.request import Request, urlopen
from unittest.mock import patch
from zoneinfo import ZoneInfo


HERE = Path(__file__).resolve().parent
ROOT = HERE.parents[1]
EVIDENCE = ROOT.parent / "evidence" / "luna-b"
EVIDENCE.mkdir(parents=True, exist_ok=True)
sys.path.insert(0, str(HERE))

import ghost_scheduler_host as host_mod  # noqa: E402


SID = "S-1-5-21-1000000000-1000000000-1000000000-1001"
DRAFT_ID = "a" * 32
JOB_REQUEST = "register_0001"
try:
    NOW = datetime(2026, 3, 1, 9, 0, tzinfo=ZoneInfo(host_mod.TIMEZONE_IANA))
except Exception as exc:  # ZoneInfoNotFoundError: Windows Python ships no system tz database
    raise unittest.SkipTest(
        f"time zone {host_mod.TIMEZONE_IANA!r} is unavailable ({exc}); "
        "install the 'tzdata' package to run the Ghost scheduler tests"
    )


def make_draft(
    *,
    draft_id: str = DRAFT_ID,
    revision: int = 1,
    prompt: str = "Summarize the workspace status.",
    date: str = "2026-03-01",
    time: str = "09:00",
    recurrence: str = "daily",
) -> dict:
    return {
        "id": draft_id,
        "revision": revision,
        "title": "Morning review",
        "prompt": prompt,
        "date": date,
        "time": time,
        "recurrence": recurrence,
        "timezone": host_mod.TIMEZONE_IANA,
        "active": False,
        "status": "draft",
    }


class FakeDraftReader:
    def __init__(self, *rows: dict):
        self.rows = {(row["id"], row["revision"]): deepcopy(row) for row in rows}

    def add(self, row: dict) -> None:
        self.rows[(row["id"], row["revision"])] = deepcopy(row)

    def get(self, draft_id: str, expected_revision: int) -> dict:
        row = self.rows.get((draft_id, expected_revision))
        if row is None:
            latest = [revision for current_id, revision in self.rows if current_id == draft_id]
            if not latest:
                raise host_mod.HostError(404, "unknown_draft")
            raise host_mod.HostError(409, "draft_changed_refresh_required")
        return deepcopy(row)


class FakeTaskScheduler(host_mod.TaskScheduler):
    def __init__(self):
        self.config = None
        self.tasks: dict[str, dict] = {}
        self.events: list[str] = []
        self.fail_enable = False

    def bind_config(self, config):
        self.config = config

    def current_identity(self):
        return SID

    def verify_private_path(self, path, owner_sid):
        if owner_sid != SID or not Path(path).exists():
            raise host_mod.HostError(503, "private_acl_unverified")

    def timezone_id(self):
        return host_mod.TIMEZONE_WINDOWS

    def list_tasks(self):
        self.events.append("list")
        return deepcopy(list(self.tasks.values()))

    def _snapshot(self, job: dict, enabled: bool, *, state: str = "Ready") -> dict:
        recurrence = job["recurrence"]
        trigger = {
            "kind": {"once": "Time", "daily": "Daily", "weekly": "Weekly"}[recurrence],
            "startBoundary": host_mod._schedule_local_boundary(job),
            "enabled": True,
        }
        if recurrence == "daily":
            trigger["daysInterval"] = 1
        elif recurrence == "weekly":
            trigger["weeksInterval"] = 1
            trigger["daysOfWeek"] = [
                datetime.strptime(job["date"], "%Y-%m-%d").strftime("%A")
            ]
        return {
            "taskName": host_mod._job_name(job["jobId"]),
            "taskPath": host_mod.TASK_PATH,
            "description": host_mod._expected_description(job),
            "enabled": enabled,
            "state": state,
            "actions": [
                {
                    "execute": str(self.config.python_exe.with_name("pythonw.exe")),
                    "arguments": host_mod._expected_action_arguments(job, self.config),
                    "workingDirectory": str(self.config.workspace),
                }
            ],
            "triggers": [trigger],
            "principal": {
                "userId": self.config.execution_identity_sid,
                "logonType": "InteractiveToken",
                "runLevel": "Limited",
            },
            "settings": {"startWhenAvailable": False, "multipleInstances": "IgnoreNew"},
        }

    def create_disabled(self, job):
        self.events.append("create_disabled")
        name = host_mod._job_name(job["jobId"])
        if name in self.tasks:
            raise host_mod.HostError(503, "scheduler_task_collision")
        self.tasks[name] = self._snapshot(job, False)

    def replace_disabled(self, old_job, new_job):
        self.events.append("replace_disabled")
        name = host_mod._job_name(old_job["jobId"])
        old = self.tasks.get(name)
        if old is None or old["enabled"] or not host_mod._matching_task(
            old, old_job, self.config, enabled=False
        ):
            raise host_mod.HostError(503, "scheduler_update_unverified")
        self.tasks[name] = self._snapshot(new_job, False)

    def enable(self, job):
        self.events.append("enable")
        if self.fail_enable:
            raise host_mod.HostError(503, "scheduler_enable_unverified")
        name = host_mod._job_name(job["jobId"])
        task = self.tasks.get(name)
        if task is None or task["enabled"] or not host_mod._matching_task(
            task, job, self.config, enabled=False
        ):
            raise host_mod.HostError(503, "scheduler_enable_unverified")
        task["enabled"] = True

    def disable(self, job):
        self.events.append("disable")
        name = host_mod._job_name(job["jobId"])
        task = self.tasks.get(name)
        if task is None or task["state"] == "Running":
            raise host_mod.HostError(503, "scheduler_disable_unverified")
        if not host_mod._matching_task(
            task, job, self.config, enabled=bool(task["enabled"])
        ):
            raise host_mod.HostError(503, "scheduler_foreign_task_refused")
        task["enabled"] = False

    def remove(self, job):
        self.events.append("remove")
        name = host_mod._job_name(job["jobId"])
        task = self.tasks.get(name)
        if task is None or task["enabled"] or not host_mod._matching_task(
            task, job, self.config, enabled=False
        ):
            raise host_mod.HostError(503, "scheduler_remove_unverified")
        del self.tasks[name]


class GhostHostTests(unittest.TestCase):
    def test_host_disables_bytecode_before_project_module_imports(self):
        self.assertIs(host_mod.sys.dont_write_bytecode, True)
        self.assertEqual(host_mod.os.environ.get("PYTHONDONTWRITEBYTECODE"), "1")

    def setUp(self):
        self.temp = tempfile.TemporaryDirectory(prefix="host-test-", dir=EVIDENCE)
        self.base = Path(self.temp.name)
        state_dir = self.base / "state"
        draft_dir = self.base / "drafts"
        workspace = self.base / "workspace"
        for folder in (state_dir, draft_dir, workspace):
            folder.mkdir()
        python_exe = self.base / "python.exe"
        runner_exe = self.base / "codex.exe"
        config_path = state_dir / "private ghost config.json"
        python_exe.touch()
        runner_exe.touch()
        config_path.touch()
        self.config = host_mod.HostConfig(
            state_dir=state_dir,
            draft_state_dir=draft_dir,
            control_key="k" * 48,
            owner_sid=SID,
            execution_identity_sid=SID,
            python_exe=python_exe,
            host_script=HERE / "ghost_scheduler_host.py",
            task_script=HERE / "ghost_task_scheduler.ps1",
            runner_exe=runner_exe,
            runner_arguments=(),
            config_path=config_path,
            workspace=workspace,
            listen_host="127.0.0.1",
            listen_port=18473,
            sandbox="read-only",
            run_timeout_seconds=60,
        )
        self.scheduler = FakeTaskScheduler()
        self.drafts = FakeDraftReader(make_draft())
        self.runs: list[str] = []

        def runner(prompt):
            self.runs.append(prompt)
            return 0

        self.host = host_mod.GhostScheduler(
            self.config,
            self.scheduler,
            drafts=self.drafts,
            runner=runner,
            clock=lambda: NOW,
        )

    def tearDown(self):
        self.temp.cleanup()

    def register(self, request_id=JOB_REQUEST, draft_id=DRAFT_ID, revision=1):
        return self.host.handle_action(
            {
                "action": "register-schedule",
                "confirm": True,
                "requestId": request_id,
                "draftId": draft_id,
                "expectedDraftRevision": revision,
            }
        )

    def update(self, request_id, job_id, expected_revision, draft_id, draft_revision):
        return self.host.handle_action(
            {
                "action": "update-schedule",
                "confirm": True,
                "requestId": request_id,
                "jobId": job_id,
                "expectedRevision": expected_revision,
                "draftId": draft_id,
                "expectedDraftRevision": draft_revision,
            }
        )

    def test_register_requires_disabled_readback_before_activation(self):
        status, response = self.register()
        self.assertEqual(status, 200)
        self.assertEqual(self.scheduler.events[:4], ["create_disabled", "list", "enable", "list"])
        self.assertTrue(response["active"])
        self.assertEqual(response["ownerSid"], SID)
        self.assertEqual(response["executionIdentitySid"], SID)
        self.assertEqual(response["promptSha256"], hashlib.sha256(make_draft()["prompt"].encode()).hexdigest())
        state = self.host.get_state()
        self.assertEqual(state["ownerSid"], SID)
        self.assertEqual(
            state["capabilities"],
            {"schedule": {"register": True, "update": True, "cancel": True, "readback": True, "execute": True}},
        )
        self.assertEqual(len(state["schedules"]), 1)
        self.assertEqual(state["schedules"][0]["principalSid"], SID)

    def test_request_replay_is_idempotent_and_payload_conflict_is_409(self):
        _, first = self.register()
        events = list(self.scheduler.events)
        _, replay = self.register()
        self.assertTrue(replay["replayed"])
        self.assertEqual(replay["jobId"], first["jobId"])
        self.assertEqual(
            [event for event in self.scheduler.events if event != "list"],
            [event for event in events if event != "list"],
        )
        changed = {
            "action": "register-schedule",
            "confirm": True,
            "requestId": JOB_REQUEST,
            "draftId": DRAFT_ID,
            "expectedDraftRevision": 2,
        }
        with self.assertRaises(host_mod.HostError) as caught:
            self.host.handle_action(changed)
        self.assertEqual(caught.exception.status, 409)
        self.assertEqual(caught.exception.code, "request_id_payload_conflict")
        self.assertTrue(next(iter(self.scheduler.tasks.values()))["enabled"])

    def test_update_binds_prompt_revisions_and_stale_action_refuses(self):
        _, registered = self.register()
        job_id = registered["jobId"]
        self.drafts.add(make_draft(revision=2, prompt="Summarize the workspace status."))
        _, same_prompt = self.update("update_0001", job_id, 1, DRAFT_ID, 2)
        self.assertEqual(same_prompt["revision"], 2)
        self.assertEqual(same_prompt["promptRevision"], 1)
        self.drafts.add(make_draft(revision=3, prompt="Review the workspace changes."))
        _, changed_prompt = self.update("update_0002", job_id, 2, DRAFT_ID, 3)
        self.assertEqual(changed_prompt["revision"], 3)
        self.assertEqual(changed_prompt["promptRevision"], 2)
        with self.assertRaises(host_mod.HostError) as caught:
            self.host.execute_job(job_id, 1, 1, hashlib.sha256(make_draft()["prompt"].encode()).hexdigest())
        self.assertEqual(caught.exception.status, 409)
        result = self.host.execute_job(
            job_id,
            3,
            2,
            changed_prompt["promptSha256"],
        )
        duplicate = self.host.execute_job(
            job_id,
            3,
            2,
            changed_prompt["promptSha256"],
        )
        self.assertEqual(result["receipt"]["status"], "succeeded")
        self.assertEqual(duplicate["receipt"]["status"], "succeeded")
        self.assertEqual(self.runs, ["Review the workspace changes."])
        durable = self.host.store.read()
        per_job = durable["jobs"][0]["executionReceipts"][0]
        global_copy = durable["executionReceipts"][0]
        self.assertEqual(per_job, global_copy)
        self.assertEqual(global_copy["exitCode"], 0)

    def test_runner_exit_code_is_durable_and_output_is_not_captured(self):
        _, registered = self.register()
        self.host.runner = lambda _prompt: 17
        result = self.host.execute_job(
            registered["jobId"],
            registered["revision"],
            registered["promptRevision"],
            registered["promptSha256"],
        )
        self.assertEqual(result["receipt"]["status"], "failed")
        self.assertEqual(result["receipt"]["exitCode"], 17)
        self.assertEqual(result["receipt"]["error"], "runner_nonzero_exit")
        durable = self.host.store.read()
        self.assertEqual(
            durable["jobs"][0]["executionReceipts"][0],
            durable["executionReceipts"][0],
        )

    def test_private_runner_arguments_are_fixed_and_prompt_only_uses_stdin(self):
        runner = self.base / "free-provider.exe"
        runner.touch()
        data = {
            "schema": host_mod.CONFIG_SCHEMA,
            "stateDirectory": str(self.config.state_dir),
            "draftStateDirectory": str(self.config.draft_state_dir),
            "controlKey": self.config.control_key,
            "ownerSid": SID,
            "executionIdentitySid": SID,
            "pythonExe": str(self.config.python_exe),
            "runnerExecutable": str(runner),
            "runnerArguments": ["run", "--model", "free-tier"],
            "workspace": str(self.config.workspace),
            "listenHost": self.config.listen_host,
            "listenPort": self.config.listen_port,
            "sandbox": self.config.sandbox,
            "runTimeoutSeconds": self.config.run_timeout_seconds,
        }
        config = host_mod.HostConfig.from_mapping(
            data, config_path=self.config.config_path
        )
        scheduler = FakeTaskScheduler()
        host = host_mod.GhostScheduler(config, scheduler, drafts=self.drafts, clock=lambda: NOW)
        with patch.object(host_mod.subprocess, "run") as run:
            run.return_value.returncode = 0
            self.assertEqual(host._run_configured_runner("private prompt"), 0)
        args, kwargs = run.call_args
        self.assertEqual(args[0], [str(runner), "run", "--model", "free-tier"])
        self.assertEqual(kwargs["input"], b"private prompt")
        self.assertIs(kwargs["shell"], False)
        self.assertIs(kwargs["stdout"], host_mod.subprocess.DEVNULL)
        self.assertIs(kwargs["stderr"], host_mod.subprocess.DEVNULL)
        self.assertEqual(kwargs["timeout"], self.config.run_timeout_seconds)

    def test_task_action_binds_verified_nondefault_config_and_refuses_tamper(self):
        _, registered = self.register()
        task = self.scheduler.tasks[host_mod._job_name(registered["jobId"])]
        arguments = task["actions"][0]["arguments"]
        self.assertTrue(arguments.startswith('-B "'))
        self.assertIn(f'--config "{self.config.config_path}"', arguments)
        self.assertNotIn('--config "%LOCALAPPDATA%', arguments)
        self.assertIn("--execute-job " + registered["jobId"], arguments)
        task["actions"][0]["arguments"] = arguments.replace(
            str(self.config.config_path), str(self.config.state_dir / "default.json")
        )
        with self.assertRaises(host_mod.HostError) as caught:
            self.host.get_state()
        self.assertEqual(caught.exception.code, "scheduler_readback_mismatch")

        output = io.StringIO()
        scheduler = FakeTaskScheduler()
        receipt = {"ok": True, "receipt": {"status": "succeeded", "exitCode": 0}}
        with (
            patch.object(host_mod, "PowerShellTaskScheduler", return_value=scheduler),
            patch.object(host_mod.HostConfig, "load", return_value=self.config) as load_config,
            patch.object(host_mod.GhostScheduler, "execute_job", return_value=receipt),
            redirect_stdout(output),
        ):
            result = host_mod.main(
                [
                    "--config",
                    str(self.config.config_path),
                    "--execute-job",
                    registered["jobId"],
                    "--revision",
                    str(registered["revision"]),
                    "--prompt-revision",
                    str(registered["promptRevision"]),
                    "--prompt-sha256",
                    registered["promptSha256"],
                ]
            )
        self.assertEqual(result, 0)
        self.assertEqual(load_config.call_args.args[0], self.config.config_path)
        self.assertEqual(json.loads(output.getvalue())["exitCode"], 0)

    def test_cancel_tombstones_job_and_old_registration_replay_never_enables(self):
        _, registered = self.register()
        job_id = registered["jobId"]
        cancel = {
            "action": "cancel-schedule",
            "confirm": True,
            "requestId": "cancel_0001",
            "jobId": job_id,
            "expectedRevision": 1,
        }
        status, cancelled = self.host.handle_action(cancel)
        self.assertEqual(status, 200)
        self.assertFalse(cancelled["active"])
        self.assertNotIn(host_mod._job_name(job_id), self.scheduler.tasks)
        enable_count = self.scheduler.events.count("enable")
        _, replay = self.register()
        self.assertTrue(replay["replayed"])
        self.assertFalse(replay["active"])
        self.assertEqual(self.scheduler.events.count("enable"), enable_count)
        self.assertNotIn(host_mod._job_name(job_id), self.scheduler.tasks)
        self.assertIn(job_id, self.host.store.read()["retiredJobIds"])
        _, replacement = self.register(request_id="register_0002")
        self.assertNotEqual(replacement["jobId"], job_id)
        self.assertTrue(replacement["active"])

    def test_active_draft_is_unique_for_register_and_update(self):
        _, first = self.register(request_id="register_0101")
        mutations_before = [
            event
            for event in self.scheduler.events
            if event in {"create_disabled", "replace_disabled", "enable", "disable", "remove"}
        ]
        with self.assertRaises(host_mod.HostError) as duplicate:
            self.register(request_id="register_0102")
        self.assertEqual(duplicate.exception.status, 409)
        self.assertEqual(duplicate.exception.code, "draft_already_scheduled")
        self.assertEqual(
            [
                event
                for event in self.scheduler.events
                if event in {"create_disabled", "replace_disabled", "enable", "disable", "remove"}
            ],
            mutations_before,
        )

        second_draft_id = "c" * 32
        self.drafts.add(make_draft(draft_id=second_draft_id, prompt="Second schedule."))
        _, second = self.register(
            request_id="register_0103", draft_id=second_draft_id
        )
        self.scheduler.events.clear()
        with self.assertRaises(host_mod.HostError) as collision:
            self.update("update_0101", second["jobId"], 1, DRAFT_ID, 1)
        self.assertEqual(collision.exception.status, 409)
        self.assertEqual(collision.exception.code, "draft_already_scheduled")
        self.assertNotIn("replace_disabled", self.scheduler.events)
        self.assertEqual(self.host.store.read()["jobs"][0]["jobId"], first["jobId"])

    def test_stale_draft_revision_and_unknown_fields_do_not_mutate_scheduler(self):
        with self.assertRaises(host_mod.HostError) as stale:
            self.register(revision=2)
        self.assertEqual(stale.exception.status, 409)
        self.assertEqual(self.scheduler.tasks, {})
        body = {
            "action": "register-schedule",
            "confirm": True,
            "requestId": "register_0002",
            "draftId": DRAFT_ID,
            "expectedDraftRevision": 1,
            "ownerSid": SID,
        }
        with self.assertRaises(host_mod.HostError) as unknown:
            self.host.handle_action(body)
        self.assertEqual(unknown.exception.status, 400)
        self.assertEqual(self.scheduler.tasks, {})
        with self.assertRaises(ValueError):
            host_mod._decode_json(b'{"a":1,"a":2}', maximum=100)

    def test_http_requires_private_key_and_preserves_action_status_codes(self):
        config = replace(self.config, listen_port=0)
        scheduler = FakeTaskScheduler()
        host = host_mod.GhostScheduler(config, scheduler, drafts=self.drafts, clock=lambda: NOW)
        server = host_mod.create_http_server(host)
        thread = threading.Thread(target=server.serve_forever, daemon=True)
        thread.start()
        url = f"http://127.0.0.1:{server.server_address[1]}/action"
        body = json.dumps(
            {
                "action": "register-schedule",
                "confirm": True,
                "requestId": "http_0001",
                "draftId": DRAFT_ID,
                "expectedDraftRevision": 2,
            }
        ).encode("utf-8")
        try:
            unauthorized = Request(
                url,
                data=body,
                headers={"Content-Type": "application/json"},
                method="POST",
            )
            with self.assertRaises(HTTPError) as denied:
                urlopen(unauthorized, timeout=2)
            self.assertEqual(denied.exception.code, 403)

            authorized = Request(
                url,
                data=body,
                headers={
                    "Content-Type": "application/json",
                    "X-Ghost-Control-Key": self.config.control_key,
                },
                method="POST",
            )
            with self.assertRaises(HTTPError) as stale:
                urlopen(authorized, timeout=2)
            self.assertEqual(stale.exception.code, 409)
            self.assertEqual(json.loads(stale.exception.read())["error"], "draft_changed_refresh_required")
            self.assertEqual(scheduler.tasks, {})
        finally:
            server.shutdown()
            server.server_close()
            thread.join(timeout=2)

    def test_task_readback_mismatch_fails_closed(self):
        _, registered = self.register()
        task = self.scheduler.tasks[host_mod._job_name(registered["jobId"])]
        task["actions"][0]["execute"] = str(self.base / "unapproved.exe")
        with self.assertRaises(host_mod.HostError) as caught:
            self.host.get_state()
        self.assertEqual(caught.exception.status, 503)
        self.assertEqual(caught.exception.code, "scheduler_readback_mismatch")
        task["actions"][0]["execute"] = str(self.config.python_exe.with_name("pythonw.exe"))
        task["taskName"] = "singularity-ghost-schedule-" + registered["jobId"]
        with self.assertRaises(host_mod.HostError) as case_mismatch:
            self.host.get_state()
        self.assertEqual(case_mismatch.exception.status, 503)

    def test_update_and_cancel_refuse_a_running_task(self):
        _, registered = self.register()
        job_id = registered["jobId"]
        self.drafts.add(make_draft(revision=2, prompt="Updated review."))
        task = self.scheduler.tasks[host_mod._job_name(job_id)]
        task["state"] = "Running"
        self.scheduler.events.clear()
        with self.assertRaises(host_mod.HostError) as update:
            self.update("update_running", job_id, 1, DRAFT_ID, 2)
        self.assertEqual(update.exception.status, 409)
        self.assertEqual(update.exception.code, "schedule_running_update_refused")
        with self.assertRaises(host_mod.HostError) as cancel:
            self.host.handle_action(
                {
                    "action": "cancel-schedule",
                    "confirm": True,
                    "requestId": "cancel_running",
                    "jobId": job_id,
                    "expectedRevision": 1,
                }
            )
        self.assertEqual(cancel.exception.status, 409)
        self.assertEqual(cancel.exception.code, "schedule_running_cancel_refused")
        self.assertTrue(task["enabled"])
        self.assertFalse(any(event in {"disable", "remove", "replace_disabled"} for event in self.scheduler.events))

    def test_restart_marks_started_execution_as_interrupted_without_rerun(self):
        _, registered = self.register()
        job_id = registered["jobId"]
        receipt = {
            "jobId": job_id,
            "scheduleRevision": registered["revision"],
            "promptRevision": registered["promptRevision"],
            "promptSha256": registered["promptSha256"],
            "occurrenceKey": "2026-03-01T09:00",
            "startedAt": "2026-03-01T20:00:00Z",
            "status": "started",
        }
        state = self.host.store.read()
        job = state["jobs"][0]
        job["executionReceipts"].append(deepcopy(receipt))
        job["lastReceipt"] = deepcopy(receipt)
        state["executionReceipts"].append(deepcopy(receipt))
        self.host.store.write(state)
        self.host.recover_pending()
        state = self.host.store.read()
        recovered = state["jobs"][0]["executionReceipts"][0]
        self.assertEqual(recovered["status"], "interrupted")
        self.assertEqual(recovered["error"], "interrupted_before_completion")
        self.assertEqual(state["executionReceipts"][0]["status"], "interrupted")
        self.assertEqual(state["executionReceipts"][0], recovered)
        self.assertEqual(self.runs, [])

    def test_config_owner_sid_must_match_windows_process_identity(self):
        path = self.config.control_config_path
        payload = {
            "schema": host_mod.CONFIG_SCHEMA,
            "stateDirectory": str(self.config.state_dir),
            "draftStateDirectory": str(self.config.draft_state_dir),
            "controlKey": self.config.control_key,
            "ownerSid": "S-1-5-21-1000000000-1000000000-1000000000-2002",
            "executionIdentitySid": "S-1-5-21-1000000000-1000000000-1000000000-2002",
            "pythonExe": str(self.config.python_exe),
            "runnerExecutable": str(self.config.runner_exe),
            "runnerArguments": [],
            "workspace": str(self.config.workspace),
            "listenHost": self.config.listen_host,
            "listenPort": self.config.listen_port,
            "sandbox": self.config.sandbox,
            "runTimeoutSeconds": self.config.run_timeout_seconds,
        }
        path.write_text(json.dumps(payload), encoding="utf-8")
        with self.assertRaises(host_mod.HostError) as caught:
            host_mod.HostConfig.load(path, self.scheduler)
        self.assertEqual(caught.exception.status, 503)
        self.assertEqual(caught.exception.code, "config_owner_sid_mismatch")

    def test_nz_dst_policy_refuses_recurring_and_ambiguous_one_time_plans(self):
        recurring = make_draft(time="02:30", recurrence="daily")
        with self.assertRaises(host_mod.HostError) as daily:
            host_mod.validate_nz_plan(recurring, NOW)
        self.assertEqual(daily.exception.code, "dst_policy_required_for_recurring_02_hour")

        sunday = make_draft(date="2026-03-01", time="02:00", recurrence="weekly")
        with self.assertRaises(host_mod.HostError) as weekly:
            host_mod.validate_nz_plan(sunday, NOW)
        self.assertEqual(weekly.exception.code, "dst_policy_required_for_recurring_02_hour")

        zone = ZoneInfo(host_mod.TIMEZONE_IANA)
        ambiguous = None
        nonexistent = None
        for offset in range(366):
            day = (datetime(2026, 1, 1) + timedelta(days=offset)).date()
            for hour in range(24):
                local = datetime(day.year, day.month, day.day, hour, 30)
                first = local.replace(tzinfo=zone, fold=0)
                second = local.replace(tzinfo=zone, fold=1)
                if first.utcoffset() == second.utcoffset():
                    continue
                roundtrip0 = first.astimezone(timezone.utc).astimezone(zone).replace(tzinfo=None)
                roundtrip1 = second.astimezone(timezone.utc).astimezone(zone).replace(tzinfo=None)
                if roundtrip0 == local and roundtrip1 == local:
                    ambiguous = local
                elif roundtrip0 != local and roundtrip1 != local:
                    nonexistent = local
        self.assertIsNotNone(ambiguous)
        self.assertIsNotNone(nonexistent)
        for local in (ambiguous, nonexistent):
            plan = make_draft(
                date=local.strftime("%Y-%m-%d"),
                time=local.strftime("%H:%M"),
                recurrence="once",
            )
            with self.assertRaises(host_mod.HostError) as caught:
                host_mod.validate_nz_plan(plan, NOW)
            self.assertEqual(caught.exception.code, "nz_local_time_ambiguous_or_nonexistent")

    def test_startup_recovery_retires_uncommitted_registration_task(self):
        draft = make_draft()
        candidate = self.host._new_job(draft)
        request_id = "register_recovery"
        body = {
            "action": "register-schedule",
            "confirm": True,
            "requestId": request_id,
            "draftId": DRAFT_ID,
            "expectedDraftRevision": 1,
        }
        digest = host_mod._canonical_hash(body)
        state = self.host.store.read()
        state["pending"] = {
            "requestId": request_id,
            "action": body["action"],
            "jobId": candidate["jobId"],
            "stage": "prepared",
            "oldJob": None,
            "candidate": candidate,
        }
        state["requests"][request_id] = {
            "action": body["action"],
            "payloadSha256": digest,
            "jobId": candidate["jobId"],
            "status": "pending",
            "receipt": None,
        }
        self.host.store.write(state)
        self.scheduler.create_disabled(candidate)
        self.host.recover_pending()
        self.assertNotIn(host_mod._job_name(candidate["jobId"]), self.scheduler.tasks)
        recovered = self.host.store.read()
        self.assertIsNone(recovered["pending"])
        self.assertEqual(recovered["jobs"][0]["status"], "cancelled")
        self.assertIn(candidate["jobId"], recovered["retiredJobIds"])
        self.assertEqual(recovered["requests"][request_id]["status"], "failed")
        self.assertEqual(
            recovered["requests"][request_id]["receipt"]["error"],
            "interrupted_operation_not_activated",
        )
        self.assertEqual(self.host.get_state()["schedules"], [])

    def test_startup_recovery_refuses_global_execution_receipt_even_if_job_copy_missing(self):
        candidate = self.host._new_job(make_draft())
        candidate["status"] = "recovery_required"
        candidate["active"] = False
        request_id = "register_global_receipt"
        body = {
            "action": "register-schedule",
            "confirm": True,
            "requestId": request_id,
            "draftId": DRAFT_ID,
            "expectedDraftRevision": 1,
        }
        state = self.host.store.read()
        state["jobs"].append(candidate)
        state["requests"][request_id] = {
            "action": body["action"],
            "payloadSha256": host_mod._canonical_hash(body),
            "jobId": candidate["jobId"],
            "status": "failed",
            "receipt": {
                "operation": "register-schedule",
                "jobId": candidate["jobId"],
                "status": "recovery_required",
                "active": False,
                "error": "scheduler_operation_unverified",
            },
        }
        state["executionReceipts"].append(
            {"jobId": candidate["jobId"], "status": "started"}
        )
        self.host.store.write(state)
        self.scheduler.create_disabled(candidate)

        with self.assertRaises(host_mod.HostError) as caught:
            self.host.recover_pending()
        self.assertEqual(caught.exception.code, "scheduler_operation_recovery_required")
        self.assertIn(host_mod._job_name(candidate["jobId"]), self.scheduler.tasks)
        self.assertFalse(self.scheduler.tasks[host_mod._job_name(candidate["jobId"])]["enabled"])
        self.assertEqual(self.host.store.read()["jobs"][0]["status"], "recovery_required")

    def test_file_draft_reader_checks_locked_current_revision(self):
        path = self.config.draft_path
        row = make_draft()
        row.update({"lastRequestId": "draft_req_001", "requestIds": ["draft_req_001"]})
        with host_mod.draft_store.locked(path):
            host_mod.draft_store.write(path, [row])
        reader = host_mod.FileDraftReader(self.config)
        self.assertEqual(reader.get(DRAFT_ID, 1)["prompt"], row["prompt"])
        with self.assertRaises(host_mod.HostError) as stale:
            reader.get(DRAFT_ID, 2)
        self.assertEqual(stale.exception.code, "draft_changed_refresh_required")


class PowerShellChildEnvironmentTests(unittest.TestCase):
    def test_invoke_filters_only_power_shell_module_environment_keys(self):
        poisoned_environment = {
            "pSmOdUlEpAtH": "invalid-module-path",
            "PSMODULEANALYSISCACHEPATH": "invalid-analysis-cache-path",
            "PRESERVE_ME": "preserved-value",
        }
        completed = host_mod.subprocess.CompletedProcess(
            args=[], returncode=0, stdout=b'{"ok":true}'
        )
        captured = {}

        def fake_runner(*args, **kwargs):
            captured["kwargs"] = kwargs
            return completed

        scheduler = host_mod.PowerShellTaskScheduler(
            powershell="powershell.exe", runner=fake_runner
        )
        with (
            patch.object(host_mod.os, "environ", poisoned_environment),
        ):
            scheduler._invoke("identity")

        child_environment = captured["kwargs"]["env"]
        self.assertEqual(
            {key.upper() for key in child_environment}, {"PRESERVE_ME", "PYTHONDONTWRITEBYTECODE"}
        )
        self.assertEqual(child_environment["PRESERVE_ME"], "preserved-value")
        self.assertEqual(child_environment["PYTHONDONTWRITEBYTECODE"], "1")


if __name__ == "__main__":
    unittest.main()
