"""Windows release gate must not mistake source presence for runtime parity."""
from pathlib import Path
import json
import tempfile
import unittest
import zipfile
import sys

ROOT=Path(__file__).resolve().parents[2]
sys.path.insert(0,str(ROOT/'native/windows'))
from runtime_closure import inspect, BASE, EXTRAS

class RuntimeClosureSourceTests(unittest.TestCase):
    def test_options_cover_real_runtime_boundaries(self):
        ids={entry[0] for entry in BASE}
        self.assertTrue({'repoql','tencent-memorycore','self-learning','agent-chat','kanzo',
                         'dashboard','memory-graph','rust-harness-authority','rust-service-supervisor',
                         'native-telemetry','desktop-bridge'} <= ids)
        self.assertEqual({x[0] for x in EXTRAS},{'ghost','claude-office'})
    def test_inspection_reports_source_only_not_ready(self):
        # Build the actual option 1 ZIP from this checkout for a real scan.
        from build_source_variants import build
        with tempfile.TemporaryDirectory() as d:
            path=Path(d)/'option1.zip'
            build(1,path)
            r=inspect(path)
            self.assertTrue(r['source_archive_valid'])
            self.assertFalse(r['ready'])
            self.assertEqual(r['repoql_version_required'],'1.7.18')
            self.assertNotIn('ghost',{x['id'] for x in r['components']})
            self.assertTrue(all(not x['native_runtime_verified'] for x in r['components']))
            self.assertTrue(all(not x['behavioural_parity_verified'] for x in r['components']))
            self.assertTrue(any('no native Windows runtime' in x for x in r['issues']))
    def test_full_option_requires_office_and_ghost(self):
        from build_source_variants import build
        with tempfile.TemporaryDirectory() as d:
            path=Path(d)/'option4.zip'
            build(4,path)
            r=inspect(path)
            self.assertTrue(r['source_archive_valid'])
            self.assertEqual(r['gui'],'openchamber-desktop')
            ids={x['id'] for x in r['components']}
            self.assertTrue({'ghost','claude-office','openchamber-desktop'} <= ids)
            self.assertFalse(r['ready'])

if __name__=='__main__':unittest.main()
