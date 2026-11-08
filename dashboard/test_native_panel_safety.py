import os
import unittest
from unittest.mock import patch
from native_panel_proxy import _upstream

class NativePanelSafety(unittest.TestCase):
    def test_windows_refuses_remote_tencent_office_kanzo_upstreams(self):
        for name in ['tencent','office','kanzo']:
            with self.subTest(name=name), patch.dict(os.environ,{'SINGULARITY_WINDOWS_NATIVE':'1', f'SINGULARITY_{name.upper()}_HOST':'evil.example.org'}):
                with self.assertRaisesRegex(ValueError,'loopback'):
                    _upstream(name, 4242)
    def test_windows_accepts_only_loopback_and_valid_port(self):
        for name in ['127.0.0.1','localhost','::1']:
            with patch.dict(os.environ,{'SINGULARITY_WINDOWS_NATIVE':'1','SINGULARITY_KANZO_HOST':name,'SINGULARITY_KANZO_PORT':'4242'}):
                self.assertEqual(_upstream('kanzo', 4242),(name,4242))
        with patch.dict(os.environ,{'SINGULARITY_WINDOWS_NATIVE':'1','SINGULARITY_KANZO_PORT':'66000'}):
            with self.assertRaisesRegex(ValueError,'port'): _upstream('kanzo', 4242)


class NativeOfficeAuthentication(unittest.TestCase):
    def test_windows_office_refuses_untrusted_http_token_url(self):
        from native_panel_proxy import backend_key
        with patch.dict(os.environ,{
            'SINGULARITY_WINDOWS_NATIVE':'1',
            'SINGULARITY_OFFICE_EMBED_URL':'http://127.0.0.1/?token=must-not-use',
            'SINGULARITY_OFFICE_PANEL_KEY_FILE':'',
        }):
            with self.assertRaises(PermissionError):
                backend_key('office')

    def test_windows_office_uses_private_key_file_source(self):
        from native_panel_proxy import backend_key
        import tempfile
        from pathlib import Path
        with tempfile.TemporaryDirectory() as d:
            file = Path(d)/'key.txt';file.write_text('a-private-test-key\n')
            with patch.dict(os.environ,{'SINGULARITY_WINDOWS_NATIVE':'1','SINGULARITY_OFFICE_PANEL_KEY_FILE':str(file), 'SINGULARITY_OFFICE_NATIVE_AUTH_MODE':'key_file'}):
                self.assertEqual(backend_key('office'),'a-private-test-key')

    def test_windows_office_reads_only_the_api_key_from_service_keys(self):
        import json
        import tempfile
        from pathlib import Path
        from native_panel_proxy import backend_key

        with tempfile.TemporaryDirectory() as directory:
            file = Path(directory) / 'keys.json'
            with patch.dict(os.environ, {
                'SINGULARITY_WINDOWS_NATIVE': '1',
                'SINGULARITY_OFFICE_PANEL_KEY_FILE': str(file),
                'SINGULARITY_OFFICE_NATIVE_AUTH_MODE': 'service_keys',
            }):
                file.write_text(json.dumps({'apiKey': 'api-fixture', 'ingestKey': 'ingest-fixture'}),
                                encoding='utf-8-sig')
                self.assertEqual(backend_key('office'), 'api-fixture')
                for data in ('{}', '[]', '{"apiKey": 42}', json.dumps({'apiKey': 'bad\nkey'}),
                             'invalid json'):
                    file.write_text(data, encoding='utf-8')
                    with self.subTest(data=data), self.assertRaises(PermissionError):
                        backend_key('office')


if __name__ == '__main__':
    unittest.main()
