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

    def test_nested_repoql_probe_has_no_console(self):
        probe = (ROOT / 'native/desktop-bridge/src/repoql_compat.rs').read_text()
        body = probe.split('fn bounded_probe(', 1)[1].split('let deadline', 1)[0]
        self.assertIn('command.creation_flags(0x08000000)', body)
        self.assertLess(body.index('creation_flags'), body.index('command.spawn()'))


if __name__ == '__main__':
    unittest.main()
