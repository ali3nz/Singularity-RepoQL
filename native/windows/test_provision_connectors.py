"""Contract tests for the bundled connector build/provision helper.

These tests are hermetic: they never call rql, never touch a connector registry
and never install anything. The real build and package tests run on Windows.
"""
from __future__ import annotations

import json
from pathlib import Path
import subprocess
import sys
import tempfile
import unittest
import zipfile

ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(ROOT / "native" / "windows"))
import provision_connectors as pc  # noqa: E402

SHA_A = "a" * 64
SHA_B = "b" * 64


def completed(returncode=0, stdout="", stderr=""):
    return subprocess.CompletedProcess(["rql.exe"], returncode, stdout, stderr)


def source_fixture(root: Path, scheme: str) -> Path:
    source = root / "connectors" / scheme
    (source / "help").mkdir(parents=True, exist_ok=True)
    (source / "sql").mkdir(parents=True, exist_ok=True)
    (source / "connector.ts").write_text("// connector\n", encoding="utf-8")
    (source / "manifest.yaml").write_text(f"scheme: {scheme}\n", encoding="utf-8")
    (source / "README.md").write_text(f"# {scheme}\n", encoding="utf-8")
    (source / "suite.json").write_text('{"import": "%s://data", "generations": []}\n' % scheme, encoding="utf-8")
    (source / "help" / "layout.md").write_text("# layout\n", encoding="utf-8")
    (source / "sql" / "one.sql").write_text("select 1;\n", encoding="utf-8")
    return source


def lock_fixture(root: Path) -> dict:
    source_fixture(root, "kanzo")
    source_fixture(root, "memorycore")
    return {
        "schema": pc.LOCK_SCHEMA,
        "repoqlVersion": pc.REQUIRED_RQL,
        "connectorAbi": 1,
        "authors": "Singularity",
        "packages": [
            {"scheme": "kanzo", "title": "Kanzo board", "id": "RepoQL.Connectors.Kanzo",
             "version": "1.0.0", "source": "connectors/kanzo",
             "suite": "connectors/kanzo/suite.json",
             "package": "RepoQL.Connectors.Kanzo.1.0.0.nupkg", "sha256": SHA_A, "bytes": 1},
            {"scheme": "memorycore", "title": "Tencent MemoryCore", "id": "Tencent.MemoryCore",
             "version": "1.0.0", "source": "connectors/memorycore",
             "suite": "connectors/memorycore/suite.json",
             "package": "Tencent.MemoryCore.1.0.0.nupkg", "sha256": SHA_B, "bytes": 1},
        ],
    }


def nuspec(spec: dict, authors: str = "Singularity") -> bytes:
    return (f'<?xml version="1.0" encoding="utf-8"?>'
            f'<package xmlns="http://schemas.microsoft.com/packaging/2012/06/nuspec.xsd">'
            f'<metadata><id>{spec["id"]}</id><version>{spec["version"]}</version>'
            f'<authors>{authors}</authors><description>Test</description>'
            f'<packageTypes><packageType name="RepoQLConnector" version="1.0" /></packageTypes>'
            f'</metadata></package>').encode("utf-8")


def make_package(path: Path, root: Path, spec: dict, *, authors: str = "Singularity",
                 extra_typescript: bool = False, readme: bytes | None = None) -> dict:
    source = root / spec["source"]
    entries = {
        "[Content_Types].xml": b"<Types/>",
        "_rels/.rels": b"<Relationships/>",
        spec["id"] + ".nuspec": nuspec(spec, authors),
        "connector/manifest.yaml": (source / "manifest.yaml").read_bytes(),
        "connector/README.md": readme if readme is not None else (source / "README.md").read_bytes(),
        "connector/help/layout.md": (source / "help" / "layout.md").read_bytes(),
        "connector/sql/one.sql": (source / "sql" / "one.sql").read_bytes(),
        "connector/connector.wasm": b"\x00asm" + b"\x00" * 2048,
    }
    if extra_typescript:
        entries["connector/connector.ts"] = b"// source\n"
    path.parent.mkdir(parents=True, exist_ok=True)
    with zipfile.ZipFile(path, "w") as archive:
        for name, data in entries.items():
            archive.writestr(name, data)
    data = path.read_bytes()
    import hashlib
    return dict(spec, sha256=hashlib.sha256(data).hexdigest(), bytes=len(data))


