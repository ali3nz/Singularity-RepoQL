// Windows-only presentation parity with the simplified dockerhost navigation.
// No server, credentials, model or browser are started by this test.
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {renderMemoryArchitecturePage, renderOrchestraWorkflowPage} from './workflow_graphs.js';
function stub(){return {innerHTML:'',textContent:'',dataset:{},classList:{toggle(){},add(){},remove(){}},addEventListener(){},removeEventListener(){},appendChild(){},querySelector(){return null},querySelectorAll(){return []}};}
const appNode = stub();
globalThis.document={getElementById(id){return id==='app'?appNode:stub()},querySelectorAll(){return []},querySelector(){return null},addEventListener(){},createElement(){return stub()},body:stub(),hidden:false};
globalThis.location={hash:'',pathname:'/',href:'http://127.0.0.1:18100/'};
globalThis.history={replaceState(){}};
globalThis.sessionStorage={getItem(){return null},setItem(){}};
globalThis.matchMedia=()=>({matches:false,addEventListener(){}});
globalThis.window={addEventListener(){},scrollTo(){}};
const index = readFileSync(new URL('./index.html', import.meta.url), 'utf8');
const navigate = index.match(/<h2>Navigate<\/h2>([\s\S]*?)<details/)[1];
const navigateEntries = [...navigate.matchAll(/<a [^>]*data-nav="([^"]+)"[^>]*>([\s\S]*?)<\/a>/g)]
  .map(([,route,markup]) => ({route,markup,label:markup.replace(/<[^>]*>/g,'').trim()}));
