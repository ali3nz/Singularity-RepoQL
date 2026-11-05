"""Auth broker regression: panel audiences and no weak on-disk Windows token."""
import tempfile
import unittest
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import patch

import repoql_native_auth as auth
import native_panel_proxy as panel


class AuthBrokerTests(unittest.TestCase):
    def test_launch_cookies_are_panel_audience_scoped(self):
        for source in ('repoql', 'tencent', 'office', 'kanzo'):
            with self.subTest(source=source):
                cookie = auth.create_launch_cookie('test-private-secret', now=123_456, audience=source)
                header = f'{auth.COOKIE_NAME}={cookie}'
                for target in ('repoql', 'tencent', 'office', 'kanzo'):
                    self.assertEqual(auth.valid_launch_cookie(header, 'test-private-secret', now=123_500, max_age=60, audience=target), source == target)
                self.assertFalse(auth.valid_launch_cookie(header, 'test-private-secret', now=123_518, max_age=60, audience=source))

    def test_wrong_panel_cookie_cannot_authorize_proxy(self):
        value = auth.create_launch_cookie('secret', audience='office')
        handler = SimpleNamespace(
            headers={'Cookie': f'{auth.COOKIE_NAME}={value}'},
            app=SimpleNamespace(token='secret'), authorized=lambda: False,
        )
        self.assertTrue(panel.authenticated(handler, 'office'))
        self.assertFalse(panel.authenticated(handler, 'tencent'))
        self.assertFalse(panel.authenticated(handler, 'kanzo'))

    def test_windows_native_issuer_never_persists_capability_to_disk(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            cache_file = root / 'capability.txt'
            issuer = root / 'rql.exe'
            auth._WINDOWS_LOGIN_CACHE.clear()
            issued = 'http://127.0.0.1:8000/#k=abcdefghijklmnopqrst'
            result = SimpleNamespace(returncode=0, stdout='login: ' + issued, stderr='')
            with patch.object(auth, '_is_windows', return_value=True), \
                patch.object(auth.subprocess, 'run', return_value=result) as run, \
                patch.object(auth.tempfile, 'mkstemp', side_effect=AssertionError('windows must not write token')), \
                patch.object(auth.os, 'replace', side_effect=AssertionError('windows must not write token')):
                first = auth.refresh_native_login_path(force=True, login_file=str(cache_file), rql_binary=str(issuer), workspace=str(root))
                self.assertEqual(first, '/embed/repoql/#k=abcdefghijklmnopqrst')
                self.assertEqual(auth.native_login_path(str(cache_file)), first)
                second = auth.refresh_native_login_path(login_file=str(cache_file), rql_binary=str(issuer), workspace=str(root))
                self.assertEqual(second, first)
                self.assertEqual(run.call_count, 1)
                self.assertFalse(cache_file.exists())
            auth._WINDOWS_LOGIN_CACHE.clear()
            self.assertIsNone(auth.native_login_path(str(cache_file)))

    def test_reject_invalid_audience(self):
        with self.assertRaises(ValueError):
            auth.create_launch_cookie('secret', audience='admin')

if __name__ == '__main__':
    unittest.main()
