"""Read-only subprocess smoke checks for the Windows PowerShell 5.1 adapter."""
from __future__ import annotations

import json
import os
from pathlib import Path
import shutil
import subprocess
import sys
import unittest
from unittest.mock import patch


HERE = Path(__file__).resolve().parent
SCRIPT = HERE.parent / "ghost_task_scheduler.ps1"
LOCATION_POINTER = HERE.parents[3] / "ghost-acceptance-location.json"
POWERSHELL = shutil.which("powershell.exe")
sys.path.insert(0, str(SCRIPT.parent))
import ghost_scheduler_host as host_mod  # noqa: E402


@unittest.skipUnless(POWERSHELL and SCRIPT.is_file(), "Windows PowerShell adapter unavailable")
class WindowsPowerShellSchedulerSmokeTests(unittest.TestCase):
    def run_adapter(self, operation: str, payload: str = "{}") -> subprocess.CompletedProcess[str]:
        return subprocess.run(
            [
                POWERSHELL,
                "-NoLogo",
                "-NoProfile",
                "-NonInteractive",
                "-ExecutionPolicy",
                "Bypass",
                "-File",
                str(SCRIPT),
                "-Operation",
                operation,
            ],
            input=payload,
            capture_output=True,
            text=True,
            timeout=30,
            check=False,
        )

    def test_invoked_engine_is_windows_powershell_51(self):
        result = subprocess.run(
            [
                POWERSHELL,
                "-NoLogo",
                "-NoProfile",
                "-NonInteractive",
                "-Command",
                "[Console]::Out.Write($PSVersionTable.PSVersion.ToString())",
            ],
            capture_output=True,
            text=True,
            timeout=15,
            check=False,
        )
        self.assertEqual(result.returncode, 0, "PowerShell version probe failed")
        self.assertTrue(result.stdout.startswith("5.1."), "smoke test requires Windows PowerShell 5.1")

    def test_read_only_identity_timezone_and_list_operations(self):
        for operation in ("identity", "timezone", "list"):
            with self.subTest(operation=operation):
                result = self.run_adapter(operation)
                self.assertEqual(result.returncode, 0, f"read-only {operation} operation failed")
                response = json.loads(result.stdout)
                self.assertIs(response.get("ok"), True)
                if operation == "identity":
                    self.assertRegex(response.get("currentSid", ""), r"^S-1-[0-9]+(-[0-9]+)+$")
                elif operation == "timezone":
                    self.assertTrue(response.get("timeZoneId"))
                else:
                    self.assertIsInstance(response.get("tasks"), list)

    def test_host_read_only_operations_and_private_acl_with_poisoned_parent_environment(self):
        self.assertTrue(LOCATION_POINTER.is_file(), "private Ghost location pointer unavailable")
        location = json.loads(LOCATION_POINTER.read_text(encoding="utf-8"))
        config_path = Path(location["configPath"])
        self.assertTrue(config_path.is_file(), "private Ghost config fixture unavailable")

        filtered_names = {"PSMODULEPATH", "PSMODULEANALYSISCACHEPATH"}
        poisoned_environment = {
            key: value for key, value in os.environ.items() if key.upper() not in filtered_names
        }
        poisoned_environment["pSmOdUlEpAtH"] = "poisoned-module-path"
        poisoned_environment["PSMODULEANALYSISCACHEPATH"] = "poisoned-analysis-cache-path"
        scheduler = host_mod.PowerShellTaskScheduler(powershell=POWERSHELL)

        # Simulate the environment inherited from a PowerShell 7 parent. The
        # host must sanitize only its PowerShell 5.1 child environment.
        with patch.object(host_mod.os, "environ", poisoned_environment):
            owner_sid = scheduler.current_identity()
            scheduler.verify_private_path(config_path, owner_sid)
            self.assertTrue(scheduler.timezone_id())
            self.assertIsInstance(scheduler.list_tasks(), list)

    def test_empty_operation_payload_still_rejects_unknown_fields(self):
        result = self.run_adapter("identity", '{"unexpected":true}')
        self.assertEqual(result.returncode, 2)
        self.assertEqual(result.stderr.strip(), "TASK_SCHEDULER_OPERATION_FAILED")


if __name__ == "__main__":
    unittest.main()
