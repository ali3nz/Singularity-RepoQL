"""Contract tests for non-certifying, evidence-bounded acceptance inventory."""
from pathlib import Path
import hashlib
import json
import sys
import tempfile
import unittest
sys.path.insert(0,str(Path(__file__).parent))
from claude_complete_acceptance_matrix import matrix, GATES, SCHEMA, RECEIPT_SCHEMA

class MatrixTests(unittest.TestCase):
    def setUp(self):
        t=tempfile.TemporaryDirectory()
        self.addCleanup(t.cleanup)
        self.dir=Path(t.name)

    def receipt(self, gate, *, result='PASS', source='a'*40):
        content=b'REDACTED TEST EVIDENCE: synthetic fixture only\n'
        name=gate+'.log'
        (self.dir/name).write_bytes(content)
        p={'schema':RECEIPT_SCHEMA,'gate':gate,'result':result,'source_commit':source,
           'evidence_name':name,'evidence_sha256':hashlib.sha256(content).hexdigest()}
        (self.dir/(gate+'.json')).write_text(json.dumps(p))
        return p

    def test_default_all_not_run(self):
        out=matrix()
        self.assertEqual(out['schema'],SCHEMA)
        self.assertEqual(out['required_gates'],len(GATES))
        self.assertEqual(out['not_run'],len(GATES))
        self.assertFalse(out['release_ready'])
        self.assertFalse(out['all_live_tests_independently_verified'])

    def test_one_reported_pass_not_release(self):
        self.receipt(GATES[0])
        out=matrix(self.dir)
        self.assertEqual(out['reported_pass_unreviewed'],1)
        self.assertEqual(out['not_run'],len(GATES)-1)
        self.assertEqual(out['gate_results'][0]['status'],'REPORTED_PASS_UNREVIEWED')
        self.assertFalse(out['release_ready'])
        self.assertNotIn('REDACTED',json.dumps(out))
        self.assertNotIn(str(self.dir),json.dumps(out))

    def test_one_reported_fail(self):
        self.receipt(GATES[-1],result='FAIL')
        out=matrix(self.dir)
        self.assertEqual(out['reported_fail'],1)
        self.assertFalse(out['release_ready'])

    def test_all_reported_pass_still_not_certified(self):
        for g in GATES: self.receipt(g)
        out=matrix(self.dir)
        self.assertEqual(out['not_run'],0)
        self.assertEqual(out['reported_pass_unreviewed'],len(GATES))
        self.assertFalse(out['release_ready'])

    def test_mixed_source_revisions_flagged(self):
        self.receipt(GATES[0],source='a'*40)
        self.receipt(GATES[1],source='b'*40)
        self.assertTrue(matrix(self.dir)['mixed_source_revisions'])

    def test_hash_mismatch_rejected(self):
        p=self.receipt(GATES[0])
        (self.dir/p['evidence_name']).write_text('tampered')
        with self.assertRaisesRegex(ValueError,'GATE_EVIDENCE_HASH_MISMATCH'):
            matrix(self.dir)

    def test_bad_schema_refused(self):
        p=self.receipt(GATES[0]);p['result']='NOT_RUN'
        (self.dir/(GATES[0]+'.json')).write_text(json.dumps(p))
        with self.assertRaisesRegex(ValueError,'GATE_RECEIPT_SCHEMA_OR_SCOPE_INVALID'):
            matrix(self.dir)

    def test_unknown_fields_refused(self):
        p=self.receipt(GATES[0]);p['token']='SENSITIVE'
        (self.dir/(GATES[0]+'.json')).write_text(json.dumps(p))
        with self.assertRaisesRegex(ValueError,'GATE_RECEIPT_SCHEMA_OR_SCOPE_INVALID'):
            matrix(self.dir)

    def test_evidence_path_traversal_refused(self):
        p=self.receipt(GATES[0]);p['evidence_name']='../secret.txt'
        (self.dir/(GATES[0]+'.json')).write_text(json.dumps(p))
        with self.assertRaisesRegex(ValueError,'GATE_RECEIPT_SCHEMA_OR_SCOPE_INVALID'):
            matrix(self.dir)

    def test_symlink_evidence_refused(self):
        p=self.receipt(GATES[0]); target=self.dir/p['evidence_name'];target.unlink()
        try:target.symlink_to(self.dir/'elsewhere')
        except OSError:self.skipTest('symlinks unavailable')
        with self.assertRaisesRegex(ValueError,'REPARSE_EVIDENCE_PATH_REFUSED'):
            matrix(self.dir)

    def test_missing_evidence_is_error(self):
        p=self.receipt(GATES[0]);(self.dir/p['evidence_name']).unlink()
        with self.assertRaises(FileNotFoundError):matrix(self.dir)

if __name__=='__main__':unittest.main()
