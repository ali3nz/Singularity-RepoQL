"""RepoQL query receipt Rust aggregation and private-field boundary tests."""
import json
import os
from pathlib import Path
import subprocess
import tempfile
import unittest
from unittest.mock import patch

from repo_query_usage import report, _native_checked_usage, EVENT_SCHEMA

NOW = 1793253600.0
ROOTS = ['C:/private/repository-one', 'C:/private/repository-two']


def event(eid, offset, roots=None, agent='worker', operation='find', **extra):
    return {'schema':EVENT_SCHEMA,'event_id':eid,'ts':NOW+offset,'operation':operation,
            'repo_roots':ROOTS if roots is None else roots,'agent':agent,**extra}


class QueryUsageRustBridge(unittest.TestCase):
    def setUp(self):
        self.temp=tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.root=Path(self.temp.name)
        self.file=self.root/'usage.jsonl'
        self.binary=self.root/'singularity-repoql-query-usage.exe'
        self.binary.write_bytes(b'fixture')
        self.events=[event('a',-5), event('b',-90000,[ROOTS[0]]),
                     event('dup',-20,[ROOTS[1]]),event('dup',-15,[ROOTS[0]]),
                     event('dashboard',-10,agent='repoql-dashboard'),
                     event('unmatched',-4,['C:/not-a-requested-repo']),
                     event('bad',-5,operation='index'),
                     event('f',10,[ROOTS[0]])]
        self.file.write_text('\n'.join(json.dumps(x) for x in self.events)+'\n')
        self.file.chmod(0o600)

    def test_reference_attribution_dedup_and_invalids(self):
        with patch.dict(os.environ,{'SINGULARITY_REPOQL_QUERY_USAGE_RUST_BINARY':''}):
            got=report(self.file,ROOTS,now=NOW)
        self.assertTrue(got['available'])
        self.assertEqual(got['accepted_events'],5)
        self.assertEqual(got['invalid_events'],1)
        self.assertEqual(got['calls']['1d'],3)
        self.assertEqual(got['unattributed']['1d'],1)
        self.assertEqual(got['repositories'][ROOTS[0]]['1d'],1)
        self.assertEqual(got['repositories'][ROOTS[1]]['1d'],2)
        self.assertEqual(got['coverage'],'partial-invalid-rows')
        self.assertTrue(got['counts_are_observed_lower_bounds'])

    def test_rust_receives_only_numeric_indices_and_exact_output(self):
        reference=report(self.file, ROOTS, now=NOW)
        assert reference['available']
        def fake_run(_args,**kwargs):
            request=json.loads(kwargs['input'])
            self.assertEqual(set(request), {'now','root_count','events'})
            self.assertEqual(request['root_count'],2)
            self.assertEqual(len(request['events']),5)
            self.assertNotIn(ROOTS[0],kwargs['input'])
            self.assertNotIn(ROOTS[1],kwargs['input'])
            self.assertNotIn('PRIVATE',kwargs['input'])
            self.assertNotIn('event_id',kwargs['input'])
            self.assertNotIn('agent',kwargs['input'])
            self.assertFalse(kwargs['shell'])
            self.assertEqual(kwargs['timeout'],15)
            output={
              'calls':reference['calls'],'unattributed':reference['unattributed'],
              'repositories':[reference['repositories'][root] for root in sorted(ROOTS)],
              'accepted_events':reference['accepted_events'],
              'earliest':NOW-90000,'latest':NOW+10}
            return subprocess.CompletedProcess([],0,json.dumps(output),'')
        with patch.dict(os.environ,{'SINGULARITY_REPOQL_QUERY_USAGE_RUST_BINARY':str(self.binary)}), \
             patch('repo_query_usage.subprocess.run',side_effect=fake_run) as run:
            native=report(self.file,ROOTS,now=NOW)
        self.assertEqual(native,reference)
        run.assert_called_once()

    def test_forgery_fails_closed_without_claiming_complete_history(self):
        malicious={'calls':{'1d':100000,'7d':100000,'30d':100000},
                   'unattributed':{'1d':0,'7d':0,'30d':0},
                   'repositories':[{'1d':1,'7d':1,'30d':1}]*2,
                   'accepted_events':100000,'earliest':NOW-100,'latest':NOW}
        with patch.dict(os.environ,{'SINGULARITY_REPOQL_QUERY_USAGE_RUST_BINARY':str(self.binary)}), \
             patch('repo_query_usage.subprocess.run',return_value=subprocess.CompletedProcess([],0,json.dumps(malicious),'')):
            got=report(self.file,ROOTS,now=NOW)
        self.assertFalse(got['available'])
        self.assertEqual(got['coverage'],'unverified')
        self.assertNotIn('calls',got)
        self.assertEqual(got['repositories'],{})

    def test_bad_binary_symlink_or_private_receipt_is_rejected(self):
        with patch.dict(os.environ,{'SINGULARITY_REPOQL_QUERY_USAGE_RUST_BINARY':'relative.exe'}):
            got=report(self.file,ROOTS,now=NOW)
        self.assertFalse(got['available'])
        self.assertNotIn('calls',got)
        self.file.chmod(0o644)
        got=report(self.file,ROOTS,now=NOW)
        self.assertFalse(got['available'])
        self.assertIn('unsafe world permissions',got['error'])
        self.file.chmod(0o600)
        alias=self.root/'alias.jsonl'
        try:
            alias.symlink_to(self.file)
        except (OSError,NotImplementedError):
            return
        self.assertIn('symlink',report(alias,ROOTS,now=NOW)['error'])

    def test_forged_or_oversized_projection_rejected(self):
        with patch.dict(os.environ,{'SINGULARITY_REPOQL_QUERY_USAGE_RUST_BINARY':str(self.binary)}):
            with self.assertRaisesRegex(RuntimeError,'repoql_query_usage_rust_input_too_large'):
                _native_checked_usage([],[[NOW,[]]]*200001,NOW,{})
            with patch('repo_query_usage.subprocess.run',return_value=subprocess.CompletedProcess([],0,'{}','')):
                with self.assertRaises(RuntimeError):
                    _native_checked_usage(ROOTS,[[NOW,[0]]],NOW,{})


if __name__=='__main__':unittest.main()
