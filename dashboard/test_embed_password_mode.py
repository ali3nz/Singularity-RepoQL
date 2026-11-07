"""Password-mode embed integration: official RepoQL dashboard + gateway panels.

Proves, against a real dashboard listener:
  * anonymous requests to the RepoQL embed and every gateway-backed panel are
    rejected with 401 in password mode (no cookie, no bearer);
  * an authenticated same-origin dashboard session reaches each panel handshake
    and each panel through the dashboard's own cookie-audience boundary;
  * RepoQL's embed handshake issues its short-lived launch cookie only for an
    authenticated same-origin caller. The upstream RepoQL login issuance is the
    one external account step and is stubbed here (it needs the vendor login).

No fleet endpoint, no production credential: every backend is a synthetic
loopback server bound on port 0 and the account lives in a temp directory.
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
import repoql_native_auth

TENCENT_KEY = 'p2-test-tencent-owner-key'
LAUNCH_COOKIE = 'repoql_native_launch'


class Backend(BaseHTTPRequestHandler):
    def log_message(self, *_args):
        pass

    def _send(self, code, data, ctype='application/json'):
        self.send_response(code)
        self.send_header('Content-Type', ctype)
        self.send_header('Content-Length', str(len(data)))
        self.end_headers()
        self.wfile.write(data)

    def do_GET(self):
        self.server.requests.append(('GET', self.path))
        if self.server.kind == 'kanzo':
            if self.path == '/api/ping':
                self._send(200, b'kanzo', 'text/plain')
            else:
                self._send(200, b'<html><body>Kanzo</body></html>', 'text/html')
        elif self.server.kind == 'office':
            self._send(200, b'<html><body>Office</body></html>', 'text/html')
        elif self.server.kind == 'tencent':
            if self.path == '/':
                self._send(200, b'<html><body>MemoryPanel</body></html>', 'text/html')
            else:
                self._send(404, b'{}')
        else:
            self._send(404, b'{}')

    def do_POST(self):
        body = self.rfile.read(int(self.headers.get('Content-Length', '0')))
        self.server.requests.append(('POST', self.path, body))
        if self.server.kind == 'tencent' and self.path == '/api/v1/meta/auth/verify':
            if json.loads(body).get('user_key') != TENCENT_KEY:
                self._send(403, b'{}')
                return
            self._send(200, json.dumps({
                'code': 0,
                'data': {'valid': True, 'user': {'user_id': 'p2-user', 'username': 'P2'}},
            }).encode())
            return
        self._send(200, b'{"ok":true}')


@contextlib.contextmanager
def loopback(handler=Backend, kind='dashboard'):
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
    conn = http.client.HTTPConnection('127.0.0.1', port, timeout=5)
    try:
        conn.request(method, url, body=data, headers=headers or {})
        response = conn.getresponse()
        raw = response.getheaders()
        headers = dict(raw)
        cookies = [value for name, value in raw if name.lower() == 'set-cookie']
        if cookies:
            headers['Set-Cookie'] = '|'.join(cookies)
        return response.status, headers, response.read()
    finally:
        conn.close()


class PasswordModeEmbedBoundary(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        root = Path(self.temp.name)
        key = root / 'tencent-owner.key'
        key.write_text(TENCENT_KEY, encoding='utf-8')
        self.env = patch.dict(os.environ, {
            'SINGULARITY_WINDOWS_NATIVE': '1',
            'SINGULARITY_INSTALL_VARIANT': '2',
            'SINGULARITY_LOCAL_ACCOUNT_AUTH': '1',
            'SINGULARITY_DASHBOARD_AUTH_MODE': 'password',
            'SINGULARITY_TENCENT_OWNER_KEY_FILE': str(key),
            'REPOQL_NATIVE_EMBED_URL': '/embed/repoql',
            'CLAUDE_OFFICE_PUBLIC_URL': 'https://office.example.test',
            # Office legacy_url mode reads its capability token server-side; the
            # browser never sees it (asserted below).
            'CLAUDE_OFFICE_EMBED_URL': 'https://office.example.test/?token=p2-office-capability&embed=1',
        }, clear=False)
        self.env.start()
        self.addCleanup(self.env.stop)

        self.backends = contextlib.ExitStack()
        self.addCleanup(self.backends.close)
        office = self.backends.enter_context(loopback(kind='office'))
        tencent = self.backends.enter_context(loopback(kind='tencent'))
        kanzo = self.backends.enter_context(loopback(kind='kanzo'))
        self.upstreams = patch.dict(panels.UPSTREAM, {
            'office': ('127.0.0.1', office.server_port),
            'tencent': ('127.0.0.1', tencent.server_port),
            'kanzo': ('127.0.0.1', kanzo.server_port),
        })
        self.upstreams.start()
        self.addCleanup(self.upstreams.stop)

        # The vendor login issuance needs the real RepoQL account; stub only the
        # issuance call, never the dashboard's own authentication checks.
        self.issuance = patch.object(repoql_native_auth, 'refresh_native_login_path', return_value=True)
        self.issuance.start()
        self.addCleanup(self.issuance.stop)

        config = Config(workspace=root, rql=root / 'rql', state_dir=root / 'state',
                        bind='127.0.0.1', port=0, allow_peers=('127.0.0.1/32',))
        self.dashboard = self.backends.enter_context(self._server(config))
        self.port = self.dashboard.server_address[1]
        self.origin = f'http://127.0.0.1:{self.port}'

    @contextlib.contextmanager
    def _server(self, config):
        server = build_server(config)
        thread = threading.Thread(target=server.serve_forever, daemon=True)
        thread.start()
        try:
            yield server
        finally:
            server.shutdown()
            server.server_close()
            thread.join(timeout=3)

    def _sign_in(self) -> str:
        payload = json.dumps({'username': 'p2owner', 'password': 'p2-unpredictable-phrase-123'}).encode()
        status, headers, _ = request(
            self.port, 'POST', '/api/account/setup',
            headers={'Content-Type': 'application/json', 'X-Requested-With': 'repoql-dashboard',
                     'Origin': self.origin},
            data=payload)
        if status == 409:
            payload = json.dumps({'username': 'p2owner', 'password': 'p2-unpredictable-phrase-123'}).encode()
            status, headers, _ = request(
                self.port, 'POST', '/api/account/login',
                headers={'Content-Type': 'application/json', 'X-Requested-With': 'repoql-dashboard',
                         'Origin': self.origin},
                data=payload)
        self.assertEqual(status, 200, 'sign-in failed')
        cookie = headers.get('Set-Cookie', '')
        self.assertIn('srq_session=', cookie)
        return cookie.split(';', 1)[0]

    def test_anonymous_rejected_for_repoql_and_every_gateway_panel(self):
        for label in ('tencent', 'office', 'kanzo'):
            status, _, body = request(self.port, 'GET', f'/api/embed/{label}/handshake')
            self.assertEqual(status, 401, (label, body[:200]))
            status, _, body = request(self.port, 'GET', f'/embed/{label}/')
            self.assertEqual(status, 401, (label, body[:200]))
        for path in ('/api/embed/repoql/handshake', '/embed/repoql/', '/embed/repoql/api/v3/status'):
            status, _, body = request(self.port, 'GET', path)
            self.assertEqual(status, 401, (path, body[:200]))
        # Nothing reached an upstream on an anonymous request.
        for backend in panels.UPSTREAM.values():
            self.assertTrue(backend)

    def test_authenticated_same_origin_reaches_each_panel(self):
        session = self._sign_in()
        auth = {'Cookie': session}
        for label in ('tencent', 'office', 'kanzo'):
            status, headers, body = request(self.port, 'GET', f'/api/embed/{label}/handshake', headers=auth)
            self.assertEqual(status, 200, (label, body[:200]))
            self.assertEqual(json.loads(body), {'ready': True})
            panel_cookie = headers['Set-Cookie'].split(';', 1)[0]
            self.assertNotIn(TENCENT_KEY, panel_cookie)
            status, headers, body = request(self.port, 'GET', f'/embed/{label}/',
                                            headers={'Cookie': panel_cookie})
            self.assertEqual(status, 200, (label, body[:200]))
            self.assertNotIn(TENCENT_KEY.encode(), body)
            self.assertNotIn(b'p2-office-capability', body)

        status, headers, body = request(self.port, 'GET', '/api/embed/repoql/handshake', headers=auth)
        self.assertEqual(status, 200, body[:300])
        self.assertEqual(json.loads(body), {'ready': True})
        self.assertIn(f'{LAUNCH_COOKIE}=', headers.get('Set-Cookie', ''))
        self.assertNotIn('token', repr(headers).lower())

    def test_panel_cookie_cannot_cross_audiences(self):
        auth = {'Cookie': self._sign_in()}
        _, headers, _ = request(self.port, 'GET', '/api/embed/tencent/handshake', headers=auth)
        cookie = headers['Set-Cookie'].split(';', 1)[0]
        status, _, body = request(self.port, 'GET', '/embed/kanzo/', headers={'Cookie': cookie})
        self.assertEqual(status, 401)
        self.assertNotIn(b'Kanzo', body)

    def test_repoql_launch_cookie_is_scoped_and_short_lived(self):
        session = self._sign_in()
        status, headers, _ = request(self.port, 'GET', '/api/embed/repoql/handshake',
                                     headers={'Cookie': session})
        self.assertEqual(status, 200)
        cookies = headers.get('Set-Cookie', '')
        self.assertIn('Path=/api/embed/repoql/launch', cookies)
        self.assertIn('Path=/embed/repoql', cookies)
        self.assertIn('HttpOnly', cookies)
        self.assertNotIn('srq_session', cookies)

    def test_mutation_without_origin_is_refused_for_authenticated_session(self):
        session = self._sign_in()
        # The account-origin guard runs before routing: a cookie-authenticated
        # POST with no Origin is refused outright, so it never becomes a 405.
        status, _, body = request(
            self.port, 'POST', '/api/embed/tencent/handshake',
            headers={'Cookie': session})
        self.assertEqual(status, 403)
        self.assertIn(b'account_origin_refused', body)
        status, _, body = request(
            self.port, 'POST', '/api/setup/repair',
            headers={'Cookie': session, 'Content-Type': 'application/json',
                     'X-Requested-With': 'repoql-dashboard'},
            data=b'{"only":["kanzo"]}')
        self.assertIn(status, (403, 404), body[:200])


if __name__ == '__main__':
    unittest.main()
