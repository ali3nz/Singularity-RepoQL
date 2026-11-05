"""Hermetic real-HTTP check of Windows Office token URL -> authenticated proxy.

No production Office process or credential is accessed. This verifies the
actual proxy transport on loopback instead of mocking its HTTP response.
"""
import io
import os
import threading
import unittest
from http.server import BaseHTTPRequestHandler, HTTPServer
from types import SimpleNamespace
from unittest.mock import patch
from urllib.parse import urlsplit

import native_panel_proxy as panel

TOKEN = 'synthetic-m10-only-secret'

class OfficeUpstream(BaseHTTPRequestHandler):
    def do_GET(self):
        self.server.received.append(('GET', self.path, self.headers.get('X-API-Key')))
        body = b'<html><head></head><body>Office ready</body></html>'
        self.send_response(200)
        self.send_header('Content-Type', 'text/html; charset=utf-8')
        self.send_header('Content-Length', str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def do_POST(self):
        content = self.rfile.read(int(self.headers.get('Content-Length','0')))
        self.server.received.append(('POST', self.path, self.headers.get('X-API-Key'), content))
        body = b'{"ok":true}'
        self.send_response(200)
        self.send_header('Content-Type','application/json')
        self.send_header('Content-Length', str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def log_message(self, *_args):
        return

class FakeHandler:
    def __init__(self, method='GET', data=b''):
        self.headers = {'Content-Length': str(len(data)), 'Content-Type':'application/json'}
        self.rfile = io.BytesIO(data)
        self.wfile = io.BytesIO()
        self.status = None
        self.response_headers = {}
        self.app = SimpleNamespace(token='dashboard-test-token')
        self._method = method

    def authorized(self): return True
    def bearer_authorized(self): return True
    def request_origin_allowed(self, **_kwargs): return True
    def send_response(self, code): self.status = code
    def send_header(self, name, value): self.response_headers[name] = value
    def end_headers(self): pass
    def send_json(self, code, content):
        self.status = code
        self.wfile.write(str(content).encode())

class OfficeProxyRoundtrip(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.server = HTTPServer(('127.0.0.1', 0), OfficeUpstream)
        cls.server.received = []
        cls.thread = threading.Thread(target=cls.server.serve_forever, daemon=True)
        cls.thread.start()

    @classmethod
    def tearDownClass(cls):
        cls.server.shutdown()
        cls.server.server_close()
        cls.thread.join(timeout=2)

    def test_windows_office_get_post_include_token_only_upstream(self):
        env = {
            'SINGULARITY_WINDOWS_NATIVE':'1',
            'CLAUDE_OFFICE_PUBLIC_URL':'https://office.example.test',
            'CLAUDE_OFFICE_EMBED_URL':f'https://office.example.test/?token={TOKEN}&embed=1',
        }
        with patch.dict(os.environ, env, clear=True), patch.dict(panel.UPSTREAM, {'office':self.server.server_address}):
            self.server.received.clear()
            get = FakeHandler()
            panel.serve(get, 'office', 'GET', urlsplit('/embed/office/?embed=1'))
            self.assertEqual(get.status, 200)
            self.assertEqual(self.server.received[0], ('GET','/?embed=1',TOKEN))
            response = get.wfile.getvalue()
            self.assertIn(b'/_transport.js', response)
            self.assertNotIn(TOKEN.encode(), response)
            self.assertEqual(get.response_headers['Cache-Control'], 'no-store')
            post = FakeHandler('POST', b'{"event_type":"session_start"}')
            panel.serve(post, 'office', 'POST', urlsplit('/embed/office/api/v1/events'))
            self.assertEqual(post.status, 200)
            self.assertEqual(self.server.received[1][0:3], ('POST','/api/v1/events',TOKEN))
            self.assertIn(b'session_start', self.server.received[1][3])
            self.assertNotIn(TOKEN.encode(), post.wfile.getvalue())

    def test_office_non_https_config_fails_before_upstream(self):
        with patch.dict(os.environ, {
            'SINGULARITY_WINDOWS_NATIVE':'1',
            'CLAUDE_OFFICE_PUBLIC_URL':'https://office.example.test',
            'CLAUDE_OFFICE_EMBED_URL':f'http://office.example.test/?token={TOKEN}&embed=1',
        }, clear=True), patch.dict(panel.UPSTREAM, {'office':self.server.server_address}):
            self.server.received.clear()
            handler=FakeHandler()
            with self.assertRaises(PermissionError):
                panel.serve(handler,'office','GET',urlsplit('/embed/office/'))
            self.assertEqual(self.server.received, [])

if __name__ == '__main__': unittest.main()
