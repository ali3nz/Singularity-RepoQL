"""Native Windows telemetry must not turn Linux systemd details into false status."""
import tempfile
import unittest
from pathlib import Path
from types import SimpleNamespace
from harness_telemetry import Harness, default_telemetry_state_dir

class NativeTelemetryTests(unittest.TestCase):
    def test_windows_state_root_matches_dashboard(self):
        root=default_telemetry_state_dir(platform='nt', env={'LOCALAPPDATA':'C:/Users/test/AppData/Local'},home='C:/Users/test')
        self.assertEqual(str(root).replace('\\','/'), 'C:/Users/test/AppData/Local/Singularity/Dashboard')
        override=default_telemetry_state_dir(platform='nt', env={'SINGULARITY_STATE_DIR':'D:/State'})
        self.assertEqual(str(override),'D:/State')
    def test_windows_nannies_do_not_claim_linux_units_or_alive_service(self):
        with tempfile.TemporaryDirectory() as d:
            h=Harness(d)
            try:
                r=h.nannies(platform='nt',task_probe=lambda:SimpleNamespace(returncode=0,stdout='registered'))
                self.assertEqual(len(r['nannies']),1)
                row=r['nannies'][0]
                self.assertEqual(row['configured'],'registered-unverified')
                self.assertEqual(row['effective'],'unverified')
                self.assertEqual(row['source'],'windows:TaskScheduler')
                self.assertNotIn('systemd',str(r['nannies']).lower())
                r=h.nannies(platform='nt',task_probe=lambda:SimpleNamespace(returncode=1,stdout=''))
                self.assertEqual(r['nannies'][0]['configured'],'unverified')
            finally:
                h.close()
    def test_missing_scheduler_never_triggers_linux_fallback(self):
        with tempfile.TemporaryDirectory() as d:
            h=Harness(d)
            def failure():raise OSError('Task Scheduler absent')
            try:
                r=h.nannies(platform='nt',task_probe=failure)
                self.assertEqual(r['nannies'][0]['effective'],'unverified')
            finally:h.close()

if __name__=='__main__': unittest.main()
