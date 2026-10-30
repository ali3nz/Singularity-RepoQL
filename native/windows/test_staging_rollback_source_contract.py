"""Structural source checks only. PowerShell and native rollback not executed."""
import pathlib
import unittest
ROOT=pathlib.Path(__file__).parent
class StageRollbackSourceContract(unittest.TestCase):
 def test_generic_stager_checks_manifest_and_hashes_before_move(self):
  s=(ROOT/'stage-native.ps1').read_text()
  boundary=s.index("Move-Item -LiteralPath $previous -Destination $current")
  for x in ['Assert-Manifest $previousSource','ROLLBACK_BRIDGE_HASH_MISMATCH','ROLLBACK_SUPERVISOR_HASH_MISMATCH','Assert-PortableExecutable $previousBridge']:
   self.assertIn(x,s[:boundary])
 def test_stage_snapshot_is_verified_before_option2_rollback(self):
  s=(ROOT/'install_claude_complete.ps1').read_text()
  start=s.index("if ($Mode -eq 'RollbackStage')")
  boundary=s.index("& $stager -InstallRoot $InstallRoot -Rollback",start)
  self.assertIn("Assert-OwnedStagingSnapshot (Join-Path $InstallRoot 'previous')",s[start:boundary])
 def test_invalid_or_extra_supervisor_refused(self):
  s=(ROOT/'stage-native.ps1').read_text()
  self.assertIn('ROLLBACK_UNRECORDED_SUPERVISOR_REFUSED',s)
  self.assertIn('ROLLBACK_SUPERVISOR_HASH_INVALID',s)
 def test_rollback_does_not_delete_failed_snapshot(self):
  s=(ROOT/'stage-native.ps1').read_text()
  start=s.index('if ($Rollback) {')
  end=s.index('Assert-LocalExistingFile $BridgeExe',start)
  self.assertNotIn('Remove-Item',s[start:end])
if __name__=='__main__':unittest.main()
