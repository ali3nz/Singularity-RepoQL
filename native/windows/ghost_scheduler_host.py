"""Per-user native Windows Ghost schedule host.

This module is source-only until a reviewed installer owns its configuration and
startup. It binds only to loopback, authenticates a per-user bearer key whose
private configuration is pinned to the verified Windows owner SID, reads the
private M91 draft ledger under that ledger's lock, and treats Windows Task
Scheduler readback as the registration authority. The TCP API does not expose
an independent caller-token SID; the per-user key and OS ACL define this local
trust boundary. Importing the module has no runtime side effects.
"""
from __future__ import annotations

import argparse
from contextlib import contextmanager
from dataclasses import dataclass
from datetime import date, datetime
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
import hashlib
import hmac
import json
import os
from pathlib import Path
import re
import secrets
import subprocess
import sys
import tempfile
import threading
import time
from typing import Any, Callable
from zoneinfo import ZoneInfo, ZoneInfoNotFoundError

sys.dont_write_bytecode = True
os.environ["PYTHONDONTWRITEBYTECODE"] = "1"

ROOT = Path(__file__).absolute().parents[2]
sys.path.insert(0, str(ROOT / "dashboard"))
import ghost_schedule_plans as draft_store  # noqa: E402
from file_lock import fcntl  # noqa: E402


CONFIG_SCHEMA = "singularity-ghost-scheduler-config/v1"
STATE_SCHEMA = "singularity-ghost-scheduler-state/v1"
TASK_SCHEMA = "singularity-ghost-scheduler-task/v1"
TASK_PREFIX = "Singularity-Ghost-Schedule-"
TASK_PATH = "\\"
TIMEZONE_IANA = "Pacific/Auckland"
TIMEZONE_WINDOWS = "New Zealand Standard Time"
MAX_HTTP_BODY = 131072
MAX_CONFIG_BYTES = 32768
MAX_STATE_BYTES = 8 * 1024 * 1024
MAX_JOBS = 100
MAX_REQUESTS = 2048
MAX_RETIRED_JOBS = 2048
MAX_EXECUTION_RECEIPTS = 4096
MAX_PROMPT_CHARS = 4000
LOCK_WAIT_SECONDS = 5.0
RUN_GRACE_SECONDS = 60
REQUEST_ID_RX = re.compile(r"^[A-Za-z0-9_-]{8,128}$")
ID_RX = re.compile(r"^[0-9a-f]{32}$")
SHA_RX = re.compile(r"^[0-9a-f]{64}$")
SID_RX = re.compile(r"^S-1-[0-9]+(?:-[0-9]+)+$")
ALLOWED_ACTIONS = {
    "register-schedule": frozenset(
        {"action", "confirm", "requestId", "draftId", "expectedDraftRevision"}
    ),
    "update-schedule": frozenset(
        {
            "action",
            "confirm",
            "requestId",
            "jobId",
            "expectedRevision",
            "draftId",
            "expectedDraftRevision",
        }
    ),
    "cancel-schedule": frozenset(
        {"action", "confirm", "requestId", "jobId", "expectedRevision"}
    ),
}


class HostError(ValueError):
    def __init__(self, status: int, code: str):
        super().__init__(code)
        self.status = status
        self.code = code


def _no_duplicate_pairs(pairs):
    result = {}
    for key, value in pairs:
        if key in result:
            raise ValueError("duplicate_json_key")
        result[key] = value
    return result


def _decode_json(raw: bytes, *, maximum: int):
    if len(raw) > maximum:
        raise ValueError("json_too_large")
    return json.loads(raw.decode("utf-8"), object_pairs_hook=_no_duplicate_pairs)


def _canonical_hash(body: dict) -> str:
    canonical = json.dumps(
        body, ensure_ascii=False, sort_keys=True, separators=(",", ":")
    ).encode("utf-8")
    return hashlib.sha256(canonical).hexdigest()


def _sha_prompt(text: str) -> str:
    return hashlib.sha256(text.encode("utf-8")).hexdigest()


def _is_reparse(path: Path) -> bool:
    try:
        info = path.lstat()
    except FileNotFoundError:
        return False
    if path.is_symlink():
        return True
    return bool(getattr(info, "st_file_attributes", 0) & 0x400)


def _local_path(raw: Any, field: str, *, must_exist: bool) -> Path:
    if not isinstance(raw, str) or not raw or "\x00" in raw or "\r" in raw or "\n" in raw:
        raise HostError(503, f"config_{field}_invalid")
    path = Path(raw)
    if not path.is_absolute() or raw.startswith("\\\\"):
        raise HostError(503, f"config_{field}_must_be_local_absolute")
    cursor = path
    while True:
        if _is_reparse(cursor):
            raise HostError(503, f"config_{field}_reparse_refused")
        parent = cursor.parent
        if parent == cursor:
            break
        cursor = parent
    if must_exist and not path.exists():
        raise HostError(503, f"config_{field}_missing")
    return path


def _same_path(left: str, right: str) -> bool:
    return os.path.normcase(os.path.normpath(left)) == os.path.normcase(
        os.path.normpath(right)
    )


def _valid_sid(value: Any) -> bool:
    return isinstance(value, str) and bool(SID_RX.fullmatch(value))


def _require_exact_fields(obj: Any, fields: frozenset[str], code: str) -> dict:
    if not isinstance(obj, dict) or set(obj) != set(fields):
        raise HostError(400, code)
    return obj


@dataclass(frozen=True)
class HostConfig:
    state_dir: Path
    draft_state_dir: Path
    control_key: str
    owner_sid: str
    execution_identity_sid: str
    python_exe: Path
    host_script: Path
    task_script: Path
    runner_exe: Path
    runner_arguments: tuple[str, ...]
    config_path: Path
    workspace: Path
    listen_host: str
    listen_port: int
    sandbox: str
    run_timeout_seconds: int

    @property
    def state_path(self) -> Path:
        return self.state_dir / "ghost-scheduler-state.json"

    @property
    def draft_path(self) -> Path:
        return self.draft_state_dir / "ghost-task-plans.json"

    @property
    def control_config_path(self) -> Path:
        return self.config_path

    @classmethod
    def from_mapping(cls, data: Any, *, config_path: Path) -> "HostConfig":
        required = {
            "schema",
            "stateDirectory",
            "draftStateDirectory",
            "controlKey",
            "ownerSid",
            "executionIdentitySid",
            "pythonExe",
            "runnerExecutable",
            "runnerArguments",
            "workspace",
            "listenHost",
            "listenPort",
            "sandbox",
            "runTimeoutSeconds",
        }
        if not isinstance(data, dict) or set(data) != required:
            raise HostError(503, "config_schema_invalid")
        if data["schema"] != CONFIG_SCHEMA:
            raise HostError(503, "config_schema_invalid")
        key = data["controlKey"]
        if (
            not isinstance(key, str)
            or not 32 <= len(key) <= 1024
            or any(ord(c) < 32 or ord(c) == 127 for c in key)
        ):
            raise HostError(503, "config_control_key_invalid")
        if not _valid_sid(data["ownerSid"]) or not _valid_sid(
            data["executionIdentitySid"]
        ):
            raise HostError(503, "config_identity_invalid")
        if data["ownerSid"] != data["executionIdentitySid"]:
            raise HostError(503, "config_execution_identity_must_match_owner")
        host = data["listenHost"]
        if host not in ("127.0.0.1", "localhost"):
            raise HostError(503, "config_loopback_only")
        port = data["listenPort"]
        if type(port) is not int or not 1024 <= port <= 65535:
            raise HostError(503, "config_port_invalid")
        if data["sandbox"] not in ("read-only", "workspace-write"):
            raise HostError(503, "config_sandbox_invalid")
        timeout = data["runTimeoutSeconds"]
        if type(timeout) is not int or not 1 <= timeout <= 24 * 60 * 60:
            raise HostError(503, "config_run_timeout_invalid")
        runner_arguments = data["runnerArguments"]
        if (
            not isinstance(runner_arguments, list)
            or len(runner_arguments) > 64
            or any(
                not isinstance(item, str)
                or len(item) > 2048
                or any(ord(char) < 32 or ord(char) == 127 for char in item)
                for item in runner_arguments
            )
        ):
            raise HostError(503, "config_runner_arguments_invalid")
        if Path(str(data["runnerExecutable"])).suffix.casefold() != ".exe":
            raise HostError(503, "config_runner_must_be_absolute_exe")
        if (
            Path(str(data["runnerExecutable"])).name.casefold() == "codex.exe"
            and runner_arguments
        ):
            raise HostError(503, "config_codex_runner_arguments_fixed")
        paths = {
            "stateDirectory": _local_path(data["stateDirectory"], "state_directory", must_exist=True),
            "draftStateDirectory": _local_path(data["draftStateDirectory"], "draft_state_directory", must_exist=True),
            "pythonExe": _local_path(data["pythonExe"], "python_exe", must_exist=True),
            "hostScript": _local_path(str(Path(__file__)), "host_script", must_exist=True),
            "taskScript": _local_path(str(Path(__file__).with_name("ghost_task_scheduler.ps1")), "task_script", must_exist=True),
            "runnerExecutable": _local_path(data["runnerExecutable"], "runner_executable", must_exist=True),
            "configPath": _local_path(str(config_path), "config_path", must_exist=True),
            "workspace": _local_path(data["workspace"], "workspace", must_exist=True),
        }
        for name in ("stateDirectory", "draftStateDirectory", "workspace"):
            if not paths[name].is_dir():
                raise HostError(503, f"config_{name}_must_be_directory")
        if not paths["pythonExe"].is_file() or not paths["runnerExecutable"].is_file():
            raise HostError(503, "config_executable_missing")
        if not paths["configPath"].is_file():
            raise HostError(503, "config_file_invalid")
        if not paths["hostScript"].is_file() or not paths["taskScript"].is_file():
            raise HostError(503, "config_host_source_missing")
        return cls(
            state_dir=paths["stateDirectory"],
            draft_state_dir=paths["draftStateDirectory"],
            control_key=key,
            owner_sid=data["ownerSid"],
            execution_identity_sid=data["executionIdentitySid"],
            python_exe=paths["pythonExe"],
            host_script=paths["hostScript"],
            task_script=paths["taskScript"],
            runner_exe=paths["runnerExecutable"],
            runner_arguments=tuple(runner_arguments),
            config_path=paths["configPath"],
            workspace=paths["workspace"],
            listen_host=host,
            listen_port=port,
            sandbox=data["sandbox"],
            run_timeout_seconds=timeout,
        )

    @classmethod
    def load(cls, path: Path, scheduler: "TaskScheduler") -> "HostConfig":
        path = _local_path(str(path), "config_path", must_exist=True)
        if not path.is_file() or path.stat().st_size > MAX_CONFIG_BYTES:
            raise HostError(503, "config_file_invalid")
        owner = scheduler.current_identity()
        if not _valid_sid(owner):
            raise HostError(503, "windows_identity_unavailable")
        scheduler.verify_private_path(path, owner)
        data = _decode_json(path.read_bytes(), maximum=MAX_CONFIG_BYTES)
        config = cls.from_mapping(data, config_path=path)
        if config.owner_sid != owner:
            raise HostError(503, "config_owner_sid_mismatch")
        scheduler.verify_private_path(config.state_dir, owner)
        scheduler.verify_private_path(config.draft_state_dir, owner)
        return config


