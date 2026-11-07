"""Narrow mocked-browser checks for Lounge's read-only Kanzo activity projection."""
from pathlib import Path
from playwright.sync_api import sync_playwright
ROOT=Path(__file__).resolve().parents[1]
source=(ROOT/'static/app.js').read_text()
source=source[source.index('function agentChatParticipants(message)'):]
html=(ROOT/'static/index.html').read_text().replace('<script type="module" src="/app.js"></script>','')
bootstrap=r'''const APP=document.getElementById('app');
function pageHead(title){return `<div class="page-head"><h1>${title}</h1></div>`}
function esc(v){return String(v??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));}
window.testCalls=[];window.poll=()=>{};
window.kanzo={changes:'a',board:{changes:'a',statuses:['todo','doing','review','done'],projects:[],tasks:[
{id:550,project:'fleet',title:'Actual verified task <img onerror=alert(1)>',status:'doing',updated_at:new Date().toISOString()},
{id:551,project:'fleet',title:'Old task',status:'done',updated_at:'2020-01-01T00:00:00Z'}]}};
window.messages=[{id:2,from:'ghost',recipients:['sol'],created_at:new Date().toISOString(),text:'Testing '+('Long agent message content. '.repeat(28))+'<img src=x onerror=alert(1)>'},
{id:1,from:'sol',recipients:['ghost'],created_at:'2020-01-01T00:00:00Z',text:'Old message'}];
function schedule(fn){window.poll=fn;}
async function api(url,opts={}) {
 window.testCalls.push({url,method:opts.method||'GET'});
 if (url.startsWith('/api/agentchat/feed?')) {const data=window.messages;window.messages=[];return {available:true,messages:data,last_id:2,has_more:false};}
 if (url==='/api/agentchat/presence')return {available:true,agents:[]};
 if (url==='/api/embed/kanzo/handshake')return {ready:true};
 if (url==='/embed/kanzo/api/changes')return {changes:window.kanzo.changes};
 if (url.startsWith('/embed/kanzo/api/board'))return window.kanzo.board;
 throw Error('unexpected: '+url);
}
'''
with sync_playwright() as p:
    browser=p.chromium.launch(headless=True,executable_path='/usr/bin/chromium',args=['--no-sandbox'])
    try:
        for width,height in [(390,844),(430,932),(768,850),(1280,850)]:
            page=browser.new_page(viewport={'width':width,'height':height})
            errors=[]
            page.on('pageerror',lambda exc:errors.append(str(exc)))
            page.set_content(html)
            page.add_style_tag(content=(ROOT/'static/app.css').read_text())
            page.add_script_tag(content=bootstrap+source+'\nwindow.ready=viewAgentChat();')
            page.wait_for_selector('.messenger-kanzo')
            assert page.locator('.messenger-kanzo').count()==1
            assert page.locator('.messenger-kanzo strong').inner_text().startswith('Actual verified task')
            assert page.locator('.messenger-kanzo img').count()==0
            assert page.locator('.messenger-kanzo .lounge-task-link').get_attribute('href')=='#/kanban?task=550'
            assert 'Current stage: doing' in page.locator('.messenger-kanzo').inner_text()
            # Live Feed always shows complete messages. Conversation mode still
            # supports manual expansion for its denser thread view.
            assert page.locator('.messenger-expand').count()==0
            assert page.locator('.messenger-bubble-collapsed').count()==0
            page.locator('#ac-mode-threads').click()
            page.locator('.messenger-conversation').first.click()
            assert page.locator('.messenger-expand').count()==1
            page.locator('.messenger-expand').click()
            assert page.locator('.messenger-expand').get_attribute('aria-expanded')=='true'
            page.locator('#ac-mode-feed').click()
            assert page.locator('.messenger-bubble-collapsed').count()==0
            assert page.locator('.messenger-message img').count()==0
            page.locator('#ac-range').select_option('today')
            assert page.locator('.messenger-message').count()==1
            page.locator('#ac-range').select_option('all')
            assert page.locator('.messenger-message').count()==2
            page.evaluate('''window.kanzo={changes:'b',board:{...window.kanzo.board,changes:'b',tasks:
                [{...window.kanzo.board.tasks[0],status:'review',updated_at:new Date().toISOString()},window.kanzo.board.tasks[1]]}}''')
            page.locator('#ac-mode-threads').click()
            page.locator('#ac-mode-feed').click()
            page.wait_for_function("document.querySelector('.messenger-kanzo')?.innerText.includes('Observed change')")
            assert 'Moved doing → review' in page.locator('.messenger-kanzo').first.inner_text()
            assert all(x['method']=='GET' for x in page.evaluate('window.testCalls'))
            assert page.evaluate('document.documentElement.scrollWidth')<=width
            assert not errors,errors
            if width in (390,1280):page.screenshot(path=str(ROOT.parent/f'agent-lounge-kanzo-{width}.png'))
            page.close()
        print('PASS Kanzo task state from API, observed transition, safe text, deep links, 7d filtering, long message, no writes, 390/430/768/1280')
    finally:browser.close()
