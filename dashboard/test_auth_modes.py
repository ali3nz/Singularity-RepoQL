"""Auth-mode contract tests (owner addendum A2/A5), isolated state dirs only.

auto-local: a loopback navigation that passes the drive-by checks is issued the
normal session cookie with no account and no prompt.
password: the pre-existing create-account/login/throttle/expiry contract, opt-in.
"""
import http.client
import json
import os
from pathlib import Path
import sys
import tempfile
import threading
import unittest
from unittest.mock import patch

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE))
from local_account import LocalAccount, AccountRefused
from repoql_bridge import Config
from server import build_server


def headers_of(response):
    return {name.lower(): value for name, value in response.getheaders()}


class LocalAccountModeUnit(unittest.TestCase):
    def test_default_mode_is_auto_local(self):
        with tempfile.TemporaryDirectory() as td, patch.dict(os.environ, {}, clear=False):
            os.environ.pop('SINGULARITY_DASHBOARD_AUTH_MODE', None)
            auth = LocalAccount(Path(td))
            self.assertEqual(auth.mode, 'auto-local')
            self.assertTrue(auth.auto_local)
            self.assertFalse(auth.configured())

    def test_mode_persists_0600_and_survives_restart(self):
        with tempfile.TemporaryDirectory() as td, patch.dict(os.environ, {}, clear=False):
            os.environ.pop('SINGULARITY_DASHBOARD_AUTH_MODE', None)
            root = Path(td)
            auth = LocalAccount(root)
            self.assertEqual(auth.set_mode('password'), 'password')
            mode_file = root / 'auth-mode.json'
            self.assertTrue(mode_file.exists())
            self.assertEqual(mode_file.stat().st_mode & 0o777, 0o600)
            self.assertEqual(json.loads(mode_file.read_text()), {'version': 1, 'mode': 'password'})
            self.assertEqual(LocalAccount(root).mode, 'password')

    def test_mode_switch_revokes_sessions(self):
        with tempfile.TemporaryDirectory() as td, patch.dict(os.environ, {}, clear=False):
            os.environ.pop('SINGULARITY_DASHBOARD_AUTH_MODE', None)
            auth = LocalAccount(Path(td))
            cookie = auth.issue_session()
            self.assertTrue(auth.authenticated('srq_session=' + cookie))
            auth.set_mode('password')
            self.assertFalse(auth.authenticated('srq_session=' + cookie))

    def test_invalid_mode_rejected(self):
        with tempfile.TemporaryDirectory() as td, patch.dict(os.environ, {}, clear=False):
            os.environ.pop('SINGULARITY_DASHBOARD_AUTH_MODE', None)
            auth = LocalAccount(Path(td))
            with self.assertRaisesRegex(AccountRefused, 'invalid_auth_mode'):
                auth.set_mode('anything-else')
            self.assertEqual(auth.mode, 'auto-local')

    def test_mode_file_symlink_refused(self):
        with tempfile.TemporaryDirectory() as td, patch.dict(os.environ, {}, clear=False):
            os.environ.pop('SINGULARITY_DASHBOARD_AUTH_MODE', None)
            root = Path(td)
            (root / 'elsewhere.json').write_text(json.dumps({'version': 1, 'mode': 'password'}))
            (root / 'auth-mode.json').symlink_to(root / 'elsewhere.json')
            with self.assertRaisesRegex(AccountRefused, 'account_path_reparse_refused'):
                LocalAccount(root)


class HTTPCase(unittest.TestCase):
    mode = None

    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        env = {'SINGULARITY_LOCAL_ACCOUNT_AUTH': '1'}
        if self.mode is not None:
            env['SINGULARITY_DASHBOARD_AUTH_MODE'] = self.mode
        self.env = patch.dict(os.environ, env, clear=False)
        self.env.start()
        root = Path(self.temp.name)
        config = Config(workspace=root, rql=root / 'rql', state_dir=root / 'state',
                        bind='127.0.0.1', port=0, allow_peers=('127.0.0.1/32',))
        self.server = build_server(config)
        self.thread = threading.Thread(target=self.server.serve_forever, daemon=True)
        self.thread.start()
        self.port = self.server.server_address[1]

    def tearDown(self):
        self.server.shutdown()
        self.server.server_close()
        self.thread.join(timeout=2)
        self.env.stop()
        self.temp.cleanup()

    def request(self, path='/', *, method='GET', headers=None, payload=None):
        conn = http.client.HTTPConnection('127.0.0.1', self.port, timeout=5)
        body = json.dumps(payload).encode() if payload is not None else None
        conn.request(method, path, body=body, headers=headers or {})
        response = conn.getresponse()
        data = response.read()
        result = (response.status, headers_of(response), data)
        conn.close()
        return result

    def same_origin_headers(self, *, cookie=None):
        headers = {'Origin': f'http://127.0.0.1:{self.port}',
                   'X-Requested-With': 'repoql-dashboard',
                   'Content-Type': 'application/json',
                   'Sec-Fetch-Site': 'same-origin'}
        if cookie:
            headers['Cookie'] = cookie
        return headers