def _empty_state(config: HostConfig) -> dict:
    return {
        "schema": STATE_SCHEMA,
        "ownerSid": config.owner_sid,
        "executionIdentitySid": config.execution_identity_sid,
        "jobs": [],
        "requests": {},
        "retiredJobIds": [],
        "pending": None,
        "executionReceipts": [],
    }


def _validate_state(state: Any, config: HostConfig) -> dict:
    required = {
        "schema",
        "ownerSid",
        "executionIdentitySid",
        "jobs",
        "requests",
        "retiredJobIds",
        "pending",
        "executionReceipts",
    }
    if not isinstance(state, dict) or set(state) != required:
        raise HostError(503, "state_invalid")
    if (
        state["schema"] != STATE_SCHEMA
        or state["ownerSid"] != config.owner_sid
        or state["executionIdentitySid"] != config.execution_identity_sid
        or not isinstance(state["jobs"], list)
        or len(state["jobs"]) > MAX_JOBS
        or not isinstance(state["requests"], dict)
        or len(state["requests"]) > MAX_REQUESTS
        or not isinstance(state["retiredJobIds"], list)
        or len(state["retiredJobIds"]) > MAX_RETIRED_JOBS
        or not isinstance(state["executionReceipts"], list)
        or len(state["executionReceipts"]) > MAX_EXECUTION_RECEIPTS
    ):
        raise HostError(503, "state_invalid")
    job_ids = set()
    for job in state["jobs"]:
        if not isinstance(job, dict) or not ID_RX.fullmatch(str(job.get("jobId", ""))):
            raise HostError(503, "state_invalid")
        if job["jobId"] in job_ids:
            raise HostError(503, "state_invalid")
        job_ids.add(job["jobId"])
        if (
            type(job.get("revision")) is not int
            or job["revision"] < 1
            or not ID_RX.fullmatch(str(job.get("draftId", "")))
            or type(job.get("draftRevision")) is not int
            or job["draftRevision"] < 1
            or job.get("timezone") != TIMEZONE_IANA
            or job.get("recurrence") not in ("once", "daily", "weekly")
            or job.get("status") not in ("active", "cancelled", "recovery_required")
            or type(job.get("active")) is not bool
            or job["active"] != (job["status"] == "active")
            or job.get("ownerSid") != config.owner_sid
            or job.get("executionIdentitySid") != config.execution_identity_sid
            or type(job.get("promptRevision")) is not int
            or job["promptRevision"] < 1
            or not SHA_RX.fullmatch(str(job.get("promptSha256", "")))
            or not isinstance(job.get("promptRevisions"), list)
            or not 1 <= len(job["promptRevisions"]) <= 128
        ):
            raise HostError(503, "state_invalid")
        if not isinstance(job.get("executionReceipts"), list):
            raise HostError(503, "state_invalid")
        current = next(
            (
                item
                for item in job["promptRevisions"]
                if item.get("revision") == job["promptRevision"]
            ),
            None,
        )
        if (
            current is None
            or not isinstance(current.get("text"), str)
            or len(current["text"]) > MAX_PROMPT_CHARS
            or current.get("sha256") != job["promptSha256"]
            or _sha_prompt(current["text"]) != current["sha256"]
        ):
            raise HostError(503, "state_invalid")
    for request_id, request in state["requests"].items():
        if not REQUEST_ID_RX.fullmatch(request_id) or not isinstance(request, dict):
            raise HostError(503, "state_invalid")
        if (
            not SHA_RX.fullmatch(str(request.get("payloadSha256", "")))
            or request.get("action") not in ALLOWED_ACTIONS
            or request.get("status") not in ("pending", "complete", "failed")
        ):
            raise HostError(503, "state_invalid")
    if len(set(state["retiredJobIds"])) != len(state["retiredJobIds"]) or any(
        not ID_RX.fullmatch(str(item)) for item in state["retiredJobIds"]
    ):
        raise HostError(503, "state_invalid")
    if state["pending"] is not None and not isinstance(state["pending"], dict):
        raise HostError(503, "state_invalid")
    return state


class StateStore:
    def __init__(self, config: HostConfig):
        self.config = config
        self.path = config.state_path
        self.lock_path = self.path.with_name(self.path.name + ".lock")
        self._thread_lock = threading.RLock()

    @contextmanager
    def locked(self, *, nonblocking: bool = False):
        if _is_reparse(self.config.state_dir) or _is_reparse(self.path):
            raise HostError(503, "state_reparse_refused")
        with self._thread_lock:
            try:
                handle = self.lock_path.open("a+b")
            except OSError as exc:
                raise HostError(503, "state_lock_unavailable") from exc
            try:
                if _is_reparse(self.lock_path):
                    raise HostError(503, "state_lock_reparse_refused")
                if handle.seek(0, os.SEEK_END) == 0:
                    handle.write(b"\0")
                    handle.flush()
                    os.fsync(handle.fileno())
                os.chmod(self.lock_path, 0o600)
                deadline = time.monotonic() + (0.0 if nonblocking else LOCK_WAIT_SECONDS)
                while True:
                    try:
                        fcntl.flock(
                            handle.fileno(),
                            fcntl.LOCK_EX | (fcntl.LOCK_NB if nonblocking else 0),
                        )
                        break
                    except OSError as exc:
                        if nonblocking or time.monotonic() >= deadline:
                            raise HostError(503, "state_lock_busy") from exc
                        time.sleep(0.05)
                try:
                    yield
                finally:
                    fcntl.flock(handle.fileno(), fcntl.LOCK_UN)
            finally:
                handle.close()

    @contextmanager
    def job_locked(self, job_id: str, *, nonblocking: bool = False):
        if not ID_RX.fullmatch(job_id):
            raise HostError(400, "invalid_job_id")
        path = self.config.state_dir / f"execute-{job_id}.lock"
        if _is_reparse(path):
            raise HostError(503, "execution_lock_reparse_refused")
        # msvcrt byte-range locks coordinate separate Windows processes; the
        # shared RLock also serializes threads in this process on Windows.
        acquired = self._thread_lock.acquire(blocking=not nonblocking)
        if not acquired:
            raise HostError(503, "execution_already_in_progress")
        try:
            try:
                handle = path.open("a+b")
            except OSError as exc:
                raise HostError(503, "execution_lock_unavailable") from exc
            try:
                if handle.seek(0, os.SEEK_END) == 0:
                    handle.write(b"\0")
                    handle.flush()
                    os.fsync(handle.fileno())
                os.chmod(path, 0o600)
                deadline = time.monotonic() + (0.0 if nonblocking else LOCK_WAIT_SECONDS)
                while True:
                    try:
                        fcntl.flock(
                            handle.fileno(),
                            fcntl.LOCK_EX | (fcntl.LOCK_NB if nonblocking else 0),
                        )
                        break
                    except OSError as exc:
                        if nonblocking or time.monotonic() >= deadline:
                            raise HostError(503, "execution_already_in_progress") from exc
                        time.sleep(0.05)
                try:
                    yield
                finally:
                    fcntl.flock(handle.fileno(), fcntl.LOCK_UN)
            finally:
                handle.close()
        finally:
            self._thread_lock.release()

    def read(self) -> dict:
        if not self.path.exists():
            return _empty_state(self.config)
        if _is_reparse(self.path):
            raise HostError(503, "state_reparse_refused")
        try:
            raw = self.path.read_bytes()
        except OSError as exc:
            raise HostError(503, "state_unavailable") from exc
        if len(raw) > MAX_STATE_BYTES:
            raise HostError(503, "state_too_large")
        try:
            state = _decode_json(raw, maximum=MAX_STATE_BYTES)
        except (ValueError, UnicodeError, json.JSONDecodeError) as exc:
            raise HostError(503, "state_invalid") from exc
        return _validate_state(state, self.config)

    def write(self, state: dict) -> None:
        state = _validate_state(state, self.config)
        content = json.dumps(
            state, ensure_ascii=False, sort_keys=True, separators=(",", ":")
        ).encode("utf-8")
        if len(content) > MAX_STATE_BYTES:
            raise HostError(507, "state_capacity_reached")
        if _is_reparse(self.path):
            raise HostError(503, "state_reparse_refused")
        name = None
        try:
            fd, name = tempfile.mkstemp(prefix=".ghost-scheduler-", dir=self.config.state_dir)
            os.chmod(name, 0o600)
            with os.fdopen(fd, "wb") as stream:
                stream.write(content)
                stream.flush()
                os.fsync(stream.fileno())
            if _is_reparse(self.path):
                raise HostError(503, "state_reparse_refused")
            os.replace(name, self.path)
        except HostError:
            raise
        except OSError as exc:
            raise HostError(503, "state_write_unavailable") from exc
        finally:
            if name and os.path.exists(name):
                os.unlink(name)


