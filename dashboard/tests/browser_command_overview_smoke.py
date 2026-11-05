"""Command Center: source-backed optional status, no data fabrication or navigation gate."""
from pathlib import Path
from playwright.sync_api import sync_playwright

root = Path(__file__).resolve().parents[1]
html = (root / 'static/index.html').read_text().replace('<script type="module" src="/app.js"></script>', '')
css = (root / 'static/app.css').read_text()
js = (root / 'static/app.js').read_text()
script = js[js.index('function dashboardSnapshot() {'):js.index('// ------------------------------------------------------------ chart + graph', js.index('async function viewDashboard() {'))]
boot = r'''
const APP=document.getElementById('app');
const HOST_LINE={textContent:''};
const state={routeEpoch:1};
function pageHead(title){return `<div class="page-head"><h1>${title}</h1></div>`}
function esc(v){return String(v??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;'}[c]));}
function miniatureBrainGraph(){return '<svg viewBox="0 0 20 20" aria-hidden="true"></svg>'}
window.calls=[];
window.fakeMode='ok';
window.count=0;
async function api(path,opts={}){
 window.calls.push(path);
 if (window.fakeMode==='fail') throw Error('Offline');
 if (path.includes('handshake'))return {ready:true};
 if (path.includes('board'))return {tasks:[
  {status:'todo'},{status:'todo'},{status:'doing'},{status:'review'},
  {status:'backlog'},{status:'backlog'},{status:'done'}]};
 if (path.includes('presence'))return {available:window.fakeMode!=='agent-missing',agents:[
  {status:'working'},{status:'idle'},{status:'working'},{status:'off'}]};
 throw Error('Unexpected request: '+path);
}
'''
with sync_playwright() as p:
  browser=p.chromium.launch(headless=True,executable_path='/usr/bin/chromium',args=['--no-sandbox'])
  try:
    for w,h in [(390,844),(768,900),(1024,900),(1440,900)]:
      page=browser.new_page(viewport={'width':w,'height':h})
      errors=[]
      page.on('pageerror',lambda e:errors.append(str(e)))
      page.set_content(html)
      page.add_style_tag(content=css)
      page.add_script_tag(content=boot+script+'\nwindow.ready=viewDashboard();')
      page.wait_for_function('document.getElementById("command-live-status")?.textContent==="Latest snapshot"')
      def value(key):return page.locator(f'#command-live-{key}').inner_text()
      assert [value(k) for k in ('ready','doing','review','backlog','agents')]==['2','1','1','2','2']
      assert page.evaluate('document.documentElement.scrollWidth')<=w+1, w
      assert page.locator('.command-workspace').count()==5
      assert page.locator('.command-overview-card').count()==5
      if w==1440:
        page.screenshot(path='/mnt/data/repoql-operations-overview-desktop.png',full_page=True)
        page.evaluate("window.fakeMode='fail'")
        page.locator('#command-live-refresh').click()
        page.wait_for_function('document.getElementById("command-live-status").textContent==="Some services unavailable"')
        assert [value(k) for k in ('ready','doing','review','backlog','agents')]==['Unavailable']*5
        page.evaluate("window.fakeMode='agent-missing'")
        page.locator('#command-live-refresh').click()
        page.wait_for_function('document.getElementById("command-live-agents").textContent==="Unavailable"')
        assert value('ready')=='2' and value('agents')=='Unavailable'
      if w==390:page.screenshot(path='/mnt/data/repoql-operations-overview-mobile.png',full_page=True)
      assert not errors,errors
      page.close()
    print('PASS operations overview: source-backed counts, partial failure, refresh, 390/768/1024/1440, no overflow')
  finally:
    browser.close()
