"""Unit contracts for the zero-touch RC local service bootstrap (fleet#893)."""
from __future__ import annotations

import json
import os
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path
from unittest import mock

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


class SourceSelection(unittest.TestCase):
    def test_module_source_is_the_product_root(self):
        self.assertTrue((rc.SOURCE / "native" / "windows" / "rc_services.py").is_file())
        self.assertTrue((rc.SOURCE / "memory" / "rc_stack.py").is_file())
        self.assertTrue((rc.SOURCE / "dashboard" / "server.py").is_file())

    def test_empty_staged_source_directory_is_ignored(self):
        """A leftover empty `source` dir must not become the product tree."""
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp) / "Singularity" / "Fleet861RC"
            (root / "source").mkdir(parents=True)
            d = rc.defaults({"LOCALAPPDATA": tmp})
        self.assertEqual(d["source"], rc.SOURCE)

    def test_staged_tree_with_product_entry_points_is_used(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp) / "Singularity" / "Fleet861RC"
            staged = root / "source"
            (staged / "native" / "windows").mkdir(parents=True)
            (staged / "memory").mkdir(parents=True)
            (staged / "native" / "windows" / "rc_services.py").write_text("", encoding="utf-8")
            (staged / "memory" / "rc_stack.py").write_text("", encoding="utf-8")
            d = rc.defaults({"LOCALAPPDATA": tmp})
        self.assertEqual(d["source"], staged)


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


def repoql_case(tmp, graph=True):
    d = defaults_for(Path(tmp))
    d["rql"] = Path(tmp) / "rql.exe"
    d["rql"].write_bytes(b"stub")
    if graph:
        cache = d["workspace"] / ".repoql" / "cache"
        cache.mkdir(parents=True)
        (cache / "index.duckdb").write_bytes(b"graph")
    return d


class RepoqlStartup(unittest.TestCase):
    def test_serves_an_existing_graph_without_importing_it_again(self):
        calls = []
        spawned = []
        online = {"value": False}

        def run(cmd, cwd=None, timeout=None):
            calls.append([str(part) for part in cmd])
            if not online["value"]:
                return completed('{"running": false, "error": "no host"}', code=1)
            return completed('{"ready": true, "totalFiles": 1268, "host": {"pid": 7}}')

        def spawn(cmd, cwd=None, log_path=None):
            spawned.append([str(part) for part in cmd])
            online["value"] = True
            return 4242

        with tempfile.TemporaryDirectory() as tmp:
            report = rc.ensure_repoql(repoql_case(tmp), run=run, spawn=spawn, sleep=lambda _s: None)
        self.assertTrue(report["ok"])
        self.assertTrue(report["host_started"])
        self.assertFalse(report["imported"])
        self.assertEqual(spawned[0][1:], ["serve", "--path", str(Path(tmp) / "Singularity" / "Fleet861RC" / "workspace")])
        self.assertFalse(any("import" in call for call in calls))

    def test_stale_host_socket_is_removed_before_serve(self):
        online = {"value": False}

        def run(cmd, cwd=None, timeout=None):
            if not online["value"]:
                return completed('{"running": false, "error": "no host"}', code=1)
            return completed('{"ready": true, "totalFiles": 1, "host": {"pid": 9}}')

        def spawn(cmd, cwd=None, log_path=None):
            online["value"] = True
            return 4242

        with tempfile.TemporaryDirectory() as tmp:
            d = repoql_case(tmp)
            stale = d["workspace"] / ".repoql" / "cache" / "repoql.sock"
            stale.write_bytes(b"stale")
            report = rc.ensure_repoql(d, run=run, spawn=spawn, sleep=lambda _s: None)
        self.assertTrue(report["ok"])
        self.assertFalse(stale.exists())

    def test_imports_once_when_the_workspace_has_no_graph(self):
        calls = []
        online = {"value": False}

        def run(cmd, cwd=None, timeout=None):
            calls.append([str(part) for part in cmd])
            if "import" in cmd:
                return completed("Import started: local:///source\n")
            if not online["value"]:
                return completed('{"running": false, "error": "no host"}', code=1)
            return completed('{"ready": true, "totalFiles": 10, "host": {"pid": 7}}')

        def spawn(cmd, cwd=None, log_path=None):
            online["value"] = True
            return 4242

        with tempfile.TemporaryDirectory() as tmp:
            report = rc.ensure_repoql(repoql_case(tmp, graph=False), run=run, spawn=spawn,
                                      sleep=lambda _s: None)
        self.assertTrue(report["ok"])
        self.assertTrue(report["imported"])
        self.assertEqual(sum(1 for call in calls if "import" in call), 1)

    def test_real_status_shape_counts_as_running_without_an_import(self):
        """`host status` has no `running` field; ready/host.pid is the contract."""
        calls = []

        def run(cmd, cwd=None, timeout=None):
            calls.append([str(part) for part in cmd])
            return completed('{"ready": true, "queryable": true, "totalFiles": 1268, '
                             '"host": {"pid": 16400}}')

        with tempfile.TemporaryDirectory() as tmp:
            report = rc.ensure_repoql(repoql_case(tmp), run=run, spawn=lambda *a, **k: 1,
                                      sleep=lambda _s: None)
        self.assertTrue(report["ok"])
        self.assertEqual(report["pid"], 16400)
        self.assertEqual(report["files"], 1268)
        self.assertFalse(any("import" in call for call in calls))

    def test_no_host_after_import_is_a_failure_not_a_pass(self):
        def run(cmd, cwd=None, timeout=None):
            return completed('{"running": false, "error": "no host"}')

        with tempfile.TemporaryDirectory() as tmp:
            d = defaults_for(Path(tmp))
            d["rql"] = Path(tmp) / "rql.exe"
            d["rql"].write_bytes(b"stub")
            with self.assertRaises(rc.ServiceError) as caught:
                rc.ensure_repoql(d, run=run, spawn=lambda *a, **k: 1, sleep=lambda _s: None,
                                 attempts=2, delay=0)
        self.assertIn("did not start", str(caught.exception))

    def test_missing_rql_binary_is_reported(self):
        with tempfile.TemporaryDirectory() as tmp:
            d = defaults_for(Path(tmp))
            with self.assertRaises(rc.ServiceError) as caught:
                rc.ensure_repoql(d, run=lambda *a, **k: completed())
        self.assertIn("not installed", str(caught.exception))


