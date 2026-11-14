"""Source-level transport tests; actual Rust parity still requires Cargo."""
import json
from pathlib import Path
import subprocess
import tempfile
import unittest
from unittest.mock import patch

from rust_readonly_bridge import run_checked, RustReadOnlyBridgeError
from memory_authority_preflight import inspect


class NativeEvidenceBridgeTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name)
        self.binary = self.root / 'policy.exe'
        self.binary.write_bytes(b'fixture only')

    def test_native_accepts_exact_readonly_reference(self):
        reference = {'ok': True, 'code': 'READY', 'checks': {}}
        with patch('rust_readonly_bridge.subprocess.run', return_value=subprocess.CompletedProcess([], 0, stdout=json.dumps(reference), stderr='')) as subprocess_run:
            self.assertEqual(run_checked(self.binary, ['preflight', '--root', str(self.root)], reference), reference)
            argv = subprocess_run.call_args.args[0]
            self.assertEqual(argv[:2], [str(self.binary), 'preflight'])
            self.assertFalse(subprocess_run.call_args.kwargs.get('shell', False))

    def test_valid_negative_check_uses_exit_two(self):
        reference = {'ok': False, 'code': 'UNVERIFIED', 'checks': {}}
        with patch('rust_readonly_bridge.subprocess.run', return_value=subprocess.CompletedProcess([], 2, stdout=json.dumps(reference), stderr='')):
            self.assertEqual(run_checked(self.binary, ['preflight'], reference), reference)

    def test_connector_success_uses_stdin_only(self):
        reference = {'bothConnectorsActive': True, 'releaseReady': False}
        inventory = {'available': True, 'connectors': [{'id': 'memorycore'}]}
        with patch('rust_readonly_bridge.subprocess.run', return_value=subprocess.CompletedProcess([], 0, stdout=json.dumps(reference), stderr='')) as execute:
            self.assertEqual(run_checked(self.binary, ['connector-evaluate-stdin'], reference, data=inventory), reference)
            self.assertNotIn('memorycore', str(execute.call_args.args[0]))
            self.assertIn('memorycore', execute.call_args.kwargs['input'])

    def test_connector_negative_exit_two(self):
        reference = {'bothConnectorsActive': False, 'releaseReady': False}
        with patch('rust_readonly_bridge.subprocess.run', return_value=subprocess.CompletedProcess([], 2, stdout=json.dumps(reference), stderr='')):
            self.assertEqual(run_checked(self.binary, ['connector-evaluate-stdin'], reference, data={}), reference)

    def test_rejects_mismatch_and_invalid_exit(self):
        reference = {'ok': True, 'checks': {}}
        for result in [
            subprocess.CompletedProcess([], 0, stdout='{"ok":true,"checks":{"forged":true}}', stderr=''),
            subprocess.CompletedProcess([], 2, stdout=json.dumps(reference), stderr=''),
            subprocess.CompletedProcess([], 0, stdout='not json', stderr=''),
            subprocess.CompletedProcess([], 4, stdout=json.dumps(reference), stderr=''),
        ]:
            with self.subTest(result=result):
                with patch('rust_readonly_bridge.subprocess.run', return_value=result):
                    with self.assertRaises(RustReadOnlyBridgeError):
                        run_checked(self.binary, [], reference)

    def test_refuses_relative_missing_symlink_and_big_input(self):
        for executable in [Path('relative.exe'), self.root/'does-not-exist.exe']:
            with self.assertRaises(RustReadOnlyBridgeError):
                run_checked(executable, [], {'ok': True})
        link = self.root/'indirect.exe'
        try:
            link.symlink_to(self.binary)
        except (OSError, NotImplementedError):
            pass
        else:
            with self.assertRaises(RustReadOnlyBridgeError):
                run_checked(link, [], {'ok': True})
        with self.assertRaisesRegex(RustReadOnlyBridgeError, 'RUST_INPUT_LIMIT'):
            run_checked(self.binary, [], {'ok': True}, data={'x': 'a'*300000})

    def test_restricted_environment_prevents_secret_inheritance(self):
        reference = {'ok': True, 'verdict': 'verified'}
        sandbox_env = {'PATH': '/usr/bin', 'SYSTEMROOT': r'C:\Windows'}
        with patch('rust_readonly_bridge.subprocess.run',
                   return_value=subprocess.CompletedProcess([], 0, stdout=json.dumps(reference), stderr='')) as run:
            self.assertEqual(run_checked(self.binary, [], reference, env=sandbox_env), reference)
            self.assertEqual(run.call_args.kwargs['env'], sandbox_env)
            self.assertNotIn('MEMORY_SECRETS', run.call_args.kwargs['env'])

    def test_timeout_refuses_instead_of_falling_back(self):
        with patch('rust_readonly_bridge.subprocess.run', side_effect=subprocess.TimeoutExpired('program', 1)):
            with self.assertRaisesRegex(RustReadOnlyBridgeError, 'RUST_EXECUTION_FAILED'):
                run_checked(self.binary, [], {'ok': True})

    def test_preflight_python_reference_stays_pure(self):
        config = self.root/'harness/kit/config.json'
        config.parent.mkdir(parents=True)
        config.write_text(json.dumps({'memoryProvenance': {'retrievalFilter': 'ENABLED'}}))
        self.assertEqual(inspect(self.root, {})['code'], 'WINDOWS_MEMORY_AUTHORITY_UNVERIFIED')


if __name__ == '__main__':
    unittest.main()
