"""Regression contracts for bundled OpenMausBot and invisible child launches."""
from pathlib import Path
import unittest

ROOT = Path(__file__).resolve().parents[2]


class OpenMausBotLifecycle(unittest.TestCase):
    def test_pinned_payload_and_owned_task(self):
        source = (ROOT / 'native/windows/manage_openmausbot.ps1').read_text()
        for contract in ('OPENMAUSBOT_PAYLOAD_UNVERIFIED', 'OPENMAUSBOT_TASK_FOREIGN',
                         'OPENMAUSBOT_PORT_BUSY', 'OPENMAUSBOT_RECEIPT_DRIFT',
                         'OPENMAUSBOT_PROCESS_FOREIGN', 'OPENMAUSBOT_LISTENER_OWNERSHIP_FAILED',
                         '0.1.149', 'S4U', 'Assert-PortsFree', 'Assert-PlainPath'):
            self.assertIn(contract, source)
        self.assertNotIn('Remove-Item', source)

    def test_installer_carries_lifecycle_and_mcp(self):
        setup = (ROOT / 'native/windows/setup/Complete-Setup.ps1').read_text()
        for action in ('Install', 'Start', 'Verify', 'Unregister'):
            self.assertIn("Invoke-OpenMausBot '" + action + "'", setup)
        self.assertIn('--omb-cli $ombCli --omb-port 18211 --node-exe $nodeExe', setup)
        launcher = (ROOT / 'native/windows/start_openmausbot.mjs').read_text()
        self.assertIn('windowsHide: true', launcher)
        self.assertIn("'--local'", launcher)
        self.assertIn("'OMB_LAN'", launcher)

    def test_rust_launch_is_explicit_and_receipt_owned(self):
        manager = (ROOT / 'native/windows/manage_openmausbot.ps1').read_text()
        for contract in ('[switch]$UseRustSupervisor', 'OPENMAUSBOT_LAUNCH_MODE_CHANGE_REFUSED',
                         'OPENMAUSBOT_RUST_SUPERVISOR_NOT_STAGED', 'OPENMAUSBOT_SCHEDULER_UNAVAILABLE',
                         'OPENMAUSBOT_UNREGISTER_NOT_VERIFIED', 'GetOwnerSid'):
            self.assertIn(contract, manager)
        self.assertIn('else { $legacySchema }', manager)
        self.assertIn('[switch]$ChangeSupervisor', manager)
        self.assertIn('OPENMAUSBOT_CHANGE_REQUIRES_UNREGISTERED_OWNED_RECEIPT', manager)
        change = manager.split('} elseif ($ChangeSupervisor', 1)[1].split('if (-not $task)', 1)[0]
        self.assertIn('Assert-StagedRustSupervisor', change)
        self.assertLess(change.index('Assert-PortsFree'), change.index('Write-SupervisorReceipt'))
        self.assertIn('[IO.File]::Replace($tmp,$receiptPath,[NullString]::Value)', manager)
        self.assertNotIn('Remove-Item', change)
        stop = manager.split('Stop-ScheduledTask -TaskName', 1)[1].split('} elseif ($health', 1)[0]
        self.assertIn('Assert-PortsFree', stop)
        self.assertNotIn('Stop-Process', stop)

    def test_compiled_job_fixture_is_wired_without_a_vendor_service(self):
        base = ROOT / 'native/windows'
        launcher = (base / 'rust-supervisor/src/openmausbot.rs').read_text()
        binary = (base / 'rust-supervisor/src/bin/singularity_windows_supervisorw.rs').read_text()
        manifest = (base / 'rust-supervisor/Cargo.toml').read_text()
        fixture = (base / 'test_openmausbot_rust_job.ps1').read_text()
        workflow = (ROOT / '.github/workflows/native-desktop-rust.yml').read_text()
        for marker in ('run(Stack', 'OMB_WEBHOOK_PORT', '--no-pair', '--local', 'symlink_metadata'):
            self.assertIn(marker, launcher)
        self.assertIn('run_openmausbot(cfg)', binary)
        self.assertIn('name = "singularity-windows-supervisorw"', manifest)
        self.assertIn('test_openmausbot_rust_job.ps1 -SupervisorExe $exe', workflow)
        upgrade = (base / 'verify_rust_upgrade.ps1').read_text()
        native_only = upgrade.split('if (-not $Native) { return }', 1)[1]
        self.assertIn("'test_openmausbot_rust_job.ps1') -SupervisorExe", native_only)
        self.assertIn('$child.WaitForExit(5000)', fixture)
        self.assertIn('OPENMAUSBOT_BAD_RECEIPT_WAS_NOT_REFUSED', fixture)

    def test_rust_lease_check_keeps_os_ownership_requirements(self):
        manager = (ROOT / 'native/windows/manage_openmausbot.ps1').read_text()
        body = manager.split('function Assert-Process', 1)[1].split('function Assert-PortsFree', 1)[0]
        self.assertLess(body.index('Assert-StagedRustSupervisor'), body.index('openmausbot-verify-lease'))
        for marker in ('GetOwnerSid', 'Get-NetTCPConnection', 'OPENMAUSBOT_PROCESS_FOREIGN'):
            self.assertIn(marker, body)
        self.assertIn('OPENMAUSBOT_RUST_CONSOLE_NOT_STAGED', manager)
        self.assertIn('supervisorSha256', manager)

    def test_nested_repoql_probe_has_no_console(self):
        probe = (ROOT / 'native/desktop-bridge/src/repoql_compat.rs').read_text()
        body = probe.split('fn bounded_probe(', 1)[1].split('let deadline', 1)[0]
        self.assertIn('command.creation_flags(0x08000000)', body)
        self.assertLess(body.index('creation_flags'), body.index('command.spawn()'))


if __name__ == '__main__':
    unittest.main()
