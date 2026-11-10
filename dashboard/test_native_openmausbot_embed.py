"""Hermetic loopback tests for the dashboard's OpenMausBot embed boundary."""
import io
import json
import os
import stat
import tempfile
import threading
import unittest
from http.server import BaseHTTPRequestHandler, HTTPServer
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import patch
from urllib.parse import urlsplit

import native_panel_proxy as panel


TOKEN = 'synthetic-openmausbot-session-token'


class OpenMausBotUpstream(BaseHTTPRequestHandler):
    def do_GET(self):
        self.server.received.append(('GET', self.path, self.headers.get('Authorization'),
                                     self.headers.get('Origin'), self.headers.get('Cookie'),
                                     self.headers.get('Host')))
        if self.path == '/api/health':
            body = json.dumps({'app': self.server.app_name}).encode()
        else:
            body = b'{"ok":true}'
        self.send_response(200)
        self.send_header('Content-Type', 'application/json')
        self.send_header('Content-Length', str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def do_POST(self):
        body = self.rfile.read(int(self.headers.get('Content-Length', '0')))
        self.server.received.append(('POST', self.path, self.headers.get('Authorization'),
                                     self.headers.get('Origin'), self.headers.get('Cookie'),
                                     self.headers.get('Host'), body))
        response = b'{"ok":true}'
        self.send_response(200)
        self.send_header('Content-Type', 'application/json')
        self.send_header('Content-Length', str(len(response)))
        self.end_headers()
        self.wfile.write(response)

    def log_message(self, *_args):
        return


class FakeHandler:
    def __init__(self, state_dir, method='GET', data=b'', **headers):
        self.headers = {'Content-Length': str(len(data)), 'Content-Type': 'application/json', **headers}
        self.rfile = io.BytesIO(data)
        self.wfile = io.BytesIO()
        self.status = None
        self.response_headers = {}
        self.app = SimpleNamespace(token='dashboard-test-token',
                                   config=SimpleNamespace(state_dir=Path(state_dir)))
        self.connection = SimpleNamespace(settimeout=lambda _timeout: None)
        self._method = method
        self.close_connection = False

    def authorized(self):
        return True

    def bearer_authorized(self):
        return False

    def request_origin_allowed(self, **_kwargs):
        return True

    def access_identity(self):
        return None

    def request_is_https(self):
        return False

    def send_response(self, code):
        self.status = code

    def send_header(self, name, value):
        self.response_headers[name] = value

    def end_headers(self):
        pass

    def send_json(self, code, content):
        self.status = code
        self.wfile.write(json.dumps(content).encode())


class NativeOpenMausBotEmbed(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.server = HTTPServer(('127.0.0.1', 0), OpenMausBotUpstream)
        cls.server.received = []
        cls.server.app_name = 'openmausbot'
        cls.thread = threading.Thread(target=cls.server.serve_forever, daemon=True)
        cls.thread.start()

    @classmethod
    def tearDownClass(cls):
        cls.server.shutdown()
        cls.server.server_close()
        cls.thread.join(timeout=2)

    def test_handshake_verifies_app_and_keeps_optional_token_server_side(self):
        with self.subTest(token='present'), tempfile.TemporaryDirectory() as directory:
            token_path = Path(directory) / 'omb-session.token'
            token_path.write_text(TOKEN, encoding='utf-8')
            handler = FakeHandler(directory)
            with patch.dict(panel.UPSTREAM, {'openmausbot': self.server.server_address}), \
                 patch.object(panel, 'create_launch_cookie', return_value='signed-dashboard-cookie'):
                self.server.received.clear()
                panel.handshake(handler, 'openmausbot')
            self.assertEqual(handler.status, 200)
            self.assertIn(panel.COOKIE_NAME + '=signed-dashboard-cookie', handler.response_headers['Set-Cookie'])
            self.assertEqual(self.server.received[0][2], 'Bearer ' + TOKEN)
            self.assertNotIn(TOKEN.encode(), handler.wfile.getvalue())

        with self.subTest(token='missing'), tempfile.TemporaryDirectory() as directory:
            handler = FakeHandler(directory)
            with patch.dict(panel.UPSTREAM, {'openmausbot': self.server.server_address}), \
                 patch.object(panel, 'create_launch_cookie', return_value='signed-dashboard-cookie'):
                self.server.received.clear()
                panel.handshake(handler, 'openmausbot')
            self.assertEqual(handler.status, 200)
            self.assertIsNone(self.server.received[0][2])

    def test_handshake_rejects_unexpected_health_before_issuing_cookie(self):
        with tempfile.TemporaryDirectory() as directory, \
             patch.dict(panel.UPSTREAM, {'openmausbot': self.server.server_address}), \
             patch.object(panel, 'create_launch_cookie', return_value='must-not-be-issued'):
            handler = FakeHandler(directory)
            self.server.app_name = 'another-local-app'
            try:
                panel.handshake(handler, 'openmausbot')
            finally:
                self.server.app_name = 'openmausbot'
            self.assertEqual(handler.status, 503)
            self.assertNotIn('Set-Cookie', handler.response_headers)

    def test_cookie_authenticated_get_and_post_use_only_server_token_and_fixed_origin(self):
        with tempfile.TemporaryDirectory() as directory:
            (Path(directory) / 'omb-session.token').write_text(TOKEN, encoding='utf-8')
            headers = {'Authorization': 'Bearer browser-supplied-value', 'Cookie': 'browser-cookie'}
            with patch.dict(panel.UPSTREAM, {'openmausbot': self.server.server_address}):
                self.server.received.clear()
                get = FakeHandler(directory, **headers)
                panel.serve(get, 'openmausbot', 'GET', urlsplit('/embed/openmausbot/api/state'))
                self.assertEqual(get.status, 200)
                self.assertEqual(self.server.received[0][2], 'Bearer ' + TOKEN)
                self.assertIsNone(self.server.received[0][3])
                self.assertIsNone(self.server.received[0][4])

                post = FakeHandler(directory, 'POST', b'{"action":"test"}', **headers)
                panel.serve(post, 'openmausbot', 'POST', urlsplit('/embed/openmausbot/api/action'))
                received = self.server.received[1]
                self.assertEqual(post.status, 200)
                self.assertEqual(received[2], 'Bearer ' + TOKEN)
                self.assertEqual(received[3], 'http://127.0.0.1:%d' % self.server.server_address[1])
                self.assertIsNone(received[4])
                self.assertNotIn(TOKEN.encode(), post.wfile.getvalue())

    def test_websocket_replaces_browser_origin_and_does_not_forward_browser_credentials(self):
        class UpstreamSocket:
            def __init__(self):
                self.sent = b''
                self.closed = False

            def sendall(self, data):
                self.sent += data

            def settimeout(self, _timeout):
                pass

            def close(self):
                self.closed = True

        with tempfile.TemporaryDirectory() as directory:
            (Path(directory) / 'omb-session.token').write_text(TOKEN, encoding='utf-8')
            upstream = UpstreamSocket()
            handler = FakeHandler(directory, Upgrade='websocket',
                                  Origin='https://dashboard.example',
                                  Authorization='Bearer browser-supplied-value',
                                  Cookie='browser-cookie')
            handler.connection = UpstreamSocket()
            with patch.dict(panel.UPSTREAM, {'openmausbot': self.server.server_address}), \
                 patch.object(panel.socket, 'create_connection', return_value=upstream), \
                 patch.object(panel.select, 'select', return_value=([], [], [])):
                panel.serve(handler, 'openmausbot', 'GET',
                            urlsplit('/embed/openmausbot/ws/chat?cursor=4'))
            request = upstream.sent.decode('latin-1')
            self.assertIn('GET /ws/chat?cursor=4 HTTP/1.1', request)
            self.assertIn('Authorization: Bearer ' + TOKEN, request)
            self.assertIn('Origin: http://127.0.0.1:%d' % self.server.server_address[1], request)
            self.assertNotIn('browser-supplied-value', request)
            self.assertNotIn('browser-cookie', request)
            self.assertNotIn('https://dashboard.example', request)

    def test_symlink_or_malformed_token_fails_closed(self):
        with tempfile.TemporaryDirectory() as directory:
            token_path = Path(directory) / 'omb-session.token'
            token_path.write_text('invalid token', encoding='utf-8')
            with self.assertRaises(PermissionError):
                panel.openmausbot_session_token(FakeHandler(directory))
            with patch.object(Path, 'lstat', return_value=SimpleNamespace(st_mode=stat.S_IFLNK, st_size=12)):
                with self.assertRaises(PermissionError):
                    panel.openmausbot_session_token(FakeHandler(directory))

    def test_upstream_uses_fixed_loopback_and_validated_windows_port(self):
        with patch.dict(os.environ, {
            'SINGULARITY_OPENMAUSBOT_HOST': '203.0.113.2',
            'SINGULARITY_WINDOWS_OMB_PORT': '18211',
        }, clear=True):
            self.assertEqual(panel._upstream('openmausbot', 8799), ('127.0.0.1', 18211))
        for value in ('abc', '1', '65535'):
            with patch.dict(os.environ, {'SINGULARITY_WINDOWS_OMB_PORT': value}, clear=True):
                with self.subTest(port=value), self.assertRaisesRegex(ValueError, 'OpenMausBot port'):
                    panel._upstream('openmausbot', 8799)


if __name__ == '__main__':
    unittest.main()
