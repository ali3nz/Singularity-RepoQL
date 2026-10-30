"""Real loopback regression: no redirect, proxy or malicious coordinator data."""
import json
import os
import threading
import tempfile
import unittest
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from unittest.mock import patch

import harness_rust as harness


class HostileCoordinator(BaseHTTPRequestHandler):
    behavior = 'ok'
    requests = []
    redirect_target = ''
    def log_message(self, *args):
        pass
    def do_GET(self):
        type(self).requests.append((self.path, self.headers.get('Authorization')))
        if type(self).behavior == 'redirect':
            self.send_response(302)
            self.send_header('Location', type(self).redirect_target)
            self.end_headers()
        elif type(self).behavior == 'notok':
            body = {'schema': harness.SCHEMA, 'readOnly': True, 'ok': False, 'available': True}
            self.send_response(200)
            self.end_headers()
            self.wfile.write(json.dumps(body).encode())
        elif type(self).behavior == 'oversize':
            self.send_response(200)
            self.end_headers()
            self.wfile.write(b'x' * (harness.MAX_BODY + 2))
        else:
            self.send_response(200)
            self.send_header('Content-Type', 'application/json')
            self.end_headers()
            self.wfile.write(json.dumps({'schema':harness.SCHEMA,'ok':True,'readOnly':True}).encode())


class Recipient(BaseHTTPRequestHandler):
    requests = []
    def log_message(self, *args):
        pass
    def do_GET(self):
        type(self).requests.append((self.path,self.headers.get('Authorization')))
        self.send_response(200)
        self.end_headers()
        self.wfile.write(b'{}')


class NativeCoordinatorSecurityTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.server = ThreadingHTTPServer(('127.0.0.1',0),HostileCoordinator)
        cls.target = ThreadingHTTPServer(('127.0.0.1',0),Recipient)
        cls.threads=[]
        for server in (cls.server,cls.target):
            thread=threading.Thread(target=server.serve_forever,daemon=True)
            thread.start()
            cls.threads.append(thread)

    @classmethod
    def tearDownClass(cls):
        for server in (cls.server,cls.target):
            server.shutdown(); server.server_close()
        for thread in cls.threads: thread.join(3)

    def setUp(self):
        HostileCoordinator.behavior='ok'
        HostileCoordinator.requests.clear();Recipient.requests.clear()
        self.client=harness.RustHarness(base_url=f'http://127.0.0.1:{self.server.server_port}',token='superprivate')

    def test_valid_authenticated_health(self):
        self.assertTrue(self.client.health()['available'])
        self.assertEqual(HostileCoordinator.requests[0][1], 'Bearer superprivate')

    def test_redirect_never_reaches_second_service(self):
        HostileCoordinator.behavior='redirect'
        HostileCoordinator.redirect_target=f'http://127.0.0.1:{self.target.server_port}/stolen'
        response=self.client.health()
        self.assertFalse(response['available'])
        self.assertEqual(Recipient.requests,[])
        self.assertNotIn('superprivate',json.dumps(response))

    def test_no_redirect_to_different_path_on_same_origin(self):
        HostileCoordinator.behavior='redirect'
        HostileCoordinator.redirect_target=f'http://127.0.0.1:{self.server.server_port}/other'
        self.assertFalse(self.client.health()['available'])
        self.assertEqual(len(HostileCoordinator.requests),1)

    def test_bad_base_urls_refuse_network(self):
        for url in ('http://127.0.0.1','http://example.net:45','http://127.0.0.1:7879/evil',
                    'http://127.0.0.1:7879?token=x','http://me:password@127.0.0.1:7879',
                    'file:///etc/passwd','https://127.0.0.1:7879'):
            with self.subTest(url=url):
                c=harness.RustHarness(base_url=url,token='superprivate')
                self.assertEqual(c.health()['error'],'non_loopback_refused')
        self.assertFalse(HostileCoordinator.requests)

    def test_no_false_healthy_on_upstream_notok(self):
        HostileCoordinator.behavior='notok'
        self.assertEqual(self.client.health(),{'available':False,'error':'health_not_ok'})

    def test_oversize_not_reported_healthy(self):
        HostileCoordinator.behavior='oversize'
        self.assertEqual(self.client.health()['error'],'response_too_large')

    def test_windows_token_default_is_localappdata(self):
        with tempfile.TemporaryDirectory() as td, patch.dict(os.environ,{
            'SINGULARITY_WINDOWS_NATIVE':'1','LOCALAPPDATA':td}, clear=False):
            self.assertEqual(harness._default_token_file(),Path(td)/'Singularity/Harness/coordinator.token')

    def test_remote_url_requires_explicit_https_opt_in(self):
        self.assertFalse(harness._valid_base_url('http://remote.example:443',allow_remote=True))
        self.assertTrue(harness._valid_base_url('https://remote.example:443',allow_remote=True))

if __name__=='__main__':unittest.main()
