"""HTTP-level variant enforcement, without network or live upstream services."""
import io
import os
import unittest
from unittest.mock import patch
from server import Handler

class FakeHandler:
    def __init__(self, path='/'):
        self.path = path
        self.headers = {}
        self.wfile = io.BytesIO()
        self.code = None
        self.payload = None
        self.sent_headers = {}

    def send_json(self, code, payload):
        self.code = int(code)
        self.payload = payload

    def send_response(self, code):
        self.code = int(code)

    def send_header(self, key, value):
        self.sent_headers[key] = value

    def end_headers(self):
        pass

    def access_identity(self):
        return None

class VariantHttp(unittest.TestCase):
    def test_disallowed_ghost_and_office_api_routes_are_rejected_pre_proxy(self):
        for n in (1,3):
            with self.subTest(option=n), patch.dict(os.environ, {'SINGULARITY_INSTALL_VARIANT':str(n), 'SINGULARITY_WINDOWS_NATIVE':'1'}):
                for url in ('/api/ghost/status', '/api/ghost/control', '/api/embed/office/handshake', '/embed/office/index.html', '/api/harness/office'):
                    fake=FakeHandler(url)
                    Handler.route(fake,'GET')
                    self.assertEqual(fake.code,404,url)
                    self.assertEqual(fake.payload,{'error':'feature_not_in_install_variant'})

    def test_no_ghost_asset_is_served_for_lean_variants(self):
        for n in (1,3):
            with patch.dict(os.environ, {'SINGULARITY_INSTALL_VARIANT':str(n),'SINGULARITY_WINDOWS_NATIVE':'1'}):
                fake=FakeHandler('/ghost/dashboard.js')
                Handler.serve_static(fake, '/ghost/dashboard.js')
                self.assertEqual(fake.code,404)
                self.assertEqual(fake.wfile.getvalue(),b'')

    def test_ghost_calendar_module_served_as_javascript_in_complete_variant(self):
        with patch.dict(os.environ, {'SINGULARITY_INSTALL_VARIANT':'2','SINGULARITY_WINDOWS_NATIVE':'1'}):
            fake=FakeHandler('/ghost/schedule_model.mjs')
            Handler.serve_static(fake, '/ghost/schedule_model.mjs')
            self.assertEqual(fake.code,200)
            self.assertEqual(fake.sent_headers.get('Content-Type'),'application/javascript; charset=utf-8')
            self.assertIn(b'export function weekDays',fake.wfile.getvalue())

    def test_home_page_exposes_only_public_variant_flags(self):
        for n in (1,2,3,4):
            with patch.dict(os.environ, {'SINGULARITY_INSTALL_VARIANT':str(n),'SINGULARITY_WINDOWS_NATIVE':'1'}):
                fake=FakeHandler('/')
                Handler.serve_static(fake, '/')
                self.assertEqual(fake.code,200)
                body=fake.wfile.getvalue().decode('utf-8')
                self.assertIn(f'"variant":{n}',body)
                self.assertIn('window.__SINGULARITY_VARIANT__',body)
                self.assertNotIn('gatewayKey',body)
                self.assertNotIn('ingestKey',body)

if __name__=='__main__': unittest.main()