class AutoLocal(HTTPCase):
    mode = None  # product default

    def test_first_request_is_already_signed_in(self):
        status, headers, _ = self.request('/')
        self.assertEqual(status, 200)
        cookie = headers.get('set-cookie', '')
        self.assertIn('srq_session=', cookie)
        self.assertIn('HttpOnly', cookie)
        self.assertIn('SameSite=Strict', cookie)
        value = cookie.split('srq_session=', 1)[1].split(';', 1)[0]
        # the issued cookie is a real session, and no login page was served
        status2, _, body = self.request('/api/account/status', headers={'Cookie': 'srq_session=' + value})
        self.assertEqual(status2, 200)
        payload = json.loads(body)
        self.assertTrue(payload['authenticated'])
        self.assertTrue(payload['auto_local'])
        self.assertEqual(payload['mode'], 'auto-local')
        self.assertFalse(payload['configured'])

    def test_foreign_host_gets_no_session(self):
        status, headers, _ = self.request('/api/features', headers={'Host': 'evil.example'})
        self.assertEqual(status, 401)
        self.assertNotIn('set-cookie', headers)

    def test_cross_site_navigation_gets_no_session(self):
        status, headers, _ = self.request('/api/features', headers={'Sec-Fetch-Site': 'cross-site'})
        self.assertEqual(status, 401)
        self.assertNotIn('set-cookie', headers)

    def test_foreign_origin_gets_no_session(self):
        status, headers, _ = self.request('/api/features', headers={'Origin': 'http://evil.example'})
        self.assertEqual(status, 401)
        self.assertNotIn('set-cookie', headers)

    def test_cookie_mutation_without_origin_is_refused(self):
        _, headers, _ = self.request('/')
        value = headers['set-cookie'].split('srq_session=', 1)[1].split(';', 1)[0]
        status, _, body = self.request('/api/account/mode', method='POST',
                                        payload={'mode': 'password'},
                                        headers={'Cookie': 'srq_session=' + value,
                                                 'Content-Type': 'application/json'})
        self.assertEqual(status, 403)
        self.assertIn('local_origin_required', body.decode())

    def test_settings_toggle_switches_to_password_and_back(self):
        _, headers, _ = self.request('/')
        value = headers['set-cookie'].split('srq_session=', 1)[1].split(';', 1)[0]
        status, _, body = self.request('/api/account/mode', method='POST', payload={'mode': 'password'},
                                       headers=self.same_origin_headers(cookie='srq_session=' + value))
        self.assertEqual(status, 200)
        self.assertEqual(json.loads(body)['mode'], 'password')
        # password mode with no account: the API is closed again (the shell stays 200)
        status, headers, _ = self.request('/api/features', headers={'Cookie': 'srq_session=' + value})
        self.assertEqual(status, 401)
        # create the owner account, then opt back into auto-local from Settings
        status, headers, _ = self.request('/api/account/setup', method='POST',
                                         payload={'username': 'operator', 'password': 'a-private-phrase-1234'},
                                         headers=self.same_origin_headers())
        self.assertEqual(status, 200)
        account_cookie = headers['set-cookie'].split('srq_session=', 1)[1].split(';', 1)[0]
        status, _, body = self.request('/api/account/mode', method='POST', payload={'mode': 'auto-local'},
                                       headers=self.same_origin_headers(cookie='srq_session=' + account_cookie))
        self.assertEqual(status, 200)
        self.assertEqual(json.loads(body)['mode'], 'auto-local')
        # the toggle cleared the password session; auto-local re-issues a fresh one
        status, headers, _ = self.request('/api/features', headers={'Cookie': 'srq_session=' + account_cookie})
        self.assertEqual(status, 200)
        self.assertIn('srq_session=', headers.get('set-cookie', ''))

    def test_invalid_mode_is_bad_request(self):
        _, headers, _ = self.request('/')
        value = headers['set-cookie'].split('srq_session=', 1)[1].split(';', 1)[0]
        status, _, body = self.request('/api/account/mode', method='POST', payload={'mode': 'open-sesame'},
                                       headers=self.same_origin_headers(cookie='srq_session=' + value))
        self.assertEqual(status, 400)
        self.assertIn('invalid_auth_mode', body.decode())


class PasswordMode(HTTPCase):
    mode = 'password'

    def test_password_mode_requires_account_and_login(self):
        status, headers, _ = self.request('/api/features')
        self.assertEqual(status, 401)
        self.assertNotIn('set-cookie', headers)
        status, headers, _ = self.request(
            '/api/account/setup', method='POST',
            payload={'username': 'operator', 'password': 'a-private-phrase-1234'},
            headers=self.same_origin_headers())
        self.assertEqual(status, 200)
        value = headers['set-cookie'].split('srq_session=', 1)[1].split(';', 1)[0]
        status, _, _ = self.request('/', headers={'Cookie': 'srq_session=' + value})
        self.assertEqual(status, 200)
        status, _, body = self.request('/api/account/status', headers={'Cookie': 'srq_session=' + value})
        self.assertEqual(status, 200)
        self.assertEqual(json.loads(body)['mode'], 'password')
        self.assertTrue(json.loads(body)['configured'])

    def test_logout_revokes_and_wrong_password_is_401(self):
        _, headers, _ = self.request('/api/account/setup', method='POST',
                                     payload={'username': 'operator', 'password': 'a-private-phrase-1234'},
                                     headers=self.same_origin_headers())
        value = headers['set-cookie'].split('srq_session=', 1)[1].split(';', 1)[0]
        cookie = 'srq_session=' + value
        status, _, _ = self.request('/api/account/logout', method='POST', headers=self.same_origin_headers(cookie=cookie))
        self.assertEqual(status, 200)
        status, _, _ = self.request('/api/features', headers={'Cookie': cookie})
        self.assertEqual(status, 401)
        status, _, body = self.request('/api/account/login', method='POST',
                                       payload={'username': 'operator', 'password': 'wrong-password-1'},
                                       headers=self.same_origin_headers())
        self.assertEqual(status, 401)
        self.assertIn('invalid_credentials', body.decode())


if __name__ == '__main__':
    unittest.main(verbosity=2)
