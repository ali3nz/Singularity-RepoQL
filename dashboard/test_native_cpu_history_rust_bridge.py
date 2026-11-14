"""Opt-in native CPU history projection boundaries, no Win32 or live services."""
import json
import os
from pathlib import Path
import subprocess
import tempfile
import unittest
from unittest.mock import patch

from native_cpu_history import _project_rows_python, _native_checked_rows

NOW = 1793253600
ARGS = {'period':'1h','window':3600,'bucket':60,'retention_days':30,
        'sample_interval_seconds':15}
ROWS = [(NOW-30, 35.5, 'ok'), (NOW-10, None, 'identity_mismatch'),
        (NOW, 45.5, 'ok')]


class WindowsCpuRustBridge(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.binary = Path(self.temp.name)/'singularity-native-cpu-history.exe'
        self.binary.write_bytes(b'fixture')
        self.expected = _project_rows_python(ROWS, **ARGS)

    def checked(self, rows=ROWS):
        return _native_checked_rows(rows, now=NOW, expected=self.expected, **ARGS)

    def test_python_default_and_verified_rust_opt_in(self):
        with patch.dict(os.environ, {'SINGULARITY_NATIVE_CPU_HISTORY_RUST_BINARY':''}):
            self.assertEqual(self.checked(), self.expected)
        with patch.dict(os.environ, {'SINGULARITY_NATIVE_CPU_HISTORY_RUST_BINARY':str(self.binary)}), \
             patch('native_cpu_history.subprocess.run') as run:
            run.return_value = subprocess.CompletedProcess([], 0, json.dumps(self.expected), '')
            self.assertEqual(self.checked(), self.expected)
            kwargs = run.call_args.kwargs
            self.assertFalse(kwargs['shell'])
            self.assertEqual(kwargs['timeout'], 10)
            request = json.loads(kwargs['input'])
            self.assertEqual(set(request), {'period','now','window','bucket','retention_days',
                                            'sample_interval_seconds','rows'})
            self.assertNotIn('pid', kwargs['input'])
            self.assertNotIn('path', kwargs['input'])
            self.assertNotIn('token', kwargs['input'])
            self.assertEqual(request['rows'][0][1], 35.5)

    def test_rejects_invalid_binary_and_symlinks(self):
        for invalid in ('relative.exe', str(self.binary.parent/'missing.exe')):
            with self.subTest(invalid=invalid), \
                 patch.dict(os.environ, {'SINGULARITY_NATIVE_CPU_HISTORY_RUST_BINARY':invalid}):
                with self.assertRaisesRegex(RuntimeError,'native_cpu_history_rust_binary_invalid'):
                    self.checked()
        link = Path(self.temp.name)/'alias.exe'
        try:
            link.symlink_to(self.binary)
        except (OSError, NotImplementedError):
            return
        with patch.dict(os.environ, {'SINGULARITY_NATIVE_CPU_HISTORY_RUST_BINARY':str(link)}):
            with self.assertRaisesRegex(RuntimeError,'native_cpu_history_rust_binary_invalid'):
                self.checked()

    def test_forged_output_and_failed_process_rejected(self):
        forged = dict(self.expected, available=False)
        for response, code in ((json.dumps(forged),0), ('not-json',0), ('',1)):
            with self.subTest(code=code, response=response), \
                 patch.dict(os.environ, {'SINGULARITY_NATIVE_CPU_HISTORY_RUST_BINARY':str(self.binary)}), \
                 patch('native_cpu_history.subprocess.run',
                       return_value=subprocess.CompletedProcess([],code,response,'')):
                with self.assertRaises(RuntimeError):
                    self.checked()

    def test_oversized_and_nonfinite_input_rejected(self):
        with patch.dict(os.environ, {'SINGULARITY_NATIVE_CPU_HISTORY_RUST_BINARY':str(self.binary)}):
            with self.assertRaisesRegex(RuntimeError, 'native_cpu_history_rust_input_too_large'):
                self.checked(rows=[ROWS[0]] * 20001)
            with self.assertRaisesRegex(RuntimeError, 'native_cpu_history_rust_invalid_input'):
                self.checked(rows=[(NOW, float('nan'), 'ok')])


if __name__ == '__main__':
    unittest.main()
