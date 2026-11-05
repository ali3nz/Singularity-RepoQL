"""Read-only lounge acceptance for grouping, full text, unread and responsive agent focus."""
from pathlib import Path
from playwright.sync_api import sync_playwright

ROOT=Path(__file__).resolve().parents[1]
html=(ROOT/'static/index.html').read_text().replace('<script type="module" src="/app.js"></script>','')
css=(ROOT/'static/app.css').read_text()
source=(ROOT/'static/app.js').read_text()
source=source[source.index('function agentChatParticipants(message)'):]
bootstrap=r'''
const APP=document.getElementById('app');
function pageHead(title){return `<div class="page-head"><h1>${title}</h1></div>`}
function esc(v){return String(v??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));}
Object.defineProperty(window,'localStorage',{configurable:true,value:{getItem(){return null},setItem(){}}});
const stamp=(n)=>new Date(Date.now()+n*15000).toISOString();
window.buffer=Array.from({length:60},(_,i)=>({id:i+1,from:i<40?'ghost':(i<52?'buffy':'super'),recipients:['operator'],
 text:i===30?'A very long message '+('reasoning and evidence '.repeat(150)): 'Message '+(i+1)+' with details and evidence.',created_at:stamp(i)}));
window.calls=[];
function schedule(fn){window.poll=fn;}
async function api(url,opts={}){
 window.calls.push({url,method:opts.method||'GET'});
 if(url==='/api/agentchat/presence')return {available:true,agents:[{role:'ghost',status:'working'}, {role:'buffy',status:'working'}, {role:'super',status:'idle'}]};
 if(url==='/api/embed/kanzo/handshake')return {ready:true};
 if(url==='/embed/kanzo/api/changes')return {changes:'s1'};
 if(url.startsWith('/embed/kanzo/api/board'))return {tasks:[],projects:[]};
 if(url.startsWith('/api/agentchat/feed?')){const messages=window.buffer;window.buffer=[];return {available:true,messages,last_id:messages.length?Math.max(...messages.map(m=>m.id)):0,has_more:false};}
 throw Error('Unexpected API: '+url);
}
'''

with sync_playwright() as p:
 browser=p.chromium.launch(headless=True,executable_path='/usr/bin/chromium',args=['--no-sandbox'])
 try:
  for width,height in [(390,844),(430,932),(768,900),(1024,800),(1280,860)]:
   page=browser.new_page(viewport={'width':width,'height':height})
   errors=[]
   page.on('pageerror',lambda e:errors.append(str(e)))
   page.set_content(html)
   page.add_style_tag(content=css)
   page.add_script_tag(content=bootstrap+source+'\nwindow.ready=viewAgentChat();')
   page.wait_for_function('document.querySelectorAll(".messenger-mode-feed .messenger-message").length===60')
   page.wait_for_function('document.querySelectorAll(".lounge-person").length===3')
   assert page.locator('.messenger-message-continued').count()>=30, 'messages from same sender should group'
   assert page.locator('.messenger-bubble-collapsed').count()==0, 'full feed must never clamp content'
   assert page.locator('.messenger-expand').count()==0, 'feed should not need expand buttons'
   assert 'reasoning and evidence' in page.locator('.messenger-bubble').nth(30).inner_text()
   assert page.locator('.messenger-bubble').nth(30).evaluate('(e)=>e.scrollHeight-e.clientHeight') < 2
   assert page.evaluate('document.documentElement.scrollWidth')<=width+1, 'horizontal overflow'
   # Focus is real filtering and the selected state is kept during a rerender.
   if width<=760: page.locator('#ac-presence summary').click()
   page.locator('button[data-select-agent="buffy"]').click()
   assert page.locator('.messenger-message').count()==12
   assert page.locator('.lounge-person.selected').get_attribute('data-agent-role')=='buffy'
   assert page.locator('#ac-clear-agent').is_visible()
   page.locator('#ac-clear-agent').click()
   assert page.locator('.messenger-message').count()==60
   assert page.locator('.lounge-person.selected').count()==0
   # A new message when scrolled up has a persistent, counted jump button.
   page.locator('#ac-stream').evaluate('e=>e.scrollTop=0')
   page.evaluate('window.buffer=[{id:61,from:"ghost",recipients:["operator"],text:"Fresh update",created_at:new Date().toISOString()}];window.poll()')
   page.wait_for_function('document.querySelectorAll(".messenger-message").length===61')
   assert page.locator('#ac-latest').is_visible(), 'new message indicator missing'
   assert '1 new message' in page.locator('#ac-latest').inner_text()
   # Empty refresh must not dismiss the indicator.
   page.evaluate('window.poll()')
   page.wait_for_timeout(60)
   assert page.locator('#ac-latest').is_visible()
   page.evaluate('window.buffer=[{id:62,from:"ghost",recipients:["operator"],text:"Second update",created_at:new Date().toISOString()}];window.poll()')
   page.wait_for_function('document.querySelectorAll(".messenger-message").length===62')
   assert '2 new messages' in page.locator('#ac-latest').inner_text()
   page.locator('#ac-latest').click()
   assert page.locator('#ac-latest').is_hidden()
   assert page.locator('#ac-stream').evaluate('e=>e.scrollHeight-e.scrollTop-e.clientHeight')<3
   # Tablet / narrow desktop rail must be compact; mobile retains readable horizontal roster.
   if 760<width<=1200:
    assert page.locator('#ac-presence').bounding_box()['width']<=75
    assert page.locator('.lounge-agent-select strong').first.is_hidden()
   if width>1200:
    assert page.locator('#ac-presence').bounding_box()['width']>150
   assert all(c['method']=='GET' for c in page.evaluate('window.calls'))
   assert not errors,errors
   page.close()
  print('PASS full feed, grouped senders, agent focus, counted unread, jump, read-only, responsive 390/430/768/1024/1280')
 finally:
  browser.close()