class MemoryStartup(unittest.TestCase):
    def test_stale_manifest_is_stopped_before_a_fresh_start(self):
        calls = []

        class Stack:
            @staticmethod
            def stop(node, supervisor, config_path, run=None):
                calls.append("stop")
                return {"processes": []}

        states = {"n": 0}

        def memory_status(d, run=None):
            states["n"] += 1
            if states["n"] == 1:
                return {"code": "NO_MANIFEST", "healthy": False, "processes": []}
            return {"code": "RUNNING", "healthy": True,
                    "processes": [{"name": "core", "health": "ok", "ownership": "verified",
                                    "port": 18221}]}

        with tempfile.TemporaryDirectory() as tmp:
            d = defaults_for(Path(tmp))
            for key in ("node", "supervisor"):
                d[key] = Path(tmp) / f"{key}.exe"
                d[key].write_bytes(b"")
            for key in ("core_dir", "panel_dir"):
                d[key] = Path(tmp) / key
                d[key].mkdir()
            with mock.patch.object(rc, "_rc_stack", return_value=Stack), \
                    mock.patch.object(rc, "memory_config", return_value=({}, Path(tmp) / "stack.json")), \
                    mock.patch.object(rc, "memory_status", side_effect=memory_status):
                report = rc.ensure_memory(d, run=lambda *a, **k: None, spawn=lambda *a, **k: 123,
                                          sleep=lambda _s: None, attempts=2, delay=0)
        self.assertEqual(calls, ["stop"])
        self.assertTrue(report["ok"])


