from pathlib import Path
import unittest
P=Path(__file__).with_name('install_claude_complete.ps1').read_text('utf8')
class SchedulerMutations(unittest.TestCase):
    def test_scheduler_errors_never_mean_absent(self):
        self.assertIn('SUPERVISOR_SCHEDULER_UNAVAILABLE_REFUSE_MUTATION',P)
        self.assertIn('@(Get-ScheduledTask -ErrorAction Stop)',P)
        self.assertNotIn("Get-ScheduledTask -TaskName 'Singularity-Rust-Native-Supervisor' -ErrorAction SilentlyContinue",P)
    def test_stage_and_recovery_check_scheduler(self):
        self.assertIn('function Assert-NoLiveInstallReferences',P)
        self.assertIn('Assert-SupervisorTaskAbsent # REMOVE_SUPERVISOR_TASK_BEFORE_STAGE_ROLLBACK',P)
        self.assertIn('} else {\n      Assert-SupervisorTaskAbsent\n    }',P)
    def test_direct_config_rollback_refuses_active_task(self):
        i=P.index("if ($Mode -eq 'RollbackConfig')")
        self.assertIn('Assert-SupervisorTaskAbsent',P[i:i+100])
if __name__=='__main__':unittest.main()
