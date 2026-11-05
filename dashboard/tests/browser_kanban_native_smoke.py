"""Focused isolated native Kanzo UI browser checks with representative API fixtures."""
from pathlib import Path
from playwright.sync_api import sync_playwright
ROOT=Path(__file__).resolve().parents[1]
JS=(ROOT/'static/kanban_native.js').read_text().replace('export function mountNativeKanban', 'window.mountNativeKanban = function mountNativeKanban')
CSS=(ROOT/'static/app.css').read_text()
HEAD='''<!doctype html><html lang="en"><meta name="viewport" content="width=device-width,initial-scale=1"><body style="margin:0;background:#090f1a;color:#e5effa;"><main id="app" style="padding:16px"><section class="kn-shell" id="board"></section></main></body></html>'''
INIT=r'''() => {
  window.__writes=[];
  window.__rows=[
    {id:1,project:'fleet',title:'Improve Kanzo integration',description:'Use protected RepoQL API and mobile responsive lists',tags:['dashboard'],human:false,status:'doing',position:1,comments:1},
    {id:2,project:'fleet',title:'<img src=x onerror=alert(1)>',description:'Review compatibility & audit trail',tags:['review'],human:true,status:'review',position:2,comments:0},
    {id:3,project:'family',title:'Prepare Ghost meal planning',description:'Integrate verified Mealie data only',tags:['ghost'],human:false,status:'todo',position:1,comments:0},
    {id:4,project:'fleet',title:'Closed old ticket',description:'Do not overwhelm the default board',tags:[],human:false,status:'done',position:1,comments:0},
  ];
  window.__api=async (url, options={}) => {
    const path=String(url), method=options.method||'GET';
    if(method!=='GET') window.__writes.push({path,method,body:options.body});
    if(method==='GET' && path.includes('/api/board')) return {
      statuses:['todo','doing','review','done'],
      projects:[{slug:'fleet',name:'Fleet'},{slug:'family',name:'Household'}],
      tasks:window.__rows.filter(x=>x.status!=='done' || path.includes('done=all')),
      done_hidden:path.includes('done=all')?0:1,
      changes:'abc'};
    if(method==='GET' && /\/api\/tasks\/\d+$/.test(path)){
      const id=Number(path.split('/').at(-1));return {task:JSON.parse(JSON.stringify(window.__rows.find(t=>t.id===id))),comments:id===1?[{author:'agent',body:'Started work',id:50}]:[],images:[]};
    }
    if(method==='POST'&&path.endsWith('/tasks')){const id=window.__rows.length+1; window.__rows.push({...options.body,id,status:'todo',tags:[],human:false,position:2,comments:0});return {id};}
    if(method==='POST'&&path.endsWith('/move')){const id=Number(path.split('/').at(-2));window.__rows.find(t=>t.id===id).status=options.body.status;return {ok:true};}
    if(method==='PATCH'){const id=Number(path.split('/').at(-1));Object.assign(window.__rows.find(t=>t.id===id), options.body);return {ok:true};}
    if(method==='POST'&&path.endsWith('/comments'))return {ok:true};
    throw Error('Unexpected API '+path);
  };
  window.__dispose=window.mountNativeKanban(document.getElementById('board'),window.__api);
}'''
with sync_playwright() as p:
    browser=p.chromium.launch(headless=True,executable_path='/usr/bin/chromium',args=['--no-sandbox'])
    try:
        for width in (390,430,768,1280):
            page=browser.new_page(viewport={'width':width,'height':850})
            errors=[]
            page.on('pageerror',lambda ex:errors.append(str(ex)))
            page.set_content(HEAD);page.add_style_tag(content=CSS)
            if width==768:page.evaluate("document.documentElement.dataset.themeMode='light'")
            page.add_script_tag(content=JS);page.evaluate(INIT)
            page.wait_for_selector('.kn-task[data-id="1"]')
            assert page.locator('img[onerror]').count()==0,'task titles must be escaped'
            if width <= 760:
                assert page.locator('.kn-stage-select').input_value()=='queue'
                assert page.locator('.kn-task').count()==3
                page.locator('.kn-stage-select').select_option('all')
            assert page.locator('.kn-task').count()==3
            assert page.locator('.kn-status').inner_text().startswith('Kanzo synced')
            page.locator('.kn-search').fill('Mealie')
            assert page.locator('.kn-task').count()==1
            page.locator('.kn-search').fill('')
            page.locator('.kn-select').first.select_option('family')
            assert page.locator('.kn-task').count()==1
            page.locator('.kn-select').first.select_option('all')
            page.locator('.kn-stage-select').select_option('doing')
            assert page.locator('.kn-task').count()==1
            page.locator('.kn-stage-select').select_option('all')
            page.locator('.kn-task[data-id="1"]').click()
            assert page.locator('.kn-dialog').evaluate('(el)=>el.open')
            assert page.locator('.kn-comment').count()==1
            assert page.locator('.kn-dialog textarea[name="description"]').input_value().startswith('Use protected')
            # Unsaved edits must not disappear without an explicit decision.
            page.locator('.kn-dialog input[name=title]').fill('Unsaved change')
            page.once('dialog',lambda dialog:dialog.dismiss())
            page.locator('.kn-modal-close').click()
            assert page.locator('.kn-dialog').evaluate('(el)=>el.open')
            page.once('dialog',lambda dialog:dialog.accept())
            page.locator('.kn-modal-close').click()
            assert not page.locator('.kn-dialog').evaluate('(el)=>el.open')
            page.locator('.kn-done-label input').check()
            page.wait_for_selector('.kn-task[data-id="4"]')
            page.locator('.kn-done-label input').uncheck()
            page.wait_for_function('document.querySelectorAll(".kn-task").length===3')
            page.locator('.kn-primary').first.click()
            page.locator('.kn-dialog input[name="title"]').fill('New approved job')
            page.locator('.kn-form button[type="submit"]').click()
            page.wait_for_selector('.kn-task[data-id="5"]')
            page.locator('.kn-stage-select').select_option('all')
            assert any(w['path'].endswith('/api/tasks') and w['body']['title']=='New approved job' for w in page.evaluate('window.__writes'))
            if width==1280:
                # Concurrent changes must be rejected, not overwritten.
                page.locator('.kn-task[data-id="1"]').click()
                page.locator('.kn-dialog input[name=title]').fill('Edited by me')
                page.evaluate('window.__rows.find(x=>x.id===1).title="Edited by another agent"')
                before=len(page.evaluate('window.__writes'))
                page.locator('.kn-form button[type=submit]').click()
                page.wait_for_function('document.querySelector(".kn-form-feedback")?.textContent.includes("changed in Kanzo")')
                assert len(page.evaluate('window.__writes'))==before
                page.once('dialog',lambda dialog:dialog.accept())
                page.locator('.kn-modal-close').click()
                page.locator('.kn-task[data-id="1"]').drag_to(page.locator('.kn-column[data-stage="todo"]'))
                page.wait_for_function('window.__rows.find(x=>x.id===1).status==="todo"')
                assert any(w['path'].endswith('/tasks/1/move') for w in page.evaluate('window.__writes'))
                # Explicitly cancel advancing a reviewed task to done.
                page.locator('.kn-task[data-id="2"]').click()
                page.locator('.kn-dialog select').select_option('done')
                page.once('dialog',lambda dialog:dialog.dismiss())
                before=len(page.evaluate('window.__writes'))
                page.locator('.kn-form button[type="submit"]').click()
                assert len(page.evaluate('window.__writes'))==before
                assert page.evaluate('window.__rows.find(x=>x.id===2).status')=='review'
                page.locator('.kn-modal-close').click()

            stats=page.evaluate('''() => ({viewport:innerWidth,scroll:document.documentElement.scrollWidth,
                cols:getComputedStyle(document.querySelector('.kn-results')).gridTemplateColumns,
                cards:document.querySelectorAll('.kn-task').length})''')
            assert stats['scroll']<=width+1,stats
            if width==768: assert page.locator('.kn-task').first.evaluate('(el)=>getComputedStyle(el).color')!='rgb(255, 255, 255)'
            assert not errors,errors
            if width==390:page.screenshot(path='/mnt/data/kanban-mobile-390.png',full_page=True)
            if width==1280:page.screenshot(path='/mnt/data/kanban-desktop-1280.png',full_page=True)
            print('PASS',width,stats)
            page.evaluate('window.__dispose()');page.close()
    finally:browser.close()
