"""Windows release gate must not mistake source presence for runtime parity."""
from pathlib import Path
import tempfile
import unittest

from build_source_variants import build
from runtime_closure import inspect


class RuntimeClosureSourceTests(unittest.TestCase):
    def test_full_source_reports_every_required_runtime_as_unverified(self):
        with tempfile.TemporaryDirectory() as d:
            path = Path(d) / 'option2.zip'
            build(2, path)
            report = inspect(path)
        self.assertTrue(report['source_archive_valid'])
        self.assertFalse(report['ready'])
        self.assertEqual(report['repoql_version_required'], '1.7.18')
        self.assertEqual(report['gui'], 'claude-desktop-code')
        components = report['components']
        self.assertEqual({item['id'] for item in components}, {
            'repoql', 'tencent-memorycore', 'self-learning', 'agent-chat', 'kanzo',
            'dashboard', 'memory-graph', 'rust-harness-authority', 'rust-service-supervisor',
            'native-telemetry', 'desktop-bridge', 'claude-office', 'openmausbot',
            'claude-desktop-code',
        })
        self.assertEqual(report['components_without_native_runtime_proof'], len(components))
        self.assertTrue(all(not item['native_runtime_verified'] for item in components))
        self.assertTrue(all(not item['behavioural_parity_verified'] for item in components))
        self.assertTrue(all(item['source_hint_present'] is True
                            for item in components if item['source_hint'] is not None))
        self.assertTrue(any('no native Windows runtime' in issue for issue in report['issues']))


if __name__ == '__main__':
    unittest.main()
