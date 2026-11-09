"""The native dashboard no longer consumes Ghost client configuration."""
import ast
import os
from pathlib import Path
import sys
import tempfile
from types import ModuleType
import unittest
from unittest.mock import patch

from claude_complete_dashboard_host import environment, main


ROOT = Path(__file__).resolve().parents[2]


class NativeGhostClientRetirementTests(unittest.TestCase):
    def setUp(self):
        temporary = tempfile.TemporaryDirectory()
        self.addCleanup(temporary.cleanup)
        self.root = Path(temporary.name)
        self.source = self.root / "source"
        (self.source / "dashboard").mkdir(parents=True)
        for connector in ("memorycore", "kanzo"):
            path = self.source / "connectors" / connector
            path.mkdir(parents=True)
            (path / "manifest.yaml").write_text("scheme: test\n", encoding="utf-8")
        (self.source / "dashboard" / "server.py").write_text("", encoding="utf-8")
        self.rql = self.root / "rql.exe"
        self.rql.write_bytes(b"test fixture")
        self.workspace = self.root / "workspace"
        self.workspace.mkdir()
        self.state = self.root / "Singularity" / "Dashboard"
        self.state.mkdir(parents=True)
        # Deliberately untrusted, absent paths: compatibility kwargs must be
        # accepted without validation, stat, or file reads.
        self.bridge = self.root / "untrusted" / "not-a-real-bridge.exe"
        self.config = self.root / "untrusted" / "not-a-real-client.json"

    def run_environment(self, variant=2, legacy=True):
        kwargs = ({"native_bridge_exe": self.bridge, "ghost_control_config": self.config}
                  if legacy else {})
        return environment(self.source, self.rql, self.workspace, self.state, 18100,
                           variant=variant, windows=True, **kwargs)

    def test_all_four_variants_need_no_ghost_config_and_ignore_legacy_paths(self):
        for variant in (1, 2, 3, 4):
            with self.subTest(variant=variant):
                # Both new and old task call shapes work; the latter supplies
                # paths that would fail any legacy validation or file access.
                for legacy in (False, True):
                    result = self.run_environment(variant, legacy=legacy)
                    self.assertEqual(result["SINGULARITY_INSTALL_VARIANT"], str(variant))
                    self.assertFalse(any("GHOST" in key or "NATIVE_BRIDGE" in key for key in result))

    def test_host_retains_only_inert_legacy_cli_and_keyword_names(self):
        host_path = ROOT / "native/windows/claude_complete_dashboard_host.py"
        host_source = host_path.read_text(encoding="utf-8")
        tree = ast.parse(host_source)
        environment_function = next(n for n in tree.body
                                    if isinstance(n, ast.FunctionDef) and n.name == "environment")
        self.assertIn("native_bridge_exe", {arg.arg for arg in environment_function.args.kwonlyargs})
        self.assertIn("ghost_control_config", {arg.arg for arg in environment_function.args.kwonlyargs})
        body = "\n".join(host_source.splitlines()[environment_function.body[0].lineno - 1:
                                                    environment_function.end_lineno])
        self.assertNotIn("native_bridge_exe", body)
        self.assertNotIn("ghost_control_config", body)
        self.assertNotIn("_native_ghost_environment", host_source)
        self.assertNotIn("SINGULARITY_NATIVE_BRIDGE_EXE", host_source)
        self.assertNotIn("SINGULARITY_GHOST_CONTROL_CONFIG", host_source)
        self.assertIn("p.add_argument('--native-bridge-exe'", host_source)
        self.assertIn("p.add_argument('--ghost-control-config'", host_source)
        self.assertNotIn("native_bridge_exe=a.native_bridge_exe", host_source)
        self.assertNotIn("ghost_control_config=a.ghost_control_config", host_source)

    def test_cli_accepts_legacy_ghost_flags_without_using_their_paths(self):
        calls = []
        fake_server = ModuleType("server")
        fake_server.main = lambda args: calls.append(args) or "checked"
        argv = [
            "--source-root", str(self.source),
            "--rql-exe", str(self.rql),
            "--workspace", str(self.workspace),
            "--state-dir", str(self.state),
            "--native-bridge-exe", str(self.bridge),
            "--ghost-control-config", str(self.config),
            "--mode", "check",
        ]
        with patch.dict(os.environ, {}, clear=True), \
                patch.dict(sys.modules, {"server": fake_server}), \
                patch.object(sys, "path", list(sys.path)):
            self.assertEqual(main(argv), "checked")
        self.assertEqual(calls, [["check"]])

    def test_manager_rejects_new_ghost_registration_but_keeps_legacy_receipt_checks(self):
        manager = (ROOT / "native/windows/manage_claude_complete_dashboard.ps1").read_text(encoding="utf-8")
        self.assertIn("$Mode -eq 'Register' -and ($NativeBridgeExe -or $GhostControlConfig)", manager)
        self.assertNotIn("--native-bridge-exe", manager)
        self.assertNotIn("--ghost-control-config", manager)
        self.assertIn("$receipt.PSObject.Properties['nativeBridgeExe']", manager)
        self.assertIn("$receipt.PSObject.Properties['ghostControlConfig']", manager)
        self.assertIn("if ($legacyNativeBridgeExe -or $legacyGhostControlConfig)", manager)
        self.assertIn("if ($Variant -notin @(2,4) -or -not $legacyNativeBridgeExe -or -not $legacyGhostControlConfig)", manager)
        self.assertIn("Join-Path $env:LOCALAPPDATA 'Singularity/GhostScheduler/native-bridge-client.json'", manager)
        self.assertIn("[IO.Path]::GetFileName($legacyNativeBridgeExe) -ine 'singularity-desktop-bridge.exe'", manager)
        self.assertIn("$legacyGhostControlConfig.Equals($expectedGhostConfig", manager)
        self.assertIn("Assert-Path $legacyNativeBridgeExe 'NATIVE_BRIDGE'", manager)
        self.assertIn("Assert-Path $legacyGhostControlConfig 'GHOST_CLIENT_CONFIG'", manager)
        for check in (
            "Assert-ReceiptAcl",
            "DASHBOARD_OWNERSHIP_RECEIPT_OWNER_MISMATCH",
            "DASHBOARD_OWNERSHIP_RECEIPT_INVALID",
            "[string]$actual[0].Execute -ne [string]$receipt.pythonExe",
            "[string]$actual[0].Arguments -ne [string]$receipt.arguments",
            "-not ($userIds -contains [string]$task.Principal.UserId)",
            "[string]$task.Principal.RunLevel -notin @('Limited', 'LeastPrivilege')",
            "Assert-TaskOwned $existing[0] $owned",
            "Assert-TaskOwned $task[0] $owned",
            "Unregister-ScheduledTask -TaskName $taskName",
            "DASHBOARD_TASK_REMOVAL_UNVERIFIED",
        ):
            self.assertIn(check, manager)


if __name__ == "__main__":
    unittest.main()