async function checkArchitecture(surface, native) {
  for (const render of [renderMemoryArchitecturePage, renderOrchestraWorkflowPage]) {
    const links = [...render().matchAll(/href="(#\/[^\"]+)"/g)].map(([,href]) => ({
      href, removed:false, getAttribute(){return href;}, remove(){this.removed=true;},
    }));
    let insertedMarkup = '', refresh;
    const requests = [], rows = [];
    const guide = {
      querySelectorAll(){return links;},
      insertAdjacentHTML(position, html){insertedMarkup = html;},
    };
    const button = {disabled:false,addEventListener(event, handler){refresh = handler;}};
    const results = {isConnected:true,replaceChildren(){rows.length=0;},appendChild(row){rows.push(row);}};
    appNode.querySelector = selector => ({
      '.arch-guide':guide, '#arch-runtime-results':results, '#arch-runtime-refresh':button,
    })[selector];
    const savedFetch = globalThis.fetch;
    globalThis.fetch = async path => {
      requests.push(path);
      return new Response(JSON.stringify({ok:true,rust:true,enabled:true,last_ingest:new Date().toISOString()}));
    };
    try {
      surface.architectureRuntimeChecks();
      assert.deepEqual(requests, [], 'opening architecture waits for an explicit service check');
      const visible = links.filter(link => !link.removed).map(link => link.href);
      assert.equal(visible.some(href => href.startsWith('#/harness')), !native);
      if (native) {
        assert.match(insertedMarkup, /href="#\/native\/status"/);
        assert.doesNotMatch(insertedMarkup, /href="#\/harness/);
      }
      await refresh();
      assert.deepEqual(requests, native ? ['/api/unified/health'] : ['/api/harness/health','/api/unified/health']);
      assert.equal(rows.length, requests.length);
      assert.ok(rows.every(row => row.innerHTML.includes('Responding')));
    } finally {
      globalThis.fetch = savedFetch;
      appNode.querySelector = () => null;
    }
  }
}
for (let variant of [1,2,3,4]) {
  const complete = variant===2 || variant===4;
  window.__SINGULARITY_VARIANT__={variant,features:{office:complete,kanban:true,agent_chat:true}};
  const {__editorTestSurface:t}=await import(`./app.js?native-consolidation-${variant}`);
  const command=t.dashboardSnapshot();
  assert.match(command,/href="#\/openmausbot"/);
  assert.match(command,/href="#\/openmausbot\/chat"/);
  assert.match(command,/>Bot Operations</);
  assert.doesNotMatch(command,/href="#\/ghost"/);
  assert.match(command,/href="#\/architecture\/orchestra"/);
  assert.doesNotMatch(command,/href="#\/harness(?:\/|"|\?)/);
  for (const route of ['/repoql/cheat-sheet','/architecture/memory','/architecture/orchestra',
    '/repoql/control','/unified/tencent','/knowledge/all','/links','/knowledge/connectors',
    '/indexing','/diagnostics','/claude/agents','/native/status']) {
    assert.equal(t.featureAllowed(route),true,`variant ${variant} keeps ${route}`);
  }
  for (const route of ['/harness','/harness/agents','/harness/runs','/agents-control','/reference/agents']) {
    assert.equal(t.featureAllowed(route),false,`variant ${variant} excludes fleet route ${route}`);
  }
  await checkArchitecture(t, true);
  const workspaces = [...command.matchAll(/class="command-link command-workspace[^"]*"[^>]*href="#([^"]+)"/g)]
    .map(([,route]) => route);
  assert.deepEqual(workspaces, ['/openmausbot/chat','/kanban','/openmausbot','/agentchat','/unified/graph','/office']);
  const visibleNavigate = navigateEntries.filter(entry => t.featureAllowed(entry.route));
  assert.deepEqual(visibleNavigate.map(entry => entry.label), [
    'Command center','Kanban Board','OpenMausBot','Bot Operations','Agent Lounge',
    ...(complete ? ['Office Viewer'] : []),'Memory Graph',
  ]);
  for (const entry of visibleNavigate) assert.match(entry.markup, /<svg\b/);
  for (const route of ['/openmausbot','/openmausbot/chat','/openmausbot/calendar','/openmausbot/attention','/openmausbot/history','/openmausbot/fleet']) {
    assert.equal(t.featureAllowed(route),true);
  }
}
delete window.__SINGULARITY_VARIANT__;
const {__editorTestSurface:legacy}=await import('./app.js?consolidation-legacy');
assert.doesNotMatch(legacy.dashboardSnapshot(),/href="#\/ghost"/);
assert.equal(legacy.featureAllowed('/architecture/orchestra'),true);
await checkArchitecture(legacy, false);
assert.match(legacy.dashboardSnapshot(),/href="#\/openmausbot"/);
// Legacy Linux retains the optional console and its lazy-loaded assets.
const app=readFileSync(new URL('./app.js',import.meta.url),'utf8');
const workflows = readFileSync(new URL('./workflow_graphs.js', import.meta.url), 'utf8');
assert.doesNotMatch(workflows, /ghost/i, 'architecture graphs carry no Ghost node');
assert.match(workflows, /bindOrchestraWorkflowPage\(\) \{ return bindArchitecture\(ORCHESTRA_MODES/);
assert.doesNotMatch(app,/viewGhostOperations|viewGhostPlanner|includeGhost/);
assert.doesNotMatch(app,/insideOpenMausBot|windowsOmbTabStrip/);
assert.doesNotMatch(app,/workspaceHref:.*127\.0\.0\.1/);
assert.equal([...app.matchAll(/workspaceHref: '#\/openmausbot\/chat'/g)].length, 2);
assert.match(app,/nativeInstall && link\.dataset\.nav === '\/unified\/usage'/);
assert.doesNotMatch(app,/dataset\.dock === '\/ghost'/);
console.log('Ghost-free bot operations contracts passed (four variants plus legacy).');

// Agents Control source contract: the editor exposes only native, non-escalating
// fields, restores through the guarded endpoint, and states required-integration
// presence without claiming live health.
const agentsControl = readFileSync(new URL('./claude_agents_control.js', import.meta.url), 'utf8');
assert.match(agentsControl, /id="claude-agent-permissionMode"/);
for (const mode of ['default','plan','acceptEdits','dontAsk']) assert.match(agentsControl, new RegExp('option value="' + mode + '"'));
assert.doesNotMatch(agentsControl, /option value="bypassPermissions"/);
assert.doesNotMatch(agentsControl, /option value="auto"/);
assert.match(agentsControl, /\/api\/claude\/agents\/restore/);
assert.match(agentsControl, /value\.status === 'configured'/);
assert.match(agentsControl, /live health|connection state not tested/i);
console.log('Agents Control source contract passed (permission modes, restore, required presence).');
