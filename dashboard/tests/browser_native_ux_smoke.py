"""Native health and palette checks with synthetic data and intercepted requests."""
import json
from pathlib import Path
from urllib.parse import urlparse

from playwright.sync_api import sync_playwright

helper = (Path(__file__).resolve().parents[1] / 'static/ux_pack.js').read_text()
fleet_endpoints = {'/api/harness/health', '/api/agents-control'}
html = '''<!doctype html><html><body>
<aside class="sidebar">
  <a class="nav-link" data-nav="/" href="#/">Command Center</a>
  <a class="nav-link" data-nav="/diagnostics" href="#/diagnostics">Diagnostics</a>
  <a class="nav-link" data-nav="/harness" href="#/harness" {retired}>Harness</a>
  <div hidden><a class="nav-link" data-nav="/hidden" href="#/hidden">Hidden page</a></div>
  <details><summary>Reference</summary>
    <a class="nav-link" data-nav="/concepts" href="#/concepts">Concepts</a>
  </details>
</aside>
<main id="app"><div id="dash"></div></main>
</body></html>'''

with sync_playwright() as playwright:
    browser = playwright.chromium.launch(
        headless=True, executable_path='/usr/bin/chromium', args=['--no-sandbox'])
    try:
        for variant in (1, 2, 3, 4, None):
            native = variant is not None
            requests = []
            errors = []
            page = browser.new_page()
            page.on('pageerror', lambda error: errors.append(str(error)))
            profile = {'variant': variant} if native else None
            page.add_init_script('window.__SINGULARITY_VARIANT__=' + json.dumps(profile))

            def respond(route):
                path = urlparse(route.request.url).path
                if path.startswith('/api/'):
                    requests.append(path)
                    data = {'agents': [{'name': 'Legacy worker'}]} if path == '/api/agents-control' else {'ok': True}
                    route.fulfill(content_type='application/json', body=json.dumps(data))
                else:
                    route.fulfill(content_type='text/html', body=html.format(retired='hidden' if native else ''))

            page.route('**/*', respond)
            page.goto('http://singularity.test/')
            page.add_script_tag(content=helper)
            page.wait_for_selector('.ux-health[data-state="ok"]')
            assert page.locator('.ux-health').get_attribute('data-state') == 'ok'
            assert page.locator('.ux-chip').all_text_contents() == (
                ['Dashboard', 'Host'] if native else ['Dashboard', 'Host', 'Harness'])
            page.keyboard.press('Control+k')
            palette = page.get_by_role('dialog', name='Command palette')
            for target in ('#/', '#/diagnostics', '#/concepts'):
                assert palette.locator(f'a[href="{target}"]').count() == 1
            assert palette.locator('a[href="#/hidden"]').count() == 0
            for target in ('#/harness',):
                assert palette.locator(f'a[href="{target}"]').count() == (0 if native else 1)
            if native:
                assert palette.locator('a[href^="#/agents-control"]').count() == 0
            else:
                palette.get_by_role('link', name='Legacy worker').wait_for()
            assert set(requests) & fleet_endpoints == (set() if native else fleet_endpoints), requests
            assert {'/api/health', '/api/status'} <= set(requests)
            assert not errors, errors
            page.close()
            print('PASS native profile' if native else 'PASS legacy profile', variant, flush=True)
    finally:
        browser.close()
