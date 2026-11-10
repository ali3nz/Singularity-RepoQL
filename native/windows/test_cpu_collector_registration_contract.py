"""Protect the installed CPU collector task's native bridge environment."""
from pathlib import Path
import unittest


SCRIPT = Path(__file__).with_name('register_cpu_collector.ps1')


class CpuCollectorRegistrationContractTests(unittest.TestCase):
    def test_wrapper_uses_owned_current_install_bridge(self):
        source = SCRIPT.read_text(encoding='utf-8')
        self.assertIn(
            r"$bridge = Join-Path $cur 'bin\singularity-desktop-bridge.exe'",
            source,
        )
        self.assertIn(
            '"set SINGULARITY_NATIVE_BRIDGE_EXE=$bridge",',
            source,
        )


if __name__ == '__main__':
    unittest.main()
