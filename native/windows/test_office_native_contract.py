"""Source contract only: Rust must be compiled in a Windows CI before release."""
import unittest
from pathlib import Path

ROOT=Path(__file__).resolve().parents[2]

class OfficeNativeContract(unittest.TestCase):
    def test_token_url_is_default_in_windows_and_key_file_is_explicit(self):
        py=(ROOT/'dashboard/native_panel_proxy.py').read_text()
        self.assertIn("get('SINGULARITY_OFFICE_NATIVE_AUTH_MODE', 'legacy_url')",py)
        self.assertIn("elif mode == 'legacy_url':",py)
        self.assertIn('X-API-Key',py)
        self.assertIn('origin',py)
        self.assertNotIn('browser_secret_url',py)

    def test_rust_office_native_token_and_redacted_preflight_are_wired(self):
        source=(ROOT/'native/desktop-bridge/src/office.rs').read_text()
        main=(ROOT/'native/desktop-bridge/src/main.rs').read_text()
        for required in ('fn launch_token()', 'fn office_credentials()',
                         'CLAUDE_OFFICE_EMBED_URL','CLAUDE_OFFICE_PUBLIC_URL',
                         'X-API-Key', 'no_proxy()', 'pub fn auth_check()',
                         'token_exposed', 'false'):
            self.assertIn(required,source)
        self.assertIn('Some("office-auth-check")',main)
        self.assertIn('#[cfg(feature = "office")]',main)

    def test_ghost_native_file_lock_and_programdata_source(self):
        source=(ROOT/'ghost/prompt-store/prompt_store.py').read_text()
        self.assertIn('PROGRAMDATA',source)
        self.assertIn('msvcrt.locking',source)
        self.assertIn('fcntl.flock',source)
        self.assertNotIn('\nimport fcntl\n',source)

if __name__=='__main__':unittest.main()