class Identity(unittest.TestCase):
    def test_existing_owner_key_is_reused_without_running_anything(self):
        def run(cmd, cwd=None, timeout=None):
            raise AssertionError("no provisioner run expected")

        with tempfile.TemporaryDirectory() as tmp:
            d = defaults_for(Path(tmp))
            d["admin_key"].parent.mkdir(parents=True, exist_ok=True)
            d["admin_key"].write_text("synthetic-key", encoding="utf-8")
            d["metadata_db"].parent.mkdir(parents=True, exist_ok=True)
            d["metadata_db"].write_text("synthetic", encoding="utf-8")
            result = rc.ensure_identity(d, run=run)
        self.assertEqual(result["action"], "reused")

    def test_owner_key_without_metadata_store_is_reprovisioned(self):
        """A key left behind by purged state must not suppress init-admin."""
        seen = []

        def run(cmd, cwd=None, timeout=None):
            seen.append(cmd)
            return completed(stdout='{"provisioned": true, "team_id": "t"}')

        with tempfile.TemporaryDirectory() as tmp:
            d = defaults_for(Path(tmp))
            d["admin_key"].parent.mkdir(parents=True, exist_ok=True)
            d["admin_key"].write_text("stale-key", encoding="utf-8")
            script = Path(d["source"]) / "native" / "windows" / "provision_memory_identity.mjs"
            script.parent.mkdir(parents=True, exist_ok=True)
            script.write_text("// stub", encoding="utf-8")

            result = rc.ensure_identity(d, run=run, sleep=lambda _s: None, attempts=2)
        self.assertEqual(result["action"], "provisioned")
        self.assertEqual(len(seen), 1)
        self.assertFalse(d["admin_key"].exists())

    def test_fresh_store_provisions_without_waiting_for_the_database(self):
        """init-admin creates the metadata database; the start must not wait."""
        seen = []

        def run(cmd, cwd=None, timeout=None):
            seen.append(cmd)
            return completed(stdout='{"provisioned": true, "team_id": "t", '
                                    '"identity_map": {"agents": 9}}')

        def sleep(_seconds):
            raise AssertionError("a fresh store must not be polled for a database")

        with tempfile.TemporaryDirectory() as tmp:
            d = defaults_for(Path(tmp))
            script = Path(d["source"]) / "native" / "windows" / "provision_memory_identity.mjs"
            script.parent.mkdir(parents=True, exist_ok=True)
            script.write_text("// stub", encoding="utf-8")
            result = rc.ensure_identity(d, run=run, sleep=sleep)
        self.assertEqual(result["action"], "provisioned")
        self.assertEqual(result["agents"], 9)
        self.assertEqual(len(seen), 1)

    def test_failed_provisioning_reports_the_provisioner_error(self):
        with tempfile.TemporaryDirectory() as tmp:
            d = defaults_for(Path(tmp))
            script = Path(d["source"]) / "native" / "windows" / "provision_memory_identity.mjs"
            script.parent.mkdir(parents=True, exist_ok=True)
            script.write_text("// stub", encoding="utf-8")
            with self.assertRaises(rc.ServiceError) as caught:
                rc.ensure_identity(d, run=lambda *a, **k: completed(stderr="INIT_ADMIN_FAILED HTTP 500", code=1),
                                   sleep=lambda _s: None, attempts=2, delay=0)
        self.assertIn("INIT_ADMIN_FAILED", str(caught.exception))


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
        self.assertEqual(env["SINGULARITY_KANZO_PORT"], "18202")
        self.assertEqual(env["SINGULARITY_OFFICE_PORT"], "18203")
        self.assertEqual(env["SINGULARITY_OFFICE_NATIVE_AUTH_MODE"], "key_file")
        self.assertTrue(Path(env["SINGULARITY_OFFICE_PANEL_KEY_FILE"])
                        .is_relative_to(Path(d["root"])))
        self.assertNotIn("4242", env["SINGULARITY_KANZO_PORT"])
        self.assertNotEqual(env["SINGULARITY_OFFICE_HEALTH_PORT"], "8001")

    def test_owner_key_path_is_inside_the_rc_memory_root(self):
        with tempfile.TemporaryDirectory() as tmp:
            d = defaults_for(Path(tmp))
            env = rc.panel_env(d)
        self.assertTrue(Path(env["SINGULARITY_TENCENT_OWNER_KEY_FILE"])
                        .is_relative_to(Path(d["memory_root"])))

    @mock.patch.dict(os.environ, {}, clear=False)
    def test_panel_environment_enables_the_local_owner_account(self):
        """Auto-local cannot issue a session unless the dashboard owns an account.

        server.py builds LocalAccount only when SINGULARITY_LOCAL_ACCOUNT_AUTH=1;
        without it every /api call answers dashboard_secret_required and the RC
        never opens signed in, which is what the installed candidate must do.
        """
        os.environ.pop("SINGULARITY_LOCAL_ACCOUNT_AUTH", None)
        os.environ.pop("SINGULARITY_DASHBOARD_AUTH_MODE", None)
        with tempfile.TemporaryDirectory() as tmp:
            env = rc.panel_env(defaults_for(Path(tmp)))
        self.assertEqual(env["SINGULARITY_LOCAL_ACCOUNT_AUTH"], "1")
        self.assertEqual(env["SINGULARITY_DASHBOARD_AUTH_MODE"], "auto-local")

    @mock.patch.dict(os.environ, {"SINGULARITY_DASHBOARD_AUTH_MODE": "password"}, clear=False)
    def test_panel_environment_keeps_an_explicit_mode(self):
        with tempfile.TemporaryDirectory() as tmp:
            env = rc.panel_env(defaults_for(Path(tmp)))
        self.assertEqual(env["SINGULARITY_DASHBOARD_AUTH_MODE"], "password")

    def test_panel_environment_wires_the_repoql_control_panel(self):
        """The embedded official panel is a same-origin embed of the RC host.

        embed_config only reports it configured for the /embed/repoql URL, and
        the proxy resolves the upstream from the RC workspace's own bind record;
        without both the panel answers native_repoql_proxy_unconfigured.
        """
        with tempfile.TemporaryDirectory() as tmp:
            d = defaults_for(Path(tmp))
            env = rc.panel_env(d)
        self.assertEqual(env["REPOQL_NATIVE_EMBED_URL"], "/embed/repoql")
        self.assertEqual(env["REPOQL_NATIVE_WORKSPACE"], str(d["workspace"]))
        self.assertNotIn("41005", env.values())


