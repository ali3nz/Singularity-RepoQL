import tempfile
import unittest
from pathlib import Path
from build_source_variants import build
from claude_complete_release_audit import inspect, AGENTS

class ClaudeCompleteReleaseAuditTests(unittest.TestCase):
    def test_option2_source_is_complete_as_code_but_not_installable(self):
        with tempfile.TemporaryDirectory() as d:
            path=Path(d)/'option2.zip'
            build(2,path)
            r=inspect(path)
            self.assertTrue(r['sourceValid'],r)
            self.assertEqual(r['agentDefinitions'],9)
            self.assertEqual(r['skillDefinitions'],10)
            self.assertEqual(r['repoqlPluginSkillsExpected'],17)
            self.assertFalse(r['repoqlPluginCacheAndGuiVerified'])
            self.assertFalse(r['repoqlDocsIndexedVerified'])
            self.assertTrue(r['delegatedMemoryProfileToolBundled'])
            self.assertTrue(r['dualDocReadbackToolBundled'])
            self.assertTrue(r['windowsBuildCandidateAssemblerBundled'])
            self.assertTrue(r['windowsCandidatePreparationBundled'])
            self.assertTrue(r['windowsPreparedCandidateVerificationBundled'])
            self.assertTrue(r['windowsAcceptanceEvidenceMatrixBundled'])
            self.assertEqual(len(AGENTS),9)
            self.assertEqual(r['missingSourceAssets'],[])
            self.assertFalse(r['pinnedOfficeApplicationBundled'])
            self.assertFalse(r['nativeWindowsExecutableBundled'])
            self.assertFalse(r['releaseReady'])
            self.assertGreaterEqual(len(r['blockers']),7)
    def test_lean_profile_is_not_a_supported_installation(self):
        with tempfile.TemporaryDirectory() as d:
            path=Path(d)/'option1.zip'
            with self.assertRaisesRegex(ValueError,'only Claude Code Full'):
                build(1,path)
            self.assertFalse(path.exists())
if __name__=='__main__': unittest.main()
