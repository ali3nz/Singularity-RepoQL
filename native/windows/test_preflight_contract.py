"""Offline source contract only; cannot execute PowerShell without Windows."""
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parent


class PreflightContract(unittest.TestCase):
    def test_preflight_is_read_only_and_has_all_four_variants(self):
        script = (ROOT / 'preflight.ps1').read_text(encoding='utf-8')
        for value in ('[ValidateRange(1, 4)]', "required_repoql_version = '1.7.18'", 'required_connector_abi = 1',
                      'windows_gui_runtime_verified = $false', 'release_ready = $false',
                      "'127.0.0.1'", 'ConvertTo-Json', 'SkipLocalPortChecks'):
            self.assertIn(value, script)
        # Explicitly disallow changes to services or installer state in this tool.
        for value in ('Start-Service ', 'Stop-Service ', 'Set-Service ', 'New-Service ',
                      'Remove-Item ', 'Set-ItemProperty ', 'Invoke-WebRequest', 'Start-Process '):
            self.assertNotIn(value, script)


if __name__ == '__main__':
    unittest.main()
