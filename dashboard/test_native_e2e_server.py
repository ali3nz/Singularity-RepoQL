"""Real dashboard HTTP -> synthetic loopback services integration regression.

This launches the actual Python dashboard server and verifies that a browser
session crosses the real Office/Tencent/Kanzo proxy boundaries safely. These
synthetic backends are NOT native Windows/service feature parity evidence.
"""
from __future__ import annotations
import contextlib
import http.client
import json
import os
from pathlib import Path
import tempfile
import threading
import unittest
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from unittest.mock import patch

from repoql_bridge import Config
from server import build_server
import native_panel_proxy as panels

TOKEN = 'm22-test-secret-is-never-sent-to-browser'
TENCENT_KEY = 'm22-test-tencent-owner-key'

class Backend(BaseHTTPRequestHandler):
    def log_message(self, *_args): pass
    def send(self, code, data, ctype='application/json'):
        self.send_response(code)
        self.send_header('Content-Type', ctype)
        self.send_header('Content-Length', str(len(data)))
        self.end_headers()
        self.wfile.write(data)
    def do_GET(self):
        self.server.requests.append(('GET', self.path, self.headers.get('X-API-Key')))
        if self.server.kind == 'kanzo':
            self.send(200 if self.path in ('/api/ping','/') else 404, b'kanzo' if self.path == '/api/ping' else b'Kanzo smoke page', 'text/plain')
        elif self.server.kind == 'office':
            if self.path in ('/go-to-room', '/offsite', '/redirect-capability'):
                locations={'/go-to-room':'/rooms/modern?room=modern', '/offsite':'https://untrusted.example.invalid/steal',
                           '/redirect-capability':f'http://127.0.0.1:{self.server.server_port}/rooms/modern?token={TOKEN}&room=modern'}
                self.send_response(302)
                self.send_header('Location',locations[self.path])
                self.send_header('Content-Length',str(len(TOKEN)))
                self.end_headers()
                self.wfile.write(TOKEN.encode())
            else:
                self.send(200, b'<html><head></head><body>Office integration smoke</body></html>', 'text/html')
        else:
            self.send(404, b'{}')
    def do_POST(self):
        body = self.rfile.read(int(self.headers.get('Content-Length', '0')))
        self.server.requests.append(('POST', self.path, self.headers.get('X-API-Key'), body))
        if self.server.kind == 'tencent' and self.path == '/api/v1/meta/auth/verify':
            if json.loads(body).get('user_key') != TENCENT_KEY:
                self.send(403, b'{}')
            else:
                self.send(200, json.dumps({'code': 0, 'data': {'valid': True, 'user': {'user_id': 'test-user', 'username': 'Test', 'private_email': 'MUST_NOT_LEAK'}}}).encode())
        elif self.server.kind == 'office':
            self.send(200, b'{"ok":true}')
        else:
            self.send(404, b'{}')

@contextlib.contextmanager
def local_server(handler=Backend, kind='dashboard'):
    server = ThreadingHTTPServer(('127.0.0.1', 0), handler)
    server.kind = kind
    server.requests = []
    thread = threading.Thread(target=server.serve_forever, daemon=True)
    thread.start()
    try:
        yield server
    finally:
        server.shutdown()
        server.server_close()
        thread.join(timeout=3)

def request(port, method, url, *, headers=None, data=None):
    conn = http.client.HTTPConnection('127.0.0.1', port, timeout=4)
    try:
        conn.request(method, url, body=data, headers=headers or {})
        response = conn.getresponse()
        return response.status, dict(response.getheaders()), response.read()
    finally:
        conn.close()

