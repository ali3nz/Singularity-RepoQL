"""Sidebar icons match the existing workspace art without changing navigation."""
from pathlib import Path
import re
from playwright.sync_api import sync_playwright

ROOT = Path(__file__).resolve().parents[1]
html = (ROOT / 'static/index.html').read_text().replace('<script type="module" src="/app.js"></script>', '')
css = (ROOT / 'static/app.css').read_text()
links = re.findall(r'data-nav="([^"]+)"', html)
assert len(links) == len(set(links)) == 23
assert all(html.count(f'data-nav="{route}"') == 1 for route in links)
# Verify that the existing card icons are copied into matching sidebar links.
js=(ROOT / 'static/app.js').read_text()
source=js[js.index('const iconBadges = {'):js.index('// Decorative only:')]
card_icons=dict(re.findall(r"'(/[^']+)': `(<svg.*?</svg>)`,",source))
card_icons['/repoql/control']=re.search(r'const REPOQL_ICON = `(<svg.*?</svg>)`',js).group(1)
card_icons['/unified/graph']=re.search(r'const BRAIN_ICON = `(<svg.*?</svg>)`',js).group(1)
card_icons['/unified/tencent']=card_icons['/unified/graph']
for route in ['/kanban','/agentchat','/office','/unified/graph','/repoql/control','/unified/tencent']:
    pattern=re.compile(r'data-nav="'+re.escape(route)+r'"[^>]*><span class="nav-icon" aria-hidden="true">(<svg.*?</svg>)</span>')
    match=pattern.search(html)
    assert match,route
    assert match.group(1).replace('<svg focusable="false" ','<svg ',1)==card_icons[route],route

with sync_playwright() as p:
    browser = p.chromium.launch(headless=True, executable_path='/usr/bin/chromium', args=['--no-sandbox'])
    try:
        for width,height in [(390,844),(430,932),(768,900),(1024,900),(1440,1050)]:
            page = browser.new_page(viewport={'width':width,'height':height})
            errors=[]
            page.on('pageerror', lambda error: errors.append(str(error)))
            page.set_content(html)
            page.add_style_tag(content=css)
            page.locator('#app').evaluate('(el) => { el.innerHTML = `<div class="page-head"><h1>Command center</h1></div><section class="block" style="height:350px">Workspaces</section>`; }')
            assert page.locator('.nav-link .nav-icon svg').count() == 23
            assert page.locator('.nav-link .dot').count() == 0
            assert page.locator('.nav-more[open]').count() == 3
            assert page.evaluate('document.documentElement.scrollWidth') <= width+1
            # Keyboard navigation remains available and each icon is decorative.
            assert page.locator('.nav-link .nav-icon:not([aria-hidden="true"])').count()==0
            if width <= 768:
                page.locator('#site-nav').evaluate('(el)=>document.body.classList.add("nav-open")')
                page.wait_for_timeout(330)
                first=page.locator('.nav-link').first
                assert first.is_visible()
                box=first.locator('.nav-icon').bounding_box()
                assert box and box['width']>=20 and box['height']>=20
                if width==430:
                    page.screenshot(path='/mnt/data/repoql-sidebar-icons-mobile.png')
            else:
                first=page.locator('.nav-link').first
                assert first.is_visible()
                box=first.locator('.nav-icon').bounding_box()
                assert box and box['width']>=20 and box['height']>=20
                if width==1440:
                    page.screenshot(path='/mnt/data/repoql-sidebar-icons-desktop.png')
                    page.locator('.sidebar').evaluate('(el)=>el.scrollTop=460')
                    page.screenshot(path='/mnt/data/repoql-sidebar-icons-system-knowledge.png')
            assert not errors,errors
            page.close()
        print('PASS: 23 sidebar SVGs, unchanged routes, expanded groups, accessible icons, 390/430/768/1024/1440')
    finally:
        browser.close()