class TaskScheduler:
    """Narrow adapter interface; tests inject a deterministic in-memory fake."""

    def current_identity(self) -> str:
        raise NotImplementedError

    def verify_private_path(self, path: Path, owner_sid: str) -> None:
        raise NotImplementedError

    def timezone_id(self) -> str:
        raise NotImplementedError

    def list_tasks(self) -> list[dict]:
        raise NotImplementedError

    def create_disabled(self, job: dict) -> None:
        raise NotImplementedError

    def replace_disabled(self, old_job: dict, new_job: dict) -> None:
        raise NotImplementedError

    def enable(self, job: dict) -> None:
        raise NotImplementedError

    def disable(self, job: dict) -> None:
        raise NotImplementedError

    def remove(self, job: dict) -> None:
        raise NotImplementedError


class PowerShellTaskScheduler(TaskScheduler):
    OPERATIONS = frozenset(
        {
            "identity",
            "verify-private-path",
            "timezone",
            "list",
            "create-disabled",
            "replace-disabled",
            "enable",
            "disable",
            "remove",
        }
    )

    def __init__(
        self,
        script: Path | None = None,
        *,
        config: HostConfig | None = None,
        powershell: str | None = None,
        runner: Callable = subprocess.run,
    ):
        self.script = script or Path(__file__).with_name("ghost_task_scheduler.ps1")
        self.config = config
        self.powershell = powershell or os.path.join(
            os.environ.get("SystemRoot", r"C:\Windows"),
            "System32",
            "WindowsPowerShell",
            "v1.0",
            "powershell.exe",
        )
        self.runner = runner

    def bind_config(self, config: HostConfig) -> None:
        self.config = config

    def _invoke(self, operation: str, payload: dict | None = None) -> dict:
        if operation not in self.OPERATIONS:
            raise HostError(500, "scheduler_operation_invalid")
        raw = json.dumps(payload or {}, ensure_ascii=False, separators=(",", ":")).encode()
        # A parent process may be running under PowerShell 7 and export module
        # paths whose modules cannot load in the Windows PowerShell 5.1 child.
        # Omit only these PowerShell-specific variables from this invocation;
        # keep the parent environment untouched and preserve every other key.
        child_env = {
            key: value
            for key, value in os.environ.items()
            if key.upper() not in {"PSMODULEPATH", "PSMODULEANALYSISCACHEPATH"}
        }
        child_env["PYTHONDONTWRITEBYTECODE"] = "1"
        try:
            result = self.runner(
                [
                    self.powershell,
                    "-NoLogo",
                    "-NoProfile",
                    "-NonInteractive",
                    "-ExecutionPolicy",
                    "Bypass",
                    "-File",
                    str(self.script),
                    "-Operation",
                    operation,
                ],
                input=raw,
                stdout=subprocess.PIPE,
                stderr=subprocess.DEVNULL,
                shell=False,
                timeout=20,
                check=False,
                env=child_env,
                creationflags=getattr(subprocess, "CREATE_NO_WINDOW", 0),
            )
        except (OSError, subprocess.TimeoutExpired) as exc:
            raise HostError(503, "scheduler_unavailable") from exc
        if result.returncode != 0 or len(result.stdout) > 1024 * 1024:
            raise HostError(503, "scheduler_readback_unavailable")
        try:
            response = _decode_json(result.stdout, maximum=1024 * 1024)
        except (ValueError, UnicodeError, json.JSONDecodeError) as exc:
            raise HostError(503, "scheduler_response_invalid") from exc
        if not isinstance(response, dict) or response.get("ok") is not True:
            code = response.get("error") if isinstance(response, dict) else None
            if code == "SCHEDULER_QUERY_FAILED":
                raise HostError(503, "scheduler_query_failed")
            raise HostError(503, "scheduler_operation_refused")
        return response

    def current_identity(self) -> str:
        return self._invoke("identity").get("currentSid", "")

    def verify_private_path(self, path: Path, owner_sid: str) -> None:
        result = self._invoke(
            "verify-private-path", {"path": str(path), "ownerSid": owner_sid}
        )
        if result.get("verified") is not True:
            raise HostError(503, "private_acl_unverified")

    def timezone_id(self) -> str:
        return self._invoke("timezone").get("timeZoneId", "")

    def list_tasks(self) -> list[dict]:
        result = self._invoke("list")
        tasks = result.get("tasks")
        if not isinstance(tasks, list) or any(not isinstance(item, dict) for item in tasks):
            raise HostError(503, "scheduler_readback_invalid")
        return tasks

    def _mutate(self, operation: str, **payload):
        self._invoke(operation, payload)

    def _task_spec(self, job: dict) -> dict:
        if self.config is None:
            raise HostError(503, "scheduler_config_unavailable")
        return {
            "jobId": job["jobId"],
            "revision": job["revision"],
            "draftId": job["draftId"],
            "draftRevision": job["draftRevision"],
            "date": job["date"],
            "time": job["time"],
            "timezone": job["timezone"],
            "recurrence": job["recurrence"],
            "ownerSid": job["ownerSid"],
            "executionIdentitySid": job["executionIdentitySid"],
            "promptRevision": job["promptRevision"],
            "promptSha256": job["promptSha256"],
            "pythonExe": str(self.config.python_exe),
            "hostScript": str(self.config.host_script),
            "configPath": str(self.config.config_path),
            "workspace": str(self.config.workspace),
        }

    def create_disabled(self, job: dict) -> None:
        self._mutate("create-disabled", job=self._task_spec(job))

    def replace_disabled(self, old_job: dict, new_job: dict) -> None:
        self._mutate(
            "replace-disabled",
            oldJob=self._task_spec(old_job),
            newJob=self._task_spec(new_job),
        )

    def enable(self, job: dict) -> None:
        self._mutate("enable", job=self._task_spec(job))

    def disable(self, job: dict) -> None:
        self._mutate("disable", job=self._task_spec(job))

    def remove(self, job: dict) -> None:
        self._mutate("remove", job=self._task_spec(job))


def validate_nz_plan(plan: dict, now: datetime | None = None) -> None:
    if (
        not isinstance(plan, dict)
        or plan.get("timezone") != TIMEZONE_IANA
        or plan.get("recurrence") not in ("once", "daily", "weekly")
    ):
        raise HostError(400, "invalid_draft")
    try:
        day = date.fromisoformat(plan["date"])
        hour, minute = (int(value) for value in plan["time"].split(":"))
        if not 0 <= hour <= 23 or not 0 <= minute <= 59:
            raise ValueError
    except (KeyError, TypeError, ValueError) as exc:
        raise HostError(400, "invalid_draft") from exc
    recurrence = plan["recurrence"]
    if recurrence == "daily" or (recurrence == "weekly" and day.weekday() == 6):
        if hour == 2:
            raise HostError(400, "dst_policy_required_for_recurring_02_hour")
    if recurrence == "once":
        local = datetime(day.year, day.month, day.day, hour, minute)
        try:
            nz = ZoneInfo(TIMEZONE_IANA)
        except ZoneInfoNotFoundError as exc:
            raise HostError(503, "nz_timezone_database_unavailable") from exc
        first = local.replace(tzinfo=nz, fold=0)
        second = local.replace(tzinfo=nz, fold=1)
        if first.utcoffset() != second.utcoffset():
            raise HostError(400, "nz_local_time_ambiguous_or_nonexistent")
        current = now or datetime.now(nz)
        if current.tzinfo is None:
            current = current.replace(tzinfo=nz)
        if first <= current.astimezone(nz):
            raise HostError(400, "one_time_activation_in_the_past")


def _schedule_local_boundary(job: dict) -> str:
    return f"{job['date']}T{job['time']}:00"


def _job_name(job_id: str) -> str:
    return TASK_PREFIX + job_id


def _expected_description(job: dict) -> str:
    return (
        f"{TASK_SCHEMA};jobId={job['jobId']};ownerSid={job['ownerSid']};"
        f"revision={job['revision']};promptRevision={job['promptRevision']};"
        f"promptSha256={job['promptSha256']}"
    )


def _expected_action_arguments(job: dict, config: HostConfig) -> str:
    host = str(config.host_script)
    config_path = str(config.config_path)
    if any(char in host for char in ('"', "\r", "\n")) or any(
        char in config_path for char in ('"', "\r", "\n")
    ):
        raise HostError(503, "host_or_config_path_invalid")
    return (
        f'-B "{host}" --config "{config_path}" --execute-job {job["jobId"]} '
        f'--revision {job["revision"]} '
        f'--prompt-revision {job["promptRevision"]} '
        f'--prompt-sha256 {job["promptSha256"]}'
    )