class LockTests(unittest.TestCase):
    def test_valid_lock_is_accepted(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            lock = lock_fixture(root)
            self.assertIs(pc.validate_lock(lock, root), lock)

    def test_lock_rejects_version_abi_duplicates_and_path_escape(self):
        cases = []
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            lock = lock_fixture(root)
            for label, mutate in [
                ("version", lambda d: d.update(repoqlVersion="1.7.17")),
                ("abi", lambda d: d.update(connectorAbi=2)),
                ("duplicate", lambda d: d["packages"][1].update(scheme="kanzo")),
                ("package", lambda d: d["packages"][0].update(package="wrong.nupkg")),
                ("escape", lambda d: d["packages"][0].update(source="connectors/../../etc")),
                ("hash", lambda d: d["packages"][0].update(sha256="nope")),
            ]:
                data = json.loads(json.dumps(lock))
                mutate(data)
                cases.append((label, data))
        for label, data in cases:
            with self.subTest(case=label), tempfile.TemporaryDirectory() as temporary:
                root = Path(temporary)
                source_fixture(root, "kanzo")
                source_fixture(root, "memorycore")
                with self.assertRaises(pc.ProvisionError):
                    pc.validate_lock(data, root)

    def test_load_lock_reports_a_missing_file_safely(self):
        with tempfile.TemporaryDirectory() as temporary:
            with self.assertRaises(pc.ProvisionError) as context:
                pc.load_lock(Path(temporary) / "missing.json", Path(temporary))
        self.assertEqual(context.exception.code, "CONNECTOR_LOCK_MISSING")


class InventoryTests(unittest.TestCase):
    def test_read_inventory_uses_local_status_and_ignores_bad_schemes(self):
        payload = {"schema": "repoql.imports.status/v1", "connectors": [
            {"scheme": "kanzo", "state": "installed", "version": "1.0.0", "title": "Kanzo"},
            {"scheme": "memorycore", "state": "installed", "version": "1.0.0", "title": "MemoryCore"},
            {"scheme": "not a scheme", "state": "installed"},
            {"scheme": "kanzo", "state": "failed"},
        ], "imports": []}
        commands = []
        with tempfile.TemporaryDirectory() as temporary:
            workspace = Path(temporary)
            def runner(cmd, **kwargs):
                commands.append([str(part) for part in cmd])
                return completed(stdout=json.dumps(payload))
            inventory = pc.read_inventory(Path("C:/rql.exe"), workspace, runner=runner)
        self.assertEqual(commands[0][1:], ["connector", "status", "--json"])
        self.assertEqual(inventory["kanzo"]["state"], "installed")
        self.assertEqual(inventory["kanzo"]["version"], "1.0.0")
        self.assertEqual(inventory["memorycore"]["title"], "MemoryCore")

    def test_inventory_timeout_is_reported_as_unavailable(self):
        def timeout(*args, **kwargs):
            raise subprocess.TimeoutExpired("rql", 45)
        with tempfile.TemporaryDirectory() as temporary:
            with self.assertRaises(pc.ProvisionError) as context:
                pc.read_inventory(Path("C:/rql.exe"), Path(temporary), runner=timeout)
        self.assertEqual(context.exception.code, "CONNECTOR_INVENTORY_UNAVAILABLE")
        self.assertEqual(context.exception.detail, "timeout")

    def test_inventory_is_unavailable_not_empty_on_bad_payload(self):
        for stdout, rc in [("not json", 0), ("", 1), (json.dumps({"connectors": {}}), 0)]:
            with self.subTest(stdout=stdout, rc=rc), tempfile.TemporaryDirectory() as temporary:
                with self.assertRaises(pc.ProvisionError) as context:
                    pc.read_inventory(Path("C:/rql.exe"), Path(temporary),
                                      runner=lambda *a, **k: completed(rc, stdout))
                self.assertEqual(context.exception.code, "CONNECTOR_INVENTORY_UNAVAILABLE")


class PackageTests(unittest.TestCase):
    def test_package_state_and_rows_cover_built_missing_and_mismatch(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            lock = lock_fixture(root)
            spec = lock["packages"][0]
            built = make_package(root / "build" / "packages" / spec["package"], root, spec)
            state = pc.package_state(root / "build", built)
            self.assertEqual(state["state"], "built")
            rows = pc.connector_rows(lock, root / "build", {"kanzo": {"state": "installed", "version": "1.0.0", "title": ""}})
            kanzo = next(row for row in rows if row["scheme"] == "kanzo")
            memory = next(row for row in rows if row["scheme"] == "memorycore")
            self.assertEqual(kanzo["state"], "installed")
            self.assertEqual(memory["state"], "package_missing")
            self.assertEqual(memory["nextAction"], "build")
            wrong = Path(temporary) / "wrong.nupkg"
            wrong.write_bytes(b"wrong")
            mismatch = dict(spec, sha256=SHA_A, bytes=4)
            (root / "build" / "packages").mkdir(parents=True, exist_ok=True)
            (root / "build" / "packages" / spec["package"]).write_bytes(b"other")
            self.assertEqual(pc.package_state(root / "build", mismatch)["state"], "hash_mismatch")
            rows = pc.connector_rows(lock, root / "build", {})
            self.assertEqual(next(row for row in rows if row["scheme"] == "kanzo")["state"], "package_hash_mismatch")

    def test_inspect_package_accepts_pinned_content_and_rejects_drift(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            lock = lock_fixture(root)
            spec = lock["packages"][0]
            built = make_package(root / "pkg.nupkg", root, spec)
            info = pc.inspect_package(root / "pkg.nupkg", built, root)
            self.assertGreater(info["wasmBytes"], 1024)
            with self.assertRaises(pc.ProvisionError) as context:
                pc.inspect_package(root / "pkg.nupkg", dict(built, sha256=SHA_A), root)
            self.assertEqual(context.exception.code, "CONNECTOR_PACKAGE_HASH_DRIFT")

            bad_readme = make_package(root / "bad-readme.nupkg", root, spec, readme=b"changed\n")
            with self.assertRaises(pc.ProvisionError) as context:
                pc.inspect_package(root / "bad-readme.nupkg", bad_readme, root)
            self.assertEqual(context.exception.code, "CONNECTOR_PACKAGE_CONTENT_INVALID")

            source_entry = make_package(root / "source.nupkg", root, spec, extra_typescript=True)
            with self.assertRaises(pc.ProvisionError) as context:
                pc.inspect_package(root / "source.nupkg", source_entry, root)
            self.assertEqual(context.exception.code, "CONNECTOR_PACKAGE_CONTENT_INVALID")

            wrong_authors = make_package(root / "authors.nupkg", root, spec, authors="Someone")
            with self.assertRaises(pc.ProvisionError) as context:
                pc.inspect_package(root / "authors.nupkg", wrong_authors, root)
            self.assertEqual(context.exception.code, "CONNECTOR_PACKAGE_CONTENT_INVALID")


class BuildTests(unittest.TestCase):
    def test_build_normalizes_the_default_runner_for_preflight(self):
        import hashlib
        import types
        from unittest import mock

        with tempfile.TemporaryDirectory() as root_dir, tempfile.TemporaryDirectory() as out_dir:
            root = Path(root_dir)
            build_root = Path(out_dir) / "build"
            lock = lock_fixture(root)
            seen = {}

            def fake_preflight(**kwargs):
                seen["runner"] = kwargs.get("runner")
                return {"ok": True, "actual_version": "1.7.18"}

            def fake_pack(rql, spec, output, root, runner=None, cwd=None, env=None):
                seen["cwd"] = cwd
                seen["env"] = env
                seen["pack_runner"] = runner
                path = output / spec["package"]
                path.parent.mkdir(parents=True, exist_ok=True)
                path.write_bytes(("package:" + spec["scheme"]).encode("utf-8"))
                return path

            def fake_inspect(path, spec, root):
                data = path.read_bytes()
                return {"sha256": hashlib.sha256(data).hexdigest(), "bytes": len(data),
                        "entries": 1, "wasmBytes": 2048}

            fake = types.SimpleNamespace(preflight=fake_preflight)
            with mock.patch.dict(sys.modules, {"repoql_compat": fake}), \
                 mock.patch.object(pc, "_connector_test", return_value={"scheme": "kanzo", "passed": True, "generations": 1}) as connector_test, \
                 mock.patch.object(pc, "_pack", side_effect=fake_pack), \
                 mock.patch.object(pc, "inspect_package", side_effect=fake_inspect), \
                 mock.patch.object(pc, "stop_workspace_host", return_value=True) as stop_host:
                result = pc.build_connectors(root / "rql.exe", lock, build_root, root=root)

            self.assertTrue(callable(seen["runner"]))
            self.assertIsNone(seen["pack_runner"])
            self.assertEqual(Path(seen["cwd"]).name, "workspace")
            self.assertEqual(seen["env"], {"REPOQL_MCP_INCLUDE_GLOBALS": "false"})
            self.assertEqual(len(result["packages"]), 2)
            self.assertTrue((build_root / "connector-build-receipt.json").is_file())
            # Only preflight needs a callable default. Source/package commands
            # must retain None so _run uses bounded process-tree cleanup.
            self.assertTrue(all(call.args[4] is None
                                for call in connector_test.call_args_list))
            stop_host.assert_called_once_with((root / "rql.exe").resolve(),
                                              build_root / "workspace", runner=None)

    def test_build_stops_scratch_host_after_a_source_test_failure(self):
        import types
        from unittest import mock

        with tempfile.TemporaryDirectory() as root_dir, tempfile.TemporaryDirectory() as out_dir:
            root = Path(root_dir)
            build_root = Path(out_dir) / "build"
            lock = lock_fixture(root)
            fake = types.SimpleNamespace(preflight=lambda **kwargs: {"ok": True, "actual_version": "1.7.18"})
            with mock.patch.dict(sys.modules, {"repoql_compat": fake}), \
                 mock.patch.object(pc, "_connector_test", side_effect=pc.ProvisionError("CONNECTOR_TEST_FAILED")), \
                 mock.patch.object(pc, "stop_workspace_host", return_value=True) as stop_host:
                with self.assertRaises(pc.ProvisionError) as error:
                    pc.build_connectors(root / "rql.exe", lock, build_root, root=root)
            self.assertEqual(error.exception.code, "CONNECTOR_TEST_FAILED")
            stop_host.assert_called_once_with((root / "rql.exe").resolve(),
                                              build_root / "workspace", runner=None)
            self.assertEqual(list(build_root.glob(".build-*")), [])


class ReuseTests(unittest.TestCase):
    def test_build_reuses_verified_release_packages_without_packing(self):
        import hashlib
        import types
        from unittest import mock

        with tempfile.TemporaryDirectory() as root_dir, tempfile.TemporaryDirectory() as out_dir:
            root = Path(root_dir)
            build_root = Path(out_dir) / "build"
            lock = lock_fixture(root)
            packages = build_root / "packages"
            packages.mkdir(parents=True)
            for spec in lock["packages"]:
                (packages / spec["package"]).write_bytes(("pinned:" + spec["scheme"]).encode("utf-8"))

            def fake_preflight(**kwargs):
                return {"ok": True, "actual_version": "1.7.18"}

            def fake_inspect(path, spec, root):
                data = path.read_bytes()
                return {"sha256": hashlib.sha256(data).hexdigest(), "bytes": len(data),
                        "entries": 1, "wasmBytes": 2048}

            fake = types.SimpleNamespace(preflight=fake_preflight)
            with mock.patch.dict(sys.modules, {"repoql_compat": fake}), \
                 mock.patch.object(pc, "inspect_package", side_effect=fake_inspect), \
                 mock.patch.object(pc, "_pack") as pack, \
                 mock.patch.object(pc, "_connector_test") as test:
                result = pc.build_connectors(root / "rql.exe", lock, build_root, root=root)

            self.assertTrue(result["reused"])
            self.assertTrue(all(item["reused"] for item in result["packages"]))
            pack.assert_not_called()
            test.assert_not_called()
            receipt = json.loads((build_root / "connector-build-receipt.json").read_text(encoding="utf-8"))
            self.assertTrue(receipt["reusedPinnedPackages"])

class ConnectorTestTests(unittest.TestCase):
    def _spec(self, root: Path) -> dict:
        lock_fixture(root)
        return lock_fixture(root)["packages"][0]

    def test_connector_test_accepts_a_passed_suite(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            spec = self._spec(root)
            payload = {"scheme": "kanzo", "passed": True, "notRun": 0, "refusal": None,
                       "generations": [{"name": "one", "passed": True}]}
            result = pc._connector_test(Path("C:/rql.exe"), root / "connector.ts", spec, root,
                                        runner=lambda *a, **k: completed(stdout=json.dumps(payload)))
        self.assertEqual(result, {"scheme": "kanzo", "passed": True, "generations": 1})

    def test_connector_test_fails_closed_on_refusal_or_not_run(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            spec = self._spec(root)
            for label, payload, rc in [
                ("refusal", {"scheme": "kanzo", "passed": False, "notRun": 0, "refusal": "no", "generations": []}, 0),
                ("notRun", {"scheme": "kanzo", "passed": True, "notRun": 1, "refusal": None, "generations": []}, 0),
                ("wrong-scheme", {"scheme": "other", "passed": True, "notRun": 0, "refusal": None, "generations": [1]}, 0),
                ("rc", {"scheme": "kanzo", "passed": True, "notRun": 0, "refusal": None, "generations": [1]}, 3),
            ]:
                with self.subTest(case=label), self.assertRaises(pc.ProvisionError) as context:
                    pc._connector_test(Path("C:/rql.exe"), root / "connector.ts", spec, root,
                                       runner=lambda *a, **k: completed(rc, json.dumps(payload)))
                self.assertEqual(context.exception.code, "CONNECTOR_TEST_FAILED")


class InstallTests(unittest.TestCase):
    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory()
        self.root = Path(self.temporary.name)
        self.lock = lock_fixture(self.root)
        self.build_root = self.root / "build"
        self.rql = self.root / "rql.exe"
        self.rql.write_bytes(b"binary")

    def tearDown(self):
        self.temporary.cleanup()

    def _builder(self):
        packages = []
        for spec in self.lock["packages"]:
            path = self.build_root / "packages" / spec["package"]
            path.parent.mkdir(parents=True, exist_ok=True)
            path.write_bytes(b"package:" + spec["scheme"].encode())
            packages.append({"scheme": spec["scheme"], "id": spec["id"], "version": spec["version"],
                             "package": path.name, "path": str(path), "sha256": SHA_A,
                             "bytes": path.stat().st_size, "entries": 1, "wasmBytes": 1,
                             "sourceTest": {"passed": True}, "packageTest": {"passed": True}})
        return {"packages": packages, "receipt": str(self.build_root / "receipt.json"), "rqlVersion": pc.REQUIRED_RQL}

    def test_already_installed_never_builds_or_installs(self):
        calls = []
        inventory = {scheme: {"state": "installed", "version": "1.0.0", "title": ""}
                     for scheme in ("kanzo", "memorycore")}
        result = pc.install_connectors(self.rql, self.lock, self.build_root,
                                       builder=lambda *a, **k: (_ for _ in ()).throw(AssertionError("build called")),
                                       inventory_reader=lambda *a, **k: inventory,
                                       runner=lambda *a, **k: calls.append(a) or completed())
        self.assertTrue(result["allInstalled"])
        self.assertEqual(calls, [])

    def test_missing_connectors_install_with_no_grant_flags(self):
        queue = [{}, {"kanzo": {"state": "installed", "version": "1.0.0"}},
                 {"kanzo": {"state": "installed", "version": "1.0.0"},
                  "memorycore": {"state": "installed", "version": "1.0.0"}}]
        commands = []

        def runner(cmd, **kwargs):
            commands.append([str(part) for part in cmd])
            return completed()

        result = pc.install_connectors(self.rql, self.lock, self.build_root,
                                       builder=lambda *a, **k: self._builder(),
                                       inventory_reader=lambda *a, **k: queue.pop(0),
                                       runner=runner)
        self.assertTrue(result["allInstalled"])
        self.assertEqual(len(commands), 2)
        for command in commands:
            self.assertEqual(command[1:3], ["connector", "install"])
            self.assertFalse(set(command) & {"--allow-host", "--allow-local-host", "--rate", "--source-root"})

    def test_auto_approve_passes_only_the_bundled_envelope(self):
        commands = []
        queue = [{}, {"kanzo": {"state": "installed", "version": "1.0.0"}},
                 {"kanzo": {"state": "installed", "version": "1.0.0"}, "memorycore": {"state": "installed", "version": "1.0.0"}}]
        def runner(cmd, **kwargs):
            commands.append(list(cmd))
            return completed()
        data = self.build_root / "memdata"
        pc.install_connectors(self.rql, self.lock, self.build_root, builder=lambda *a, **k: self._builder(),
                              inventory_reader=lambda *a, **k: queue.pop(0) if len(queue) > 1 else queue[0],
                              runner=runner, auto_approve=True, memory_data_root=data)
        flat = [part for c in commands for part in c]
        by_pkg = {("kanzo" if "Kanzo" in c[3] else "memorycore"): c[4:] for c in commands}
        self.assertEqual(by_pkg["kanzo"], ["--allow-local-host", "http://localhost:4242", "--rate", "6"])
        self.assertEqual(by_pkg["memorycore"], ["--source-root", f"data={data}"])
        self.assertNotIn("--allow-host", flat)
        self.assertTrue(data.is_dir())

    def test_digest_version_from_repoql_counts_as_installed(self):
        self.assertTrue(pc._is_installed({"state": "installed", "version": "sha256:" + "a" * 64}, "1.0.0"))
        self.assertFalse(pc._is_installed({"state": "installed", "version": "sha256:abc"}, "1.0.0"))
        self.assertTrue(pc._is_installed({"state": "installed", "version": "1.0.0"}, "1.0.0"))
        self.assertFalse(pc._is_installed({"state": "installed", "version": "0.9.0"}, "1.0.0"))
        self.assertFalse(pc._is_installed({"state": "failed", "version": "sha256:abc"}, "1.0.0"))
        self.assertFalse(pc._is_installed(None, "1.0.0"))

    def test_memorycore_envelope_requires_a_folder(self):
        with self.assertRaises(pc.ProvisionError):
            pc.bundled_envelope("memorycore", None)
        with self.assertRaises(pc.ProvisionError):
            pc.bundled_envelope("other", None)

    def test_declined_and_pending_and_failed_paths_are_reported(self):
        cases = [
            ("declined", completed(1, stderr="operator declined"), "declined"),
            ("pending", completed(0), "waiting_for_consent"),
            ("failed", completed(2, stderr="boom"), "failed"),
        ]
        for label, outcome, expected in cases:
            with self.subTest(case=label):
                result = pc.install_connectors(self.rql, self.lock, self.build_root,
                                               builder=lambda *a, **k: self._builder(),
                                               inventory_reader=lambda *a, **k: {},
                                               runner=lambda *a, **k: outcome)
                self.assertEqual(result["packages"][0]["state"], expected)
                self.assertEqual(result["packages"][1]["state"], "not_attempted")
                self.assertFalse(result["allInstalled"])
                self.assertEqual(result["awaitingConsent"], expected == "waiting_for_consent")

    def test_install_timeout_is_waiting_for_consent(self):
        def timeout(*args, **kwargs):
            raise subprocess.TimeoutExpired(args[0], 1)
        result = pc.install_connectors(self.rql, self.lock, self.build_root,
                                       builder=lambda *a, **k: self._builder(),
                                       inventory_reader=lambda *a, **k: {},
                                       runner=timeout)
        self.assertEqual(result["packages"][0]["state"], "waiting_for_consent")
        self.assertEqual(result["packages"][1]["state"], "not_attempted")

    def test_install_command_carries_no_envelope_flags(self):
        command = pc.install_command(Path("C:/rql.exe"), Path("C:/pkg.nupkg"))
        self.assertEqual(command, [str(Path("C:/rql.exe")), "connector", "install", str(Path("C:/pkg.nupkg"))])

    def test_scratch_workspace_has_the_initialized_repoql_shape(self):
        workspace = pc.ensure_workspace(self.build_root)
        marker = workspace / ".repoql"
        self.assertTrue((marker / "cache").is_dir())
        self.assertEqual((marker / ".gitignore").read_text(encoding="utf-8"), "*\n")
        self.assertEqual(json.loads((marker / "config.json").read_text(encoding="utf-8")),
                         {"mcp": {"include_globals": False}})

    def test_stop_workspace_host_uses_the_local_stop_verb(self):
        commands = []
        def runner(cmd, **kwargs):
            commands.append([str(part) for part in cmd])
            return completed()
        self.assertTrue(pc.stop_workspace_host(Path("C:/rql.exe"), self.build_root, runner=runner))
        self.assertEqual(commands, [[str(Path("C:/rql.exe")), "host", "stop"]])


if __name__ == "__main__":
    unittest.main()
