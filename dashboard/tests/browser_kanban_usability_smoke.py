"""Focused Kanzo UI checks for non-destructive refresh, clear filters and old completed tasks."""
from pathlib import Path
from playwright.sync_api import sync_playwright
ROOT=Path(__file__).resolve().parents[1]
js=(ROOT/'static/kanban_native.js').read_text().replace('export function mountNativeKanban','window.mountNativeKanban = function mountNativeKanban')
css=(ROOT/'static/app.css').read_text()
init=r'''() => {
window.rows=[
{id:1,project:'fleet',title:'Current ticket',description:'Being worked on',tags:[],status:'doing',position:1,human:false,comments:1},
{id:2,project:'fleet',title:'Archived ticket',description:'Older completed item',tags:[],status:'done',position:1,human:false,comments:0},
];
window.changes=1;window.calls=[];
window.api=async (path,opts={})=>{
window.calls.push({path,method:opts.method||'GET'});
if(path.includes('/api/board'))return {changes:String(window.changes),projects:[{slug:'fleet',name:'Fleet'}],statuses:['todo','doing','review','done'],done_hidden:path.includes('done=all')?0:1,tasks:window.rows.filter(t=>t.status!=='done'||path.includes('done=all'))};
if(/\/tasks\/\d+$/.test(path))return {task:window.rows.find(t=>String(t.id)===path.split('/').at(-1)),comments:[],images:[]};
throw Error('unexpected API '+path);
};
window.dispose=window.mountNativeKanban(document.querySelector('#board'),window.api);
}'''
with sync_playwright() as p:
  browser=p.chromium.launch(headless=True,executable_path='/usr/bin/chromium',args=['--no-sandbox'])
  try:
    page=browser.new_page(viewport={'width':390,'height':844})
    page.set_content('<!doctype html><html><meta name="viewport" content="width=device-width,initial-scale=1"><body style="background:#090f1a;color:white"><main><section class="kn-shell" id="board"></section></main></body></html>')
    page.add_style_tag(content=css);page.add_script_tag(content=js);page.evaluate(init)
    page.wait_for_selector('.kn-task[data-id="1"]')
    card=page.locator('.kn-task[data-id="1"]')
    card.focus()
    page.evaluate("""window.firstCard=document.querySelector('.kn-task[data-id=\"1\"]')""")
    # Quiet refresh with unchanged Kanzo token should not rebuild a task mid-reading.
    page.evaluate("document.dispatchEvent(new Event('visibilitychange'))")
    page.wait_for_function('window.calls.filter(c=>c.path.includes("/api/board")).length>=2')
    assert page.evaluate("""window.firstCard===document.querySelector('.kn-task[data-id=\"1\"]')""")
    # A real change should rerender but preserve keyboard focus on the same task.
    page.evaluate('window.changes=2;document.dispatchEvent(new Event("visibilitychange"))')
    page.wait_for_function("""window.firstCard!==document.querySelector('.kn-task[data-id=\"1\"]')""")
    assert page.evaluate('document.activeElement?.dataset.id')=='1'
    page.locator('.kn-search').fill('no matching task')
    assert page.get_by_role('button',name='Show work queue').count()==1
    page.get_by_role('button',name='Show work queue').click()
    assert page.locator('.kn-search').input_value()==''
    page.locator('.kn-stage-select').select_option('done')
    assert page.get_by_role('button',name='Include 1 older completed tasks').count()==1
    page.get_by_role('button',name='Include 1 older completed tasks').click()
    page.wait_for_selector('.kn-task[data-id="2"]')
    assert page.locator('#kn-done-all').is_checked()
    page.locator('.kn-task[data-id="2"]').click()
    page.wait_for_selector('.kn-dialog[open]')
    assert page.locator('.kn-dialog').get_attribute('aria-labelledby')=='kn-modal-heading'
    assert page.get_by_role('button',name='Close task editor').count()==1
    assert page.get_by_role('button',name='Copy task ID').count()==1
    assert page.evaluate('document.documentElement.scrollWidth')<=390
    assert not page.evaluate('window.calls.some(c=>c.method!=="GET")')
    page.evaluate('window.dispose()')
    print('PASS non-destructive idle refresh, focused task restore, clear search, archived tasks, accessible modal, no writes')
  finally:browser.close()