def _task_for_id(tasks: list[dict], job_id: str) -> dict | None:
    wanted = _job_name(job_id).casefold()
    matches = [
        task
        for task in tasks
        if isinstance(task.get("taskName"), str)
        and task["taskName"].casefold() == wanted
    ]
    if len(matches) > 1:
        raise HostError(503, "scheduler_task_ambiguous")
    if not matches:
        return None
    task = matches[0]
    if task.get("taskPath") != TASK_PATH:
        raise HostError(503, "scheduler_task_foreign")
    return task


def _matching_task(task: dict, job: dict, config: HostConfig, *, enabled: bool) -> bool:
    if not isinstance(task, dict):
        return False
    expected_boundary = _schedule_local_boundary(job)
    actions = task.get("actions")
    triggers = task.get("triggers")
    principal = task.get("principal")
    settings = task.get("settings")
    if (
        task.get("taskName") != _job_name(job["jobId"])
        or task.get("taskPath") != TASK_PATH
        or task.get("description") != _expected_description(job)
        or task.get("enabled") is not enabled
        or not isinstance(actions, list)
        or len(actions) != 1
        or not isinstance(principal, dict)
        or not isinstance(settings, dict)
        or not isinstance(triggers, list)
        or len(triggers) != 1
    ):
        return False
    action = actions[0]
    if (
        not isinstance(action, dict)
        or not _same_path(str(action.get("execute", "")), str(config.python_exe))
        or action.get("arguments") != _expected_action_arguments(job, config)
        or not _same_path(str(action.get("workingDirectory", "")), str(config.workspace))
    ):
        return False
    if (
        principal.get("userId") != config.execution_identity_sid
        or principal.get("logonType") not in ("InteractiveToken", "Interactive")
        or principal.get("runLevel") not in ("Limited", "LeastPrivilege")
    ):
        return False
    if (
        settings.get("startWhenAvailable") is not False
        or settings.get("multipleInstances") != "IgnoreNew"
    ):
        return False
    trigger = triggers[0]
    if not isinstance(trigger, dict) or trigger.get("enabled") is not True:
        return False
    if trigger.get("startBoundary") != expected_boundary:
        return False
    recurrence = job["recurrence"]
    if recurrence == "once":
        return trigger.get("kind") == "Time"
    if recurrence == "daily":
        return trigger.get("kind") == "Daily" and trigger.get("daysInterval") == 1
    try:
        weekday = date.fromisoformat(job["date"]).strftime("%A")
    except ValueError:
        return False
    days = trigger.get("daysOfWeek")
    return (
        trigger.get("kind") == "Weekly"
        and trigger.get("weeksInterval") == 1
        and isinstance(days, list)
        and days == [weekday]
    )


class FileDraftReader:
    def __init__(self, config: HostConfig):
        self.config = config

    def get(self, draft_id: str, expected_revision: int) -> dict:
        path = self.config.draft_path
        if _is_reparse(path) or _is_reparse(path.parent):
            raise HostError(503, "draft_reparse_refused")
        try:
            with draft_store.locked(path):
                rows, _retired = draft_store.read(path, include_retired=True)
        except draft_store.PlanBusy as exc:
            raise HostError(503, "draft_busy") from exc
        except draft_store.PlanError as exc:
            raise HostError(503, "draft_unavailable") from exc
        row = next((item for item in rows if item.get("id") == draft_id), None)
        if row is None:
            raise HostError(404, "unknown_draft")
        if type(expected_revision) is not int or row.get("revision") != expected_revision:
            raise HostError(409, "draft_changed_refresh_required")
        if row.get("active") is not False or row.get("status") != "draft":
            raise HostError(409, "draft_not_executable")
        if (
            not isinstance(row.get("prompt"), str)
            or len(row["prompt"].strip()) < 1
            or len(row["prompt"]) > MAX_PROMPT_CHARS
        ):
            raise HostError(400, "invalid_draft_prompt")
        return row


