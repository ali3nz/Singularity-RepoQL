"""The RepoQL Control Panel upstream is the running host's own listener.

The host records its dashboard origin in <workspace>/.repoql/cache/dashboard-bind.json.
A hard-coded 41005 proxies another workspace's panel (or nothing) as soon as the
machine runs more than one host, which the installed product and this candidate
do. These contracts cover the resolver and the proxy boundaries that use it.
"""
import io
import json
import os
import tempfile
import unittest
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import patch

import repoql_native_auth
import server


class PanelOriginTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.workspace = Path(self.temp.name)
        (self.workspace / '.repoql' / 'cache').mkdir(parents=True)
        self.record = self.workspace / '.repoql' / 'cache' / 'dashboard-bind.json'
        self.env = patch.dict(os.environ, {}, clear=False)
        self.env.start()
        for name in (repoql_native_auth.PANEL_ORIGIN_ENV, 'REPOQL_NATIVE_WORKSPACE',
                     'SINGULARITY_WORKSPACE'):
            os.environ.pop(name, None)

    def tearDown(self):
        self.env.stop()
        self.temp.cleanup()

    def write_record(self, payload):
        self.record.write_text(payload if isinstance(payload, str) else json.dumps(payload),
                               encoding='utf-8')

    def test_running_host_port_is_used(self):
        self.write_record({'url': 'http://127.0.0.1:59796', 'secret': 'z' * 43})
        self.assertEqual(repoql_native_auth.panel_origin(str(self.workspace)), ('127.0.0.1', 59796))
        with patch.dict(os.environ, {'REPOQL_NATIVE_WORKSPACE': str(self.workspace)}, clear=False):
            self.assertEqual(server.native_repoql_upstream(), ('127.0.0.1', 59796))

    def test_the_record_secret_never_leaves_the_resolver(self):
        secret = 'q' * 43
        self.write_record({'url': 'http://127.0.0.1:50001', 'secret': secret})
        origin = repoql_native_auth.panel_origin(str(self.workspace))
        self.assertEqual(origin, ('127.0.0.1', 50001))
        self.assertNotIn(secret, repr(origin))

    def test_explicit_origin_wins_and_is_validated(self):
        self.write_record({'url': 'http://127.0.0.1:50001', 'secret': 'z' * 43})
        with patch.dict(os.environ, {repoql_native_auth.PANEL_ORIGIN_ENV: 'http://localhost:50002'}, clear=False):
            self.assertEqual(repoql_native_auth.panel_origin(str(self.workspace)), ('localhost', 50002))
        # A configured value that is not a bare loopback origin is refused rather
        # than quietly replaced by another workspace's panel.
        for value in ('http://10.0.0.5:50002', 'https://127.0.0.1:50002',
                      'http://127.0.0.1:50002/#k=capability', 'http://user:pass@127.0.0.1:50002',
                      'http://127.0.0.1:50002/login?t=token', 'http://127.0.0.1:0'):
            with self.subTest(value=value), patch.dict(
                    os.environ, {repoql_native_auth.PANEL_ORIGIN_ENV: value}, clear=False):
                self.assertIsNone(repoql_native_auth.panel_origin(str(self.workspace)))

    def test_absent_or_unusable_records_do_not_guess_a_port(self):
        self.assertIsNone(repoql_native_auth.panel_origin(str(self.workspace)))
        for payload in ('not json', '[]', {'url': 'http://127.0.0.1:1/extra'},
                        {'url': 'http://example.invalid:50001'}, {'url': 50001}, {'secret': 'x'}):
            with self.subTest(payload=payload):
                self.write_record(payload)
                self.assertIsNone(repoql_native_auth.panel_origin(str(self.workspace)))
        # Symlinked and oversized records are refused rather than followed.
        self.record.unlink()
        target = self.workspace / 'outside.json'
        target.write_text(json.dumps({'url': 'http://127.0.0.1:50001'}), encoding='utf-8')
        try:
            self.record.symlink_to(target)
        except (OSError, NotImplementedError):
            self.skipTest('symlinks unavailable in this environment')
        self.assertIsNone(repoql_native_auth.panel_origin(str(self.workspace)))

    def test_relative_or_missing_workspace_is_not_a_record(self):
        cwd = os.getcwd()
        self.assertEqual(repoql_native_auth.dashboard_bind_record(''), None)
        self.assertEqual(repoql_native_auth.dashboard_bind_record('relative/path'), None)
        self.assertTrue(str(repoql_native_auth.dashboard_bind_record(cwd)).endswith('dashboard-bind.json'))


def make_handler():
    handler = object.__new__(server.Handler)
    handler.app = SimpleNamespace(token='private-test-secret')
    handler.headers = {'Host': '127.0.0.1:18200'}
    handler.rfile = io.BytesIO()
    handler.wfile = io.BytesIO()
    return handler


class PanelUpstreamBoundaryTests(unittest.TestCase):
    def test_redirect_is_confined_to_the_resolved_panel_port(self):
        handler = make_handler()
        with patch.object(server, 'native_repoql_upstream', return_value=('127.0.0.1', 59796)):
            self.assertEqual(handler._safe_repoql_redirect('http://127.0.0.1:59796/#k=cap', '/login'),
                             '/embed/repoql/#k=cap')
            for foreign in ('http://127.0.0.1:41005/#k=cap', 'http://127.0.0.1:59797/login',
                            'http://localhost:52511/#k=cap'):
                with self.subTest(foreign=foreign), self.assertRaises(PermissionError):
                    handler._safe_repoql_redirect(foreign, '/')


if __name__ == '__main__':
    unittest.main()
