"""Node/Python cross-runtime safety tests for the shared documentation ledger."""
from __future__ import annotations
import importlib.util
import os
from pathlib import Path
import subprocess
import sys
import tempfile
import unittest

ROOT = Path(__file__).resolve().parent
if str(ROOT) not in sys.path:
    sys.path.insert(0, str(ROOT))
spec=importlib.util.spec_from_file_location('memory_doc_ingest',ROOT/'memory-doc-ingest.py')
module=importlib.util.module_from_spec(spec)
spec.loader.exec_module(module)

class LockSafety(unittest.TestCase):
    def test_old_owner_is_not_reaped_by_python(self):
        with tempfile.TemporaryDirectory() as t:
            lock=Path(t)/'doc-index'/'.ledger.lock.d'
            owner=module.acquire_ledger_lock(lock)
            os.utime(lock,(1,1))
            with self.assertRaisesRegex(RuntimeError,'busy'):
                module.acquire_ledger_lock(lock,timeout=0.08,stale=0.001)
            self.assertEqual((lock/'owner').read_text(),owner)
            module.release_ledger_lock(lock,owner)
            self.assertFalse(lock.exists())

    def test_replacement_token_prevents_release(self):
        with tempfile.TemporaryDirectory() as t:
            lock=Path(t)/'.ledger.lock.d'
            owner=module.acquire_ledger_lock(lock)
            (lock/'owner').write_text('other-owner')
            with self.assertRaisesRegex(RuntimeError,'ownership changed'):
                module.release_ledger_lock(lock,owner)
            self.assertTrue(lock.exists())

    def test_python_lock_blocks_node_writer_even_if_old(self):
        with tempfile.TemporaryDirectory() as t:
            lock=Path(t)/'doc-index'/'.ledger.lock.d'
            owner=module.acquire_ledger_lock(lock)
            os.utime(lock,(1,1))
            code="""import {withLedger} from './doc-ingest-node.mjs';
              await withLedger(async()=>{}, {env:{SINGULARITY_DOC_DATA:process.env.DOC_TEST_DATA},lockTimeoutMs:90,lockStaleMs:1})"""
            env={**os.environ,'DOC_TEST_DATA':t}
            result=subprocess.run(['node','--input-type=module','--eval',code],cwd=ROOT,env=env,
                                  timeout=6,text=True,capture_output=True)
            self.assertNotEqual(result.returncode,0)
            self.assertIn('ledger lock busy',result.stderr)
            self.assertEqual((lock/'owner').read_text(),owner)
            module.release_ledger_lock(lock,owner)

if __name__=='__main__':unittest.main()
