"""Actual HTTP route regression for the native Windows supervisor health probe."""
from http.server import ThreadingHTTPServer
import http.client
import os
import threading
import unittest
from unittest.mock import patch

from server import Handler

class _App:
    token = 'not-needed'
    def peer_allowed(self, addr):
        return True

class _Handler(Handler):
    app = _App()

class SupervisorHealthTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.server = ThreadingHTTPServer(('127.0.0.1',0), _Handler)
        cls.worker = threading.Thread(target=cls.server.serve_forever,daemon=True)
        cls.worker.start()
    @classmethod
    def tearDownClass(cls):
        cls.server.shutdown();cls.server.server_close();cls.worker.join(timeout=3)

    def fetch(self, method='GET'):
        c=http.client.HTTPConnection('127.0.0.1', self.server.server_port,timeout=3)
        try:
            c.request(method,'/.well-known/singularity-health')
            r=c.getresponse()
            return r.status, r.getheader('X-Singularity-Component'),r.read(512)
        finally:c.close()

    def test_native_probe_identifies_dashboard_without_token(self):
        with patch.dict(os.environ,{'SINGULARITY_WINDOWS_NATIVE':'1','SINGULARITY_INSTALL_VARIANT':'3'}):
            status, identity, body = self.fetch()
        self.assertEqual(status,200)
        self.assertEqual(identity,'dashboard')
        self.assertEqual(body,b'{"ok":true}')

    def test_linux_deployment_does_not_gain_unauthenticated_probe(self):
        with patch.dict(os.environ,{'SINGULARITY_WINDOWS_NATIVE':'0'}):
            status,identity,_=self.fetch()
        self.assertNotEqual(status,200)
        self.assertIsNone(identity)

    def test_mutating_method_is_refused(self):
        with patch.dict(os.environ,{'SINGULARITY_WINDOWS_NATIVE':'1','SINGULARITY_INSTALL_VARIANT':'3'}):
            status,identity,_=self.fetch('POST')
        self.assertNotEqual(status,200)
        self.assertIsNone(identity)

if __name__=='__main__':unittest.main()
