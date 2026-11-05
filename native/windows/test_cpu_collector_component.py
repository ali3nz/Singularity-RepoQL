"""Validate generated Rust supervisor CPU collector config without running Windows."""
import importlib.util
import json
import subprocess
import sys
from pathlib import Path
import unittest

FILE = Path(__file__).with_name('build_cpu_collector_component.py')
spec = importlib.util.spec_from_file_location('cpu_supervisor_component', FILE)
module = importlib.util.module_from_spec(spec)
spec.loader.exec_module(module)

VALID = dict(variant=3, python_exe=r'C:\Python312\python.exe',
             dashboard_dir=r'C:\Users\Example\AppData\Local\Singularity\current\source\dashboard',
             dashboard_config=r'C:\Users\Example\AppData\Local\Singularity\config\dashboard.json',
             bridge_exe=r'C:\Users\Example\AppData\Local\Singularity\current\bin\singularity-desktop-bridge.exe',
             repoql_exe=r'C:\Program Files\RepoQL\rql.exe')

class CpuSupervisorComponentTests(unittest.TestCase):
    def test_four_profiles_configure_matching_native_variant(self):
        for n in (1, 2, 3, 4):
            with self.subTest(option=n):
                c = module.make_component(**{**VALID, 'variant':n})
                self.assertEqual(c['id'], 'windows-cpu-history')
                self.assertEqual(c['env']['SINGULARITY_INSTALL_VARIANT'],str(n))
                self.assertEqual(c['env']['SINGULARITY_WINDOWS_NATIVE'],'1')
                self.assertEqual(c['args'][:3], ['-E','-s','-B'])
                self.assertEqual(c['args'][-2], '--config')
                self.assertTrue(c['args'][3].endswith('\\native_cpu_history.py'))
                self.assertIsNone(c['health'])
                self.assertEqual(set(c), {'id','executable','args','workingDir','env','health'})
                self.assertNotIn('password', json.dumps(c).lower())
                self.assertNotIn('token', json.dumps(c).lower())
    def test_rejects_remote_device_and_unsafe_paths(self):
        bad = [r'\\server\share\python.exe',r'\\?\C:\Python\python.exe',
               r'C:Python\python.exe',r'.\python.exe',r'C:\x\..\python.exe',
               'C:\\x\\foo:bar\\python.exe',r'C:\CON\python.exe',
               'C:\\foo.\\python.exe',r'C:\foo\\python.exe',
               r'C:\Python\python.exe ',r'C:\Python\python.exe:evil',
               r'D:\Python\powershell.exe']
        for path in bad:
            with self.subTest(path=path),self.assertRaises(ValueError):
                module.make_component(**{**VALID,'python_exe':path})
    def test_rejects_wrong_binary_or_variant(self):
        for variant in (0, 5, True, '3'):
            with self.subTest(variant=variant),self.assertRaises(ValueError):
                module.make_component(**{**VALID, 'variant':variant})
        for field, path in [('bridge_exe',r'C:\Bin\evil.exe'),
                            ('repoql_exe',r'C:\Bin\docker.exe')]:
            with self.subTest(field=field),self.assertRaises(ValueError):
                module.make_component(**{**VALID,field:path})
    def test_interpreter_flags_import_real_collector(self):
        # -I / -P would exclude the collector script directory and break
        # imports such as `from native_cpu import sample_cpu` at startup.
        script = FILE.parents[2] / 'dashboard' / 'native_cpu_history.py'
        p = subprocess.run([sys.executable, '-E', '-s', '-B', str(script), '--help'],
                           text=True, capture_output=True, timeout=5)
        self.assertEqual(p.returncode, 0, p.stderr)
        self.assertIn('--config', p.stdout)

    def test_cli_is_read_only_json(self):
        args = []
        for k,v in VALID.items():
            args.extend(['--'+k.replace('_','-'), str(v)])
        p = subprocess.run([sys.executable,str(FILE),*args],text=True,capture_output=True,timeout=5)
        self.assertEqual(p.returncode,0,p.stderr)
        payload=json.loads(p.stdout)
        self.assertFalse(payload['releaseReady'])
        self.assertTrue(payload['requiresNativeWindowsPreflight'])
        self.assertEqual(payload['supervisorComponent']['id'],'windows-cpu-history')

if __name__=='__main__':unittest.main()
