"""Focused connector source contracts and native PowerShell behavior checks.

Windows-only checks execute the current extracted PowerShell blocks against
task-owned fixtures and mocked child helpers; they never install a connector.
"""
from __future__ import annotations

import hashlib
import json
import os
from pathlib import Path
import shutil
import stat
import subprocess
import sys
import unittest
import uuid

ROOT = Path(__file__).resolve().parents[2]
WINDOWS = ROOT / "native" / "windows"


class ConnectorWiringContract(unittest.TestCase):
    def test_lifecycle_exposes_status_build_and_install(self):
        text = (WINDOWS / "manage_native_windows.ps1").read_text(encoding="utf-8")
        self.assertIn("[ValidateSet('','status','build','install')][string]$ConnectorAction=''", text)
        self.assertIn("$connectorMutating=$ConnectorAction -in @('build','install')", text)
        self.assertIn("NATIVE_LIFECYCLE_EXPLICIT_APPLY_REQUIRED", text)
        self.assertIn("provision_connectors.py", text)
        self.assertIn("'--action',$ConnectorAction,'--rql-exe',$repoqlPath,'--build-root',$connectorBuildRoot", text)
        self.assertIn("NATIVE_CONNECTOR_BUILD_ROOT_OUTSIDE_LOCALAPPDATA_SINGULARITY", text)
        path_guard = text.index("Assert-LocalPath $connectorBuildRoot 'NATIVE_CONNECTOR_BUILD_ROOT_INVALID' $false $true")
        lexical_boundary = text.index("if (-not $connectorBuildRoot.StartsWith")
        helper_invocation = text.index("$raw=& $pythonPath @argv")
        self.assertLess(path_guard, lexical_boundary)
        self.assertLess(lexical_boundary, helper_invocation)
        self.assertIn("Emit-Result ([ordered]@{schema='singularity-native-connectors/v1'", text)
        self.assertIn("function Emit-Result($Data) { $Data | ConvertTo-Json -Depth 12 -Compress }", text)
        self.assertLess(text.index("if ($ConnectorAction)"), text.index("if ($Mode -eq 'Plan')"))
        route = text[text.index("$argv=@($helper"):text.index("$raw=& $pythonPath @argv")]
        for forbidden in ("--allow-local-host", "--allow-host", "--source-root", "--rate"):
            self.assertNotIn(forbidden, route)
        self.assertIn("'--auto-approve','--memory-data-root',(Join-Path $installRoot 'memory\\state\\data\\core')", text)

    def test_bootstrap_builds_but_does_not_install_a_connector(self):
        text = (WINDOWS / "bootstrap_runtime.ps1").read_text(encoding="utf-8")
        self.assertIn("[switch]$InstallProduct,\n  [switch]$ProvisionConnectors", text)
        block_start = text.index("$connectorProvisioning=$null")
        block_end = text.index("\n[ordered]@{", block_start)
        block = text[block_start:block_end]
        self.assertIn("action='build';state='planned'", block)
        self.assertIn("$connectorProvisioning.installCommand='powershell", block)
        self.assertNotIn("$connectorAction=if ($Apply) {'build'} else {'status'}", block)
        self.assertNotIn("'-ConnectorAction','status'", block)
        apply_branch = block.index("if ($Apply) {")
        invocation = block.index("$raw=& powershell @argv")
        self.assertLess(apply_branch, invocation)
        self.assertEqual(block[apply_branch:invocation].count("{") - block[apply_branch:invocation].count("}"), 1)
        self.assertEqual(block.count("$raw=& powershell @argv"), 1)
        self.assertIn("$argv=@('-NoProfile','-ExecutionPolicy','Bypass','-File',$manager,'-ConnectorAction','build'", block)
        self.assertIn("connectorProvisioning=$connectorProvisioning", text)
        self.assertIn("-ConnectorAction install -Apply", text)
        self.assertNotIn("-ConnectorAction install -Apply -RepoqlExe", text.split("installCommand=")[0])
        for forbidden in ("--allow-local-host", "--allow-host", "--source-root"):
            self.assertNotIn(forbidden, text)

    def test_packages_are_pinned_and_bytes_are_not_committed(self):
        lock = json.loads((ROOT / "connectors" / "packages.lock.json").read_text(encoding="utf-8"))
        self.assertEqual(lock["repoqlVersion"], "1.7.18")
        self.assertEqual(lock["connectorAbi"], 1)
        self.assertEqual({p["scheme"] for p in lock["packages"]}, {"kanzo", "memorycore"})
        for spec in lock["packages"]:
            self.assertRegex(spec["sha256"], r"^[0-9a-f]{64}$")
            self.assertGreater(spec["bytes"], 0)
            self.assertFalse((ROOT / "connectors" / spec["package"]).exists())

    def test_documentation_uses_the_local_consent_flow(self):
        connectors = (ROOT / "connectors" / "README.md").read_text(encoding="utf-8")
        self.assertIn("-ConnectorAction status `\n  -RepoqlExe $repoqlExe `\n  -PythonExe $pythonExe", connectors)
        self.assertIn("-ConnectorAction install -Apply `\n  -RepoqlExe $repoqlExe `\n  -PythonExe $pythonExe", connectors)
        self.assertIn("local install review page", connectors)
        self.assertIn("rql connector install RepoQL.Connectors.Kanzo.1.0.0.nupkg", connectors)
        self.assertIn("rql connector install Tencent.MemoryCore.1.0.0.nupkg", connectors)
        self.assertNotIn("rql connector install --allow-local-host", connectors)
        status_example = connectors.split("# Read-only connector inventory", 1)[1].split(
            "# Install both connectors (automatic, fixed access)", 1
        )[0]
        install_example = connectors.split("# Install both connectors (automatic, fixed access)", 1)[1].split(
            "```", 1
        )[0]
        self.assertIn("-ConnectorAction status", status_example)
        self.assertIn("-RepoqlExe $repoqlExe", status_example)
        self.assertIn("-PythonExe $pythonExe", status_example)
        self.assertNotIn("-Apply", status_example)
        self.assertIn("-ConnectorAction install -Apply", install_example)
        self.assertIn("-RepoqlExe $repoqlExe", install_example)
        self.assertIn("-PythonExe $pythonExe", install_example)
        native = (ROOT / "docs" / "NATIVE-WINDOWS-INSTALLATION.md").read_text(encoding="utf-8")
        self.assertIn("-ProvisionConnectors", native)
        self.assertIn("-ConnectorAction install -Apply", native)
        self.assertIn("waiting_for_consent", native)
        self.assertIn("dashboard stays read-only", native)


