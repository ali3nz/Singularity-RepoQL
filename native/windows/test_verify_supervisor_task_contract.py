from pathlib import Path
import unittest
P=Path(__file__).with_name('verify_supervisor_task.ps1').read_text('utf8')
INSTALL=Path(__file__).with_name('install_claude_complete.ps1').read_text('utf8')
BUILDER=Path(__file__).with_name('build_supervisor_config.py').read_text('utf8')
class TaskReadbackContract(unittest.TestCase):
    def test_read_only_and_no_publisher_claim(self):
        self.assertIn('registeredOwnedAndConfigured',P)
        self.assertIn('rebootRecoveryVerified=$false',P)
        self.assertNotIn('Register-ScheduledTask',P)
        self.assertNotIn('Unregister-ScheduledTask',P)
        self.assertNotIn('Start-ScheduledTask',P)
    def test_checks_exact_owned_task_fields(self):
        for p in ('MSFT_TaskLogonTrigger','RunLevel','Principal.UserId','TaskName','TASK_REPARSE_PATH_REFUSED','OWNED_FILE_MISSING'):
            self.assertIn(p,P)
    def test_wrapper_keeps_verification_separate_from_registration(self):
        self.assertIn("'SupervisorVerify'",INSTALL)
        self.assertIn('Assert-OwnedStagingSnapshot $current',INSTALL)
        self.assertIn('SUPERVISOR_TASK_NOT_VERIFIED',INSTALL)
    def test_no_runtime_release_claims(self):
        self.assertIn('processHealthVerified=$false',P)
        self.assertIn('releaseReady=$false',P)
    def test_matches_registered_windowless_and_owned_legacy_actions(self):
        self.assertIn("$runtimeExe=Assert-PrivatePath",P)
        self.assertIn("'singularity-windows-supervisorw.exe'",P)
        self.assertIn('$actions[0].Execute -ieq $runtimeExe -or $actions[0].Execute -ieq $exe',P)
        self.assertIn('[IO.File]::Exists($runtimeExe)',P)
    def test_new_supervisor_stack_never_emits_ghost(self):
        self.assertNotIn('components.append(component("ghost"',BUILDER)
        self.assertNotIn('--ghost-control-config',BUILDER)
if __name__=='__main__':unittest.main()
