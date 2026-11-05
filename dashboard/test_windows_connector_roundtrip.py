"""Hermetic fixed-loopback Tencent and Kanzo transport checks for Windows.

These fake services validate dashboard request/response shape only. They are
not Tencent or Kanzo application/connector compatibility certification.
"""
import json
import os
import tempfile
import threading
import unittest
from http.server import BaseHTTPRequestHandler, HTTPServer
from pathlib import Path
from unittest.mock import patch
from urllib.parse import urlsplit

import native_panel_proxy as panel
from native_readiness import _ping_kanzo
from test_office_proxy_roundtrip import FakeHandler

class TencentFake(BaseHTTPRequestHandler):
    def do_POST(self):
        data = self.rfile.read(int(self.headers.get('Content-Length','0')))
        self.server.calls.append((self.path, self.headers.get('X-Tdai-Service-Id'), json.loads(data)))
        payload = {'code':0,'data':{'valid':True, 'user':{'user_id':'synthetic',
           'username':'SyntheticUser','private_email':'must-not-leak', 'created_at':'2026-01-01'}}}
        content = json.dumps(payload).encode()
        self.send_response(200)
        self.send_header('Content-Type','application/json')
        self.send_header('Content-Length', str(len(content)))
        self.end_headers()
        self.wfile.write(content)
    def log_message(self, *_args): pass

class KanzoFake(BaseHTTPRequestHandler):
    def do_GET(self):
        result=b'kanzo' if self.path == '/api/ping' else b'unexpected'
        self.send_response(200 if result==b'kanzo' else 404)
        self.send_header('Content-Length', str(len(result)))
        self.end_headers()
        self.wfile.write(result)
    def log_message(self,*_args): pass

class ConnectorRoundtrip(unittest.TestCase):
    def test_tencent_authenticated_identity_is_scoped_and_sanitized(self):
        server=HTTPServer(('127.0.0.1',0),TencentFake)
        server.calls=[]
        thread=threading.Thread(target=server.serve_forever,daemon=True); thread.start()
        try:
            with tempfile.TemporaryDirectory() as root:
                key=Path(root)/'test-owner.key'; key.write_text('synthetic-user-key\n')
                with patch.dict(os.environ,{
                    'SINGULARITY_WINDOWS_NATIVE':'1',
                    'SINGULARITY_TENCENT_OWNER_KEY_FILE':str(key),
                },clear=True),patch.dict(panel.UPSTREAM,{'tencent':server.server_address}):
                    result=panel.tencent_session()
            self.assertTrue(result['authenticated'])
            self.assertEqual(result['user']['user_id'],'synthetic')
            self.assertNotIn('private_email',json.dumps(result))
            self.assertNotIn('synthetic-user-key',json.dumps(result))
            self.assertEqual(server.calls[0],('/api/v1/meta/auth/verify','default',{'user_key':'synthetic-user-key'}))
        finally:
            server.shutdown();server.server_close();thread.join(timeout=2)

    def test_kanzo_probe_and_mcp_route_prohibition(self):
        server=HTTPServer(('127.0.0.1',0),KanzoFake)
        thread=threading.Thread(target=server.serve_forever,daemon=True);thread.start()
        try:
            with patch.dict(panel.UPSTREAM,{'kanzo':server.server_address}):
                self.assertTrue(_ping_kanzo())
                handler=FakeHandler()
                panel.serve(handler,'kanzo','GET',urlsplit('/embed/kanzo/mcp'))
                self.assertEqual(handler.status,403)
                self.assertIn(b'kanzo_mcp_is_local_only',handler.wfile.getvalue())
        finally:
            server.shutdown();server.server_close();thread.join(timeout=2)

if __name__=='__main__':unittest.main()
