"""Focused safe Kanban queue checks using synthetic board data only."""
from pathlib import Path
from playwright.sync_api import sync_playwright
root=Path(__file__).resolve().parents[1]
js=(root/'static/kanban_native.js').read_text().replace('export function mountNativeKanban','window.mountNativeKanban = function mountNativeKanban')
css=(root/'static/app.css').read_text()
html='''<!doctype html><html><meta name="viewport" content="width=device-width,initial-scale=1"><body style="margin:0;color:white;background:#090f1a"><main style="padding:15px"><div id="board" class="kn-shell"></div></main></body></html>'''
setup=r'''() => {
window.writes=[];window.reads=[];window.rev=1;
window.tasks=[...Array.from({length:53},(_,i)=>({id:i+1,project:'fleet',title:`Backlog item ${i+1}`,description:'Parked work',status:'backlog',tags:[],human:false,position:i,comments:0})),
 ...Array.from({length:9},(_,i)=>({id:i+54,project:'fleet',title:`Ready task ${i+1}`,description:'Waiting for an agent to begin',status:'todo',tags:[],human:false,position:i,comments:0}))];
window.api=async(path,opts={})=>{
 if(!opts.method)window.reads.push(path);
 if(path.includes('/board'))return {statuses:['backlog','todo','doing','review','done'],projects:[{slug:'fleet',name:'Fleet'}],tasks:structuredClone(window.tasks),done_hidden:602,changes:String(window.rev)};
 if(/\/tasks\/\d+$/.test(path)&&!opts.method){let id=Number(path.split('/').at(-1));return {task:structuredClone(window.tasks.find(x=>x.id===id)),comments:[],images:[]};}
 if(opts.method==='POST'&&path.endsWith('/move')) {window.writes.push({path,body:opts.body});let id=Number(path.split('/').at(-2));window.tasks.find(x=>x.id===id).status=opts.body.status;window.rev++;return {ok:true};}
 throw Error('Unexpected API: '+path);
};
window.dispose=window.mountNativeKanban(document.querySelector('#board'),window.api);
}'''
with sync_playwright() as p:
 browser=p.chromium.launch(headless=True,executable_path='/usr/bin/chromium',args=['--no-sandbox'])
 try:
  for width in (390,768,1280):
   page=browser.new_page(viewport={'width':width,'height':900},device_scale_factor=1)
   errors=[];page.on('pageerror',lambda err:errors.append(str(err)))
   page.set_content(html);page.add_style_tag(content=css);page.add_script_tag(content=js);page.evaluate(setup)
   page.wait_for_selector('.kn-task[data-id="54"]')
   assert page.locator('.kn-stage-select').input_value()=='queue'
   assert page.locator('.kn-task').count()==9
   assert page.locator('.kn-column[data-stage="backlog"]').count()==0
   assert page.locator('.kn-column[data-stage="todo"]').count()==1
   assert page.locator('.kn-column[data-stage="doing"]').count()==0
   assert page.locator('.kn-column[data-stage="review"]').count()==0
   assert page.locator('.kn-idle-activity').count()==1
   summary=page.locator('.kn-board-summary').inner_text()
   assert 'Work queue: 9 tasks' in summary,summary
   for v in ('Work queue · 9','In progress · 0','Review · 0','Backlog · 53'):assert v in page.locator('.kn-lanes').inner_text(),v
   assert '602 older completed tasks excluded' in page.locator('.kn-status').inner_text()
   assert page.evaluate('window.writes.length')==0
   assert page.evaluate('document.documentElement.scrollWidth')<=width,(width,'overflow')
   if width==1280:
    page.screenshot(path='/mnt/data/kanban-queue-1280.png',full_page=True)
    # The button changes only the Kanzo status; it is not an ownership claim.
    page.get_by_role('button',name='Move to In progress: Ready task 1').click()
    page.wait_for_function('window.writes.length===1')
    assert page.evaluate('window.writes[0].body.status')=='doing'
    page.wait_for_function('document.querySelector(".kn-lane[data-stage=doing]")?.textContent.includes("1")')
    assert page.locator('.kn-column[data-stage="doing"] .kn-task[data-id="54"]').count()==1
    assert page.locator('.kn-idle-activity').count()==0
    page.locator('.kn-lane').filter(has_text='All').first.click()
    assert page.locator('.kn-column[data-stage="backlog"]').count()==1
    assert page.locator('.kn-column[data-stage="backlog"] .kn-task').count()==40 # existing pagination preserved
    assert page.evaluate('window.writes.length')==1
    # A backlog-only board explains that the queue is empty rather than hiding work silently.
    page.evaluate('window.tasks.forEach(t=>t.status="backlog");window.rev++;document.dispatchEvent(new Event("visibilitychange"))')
    page.wait_for_function('document.querySelector(".kn-lane[data-stage=backlog]")?.textContent.includes("62")')
    page.locator('.kn-lane').filter(has_text='Work queue').first.click()
    assert page.get_by_role('button',name='View backlog · 62').count()==1
    assert page.evaluate('window.writes.length')==1
   assert not errors,errors
   print(f'PASS queue at {width}px: 9 ready, 53 backlog separate, stage counts accurate, no unexpected writes')
   page.evaluate('window.dispose()');page.close()
 finally:browser.close()
