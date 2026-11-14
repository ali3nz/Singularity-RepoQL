"""Indexing error API boundary and optional native ordering tests."""
import json
import os
from pathlib import Path
import subprocess
import tempfile
import unittest
from types import SimpleNamespace
from unittest.mock import Mock, patch

from server import Handler
from indexing_error_projection import project_indexing_errors

ITEMS = [
    {'timestamp':'2026-01-03','uri':'local://private/a','message':'secret A'},
    {'timestamp':None,'uri':'local://private/b','message':'secret B'},
    {'timestamp':'2026-01-04','uri':'local://private/c','message':'secret C'},
    {'timestamp':'2026-01-04','uri':'local://private/d','message':'secret D'},
]

class IndexingErrorsBridgeTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.binary = Path(self.temp.name) / 'indexing.exe'
        self.binary.write_bytes(b'fixture')

    def test_stable_paging_preserves_original_metadata(self):
        self.assertEqual(project_indexing_errors(ITEMS,1,3,rust_bin=''),
                         {'total':4,'rows':[ITEMS[2],ITEMS[3],ITEMS[0]]})
        self.assertEqual(project_indexing_errors(ITEMS,2,2,rust_bin='')['rows'],
                         [ITEMS[0],ITEMS[1]])
        self.assertEqual(project_indexing_errors([],1,2,rust_bin=''),
                         {'total':0,'rows':[]})

    def test_opt_in_transmits_only_numeric_ranks(self):
        output = {'total':4,'indices':[2,3,0]}
        runner = Mock(return_value=subprocess.CompletedProcess([],0,json.dumps(output),''))
        with patch.dict(os.environ,{'SECRET_TOKEN':'hidden',
                    'SINGULARITY_DASHBOARD_INDEXING_ERRORS_RUST_BINARY':str(self.binary)}):
            self.assertEqual(project_indexing_errors(ITEMS,1,3,runner=runner)['rows'],
                             [ITEMS[2],ITEMS[3],ITEMS[0]])
        args,kwargs = runner.call_args
        self.assertFalse(kwargs['shell'])
        self.assertEqual(kwargs['timeout'],8)
        self.assertEqual(kwargs['env'].get('SECRET_TOKEN'),None)
        self.assertEqual(json.loads(kwargs['input'])['ranks'],[1,0,2,2])
        for private in ('secret','private','local://','2026','uri','message'):
            self.assertNotIn(private,kwargs['input'])

    def test_native_mismatch_and_execution_failure_fail_closed(self):
        for forged in ({'total':4,'indices':[0,1,2]},
                       {'total':4,'indices':[2,2,0]},
                       {'total':4,'indices':[]},
                       [2,3,0]):
            with self.subTest(result=forged),self.assertRaisesRegex(RuntimeError,'parity_mismatch'):
                runner=Mock(return_value=subprocess.CompletedProcess([],0,json.dumps(forged),''))
                project_indexing_errors(ITEMS,1,3,rust_bin=self.binary,runner=runner)
        with self.assertRaisesRegex(RuntimeError,'execution_failed'):
            runner=Mock(return_value=subprocess.CompletedProcess([],7,'','fail'))
            project_indexing_errors(ITEMS,1,3,rust_bin=self.binary,runner=runner)

    def test_binary_path_and_paging_validation(self):
        for page,size in ((0,1),(1,201),(-1,3),(True,1),(1,True)):
            with self.subTest(page=page,size=size),self.assertRaises(ValueError):
                project_indexing_errors(ITEMS,page,size,rust_bin='')
        with self.assertRaisesRegex(RuntimeError,'binary_invalid'):
            project_indexing_errors(ITEMS,1,2,rust_bin='relative.exe')
        with self.assertRaisesRegex(RuntimeError,'input_too_large'):
            project_indexing_errors(ITEMS*2501,1,2,rust_bin=self.binary)

    def test_handler_filter_order_summary_and_native_rejection(self):
        class Rql:
            def __init__(self): self.ttls=[]
            def failed_files(self,ttl):
                self.ttls.append(ttl)
                return [
                    {'stage':'index','uri':'local://first','error':'first err',
                     'failures':3,'transitioned_at':'2026-02-02'},
                    {'stage':'index','uri':'local://second','error':'second err',
                     'failures':1,'transitioned_at':'2026-02-03'}]
            def queue(self):
                return [{'stage':'queue','uri':'local://last','error':'last err',
                         'failures':2,'status':'pending','enqueued_at':'2026-02-03'},
                        {'uri':'ignored','error':''}]
        rql=Rql(); handler=object.__new__(Handler)
        handler.app=SimpleNamespace(rql=rql)
        response=handler.errors({'kind':'indexing','page':'1','page_size':'2'})
        self.assertEqual(response['total'],3)
        self.assertEqual([x['uri'] for x in response['rows']],['local://second','local://last'])
        self.assertEqual(response['summary'],{'indexing':3,'service':None})
        filtered=handler.errors({'kind':'indexing','q':'last','page':'1','page_size':'3'})
        self.assertEqual([x['uri'] for x in filtered['rows']],['local://last'])
        with patch('indexing_error_projection.project_indexing_errors',
                   side_effect=RuntimeError('indexing_errors_native_parity_mismatch')):
            with self.assertRaisesRegex(RuntimeError,'parity_mismatch'):
                handler.errors({'kind':'indexing','page':'1','page_size':'1'})
        self.assertEqual(rql.ttls,[10.0,10.0,10.0])

if __name__=='__main__': unittest.main()
