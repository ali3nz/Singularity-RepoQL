"""Protect sensitive exception text in dashboard's generic error boundary."""
import contextlib
import io
from pathlib import Path
import subprocess
import sys
import tempfile
import time
from types import SimpleNamespace
import unittest
from unittest.mock import patch
import repoql_bridge
from repoql_bridge import Config, RepoQL
from server import Handler


class DashboardUnexpectedFailureTests(unittest.TestCase):
    def test_unexpected_exception_never_echoes_sensitive_exception_text(self):
        h = object.__new__(Handler)
        h.path = '/api/test'
        h.headers = {'Host': 'localhost:18100'}
        h.is_public_office_host = lambda: False
        h.authorized = lambda: True
        h.dispatch = lambda *_: (_ for _ in ()).throw(RuntimeError('api_key=test-secret; file=C:/private'))
        response = []
        h.send_json = lambda code, payload: response.append((code, payload))
        h.request_origin_allowed = lambda **kwargs: True
        out = io.StringIO()
        with patch('server.variant_features',return_value={'features': {}}), \
             patch('server.variant_route_allowed',return_value=True), \
             contextlib.redirect_stderr(out):
            h.route('GET')
        self.assertEqual(response, [(500, {'error': 'internal_error'})])
        self.assertNotIn('test-secret',out.getvalue())
        self.assertNotIn('C:/private',out.getvalue())
        self.assertIn('RuntimeError',out.getvalue())


class WindowsBridgeProcessTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        root = Path(self.temp.name)
        self.rql = RepoQL(Config(workspace=root, rql=Path(sys.executable),
                                 state_dir=root, bind='127.0.0.1', port=18199))

    def test_windows_dispatch_uses_file_backed_runner(self):
        result = subprocess.CompletedProcess([], 0, '{}', '')
        with patch.object(repoql_bridge, 'os', SimpleNamespace(name='nt')), \
             patch.object(self.rql, '_run_windows', return_value=result) as run:
            self.assertIs(self.rql.run(['host', 'status'], timeout=7), result)
        run.assert_called_once_with([sys.executable, 'host', 'status'], 7)

    def test_non_windows_keeps_existing_runner(self):
        result = subprocess.CompletedProcess([], 0, '{}', '')
        with patch.object(repoql_bridge, 'os', SimpleNamespace(name='posix')), \
             patch.object(repoql_bridge.subprocess, 'run', return_value=result) as run:
            self.assertIs(self.rql.run(['host', 'status'], timeout=7), result)
        run.assert_called_once_with([sys.executable, 'host', 'status'],
                                    cwd=self.temp.name, capture_output=True,
                                    text=True, timeout=7, check=False)

    def test_output_preserves_utf8_stderr_and_exit_status(self):
        code = "import os;os.write(1, 'caf\u00e9'.encode('utf-8'));os.write(2,b'diagnostic');raise SystemExit(3)"
        result = self.rql._run_windows([sys.executable, '-c', code], 5)
        self.assertEqual((result.returncode, result.stdout, result.stderr),
                         (3, 'caf\u00e9', 'diagnostic'))

    @staticmethod
    def holding_child():
        # Keep inherited output open, but not the test's workspace directory.
        return ("import subprocess,sys,os,time; "
                "subprocess.Popen([sys.executable,'-c','import time;time.sleep(2)'],"
                "cwd=os.path.dirname(sys.executable)); ")

    def test_completed_client_does_not_wait_for_inherited_output(self):
        code = self.holding_child() + "os.write(1,b'complete')"
        start = time.monotonic()
        result = self.rql._run_windows([sys.executable, '-c', code], 5)
        elapsed = time.monotonic() - start
        self.assertEqual((result.returncode, result.stdout), (0, 'complete'))
        self.assertLess(elapsed, 1.5)

    def test_timeout_does_not_wait_for_inherited_output(self):
        code = self.holding_child() + "time.sleep(10)"
        start = time.monotonic()
        with self.assertRaises(subprocess.TimeoutExpired):
            self.rql._run_windows([sys.executable, '-c', code], .25)
        self.assertLess(time.monotonic() - start, 1.5)

    def test_cache_key_and_query_slot_are_released_after_timeout(self):
        with patch.object(self.rql, 'run', side_effect=[
                subprocess.TimeoutExpired('fixture', .25),
                subprocess.CompletedProcess([], 0, '[{"ok":true}]', '')]):
            with self.assertRaises(subprocess.TimeoutExpired):
                self.rql.query_cached('engine', 'SELECT 1', 3, timeout=.25)
            self.assertEqual(self.rql.query_cached('engine', 'SELECT 1', 3), [{'ok': True}])


if __name__=='__main__':unittest.main()
