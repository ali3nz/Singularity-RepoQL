"""Small, source-only Uninstall Plan contract checks; no PowerShell execution."""
import unittest
from pathlib import Path

ROOT=Path(__file__).parent
class UninstallSourceTests(unittest.TestCase):
 @classmethod
 def setUpClass(cls):cls.text=(ROOT/'uninstall_claude_complete.ps1').read_text('utf8')
 def test_preview_is_default_and_uninstall_requires_apply(self):
  self.assertIn("[string]$Mode = 'Plan'",self.text)
  self.assertIn('EXPLICIT_UNINSTALL_APPLY_REQUIRED',self.text)
  self.assertIn('PLAN_REFUSES_APPLY',self.text)
 def test_only_owned_lifecycle_steps_used(self):
  for phrase in ('-Mode RemoveSupervisor','-Mode RollbackConfig','-Mode RetireStage','Get-ScheduledTask'):
   self.assertIn(phrase,self.text)
  self.assertLess(self.text.index('-Mode RemoveSupervisor'),self.text.index('-Mode RollbackConfig'))
  self.assertLess(self.text.index('-Mode RollbackConfig'),self.text.index('-Mode RetireStage'))
 def test_no_destructive_clear_or_unsafe_elevation(self):
  for phrase in ('Remove-Item ','Clear-Content','Stop-Process','RunAs','Unregister-ScheduledTask','Invoke-Expression','Start-Process'):
   self.assertNotIn(phrase,self.text)
 def test_blocks_reparse_and_uses_user_local_root(self):
  for phrase in ('REPARSE_PATH_REFUSED','LOCALAPPDATA_REQUIRED','INSTALL_ROOT_OUTSIDE_PRIVATE_LOCALAPPDATA'):
   self.assertIn(phrase,self.text)
 def test_upgrade_or_retire_collision_checked_before_mutating(self):
  self.assertIn('UPGRADE_SNAPSHOT_REQUIRES_EXPLICIT_ROLLBACK_PLAN',self.text)
  self.assertIn('RETIRED_SNAPSHOT_COLLISION_REFUSED',self.text)
  self.assertLess(self.text.index('UPGRADE_SNAPSHOT_REQUIRES_EXPLICIT_ROLLBACK_PLAN'),self.text.index('-Mode RemoveSupervisor'))
 def test_parent_proxy_is_rolled_back_before_base_claude_config(self):
  self.assertIn('-Mode RollbackParent',self.text)
  self.assertLess(self.text.index('-Mode RollbackParent'),self.text.index('-Mode RollbackConfig'))
 def test_scheduler_error_is_not_task_absence(self):
  self.assertIn('Get-ScheduledTask -ErrorAction Stop',self.text)
  self.assertNotIn('Get-ScheduledTask -TaskName',self.text)
  self.assertNotIn('SilentlyContinue',self.text)
  self.assertIn('SUPERVISOR_SCHEDULER_UNAVAILABLE_REFUSE_MUTATION',self.text)
  self.assertIn('AMBIGUOUS_SUPERVISOR_TASK_REFUSED',self.text)
  self.assertIn('supervisorTaskState=$taskState',self.text)
  self.assertIn("if ($Mode -eq 'Uninstall') { throw }",self.text)
 def test_current_stage_without_receipt_blocks_mutation(self):
  self.assertIn('UNRECOGNIZED_CURRENT_STAGE_REFUSED',self.text)
  self.assertIn('unknownCurrentStagePresent=($stageDirectoryPresent -and -not $hasStage)',self.text)
  self.assertLess(self.text.index('UNRECOGNIZED_CURRENT_STAGE_REFUSED'),self.text.index('-Mode RemoveSupervisor'))
 def test_post_removal_check_reads_scheduler_fail_closed(self):
  self.assertIn('if (@(Get-SupervisorTaskCandidates).Count -ne 0)',self.text)
  self.assertNotIn('-ErrorAction SilentlyContinue',self.text)
 def test_never_claims_runtime_release(self):
  self.assertIn('releaseReady=$false',self.text)
  self.assertIn('runtimeAccepted=$false',self.text)
if __name__=='__main__':unittest.main()
