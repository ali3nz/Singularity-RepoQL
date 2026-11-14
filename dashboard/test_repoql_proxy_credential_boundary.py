"""Isolated dashboard->RepoQL proxy credential boundary tests; no real network."""
import io
import unittest
from types import SimpleNamespace
from unittest.mock import patch
from urllib.parse import urlparse

from server import Handler
from repoql_native_auth import COOKIE_NAME


def handler(headers):
    h = object.__new__(Handler)
    h.headers = headers
    h.app = SimpleNamespace(token='dashboard-private-secret')
    return h


class ProxyHeaderBoundary(unittest.TestCase):
    def test_dashboard_credentials_and_cloudflare_identity_never_forwarded(self):
        h = handler({'Authorization': 'Bearer dashboard-private-secret',
                     'Cf-Access-Jwt-Assertion': 'cloudflare-private-jwt',
                     'Cf-Access-Authenticated-User-Email': 'private@example.test',
                     'Cookie': f'{COOKIE_NAME}=dashboard-cookie; srq_session=dashboard-owner; repoql_session=panel-cookie',
                     'Referer': 'http://127.0.0.1/?key=dashboard-private-secret',
                     'X-Requested-With': 'repoql-dashboard'})
        for websocket in (False, True):
            headers = h._repoql_forward_headers(websocket=websocket)
            combined = str(headers)
            self.assertNotIn('dashboard-private-secret', combined)
            self.assertNotIn('cloudflare-private-jwt', combined)
            self.assertNotIn('private@example.test', combined)
            self.assertNotIn('dashboard-cookie', combined)
            self.assertNotIn('dashboard-owner', combined)
            self.assertIn('repoql_session=panel-cookie', combined)
            self.assertEqual(headers['X-Requested-With'], 'repoql-dashboard')

    def test_repoql_own_bearer_is_preserved(self):
        h = handler({'Authorization': 'Bearer repoql-native-session', 'Cookie': 'repoql_session=panel'})
        headers = h._repoql_forward_headers()
        self.assertEqual(headers['Authorization'], 'Bearer repoql-native-session')
        self.assertEqual(headers['Cookie'], 'repoql_session=panel')

    def test_header_crlf_injection_is_rejected(self):
        for bad in ('hello\r\nInjected: yes', 'hello\nInjected: yes'):
            with self.subTest(bad=bad):
                with self.assertRaises(PermissionError):
                    handler({'X-Test': bad})._repoql_forward_headers(websocket=True)

    def test_http_proxy_uses_shared_filter_in_real_proxy_path(self):
        h = handler({'Authorization': 'Bearer dashboard-private-secret',
                     'Cf-Access-Jwt-Assertion': 'secret-assertion',
                     'Cookie': f'{COOKIE_NAME}=launch-secret; srq_session=dashboard-owner; repoql_session=native',
                     'Host': 'localhost:18100'})
        h.rfile = io.BytesIO()
        h.wfile = io.BytesIO()
        h.send_response = lambda *_: None
        received = []
        h.send_header = lambda *header: received.append(header)
        h.end_headers = lambda: None
        h.request_origin_allowed = lambda **_: True
        h.bearer_authorized = lambda: True
        requests = []
        class Response:
            status = 200
            def read(self, *_): return b'{}'
            def getheader(self, *_): return 'application/json'
            def getheaders(self):
                return [('Set-Cookie', 'SRQ_SESSION=fixture-replacement; Path=/'),
                        ('Set-Cookie', f'{COOKIE_NAME}=fixture-replacement; Path=/'),
                        ('Set-Cookie', 'repoql_session=panel-cookie; Path=/')]
        class Conn:
            def __init__(self, *_args, **_kwargs): pass
            def request(self, method, path, body, headers): requests.append((method,path,headers))
            def getresponse(self): return Response()
            def close(self): pass
        with patch('server.http.client.HTTPConnection', Conn):
            h.proxy_repoql('GET', urlparse('/embed/repoql/api/health'))
        self.assertEqual(len(requests), 1)
        method, path, headers = requests[0]
        self.assertEqual((method, path), ('GET', '/api/health'))
        self.assertNotIn('Authorization', headers)
        self.assertNotIn('Cf-Access-Jwt-Assertion', headers)
        self.assertEqual(headers.get('Cookie'), 'repoql_session=native')
        self.assertEqual([value for name,value in received if name == 'Set-Cookie'],
                         ['repoql_session=panel-cookie; Path=/embed/repoql'])

    def test_websocket_proxy_uses_shared_filter_in_upstream_handshake(self):
        h = handler({'Authorization': 'Bearer dashboard-private-secret',
                     'Cf-Access-Jwt-Assertion': 'private-jwt',
                     'Cookie': f'{COOKIE_NAME}=private-launch; srq_session=dashboard-owner; repoql_session=native',
                     'Upgrade': 'websocket', 'Sec-WebSocket-Key': 'fake-key'})
        h.authorized_for_embed = lambda: True
        h.bearer_authorized = lambda: True
        h.request_origin_allowed = lambda **_: True
        h.send_json = lambda *_: self.fail('Unexpected rejection')
        class Sock:
            def __init__(self): self.sent=[]
            def sendall(self, data): self.sent.append(data)
            def settimeout(self, *_): pass
            def recv(self, *_): return b''
            def close(self): pass
        upstream = Sock();h.connection=Sock()
        with patch('server.socket.create_connection', return_value=upstream),patch('server.select.select',return_value=([h.connection], [], [])):
            h.proxy_repoql_websocket('/embed/repoql/ws')
        sent = b''.join(upstream.sent).decode('latin-1')
        self.assertIn('Sec-WebSocket-Key: fake-key',sent)
        self.assertIn('repoql_session=native',sent)
        for secret in ('dashboard-private-secret','private-jwt','private-launch','dashboard-owner'):
            self.assertNotIn(secret, sent)


if __name__ == '__main__': unittest.main()
