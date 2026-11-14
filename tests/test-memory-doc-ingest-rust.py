#!/usr/bin/env python3
"""Guarded native doc index planning and long-line source correctness."""
import importlib.util
import json
import os
from pathlib import Path
from types import SimpleNamespace
import subprocess
import sys
import tempfile
import unittest
from unittest.mock import patch

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / 'scripts'))
spec = importlib.util.spec_from_file_location('doc_ingest_wave19', ROOT / 'scripts/memory-doc-ingest.py')
mod = importlib.util.module_from_spec(spec)
spec.loader.exec_module(mod)


class DocIngestNativeBoundary(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.home = Path(self.tmp.name)
        self.docroot = self.home / 'docs'
        self.docroot.mkdir()
        self.binary = self.home / 'memory-parity.exe'
        self.binary.write_bytes(b'SYNTHETIC TEST BINARY; NEVER EXECUTED')
        self.data = self.home / 'data'
        self.environ = patch.dict(os.environ, {
            'SINGULARITY_DOC_DATA': str(self.data),
            'DOC_INDEX_TEAM': 'shared-docs',
            'DOC_INDEX_USER': 'shared',
        }, clear=False)
        self.environ.start()
        self.addCleanup(self.environ.stop)
        os.environ.pop('SINGULARITY_DOC_RUST_BIN', None)

    def test_native_retrieval_facts_hide_identity_and_preserve_deduplication(self):
        base = dict(index=0, validMarker=True, superseded=False, hasEntry=True,
                    rootAllowed=True, activeRevMatches=True, verifiedActive=True,
                    rootId='secretroot', rel='confidential/runbook.md', rev='abcdef12')
        original = [dict(base), dict(base, index=1),
                    dict(base, index=2, rel='different/runbook.md')]
        projected = mod._native_retrieval_facts(original)
        self.assertEqual([row['rootId'] for row in projected], ['0','0','1'])
        self.assertTrue(all(row['rel']==row['rev']=='' for row in projected))
        self.assertEqual([row['rel'] for row in original],
                         ['confidential/runbook.md','confidential/runbook.md','different/runbook.md'])
        self.assertEqual(mod._select_retrieval_indices_reference(projected, 5, True, False),
                         mod._select_retrieval_indices_reference(original, 5, True, False))
        self.assertNotIn('confidential', json.dumps(projected))

    def test_randomized_retrieval_identity_projection_preserves_selection(self):
        import random
        rng = random.Random(46664)
        for case in range(500):
            rows = []
            for index in range(rng.randrange(0, 70)):
                rows.append(dict(index=index, validMarker=rng.choice([True,False]),
                                 superseded=rng.choice([True,False]),
                                 hasEntry=rng.choice([True,False]),
                                 rootAllowed=rng.choice([True,False]),
                                 activeRevMatches=rng.choice([True,False]),
                                 verifiedActive=rng.choice([True,False]),
                                 rootId=f'root{rng.randrange(0,6)}',
                                 rel=f'confidential/{rng.randrange(0,11)}.md',
                                 rev=f'{rng.randrange(0,4):08x}'))
            projected = mod._native_retrieval_facts(rows)
            limit = rng.randrange(1, 17)
            stale = rng.choice([True,False])
            restricted = rng.choice([True,False])
            with self.subTest(case=case):
                self.assertEqual(mod._select_retrieval_indices_reference(rows,limit,stale,restricted),
                                 mod._select_retrieval_indices_reference(projected,limit,stale,restricted))
                self.assertNotIn('confidential/',json.dumps(projected))

    def test_native_document_retrieval_does_not_forward_identities_or_secrets(self):
        os.environ['SINGULARITY_DOC_RUST_BIN'] = str(self.binary)
        os.environ['MEMORY_SECRETS'] = str(self.home / 'memory-private.json')
        os.environ['TOP_SECRET_TOKEN'] = 'child-should-not-see-this'
        msgs = [{'content':f'[doc-ref:{rel}#{rev} chunk 1/1 hash 00000000]\nroot-id: 1234abcd\ntext'}
                for rel,rev in [('private/runbook.md','abcdef12'),
                                ('private/runbook.md','abcdef12'),
                                ('private/other.md','dcba4321')]]
        seen = []
        def child(argv, **kwargs):
            request = json.loads(kwargs['input'])
            seen.append(request)
            self.assertNotIn('MEMORY_SECRETS', kwargs['env'])
            self.assertNotIn('TOP_SECRET_TOKEN', kwargs['env'])
            self.assertEqual([row['rootId'] for row in request['candidates']], ['0','0','1'])
            for sensitive in ('private/runbook.md','private/other.md','1234abcd','abcdef12','dcba4321'):
                self.assertNotIn(sensitive, kwargs['input'])
            return SimpleNamespace(returncode=0,stdout=json.dumps({'ok':True,'indices':[0,2]}),stderr='')
        with patch.object(mod,'load_cfg',return_value={'safe':'fixture'}), \
             patch.object(mod,'search_once',return_value=msgs), \
             patch.object(mod,'_load_ledger',return_value={'docs':{}}), \
             patch.object(mod,'doc_roots',return_value=[]), \
             patch.object(subprocess,'run',side_effect=child):
            rows=mod.search_docs('ignored',limit=5,include_stale=True)
        self.assertEqual([row['source'] for row in rows],['private/runbook.md','private/other.md'])
        self.assertEqual(len(seen),1)

    def test_native_ledger_locator_only_receives_match_bits(self):
        root = self.docroot.resolve()
        rel = 'private/runbook.md'
        root_id = mod._root_id_of(root)
        key = root_id + '::' + rel
        ledger = {'docs': {
            'a-root::' + rel: {'rel': rel, 'root': str(root.parent / 'foreign')},
            key: {'rel': rel, 'root': str(root), 'root_id': root_id, 'revs': {}},
            root_id + '::fallback.md': {'root': str(root)},
        }}
        self.assertIsNone(mod.locate_entry_key(ledger, rel))
        self.assertEqual(mod.locate_entry_key(ledger, rel, root), key)
        self.assertEqual(mod.locate_entry_key(ledger, root / 'fallback.md'), root_id + '::fallback.md')
        os.environ['SINGULARITY_DOC_RUST_BIN'] = str(self.binary)
        os.environ['MEMORY_SECRETS'] = 'private-config'
        def child(argv, **kwargs):
            self.assertEqual(argv[1:], ['doc-index-locate'])
            self.assertNotIn('MEMORY_SECRETS', kwargs['env'])
            self.assertEqual(json.loads(kwargs['input']),
                             {'candidates': [[True, False], [True, True], [False, True]],
                              'rootPinned': True})
            return SimpleNamespace(returncode=0, stdout='{"ok":true,"index":1}', stderr='')
        with patch.object(mod, '_load_ledger', return_value=ledger), \
             patch.object(mod, '_status_row', return_value={'file': rel}) as status, \
             patch.object(mod, 'ingest_file', return_value={'file': rel}) as ingest, \
             patch.object(subprocess, 'run', side_effect=child):
            self.assertEqual(mod.status_report(rel, root_arg=root), [{'file': rel}])
            status.assert_called_once_with(ledger['docs'][key], rel)
            self.assertEqual(mod.retry(rel, root_arg=root), [{'file': rel}])
            ingest.assert_called_once_with(root / rel, root_arg=str(root))

    def test_native_ledger_locator_divergence_blocks_retry_before_ingest(self):
        root_id = mod._root_id_of(self.docroot)
        ledger = {'docs': {root_id+'::safe.md': {'rel':'safe.md','root':str(self.docroot)}}}
        os.environ['SINGULARITY_DOC_RUST_BIN'] = str(self.binary)
        for forged in (True, False, 0.0, 1, None):
            result = SimpleNamespace(returncode=0, stdout=json.dumps({'ok': True, 'index': forged}), stderr='')
            with self.subTest(forged=forged), patch.object(subprocess, 'run', return_value=result), \
                 patch.object(mod, '_load_ledger', return_value=ledger), \
                 patch.object(mod, 'ingest_file', side_effect=AssertionError('MUST NOT WRITE')):
                with self.assertRaises(mod.Blocked):
                    mod.retry('safe.md', root_arg=self.docroot)

    def test_long_unicode_line_is_bounded_without_losing_characters(self):
        value = '🧠'*19000
        result = mod.chunk_markdown(value)
        self.assertEqual(len(result), 3)
        self.assertTrue(all(len(c)<=mod.MAX_CHUNK_CHARS for c in result))
        self.assertEqual(''.join(result), value)

    def test_heading_and_fenced_sections_are_bounded(self):
        text = '# Main\n' + ('a' * 5000) + '\n## Heading\n```rust\n# not heading\n```\n' + ('b' * 9000)
        result = mod.chunk_markdown(text)
        self.assertTrue(all(len(c) <= 7000 for c in result))
        self.assertIn('## Heading', '\n'.join(result))
        self.assertIn('# not heading', '\n'.join(result))

    def test_too_many_large_lines_are_blocked(self):
        with self.assertRaises(mod.Blocked):
            mod.chunk_markdown(('a' * 7000 + '\n') * 65)

    def test_valid_native_results_are_accepted(self):
        os.environ['SINGULARITY_DOC_RUST_BIN'] = str(self.binary)
        calls = []
        def oracle(argv, **kwargs):
            calls.append((argv, kwargs))
            self.assertEqual(argv[0], str(self.binary))
            request = json.loads(kwargs['input'])
            if argv[1] == 'doc-index-chunks':
                result = {'ok': True, 'chunks': mod._chunk_markdown_reference(request['text'])}
            elif argv[1] == 'doc-index-plan':
                result = {'ok': True, 'tasks': mod._chunk_tasks_reference(
                    request['chunks'], request['rel'], request['title'], request['rootId'],
                    request['docId'], request['rev'], request['timestamp'],
                    request['team'], request['user'])}
            else:
                self.fail('unexpected native command')
            return SimpleNamespace(returncode=0, stdout=json.dumps(result), stderr='')
        with patch.object(subprocess, 'run', side_effect=oracle):
            parts = mod.chunk_markdown('# Safe\n' + '🦊'*15000)
            tasks = mod.doc_chunk_tasks(parts, 'a.md', 'Safe', 'abcdef01', '01234567', 'fedcba98',
                                        '2026-11-12T00:00:00Z')
        self.assertEqual(len(tasks), len(parts))
        self.assertEqual(len(calls), 2)
        self.assertTrue(all(t['marker'] in t['text'] for t in tasks))
        for argv, kwargs in calls:
            self.assertNotIn('Authorization', kwargs['input'])
            self.assertNotIn('gatewayKey', kwargs['input'])
            self.assertNotIn('memory.json', kwargs['input'])
            self.assertEqual(kwargs['timeout'], 10)

    def test_native_forged_chunk_is_rejected_before_memory_write(self):
        os.environ['SINGULARITY_DOC_RUST_BIN'] = str(self.binary)
        path = self.docroot / 'safe.md'
        path.write_text('# Safe\nA recoverable runbook without secrets.', encoding='utf-8')
        forge = SimpleNamespace(returncode=0, stdout=json.dumps({'ok': True, 'chunks':['UNTRUSTED']}), stderr='')
        with patch.object(subprocess, 'run', return_value=forge), \
             patch.object(mod, 'memory_call', side_effect=AssertionError('MUST NOT WRITE')):
            result = mod.ingest_file(path, root_arg=str(self.docroot))
        self.assertEqual(result['status'], 'DOC_INGEST_BLOCKED')
        self.assertIn('native documentation policy', result['reason'])

    def test_native_forged_plan_is_rejected_before_memory_write(self):
        os.environ['SINGULARITY_DOC_RUST_BIN'] = str(self.binary)
        path = self.docroot / 'safe.md'
        path.write_text('# Safe\nA recoverable runbook without secrets.', encoding='utf-8')
        def process(argv, **kwargs):
            if argv[1] == 'doc-index-chunks':
                request=json.loads(kwargs['input'])
                actual={'ok':True,'chunks':mod._chunk_markdown_reference(request['text'])}
            else:
                actual={'ok':True,'tasks':[{'task_id':'FAKE','marker':'FAKE','text':'FAKE','hash':'FAKE'}]}
            return SimpleNamespace(returncode=0,stdout=json.dumps(actual),stderr='')
        with patch.object(subprocess, 'run', side_effect=process), \
             patch.object(mod, 'memory_call', side_effect=AssertionError('MUST NOT WRITE')):
            result = mod.ingest_file(path, root_arg=str(self.docroot))
        self.assertEqual(result['status'], 'DOC_INGEST_BLOCKED')
        self.assertIn('native documentation policy', result['reason'])

    def test_invalid_binary_fails_closed(self):
        os.environ['SINGULARITY_DOC_RUST_BIN'] = str(self.home / 'not-here.exe')
        with self.assertRaises(mod.Blocked):
            mod.chunk_markdown('safe content')

    def test_sensitive_content_never_sent_to_native_binary(self):
        os.environ['SINGULARITY_DOC_RUST_BIN'] = str(self.binary)
        path=self.docroot/'secret.md'
        path.write_text('# Secret\napi_key = supersecretvalue123', encoding='utf-8')
        with patch.object(subprocess, 'run', side_effect=AssertionError('MUST NOT SEND')):
            result=mod.ingest_file(path, root_arg=str(self.docroot))
        self.assertEqual(result['status'],'DOC_INGEST_BLOCKED')

    def test_unindexed_history_is_never_current(self):
        msgs=[{'content':'[doc-ref:lost.md#12345678 chunk 1/1 hash 00000000]\nroot-id: 00000001\nOld'}]
        with patch.object(mod,'load_cfg',return_value={'no_secret':'needed'}), \
             patch.object(mod,'search_once',return_value=msgs), \
             patch.object(mod,'_load_ledger',return_value={'docs':{}}), \
             patch.dict(os.environ,{'SINGULARITY_DOC_ROOTS':''}):
            self.assertEqual(mod.search_docs('lost',include_stale=False),[])
            historical=mod.search_docs('lost',include_stale=True)
            self.assertEqual(len(historical),1)
            self.assertEqual(historical[0]['source'],'lost.md')

    def test_native_forged_retrieval_is_rejected(self):
        os.environ['SINGULARITY_DOC_RUST_BIN']=str(self.binary)
        msgs=[{'content':'[doc-ref:lost.md#12345678 chunk 1/1 hash 00000000]\nroot-id: 00000001\nOld'}]
        native=SimpleNamespace(returncode=0,stdout=json.dumps({'ok':True,'indices':[0]}),stderr='')
        with patch.object(mod,'load_cfg',return_value={'no_secret':'needed'}), \
             patch.object(mod,'search_once',return_value=msgs), \
             patch.object(mod,'_load_ledger',return_value={'docs':{}}), \
             patch.dict(os.environ,{'SINGULARITY_DOC_ROOTS':''}), \
             patch.object(subprocess,'run',return_value=native):
            with self.assertRaises(mod.Blocked):
                mod.search_docs('lost',include_stale=False)

    def test_verified_active_revision_is_returned_in_authorised_root(self):
        text='# Current\nSafe documented procedure.\n'
        path=self.docroot/'current.md'
        path.write_text(text,encoding='utf-8')
        root=str(self.docroot.resolve())
        root_id=mod.sha(Path(root).as_posix())[:8]
        rev=mod.sha(text)[:8]
        entry={'rel':'current.md','root':Path(root).as_posix(),'root_id':root_id,
               'doc_id':'12345678','title':'Current','active_rev':rev,
               'revs':{rev:{'status':'DOC_INGEST_INDEXED','verified_at':'2026-11-12T00:00:00Z',
                            'chunks':1,'task_ids':['docs-12345678-r'+rev+'-c01'],
                            'hashes':['abcdef12'],'ingested_at':'2026-11-12T00:00:00Z'}}}
        msg=f'[doc-ref:current.md#{rev} chunk 1/1 hash abcdef12]\nroot-id: {root_id}\nCurrent text'
        with patch.object(mod,'load_cfg',return_value={'no_secret':'needed'}), \
             patch.object(mod,'search_once',return_value=[{'content':msg}]), \
             patch.object(mod,'_load_ledger',return_value={'docs':{f'{root_id}::current.md':entry}}):
            rows=mod.search_docs('current',root_arg=root)
            self.assertEqual(len(rows),1)
            self.assertEqual(rows[0]['revision'],rev)
            path.write_text('# Changed\n',encoding='utf-8')
            self.assertEqual(mod.search_docs('current',root_arg=root),[])


if __name__ == '__main__':
    unittest.main()
