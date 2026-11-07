"""Regression: a failed unified refresh must clear all previously rendered source data."""
from pathlib import Path
from playwright.sync_api import sync_playwright

root = Path(__file__).resolve().parents[1]
script = (root / 'static/app.js').read_text(encoding='utf-8')
script = script[script.index('async function viewUnifiedGraph()'):script.index('// Embed the original upstream applications instead of reproducing their controls.')]
bootstrap = r'''
const APP=document.querySelector('#app');
const state={cleanup:null};
const esc=(v)=>String(v??'').replace(/[&<>"']/g, c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;'}[c]));
const fmt=(v)=>Number(v).toLocaleString('en-US');
const relative=()=> 'just now';
const pill=(v)=>`<span class="pill">${esc(v)}</span>`;
const toast=(...args)=>window.toasts.push(args);
const schedule=()=>{};
window.toasts=[];window.fetchResults=[];window.graphUpdates=[];
function createKnowledgeGraph(canvas,{onSelect}){
  let data={nodes:[],edges:[]};
  return {
    update(next){data=next;window.graphUpdates.push({nodes:data.nodes.map(n=>n.id),edges:data.edges.length})},
    filter(){},getVisible(){return {...data,omitted:0}},fit(){},focus(){},focusEdge(){},
    setMode(){},zoomBy(){},dispose(){}
  };
}
async function api(path){
  if(path==='/api/graph/annotations') return {annotations:{}};
  if(path.startsWith('/api/unified/graph?')) {
    if(!window.fetchResults.length) throw new Error('no mocked response');
    const next=window.fetchResults.shift();
    if(next.throw)throw new Error(next.throw);
    return next;
  }
  throw new Error('Unexpected endpoint '+path);
}
window.queue=(item)=>window.fetchResults.push(item);
window.start=()=>viewUnifiedGraph();
'''
node = {'available': True, 'retrieved_at': '2026-11-02T01:00:00Z',
        'nodes': [{'id': 'repoql:windows-only', 'label': 'Windows only', 'source_system': 'repoql', 'degree': 2}],
        'edges': [], 'sources': [{'name': 'repoql', 'available': True}]}
other = {'available': True, 'retrieved_at': '2026-11-02T01:01:00Z',
         'nodes': [{'id': 'tencent:new-local', 'label': 'Fresh local', 'source_system': 'tencent', 'degree': 1}],
         'edges': [], 'sources': [{'name': 'tencent', 'available': True}]}

with sync_playwright() as p:
    browser = p.chromium.launch(headless=True, executable_path='/usr/bin/chromium', args=['--no-sandbox'])
    try:
        page = browser.new_page(viewport={'width': 1100, 'height': 820})
        errors = []
        page.on('pageerror', lambda e: errors.append(str(e)))
        page.set_content('<!doctype html><html><body><main id="app"></main></body></html>')
        page.add_script_tag(content=bootstrap + script)
        page.evaluate('(item)=>{queue(item);window.start()}', node)
        page.wait_for_function('window.graphUpdates.some(e=>e.nodes.includes("repoql:windows-only"))')
        assert 'Windows only' in page.locator('#ug-results').inner_text()
        # An HTTP 200 with an explicit unavailable response is a failure.
        page.evaluate('queue({available:false,error:"windows_local_unified_gateway_unverified"});document.querySelector("#ug-reload").click()')
        page.wait_for_function('document.querySelector("#ug-loading").classList.contains("error")')
        assert page.evaluate('window.graphUpdates.at(-1).nodes.length') == 0
        assert 'Windows only' not in page.locator('#ug-results').inner_text()
        assert 'no current source data' in page.locator('#ug-info').text_content()
        assert 'Local graph sources could not be verified' in page.locator('#ug-sources').text_content()
        assert 'windows_local_unified_gateway_unverified' in page.locator('#ug-loading').inner_text()
        # A transport rejection after recovery must also clear the displayed graph.
        page.evaluate('(item)=>{queue(item);document.querySelector("#ug-reload").click()}', other)
        page.wait_for_function('window.graphUpdates.at(-1).nodes.includes("tencent:new-local")')
        assert not page.locator('#ug-loading').evaluate('(e)=>e.classList.contains("show")')
        page.evaluate('queue({throw:"connection refused"});document.querySelector("#ug-reload").click()')
        page.wait_for_function('document.querySelector("#ug-loading").innerText.includes("connection refused")')
        assert page.evaluate('window.graphUpdates.at(-1).nodes.length') == 0
        assert 'Fresh local' not in page.locator('#ug-results').inner_text()
        assert errors == [], errors
        print('PASS: loaded graph -> explicit unavailable -> fresh graph -> transport failure; no stale display')
    finally:
        browser.close()
