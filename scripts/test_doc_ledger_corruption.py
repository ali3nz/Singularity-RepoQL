"""Fast fail-closed regression tests for the shared documentation ledger.

These checks never contact Tencent and never mutate a real product ledger.
"""
import importlib.util
import os
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

MODULE = Path(__file__).with_name('memory-doc-ingest.py')
spec = importlib.util.spec_from_file_location('memory_doc_ingest_corruption_test', MODULE)
engine = importlib.util.module_from_spec(spec)
spec.loader.exec_module(engine)


class LedgerIntegrityTests(unittest.TestCase):
    def test_invalid_ledger_preserved_and_write_rejected(self):
        with tempfile.TemporaryDirectory() as tmp:
            with patch.dict(os.environ, {'SINGULARITY_DOC_DATA': tmp}):
                lp = engine._ledger()
                lp.parent.mkdir(parents=True, exist_ok=True)
                for damaged in ('{bad', '[]', '{"version":1,"docs":[]}', '{"version":2,"docs":{}}'):
                    with self.subTest(damaged=damaged):
                        lp.write_text(damaged)
                        with self.assertRaisesRegex(engine.Blocked, 'DOC_LEDGER_CORRUPT'):
                            engine._load_ledger()
                        with self.assertRaisesRegex(engine.Blocked, 'DOC_LEDGER_CORRUPT'):
                            engine.with_ledger(lambda ledger: ledger['docs'].update({'lost':{}}))
                        self.assertEqual(lp.read_text(), damaged)
                        self.assertFalse(engine._lock().exists())
                lp.write_text('{"version":1,"docs":{}}')
                engine.with_ledger(lambda ledger: ledger['docs'].update({'preserved':{}}))
                self.assertIn('preserved', engine._load_ledger()['docs'])


if __name__ == '__main__':
    unittest.main()
