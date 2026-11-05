import json
import os
import tempfile
import unittest
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import patch
from native_cpu import sample_cpu

class CpuNativeTests(unittest.TestCase):
    def test_never_uses_untrusted_binary_or_unc(self):
        self.assertFalse(sample_cpu(123, executable='script.ps1')['available'])
        self.assertFalse(sample_cpu(123, executable=r'\\server\tool\singularity-desktop-bridge.exe')['available'])
        self.assertFalse(sample_cpu('12', executable='/tmp/singularity-desktop-bridge.exe')['available'])

    def test_returns_only_verified_rust_win32_readings(self):
        with tempfile.TemporaryDirectory() as d:
            exe=Path(d)/'singularity-desktop-bridge.exe'
            exe.write_bytes(b'not launched')
            seen=[]
            def runner(args,**kwargs):
                seen.append((args,kwargs))
                return SimpleNamespace(returncode=0,stdout=json.dumps({
                    'available':True,'source':'win32-system-process-times','pid':29,
                    'system_cpu_pct':38.2,'process_cpu_pct':2.3, 'process_per_core_pct':18.4, 'logical_cores':8,
                    'process_created_filetime':133812345678900000}).encode())
            result=sample_cpu(29,executable=str(exe),runner=runner)
            self.assertEqual(result['system_cpu_pct'],38.2)
            self.assertEqual(result['cpu_pct'],18.4)
            self.assertEqual(result['host_pct'],2.3)
            self.assertEqual(result['cores'],8)
            self.assertEqual(result['process_created_filetime'],133812345678900000)
            self.assertFalse(seen[0][1]['shell'])
            self.assertEqual(seen[0][0][-2:],['--pid','29'])

    def test_process_identity_missing_or_pid_recycled_is_not_a_valid_cpu_sample(self):
        with tempfile.TemporaryDirectory() as d:
            exe=Path(d)/'singularity-desktop-bridge.exe';exe.write_bytes(b'x')
            response={'available':True,'source':'win32-system-process-times','pid':123,
                      'system_cpu_pct':40,'logical_cores':8,'process_cpu_pct':3,
                      'process_per_core_pct':24}
            result=sample_cpu(123,executable=str(exe),runner=lambda *a,**k:SimpleNamespace(returncode=0,stdout=json.dumps(response).encode()))
            self.assertFalse(result['available'])

    def test_no_fake_zero_on_bad_response(self):
        with tempfile.TemporaryDirectory() as d:
            exe=Path(d)/'singularity-desktop-bridge.exe';exe.write_bytes(b'x')
            for bad in ({'available':True,'source':'wrong','system_cpu_pct':0,'pid':123,'logical_cores':8},
                        {'available':True,'source':'win32-system-process-times','system_cpu_pct':500,'pid':123,'logical_cores':8},
                        {'available':True,'source':'win32-system-process-times','system_cpu_pct':50,'pid':99,'logical_cores':8}):
                with self.subTest(bad=bad):
                    result=sample_cpu(123,executable=str(exe),runner=lambda *a,**k:SimpleNamespace(returncode=0,stdout=json.dumps(bad).encode()))
                    self.assertFalse(result['available'])

if __name__=='__main__':unittest.main()
