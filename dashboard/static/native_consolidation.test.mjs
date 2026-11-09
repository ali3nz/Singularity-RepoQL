// Windows-only presentation parity with the simplified dockerhost navigation.
// No server, credentials, model or browser are started by this test.
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
function stub(){return {innerHTML:'',textContent:'',dataset:{},classList:{toggle(){},add(){},remove(){}},addEventListener(){},removeEventListener(){},appendChild(){},querySelector(){return null},querySelectorAll(){return []}};}
globalThis.document={getElementById(){return stub()},querySelectorAll(){return []},querySelector(){return null},addEventListener(){},createElement(){return stub()},body:stub(),hidden:false};
globalThis.location={hash:'',pathname:'/',href:'http://127.0.0.1:18100/'};
globalThis.history={replaceState(){}};
globalThis.sessionStorage={getItem(){return null},setItem(){}};
globalThis.matchMedia=()=>({matches:false,addEventListener(){}});
globalThis.window={addEventListener(){},scrollTo(){}};
for (let variant of [1,2,3,4]) {
  const complete = variant===2 || variant===4;
  window.__SINGULARITY_VARIANT__={variant,features:{ghost:false,office:complete,kanban:true,agent_chat:true}};
  const {__editorTestSurface:t}=await import(`./app.js?native-consolidation-${variant}`);
  const command=t.dashboardSnapshot();
  assert.match(command,/href="#\/openmausbot"/);
  assert.match(command,/href="#\/openmausbot\/chat"/);
  assert.match(command,/>Bot Operations</);
  assert.doesNotMatch(command,/href="#\/ghost"/);
  assert.equal(t.featureAllowed('/ghost'),false);
  for (const route of ['/openmausbot','/openmausbot/calendar','/openmausbot/attention','/openmausbot/history','/openmausbot/fleet']) {
    assert.equal(t.featureAllowed(route),true);
  }
}
delete window.__SINGULARITY_VARIANT__;
const {__editorTestSurface:legacy}=await import('./app.js?consolidation-legacy');
assert.match(legacy.dashboardSnapshot(),/href="#\/ghost"/);
assert.match(legacy.dashboardSnapshot(),/href="#\/openmausbot"/);
// Legacy Linux retains the optional console and its lazy-loaded assets.
const app=readFileSync(new URL('./app.js',import.meta.url),'utf8');
assert.match(app,/return await viewGhostOperations\(\);/);
assert.doesNotMatch(app,/insideOpenMausBot|windowsOmbTabStrip/);
assert.match(app,/includeGhost: !nativeInstall/);
assert.match(app,/nativeInstall && link\.dataset\.nav === '\/ghost'/);
assert.match(app,/if \(nativeInstall && link\.dataset\.dock === '\/ghost'\)/);
console.log('Ghost-free Windows bot operations contracts passed (four variants plus legacy).');

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
