"""Source-only PowerShell/Rust consistency checks; NOT Windows runtime proof."""
from pathlib import Path
import unittest

ROOT=Path(__file__).resolve().parents[2]

class BareRepoqlVersionContract(unittest.TestCase):
    def test_each_powershell_executable_probe_accepts_bare_and_rejects_mixed(self):
        for relative in ('native/windows/preflight.ps1', 'native/windows/stage-native.ps1', 'native/windows/provision_repoql.ps1'):
            with self.subTest(path=relative):
                code=(ROOT/relative).read_text(encoding='utf-8')
                self.assertIn("[regex]::Match(", code)
                self.assertIn("'^(?i:v)?(\\d+\\.\\d+\\.\\d+)$'", code)
                self.assertIn('$bareLines', code)
                self.assertIn("'1.7.18'", code)
    def test_dashboard_status_is_post_action_scheduler_readback(self):
        code=(ROOT/'native/windows/manage_claude_complete_dashboard.ps1').read_text(encoding='utf-8')
        self.assertIn('$finalTasks=@(Get-TaskCandidates)', code)
        self.assertIn('taskRegistered=($finalTasks.Count -eq 1 -and $finalReceiptExists)',code)
        self.assertNotIn('taskRegistered=($Mode',code)
    def test_rust_source_covers_bare_and_conflicting_version(self):
        code=(ROOT/'native/desktop-bridge/src/repoql_compat.rs').read_text(encoding='utf-8')
        self.assertIn('parse_version("1.7.18\\n")',code)
        self.assertIn('parse_version("rql 1.7.18\\n1.7.17")',code)

if __name__=='__main__': unittest.main()
