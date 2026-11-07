"""Unit contracts for the zero-touch RC local service bootstrap (fleet#893)."""
from __future__ import annotations

import subprocess
import sys
import tempfile
import unittest
from pathlib import Path

HERE = Path(__file__).resolve().parent
if str(HERE) not in sys.path:
    sys.path.insert(0, str(HERE))

import rc_services as rc  # noqa: E402


def completed(stdout="", stderr="", code=0):
    return subprocess.CompletedProcess(args=["fake"], returncode=code, stdout=stdout, stderr=stderr)


def defaults_for(tmp: Path, **overrides):
    env = {"LOCALAPPDATA": str(tmp)}
    env.update(overrides)
    d = rc.defaults(env)
    d["root"] = tmp / "Singularity" / "Fleet861RC"
    d["workspace"] = d["root"] / "workspace"
    d["memory_root"] = d["root"] / "memory"
    d["source"] = tmp / "source"
    (tmp / "source").mkdir(parents=True, exist_ok=True)
    return rc.layout(d)


class PortPolicy(unittest.TestCase):
    def test_rc_ports_are_not_production_ports(self):
        with tempfile.TemporaryDirectory() as tmp:
            d = rc.defaults({"LOCALAPPDATA": tmp})
            for port in (d["core_port"], d["panel_port"], d["dashboard_port"]):
                self.assertNotIn(port, rc.FORBIDDEN_PORTS)

    def test_production_port_is_refused(self):
        with tempfile.TemporaryDirectory() as tmp:
            with self.assertRaises(rc.ServiceError):
                rc.defaults({"LOCALAPPDATA": tmp, "SINGULARITY_RC_PANEL_PORT": "18126"})

    def test_core_and_panel_must_differ(self):
        with tempfile.TemporaryDirectory() as tmp:
            with self.assertRaises(rc.ServiceError):
                rc.defaults({"LOCALAPPDATA": tmp, "SINGULARITY_RC_CORE_PORT": "18221",
                             "SINGULARITY_RC_PANEL_PORT": "18221"})


class WorkspaceMarker(unittest.TestCase):
    def test_marker_matches_the_rql_init_layout_and_is_idempotent(self):
        with tempfile.TemporaryDirectory() as tmp:
            workspace = Path(tmp) / "workspace"
            rc.workspace_marker(workspace)
            rc.workspace_marker(workspace)
            marker = workspace / ".repoql"
            self.assertTrue(marker.is_dir())
            self.assertEqual((marker / ".gitignore").read_text(encoding="utf-8"), rc.MARKER_GITIGNORE)
            self.assertTrue((marker / "cache").is_dir())


class RepoqlStartup(unittest.TestCase):
    def test_imports_source_then_verifies_a_running_host(self):
        calls = []
        started = {"value": False}

        def run(cmd, cwd=None, timeout=None):
            calls.append([str(part) for part in cmd])
            if "import" in cmd:
                started["value"] = True
                return completed("Import started: local:///source\n")
            if not started["value"]:
                return completed('{"running": false, "error": "no host"}', code=1)
            return completed('{"running": true, "verdict": "ready", "host": {"pid": 7}}')

        with tempfile.TemporaryDirectory() as tmp:
            d = defaults_for(Path(tmp))
            d["rql"] = Path(tmp) / "rql.exe"
            d["rql"].write_bytes(b"stub")
            report = rc.ensure_repoql(d, run=run, sleep=lambda _s: None)
        self.assertTrue(report["ok"])
        self.assertEqual(report["pid"], 7)
        self.assertTrue(any("import" in call for call in calls))

    def test_no_host_after_import_is_a_failure_not_a_pass(self):
        def run(cmd, cwd=None, timeout=None):
            return completed('{"running": false, "error": "no host"}')

        with tempfile.TemporaryDirectory() as tmp:
            d = defaults_for(Path(tmp))
            d["rql"] = Path(tmp) / "rql.exe"
            d["rql"].write_bytes(b"stub")
            with self.assertRaises(rc.ServiceError) as caught:
                rc.ensure_repoql(d, run=run, sleep=lambda _s: None, attempts=2, delay=0)
        self.assertIn("did not start", str(caught.exception))

    def test_missing_rql_binary_is_reported(self):
        with tempfile.TemporaryDirectory() as tmp:
            d = defaults_for(Path(tmp))
            with self.assertRaises(rc.ServiceError) as caught:
                rc.ensure_repoql(d, run=lambda *a, **k: completed())
        self.assertIn("not installed", str(caught.exception))


