"""Unit tests for memory/rc_stack.py: RC-owned config, scoped probe, teardown."""
from __future__ import annotations

import json
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch

import rc_stack


class FakeResponse:
    def __init__(self, payload):
        self.payload = payload

    def read(self):
        return json.dumps(self.payload).encode()

    def __enter__(self):
        return self

    def __exit__(self, *_exc):
        return False


class Recorder:
    """Answers the four probe calls in order and records every request."""

    def __init__(self, *, recall=True, delete_clears=True):
        self.calls = []
        self.recall = recall
        self.delete_clears = delete_clears
        self.deleted = False

    def __call__(self, request, timeout=30):
        body = json.loads(request.data.decode())
        self.calls.append({
            "url": request.full_url,
            "headers": {k.lower(): v for k, v in request.header_items()},
            "body": body,
        })
        if request.full_url.endswith("/conversation/add"):
            return FakeResponse({"code": 0, "data": {"accepted_ids": ["m1", "m2"]}})
        if request.full_url.endswith("/conversation/search"):
            hits = [] if (self.deleted and self.delete_clears) or not self.recall else [
                {"id": "m1", "content": body["query"]},
                {"id": "m2", "content": "ack " + body["query"]},
            ]
            return FakeResponse({"code": 0, "data": {"messages": hits}})
        if request.full_url.endswith("/conversation/delete"):
            if self.delete_clears:
                self.deleted = True
            return FakeResponse({"code": 0, "data": {"deleted_count": 2}})
        raise AssertionError("unexpected url " + request.full_url)


class ConfigTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name)
        self.core = self.root / "build" / "MemoryCore"
        self.panel = self.root / "build" / "MemoryPanel"
        self.core.mkdir(parents=True)
        self.panel.mkdir(parents=True)
        self.node = self.root / "node.exe"
        self.node.write_text("x")

    def test_state_and_logs_stay_under_rc_root(self):
        rc = self.root / "rc"
        config = rc_stack.build_config(rc, node=self.node, core_dir=self.core, panel_dir=self.panel)
        self.assertEqual(Path(config["stateDir"]), rc / "state")
        self.assertEqual(Path(config["logsDir"]), rc / "logs")
        self.assertEqual(Path(config["components"]["core"]["cwd"]), self.core)
        self.assertEqual(Path(config["components"]["panel"]["cwd"]), self.panel)
        flat = json.dumps(config)
        for production in ("18421", "18431", "18126", "8125"):
            self.assertNotIn(production, flat)

    def test_refuses_relative_root_and_missing_inputs(self):
        with self.assertRaisesRegex(rc_stack.StackError, "absolute"):
            rc_stack.build_config("relative/rc", node=self.node, core_dir=self.core,
                                  panel_dir=self.panel)
        with self.assertRaisesRegex(rc_stack.StackError, "vendor build input"):
            rc_stack.build_config(self.root / "rc", node=self.node,
                                  core_dir=self.core / "nope", panel_dir=self.panel)
        with self.assertRaisesRegex(rc_stack.StackError, "distinct ports"):
            rc_stack.build_config(self.root / "rc", node=self.node, core_dir=self.core,
                                  panel_dir=self.panel, core_port=19000, panel_port=19000)

    def test_write_config_is_readable_by_supervisor(self):
        path = rc_stack.write_config(
            rc_stack.build_config(self.root / "rc", node=self.node, core_dir=self.core,
                                  panel_dir=self.panel),
            self.root / "rc" / "stack.json")
        raw = path.read_text(encoding="utf-8")
        self.assertNotIn("\ufeff", raw)
        self.assertEqual(json.loads(raw)["schema"], rc_stack.SCHEMA)


class ProbeTests(unittest.TestCase):
    def test_probe_writes_recalls_deletes_and_proves_empty(self):
        recorder = Recorder()
        result = rc_stack.probe("http://127.0.0.1:19999/", "token-value", session_id="s1",
                                text="rc marker", opener=recorder)
        self.assertEqual(result, {"accepted": 2, "recalled": 2, "deleted": 2, "remaining": 0})
        urls = [call["url"] for call in recorder.calls]
        self.assertEqual(len(urls), 4)
        self.assertTrue(urls[0].endswith("/conversation/add"))
        for call in recorder.calls:
            self.assertEqual(call["headers"]["x-tdai-service-id"], "default")
            self.assertEqual(call["headers"]["authorization"], "Bearer token-value")
        delete = recorder.calls[2]["body"]
        self.assertEqual(delete["session_ids"], ["s1"])
        self.assertEqual(delete["message_ids"], ["m1", "m2"])
        self.assertNotIn("token-value", json.dumps(recorder.calls[0]["body"]))

    def test_probe_refuses_a_surviving_record(self):
        with self.assertRaisesRegex(rc_stack.StackError, "survived deletion"):
            rc_stack.probe("http://127.0.0.1:19999", "t", session_id="s1", text="m",
                           opener=Recorder(delete_clears=False))

    def test_probe_reports_empty_recall(self):
        with self.assertRaisesRegex(rc_stack.StackError, "recall returned nothing"):
            rc_stack.probe("http://127.0.0.1:19999", "t", session_id="s1", text="m",
                           opener=Recorder(recall=False))


class LifecycleTests(unittest.TestCase):
    def test_start_failure_surfaces_stderr(self):
        def failing(_node, _sup, _verb, _cfg):
            return 1, None, "port 18221 already in use"

        with self.assertRaisesRegex(rc_stack.StackError, "already in use"):
            rc_stack.start("node", "sup", "cfg.json", run=failing)

    def test_healthy_requires_running_and_verified_ownership(self):
        good = {"code": "RUNNING", "processes": [
            {"health": "ok", "ownership": "verified"},
            {"health": "ok", "ownership": "verified"}]}
        self.assertTrue(rc_stack.healthy(good))
        self.assertFalse(rc_stack.healthy({"code": "STOPPED", "processes": good["processes"]}))
        self.assertFalse(rc_stack.healthy({"code": "RUNNING", "processes": [
            {"health": "ok", "ownership": "unverified"}]}))
        self.assertFalse(rc_stack.healthy({}))

    def test_read_token_refuses_empty_secret(self):
        with tempfile.TemporaryDirectory() as td:
            state = Path(td) / "state"
            (state / "secrets").mkdir(parents=True)
            (state / "secrets" / "core-bearer").write_text("  \n")
            config = {"stateDir": str(state)}
            with self.assertRaisesRegex(rc_stack.StackError, "empty"):
                rc_stack.read_token(config)
            (state / "secrets" / "core-bearer").write_text("abc123\n")
            token, path = rc_stack.read_token(config)
            self.assertEqual(token, "abc123")
            self.assertEqual(path, state / "secrets" / "core-bearer")

    def test_cleanup_only_accepts_a_state_directory(self):
        with tempfile.TemporaryDirectory() as td:
            root = Path(td)
            with self.assertRaisesRegex(rc_stack.StackError, "not an RC state dir"):
                rc_stack.cleanup(root)
            state = root / "state"
            (state / "data" / "core").mkdir(parents=True)
            (state / "data" / "core" / "db.sqlite").write_text("x")
            (state / "marker").write_text("y")
            self.assertTrue(rc_stack.cleanup(state))
            self.assertFalse(state.exists())
            self.assertFalse(rc_stack.cleanup(state))


if __name__ == "__main__":
    unittest.main()