class KanzoBoard(unittest.TestCase):
    def test_board_binary_is_staged_and_started_with_rc_home_and_port(self):
        spawned = []

        def spawn(cmd, cwd=None, log_path=None):
            spawned.append([str(part) for part in cmd])
            return 4242

        with tempfile.TemporaryDirectory() as tmp:
            d = defaults_for(Path(tmp))
            d["vendor_kanzo"].parent.mkdir(parents=True, exist_ok=True)
            d["vendor_kanzo"].write_bytes(b"MZ stub")
            d["vendor_kanzo"].chmod(0o755)
            started = {"value": False}

            def ping(port):
                return started["value"]

            def spawning(cmd, cwd=None, log_path=None):
                started["value"] = True
                return spawn(cmd, cwd, log_path)

            with mock.patch.object(rc, "_kanzo_board", lambda port: {"tasks": 3, "statuses": 5, "projects": 1}):
                report = rc.ensure_kanzo(d, spawn=spawning, sleep=lambda _s: None, ping=ping)
            self.assertTrue(report["ok"])
            self.assertEqual(report["tasks"], 3)
            self.assertTrue(Path(report["binary"]).is_file())
            self.assertTrue(Path(report["binary"]).resolve().is_relative_to(Path(d["root"]).resolve()))
            self.assertEqual(spawned[0][1], "--home")
            self.assertEqual(Path(spawned[0][2]), d["kanzo_home"])
            self.assertIn("18202", spawned[0])
            self.assertNotIn("4242", spawned[0])

    def test_missing_board_binary_is_reported_not_skipped(self):
        with tempfile.TemporaryDirectory() as tmp:
            d = defaults_for(Path(tmp))
            with self.assertRaises(rc.ServiceError) as caught:
                rc.ensure_kanzo(d, spawn=lambda *a, **k: 1, sleep=lambda _s: None)
        self.assertIn("Kanzo board binary is unavailable", str(caught.exception))

    def test_unresponsive_board_is_a_failure(self):
        with tempfile.TemporaryDirectory() as tmp:
            d = defaults_for(Path(tmp))
            d["vendor_kanzo"].parent.mkdir(parents=True, exist_ok=True)
            d["vendor_kanzo"].write_bytes(b"MZ stub")
            with self.assertRaises(rc.ServiceError) as caught:
                rc.ensure_kanzo(d, spawn=lambda *a, **k: 1, sleep=lambda _s: None,
                                attempts=2, delay=0, ping=lambda port: False)
        self.assertIn("did not answer", str(caught.exception))


