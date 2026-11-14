#!/usr/bin/env python3
"""Documentation completion evidence: no native authority, no private payload."""
import importlib.util
import os
from pathlib import Path
import sys
import tempfile
import unittest
from unittest import mock

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / 'scripts'))
spec = importlib.util.spec_from_file_location('doc_ledger_source', ROOT/'scripts'/'memory-doc-ingest.py')
mdi = importlib.util.module_from_spec(spec)
spec.loader.exec_module(mdi)


class EvidenceBoundary(unittest.TestCase):
    def setUp(self):
        self.t = tempfile.TemporaryDirectory()
        self.addCleanup(self.t.cleanup)
        self.root = Path(self.t.name)
        self.source = self.root / 'sensitive-source.md'
        self.source.write_text('# Secret project\nThis content stays in Python.\n', encoding='utf-8')
        self.rev = mdi.sha(self.source.read_text())[:8]
        self.entry = {
            'root': str(self.root), 'rel': self.source.name, 'root_id': 'id-private',
            'active_rev': self.rev, 'title': 'private title',
            'revs': {self.rev:{'status':'DOC_INGEST_INDEXED','verified_at':'2026-11-13T01:00:00Z',
                              'chunks':1, 'task_ids':['private-task'], 'hashes':['private-hash']}}
        }

    def test_no_native_selected_keeps_authoritative_result(self):
        with mock.patch.dict(os.environ, {'SINGULARITY_DOC_LEDGER_RUST_BINARY':''}):
            with mock.patch.object(mdi, '_rust_doc_policy', side_effect=AssertionError('native called')):
                result = mdi._entry_evidence(self.entry, self.source.name)
        self.assertEqual(result['status'],'DOC_INGEST_VERIFIED')
        self.assertEqual(result['revision'], self.rev)

    def test_native_receives_only_boolean_facts_and_index_order(self):
        seen = []
        def check(command, request, reference, **kw):
            seen.append((command, request, reference, kw))
            return reference
        with mock.patch.dict(os.environ, {'SINGULARITY_DOC_LEDGER_RUST_BINARY':'C:/compiled/evidence.exe'}):
            with mock.patch.object(mdi, '_rust_doc_policy', side_effect=check):
                result = mdi._entry_evidence(self.entry, self.source.name)
        self.assertEqual(result['status'],'DOC_INGEST_VERIFIED')
        self.assertEqual(len(seen),1)
        command, request, expected, kw = seen[0]
        self.assertEqual(command,'doc-index-evidence')
        self.assertEqual(kw['binary_env'],'SINGULARITY_DOC_LEDGER_RUST_BINARY')
        self.assertEqual(kw['args'],[])
        self.assertEqual(set(request),{'schema','active','hash_equal','indexed','verified','chunks_complete','revisions'})
        self.assertEqual(expected['verdict'],'verified')
        text = repr(request)
        for private in ('sensitive-source.md','Secret project','private-task','private-hash',
                        str(self.root),'id-private','private title',self.rev):
            self.assertNotIn(private,text)

    def test_native_error_fails_before_completion_claim(self):
        with mock.patch.dict(os.environ, {'SINGULARITY_DOC_LEDGER_RUST_BINARY':'C:/compiled/evidence.exe'}):
            with mock.patch.object(mdi, '_rust_doc_policy', side_effect=mdi.Blocked('native mismatch')):
                with self.assertRaisesRegex(mdi.Blocked,'native mismatch'):
                    mdi._entry_evidence(self.entry, self.source.name)

    def test_unresolved_revisions_and_hash_precedence(self):
        extra = {'status':'DOC_INGEST_PENDING','ingested_at':'2026-11-13T02:00:00Z',
                 'task_ids': ['secret'], 'hashes':['secret']}
        self.entry['revs']['second-secret'] = extra
        with mock.patch.dict(os.environ, {'SINGULARITY_DOC_LEDGER_RUST_BINARY':''}):
            result = mdi._entry_evidence(self.entry, self.source.name)
            self.assertEqual(result['status'],'DOC_INGEST_NOT_VERIFIED')
            self.assertIn('newer unresolved',result['reason'])
            self.source.write_text('# changed', encoding='utf-8')
            result = mdi._entry_evidence(self.entry,self.source.name)
            self.assertIn('stale hash',result['reason'])

    def test_over_revision_cap_fails_when_selected(self):
        for i in range(257):
            self.entry['revs'][f'future{i:03d}']={'status':'DOC_INGEST_PENDING'}
        with mock.patch.dict(os.environ, {'SINGULARITY_DOC_LEDGER_RUST_BINARY':'C:/compiled/evidence.exe'}):
            with self.assertRaisesRegex(mdi.Blocked,'revision limit'):
                mdi._entry_evidence(self.entry,self.source.name)


if __name__=='__main__': unittest.main()