class GhostScheduler:
    def __init__(
        self,
        config: HostConfig,
        scheduler: TaskScheduler,
        *,
        drafts: Any | None = None,
        runner: Callable | None = None,
        clock: Callable[[], datetime] | None = None,
    ):
        self.config = config
        self.scheduler = scheduler
        bind_config = getattr(scheduler, "bind_config", None)
        if callable(bind_config):
            bind_config(config)
        self.drafts = drafts or FileDraftReader(config)
        self.runner = runner or self._run_configured_runner
        self.clock = clock or (lambda: datetime.now(ZoneInfo(TIMEZONE_IANA)))
        self.store = StateStore(config)
        self._host_lock = self.store._thread_lock

    @contextmanager
    def owner_lock(self):
        path = self.config.state_dir / "ghost-scheduler-owner.lock"
        if _is_reparse(path):
            raise HostError(503, "owner_lock_reparse_refused")
        try:
            handle = path.open("a+b")
        except OSError as exc:
            raise HostError(503, "owner_lock_unavailable") from exc
        try:
            if handle.seek(0, os.SEEK_END) == 0:
                handle.write(b"\0")
                handle.flush()
                os.fsync(handle.fileno())
            os.chmod(path, 0o600)
            try:
                fcntl.flock(handle.fileno(), fcntl.LOCK_EX | fcntl.LOCK_NB)
            except OSError as exc:
                raise HostError(503, "host_already_running") from exc
            try:
                yield
            finally:
                fcntl.flock(handle.fileno(), fcntl.LOCK_UN)
        finally:
            handle.close()

    def _check_timezone(self) -> None:
        if self.scheduler.timezone_id() != TIMEZONE_WINDOWS:
            raise HostError(503, "windows_timezone_must_be_new_zealand")

    def recover_pending(self) -> None:
        """Disable interrupted uncommitted work and record cancellation recovery."""
        with self.store.locked():
            state = self.store.read()
            pending = state.get("pending")
            if pending is not None:
                candidate = pending.get("candidate")
                old = pending.get("oldJob")
                if not isinstance(candidate, dict) or not ID_RX.fullmatch(
                    str(candidate.get("jobId", ""))
                ):
                    raise HostError(503, "state_pending_operation_invalid")
                tasks = self.scheduler.list_tasks()
                task = _task_for_id(tasks, candidate["jobId"])
                if task is not None:
                    choices = [candidate] + ([old] if isinstance(old, dict) else [])
                    matching = next(
                        (
                            item
                            for item in choices
                            if _matching_task(
                                task, item, self.config, enabled=bool(task.get("enabled"))
                            )
                        ),
                        None,
                    )
                    if matching is None:
                        raise HostError(503, "scheduler_pending_task_foreign")
                    if task.get("state") == "Running":
                        raise HostError(503, "scheduler_pending_task_running")
                    self.scheduler.disable(matching)
                    task = _task_for_id(
                        self.scheduler.list_tasks(), candidate["jobId"]
                    )
                    if task is None or not _matching_task(
                        task, matching, self.config, enabled=False
                    ):
                        raise HostError(503, "scheduler_pending_disable_unverified")
                    if pending.get("action") == "cancel-schedule":
                        self.scheduler.remove(matching)
                        if _task_for_id(
                            self.scheduler.list_tasks(), candidate["jobId"]
                        ) is not None:
                            raise HostError(503, "scheduler_pending_remove_unverified")
                if pending.get("action") == "cancel-schedule":
                    candidate["status"] = "cancelled"
                    candidate["active"] = False
                    if candidate["jobId"] not in state["retiredJobIds"]:
                        if len(state["retiredJobIds"]) >= MAX_RETIRED_JOBS:
                            raise HostError(507, "retired_job_limit_reached")
                        state["retiredJobIds"].append(candidate["jobId"])
                    receipt = self._receipt(
                        "cancel-schedule", pending["requestId"], candidate, None
                    )
                    record_status = "complete"
                else:
                    candidate["status"] = "recovery_required"
                    candidate["active"] = False
                    receipt = {
                        "operation": pending.get("action"),
                        "jobId": candidate["jobId"],
                        "status": "recovery_required",
                        "active": False,
                        "error": "interrupted_operation_not_activated",
                    }
                    record_status = "failed"
                existing = next(
                    (
                        item
                        for item in state["jobs"]
                        if item["jobId"] == candidate["jobId"]
                    ),
                    None,
                )
                if existing is None:
                    state["jobs"].append(candidate)
                else:
                    state["jobs"][state["jobs"].index(existing)] = candidate
                request = state["requests"].get(pending.get("requestId"))
                if request is None:
                    raise HostError(503, "state_pending_request_missing")
                request["status"] = record_status
                request["receipt"] = receipt
                state["pending"] = None
                self.store.write(state)
        self._recover_failed_registration_jobs()
        self._recover_interrupted_receipts()

    def _recover_failed_registration_jobs(self) -> None:
        """Retire only failed registrations whose exact owned task is disabled.

        A failed registration can leave a verified but uncommitted task after
        the pending journal is closed. That task must not keep the host
        permanently unavailable, but recovery may remove it only when the
        original failed request, zero execution receipts, full task spec, and
        non-running disabled state all agree.
        """
        with self.store.locked():
            state = self.store.read()
            candidates = []
            for job in state["jobs"]:
                if job.get("status") != "recovery_required":
                    continue
                failures = [
                    (request_id, request)
                    for request_id, request in state["requests"].items()
                    if request.get("jobId") == job.get("jobId")
                    and request.get("action") == "register-schedule"
                    and request.get("status") == "failed"
                ]
                if len(failures) != 1:
                    raise HostError(503, "scheduler_operation_recovery_required")
                request_id, request = failures[0]
                receipt = request.get("receipt")
                if (
                    job.get("active") is not False
                    or job.get("executionReceipts")
                    or not isinstance(receipt, dict)
                    or receipt.get("operation") != "register-schedule"
                    or receipt.get("jobId") != job["jobId"]
                    or receipt.get("status") != "recovery_required"
                    or receipt.get("active") is not False
                    or receipt.get("error")
                    not in ("scheduler_operation_unverified", "interrupted_operation_not_activated")
                    or job["jobId"] in state["retiredJobIds"]
                    or any(
                        item.get("jobId") == job["jobId"]
                        for item in state["executionReceipts"]
                    )
                ):
                    raise HostError(503, "scheduler_operation_recovery_required")
                candidates.append((job, request_id))

            if not candidates:
                return
            if len(state["retiredJobIds"]) + len(candidates) > MAX_RETIRED_JOBS:
                raise HostError(507, "retired_job_limit_reached")

            tasks = self.scheduler.list_tasks()
            for job, _request_id in candidates:
                task = _task_for_id(tasks, job["jobId"])
                if task is not None:
                    if not _matching_task(
                        task, job, self.config, enabled=bool(task.get("enabled"))
                    ):
                        raise HostError(503, "scheduler_recovery_task_foreign")
                    if task.get("state") == "Running":
                        raise HostError(503, "scheduler_recovery_task_running")

            changed = False
            for job, _request_id in candidates:
                task = _task_for_id(tasks, job["jobId"])
                if task is not None:
                    if task.get("enabled"):
                        self.scheduler.disable(job)
                        task = _task_for_id(
                            self.scheduler.list_tasks(), job["jobId"]
                        )
                        if (
                            task is None
                            or task.get("state") == "Running"
                            or not _matching_task(task, job, self.config, enabled=False)
                        ):
                            raise HostError(503, "scheduler_recovery_disable_unverified")
                    self.scheduler.remove(job)
                    if _task_for_id(self.scheduler.list_tasks(), job["jobId"]) is not None:
                        raise HostError(503, "scheduler_recovery_remove_unverified")
                job["status"] = "cancelled"
                job["active"] = False
                job["updatedAt"] = self._now_text()
                state["retiredJobIds"].append(job["jobId"])
                changed = True
            if changed:
                self.store.write(state)

    def _recover_interrupted_receipts(self) -> None:
        with self.store.locked():
            job_ids = [
                job["jobId"]
                for job in self.store.read()["jobs"]
                if any(item.get("status") == "started" for item in job["executionReceipts"])
            ]
        for job_id in job_ids:
            try:
                with self.store.job_locked(job_id, nonblocking=True):
                    with self.store.locked():
                        state = self.store.read()
                        job = self._find_job(state, job_id)
                        changed = False
                        for receipt in job["executionReceipts"]:
                            if receipt.get("status") == "started":
                                receipt["status"] = "interrupted"
                                receipt["finishedAt"] = self._now_text()
                                receipt["error"] = "interrupted_before_completion"
                                job["lastReceipt"] = dict(receipt)
                                self._sync_global_execution_receipt(state, receipt)
                                changed = True
                        if changed:
                            self.store.write(state)
            except HostError as exc:
                if exc.code != "execution_already_in_progress":
                    raise

    def _new_job(self, draft: dict) -> dict:
        validate_nz_plan(draft, self.clock())
        prompt = draft["prompt"]
        digest = _sha_prompt(prompt)
        return {
            "jobId": secrets.token_hex(16),
            "revision": 1,
            "draftId": draft["id"],
            "draftRevision": draft["revision"],
            "title": draft["title"],
            "date": draft["date"],
            "time": draft["time"],
            "timezone": TIMEZONE_IANA,
            "recurrence": draft["recurrence"],
            "ownerSid": self.config.owner_sid,
            "executionIdentitySid": self.config.execution_identity_sid,
            "status": "active",
            "active": True,
            "promptRevision": 1,
            "promptSha256": digest,
            "promptRevisions": [{"revision": 1, "sha256": digest, "text": prompt}],
            "missedRunPolicy": "skip",
            "lastReceipt": None,
            "executionReceipts": [],
            "createdAt": self._now_text(),
            "updatedAt": self._now_text(),
        }

    def _updated_job(self, previous: dict, draft: dict) -> dict:
        validate_nz_plan(draft, self.clock())
        job = json.loads(json.dumps(previous))
        old_prompt = job["promptRevisions"][-1]["text"]
        prompt = draft["prompt"]
        job["revision"] = previous["revision"] + 1
        job["draftId"] = draft["id"]
        job["draftRevision"] = draft["revision"]
        job["title"] = draft["title"]
        job["date"] = draft["date"]
        job["time"] = draft["time"]
        job["recurrence"] = draft["recurrence"]
        if prompt != old_prompt:
            if len(job["promptRevisions"]) >= 128:
                raise HostError(507, "prompt_revision_limit_reached")
            prompt_revision = job["promptRevision"] + 1
            digest = _sha_prompt(prompt)
            job["promptRevision"] = prompt_revision
            job["promptSha256"] = digest
            job["promptRevisions"].append(
                {"revision": prompt_revision, "sha256": digest, "text": prompt}
            )
        job["status"] = "active"
        job["active"] = True
        job["updatedAt"] = self._now_text()
        return job

    def _now_text(self) -> str:
        now = self.clock()
        if now.tzinfo is None:
            now = now.replace(tzinfo=ZoneInfo(TIMEZONE_IANA))
        return now.astimezone(ZoneInfo("UTC")).replace(microsecond=0).isoformat().replace("+00:00", "Z")

    def _sync_global_execution_receipt(self, state: dict, receipt: dict) -> None:
        matches = [
            item
            for item in state["executionReceipts"]
            if item.get("jobId") == receipt.get("jobId")
            and item.get("occurrenceKey") == receipt.get("occurrenceKey")
        ]
        if len(matches) != 1:
            raise HostError(503, "execution_receipt_store_mismatch")
        snapshot = dict(receipt)
        matches[0].clear()
        matches[0].update(snapshot)

    def _find_job(self, state: dict, job_id: str) -> dict:
        job = next((item for item in state["jobs"] if item["jobId"] == job_id), None)
        if job is None:
            raise HostError(404, "unknown_job")
        return job

    def _ensure_draft_available(
        self, state: dict, draft_id: str, *, except_job_id: str | None = None
    ) -> None:
        if any(
            job["draftId"] == draft_id
            and job["jobId"] != except_job_id
            and job["status"] in ("active", "recovery_required")
            for job in state["jobs"]
        ):
            raise HostError(409, "draft_already_scheduled")

    def _check_all_owned(self, state: dict, tasks: list[dict]) -> list[dict]:
        known = {job["jobId"]: job for job in state["jobs"]}
        actual = []
        seen = set()
        for task in tasks:
            name = task.get("taskName", "")
            if not isinstance(name, str) or not name.casefold().startswith(
                TASK_PREFIX.casefold()
            ):
                continue
            suffix = name[len(TASK_PREFIX) :]
            if not ID_RX.fullmatch(suffix) or suffix not in known:
                raise HostError(503, "scheduler_orphan_task_refused")
            if suffix in seen:
                raise HostError(503, "scheduler_task_ambiguous")
            seen.add(suffix)
            job = known[suffix]
            if job["status"] == "active":
                if not _matching_task(task, job, self.config, enabled=True):
                    raise HostError(503, "scheduler_readback_mismatch")
            elif job["status"] == "cancelled":
                raise HostError(503, "cancelled_scheduler_task_present")
            else:
                raise HostError(503, "scheduler_operation_recovery_required")
            actual.append(self._public_job(job, task))
        for job in state["jobs"]:
            if job["status"] == "recovery_required":
                raise HostError(503, "scheduler_operation_recovery_required")
            if job["status"] == "active" and job["jobId"] not in seen:
                raise HostError(503, "scheduler_task_missing")
        if state["pending"] is not None:
            raise HostError(503, "scheduler_operation_recovery_required")
        return actual

    def _public_job(self, job: dict, task: dict) -> dict:
        trigger = task["triggers"][0]
        principal = task["principal"]
        return {
            "jobId": job["jobId"],
            "revision": job["revision"],
            "draftId": job["draftId"],
            "draftRevision": job["draftRevision"],
            "title": job["title"],
            "date": job["date"],
            "time": job["time"],
            "timezone": job["timezone"],
            "recurrence": job["recurrence"],
            "enabled": task["enabled"],
            "status": job["status"],
            "ownerSid": job["ownerSid"],
            "executionIdentitySid": job["executionIdentitySid"],
            "principalSid": principal["userId"],
            "promptRevision": job["promptRevision"],
            "promptSha256": job["promptSha256"],
            "missedRunPolicy": job["missedRunPolicy"],
            "taskPresent": True,
            "lastReceipt": job.get("lastReceipt"),
            "schedulerReadback": {
                "taskName": task["taskName"],
                "taskPath": task["taskPath"],
                "triggerKind": trigger["kind"],
                "startBoundary": trigger["startBoundary"],
                "daysInterval": trigger.get("daysInterval"),
                "weeksInterval": trigger.get("weeksInterval"),
                "daysOfWeek": trigger.get("daysOfWeek", []),
                "enabled": task["enabled"],
                "principalSid": principal["userId"],
                "actionMatches": True,
            },
        }

    def get_state(self) -> dict:
        with self.store.locked():
            self._check_timezone()
            state = self.store.read()
            tasks = self.scheduler.list_tasks()
            schedules = self._check_all_owned(state, tasks)
            return {
                "ok": True,
                "state": "ready",
                "ownerSid": self.config.owner_sid,
                "executionIdentitySid": self.config.execution_identity_sid,
                "systemTimeZoneId": TIMEZONE_WINDOWS,
                "capabilities": {
                    "schedule": {
                        "register": True,
                        "update": True,
                        "cancel": True,
                        "readback": True,
                        "execute": True,
                    }
                },
                "schedules": schedules,
            }

    def handle_action(self, body: Any) -> tuple[int, dict]:
        if not isinstance(body, dict):
            raise HostError(400, "invalid_json_object")
        action = body.get("action")
        fields = ALLOWED_ACTIONS.get(action)
        if fields is None:
            raise HostError(400, "unknown_action")
        _require_exact_fields(body, fields, "unknown_or_missing_action_field")
        if body.get("confirm") is not True or type(body.get("confirm")) is not bool:
            raise HostError(400, "confirmation_required")
        request_id = body.get("requestId")
        if not isinstance(request_id, str) or not REQUEST_ID_RX.fullmatch(request_id):
            raise HostError(400, "invalid_request_id")
        if action in ("register-schedule", "update-schedule"):
            draft_id = body.get("draftId")
            expected_draft_revision = body.get("expectedDraftRevision")
            if not isinstance(draft_id, str) or not ID_RX.fullmatch(draft_id):
                raise HostError(400, "invalid_draft_id")
            if type(expected_draft_revision) is not int or expected_draft_revision < 1:
                raise HostError(400, "invalid_draft_revision")
        if action in ("update-schedule", "cancel-schedule"):
            job_id = body.get("jobId")
            expected_revision = body.get("expectedRevision")
            if not isinstance(job_id, str) or not ID_RX.fullmatch(job_id):
                raise HostError(400, "invalid_job_id")
            if type(expected_revision) is not int or expected_revision < 1:
                raise HostError(400, "invalid_schedule_revision")
        with self.store.locked():
            state = self.store.read()
            request_hash = _canonical_hash(body)
            previous = state["requests"].get(request_id)
            if previous is not None:
                if previous["payloadSha256"] != request_hash:
                    raise HostError(409, "request_id_payload_conflict")
                return self._replay(state, request_id, previous)
            if state["pending"] is not None:
                raise HostError(503, "scheduler_operation_recovery_required")
            if len(state["requests"]) >= MAX_REQUESTS:
                raise HostError(507, "request_tombstone_limit_reached")
            self._check_timezone()
            if action == "register-schedule":
                return self._register(state, body, request_hash)
            if action == "update-schedule":
                return self._update(state, body, request_hash)
            return self._cancel(state, body, request_hash)

    def _record_request(
        self, state: dict, request_id: str, body: dict, digest: str, job_id: str, receipt: dict | None, status: str
    ) -> dict:
        record = {
            "action": body["action"],
            "payloadSha256": digest,
            "jobId": job_id,
            "status": status,
            "receipt": receipt,
        }
        state["requests"][request_id] = record
        return record

    def _begin_pending(self, state: dict, request: dict, request_hash: str, candidate: dict, old: dict | None) -> None:
        state["pending"] = {
            "requestId": request["requestId"],
            "action": request["action"],
            "jobId": candidate["jobId"],
            "stage": "prepared",
            "oldJob": old,
            "candidate": candidate,
        }
        self._record_request(
            state, request["requestId"], request, request_hash, candidate["jobId"], None, "pending"
        )
        self.store.write(state)

    def _receipt(self, action: str, request_id: str, job: dict, task: dict | None) -> dict:
        if task is None:
            readback = {
                "taskPresent": False,
                "enabled": False,
                "jobId": job["jobId"],
            }
        else:
            public = self._public_job(job, task)
            readback = public["schedulerReadback"]
            readback["taskPresent"] = True
            readback["enabled"] = task["enabled"]
            readback["promptRevision"] = job["promptRevision"]
            readback["promptSha256"] = job["promptSha256"]
            readback["recurrence"] = job["recurrence"]
            readback["timezone"] = job["timezone"]
            readback["jobId"] = job["jobId"]
        return {
            "operation": action,
            "requestId": request_id,
            "jobId": job["jobId"],
            "revision": job["revision"],
            "status": job["status"],
            "active": job["active"],
            "completedAt": self._now_text(),
            "schedulerReadback": readback,
        }

    def _safe_recovery_disable(self, job: dict | None) -> None:
        if not job:
            return
        tasks = self.scheduler.list_tasks()
        task = _task_for_id(tasks, job["jobId"])
        if task is None:
            return
        if _matching_task(task, job, self.config, enabled=bool(task.get("enabled"))):
            if task.get("state") == "Running":
                return
            self.scheduler.disable(job)

    def _fail_pending(self, state: dict, request_id: str, job: dict, old: dict | None) -> None:
        pending = state.get("pending") or {}
        try:
            self._safe_recovery_disable(job)
            self._safe_recovery_disable(old)
        except HostError:
            # Preserve the journal; subsequent readback remains UNKNOWN.
            return
        stored = next((item for item in state["jobs"] if item["jobId"] == job["jobId"]), None)
        if stored is None:
            job["status"] = "recovery_required"
            job["active"] = False
            state["jobs"].append(job)
        else:
            stored["status"] = "recovery_required"
            stored["active"] = False
        record = state["requests"].get(request_id)
        if record:
            record["status"] = "failed"
            record["receipt"] = {
                "operation": pending.get("action"),
                "jobId": job["jobId"],
                "status": "recovery_required",
                "active": False,
                "error": "scheduler_operation_unverified",
            }
        state["pending"] = None
        self.store.write(state)

    def _register(self, state: dict, body: dict, digest: str) -> tuple[int, dict]:
        if len(state["jobs"]) >= MAX_JOBS:
            raise HostError(507, "schedule_limit_reached")
        draft = self.drafts.get(body["draftId"], body["expectedDraftRevision"])
        self._ensure_draft_available(state, draft["id"])
        candidate = self._new_job(draft)
        if candidate["jobId"] in state["retiredJobIds"] or any(
            item["jobId"] == candidate["jobId"] for item in state["jobs"]
        ):
            raise HostError(503, "job_id_collision")
        self._begin_pending(state, body, digest, candidate, None)
        try:
            self.scheduler.create_disabled(candidate)
            tasks = self.scheduler.list_tasks()
            task = _task_for_id(tasks, candidate["jobId"])
            if task is None or not _matching_task(task, candidate, self.config, enabled=False):
                raise HostError(503, "scheduler_disabled_registration_unverified")
            candidate["status"] = "recovery_required"
            candidate["active"] = False
            state["jobs"].append(candidate)
            state["pending"]["stage"] = "disabled_readback"
            state["pending"]["candidate"] = candidate
            self.store.write(state)
            self.scheduler.enable(candidate)
            tasks = self.scheduler.list_tasks()
            task = _task_for_id(tasks, candidate["jobId"])
            if task is None or not _matching_task(task, candidate, self.config, enabled=True):
                raise HostError(503, "scheduler_enable_unverified")
            candidate["status"] = "active"
            candidate["active"] = True
            candidate["lastReceipt"] = self._receipt(
                "register-schedule", body["requestId"], candidate, task
            )
            state["pending"] = None
            request = self._record_request(
                state,
                body["requestId"],
                body,
                digest,
                candidate["jobId"],
                candidate["lastReceipt"],
                "complete",
            )
            self.store.write(state)
            return 200, {
                "ok": True,
                **candidate_public(candidate),
                "requestId": body["requestId"],
                "replayed": False,
                "receipt": request["receipt"],
            }
        except Exception as exc:
            self._fail_pending(state, body["requestId"], candidate, None)
            if isinstance(exc, HostError):
                raise
            raise HostError(503, "scheduler_operation_unverified") from exc

    def _update(self, state: dict, body: dict, digest: str) -> tuple[int, dict]:
        previous = self._find_job(state, body["jobId"])
        if previous["status"] != "active":
            raise HostError(409, "schedule_not_active")
        if previous["revision"] != body["expectedRevision"]:
            raise HostError(409, "schedule_changed_refresh_required")
        draft = self.drafts.get(body["draftId"], body["expectedDraftRevision"])
        self._ensure_draft_available(
            state, draft["id"], except_job_id=previous["jobId"]
        )
        candidate = self._updated_job(previous, draft)
        actual = _task_for_id(self.scheduler.list_tasks(), previous["jobId"])
        if actual is None or not _matching_task(actual, previous, self.config, enabled=True):
            raise HostError(503, "scheduler_readback_mismatch")
        if actual.get("state") == "Running":
            raise HostError(409, "schedule_running_update_refused")
        self._begin_pending(state, body, digest, candidate, previous)
        try:
            self.scheduler.disable(previous)
            task = _task_for_id(self.scheduler.list_tasks(), previous["jobId"])
            if task is None or not _matching_task(task, previous, self.config, enabled=False):
                raise HostError(503, "scheduler_disable_unverified")
            self.scheduler.replace_disabled(previous, candidate)
            task = _task_for_id(self.scheduler.list_tasks(), candidate["jobId"])
            if task is None or not _matching_task(task, candidate, self.config, enabled=False):
                raise HostError(503, "scheduler_update_unverified")
            candidate["status"] = "recovery_required"
            candidate["active"] = False
            state["jobs"][state["jobs"].index(previous)] = candidate
            state["pending"]["stage"] = "disabled_readback"
            state["pending"]["candidate"] = candidate
            self.store.write(state)
            self.scheduler.enable(candidate)
            task = _task_for_id(self.scheduler.list_tasks(), candidate["jobId"])
            if task is None or not _matching_task(task, candidate, self.config, enabled=True):
                raise HostError(503, "scheduler_enable_unverified")
            candidate["status"] = "active"
            candidate["active"] = True
            candidate["lastReceipt"] = self._receipt(
                "update-schedule", body["requestId"], candidate, task
            )
            state["pending"] = None
            request = self._record_request(
                state,
                body["requestId"],
                body,
                digest,
                candidate["jobId"],
                candidate["lastReceipt"],
                "complete",
            )
            self.store.write(state)
            return 200, {
                "ok": True,
                **candidate_public(candidate),
                "requestId": body["requestId"],
                "replayed": False,
                "receipt": request["receipt"],
            }
        except Exception as exc:
            self._fail_pending(state, body["requestId"], candidate, previous)
            if isinstance(exc, HostError):
                raise
            raise HostError(503, "scheduler_operation_unverified") from exc

    def _cancel(self, state: dict, body: dict, digest: str) -> tuple[int, dict]:
        previous = self._find_job(state, body["jobId"])
        if previous["status"] == "cancelled":
            raise HostError(409, "schedule_already_cancelled")
        if previous["status"] != "active":
            raise HostError(409, "schedule_not_active")
        if previous["revision"] != body["expectedRevision"]:
            raise HostError(409, "schedule_changed_refresh_required")
        if len(state["retiredJobIds"]) >= MAX_RETIRED_JOBS:
            raise HostError(507, "retired_job_limit_reached")
        task = _task_for_id(self.scheduler.list_tasks(), previous["jobId"])
        if task is None or not _matching_task(task, previous, self.config, enabled=True):
            raise HostError(503, "scheduler_readback_mismatch")
        if task.get("state") == "Running":
            raise HostError(409, "schedule_running_cancel_refused")
        candidate = json.loads(json.dumps(previous))
        candidate["revision"] = previous["revision"] + 1
        candidate["status"] = "cancelled"
        candidate["active"] = False
        candidate["updatedAt"] = self._now_text()
        self._begin_pending(state, body, digest, candidate, previous)
        try:
            self.scheduler.disable(previous)
            disabled = _task_for_id(self.scheduler.list_tasks(), previous["jobId"])
            if disabled is None or not _matching_task(
                disabled, previous, self.config, enabled=False
            ):
                raise HostError(503, "scheduler_disable_unverified")
            self.scheduler.remove(previous)
            if _task_for_id(self.scheduler.list_tasks(), previous["jobId"]) is not None:
                raise HostError(503, "scheduler_removal_unverified")
            state["jobs"][state["jobs"].index(previous)] = candidate
            state["retiredJobIds"].append(candidate["jobId"])
            candidate["lastReceipt"] = self._receipt(
                "cancel-schedule", body["requestId"], candidate, None
            )
            state["pending"] = None
            request = self._record_request(
                state,
                body["requestId"],
                body,
                digest,
                candidate["jobId"],
                candidate["lastReceipt"],
                "complete",
            )
            self.store.write(state)
            return 200, {
                "ok": True,
                **candidate_public(candidate),
                "requestId": body["requestId"],
                "replayed": False,
                "receipt": request["receipt"],
            }
        except Exception as exc:
            self._fail_pending(state, body["requestId"], candidate, previous)
            if isinstance(exc, HostError):
                raise
            raise HostError(503, "scheduler_operation_unverified") from exc

    def _replay(self, state: dict, request_id: str, request: dict) -> tuple[int, dict]:
        if request["status"] == "pending":
            raise HostError(503, "scheduler_operation_recovery_required")
        job = next(
            (item for item in state["jobs"] if item["jobId"] == request["jobId"]),
            None,
        )
        receipt = request.get("receipt") or {}
        active = False
        readback = None
        tasks = self.scheduler.list_tasks()
        task = _task_for_id(tasks, request["jobId"])
        if job and job["status"] == "active" and task is not None:
            if not _matching_task(task, job, self.config, enabled=True):
                raise HostError(503, "scheduler_readback_mismatch")
            active = True
            readback = self._public_job(job, task)["schedulerReadback"]
        elif task is not None:
            raise HostError(503, "scheduler_state_ambiguous")
        elif job and job["status"] == "active":
            raise HostError(503, "scheduler_task_missing")
        result = dict(receipt)
        result["active"] = active
        if readback is not None:
            result["schedulerReadback"] = readback
        return 200, {
            "ok": True,
            "requestId": request_id,
            "jobId": request["jobId"],
            "revision": job["revision"] if job else receipt.get("revision"),
            "status": job["status"] if job else receipt.get("status", "unknown"),
            "active": active,
            "replayed": True,
            "receipt": result,
        }

    def _state_for_job(self, job_id: str) -> tuple[dict, dict | None]:
        state = self.store.read()
        job = self._find_job(state, job_id)
        task = _task_for_id(self.scheduler.list_tasks(), job_id)
        if job["status"] == "active":
            if task is None or not _matching_task(task, job, self.config, enabled=True):
                raise HostError(503, "scheduler_readback_mismatch")
        elif task is not None:
            raise HostError(503, "scheduler_state_ambiguous")
        return job, task

    def execute_job(
        self,
        job_id: str,
        expected_revision: int,
        expected_prompt_revision: int,
        expected_prompt_sha256: str,
    ) -> dict:
        with self.store.job_locked(job_id, nonblocking=True):
            return self._execute_job_once(
                job_id,
                expected_revision,
                expected_prompt_revision,
                expected_prompt_sha256,
            )

    def _execute_job_once(
        self,
        job_id: str,
        expected_revision: int,
        expected_prompt_revision: int,
        expected_prompt_sha256: str,
    ) -> dict:
        if not isinstance(job_id, str) or not ID_RX.fullmatch(job_id):
            raise HostError(400, "invalid_job_id")
        if (
            type(expected_revision) is not int
            or type(expected_prompt_revision) is not int
            or not isinstance(expected_prompt_sha256, str)
            or not SHA_RX.fullmatch(expected_prompt_sha256)
        ):
            raise HostError(400, "invalid_job_revision")
        self._check_timezone()
        with self.store.locked():
            state = self.store.read()
            if state["pending"] is not None:
                raise HostError(503, "scheduler_operation_recovery_required")
            job = self._find_job(state, job_id)
            if job["status"] != "active":
                raise HostError(409, "schedule_not_active")
            if (
                job["revision"] != expected_revision
                or job["promptRevision"] != expected_prompt_revision
                or job["promptSha256"] != expected_prompt_sha256
            ):
                raise HostError(409, "stale_task_action")
            task = _task_for_id(self.scheduler.list_tasks(), job_id)
            if task is None or not _matching_task(task, job, self.config, enabled=True):
                raise HostError(503, "scheduler_readback_mismatch")
            now = self.clock()
            receipt = self._claim_occurrence(state, job, now)
            if receipt["status"] != "started":
                return {"ok": True, "jobId": job_id, "receipt": receipt}
            prompt_record = next(
                item for item in job["promptRevisions"] if item["revision"] == job["promptRevision"]
            )
            prompt = prompt_record["text"]
            if _sha_prompt(prompt) != job["promptSha256"]:
                receipt["status"] = "failed"
                receipt["error"] = "prompt_hash_mismatch"
                receipt["finishedAt"] = self._now_text()
                self._sync_global_execution_receipt(state, receipt)
                self.store.write(state)
                raise HostError(503, "prompt_hash_mismatch")
            self.store.write(state)
            occurrence_key = receipt["occurrenceKey"]
        try:
            code = self.runner(prompt)
            if type(code) is not int:
                raise RuntimeError("runner_exit_code_invalid")
            final_status = "succeeded" if code == 0 else "failed"
            safe_error = None if code == 0 else "runner_nonzero_exit"
            exit_code = code
        except subprocess.TimeoutExpired:
            final_status, safe_error = "failed", "runner_timeout"
            exit_code = None
        except Exception:
            final_status, safe_error = "failed", "runner_unavailable"
            exit_code = None
        with self.store.locked():
            state = self.store.read()
            current = self._find_job(state, job_id)
            receipt = next(
                item
                for item in reversed(current["executionReceipts"])
                if item.get("status") == "started" and item.get("occurrenceKey") == occurrence_key
            )
            receipt["status"] = final_status
            receipt["finishedAt"] = self._now_text()
            receipt["exitCode"] = exit_code
            if safe_error:
                receipt["error"] = safe_error
            current["lastReceipt"] = dict(receipt)
            self._sync_global_execution_receipt(state, receipt)
            self.store.write(state)
        return {"ok": True, "jobId": job_id, "receipt": dict(receipt)}

    def _occurrence_key(self, job: dict, now: datetime) -> str:
        if now.tzinfo is None:
            now = now.replace(tzinfo=ZoneInfo(TIMEZONE_IANA))
        local_now = now.astimezone(ZoneInfo(TIMEZONE_IANA))
        scheduled_day = date.fromisoformat(job["date"])
        scheduled_time = datetime.strptime(job["time"], "%H:%M").time()
        if job["recurrence"] == "once":
            return f"once:{job['date']}T{job['time']}"
        if local_now.date() < scheduled_day:
            return ""
        if job["recurrence"] == "weekly" and local_now.weekday() != scheduled_day.weekday():
            return ""
        return f"{local_now.date().isoformat()}T{scheduled_time.strftime('%H:%M')}"

    def _claim_occurrence(self, state: dict, job: dict, now: datetime) -> dict:
        key = self._occurrence_key(job, now)
        local_now = now.astimezone(ZoneInfo(TIMEZONE_IANA)) if now.tzinfo else now.replace(tzinfo=ZoneInfo(TIMEZONE_IANA))
        expected_day = date.fromisoformat(job["date"])
        expected_time = datetime.strptime(job["time"], "%H:%M").time()
        if not key:
            raise HostError(409, "no_scheduled_occurrence")
        existing = next(
            (old for old in job["executionReceipts"] if old.get("occurrenceKey") == key),
            None,
        )
        if existing is not None:
            if existing.get("status") == "started":
                existing["status"] = "interrupted"
                existing["finishedAt"] = self._now_text()
                existing["error"] = "interrupted_before_completion"
                job["lastReceipt"] = dict(existing)
                self._sync_global_execution_receipt(state, existing)
                self.store.write(state)
            return existing
        if job["recurrence"] == "once":
            scheduled = datetime.combine(expected_day, expected_time, ZoneInfo(TIMEZONE_IANA))
        else:
            scheduled = datetime.combine(local_now.date(), expected_time, ZoneInfo(TIMEZONE_IANA))
        lag = (local_now - scheduled).total_seconds()
        if lag < -5 or lag > RUN_GRACE_SECONDS:
            receipt = {
                "jobId": job["jobId"],
                "scheduleRevision": job["revision"],
                "promptRevision": job["promptRevision"],
                "promptSha256": job["promptSha256"],
                "occurrenceKey": key,
                "startedAt": self._now_text(),
                "finishedAt": self._now_text(),
                "status": "skipped",
                "error": "missed_run_skipped",
            }
            if len(state["executionReceipts"]) >= MAX_EXECUTION_RECEIPTS:
                raise HostError(507, "execution_receipt_limit_reached")
            state["executionReceipts"].append(receipt)
            job["executionReceipts"].append(receipt)
            job["lastReceipt"] = dict(receipt)
            self.store.write(state)
            return receipt
        if len(state["executionReceipts"]) >= MAX_EXECUTION_RECEIPTS:
            raise HostError(507, "execution_receipt_limit_reached")
        receipt = {
            "jobId": job["jobId"],
            "scheduleRevision": job["revision"],
            "promptRevision": job["promptRevision"],
            "promptSha256": job["promptSha256"],
            "occurrenceKey": key,
            "startedAt": self._now_text(),
            "status": "started",
        }
        state["executionReceipts"].append(receipt)
        job["executionReceipts"].append(receipt)
        job["lastReceipt"] = dict(receipt)
        return receipt

    def _run_configured_runner(self, prompt: str) -> int:
        if self.config.runner_exe.name.casefold() == "codex.exe":
            args = [
                str(self.config.runner_exe),
                "exec",
                "--cd",
                str(self.config.workspace),
                "--sandbox",
                self.config.sandbox,
            ]
        else:
            args = [str(self.config.runner_exe), *self.config.runner_arguments]
        result = subprocess.run(
            args,
            input=prompt.encode("utf-8"),
            stdout=subprocess.DEVNULL,
            stderr=subprocess.DEVNULL,
            shell=False,
            timeout=self.config.run_timeout_seconds,
            cwd=str(self.config.workspace),
            check=False,
            creationflags=getattr(subprocess, "CREATE_NO_WINDOW", 0),
        )
        return result.returncode