class OfficeService(unittest.TestCase):
    def _install(self, d):
        backend = Path(d["office_install"]) / "source" / "backend" / "app"
        backend.mkdir(parents=True, exist_ok=True)
        (backend / "main.py").write_text("# stub", encoding="utf-8")
        Path(d["office_python"]).parent.mkdir(parents=True, exist_ok=True)
        Path(d["office_python"]).write_bytes(b"stub")

    def test_config_state_and_keys_are_rc_owned(self):
        with tempfile.TemporaryDirectory() as tmp:
            d = defaults_for(Path(tmp))
            self._install(d)
            rc.office_config(d)
            config = json.loads(Path(d["office_config"]).read_text(encoding="utf-8"))
            self.assertEqual(config["port"], 18203)
            self.assertEqual(Path(config["stateDir"]), d["office_state"])
            self.assertEqual(Path(config["backendDir"]), Path(d["office_install"]) / "source" / "backend")
            keys = json.loads((Path(d["office_state"]) / "keys.json").read_text(encoding="utf-8"))
            self.assertEqual(Path(d["office_panel_key"]).read_text(encoding="utf-8"), keys["apiKey"])
            self.assertTrue(Path(d["office_launcher"]).is_file())

    def test_service_starts_with_the_installed_venv_and_rc_config(self):
        spawned = []

        def spawn(cmd, cwd=None, log_path=None):
            spawned.append([str(part) for part in cmd])
            return 5150

        with tempfile.TemporaryDirectory() as tmp:
            d = defaults_for(Path(tmp))
            self._install(d)
            started = {"value": False}

            def health(port):
                return started["value"]

            def spawning(cmd, cwd=None, log_path=None):
                started["value"] = True
                return spawn(cmd, cwd, log_path)

            report = rc.ensure_office(d, spawn=spawning, sleep=lambda _s: None, health=health)
            self.assertTrue(report["ok"])
            self.assertEqual(spawned[0][0], str(d["office_python"]))
            self.assertIn("--config", spawned[0])
            self.assertIn(str(d["office_config"]), spawned[0])

    def test_missing_office_distribution_is_reported(self):
        with tempfile.TemporaryDirectory() as tmp:
            d = defaults_for(Path(tmp))
            with self.assertRaises(rc.ServiceError) as caught:
                rc.ensure_office(d, spawn=lambda *a, **k: 1, sleep=lambda _s: None,
                                 health=lambda port: True)
        self.assertIn("Claude Office distribution is unavailable", str(caught.exception))


class IndependentServices(unittest.TestCase):
    def test_one_failing_service_does_not_hide_the_others(self):
        original = (rc.ensure_repoql, rc.ensure_memory, rc.ensure_identity,
                    rc.ensure_kanzo, rc.ensure_office)

        def fail(*_a, **_k):
            raise rc.ServiceError("synthetic failure")

        rc.ensure_repoql = lambda *a, **k: {"ok": True, "verdict": "ready"}
        rc.ensure_memory = fail
        rc.ensure_identity = lambda *a, **k: {"ok": True, "action": "provisioned"}
        rc.ensure_kanzo = lambda *a, **k: {"ok": True, "tasks": 1}
        rc.ensure_office = lambda *a, **k: {"ok": True, "health": "ok"}
        try:
            with tempfile.TemporaryDirectory() as tmp:
                report = rc.start(defaults_for(Path(tmp)), run=lambda *a, **k: completed(),
                                  log=lambda _message: None)
        finally:
            (rc.ensure_repoql, rc.ensure_memory, rc.ensure_identity,
             rc.ensure_kanzo, rc.ensure_office) = original
        self.assertFalse(report["ok"])
        self.assertFalse(report["services"]["memory"]["ok"])
        self.assertTrue(report["services"]["repoql"]["ok"])
        self.assertTrue(report["services"]["kanzo"]["ok"])
        self.assertTrue(report["services"]["office"]["ok"])


if __name__ == "__main__":
    unittest.main()
