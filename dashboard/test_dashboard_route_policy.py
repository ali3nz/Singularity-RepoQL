"""Route parity at the authenticated HTTP handler, with a fixture Rust runner."""
from http.server import ThreadingHTTPServer
import http.client
import json
import os
from pathlib import Path
import subprocess
import tempfile
import threading
import unittest
from types import SimpleNamespace
from unittest.mock import Mock, patch

from dashboard_route_policy import BINARY_ENV, READ_PREFIXES, READ_ROUTES, WRITE_ROUTES, classify_dashboard_route
from server import Handler


class DashboardRoutePolicy(unittest.TestCase):
    def test_dispatch_routes_have_no_duplicate_or_missing_handler(self):
        import ast
        import inspect
        import textwrap
        dispatch = ast.parse(textwrap.dedent(inspect.getsource(Handler.dispatch)))
        keys = [n.comparators[0].value for n in ast.walk(dispatch) if isinstance(n, ast.Compare)
                and isinstance(n.left, ast.Name) and n.left.id == "route"]
        expected = [*READ_ROUTES.values(), *WRITE_ROUTES.values(), *(r for _, r in READ_PREFIXES)]
        self.assertCountEqual(keys, expected)

    def test_exact_routes_and_precedence(self):
        self.assertEqual(classify_dashboard_route("GET", "/api/harness/office", rust_bin=""), "read_harness_office")
        self.assertEqual(classify_dashboard_route("GET", "/api/harness/other", rust_bin=""), "read_harness")
        self.assertEqual(classify_dashboard_route("GET", "/api/unified/tencent/invoke", rust_bin=""), "read_unified")
        self.assertEqual(classify_dashboard_route("POST", "/api/unified/tencent/invoke", rust_bin=""), "write_unified_tencent_invoke")
        self.assertIsNone(classify_dashboard_route("POST", "/api/health", rust_bin=""))

    def test_native_wire_contains_only_public_keys(self):
        with tempfile.TemporaryDirectory() as tmp:
            binary = Path(tmp) / "routes.exe"
            binary.touch()
            runner = Mock(return_value=subprocess.CompletedProcess([], 0, '{"route":"read_harness"}', ''))
            with patch.dict(os.environ, {BINARY_ENV: str(binary), "PRIVATE_TOKEN": "sentinel"}):
                self.assertEqual(classify_dashboard_route("GET", "/api/harness/private-workspace", runner=runner), "read_harness")
            options = runner.call_args.kwargs
            self.assertEqual(json.loads(options['input'])['key'], '/api/harness')
            self.assertNotIn('private-workspace', options['input'])
            self.assertNotIn('PRIVATE_TOKEN', options['env'])
            self.assertFalse(options['shell'])

    def test_http_auth_precedes_optional_compiled_route(self):
        class App:
            token = 'route-test-token'
            local_account = None

            def peer_allowed(self, addr):
                return True

            def access_identity(self, headers):
                return None

        class Probe(Handler):
            app = App()

            def files(self, params):
                return {"query": params.get("q")}

            def log_message(self, *args):
                pass

        with ThreadingHTTPServer(('127.0.0.1', 0), Probe) as server:
            worker = threading.Thread(target=server.serve_forever, daemon=True)
            worker.start()
            try:
                with patch('server.classify_dashboard_route', wraps=classify_dashboard_route) as classifier:
                    def request(headers):
                        connection = http.client.HTTPConnection('127.0.0.1', server.server_port, timeout=5)
                        try:
                            connection.request('GET', '/api/files?q=fixture', headers=headers)
                            response = connection.getresponse()
                            return response.status, json.loads(response.read())
                        finally:
                            connection.close()
                    self.assertEqual(request({})[0], 401)
                    classifier.assert_not_called()
                    self.assertEqual(request({'Authorization': 'Bearer route-test-token'}),
                                     (200, {"query": "fixture"}))
                    classifier.assert_called_once_with('GET', '/api/files')
            finally:
                server.shutdown()
                worker.join(timeout=3)

    def test_mismatch_cannot_reach_a_mutation_or_read_its_body(self):
        handler = object.__new__(Handler)
        handler.app = SimpleNamespace()
        handler.read_body = Mock()
        handler.post_remove = Mock()
        with patch('server.classify_dashboard_route', side_effect=RuntimeError('dashboard_route_native_parity_mismatch')):
            with self.assertRaisesRegex(RuntimeError, 'parity_mismatch'):
                handler.dispatch('POST', '/api/repos/remove', {})
        handler.read_body.assert_not_called()
        handler.post_remove.assert_not_called()

    def test_disabled_path_uses_original_handler_and_parameters(self):
        handler = object.__new__(Handler)
        handler.app = SimpleNamespace()
        handler.files = Mock(return_value={'rows': []})
        with patch.dict(os.environ, {BINARY_ENV: ""}):
            self.assertEqual(handler.dispatch('GET', '/api/files', {'q': 'x'}), {'rows': []})
        handler.files.assert_called_once_with({'q': 'x'})


if __name__ == "__main__":
    unittest.main()