def candidate_public(job: dict) -> dict:
    return {
        "jobId": job["jobId"],
        "revision": job["revision"],
        "draftId": job["draftId"],
        "draftRevision": job["draftRevision"],
        "title": job["title"],
        "date": job["date"],
        "time": job["time"],
        "timezone": job["timezone"],
        "recurrence": job["recurrence"],
        "enabled": job["active"],
        "active": job["active"],
        "status": job["status"],
        "ownerSid": job["ownerSid"],
        "executionIdentitySid": job["executionIdentitySid"],
        "promptRevision": job["promptRevision"],
        "promptSha256": job["promptSha256"],
        "missedRunPolicy": job["missedRunPolicy"],
    }


class _Server(ThreadingHTTPServer):
    daemon_threads = True
    allow_reuse_address = False


def create_http_server(host: GhostScheduler) -> ThreadingHTTPServer:
    if host.config.listen_host == "localhost":
        bind_host = "127.0.0.1"
    else:
        bind_host = host.config.listen_host

    class Handler(BaseHTTPRequestHandler):
        server_version = "SingularityGhostScheduler/1"
        sys_version = ""

        def log_message(self, format, *args):
            # Requests can contain private prompt metadata; never write them to logs.
            return

        def _send(self, status: int, payload: dict) -> None:
            raw = json.dumps(payload, ensure_ascii=False, separators=(",", ":")).encode()
            self.send_response(status)
            self.send_header("Content-Type", "application/json; charset=utf-8")
            self.send_header("Cache-Control", "no-store")
            self.send_header("X-Content-Type-Options", "nosniff")
            self.send_header("Content-Length", str(len(raw)))
            self.end_headers()
            self.wfile.write(raw)

        def _authorized(self) -> bool:
            try:
                import ipaddress

                if not ipaddress.ip_address(self.client_address[0]).is_loopback:
                    return False
            except (ValueError, IndexError):
                return False
            supplied = self.headers.get("X-Ghost-Control-Key", "")
            return isinstance(supplied, str) and hmac.compare_digest(
                supplied, host.config.control_key
            )

        def do_GET(self):
            if self.path != "/state":
                self._send(404, {"ok": False, "error": "not_found"})
                return
            if not self._authorized():
                self._send(403, {"ok": False, "error": "control_request_rejected"})
                return
            try:
                self._send(200, host.get_state())
            except HostError as exc:
                self._send(exc.status, {"ok": False, "state": "unknown", "error": exc.code})
            except Exception:
                self._send(
                    503,
                    {"ok": False, "state": "unknown", "error": "host_operation_failed"},
                )

        def do_POST(self):
            if self.path != "/action":
                self._send(404, {"ok": False, "error": "not_found"})
                return
            if not self._authorized():
                self._send(403, {"ok": False, "error": "control_request_rejected"})
                return
            if self.headers.get("Content-Type", "").split(";", 1)[0].strip().lower() != "application/json":
                self._send(415, {"ok": False, "error": "application_json_required"})
                return
            try:
                length = int(self.headers.get("Content-Length", "0"))
            except ValueError:
                length = -1
            if not 0 < length <= MAX_HTTP_BODY:
                self._send(413, {"ok": False, "error": "invalid_request_size"})
                return
            if self.headers.get("Transfer-Encoding"):
                self._send(400, {"ok": False, "error": "transfer_encoding_refused"})
                return
            try:
                body = _decode_json(self.rfile.read(length), maximum=MAX_HTTP_BODY)
                status, payload = host.handle_action(body)
                self._send(status, payload)
            except HostError as exc:
                self._send(exc.status, {"ok": False, "error": exc.code})
            except (ValueError, UnicodeError, json.JSONDecodeError):
                self._send(400, {"ok": False, "error": "invalid_json"})
            except Exception:
                # Do not expose request content, prompts, paths or process output.
                self._send(503, {"ok": False, "error": "scheduler_operation_unverified"})

    return _Server((bind_host, host.config.listen_port), Handler)