class RealDashboardBoundaries(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        key = Path(self.temp.name)/'tencent-owner.key'
        key.write_text(TENCENT_KEY, encoding='utf-8')
        env = {
            'SINGULARITY_WINDOWS_NATIVE':'1',
            'SINGULARITY_INSTALL_VARIANT':'2',
            'CLAUDE_OFFICE_PUBLIC_URL':'https://office.example.test',
            'CLAUDE_OFFICE_EMBED_URL':f'https://office.example.test/?token={TOKEN}&embed=1',
            'SINGULARITY_TENCENT_OWNER_KEY_FILE':str(key),
        }
        self.env = patch.dict(os.environ, env, clear=True)
        self.env.start()
        self.addCleanup(self.env.stop)
        self.backends = contextlib.ExitStack()
        self.addCleanup(self.backends.close)
        self.office = self.backends.enter_context(local_server(kind='office'))
        self.tencent = self.backends.enter_context(local_server(kind='tencent'))
        self.kanzo = self.backends.enter_context(local_server(kind='kanzo'))
        self.upstreams = patch.dict(panels.UPSTREAM, {
            'office': ('127.0.0.1', self.office.server_port),
            'tencent': ('127.0.0.1', self.tencent.server_port),
            'kanzo': ('127.0.0.1', self.kanzo.server_port),
        })
        self.upstreams.start()
        self.addCleanup(self.upstreams.stop)
        config = Config(workspace=Path(self.temp.name), rql=Path('/nonexistent/rql'),
                        state_dir=Path(self.temp.name)/'state', bind='127.0.0.1', port=0)
        self.dashboard = self.backends.enter_context(local_server_placeholder(config))
        self.port = self.dashboard.server_port
        self.auth = {'Authorization': 'Bearer '+self.dashboard.RequestHandlerClass.app.token}

    def test_rust_route_selection_runs_only_after_authentication(self):
        with patch('server.classify_dashboard_route', return_value='read_features') as classify:
            status, _, _ = request(self.port, 'GET', '/api/features')
            self.assertEqual(status, 401)
            classify.assert_not_called()
            status, _, body = request(self.port, 'GET', '/api/features', headers=self.auth)
            self.assertEqual(status, 200)
            self.assertEqual(json.loads(body)['variant'], 2)
            classify.assert_called_once_with('GET', '/api/features')

    def test_real_listener_panel_cookies_cannot_cross_audiences(self):
        for label in ('office','tencent','kanzo'):
            status, headers, body = request(self.port, 'GET',f'/api/embed/{label}/handshake', headers=self.auth)
            self.assertEqual(status, 200, label)
            self.assertEqual(json.loads(body), {'ready':True})
            cookie = headers['Set-Cookie'].split(';',1)[0]
            self.assertNotIn(TOKEN, cookie)
            self.assertNotIn(TENCENT_KEY, cookie)
            status, _, body = request(self.port, 'GET',f'/embed/{label}/'+('api/v1/auth/session' if label=='tencent' else ''),headers={'Cookie':cookie})
            self.assertEqual(status, 200, (label, body[:300]))
            self.assertNotIn(TOKEN.encode(), body)
            self.assertNotIn(TENCENT_KEY.encode(), body)
            if label == 'tencent':
                self.assertNotIn(b'MUST_NOT_LEAK',body)
                self.assertTrue(json.loads(body)['authenticated'])
            other = 'kanzo' if label != 'kanzo' else 'office'
            status, _, _ = request(self.port,'GET',f'/embed/{other}/',headers={'Cookie':cookie})
            self.assertEqual(status, 401, ('wrong cookie audience', label, other))

    def test_office_redirect_preserves_panel_and_strips_credential(self):
        status, headers, body = request(self.port,'GET','/embed/office/go-to-room',headers=self.auth)
        self.assertEqual(status,302)
        self.assertEqual(headers.get('Location'),'/embed/office/rooms/modern?room=modern')
        self.assertEqual(body,b'')
        status, headers, body = request(self.port,'GET','/embed/office/redirect-capability',headers=self.auth)
        self.assertEqual(status,302)
        self.assertEqual(headers.get('Location'),'/embed/office/rooms/modern?room=modern')
        self.assertNotIn(TOKEN,repr(headers))
        self.assertEqual(body,b'')
        status, headers, body = request(self.port,'GET','/embed/office/offsite',headers=self.auth)
        self.assertEqual(status,502)
        self.assertNotIn('Location',headers)
        self.assertIn(b'upstream_redirect_refused',body)

    def test_real_listener_requires_auth_and_never_exposes_kanzo_mcp(self):
        for label in ('office','tencent','kanzo'):
            status, _, _ = request(self.port,'GET',f'/api/embed/{label}/handshake')
            self.assertEqual(status, 401)
        status, _, body = request(self.port, 'GET','/embed/kanzo/mcp',headers=self.auth)
        self.assertEqual(status,403)
        self.assertIn(b'kanzo_mcp_is_local_only',body)
        status, _, _ = request(self.port,'GET','/.well-known/singularity-health')
        self.assertEqual(status, 200)

    def test_real_listener_office_token_upstream_only_and_browser_origin_checked(self):
        status, _, body = request(self.port, 'GET', '/embed/office/',headers=self.auth)
        self.assertEqual(status,200)
        self.assertNotIn(TOKEN.encode(), body)
        self.assertTrue(any(row[2] == TOKEN for row in self.office.requests))
        header = dict(self.auth, Origin='https://not-dashboard.example')
        status, _, _ = request(self.port,'POST','/embed/office/api/v1/events',headers=header,data=b'{}')
        self.assertEqual(status,403)
        self.assertFalse(any(row[0]=='POST' for row in self.office.requests))

@contextlib.contextmanager
def local_server_placeholder(config):
    # Use the actual application and Handler, never a fake dashboard handler.
    server=build_server(config)
    thread=threading.Thread(target=server.serve_forever,daemon=True)
    thread.start()
    try:yield server
    finally:server.shutdown();server.server_close();thread.join(timeout=3)

if __name__=='__main__':unittest.main()
