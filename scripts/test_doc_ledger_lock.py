"""Node/Python cross-runtime safety tests for the shared documentation ledger."""
from __future__ import annotations
import importlib.util
import json
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

    def test_python_and_node_do_not_publish_after_losing_lock(self):
        from unittest.mock import patch

        for host in ('python', 'node'):
            with self.subTest(host=host), tempfile.TemporaryDirectory() as t:
                base = Path(t) / 'doc-index'
                base.mkdir()
                ledger = base / 'ledger.json'
                original = '{"version":1,"docs":{"preserved":{}}}'
                ledger.write_text(original, encoding='utf-8')
                foreign_temp = base / 'ledger.tmp'
                foreign_temp.write_text('not ours', encoding='utf-8')
                owner = base / '.ledger.lock.d' / 'owner'
                if host == 'python':
                    def lose_lock(obj):
                        obj['docs']['new'] = {}
                        owner.write_text('different-owner', encoding='utf-8')
                    with patch.dict(os.environ, {'SINGULARITY_DOC_DATA': t}):
                        with self.assertRaisesRegex(RuntimeError, 'ownership changed'):
                            module.with_ledger(lose_lock)
                else:
                    code = """
import {writeFileSync} from 'node:fs';
import {withLedger} from './doc-ingest-node.mjs';
await withLedger(ledger => {
  ledger.docs.new = {};
  writeFileSync(process.env.DOC_OWNER,'different-owner');
}, {env:{SINGULARITY_DOC_DATA:process.env.DOC_TEST_DATA}});
"""
                    result = subprocess.run(
                        ['node', '--input-type=module', '--eval', code], cwd=ROOT,
                        env={**os.environ, 'DOC_TEST_DATA': t, 'DOC_OWNER': str(owner)},
                        timeout=6, text=True, capture_output=True,
                    )
                    self.assertNotEqual(result.returncode, 0)
                    self.assertIn('ownership changed', result.stderr)
                self.assertEqual(ledger.read_text(encoding='utf-8'), original)
                self.assertEqual(foreign_temp.read_text(encoding='utf-8'), 'not ours')
                self.assertEqual(owner.read_text(encoding='utf-8'), 'different-owner')
                self.assertEqual(list(base.glob('.ledger-*.tmp')), [])

    def test_both_writers_preserve_a_foreign_temporary_file_on_success(self):
        from unittest.mock import patch

        with tempfile.TemporaryDirectory() as t:
            base = Path(t) / 'doc-index'
            base.mkdir()
            foreign_temp = base / 'ledger.tmp'
            foreign_temp.write_text('not ours', encoding='utf-8')
            with patch.dict(os.environ, {'SINGULARITY_DOC_DATA': t}):
                module.with_ledger(lambda obj: obj['docs'].update({'python': {}}))
            result = subprocess.run(
                ['node', '--input-type=module', '--eval', """
import {withLedger} from './doc-ingest-node.mjs';
await withLedger(ledger => { ledger.docs.node = {}; },
  {env:{SINGULARITY_DOC_DATA:process.env.DOC_TEST_DATA}});
"""], cwd=ROOT, env={**os.environ, 'DOC_TEST_DATA': t},
                timeout=6, text=True, capture_output=True,
            )
            self.assertEqual(result.returncode, 0, result.stderr)
            ledger = json.loads((base / 'ledger.json').read_text(encoding='utf-8'))
            self.assertEqual(ledger, {'version': 1, 'docs': {'python': {}, 'node': {}}})
            self.assertEqual(foreign_temp.read_text(encoding='utf-8'), 'not ours')
            self.assertEqual(list(base.glob('.ledger-*.tmp')), [])
            self.assertFalse((base / '.ledger.lock.d').exists())

    def test_python_native_failure_never_falls_back(self):
        from unittest.mock import patch

        with tempfile.TemporaryDirectory() as t:
            with patch.dict(os.environ, {'SINGULARITY_DOC_DATA': t,
                                         'SINGULARITY_DOC_LEDGER_COMMIT_RUST_BIN': 'fake'}):
                ledger = module._ledger()
                ledger.parent.mkdir()
                original = b'{"version":1,"docs":{}}'
                ledger.write_bytes(original)
                with patch.object(module, '_rust_doc_policy', return_value={'ok': True, 'published': True}) as native:
                    with self.assertRaisesRegex(module.Blocked, 'commit unconfirmed'):
                        module.with_ledger(lambda value: value['docs'].update({'new': {}}))
                native.assert_called_once()
                self.assertEqual(ledger.read_bytes(), original)
                self.assertFalse(module._lock().exists())

    def test_python_verified_native_commit_publishes_exact_bytes(self):
        from unittest.mock import patch

        def native(command, request, reference, **kwargs):
            self.assertEqual(command, 'doc-ledger-commit')
            self.assertEqual(kwargs['args'], [])
            temp = Path(request['temp'])
            self.assertEqual(request['owner'], (module._lock() / 'owner').read_text())
            self.assertEqual(set(request), {'schema', 'temp', 'owner'})
            temp.replace(module._ledger())
            return reference

        with tempfile.TemporaryDirectory() as t:
            with patch.dict(os.environ, {'SINGULARITY_DOC_DATA': t,
                                         'SINGULARITY_DOC_LEDGER_COMMIT_RUST_BIN': 'fake'}):
                with patch.object(module, '_rust_doc_policy', side_effect=native):
                    module.with_ledger(lambda value: value['docs'].update({'new': {}}))
                self.assertIn('new', module._load_ledger()['docs'])
                self.assertFalse(module._lock().exists())

if __name__=='__main__':unittest.main()