def _default_config_path() -> Path:
    local = os.environ.get("LOCALAPPDATA", "")
    if not local:
        raise HostError(503, "localappdata_unavailable")
    return Path(local) / "Singularity" / "GhostScheduler" / "config.json"


def _run_configured(host: GhostScheduler, config: HostConfig) -> int:
    with host.owner_lock():
        host._check_timezone()
        host.recover_pending()
        server = create_http_server(host)
        try:
            server.serve_forever(poll_interval=0.25)
        finally:
            server.server_close()
    return 0


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description="Native Windows Ghost schedule host")
    parser.add_argument("--config", type=Path)
    parser.add_argument("--execute-job", type=str)
    parser.add_argument("--revision", type=int)
    parser.add_argument("--prompt-revision", type=int)
    parser.add_argument("--prompt-sha256", type=str)
    args = parser.parse_args(argv)
    scheduler = PowerShellTaskScheduler()
    try:
        config_path = args.config or _default_config_path()
        config = HostConfig.load(config_path, scheduler)
        host = GhostScheduler(config, scheduler)
        if args.execute_job:
            if (
                args.revision is None
                or args.prompt_revision is None
                or args.prompt_sha256 is None
            ):
                raise HostError(400, "task_action_revision_required")
            result = host.execute_job(
                args.execute_job,
                args.revision,
                args.prompt_revision,
                args.prompt_sha256,
            )
            print(
                json.dumps(
                    {
                        "ok": result.get("ok"),
                        "jobId": args.execute_job,
                        "status": result.get("receipt", {}).get("status"),
                        "exitCode": result.get("receipt", {}).get("exitCode"),
                    }
                )
            )
            return 0
        return _run_configured(host, config)
    except HostError as exc:
        # Only a fixed error code is emitted; never log config, prompts or paths.
        print(json.dumps({"ok": False, "error": exc.code}))
        return 2
    except Exception:
        # Configured runner errors can contain arguments; never emit tracebacks.
        print(json.dumps({"ok": False, "error": "host_operation_failed"}))
        return 2


if __name__ == "__main__":
    raise SystemExit(main())
