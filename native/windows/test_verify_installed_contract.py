from pathlib import Path
import unittest
S=Path(__file__).with_name('install_claude_complete.ps1').read_text(encoding='utf8')
class InstalledReadback(unittest.TestCase):
    def test_no_original_zip_dependency(self):
        start=S.index("if ($Mode -eq 'VerifyInstalled')")
        end=S.index("if ($Mode -eq 'SupervisorVerify')",start)
        chunk=S[start:end]
        self.assertIn('Assert-OwnedStagingSnapshot $current',chunk)
        self.assertNotIn('Assert-Prepared',chunk)
        self.assertNotIn('$Bundle',chunk)
        self.assertIn('nativeClaudeGuiVerified=$false',chunk)
    def test_checks_configuration_and_returns_fail_closed(self):
        for marker in ('OWNED_CLAUDE_CONFIG_VERIFY_FAILED','OWNED_KANZO_VERIFY_FAILED',
                       'PARENT_PROXY_CONFIGURATION_DRIFT','releaseReady=$false'):
            self.assertIn(marker,S)
    def test_not_an_mutation_mode(self):
        self.assertIn("'VerifyInstalled'",S)
        assert_mode=S[S.index('$mutates ='):S.index('if ($mutates -and')]
        self.assertNotIn("'VerifyInstalled'",assert_mode)
if __name__=='__main__':unittest.main()