@unittest.skipUnless(os.name == "nt", "requires native Windows PowerShell")
class NativePowerShellBehavior(unittest.TestCase):
    """Execute the actual current source blocks with only task-owned fixtures."""

    def setUp(self):
        self.real_helper = WINDOWS / "provision_connectors.py"
        self.assertTrue(self.real_helper.is_file(), "real repository provision_connectors.py is missing")
        self.assertFalse(self._is_reparse_point(self.real_helper), "real repository helper must be a plain file")
        self.real_helper_sha256_before = self._sha256(self.real_helper)
        self.repository_harnesses_before = self._repository_harness_paths()
        self.assertEqual(
            self.repository_harnesses_before,
            (),
            "repository already contains a connector regression harness before the test",
        )
        print(
            "REPOSITORY_INTEGRITY_BEFORE "
            + json.dumps(
                {
                    "realHelper": str(self.real_helper.relative_to(ROOT)),
                    "realHelperSha256": self.real_helper_sha256_before,
                    "harnessFiles": list(self.repository_harnesses_before),
                },
                sort_keys=True,
            )
        )
        local_app_data = os.environ.get("LOCALAPPDATA")
        self.assertTrue(local_app_data, "LOCALAPPDATA is required for native fixtures")
        self.local_app_data = Path(local_app_data)
        self._assert_plain_directory(self.local_app_data)
        self.singularity = Path(local_app_data) / "Singularity"
        self.assertTrue(self.singularity.is_dir(), "expected existing Singularity directory")
        self._assert_plain_directory(self.singularity)
        self.fixture = self.singularity / f"connector-regression-{uuid.uuid4().hex}"
        self.assertFalse(os.path.lexists(self.fixture), "unique fixture unexpectedly exists")
        self.fixture.mkdir()
        self._junction_proofs = []
        self._owned_targets = []
        self.addCleanup(self._cleanup_fixture)

    @staticmethod
    def _is_reparse_point(path: Path) -> bool:
        return bool(os.lstat(path).st_file_attributes & getattr(stat, "FILE_ATTRIBUTE_REPARSE_POINT", 0x400))

    def _assert_plain_directory(self, path: Path):
        self.assertFalse(self._is_reparse_point(path), f"refusing reparse-point fixture base: {path}")

    def _repository_harness_paths(self) -> tuple[str, ...]:
        matches = []
        for current, directories, files in os.walk(ROOT, topdown=True, followlinks=False):
            parent = Path(current)
            directories[:] = [
                name for name in directories if not self._is_reparse_point(parent / name)
            ]
            for name in files:
                if name.startswith("_connector-regression-") and name.endswith(".ps1"):
                    matches.append((parent / name).relative_to(ROOT).as_posix())
        return tuple(sorted(matches))

    def _assert_repository_integrity(self, phase: str):
        self.assertTrue(self.real_helper.is_file(), "real repository helper disappeared during native tests")
        self.assertFalse(self._is_reparse_point(self.real_helper), "real repository helper became a reparse point")
        actual_sha256 = self._sha256(self.real_helper)
        self.assertEqual(
            actual_sha256,
            self.real_helper_sha256_before,
            "real repository provision_connectors.py changed during native tests",
        )
        harnesses = self._repository_harness_paths()
        self.assertEqual(
            harnesses,
            self.repository_harnesses_before,
            "repository connector regression harness inventory changed during native tests",
        )
        print(
            "REPOSITORY_INTEGRITY "
            + json.dumps(
                {
                    "phase": phase,
                    "realHelperExists": True,
                    "realHelperSha256Before": self.real_helper_sha256_before,
                    "realHelperSha256After": actual_sha256,
                    "repositoryHarnessFiles": list(harnesses),
                },
                sort_keys=True,
            )
        )

    def _cleanup_fixture(self):
        if not os.path.lexists(self.fixture):
            self._assert_repository_integrity("after")
            return
        for link, marker, before_hash in self._junction_proofs:
            if marker.exists():
                self.assertEqual(self._sha256(marker), before_hash, "junction target marker changed before cleanup")
            if os.path.lexists(link):
                self.assertTrue(self._is_reparse_point(link), f"owned junction path changed type: {link}")
                # Exact path only, no recursion: remove the link, never its target.
                os.rmdir(link)
            if marker.exists():
                self.assertEqual(self._sha256(marker), before_hash, "junction target marker changed after cleanup")
        for target in self._owned_targets:
            if not os.path.lexists(target):
                continue
            self.assertEqual(target.parent, self.local_app_data, "outside target escaped the task-owned LocalAppData parent")
            self.assertTrue(target.name.startswith("connector-junction-outside-"), "unexpected outside-target name")
            self._assert_plain_directory(target)
            for current, directories, files in os.walk(target, topdown=True, followlinks=False):
                for name in directories + files:
                    child = Path(current) / name
                    self.assertFalse(self._is_reparse_point(child), f"unexpected reparse point in outside target: {child}")
            shutil.rmtree(target)
            self.assertFalse(os.path.lexists(target), "task-owned outside target was not removed")
            print(f"OUTSIDE_TARGET_CLEANUP target={target.name} removed=true")
        for current, directories, files in os.walk(self.fixture, topdown=True, followlinks=False):
            for name in directories + files:
                child = Path(current) / name
                self.assertFalse(self._is_reparse_point(child), f"unexpected reparse point remains: {child}")
        shutil.rmtree(self.fixture)
        self.assertFalse(os.path.lexists(self.fixture), "owned fixture was not removed")
        print(f"FIXTURE_CLEANUP root={self.fixture.name} removed=true")
        self._assert_repository_integrity("after")

    @staticmethod
    def _sha256(path: Path) -> str:
        return hashlib.sha256(path.read_bytes()).hexdigest()

    @staticmethod
    def _ps_quote(value: str | Path) -> str:
        return "'" + str(value).replace("'", "''") + "'"

    @staticmethod
    def _powershell_executable() -> str:
        executable = shutil.which("powershell.exe") or shutil.which("powershell")
        if not executable:
            raise AssertionError("Windows PowerShell 5.1 executable is unavailable")
        return executable

    def _run_powershell(self, body: str, extra_env: dict[str, str] | None = None) -> dict:
        windows_dir = self.fixture
        self.assertTrue(windows_dir.is_dir())
        self._assert_plain_directory(windows_dir)
        script = windows_dir / f"_connector-regression-{uuid.uuid4().hex}.ps1"
        self.assertFalse(os.path.lexists(script), "unique PowerShell harness unexpectedly exists")
        script.write_text(body, encoding="utf-8-sig")
        env = os.environ.copy()
        if extra_env:
            env.update(extra_env)
        try:
            completed = subprocess.run(
                [
                    self._powershell_executable(),
                    "-NoLogo",
                    "-NoProfile",
                    "-NonInteractive",
                    "-ExecutionPolicy",
                    "Bypass",
                    "-File",
                    str(script),
                ],
                capture_output=True,
                text=True,
                encoding="utf-8",
                errors="replace",
                timeout=60,
                env=env,
            )
        finally:
            if os.path.lexists(script):
                script.unlink()
        self.assertEqual(
            completed.returncode,
            0,
            f"PowerShell harness failed ({completed.returncode})\nstdout:\n{completed.stdout}\nstderr:\n{completed.stderr}",
        )
        output_lines = [line for line in completed.stdout.splitlines() if line.strip()]
        self.assertTrue(output_lines, f"PowerShell harness produced no JSON: {completed.stderr}")
        return json.loads(output_lines[-1])

    @staticmethod
    def _bootstrap_block() -> str:
        source = (WINDOWS / "bootstrap_runtime.ps1").read_text(encoding="utf-8")
        start = source.index("$connectorProvisioning=$null")
        end = source.index("\n[ordered]@{", start)
        return source[start:end]

    @staticmethod
    def _manager_fragments() -> tuple[str, str, str, str]:
        source = (WINDOWS / "manage_native_windows.ps1").read_text(encoding="utf-8")
        path_guard_start = source.index("function Assert-LocalPath(")
        path_guard_end = source.index("\nfunction Assert-PrivateAcl", path_guard_start)
        route_start = source.index("if ($ConnectorAction) {")
        route_end = source.index("\n\nif ($Mode -eq 'Plan')", route_start)
        base_lines = [line for line in source.splitlines() if line.startswith("$base=[IO.Path]::GetFullPath(")]
        emit_lines = [line for line in source.splitlines() if line.startswith("function Emit-Result($Data)")]
        if len(base_lines) != 1 or len(emit_lines) != 1:
            raise AssertionError("could not uniquely bind connector harness to manager base/emit source")
        return source[path_guard_start:path_guard_end], source[route_start:route_end], base_lines[0], emit_lines[0]

    def _bootstrap_harness(self, apply: bool) -> tuple[str, dict[str, str], list[str]]:
        manager = WINDOWS / "manage_native_windows.ps1"
        self.assertTrue(manager.is_file(), "task fixture manager script is missing")
        repoql = self.fixture / "repoql-placeholder.exe"
        python = self.fixture / "python-placeholder.exe"
        repoql.write_bytes(b"task-owned non-executable placeholder\n")
        python.write_bytes(b"task-owned non-executable placeholder\n")
        workspace = self.fixture / "workspace-must-not-be-created"
        child_json = '{"status":"fixture-report"}'
        body = "\n".join(
            [
                "$ErrorActionPreference='Stop'",
                "$script:ChildCount=0; $script:ChildArgs=@(); $script:StopCount=0",
                f"$scriptDir={self._ps_quote(WINDOWS)}",
                f"$repoql=[pscustomobject]@{{state='ready';path={self._ps_quote(repoql)}}}",
                f"$py312=[pscustomobject]@{{state='ready';path={self._ps_quote(python)}}}",
                "$ProvisionConnectors=$true",
                f"$Apply=${str(apply).lower()}",
                "function powershell { $script:ChildCount++; $script:ChildArgs=@($args); $global:LASTEXITCODE=0; return "
                + self._ps_quote(child_json)
                + " }",
                "function Stop-Service { $script:StopCount++ }",
                "function Invoke-ActualProvisioningBlock {",
                self._bootstrap_block(),
                "  return $connectorProvisioning",
                "}",
                "$provisioning=Invoke-ActualProvisioningBlock",
                "[ordered]@{provisioning=$provisioning;childCount=$script:ChildCount;childArgs=$script:ChildArgs;stopCount=$script:StopCount;workspaceExists=(Test-Path -LiteralPath "
                + self._ps_quote(workspace)
                + ")} | ConvertTo-Json -Depth 12 -Compress",
            ]
        )
        env = {
            "OC_CONNECTOR_WORKSPACE": str(workspace),
            "OC_CONNECTOR_REPOQL": str(repoql),
            "OC_CONNECTOR_PYTHON": str(python),
        }
        expected_args = [
            "-NoProfile",
            "-ExecutionPolicy",
            "Bypass",
            "-File",
            str(manager),
            "-ConnectorAction",
            "build",
            "-RepoqlExe",
            str(repoql),
            "-PythonExe",
            str(python),
            "-Apply",
        ]
        return body, env, expected_args

    def test_bootstrap_plan_does_not_invoke_helpers_or_touch_workspace(self):
        body, env, _ = self._bootstrap_harness(apply=False)
        result = self._run_powershell(body, env)
        self.assertEqual(result["provisioning"]["action"], "build")
        self.assertEqual(result["provisioning"]["state"], "planned")
        self.assertFalse(result["provisioning"]["invoked"])
        self.assertEqual(result["childCount"], 0)
        self.assertEqual(result["childArgs"], [])
        self.assertEqual(result["stopCount"], 0)
        self.assertFalse(result["workspaceExists"])

    def test_bootstrap_apply_invokes_build_once_with_exact_arguments(self):
        body, env, expected_args = self._bootstrap_harness(apply=True)
        result = self._run_powershell(body, env)
        self.assertEqual(result["childCount"], 1)
        self.assertEqual(result["childArgs"], expected_args)
        self.assertTrue(result["provisioning"]["invoked"])
        self.assertEqual(result["provisioning"]["action"], "build")
        self.assertEqual(result["provisioning"]["state"], "reported")
        self.assertEqual(result["provisioning"]["exitCode"], 0)
        self.assertEqual(result["provisioning"]["result"]["status"], "fixture-report")
        self.assertEqual(result["stopCount"], 0)
        self.assertFalse(result["workspaceExists"])

    def _prepare_manager_fixture(self) -> tuple[Path, Path, Path]:
        repoql = self.fixture / "repoql-placeholder.exe"
        repoql.write_bytes(b"task-owned non-executable placeholder\n")
        capture = self.fixture / "mock-helper-argv.json"
        helper = self.fixture / "provision_connectors.py"
        self.assertFalse(os.path.lexists(helper), "fixture mock helper path unexpectedly exists")
        helper.write_text(
            "import json, os, sys\n"
            "with open(os.environ['OC_CONNECTOR_CAPTURE'], 'w', encoding='utf-8') as stream:\n"
            "    json.dump(sys.argv[1:], stream)\n"
            "print(json.dumps({'fixture': 'mocked'}))\n",
            encoding="utf-8",
        )
        return repoql, capture, helper

    def _manager_setup_and_route(self) -> tuple[list[str], str]:
        path_function, route, base_assignment, emit_function = self._manager_fragments()
        return (
            [
                "$ErrorActionPreference='Stop'",
                "$ConnectorAction='build'",
                "$RepoqlExe=$env:OC_CONNECTOR_REPOQL",
                "$PythonExe=$env:OC_CONNECTOR_PYTHON",
                "$ConnectorBuildRoot=$env:OC_CONNECTOR_BUILD_ROOT",
                base_assignment,
                emit_function,
                path_function,
            ],
            route,
        )

    def _manager_harness(self) -> str:
        setup, route = self._manager_setup_and_route()
        return "\n".join(
            setup
            + [
                "$failure=''; $routeOutput=$null",
                "try { $routeOutput=& {",
                route,
                "} } catch { $failure=$_.Exception.Message }",
                "[ordered]@{failure=$failure;routeOutput=$routeOutput} | ConvertTo-Json -Depth 12 -Compress",
            ]
        )

    def _run_manager(self, repoql: Path, capture: Path, build_root: Path) -> dict:
        self.assertFalse(os.path.lexists(capture), "mock helper capture unexpectedly exists")
        env = {
            "OC_CONNECTOR_REPOQL": str(repoql),
            "OC_CONNECTOR_PYTHON": sys.executable,
            "OC_CONNECTOR_BUILD_ROOT": str(build_root),
            "OC_CONNECTOR_CAPTURE": str(capture),
        }
        return self._run_powershell(self._manager_harness(), env)

    def test_manager_allows_nonexistent_local_descendant_with_mock_helper(self):
        repoql, capture, _ = self._prepare_manager_fixture()
        build_root = self.fixture / "not-created" / "nested-build-root"
        self.assertFalse(os.path.lexists(build_root))
        result = self._run_manager(repoql, capture, build_root)
        self.assertEqual(result["failure"], "")
        manager_result = json.loads(result["routeOutput"])
        self.assertEqual(manager_result["action"], "build")
        self.assertEqual(manager_result["buildRoot"], os.path.normpath(str(build_root)))
        self.assertEqual(manager_result["exitCode"], 0)
        self.assertEqual(manager_result["result"]["fixture"], "mocked")
        self.assertEqual(
            json.loads(capture.read_text(encoding="utf-8")),
            [
                "--action",
                "build",
                "--rql-exe",
                os.path.normpath(str(repoql)),
                "--build-root",
                os.path.normpath(str(build_root)),
            ],
        )
        self.assertFalse(os.path.lexists(build_root), "manager/mock helper created the build root")

    def test_manager_rejects_lexical_outside_before_helper(self):
        repoql, capture, _ = self._prepare_manager_fixture()
        outside = self.singularity.parent / f"Singularity-outside-{uuid.uuid4().hex}"
        self.assertFalse(os.path.lexists(outside), "outside test path unexpectedly exists")
        result = self._run_manager(repoql, capture, outside)
        self.assertEqual(result["failure"], "NATIVE_CONNECTOR_BUILD_ROOT_OUTSIDE_LOCALAPPDATA_SINGULARITY")
        self.assertFalse(os.path.lexists(capture), "helper ran before lexical boundary refusal")
        self.assertFalse(os.path.lexists(outside), "outside test path was created")

    def test_manager_rejects_real_junction_ancestor_before_helper(self):
        repoql, capture, _ = self._prepare_manager_fixture()
        target = self.local_app_data / f"connector-junction-outside-{uuid.uuid4().hex}"
        self.assertEqual(target.parent, self.local_app_data)
        self.assertFalse(os.path.lexists(target), "unique outside-boundary target unexpectedly exists")
        target.mkdir()
        self._owned_targets.append(target)
        marker = target / "target-marker.txt"
        marker.write_bytes(f"junction-target-{uuid.uuid4().hex}\n".encode("ascii"))
        marker_before = self._sha256(marker)
        link_parent = self.fixture / "junction-parent"
        link = link_parent / "owned-junction"
        self._junction_proofs.append((link, marker, marker_before))
        build_root = link / "not-created"
        setup, route = self._manager_setup_and_route()
        body = "\n".join(
            setup
            + [
                f"$target={self._ps_quote(target)}; $marker={self._ps_quote(marker)}",
                f"$linkParent={self._ps_quote(link_parent)}; $junction={self._ps_quote(link)}",
                "$markerBefore=(Get-FileHash -LiteralPath $marker -Algorithm SHA256).Hash; $junctionAttributes=''; $failure=''; $routeOutput=$null; $creationFailure=''",
                "try {",
                "  $null=New-Item -ItemType Directory -Path $linkParent -ErrorAction Stop",
                "  $null=New-Item -ItemType Junction -Path $junction -Target $target -ErrorAction Stop",
                "  $junctionItem=Get-Item -LiteralPath $junction -Force",
                "  $junctionAttributes=[string]$junctionItem.Attributes",
                "  if (($junctionItem.Attributes -band [IO.FileAttributes]::ReparsePoint) -eq 0) { throw 'TEST_JUNCTION_NOT_REPARSE_POINT' }",
                "  try { $routeOutput=& {",
                route,
                "  } } catch { $failure=$_.Exception.Message }",
                "} catch { $creationFailure=$_.Exception.Message }",
                "$markerAfterRoute=(Get-FileHash -LiteralPath $marker -Algorithm SHA256).Hash",
                "$linkExistsAfterRoute=Test-Path -LiteralPath $junction",
                "[ordered]@{failure=$failure;creationFailure=$creationFailure;routeOutput=$routeOutput;junctionAttributes=$junctionAttributes;markerBefore=$markerBefore;markerAfterRoute=$markerAfterRoute;linkExistsAfterRoute=$linkExistsAfterRoute;targetMarkerExists=(Test-Path -LiteralPath $marker)} | ConvertTo-Json -Depth 12 -Compress",
            ]
        )
        result = self._run_powershell(
            body,
            {
                "OC_CONNECTOR_REPOQL": str(repoql),
                "OC_CONNECTOR_PYTHON": sys.executable,
                "OC_CONNECTOR_BUILD_ROOT": str(build_root),
                "OC_CONNECTOR_CAPTURE": str(capture),
            },
        )
        self.assertIn("ReparsePoint", result["junctionAttributes"])
        self.assertEqual(result["creationFailure"], "", "native Directory Junction creation failed")
        self.assertEqual(result["failure"], "NATIVE_REPARSE_PATH_REFUSED")
        self.assertFalse(os.path.lexists(capture), "helper ran before reparse-point refusal")
        self.assertTrue(result["linkExistsAfterRoute"], "New-Item did not leave a junction for the route check")
        self.assertTrue(result["targetMarkerExists"], "junction target marker is missing after route check")
        self.assertEqual(result["markerBefore"].lower(), marker_before)
        self.assertEqual(result["markerAfterRoute"].lower(), marker_before)
        self.assertEqual(self._sha256(marker), marker_before)
        self.assertFalse(os.path.lexists(build_root), "manager created build-root through junction")
        self.assertTrue(self._is_reparse_point(link), "expected task-owned native Junction reparse point")
        os.rmdir(link)  # exact owned link path only; unlike recursive removal, this does not traverse it
        self.assertFalse(os.path.lexists(link), "owned junction link was not removed")
        self.assertTrue(marker.exists(), "removing the link deleted the target marker")
        self.assertEqual(self._sha256(marker), marker_before, "target marker changed during junction removal")
        print(
            "JUNCTION_EVIDENCE "
            + json.dumps(
                {
                    "createdBy": "New-Item -ItemType Junction",
                    "attributes": result["junctionAttributes"],
                    "managerRefusal": result["failure"],
                    "helperInvoked": False,
                    "targetOutsideSingularity": target.parent == self.singularity.parent,
                    "linkRemovedExactly": not os.path.lexists(link),
                    "targetMarkerExists": result["targetMarkerExists"],
                    "markerSha256Before": result["markerBefore"].lower(),
                    "markerSha256After": self._sha256(marker),
                },
                sort_keys=True,
            )
        )


if __name__ == "__main__":
    unittest.main()
