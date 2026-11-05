"""Pure connector registry safety contracts; no RepoQL service or live data."""
import sys
import unittest
from datetime import datetime, timedelta, timezone
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
sys.path.insert(0, str(Path(__file__).resolve().parents[1] / 'native' / 'windows'))
from repoql_connectors import _inventory_from_payload
from verify_option2_connectors import evaluate

NOW = datetime(2026, 10, 30, 1, 0, tzinfo=timezone.utc)


def _import(scheme, stamp=None):
    return {'kind': 'connector', 'scheme': scheme, 'root': scheme + '://',
            'state': 'current', 'freshAsOf': (stamp or NOW).isoformat(),
            'sweepIntervalSeconds': 60, 'files': 2, 'bytes': 50}


def _registry(imports, connectors=None):
    return {'schema': 'repoql.imports.status/v1',
            'connectors': connectors if connectors is not None else [
                {'scheme': 'memorycore', 'state': 'installed'},
                {'scheme': 'kanzo', 'state': 'installed'}], 'imports': imports}


class ConnectorEvidenceTests(unittest.TestCase):
    def test_unique_current_fresh_imports_can_pass_registry_gate_only(self):
        inv = _inventory_from_payload(_registry([_import('memorycore'), _import('kanzo')]), NOW)
        self.assertTrue(evaluate(inv)['bothConnectorsActive'])
        self.assertFalse(evaluate(inv)['releaseReady'])
        self.assertFalse(evaluate(inv)['liveMcpCallsVerified'])

    def test_conflicting_duplicate_imports_are_never_accepted_as_active(self):
        duplicate = [_import('memorycore'), dict(_import('memorycore'), state='failed'), _import('kanzo')]
        inv = _inventory_from_payload(_registry(duplicate), NOW)
        m = next(x for x in inv['connectors'] if x['id'] == 'memorycore')
        self.assertEqual(m['status'], 'ambiguous')
        self.assertEqual(m['freshness'], 'ambiguous')
        self.assertFalse(evaluate(inv)['bothConnectorsActive'])

    def test_connector_with_conflicting_scheme_and_root_is_rejected(self):
        conflicting = dict(_import('memorycore'), root='kanzo://wrong')
        inv = _inventory_from_payload(_registry([conflicting, _import('kanzo')]), NOW)
        m = next(x for x in inv['connectors'] if x['id'] == 'memorycore')
        self.assertEqual(m['status'], 'ambiguous')
        self.assertFalse(evaluate(inv)['bothConnectorsActive'])

    def test_future_timestamp_does_not_count_as_fresh(self):
        inv = _inventory_from_payload(_registry([_import('memorycore', NOW + timedelta(days=1)), _import('kanzo')]), NOW)
        m = next(x for x in inv['connectors'] if x['id'] == 'memorycore')
        self.assertEqual(m['status'], 'clock_skew')
        self.assertFalse(evaluate(inv)['bothConnectorsActive'])

    def test_small_clock_skew_remains_tolerated(self):
        inv = _inventory_from_payload(_registry([_import('memorycore', NOW + timedelta(seconds=30)), _import('kanzo')]), NOW)
        self.assertTrue(evaluate(inv)['bothConnectorsActive'])

    def test_truncated_registry_cannot_clear_exact_two_connector_gate(self):
        registry = [{'scheme': 'memorycore', 'state': 'installed'}, {'scheme': 'kanzo', 'state': 'installed'}]
        registry.extend({'scheme': f'extra{i}', 'state': 'installed'} for i in range(201))
        inv = _inventory_from_payload(_registry([_import('memorycore'), _import('kanzo')], registry), NOW)
        self.assertTrue(inv['truncated'])
        self.assertFalse(evaluate(inv)['bothConnectorsActive'])
        self.assertFalse(evaluate(inv)['registryComplete'])

    def test_registry_without_explicit_completeness_not_certified(self):
        inv = {'available': True, 'connectors': [
            {'id': 'kanzo', 'active': True}, {'id': 'memorycore', 'active': True}]}
        self.assertFalse(evaluate(inv)['bothConnectorsActive'])


if __name__ == '__main__':
    unittest.main()
