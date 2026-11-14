"""Repository summary parity tests. Mock child is not compiled Rust evidence."""
from pathlib import Path
import json
import os
import subprocess
import tempfile
import unittest
from types import SimpleNamespace
from unittest.mock import Mock, patch

from repository_projection import project_repositories
from server import App

ROWS = [
    {'state':None,'available':True,'file_count':10,'indexed_count':9},
    {'state':'served','available':False,'file_count':5,'indexed_count':5},
    {'state':'pending','available':True,'file_count':4,'indexed_count':4},
]

class ProjectionTests(unittest.TestCase):
    def setUp(self):
        self.t = tempfile.TemporaryDirectory()
        self.addCleanup(self.t.cleanup)
        self.bin = Path(self.t.name) / 'native.exe'
        self.bin.write_bytes(b'fixture')
        self.failed = [0,0,2]
        self.exclusions = [0,1,1]
        self.expected = project_repositories(ROWS,self.failed,self.exclusions,rust_bin='')

    def test_default_accounting(self):
        self.assertEqual(self.expected, [
            {'failed':2,'excluded':1,'status_code':'errors'},
            {'failed':0,'excluded':2,'status_code':'unavailable'},
            {'failed':1,'excluded':0,'status_code':'override'}])
        self.assertEqual(project_repositories(ROWS,self.failed,self.exclusions),self.expected)

    def test_opt_in_exact_parity_sends_no_identity(self):
        fake = Mock(return_value=subprocess.CompletedProcess([],0,json.dumps(self.expected),''))
        with patch.dict(os.environ, {'SINGULARITY_REPOSITORY_SUMMARY_RUST_BINARY':str(self.bin),
                                     'PRIVATE_API_KEY':'PRIVATE'}):
            got = project_repositories(ROWS,self.failed,self.exclusions,runner=fake)
        self.assertEqual(got,self.expected)
        argv,opts=fake.call_args
        self.assertEqual(argv,([str(self.bin)],))
        self.assertEqual(opts['timeout'],8)
        self.assertFalse(opts['shell'])
        self.assertNotIn('PRIVATE_API_KEY',opts['env'])
        request=json.loads(opts['input'])
        self.assertEqual(request['rows'][2]['override'],True)
        self.assertNotIn('pending', opts['input'])
        self.assertNotIn('root', opts['input'])
        self.assertNotIn('directory', opts['input'])
        self.assertNotIn('PRIVATE',opts['input'])

    def test_native_forgery_or_execution_failure_blocks(self):
        for output,rc in ((json.dumps(self.expected[:-1]),0),
                          (json.dumps([{**self.expected[0], 'status_code':'indexed'},*self.expected[1:]]),0),
                          ('not json',0), ('',2)):
            with self.subTest(output=output):
                fake=Mock(return_value=subprocess.CompletedProcess([],rc,output,''))
                with self.assertRaisesRegex(RuntimeError,'native_'):
                    project_repositories(ROWS,self.failed,self.exclusions,rust_bin=self.bin,runner=fake)

    def test_no_silent_trust_of_unbounded_data(self):
        for count in (True,-1,'10',10**13):
            with self.subTest(count=count), self.assertRaisesRegex(RuntimeError,'invalid_count'):
                project_repositories([dict(ROWS[0],file_count=count)],[],[],rust_bin=self.bin)
        with self.assertRaisesRegex(RuntimeError,'binary_invalid'):
            project_repositories(ROWS,[],[],rust_bin='relative.exe')
        with self.assertRaisesRegex(RuntimeError,'invalid_index'):
            project_repositories(ROWS,[3],[],rust_bin=self.bin)
        with self.assertRaisesRegex(RuntimeError,'input_too_large'):
            project_repositories(ROWS,[0]*20001,[],rust_bin=self.bin)
        link=self.bin.parent/'link.exe'
        try: link.symlink_to(self.bin)
        except OSError: return
        with self.assertRaisesRegex(RuntimeError,'binary_invalid'):
            project_repositories(ROWS,[],[],rust_bin=link)

    def test_full_repo_rows_with_longest_root_and_duplicate_mounts(self):
        from tempfile import TemporaryDirectory
        with TemporaryDirectory() as folder:
            app=object.__new__(App)
            class Rql:
                def imports(self): return {'imports':[
                    {'root':'local://one','directory':folder,'state':'served'},
                    {'root':'local://one/project','directory':folder,'state':'served'},
                    {'root':'local://one','directory':folder,'state':'other'}]}
                def filesystems(self): return [
                    {'source_uri':'local://one','file_count':5,'indexed_count':4},
                    {'source_uri':'local://one/project','file_count':1,'indexed_count':1}]
                def failed_files(self,ttl): return [
                    {'uri':'local://one/project/error'},
                    {'uri':'local://one/missing'},
                    {'uri':'local://one/project/error2'}]
            app.rql=Rql()
            app.exclusions=SimpleNamespace(load=lambda:[
                {'mount_root':'local://one'}, {'mount_root':'local://one/project'}])
            app.activity=lambda:{'mounts':{}}
            with patch.dict(os.environ,{'SINGULARITY_REPOSITORY_SUMMARY_RUST_BINARY':''}):
                result=app.repo_rows()['repositories']
            self.assertEqual([(r['failed'],r['excluded'],r['status']) for r in result],
                             [(1,1,'errors'),(2,1,'errors'),(0,1,'other')])

if __name__=='__main__': unittest.main()
