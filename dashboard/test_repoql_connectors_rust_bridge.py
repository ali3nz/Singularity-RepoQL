"""Rust connector projection is opt-in and cannot certify invented connectors.

These boundary checks use mocked processes, not a compiled Rust binary.
The native differential is a separate, mandatory Windows acceptance gate.
"""
from datetime import datetime, timezone
import json
import os
from pathlib import Path
import subprocess
import tempfile
import unittest
from unittest.mock import patch

from repoql_connectors import _inventory_from_payload, _native_checked, _native_public_payload, connector_inventory

NOW = datetime(2026, 11, 12, 12, 0, tzinfo=timezone.utc)
PAYLOAD = {
    'schema': 'repoql.imports.status/v1',
    'connectors': [{'scheme': 'kanzo', 'title': 'Kanzo', 'state': 'installed', 'secret': 'PRIVATE'}],
    'imports': [{'kind': 'connector', 'scheme': 'kanzo', 'root': 'kanzo://',
                 'state': 'current', 'freshAsOf': NOW.isoformat(),
                 'sweepIntervalSeconds': 60, 'privateKey': 'PRIVATE'}],
}


class FakeCache:
    def __init__(self):
        self.values = {}

    def get(self, key):
        return self.values.get(key)

    def set(self, key, value, ttl):
        self.values[key] = value
        return value


class FakeRql:
    def __init__(self):
        self.cache = FakeCache()
        self.calls = []

    def run(self, args, *, timeout):
        self.calls.append((args, timeout))
        return subprocess.CompletedProcess(args, 0, json.dumps(PAYLOAD), '')


class RustConnectorBoundaryTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.binary = Path(self.temp.name) / 'rust-connector-projection.exe'
        self.binary.write_bytes(b'native-binary-fixture')
        self.reference = _inventory_from_payload(PAYLOAD, NOW)

    def _native(self, output, *, exit_code=0, payload=PAYLOAD):
        def run(argv, **kwargs):
            self.assertEqual(argv, [str(self.binary)])
            self.assertFalse(kwargs['shell'])
            self.assertEqual(kwargs['timeout'], 10)
            self.assertEqual(kwargs['encoding'], 'utf-8')
            request = json.loads(kwargs['input'])
            self.assertEqual(request['now'], NOW.isoformat())
            self.assertEqual(request['payload'], _native_public_payload(payload))
            self.assertNotIn('PRIVATE', json.dumps(request))
            return subprocess.CompletedProcess(argv, exit_code, output, '')
        return run

    def test_native_payload_allowlists_registry_and_import_metadata(self):
        safe = _native_public_payload(PAYLOAD)
        self.assertEqual(safe['connectors'][0]['scheme'], 'kanzo')
        self.assertNotIn('secret', safe['connectors'][0])
        self.assertNotIn('privateKey', safe['imports'][0])
        self.assertEqual(_inventory_from_payload(safe, NOW), self.reference)

    def test_python_default(self):
        with patch.dict(os.environ, {'SINGULARITY_REPOQL_CONNECTORS_RUST_BINARY': ''}):
            self.assertEqual(connector_inventory(FakeRql(), now=NOW), self.reference)

    def test_exact_native_parity_accepted(self):
        with patch.dict(os.environ, {'SINGULARITY_REPOQL_CONNECTORS_RUST_BINARY': str(self.binary)}), \
             patch('repoql_connectors.subprocess.run', side_effect=self._native(json.dumps(self.reference))):
            self.assertEqual(connector_inventory(FakeRql(), now=NOW), self.reference)
            self.assertNotIn('PRIVATE', json.dumps(self.reference))

    def test_native_cannot_forge_active_connector(self):
        fake = dict(self.reference, connectors=[{'id': 'other', 'active': True}], active=1)
        with patch.dict(os.environ, {'SINGULARITY_REPOQL_CONNECTORS_RUST_BINARY': str(self.binary)}), \
             patch('repoql_connectors.subprocess.run', side_effect=self._native(json.dumps(fake))):
            with self.assertRaisesRegex(RuntimeError, 'repoql_connectors_native_mismatch'):
                connector_inventory(FakeRql(), now=NOW)

    def test_private_fields_rejected(self):
        extra = dict(self.reference, api_token='PRIVATE')
        with patch.dict(os.environ, {'SINGULARITY_REPOQL_CONNECTORS_RUST_BINARY': str(self.binary)}), \
             patch('repoql_connectors.subprocess.run', side_effect=self._native(json.dumps(extra))):
            with self.assertRaisesRegex(RuntimeError, 'repoql_connectors_native_mismatch'):
                _native_checked(PAYLOAD, NOW, self.reference)

    def test_nonzero_native_exit_rejected(self):
        with patch.dict(os.environ, {'SINGULARITY_REPOQL_CONNECTORS_RUST_BINARY': str(self.binary)}), \
             patch('repoql_connectors.subprocess.run', side_effect=self._native('{}', exit_code=2)):
            with self.assertRaisesRegex(RuntimeError, 'repoql_connectors_native_execution_failed'):
                _native_checked(PAYLOAD, NOW, self.reference)

    def test_malformed_binary_output_rejected(self):
        with patch.dict(os.environ, {'SINGULARITY_REPOQL_CONNECTORS_RUST_BINARY': str(self.binary)}), \
             patch('repoql_connectors.subprocess.run', side_effect=self._native('not json')):
            with self.assertRaisesRegex(RuntimeError, 'repoql_connectors_native_invalid_json'):
                _native_checked(PAYLOAD, NOW, self.reference)

    def test_missing_binary_rejected(self):
        with patch.dict(os.environ, {'SINGULARITY_REPOQL_CONNECTORS_RUST_BINARY': str(self.binary.parent / 'absent.exe')}):
            with self.assertRaisesRegex(RuntimeError, 'repoql_connectors_native_binary_invalid'):
                _native_checked(PAYLOAD, NOW, self.reference)

    def test_accept_null_on_malformed_registry(self):
        malformed = {'schema': 'unexpected', 'connectors': []}
        self.assertIsNone(_inventory_from_payload(malformed, NOW))
        with patch.dict(os.environ, {'SINGULARITY_REPOQL_CONNECTORS_RUST_BINARY': str(self.binary)}), \
             patch('repoql_connectors.subprocess.run', side_effect=self._native('null', payload=malformed)):
            self.assertIsNone(_native_checked(malformed, NOW, None))


if __name__ == '__main__':
    unittest.main()
