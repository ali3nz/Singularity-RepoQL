"""Focused fail-closed checks for persistent dashboard exclusion records.

No dashboard listener, RepoQL binary or live account is used.
"""
import json
import concurrent.futures
import time
import tempfile
import unittest
from pathlib import Path
from server import ExclusionStore, ExclusionStateError


class ExclusionStoreIntegrityTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.path = Path(self.tmp.name) / 'exclusions.json'
        self.store = ExclusionStore(self.path)

    def test_absent_file_is_empty(self):
        self.assertEqual(self.store.load(), [])

    def test_legitimate_add_preserves_previous_records(self):
        self.store.add({'id': 'a', 'uri': 'file:///docs/one.md'})
        self.store.add({'id': 'b', 'uri': 'file:///docs/two.md'})
        self.assertEqual([x['id'] for x in self.store.load()], ['a', 'b'])

    def test_bad_json_is_not_silently_replaced(self):
        original = '{"exclusions": [UNFINISHED]}'
        self.path.write_text(original)
        with self.assertRaisesRegex(ExclusionStateError, 'EXCLUSIONS_LEDGER_UNREADABLE'):
            self.store.add({'id': 'new', 'uri': 'file:///new'})
        self.assertEqual(self.path.read_text(), original)

    def test_bad_schema_is_not_silently_replaced(self):
        for obj in ({}, {'exclusions': {}}, {'exclusions': [1]}, []):
            self.path.write_text(json.dumps(obj))
            with self.assertRaisesRegex(ExclusionStateError, 'EXCLUSIONS_LEDGER_INVALID_SCHEMA'):
                self.store.add({'id': 'new', 'uri': 'file:///new'})
            self.assertEqual(json.loads(self.path.read_text()), obj)

    def test_pending_save_blocks_new_write_and_preserves_data(self):
        self.path.write_text('{"exclusions": []}')
        pending = self.path.with_suffix('.json.tmp')
        pending.write_text('KEEP ME')
        with self.assertRaises(FileExistsError):
            self.store.add({'id': 'new', 'uri': 'file:///new'})
        self.assertEqual(pending.read_text(), 'KEEP ME')
        self.assertEqual(json.loads(self.path.read_text())['exclusions'], [])

    def test_cross_instance_concurrent_adds_preserve_every_record(self):
        # Distinct ExclusionStore instances simulate overlapping dashboard
        # processes. Widen the old load/save race to make regression visible.
        class SlowStore(ExclusionStore):
            def load(self):
                result = super().load()
                time.sleep(0.008)
                return result

        def add_one(i):
            SlowStore(self.path).add({'id': f'row-{i}', 'uri': f'file:///docs/{i}.md'})

        with concurrent.futures.ThreadPoolExecutor(max_workers=8) as pool:
            list(pool.map(add_one, range(8)))
        records = self.store.load()
        self.assertEqual({r['id'] for r in records}, {f'row-{i}' for i in range(8)})
        self.assertTrue(self.path.with_name('exclusions.json.lock').is_file())

    def test_symlinked_lockfile_is_refused(self):
        lockfile = self.path.with_name('exclusions.json.lock')
        foreign = Path(self.tmp.name) / 'foreign.lock'
        foreign.write_text('DO NOT MODIFY')
        lockfile.symlink_to(foreign)
        with self.assertRaisesRegex(ExclusionStateError, 'EXCLUSIONS_LOCK_SYMLINK_REFUSED'):
            self.store.add({'id': 'new', 'uri': 'file:///new'})
        self.assertEqual(foreign.read_text(), 'DO NOT MODIFY')
        self.assertFalse(self.path.exists())

    def test_symlinked_ledger_refused(self):
        target = Path(self.tmp.name) / 'foreign.json'
        target.write_text('{"exclusions": []}')
        self.path.symlink_to(target)
        with self.assertRaisesRegex(ExclusionStateError, 'EXCLUSIONS_LEDGER_SYMLINK_REFUSED'):
            self.store.add({'id': 'new', 'uri': 'file:///new'})
        self.assertEqual(json.loads(target.read_text())['exclusions'], [])


if __name__ == '__main__':
    unittest.main()
