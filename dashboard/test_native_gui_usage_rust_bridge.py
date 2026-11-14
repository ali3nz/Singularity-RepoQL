"""Rust GUI receipt projection boundary without assuming a compiled Rust binary."""
from unittest.mock import patch
import json
import os
from pathlib import Path
import subprocess
import tempfile
import unittest
from native_gui_usage import _public_native_payload, _project_python, project
from variant_features import features

PROFILE = features(2, native_windows=True)
PAYLOAD = {
    'available': True, 'credential': 'PRIVATE', 'allowance': {'secret': 'PRIVATE'},
    'sources': [{'id': 'freebuff', 'events': 900, 'private': 'PRIVATE'},
                {'id': 'claude-desktop-code', 'events': 2, 'status': 'ok', 'private': 'PRIVATE'}],
    'recent': [{'source': 'freebuff', 'token': 'PRIVATE', 'input_tokens': 999},
               {'source': 'claude-desktop-code', 'token': 'PRIVATE', 'timestamp': '2026-11-13T01:00:00Z',
                'model': 'sonnet', 'input_tokens': 10, 'output_tokens': 7}],
    'collected_at': '2026-11-13T01:01:00Z',
}


class NativeGuiRustBoundary(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.binary = Path(self.temp.name) / 'gui-receipts.exe'
        self.binary.write_bytes(b'fixture-only')
        self.reference = _project_python(PAYLOAD, profile=PROFILE)

    def _binary(self, response, returncode=0):
        def call(argv, **kwargs):
            self.assertEqual(argv, [str(self.binary)])
            self.assertEqual(kwargs['encoding'], 'utf-8')
            self.assertFalse(kwargs['shell'])
            self.assertEqual(kwargs['timeout'], 10)
            request = json.loads(kwargs['input'])
            self.assertEqual(request['gui'], 'claude-desktop-code')
            self.assertEqual(request['payload'], _public_native_payload(PAYLOAD))
            self.assertNotIn('PRIVATE', kwargs['input'])
            self.assertNotIn('freebuff', kwargs['input'])
            return subprocess.CompletedProcess(argv, returncode, response, '')
        return call

    def test_default_python_stays_authoritative(self):
        with patch.dict(os.environ, {'SINGULARITY_NATIVE_GUI_USAGE_RUST_BINARY': ''}):
            self.assertEqual(project(PAYLOAD, profile=PROFILE), self.reference)

    def test_allowlist_keeps_only_installed_gui(self):
        safe = _public_native_payload(PAYLOAD)
        self.assertNotIn('credential', safe)
        self.assertNotIn('allowance', safe)
        self.assertEqual(len(safe['recent']), 1)
        self.assertEqual(_project_python(safe, profile=PROFILE), self.reference)

    def test_exact_native_parity_accepted(self):
        with patch.dict(os.environ, {'SINGULARITY_NATIVE_GUI_USAGE_RUST_BINARY': str(self.binary)}), \
             patch('native_gui_usage.subprocess.run', side_effect=self._binary(json.dumps(self.reference))):
            self.assertEqual(project(PAYLOAD, profile=PROFILE), self.reference)

    def test_fake_receipt_or_allowance_rejected(self):
        fraudulent = dict(self.reference, allowance={'remaining': 100})
        with patch.dict(os.environ, {'SINGULARITY_NATIVE_GUI_USAGE_RUST_BINARY': str(self.binary)}), \
             patch('native_gui_usage.subprocess.run', side_effect=self._binary(json.dumps(fraudulent))):
            with self.assertRaisesRegex(RuntimeError, 'native_gui_usage_rust_mismatch'):
                project(PAYLOAD, profile=PROFILE)

    def test_failed_binary_rejected(self):
        with patch.dict(os.environ, {'SINGULARITY_NATIVE_GUI_USAGE_RUST_BINARY': str(self.binary)}), \
             patch('native_gui_usage.subprocess.run', side_effect=self._binary('', returncode=2)):
            with self.assertRaisesRegex(RuntimeError, 'native_gui_usage_rust_execution_failed'):
                project(PAYLOAD, profile=PROFILE)

    def test_invalid_output_rejected(self):
        with patch.dict(os.environ, {'SINGULARITY_NATIVE_GUI_USAGE_RUST_BINARY': str(self.binary)}), \
             patch('native_gui_usage.subprocess.run', side_effect=self._binary('not JSON')):
            with self.assertRaisesRegex(RuntimeError, 'native_gui_usage_rust_invalid_json'):
                project(PAYLOAD, profile=PROFILE)

    def test_missing_native_binary_rejected(self):
        with patch.dict(os.environ, {'SINGULARITY_NATIVE_GUI_USAGE_RUST_BINARY': str(self.binary.parent / 'missing.exe')}):
            with self.assertRaisesRegex(RuntimeError, 'native_gui_usage_rust_binary_invalid'):
                project(PAYLOAD, profile=PROFILE)


if __name__ == '__main__':
    unittest.main()
