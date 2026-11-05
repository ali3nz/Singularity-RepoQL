"""Targeted local-only tests for official RepoQL dashboard redirect confinement."""
import io
import unittest
from types import SimpleNamespace
from unittest.mock import patch
from urllib.parse import urlparse
from server import Handler


def make_handler():
    h = object.__new__(Handler)
    h.app = SimpleNamespace(token='private-test-secret')
    h.headers = {'Host': '127.0.0.1:18100'}
    h.rfile = io.BytesIO()
    h.wfile = io.BytesIO()
    h.request_origin_allowed = lambda **_: True
    h.bearer_authorized = lambda: True
    h._http_code = None
    h._sent_headers = []
    h.send_response = lambda code: setattr(h, '_http_code', code)
    h.send_header = lambda name, value: h._sent_headers.append((name, value))
    h.end_headers = lambda: None
    h.send_json = lambda code, payload: (setattr(h, '_http_code', code), h.wfile.write(str(payload).encode()))
    return h


class NativeRepoQLRedirectTests(unittest.TestCase):
    def test_valid_local_absolute_and_relative_targets_are_rewritten(self):
        h = make_handler()
        self.assertEqual(h._safe_repoql_redirect('http://127.0.0.1:41005/#k=secret', '/login'), '/embed/repoql/#k=secret')
        self.assertEqual(h._safe_repoql_redirect('http://localhost:41005/login?t=secret', '/'), '/embed/repoql/login?t=secret')
        self.assertEqual(h._safe_repoql_redirect('/dashboard', '/login'), '/embed/repoql/dashboard')
        self.assertEqual(h._safe_repoql_redirect('account?tab=2', '/settings/profile'), '/embed/repoql/settings/account?tab=2')
        self.assertEqual(h._safe_repoql_redirect('?view=1', '/settings/profile'), '/embed/repoql/settings/profile?view=1')

    def test_foreign_authority_and_encoded_traversal_refused(self):
        h = make_handler()
        invalid = ('https://other.example.invalid/', 'http://127.0.0.1:4444/',
                   'http://user:password@127.0.0.1:41005/', '//evil.example.invalid/x',
                   '/%2e%2e/admin', '/%5cadmin', '/x/../admin',
                   '/login\r\nX-Injected: value', '/%252e%252e/admin', 'file:///private')
        for value in invalid:
            with self.subTest(location=value), self.assertRaises(PermissionError):
                h._safe_repoql_redirect(value, '/')

    def test_embed_proxy_refuses_double_encoded_traversal(self):
        h = make_handler()
        for path in ('/embed/repoql/%2e%2e/api', '/embed/repoql/%252e%252e/api',
                     '/embed/repoql/%255csecret', '/embed/repoql//other',
                     '/embed/repoql/%00', '/embed/repoql/../api'):
            with self.subTest(path=path), self.assertRaises(PermissionError):
                h._embed_upstream_path(path)
        self.assertEqual(h._embed_upstream_path('/embed/repoql/assets/main.js'), '/assets/main.js')

    def test_http_proxy_rewrites_legitimate_absolute_location(self):
        h = make_handler()
        class Response:
            status = 302
            def read(self, *_): return b'potential old capability'
            def getheader(self, key, default=None):
                return {'Location': 'http://127.0.0.1:41005/login?t=issuer-token',
                        'Content-Type': 'text/html'}.get(key, default)
            def getheaders(self): return [('Location', 'http://127.0.0.1:41005/login?t=issuer-token'), ('Content-Type', 'text/html')]
        class Conn:
            def __init__(self, *_args, **_kwargs): pass
            def request(self, *_args, **_kwargs): pass
            def getresponse(self): return Response()
            def close(self): pass
        with patch('server.http.client.HTTPConnection', Conn):
            h.proxy_repoql('GET', urlparse('/embed/repoql/login'))
        self.assertEqual(h._http_code, 302)
        self.assertIn(('Location', '/embed/repoql/login?t=issuer-token'), h._sent_headers)
        self.assertEqual(h.wfile.getvalue(), b'')

    def test_http_proxy_blocks_external_location_without_leaking_body(self):
        h = make_handler()
        class Response:
            status = 302
            def read(self, *_): return b'private issuer response'
            def getheader(self, key, default=None): return 'https://outside.invalid/x' if key == 'Location' else default
            def getheaders(self): return [('Location', 'https://outside.invalid/x')]
        class Conn:
            def __init__(self, *_args, **_kwargs): pass
            def request(self, *_args, **_kwargs): pass
            def getresponse(self): return Response()
            def close(self): pass
        with patch('server.http.client.HTTPConnection', Conn):
            h.proxy_repoql('GET', urlparse('/embed/repoql/'))
        self.assertEqual(h._http_code, 502)
        self.assertFalse(any(k == 'Location' for k, _ in h._sent_headers))
        self.assertNotIn(b'private issuer response', h.wfile.getvalue())


if __name__ == '__main__':
    unittest.main()
