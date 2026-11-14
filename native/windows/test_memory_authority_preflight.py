import json
import tempfile
import unittest
from pathlib import Path
from memory_authority_preflight import inspect


class TestMemoryAuthorityPreflight(unittest.TestCase):
    def setUp(self):
        self.ctx = tempfile.TemporaryDirectory()
        self.root = Path(self.ctx.name)
        config = self.root / 'harness' / 'kit' / 'config.json'
        config.parent.mkdir(parents=True)
        config.write_text(json.dumps({'memoryProvenance': {'retrievalFilter': 'ENABLED'}}))

    def tearDown(self):
        self.ctx.cleanup()

    def test_enabled_without_local_authority_is_not_ready(self):
        r = inspect(self.root, {})
        self.assertFalse(r['ok'])
        self.assertEqual(r['code'], 'WINDOWS_MEMORY_AUTHORITY_UNVERIFIED')

    def test_local_authority_directories_satisfy_directory_preflight(self):
        t, l = self.root/'tombstones', self.root/'lineage'
        t.mkdir(); l.mkdir()
        r = inspect(self.root, {'ORCH_TOMBSTONES_DIR':str(t),'ORCH_LINEAGE_DIR':str(l)})
        self.assertTrue(r['ok'])
        self.assertTrue(r['checks']['tombstones']['localDirectoryExists'])

    def test_disabled_filter_needs_no_authority(self):
        self.assertTrue(inspect(self.root, {'ORCH_MEMORY_RETRIEVAL_FILTER': 'DISABLED'})['ok'])

    def test_missing_config_fails(self):
        (self.root/'harness'/'kit'/'config.json').unlink()
        self.assertFalse(inspect(self.root, {})['ok'])


if __name__ == '__main__':
    unittest.main()
