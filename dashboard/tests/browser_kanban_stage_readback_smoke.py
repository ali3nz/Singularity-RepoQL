"""Verify real Kanzo stage readback, not merely a successful mutation response."""
from pathlib import Path
from playwright.sync_api import sync_playwright

ROOT = Path(__file__).resolve().parents[1]
JS = (ROOT / 'static/kanban_native.js').read_text().replace(
    'export function mountNativeKanban', 'window.mountNativeKanban = function mountNativeKanban')
CSS = (ROOT / 'static/app.css').read_text()
HTML = ('<!doctype html><html><meta name="viewport" content="width=device-width,initial-scale=1">'
        '<body><section class="kn-shell" id="board"></section></body></html>')
SETUP = r'''() => {
window.record={id:7,project:'local',status:'todo',title:'Actual Windows task',description:'',position:1,tags:[],human:false,comments:0};
window.ackWithoutCommit=true;window.writes=[];
window.api=async(path,opts={})=>{
  const method=opts.method||'GET';
  if(method==='GET' && path.includes('/api/board')) return {
    tasks:[structuredClone(window.record)], statuses:['todo','doing','review','done'],
    projects:[{slug:'local',name:'Local'}], done_hidden:0, changes:window.record.status
  };
  if(method==='GET' && /\/api\/tasks\/7$/.test(path))return {task:structuredClone(window.record),comments:[],images:[]};
  if(method==='POST' && path.endsWith('/move')){
    window.writes.push({path,status:opts.body.status});
    if(!window.ackWithoutCommit)window.record.status=opts.body.status;
    return {ok:true};
  }
  throw Error('unexpected API call '+method+' '+path);
};
window.dispose=window.mountNativeKanban(document.querySelector('#board'),window.api);
}'''

with sync_playwright() as p:
    browser=p.chromium.launch(headless=True,executable_path='/usr/bin/chromium',args=['--no-sandbox'])
    try:
        page=browser.new_page(viewport={'width':900,'height':800})
        page.set_content(HTML)
        page.add_style_tag(content=CSS)
        page.add_script_tag(content=JS)
        page.evaluate(SETUP)
        page.wait_for_selector('.kn-task[data-id="7"]')
        page.get_by_role('button',name='Move to In progress: Actual Windows task').click()
        page.wait_for_function('document.querySelector(".kn-status")?.textContent.includes("did not confirm")')
        assert page.evaluate('window.record.status')=='todo'
        assert page.locator('.kn-task[data-stage="doing"]').count()==0
        assert page.evaluate('window.writes.length')==1
        # When authoritative Kanzo readback confirms doing, the board may show In progress.
        page.evaluate('window.ackWithoutCommit=false')
        page.get_by_role('button',name='Move to In progress: Actual Windows task').click()
        page.wait_for_function('window.record.status==="doing"')
        page.wait_for_selector('.kn-task[data-stage="doing"]')
        assert page.evaluate('window.writes.length')==2
        page.evaluate('window.dispose()')
        print('PASS: false acknowledgements rejected; persisted todo->doing readback accepted')
    finally:
        browser.close()
