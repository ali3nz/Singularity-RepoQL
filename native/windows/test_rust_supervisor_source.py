"""Source-only gating for native supervisor, *not* Rust compile evidence."""
from pathlib import Path
import unittest

ROOT = Path(__file__).resolve().parents[2]
LIB = (ROOT/'native/windows/rust-supervisor/src/lib.rs').read_text()
MAIN = (ROOT/'native/windows/rust-supervisor/src/main.rs').read_text()
TASK = (ROOT/'native/windows/register-supervisor-task.ps1').read_text()
WORKFLOW = (ROOT/'.github/workflows/native-desktop-rust.yml').read_text()
STAGING = (ROOT/'native/windows/stage-native.ps1').read_text()
PREFLIGHT = (ROOT/'native/windows/preflight.ps1').read_text()

class RustSupervisorSourceTests(unittest.TestCase):
    def test_job_ownership_and_cleanup(self):
        for token in ('CreateJobObjectW','SetInformationJobObject','JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE',
                      'AssignProcessToJobObject', 'drop(job)', 'child.kill()', 'child.wait()'):
            self.assertIn(token,LIB)
        self.assertNotIn('taskkill',LIB.lower())
        self.assertNotIn('std::process::Command::new("cmd")',LIB)
    def test_denies_lean_option_extensions_and_bad_repoql(self):
        for token in ('1.7.18','Office/Ghost forbidden in lean options','invalid component id',
                      'duplicate component id', 'credentials must come from an ACL-protected file'):
            self.assertIn(token,LIB)
    def test_no_wsl_and_no_unattended_tasks(self):
        self.assertIn('ShouldProcess',TASK)
        self.assertIn('if ($Apply -and $PSCmdlet.ShouldProcess',TASK)
        self.assertIn('FOREIGN_OR_CHANGED_TASK_REFUSED',TASK)
        self.assertIn('TASK_RUNNING_STOP_ONLY_WITH_MANUAL_OWNER_VERIFICATION',TASK)
        self.assertIn('Register-ScheduledTask',TASK)
        self.assertIn('Unregister-ScheduledTask',TASK)
        self.assertNotIn('wsl.exe',TASK.lower())
        self.assertNotIn('net user ',TASK.lower())
    def test_staging_and_preflight_have_distinct_unverified_supervisor_fields(self):
        for token in ('$SupervisorExe', 'singularity-windows-supervisor.exe', 'supervisorSha256'):
            self.assertIn(token, STAGING)
        self.assertIn('rust_supervisor = Test-ExplicitFile $SupervisorExe', PREFLIGHT)
        self.assertIn('rust_job_object_runtime_verified = $false', PREFLIGHT)
        self.assertIn('task_registration_verified = $false', PREFLIGHT)
        self.assertIn('REPOQL_PROBE_TIMEOUT', STAGING)
        self.assertIn('WaitForExit(10000)', STAGING)
        self.assertIn('Sort-Object -Unique', STAGING)
    def test_windows_job_owner_has_runtime_ci_test(self):
        self.assertIn('job_object_terminates_owned_child_on_close',LIB)
        self.assertIn('suspended_child_cannot_execute_before_job_assignment',LIB)
        self.assertIn('CREATE_SUSPENDED',LIB)
        self.assertIn('const CREATE_NO_WINDOW: u32 = 0x08000000;',LIB)
        self.assertIn('command.creation_flags(CREATE_SUSPENDED | CREATE_NO_WINDOW);',LIB)
        self.assertIn('spawn_contained(&mut cmd)',LIB)
        self.assertIn('ResumeThread(thread.0)',LIB)
        self.assertNotIn('let mut child = cmd.spawn()',LIB)
        self.assertIn('if ids.len() > 1',LIB)
        self.assertIn('previous_count != 1',LIB)
    def test_cli_never_has_implicit_run(self):
        self.assertIn('Some("check" | "run")',MAIN)
        self.assertIn('if mode.as_deref() == Some("check")',MAIN)
        self.assertIn('runtimeTested',MAIN)
    def test_ci_has_real_compile_gate(self):
        for token in ('rust-windows-supervisor-platform-gate','cargo fmt --manifest-path native/windows/rust-supervisor/Cargo.toml',
                      'cargo test --manifest-path native/windows/rust-supervisor/Cargo.toml',
                      'cargo build --release --manifest-path native/windows/rust-supervisor/Cargo.toml'):
            self.assertIn(token,WORKFLOW)

if __name__ == '__main__':
    unittest.main()
