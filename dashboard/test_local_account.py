"""No network or model dependency: local first-use and credential storage tests."""
import json
import os
from pathlib import Path
import sys
import tempfile
import threading
import unittest
from unittest.mock import patch
from urllib.request import Request, build_opener, HTTPHandler
from urllib.error import HTTPError

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE))
from local_account import LocalAccount, AccountRefused
from repoql_bridge import Config
from server import build_server


class AccountStorage(unittest.TestCase):
    def test_setup_verify_and_reject_duplicate(self):
        with tempfile.TemporaryDirectory() as td:
            auth = LocalAccount(Path(td))
            self.assertFalse(auth.configured())
            value = auth.setup('operator', 'an-unpredictable-phrase-123')
            account_data = (Path(td) / 'local-account.json').read_text()
            self.assertNotIn('an-unpredictable-phrase-123', account_data)
            self.assertTrue(auth.authenticated('srq_session=' + value))
            with self.assertRaisesRegex(AccountRefused, 'account_already_configured'):
                auth.setup('someone', 'another-secret-phrase-456')
            auth.revoke('srq_session=' + value)
            self.assertFalse(auth.authenticated('srq_session=' + value))
            second = auth.login('operator', 'an-unpredictable-phrase-123', '127.0.0.1')
            self.assertTrue(auth.authenticated('another=bad; srq_session=' + second))
            self.assertFalse(auth.authenticated('srq_session=' + value))

    def test_guesses_throttled_and_bad_password(self):
        with tempfile.TemporaryDirectory() as td:
            auth = LocalAccount(Path(td))
            auth.setup('owner', 'some-private-password-1234')
            for _ in range(5):
                with self.assertRaisesRegex(AccountRefused, 'invalid_credentials'):
                    auth.login('owner', 'wrong', '127.0.0.1')
            with self.assertRaisesRegex(AccountRefused, 'too_many_attempts'):
                auth.login('owner', 'some-private-password-1234', '127.0.0.1')

    def test_account_file_symlink_refused(self):
        with tempfile.TemporaryDirectory() as td:
            root = Path(td)
            (root / 'private').write_text('target')
            (root / 'local-account.json').symlink_to(root / 'private')
            with self.assertRaisesRegex(AccountRefused, 'account_path_reparse_refused'):
                LocalAccount(root)


class HTTPAccountBoundary(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.env = patch.dict(os.environ, {'SINGULARITY_LOCAL_ACCOUNT_AUTH': '1'}, clear=False)
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

    def request(self, path='/', *, method='GET', payload=None, cookie=None, origin=True, other_headers=None):
        url = f'http://127.0.0.1:{self.port}{path}'
        headers = {}
        if cookie:
            headers['Cookie'] = cookie
        if origin:
            headers['Origin'] = f'http://127.0.0.1:{self.port}'
        if method == 'POST':
            headers.update({'Content-Type': 'application/json', 'X-Requested-With': 'repoql-dashboard'})
        if other_headers:
            headers.update(other_headers)
        data = json.dumps(payload).encode() if payload is not None else b'{}' if method == 'POST' else None
        req = Request(url, method=method, headers=headers, data=data)
        try:
            with build_opener(HTTPHandler).open(req, timeout=5) as rsp:
                return rsp.status, dict(rsp.headers.items()), rsp.read()
        except HTTPError as err:
            return err.code, dict(err.headers.items()), err.read()

    def test_first_visit_setup_login_logout_and_local_origin(self):
        status, headers, body = self.request('/', origin=False)
        self.assertEqual(status, 200)
        self.assertIn(b'/api/account/setup', body)
        self.assertNotIn(b'__RQDASH_ACCESS__', body)
        self.assertEqual(self.request('/api/features', origin=False)[0], 401)
        self.assertEqual(self.request('/api/account/status', origin=False)[0], 200)
        payload={'username':'owner','password':'this-is-a-strong-passphrase'}
        bad=self.request('/api/account/setup', method='POST', payload=payload, other_headers={'Origin':'https://evil.example'})
        self.assertEqual(bad[0], 403)
        accepted=self.request('/api/account/setup', method='POST', payload=payload)
        self.assertEqual(accepted[0], 200)
        cookie=accepted[1]['Set-Cookie'].split(';',1)[0]
        self.assertIn('HttpOnly', accepted[1]['Set-Cookie'])
        self.assertIn('SameSite=Strict',accepted[1]['Set-Cookie'])
        self.assertEqual(self.request('/api/account/setup',method='POST',payload=payload)[0],409)
        self.assertEqual(self.request('/api/features', cookie=cookie, origin=False)[0],200)
        self.assertEqual(self.request('/',cookie=cookie,origin=False)[0],200)
        self.assertIn(b'__SINGULARITY_LOCAL_LOGIN__',self.request('/',cookie=cookie,origin=False)[2])
        self.assertEqual(self.request('/api/features',origin=False)[0],401)
        self.assertEqual(self.request('/api/account/logout',method='POST',cookie=cookie)[0],200)
        self.assertEqual(self.request('/api/features',cookie=cookie,origin=False)[0],401)
        result=self.request('/api/account/login',method='POST',payload=payload)
        self.assertEqual(result[0],200)
        self.assertNotIn(payload['password'].encode(),result[2])

    def test_cookie_mutation_rejects_missing_origin(self):
        payload={'username':'owner','password':'this-is-a-strong-passphrase'}
        accepted=self.request('/api/account/setup',method='POST',payload=payload)
        cookie=accepted[1]['Set-Cookie'].split(';',1)[0]
        # Generic dashboard API mutating operations cannot rely on a cookie
        # without the browser's exact Origin.
        self.assertEqual(self.request('/api/ghost/plans',method='POST',cookie=cookie,origin=False)[0],403)
        self.assertEqual(self.request('/app.js',cookie=None,origin=False)[0],401)


if __name__ == '__main__':
    unittest.main()
