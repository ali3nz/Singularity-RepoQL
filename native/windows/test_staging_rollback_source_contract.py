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
 def test_windowless_supervisor_is_verified_and_protected_before_stage_changes(self):
  s=(ROOT/'install_claude_complete.ps1').read_text()
  self.assertIn('STAGED_OPTIONAL_BINARY_HASH_DRIFT',s)
  stager=(ROOT/'stage-native.ps1').read_text()
  for name in ('singularity-windows-supervisorw.exe','singularity-dashboard-routes.exe','singularity-dashboard-listener.exe','singularity-doc-ledger-commit.exe','singularity-memorycore-writer.exe','singularity-windows-setup.exe'):
   self.assertIn("'bin/"+name+"'",s)
   self.assertIn("'bin/"+name+"'",stager)
  self.assertIn('OWNED_STAGE_ADDITIONAL_BINARY_DRIFT',s)
  self.assertIn('REMOVE_RUST_OPENMAUSBOT_TASK_BEFORE_STAGE_MUTATION',s)
  start=s.index("if ($Mode -eq 'RollbackStage')")
  boundary=s.index("& $stager -InstallRoot $InstallRoot -Rollback",start)
  self.assertIn('Assert-RustOpenMausTaskAbsent',s[start:boundary])
 def test_configuration_points_to_verified_staged_source(self):
  s=(ROOT/'install_claude_complete.ps1').read_text()
  body=s.split("if ($Mode -eq 'Configure' -or $Mode -eq 'Verify') {",1)[1]
  self.assertLess(body.index('Assert-StageMatchesPrepared'),body.index("'STAGED_SOURCE'"))
  self.assertLess(body.index("'STAGED_SOURCE'"),body.index("Invoke-Claude 'apply'"))
  self.assertIn('--rust-doc-writer-sha256',s)
 def test_pending_stage_uses_candidate_rust_verifier_before_promotion(self):
  s=(ROOT/'stage-native.ps1').read_text()
  start=s.index("  $verifierRow=@(")
  move=s.index('Move-Item -LiteralPath $staging -Destination $current',start)
  self.assertIn("& $verifierExe 'promote-pending' $targetRoot",s[start:move])
  self.assertIn('RUST_STAGING_PROMOTION_UNCONFIRMED',s[start:move])
  self.assertIn('singularity-source-packager.exe',s[start:move])
 def test_optional_recovery_tool_is_digest_pinned_and_external(self):
  s=(ROOT/'install_claude_complete.ps1').read_text()
  code=s.split('function Assert-RecoveryRustSnapshot',1)[1].split('function Assert-OwnedStagingSnapshot',1)[0]
  for marker in ('RECOVERY_RUST_VERIFIER_INSIDE_STAGE','RECOVERY_RUST_VERIFIER_HASH_DRIFT'):
   self.assertLess(code.index(marker),code.index("& $tool 'verify-snapshot' $Candidate"))
  self.assertIn('Assert-RecoveryRustSnapshot $dir',s)
  start=s.index("if ($Mode -eq 'RollbackStage')")
  move=s.index('& $stager -InstallRoot $InstallRoot -Rollback',start)
  self.assertIn('Assert-OwnedStagingSnapshot $outgoing',s[start:move])
  stage=(ROOT/'stage-native.ps1').read_text().split('$verifierRow=@(',1)[1]
  self.assertLess(stage.index("& $verifierExe 'promote-pending'"),
                  stage.index('Move-Item -LiteralPath $current -Destination $previous'))
  rust=(ROOT/'source-packager-rust/src/staged_tree.rs').read_text()
  self.assertLess(rust.index('snapshot_check(&current)'),rust.index('move_path(&current, &previous)'))
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
