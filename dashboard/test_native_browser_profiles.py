"""Opt-in Chromium browser checks against the actual four native dashboard profiles.

RUN_BROWSER_SMOKE=1 PYTHONPATH=dashboard python -m unittest dashboard/test_native_browser_profiles.py
No Windows or external services are asserted; browser and upstream are simulated.
"""
import os
import shutil
import tempfile
import threading
import unittest
from pathlib import Path
from unittest.mock import patch
from repoql_bridge import Config
from server import build_server

try:
    from playwright.sync_api import sync_playwright, Error as PlaywrightError
except ImportError:
    sync_playwright=None

MOCK={'available':True,'collected_at':'2026-10-29T00:00:00Z',
      'recent':[{'source':'freebuff','input_tokens':100000},
                {'source':'claude-desktop-code','input_tokens':10,'output_tokens':8,'timestamp':'2026-10-29T00:00:00Z'},
                {'source':'openchamber-desktop-subscription','input_tokens':19,'output_tokens':3,'timestamp':'2026-10-29T00:00:00Z'}],
      'sources':[{'id':'freebuff','events':100},{'id':'claude-desktop-code','events':1},{'id':'openchamber-desktop-subscription','events':1}],
      'daily':[{'day':'2026-10-29','input_tokens':100000}],
      'input_tokens_recorded':100000}

@unittest.skipUnless(os.environ.get('RUN_BROWSER_SMOKE')=='1' and sync_playwright and shutil.which('chromium'),
                     'requires opt-in Chromium and Playwright')
class NativeBrowserProfiles(unittest.TestCase):
    def test_all_four_profiles(self):
        with sync_playwright() as p:
            browser=p.chromium.launch(headless=True,executable_path=shutil.which('chromium'),args=['--no-sandbox'])
            try:
                for option in range(1,5):
                    with self.subTest(option=option),tempfile.TemporaryDirectory() as tmp,patch.dict(os.environ, {
                         'SINGULARITY_WINDOWS_NATIVE':'1','SINGULARITY_INSTALL_VARIANT':str(option)}):
                        config=Config(workspace=Path(tmp),rql=Path('/absent/rql'),
                          state_dir=Path(tmp)/'state',bind='127.0.0.1',port=0)
                        server=build_server(config)
                        thread=threading.Thread(target=server.serve_forever,daemon=True)
                        thread.start()
                        context=browser.new_context()
                        try:
                            page=context.new_page()
                            with patch('unified_bridge._fetch_upstream',return_value=MOCK):
                                try:
                                    page.goto(f'http://127.0.0.1:{server.server_port}/#k={server.RequestHandlerClass.app.token}',wait_until='domcontentloaded')
                                except PlaywrightError as exc:
                                    if 'ERR_BLOCKED_BY_ADMINISTRATOR' in str(exc):
                                        self.skipTest('browser policy blocks localhost navigation in this environment')
                                    raise
                                page.evaluate("location.hash = '#/unified/usage'")
                                expected='Claude Desktop Code Usage' if option in (1,2) else 'OpenChamber Desktop Usage'
                                page.get_by_role('heading',name=expected).wait_for(timeout=10000)
                                self.assertIn('Unknown',page.locator('#usage-summary').inner_text())
                                self.assertIn('Attributed receipts',page.locator('#usage-summary').inner_text())
                                self.assertEqual(page.locator('#usage-token-chart').count(),0)
                                self.assertEqual(page.locator('#fb-details').count(),0)
                                self.assertNotIn('100,000',page.locator('#usage-summary').inner_text())
                                self.assertIn(expected,page.locator('[data-nav="/unified/usage"]').inner_text())
                                for route,shown in [('/ghost',option in (2,4)),('/office',option in (2,4)),
                                                    ('/native/status',True)]:
                                    element=page.locator(f'[data-nav="{route}"]')
                                    self.assertEqual(element.is_visible(),shown, (option,route))
                                page.locator('[data-nav="/native/status"]').click()
                                page.get_by_role('heading',name='Native Windows integration status').wait_for(timeout=10000)
                                self.assertIn('RepoQL 1.7.18',page.locator('#native-status-body').inner_text())
                        finally:
                            context.close();server.shutdown();server.server_close();thread.join(timeout=3)
            finally:
                browser.close()

if __name__=='__main__':unittest.main()
