"""Real loopback protocol regression for the credentialed unified Windows proxy."""
import json
import tempfile
import threading
import unittest
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from unittest.mock import patch

import unified_bridge as bridge


class _Target(BaseHTTPRequestHandler):
    requests = []
    behavior = 'ok'

    def log_message(self, *args):
        pass

    def do_GET(self):
        self.handle_request()

    def do_POST(self):
        self.handle_request()

    def handle_request(self):
        n = int(self.headers.get('Content-Length', '0'))
        body = self.rfile.read(n) if n else b''
        type(self).requests.append((self.command, self.path, dict(self.headers), body))
        if type(self).behavior == 'redirect':
            self.send_response(302)
            self.send_header('Location', 'http://127.0.0.1:1/stolen')
            self.end_headers()
        elif type(self).behavior == 'oversize':
            self.send_response(200)
            self.send_header('Content-Type', 'application/json')
            self.end_headers()
            self.wfile.write(b'x' * (8 * 1024 * 1024 + 1))
        elif type(self).behavior == 'fail':
            self.send_response(401)
            self.send_header('Content-Type', 'application/json')
            self.end_headers()
            self.wfile.write(b'{"error":"token-super-secret"}')
        else:
            self.send_response(200)
            self.send_header('Content-Type', 'application/json')
            self.end_headers()
            self.wfile.write(b'{"available":true,"ok":true}')


class ProxyTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.server = ThreadingHTTPServer(('127.0.0.1', 0), _Target)
        cls.thread = threading.Thread(target=cls.server.serve_forever, daemon=True)
        cls.thread.start()

    @classmethod
    def tearDownClass(cls):
        cls.server.shutdown()
        cls.server.server_close()
        cls.thread.join(3)

    def setUp(self):
        _Target.requests.clear()
        _Target.behavior = 'ok'
        self.temp = tempfile.TemporaryDirectory()
        self.secret = Path(self.temp.name) / 'gateway.token'
        self.secret.write_text('private-key-value')
        self.origin = f'http://127.0.0.1:{self.server.server_port}'
        self.patches = [patch.object(bridge, 'BASE', self.origin), patch.object(bridge, 'SECRET_FILE', self.secret)]
        for p in self.patches: p.start()
        bridge._graph_cache_clear()

    def tearDown(self):
        for p in reversed(self.patches): p.stop()
        self.temp.cleanup()
        bridge._graph_cache_clear()

    def test_get_and_post_reach_only_fixed_path(self):
        self.assertTrue(bridge.forward_unified('GET', '/api/unified/health')['ok'])
        self.assertTrue(bridge.forward_unified('POST', '/api/unified/tencent/invoke', body={'name':'test'})['ok'])
        self.assertEqual([r[1] for r in _Target.requests], ['/v1/health', '/v1/tencent/invoke'])
        self.assertEqual(json.loads(_Target.requests[1][3]), {'name':'test'})
        self.assertEqual(_Target.requests[0][2]['Authorization'], 'Bearer private-key-value')

    def test_redirect_is_rejected_without_following_and_without_token_leak(self):
        _Target.behavior = 'redirect'
        result = bridge.forward_unified('GET', '/api/unified/health')
        self.assertEqual(result['error'], 'unified_upstream_redirect_refused')
        self.assertEqual(len(_Target.requests), 1)
        self.assertNotIn('private-key-value', json.dumps(result))

    def test_upstream_error_never_reflects_service_error_body(self):
        _Target.behavior = 'fail'
        result = bridge.forward_unified('GET', '/api/unified/health')
        self.assertEqual(result, {'available': False, 'error': 'unified_http_401'})

    def test_oversized_response_refused(self):
        _Target.behavior = 'oversize'
        result = bridge.forward_unified('GET', '/api/unified/health')
        self.assertEqual(result['error'], 'unified_response_too_large')

    def test_invalid_origin_fails_before_network(self):
        for base in ('http://localhost:18101', 'http://127.0.0.1:18101/evil',
                     'http://127.0.0.1:18101?x=1', 'http://u:p@127.0.0.1:18101',
                     'https://127.0.0.1:18101', 'http://127.0.0.1', 'http://example.com:1'):
            with self.subTest(base=base), patch.object(bridge, 'BASE', base):
                with self.assertRaises(PermissionError):
                    bridge.forward_unified('GET', '/api/unified/health')
        self.assertEqual(_Target.requests, [])

    def test_blank_or_multiline_gateway_secret_not_sent(self):
        for value in ('', 'a\nb'):
            self.secret.write_text(value)
            result = bridge.forward_unified('GET', '/api/unified/health')
            self.assertEqual(result['error'], 'unified_gateway_not_configured')
        self.assertEqual(_Target.requests, [])

    def test_graph_cache_caches_good_response_not_failure(self):
        _Target.behavior = 'fail'
        a = bridge.forward_unified('GET', '/api/unified/graph')
        self.assertEqual(a['error'], 'unified_http_401')
        _Target.behavior = 'ok'
        b = bridge.forward_unified('GET', '/api/unified/graph')
        self.assertTrue(b['ok'])
        self.assertEqual(b['_cache']['state'], 'miss')
        c = bridge.forward_unified('GET', '/api/unified/graph')
        self.assertEqual(c['_cache']['state'], 'fresh')
        self.assertEqual(len(_Target.requests), 2)


if __name__ == '__main__': unittest.main()
