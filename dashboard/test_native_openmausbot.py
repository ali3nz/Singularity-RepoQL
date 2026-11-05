import json
import os
from pathlib import Path
import tempfile
import threading
import unittest
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from unittest.mock import patch
import sys

sys.path.insert(0, str(Path(__file__).resolve().parent))
from native_openmausbot import overview


class MockOMB(BaseHTTPRequestHandler):
    requested = []
    def log_message(self, *_): pass
    def do_GET(self):
        self.requested.append(self.path)
        data = ({'app':'openmausbot'} if self.path == '/api/health'
                else {'bots':[{'id':'bot_A','name':'Alpha','busy':True,'threadId':'thread_A'},
                              {'id':'bad/id','name':'Unsafe'}]})
        raw=json.dumps(data).encode()
        self.send_response(200)
        self.send_header('Content-Type','application/json')
        self.send_header('Content-Length',str(len(raw)))
        self.end_headers(); self.wfile.write(raw)


class NativeOpenMausBotTest(unittest.TestCase):
    def test_local_only_read_and_truthful_external_states(self):
        MockOMB.requested=[]
        srv=ThreadingHTTPServer(('127.0.0.1',0),MockOMB)
        th=threading.Thread(target=srv.serve_forever,daemon=True);th.start()
        try:
            with tempfile.TemporaryDirectory() as td, patch.dict(os.environ,{
                'SINGULARITY_WINDOWS_NATIVE':'1','SINGULARITY_WINDOWS_OMB_PORT':str(srv.server_address[1])}):
                result=overview(Path(td))
                self.assertTrue(result['available'])
                self.assertEqual(result['total'],2)
                self.assertEqual(len(result['bots']),1)
                self.assertTrue(result['bots'][0]['working'])
                self.assertEqual(result['bots'][0]['duo'],'not_verified')
                self.assertEqual(MockOMB.requested,['/api/health','/api/bots?messages=0'])
        finally:
            srv.shutdown();srv.server_close();th.join(timeout=2)

    def test_no_remote_fallback(self):
        with tempfile.TemporaryDirectory() as td, patch.dict(os.environ,{
            'SINGULARITY_WINDOWS_NATIVE':'1','SINGULARITY_WINDOWS_OMB_PORT':'0'}):
            self.assertEqual(overview(Path(td))['reason'],'invalid_local_port')
        with tempfile.TemporaryDirectory() as td, patch.dict(os.environ,{'SINGULARITY_WINDOWS_NATIVE':'0'}):
            self.assertEqual(overview(Path(td))['reason'],'windows_native_only')


if __name__=='__main__': unittest.main()
