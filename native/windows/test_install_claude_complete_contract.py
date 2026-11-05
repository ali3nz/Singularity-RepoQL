"""Fast structural checks for the Option 2 Windows-only orchestration.
Full PowerShell execution and transaction behavior require Windows CI.
"""
from pathlib import Path
import unittest

P = Path(__file__).with_name('install_claude_complete.ps1').read_text('utf-8')

class InstallFlowContract(unittest.TestCase):
    def test_no_implicit_mutation(self):
        self.assertIn("[string]$Mode = 'Plan'", P)
        self.assertIn('EXPLICIT_APPLY_REQUIRED', P)
        self.assertIn('READ_ONLY_MODE_REFUSES_APPLY', P)
        self.assertIn('ShouldProcess', P)
        self.assertNotIn('Invoke-Expression ', P)
        self.assertNotIn('Start-Process -Verb RunAs', P)

    def test_exact_option_two_and_verified_preparation(self):
        self.assertIn("'--bundle',$Bundle,'--prepared',$Prepared", P)
        self.assertIn('BOOTSTRAP_SOURCE_MISMATCH', P)
        self.assertIn('STAGED_SOURCE_HASH_DRIFT', P)
        self.assertIn('STAGED_BINARY_HASH_DRIFT', P)
        self.assertIn('CLAUDE_CONFIGURATION_UNVERIFIED', P)
        self.assertIn("Invoke-Mcp 'verify'", P)
        self.assertIn('Option=2', P)
        self.assertIn("'--variant','2'", P)

    def test_narrow_ownership_and_recovery(self):
        self.assertIn("'RollbackConfig'", P)
        self.assertIn("'RollbackStage'", P)
        self.assertIn('STAGED_UNVERIFIED', P)
        self.assertIn('ROLLBACK_CONFIGURATION_BEFORE_STAGE', P)
        self.assertIn('NO_OWNED_CONFIGURATION_RECEIPTS', P)
        self.assertIn("'--mode','rollback'", P)
        self.assertIn("'--rollback'", P)
        self.assertNotIn('Register-ScheduledTask', P)
        self.assertNotIn('Remove-Item -Recurse', P)

    def test_supervisor_registration_is_explicit_and_safe(self):
        for marker in ("'SupervisorPlan'", "'RegisterSupervisor'", "'RemoveSupervisor'",
                       'register-supervisor-task.ps1', 'SUPERVISOR_CONFIG',
                       'REMOVE_SUPERVISOR_TASK_BEFORE_STAGE_ROLLBACK',
                       '-Remove -Apply -Confirm:$false'):
            self.assertIn(marker, P)
        self.assertNotIn('Register-ScheduledTask', P)

    def test_first_staging_is_retired_not_deleted_and_restore_is_guarded(self):
        for marker in ("'RetireStage'", "'RestoreRetired'", 'held-retired',
                       'MOVE_CONFIGURATION_BEFORE_STAGE' if False else 'REMOVE_CONFIGURATION_BEFORE_STAGE_RETIRE_OR_RESTORE',
                       'REMOVE_SUPERVISOR_TASK_BEFORE_MUTATION',
                       'UNEXPECTED_STAGED_FILE_REFUSED', 'STAGED_FILE_INVENTORY_INCOMPLETE',
                       'USE_ROLLBACK_STAGE_FOR_UPGRADE_SNAPSHOT',
                       'Move-Item -LiteralPath $current -Destination $retired',
                       'Move-Item -LiteralPath $retired -Destination $current'):
            self.assertIn(marker, P)
        self.assertNotIn('Remove-Item -Recurse', P)

    def test_stage_upgrade_refuses_active_managed_references_before_promotion(self):
        self.assertIn("if (Test-Path -LiteralPath (Join-Path $InstallRoot 'current'))", P)
        self.assertIn('Assert-NoLiveInstallReferences', P)
        self.assertLess(P.index('Assert-NoLiveInstallReferences', P.index("if ($Mode -eq 'Stage')")),
                        P.index("& $StageScript @args -Apply"))
        self.assertIn('REMOVE_SUPERVISOR_TASK_BEFORE_MUTATION', P)

    def test_parent_proxy_requires_separate_explicit_consent_and_rolls_back_first(self):
        for marker in ("'ParentPlan'", "'ConfigureParent'", "'VerifyParent'", "'RollbackParent'",
                       'PARENT_PROXY_CONFIGURATOR','ROLLBACK_PARENT_PROXY_BEFORE_CLAUDE_CONFIGURATION'):
            self.assertIn(marker,P)
        self.assertIn('singularity-parent-memory-proxy-receipt.json',P)

    def test_upgrade_plan_reads_task_state_without_mutating(self):
        for marker in ("'UpgradePlan'", 'plan_option2_upgrade.py', 'UPGRADE_DEPENDENCY_PLAN_REFUSED',
                       "'--task-state'", 'Get-ScheduledTask -ErrorAction Stop'):
            self.assertIn(marker, P)
        self.assertIn("$taskState = 'UNKNOWN'", P)

    def test_release_not_certified(self):
        for marker in ('servicesRegistered=$false','officeRuntimeVerified=$false',
                       'ghostRuntimeVerified=$false','repoqlPluginSkillsVerified=$false',
                       'releaseReady=$false'):
            self.assertIn(marker, P)

if __name__=='__main__': unittest.main()