class Identity(unittest.TestCase):
    def test_existing_owner_key_is_reused_without_running_anything(self):
        def run(cmd, cwd=None, timeout=None):
            raise AssertionError("no provisioner run expected")

        with tempfile.TemporaryDirectory() as tmp:
            d = defaults_for(Path(tmp))
            d["admin_key"].parent.mkdir(parents=True, exist_ok=True)
            d["admin_key"].write_text("synthetic-key", encoding="utf-8")
            result = rc.ensure_identity(d, run=run)
        self.assertEqual(result["action"], "reused")

    def test_missing_metadata_store_fails_with_its_path(self):
        with tempfile.TemporaryDirectory() as tmp:
            d = defaults_for(Path(tmp))
            script = Path(d["source"]) / "native" / "windows" / "provision_memory_identity.mjs"
            script.parent.mkdir(parents=True, exist_ok=True)
            script.write_text("// stub", encoding="utf-8")
            with self.assertRaises(rc.ServiceError) as caught:
                rc.ensure_identity(d, run=lambda *a, **k: completed(), sleep=lambda _s: None,
                                   attempts=2, delay=0)
        self.assertIn("metadata store never appeared", str(caught.exception))


class DashboardEnvironment(unittest.TestCase):
    def test_panel_environment_is_loopback_only(self):
        with tempfile.TemporaryDirectory() as tmp:
            d = defaults_for(Path(tmp))
            env = rc.panel_env(d)
        self.assertEqual(env["SINGULARITY_BIND"], "127.0.0.1")
        self.assertEqual(env["SINGULARITY_TENCENT_HOST"], "127.0.0.1")
        self.assertTrue(env["TENCENT_PANEL_BASE"].startswith("http://127.0.0.1:"))
        self.assertEqual(env["SINGULARITY_WORKSPACE"], str(d["workspace"]))
        self.assertNotIn(env["SINGULARITY_PORT"], {"18100", "18101", "18126", "18128"})
        self.assertEqual(env["PYTHONDONTWRITEBYTECODE"], "1")

    def test_owner_key_path_is_inside_the_rc_memory_root(self):
        with tempfile.TemporaryDirectory() as tmp:
            d = defaults_for(Path(tmp))
            env = rc.panel_env(d)
        self.assertTrue(Path(env["SINGULARITY_TENCENT_OWNER_KEY_FILE"])
                        .is_relative_to(Path(d["memory_root"])))


class IndependentServices(unittest.TestCase):
    def test_one_failing_service_does_not_hide_the_others(self):
        original = (rc.ensure_repoql, rc.ensure_memory, rc.ensure_identity)

        def fail(*_a, **_k):
            raise rc.ServiceError("synthetic failure")

        rc.ensure_repoql = lambda *a, **k: {"ok": True, "verdict": "ready"}
        rc.ensure_memory = fail
        rc.ensure_identity = lambda *a, **k: {"ok": True, "action": "provisioned"}
        try:
            with tempfile.TemporaryDirectory() as tmp:
                report = rc.start(defaults_for(Path(tmp)), run=lambda *a, **k: completed())
        finally:
            rc.ensure_repoql, rc.ensure_memory, rc.ensure_identity = original
        self.assertFalse(report["ok"])
        self.assertFalse(report["services"]["memory"]["ok"])
        self.assertTrue(report["services"]["repoql"]["ok"])


if __name__ == "__main__":
    unittest.main()
