"""Bounded native board async regression checks with synthetic Kanzo data."""
from pathlib import Path
from playwright.sync_api import sync_playwright
root=Path(__file__).resolve().parents[1]
js=(root/'static/kanban_native.js').read_text().replace('export function mountNativeKanban','window.mountNativeKanban = function mountNativeKanban')
css=(root/'static/app.css').read_text()
html='''<!doctype html><meta name="viewport" content="width=device-width,initial-scale=1"><body style="background:#081422;color:#efffff"><main id="board" class="kn-shell"></main></body>'''
setup=r'''() => {
window.writes=[];window.pending=[];
window.tasks=[
  {id:1,project:'fleet',status:'doing',position:1,title:'Live task',description:'A',tags:[],human:false,comments:0},
  {id:2,project:'fleet',status:'todo',position:2,title:'Upcoming task',description:'B',tags:[],human:false,comments:0},
  {id:3,project:'fleet',status:'done',position:3,title:'Older completed',description:'C',tags:[],human:false,comments:0}];
const normal=(path,opts={})=>{
  if(path.includes('/board'))return {tasks:structuredClone(window.tasks.filter(t=>t.status!=='done'||path.includes('done=all'))),
    statuses:['todo','doing','review','done'],projects:[{name:'Fleet',slug:'fleet'}],done_hidden:path.includes('done=all')?0:1};
  if(path.match(/\/tasks\/\d+$/))return {task:structuredClone(window.tasks.find(x=>x.id===Number(path.split('/').at(-1)))),comments:[],images:[]};
  throw Error('Unexpected read '+path);
};
window.api=async(path,opts={})=>{
  if(opts.method){window.writes.push({path,opts});return {ok:true};}
  if(path.includes('done=all')&&window.delayAllDone) return await new Promise(resolve=>window.pending.push(()=>resolve(normal(path,opts))));
  return normal(path,opts);
};
window.dispose=window.mountNativeKanban(document.querySelector('#board'),window.api);
}'''
with sync_playwright() as p:
  browser=p.chromium.launch(headless=True,executable_path='/usr/bin/chromium',args=['--no-sandbox'])
  try:
    page=browser.new_page(viewport={'width':390,'height':844})
    page.set_content(html)
    page.add_style_tag(content=css)
    page.add_script_tag(content=js)
    page.evaluate(setup)
    page.wait_for_selector('.kn-task[data-id="1"]')
    assert page.locator('.kn-stage-select').input_value()=='queue'
    # Search crosses stages, so entering a term always searches the complete board.
    page.locator('.kn-search').fill('Upcoming')
    assert page.locator('.kn-stage-select').input_value()=='all'
    assert page.locator('.kn-task[data-id="2"]').count()==1
    page.locator('.kn-search').fill('')
    # An older slow response cannot undo a more recent completed-task filter.
    page.evaluate('window.delayAllDone=true')
    page.locator('#kn-done-all').check()
    page.wait_for_function('window.pending.length===1')
    page.locator('#kn-done-all').uncheck()
    page.wait_for_function('document.querySelector(".kn-status")?.textContent.includes("Kanzo synced")')
    page.evaluate('window.pending.splice(0).forEach(fn=>fn())')
    page.wait_for_timeout(120)
    assert page.locator('.kn-task[data-id="3"]').count()==0
    # Comment alone never patches or moves a task.
    page.locator('.kn-task[data-id="1"]').click()
    page.locator('.kn-dialog textarea[name="comment"]').fill('Progress update')
    page.locator('.kn-form button[type=submit]').click()
    page.wait_for_function('window.writes.length===1')
    assert page.evaluate('window.writes[0].path').endswith('/tasks/1/comments')
    assert page.evaluate('window.writes[0].opts.body.body')=='Progress update'
    # Keyboard quick access respects input focus.
    page.locator('.kn-stage-select').focus()
    page.keyboard.press('n')
    assert not page.locator('.kn-dialog').evaluate('(el)=>el.open')
    page.locator('.kn-head h2').click()
    page.locator('.kn-head .kn-quiet').first.focus()
    page.keyboard.press('n')
    assert page.locator('.kn-dialog').evaluate('(el)=>el.open')
    page.locator('.kn-modal-close').click()
    assert page.evaluate('document.documentElement.scrollWidth')<=390
    assert page.evaluate('window.writes.length')==1
    page.evaluate('window.dispose()')
    print('PASS async refresh ordering, global search, comment-only save, keyboard shortcut, overflow')
  finally: browser.close()
