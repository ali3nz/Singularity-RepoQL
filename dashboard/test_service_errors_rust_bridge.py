"""Service error HTTP response parity; mocked native child is not compiled evidence."""
import json
import os
from pathlib import Path
import subprocess
import tempfile
import unittest
from types import SimpleNamespace
from unittest.mock import Mock, patch

from server import Handler
from service_error_projection import group_service_errors

RECORDS=[
    {'level':'ERR','msg':'Timeout worker 123','ts':'2026-01-03T03:00:00Z'},
    {'level':'WARN','msg':'Other issue','ts':'2026-01-02T02:00:00Z'},
    {'level':'FTL','msg':'Timeout worker 456','ts':'2026-01-04T04:00:00Z'},
    {'level':'ERR','msg':'Other issue','ts':'2026-01-04T04:00:00Z'},
]

class ServiceErrorsTests(unittest.TestCase):
    def setUp(self):
        tmp=tempfile.TemporaryDirectory();self.addCleanup(tmp.cleanup)
        self.binary=Path(tmp.name)/'safe.exe';self.binary.write_bytes(b'fixture')

    def test_default_reference_grouping_order_and_trailing_updates(self):
        expected=group_service_errors(RECORDS,1,2,rust_bin='')
        self.assertEqual(expected['total'],2)
        self.assertEqual([r['signature'] for r in expected['rows']],['Timeout worker #','Other issue'])
        self.assertEqual(expected['rows'][0]['count'],2)
        self.assertEqual(expected['rows'][0]['message'],RECORDS[0]['msg'])
        self.assertEqual(expected['rows'][0]['first_ts'],RECORDS[2]['ts'])
        self.assertEqual(expected['rows'][0]['level'],'FTL')
        self.assertEqual(group_service_errors(RECORDS,2,1,rust_bin='')['rows'][0]['message'],'Other issue')

    def test_opt_in_ordinal_only_and_empty_env(self):
        expected={'total':2,'groups':[{'group_index':0,'count':2,'last_event':2},
                                      {'group_index':1,'count':2,'last_event':3}]}
        mock=Mock(return_value=subprocess.CompletedProcess([],0,json.dumps(expected),''))
        with patch.dict(os.environ,{'SECRET_TOKEN':'private','SINGULARITY_DASHBOARD_SERVICE_ERRORS_RUST_BINARY':str(self.binary)}):
            response=group_service_errors(RECORDS,1,2,runner=mock)
        self.assertEqual(response['total'],2)
        _,options=mock.call_args
        self.assertNotIn('SECRET_TOKEN',options['env'])
        self.assertFalse(options['shell'])
        self.assertEqual(options['timeout'],8)
        self.assertEqual(json.loads(options['input'])['events'],[
            {'group':0,'time_rank':1},{'group':1,'time_rank':0},
            {'group':0,'time_rank':2},{'group':1,'time_rank':2}])
        for private in ('Timeout','Other issue','2026','private','message','source_uri'):
            self.assertNotIn(private,options['input'])

    def test_forgery_rejected(self):
        wrong=[{'total':2,'groups':[{'group_index':0,'count':1,'last_event':2}]},
               {'total':0,'groups':[]},[0,1]]
        for forged in wrong:
            with self.subTest(output=forged), self.assertRaisesRegex(RuntimeError,'parity_mismatch'):
                mock=Mock(return_value=subprocess.CompletedProcess([],0,json.dumps(forged),''))
                group_service_errors(RECORDS,1,2,rust_bin=self.binary,runner=mock)
        with self.assertRaisesRegex(RuntimeError,'execution_failed'):
            mock=Mock(return_value=subprocess.CompletedProcess([],2,'','fail'))
            group_service_errors(RECORDS,1,2,rust_bin=self.binary,runner=mock)

    def test_live_handler_invokes_projection_and_refuses_native_mismatch(self):
        class Rql:
            def log_tail(self):
                return RECORDS
            def failed_files(self, ttl):
                self.failed_calls.append(ttl)
                return []
            def __init__(self):
                self.failed_calls = []
        rql = Rql()
        handler = object.__new__(Handler)
        handler.app = SimpleNamespace(rql=rql)
        with patch('service_error_projection.group_service_errors', return_value={'total':2, 'rows':[{'signature':'sentinel'}]}) as mocked:
            output = handler.errors({'kind':'service', 'page':'1', 'page_size':'1'})
        self.assertEqual(output['rows'], [{'signature':'sentinel'}])
        self.assertEqual(output['total'], 2)
        self.assertEqual(output['summary'], {'service':2, 'indexing':0})
        self.assertEqual(mocked.call_args.args, (RECORDS, 1, 1))
        self.assertEqual(rql.failed_calls, [15.0])
        with patch('service_error_projection.group_service_errors', side_effect=RuntimeError('service_errors_native_parity_mismatch')):
            with self.assertRaisesRegex(RuntimeError, 'parity_mismatch'):
                handler.errors({'kind':'service', 'page':'1', 'page_size':'1'})
        self.assertEqual(rql.failed_calls, [15.0])

    def test_binary_guard_and_limits(self):
        with self.assertRaisesRegex(ValueError,'invalid_error_paging'):
            group_service_errors(RECORDS,0,1,rust_bin='')
        with self.assertRaisesRegex(RuntimeError,'binary_invalid'):
            group_service_errors(RECORDS,1,1,rust_bin='relative.exe')
        with self.assertRaisesRegex(RuntimeError,'input_too_large'):
            group_service_errors(RECORDS*2501,1,1,rust_bin=self.binary)

    def test_live_handler_with_service_filter_and_summary(self):
        class Rql:
            def log_tail(self):
                return RECORDS+[{'level':'INF','msg':'Ignore 1','ts':'2026-01-01T00:00:00Z'}]
            def failed_files(self,ttl):
                assert ttl==15.0;return [{'uri':'local:///one'}]
        h=object.__new__(Handler);h.app=SimpleNamespace(rql=Rql())
        response=h.errors({'kind':'service','q':'timeout','page':'1','page_size':'5'})
        self.assertEqual(response['total'],1)
        self.assertEqual(response['rows'][0]['count'],2)
        self.assertEqual(response['summary'],{'service':1,'indexing':1})

if __name__=='__main__':unittest.main()
