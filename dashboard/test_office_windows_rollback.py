"""Regression coverage for Claude Office token-URL rollback on native Windows.

Uses placeholder secrets only. Never writes or prints a real bearer token.
"""
import os
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

from office_bridge import embed_url, validated_legacy_embed_token
from native_panel_proxy import backend_key

LEGACY = 'https://office.example.test/?token=synthetic-office-token&embed=1'


class WindowsOfficeRollbackTests(unittest.TestCase):
    def test_explicit_key_file_does_not_fall_back_to_legacy_url(self):
        with patch.dict(os.environ, {
            'SINGULARITY_WINDOWS_NATIVE': '1',
            'SINGULARITY_OFFICE_NATIVE_AUTH_MODE': 'key_file',
            'SINGULARITY_OFFICE_PANEL_KEY_FILE': '',
            'CLAUDE_OFFICE_PUBLIC_URL': 'https://office.example.test',
            'CLAUDE_OFFICE_EMBED_URL': LEGACY,
            'SINGULARITY_OFFICE_EMBED_URL': '',
        }, clear=True):
            with self.assertRaises(PermissionError):
                backend_key('office')
            self.assertIsNone(embed_url())

    def test_native_token_url_is_default_and_never_sent_to_browser(self):
        with patch.dict(os.environ, {
            'SINGULARITY_WINDOWS_NATIVE': '1',
            'CLAUDE_OFFICE_PUBLIC_URL': 'https://office.example.test',
            'CLAUDE_OFFICE_EMBED_URL': LEGACY,
            'SINGULARITY_OFFICE_PANEL_KEY_FILE': '',
        }, clear=True):
            self.assertEqual(backend_key('office'), 'synthetic-office-token')
            self.assertEqual(embed_url(), '/embed/office/?embed=1')
            self.assertNotIn('synthetic-office-token', embed_url())

    def test_default_accepts_supported_room_in_existing_token_url(self):
        with patch.dict(os.environ, {
            'SINGULARITY_WINDOWS_NATIVE': '1',
            'CLAUDE_OFFICE_PUBLIC_URL': 'https://office.example.test',
            'CLAUDE_OFFICE_EMBED_URL': LEGACY + '&room=modern',
        }, clear=True):
            self.assertEqual(backend_key('office'), 'synthetic-office-token')
            self.assertEqual(embed_url(), '/embed/office/?embed=1')

    def test_native_private_file_works_without_any_public_token_url(self):
        with tempfile.TemporaryDirectory() as tmp:
            key_path = Path(tmp) / 'office.key'
            key_path.write_text('synthetic-file-key\n')
            with patch.dict(os.environ, {
                'SINGULARITY_WINDOWS_NATIVE': '1',
                'SINGULARITY_OFFICE_PANEL_KEY_FILE': str(key_path),
                'SINGULARITY_OFFICE_NATIVE_AUTH_MODE': 'key_file',
                'CLAUDE_OFFICE_PUBLIC_URL': '',
                'CLAUDE_OFFICE_EMBED_URL': '',
            }, clear=True):
                self.assertEqual(backend_key('office'), 'synthetic-file-key')
                self.assertEqual(embed_url(), '/embed/office/?embed=1')

    def test_explicit_legacy_url_mode_restores_original_method(self):
        with patch.dict(os.environ, {
            'SINGULARITY_WINDOWS_NATIVE': '1',
            'SINGULARITY_OFFICE_NATIVE_AUTH_MODE': 'legacy_url',
            'SINGULARITY_OFFICE_PANEL_KEY_FILE': '',
            'CLAUDE_OFFICE_PUBLIC_URL': 'https://office.example.test',
            'CLAUDE_OFFICE_EMBED_URL': LEGACY,
        }, clear=True):
            self.assertEqual(backend_key('office'), 'synthetic-office-token')
            self.assertEqual(embed_url(), '/embed/office/?embed=1')
            self.assertNotIn('synthetic-office-token', embed_url())

    def test_legacy_token_requires_matching_https_public_host(self):
        urls = [
            'http://office.example.test/?token=synthetic-office-token&embed=1',
            'https://attacker.example.test/?token=synthetic-office-token&embed=1',
            'https://office.example.test/path?token=synthetic-office-token&embed=1',
            'https://office.example.test/?token=synthetic-office-token&embed=0',
            'https://office.example.test/?token=synthetic-office-token&embed=1&other=x',
            'https://office.example.test/?token=synthetic-office-token&embed=1&room=untrusted',
            'https://office.example.test/?token=synthetic-office-token&token=other&embed=1',
            'https://office.example.test/?embed=1',
        ]
        for value in urls:
            with self.subTest(value=value), patch.dict(os.environ, {
                'SINGULARITY_WINDOWS_NATIVE': '1',
                'SINGULARITY_OFFICE_NATIVE_AUTH_MODE': 'legacy_url',
                'CLAUDE_OFFICE_PUBLIC_URL': 'https://office.example.test',
                'CLAUDE_OFFICE_EMBED_URL': value,
            }, clear=True):
                self.assertIsNone(validated_legacy_embed_token())
                with self.assertRaises(PermissionError):
                    backend_key('office')
                self.assertIsNone(embed_url())

    def test_bad_mode_does_not_fall_back_to_any_token_source(self):
        with patch.dict(os.environ, {
            'SINGULARITY_WINDOWS_NATIVE': '1',
            'SINGULARITY_OFFICE_NATIVE_AUTH_MODE': 'typo',
            'CLAUDE_OFFICE_PUBLIC_URL': 'https://office.example.test',
            'CLAUDE_OFFICE_EMBED_URL': LEGACY,
        }, clear=True):
            with self.assertRaises(PermissionError):
                backend_key('office')
            self.assertIsNone(embed_url())

    def test_linux_legacy_with_extra_public_query_keeps_old_launch_behavior(self):
        with patch.dict(os.environ, {
            'SINGULARITY_WINDOWS_NATIVE': '0',
            'CLAUDE_OFFICE_PUBLIC_URL': 'https://office.example.test',
            'CLAUDE_OFFICE_EMBED_URL': LEGACY + '&room=modern',
        }, clear=True):
            self.assertEqual(embed_url(), '/embed/office/?embed=1')

    def test_linux_legacy_backend_key_remains_unchanged(self):
        with patch.dict(os.environ, {
            'SINGULARITY_WINDOWS_NATIVE': '0',
            'CLAUDE_OFFICE_PUBLIC_URL': 'https://office.example.test',
            'CLAUDE_OFFICE_EMBED_URL': LEGACY,
        }, clear=True):
            self.assertEqual(backend_key('office'), 'synthetic-office-token')
            self.assertEqual(embed_url(), '/embed/office/?embed=1')


if __name__ == '__main__':
    unittest.main()
