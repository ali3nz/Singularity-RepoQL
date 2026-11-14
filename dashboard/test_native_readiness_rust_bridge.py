"""Opt-in readiness Rust bridge safety with a fake executable boundary."""
from unittest.mock import patch
import json
import os
from pathlib import Path
import subprocess
import tempfile
import unittest

from native_readiness import PROBE_NAMES, _project_python, _native_checked, report
from variant_features import features


class ReadinessRustBridgeTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.binary = Path(self.temp.name) / 'native-readiness.exe'
        self.binary.write_bytes(b'fixture')
        self.profile = features(2, native_windows=True)
        self.receipts = {name: name != 'tencent_session' for name in PROBE_NAMES}
        self.expected = _project_python(self.profile, self.receipts)

    def fake_binary(self, stdout, returncode=0):
        def invoke(argv, **kwargs):
            self.assertEqual(argv, [str(self.binary)])
            self.assertEqual(kwargs['timeout'], 10)
            self.assertFalse(kwargs['shell'])
            self.assertEqual(kwargs['encoding'], 'utf-8')
            request = json.loads(kwargs['input'])
            self.assertEqual(request['variant'], 2)
            self.assertEqual(request['office'], True)
            self.assertEqual(request['probes'], self.receipts)
            self.assertEqual(set(request), {'variant', 'office', 'probes'})
            self.assertNotIn('private', kwargs['input'].lower())
            return subprocess.CompletedProcess(argv, returncode, stdout, '')
        return invoke

    def test_python_is_authoritative_by_default(self):
        with patch.dict(os.environ, {'SINGULARITY_NATIVE_READINESS_RUST_BINARY': ''}), \
             patch('native_readiness.subprocess.run') as run:
            self.assertEqual(_native_checked(self.profile, self.receipts, self.expected), self.expected)
            run.assert_not_called()

    def test_rust_exact_result_accepted(self):
        with patch.dict(os.environ, {'SINGULARITY_NATIVE_READINESS_RUST_BINARY': str(self.binary)}), \
             patch('native_readiness.subprocess.run', side_effect=self.fake_binary(json.dumps(self.expected))):
            self.assertEqual(_native_checked(self.profile, self.receipts, self.expected), self.expected)

    def test_rust_cannot_grant_release_approval(self):
        dishonest = dict(self.expected, release_ready=True)
        with patch.dict(os.environ, {'SINGULARITY_NATIVE_READINESS_RUST_BINARY': str(self.binary)}), \
             patch('native_readiness.subprocess.run', side_effect=self.fake_binary(json.dumps(dishonest))):
            with self.assertRaisesRegex(RuntimeError, 'native_readiness_rust_mismatch'):
                _native_checked(self.profile, self.receipts, self.expected)

    def test_rust_cannot_add_secret_or_overstate_checks(self):
        forged = json.loads(json.dumps(self.expected))
        forged['services']['tencent_session']['state'] = 'reachable'
        forged['services']['tencent_session']['verified'] = True
        forged['credential'] = 'private'
        with patch.dict(os.environ, {'SINGULARITY_NATIVE_READINESS_RUST_BINARY': str(self.binary)}), \
             patch('native_readiness.subprocess.run', side_effect=self.fake_binary(json.dumps(forged))):
            with self.assertRaisesRegex(RuntimeError, 'native_readiness_rust_mismatch'):
                _native_checked(self.profile, self.receipts, self.expected)

    def test_invalid_json_and_binary_failure_are_rejected(self):
        for stdout, exit_code, error in [('not JSON', 0, 'invalid_json'), ('', 2, 'execution_failed')]:
            with self.subTest(error=error), patch.dict(os.environ, {
                    'SINGULARITY_NATIVE_READINESS_RUST_BINARY': str(self.binary)}), \
                 patch('native_readiness.subprocess.run', side_effect=self.fake_binary(stdout, exit_code)):
                with self.assertRaisesRegex(RuntimeError, error):
                    _native_checked(self.profile, self.receipts, self.expected)

    def test_missing_and_symlinked_binary_rejected(self):
        with patch.dict(os.environ, {'SINGULARITY_NATIVE_READINESS_RUST_BINARY': str(self.binary.parent / 'missing.exe')}):
            with self.assertRaisesRegex(RuntimeError, 'binary_invalid'):
                _native_checked(self.profile, self.receipts, self.expected)
        link = self.binary.parent / 'link.exe'
        try:
            link.symlink_to(self.binary)
        except (OSError, NotImplementedError):
            self.skipTest('current platform does not permit symlinks')
        with patch.dict(os.environ, {'SINGULARITY_NATIVE_READINESS_RUST_BINARY': str(link)}):
            with self.assertRaisesRegex(RuntimeError, 'binary_invalid'):
                _native_checked(self.profile, self.receipts, self.expected)

    def test_report_probes_only_once_and_never_sends_exception_details(self):
        calls = []
        def make_probe(name):
            def execute():
                calls.append(name)
                if name == 'tencent_session':
                    raise RuntimeError('private-secret-and-host-path')
                return True
            return execute
        probes = {name: make_probe(name) for name in PROBE_NAMES}
        receipts = {name: name != 'tencent_session' for name in PROBE_NAMES}
        with patch.dict(os.environ, {'SINGULARITY_NATIVE_READINESS_RUST_BINARY': str(self.binary)}), \
             patch('native_readiness.subprocess.run', side_effect=self.fake_binary(json.dumps(self.expected))):
            got = report(None, profile=self.profile, probes=probes)
        self.assertEqual(got, _project_python(self.profile, receipts))
        self.assertEqual(len(calls), len(PROBE_NAMES))
        self.assertEqual(len(set(calls)), len(PROBE_NAMES))
        self.assertNotIn('private-secret', json.dumps(got))

    def test_excluded_office_never_executes_the_office_probe(self):
        profile = {'variant': 2, 'features': {'office': False}}
        def forbidden():
            raise AssertionError('Office must not be checked in excluded profile')
        probes = {name: (forbidden if name == 'claude_office_http' else lambda: True)
                  for name in PROBE_NAMES}
        with patch.dict(os.environ, {'SINGULARITY_NATIVE_READINESS_RUST_BINARY': ''}):
            result = report(None, profile=profile, probes=probes)
        self.assertEqual(result['services']['claude_office_http']['state'], 'excluded')
        self.assertEqual(result['services']['claude_office_event_delivery']['state'], 'excluded')
        self.assertFalse(result['release_ready'])


if __name__ == '__main__':
    unittest.main()
