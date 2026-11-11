// Regression tests for the curated command-center dashboard surface.
import assert from 'node:assert/strict';
import fs from 'node:fs';

const dead = (id = '') => ({
  id, innerHTML: '', textContent: '', value: '', disabled: false, checked: false,
  dataset: {}, content: '', className: '',
  addEventListener() {}, removeEventListener() {},
  appendChild() {}, replaceChildren() {},
  querySelector: () => null, querySelectorAll: () => [], closest: () => null,
  classList: { toggle() {}, add() {}, remove() {} },
  focus() {}, click() {},
  getBoundingClientRect: () => ({ width: 0, height: 0, left: 0, top: 0 }),
});
globalThis.document = {
  getElementById: () => dead(),
  createElement: () => dead(),
  querySelector: () => null,
  querySelectorAll: () => [],
  addEventListener() {},
  body: dead('body'),
  hidden: false,
};
globalThis.window = globalThis.document;
globalThis.location = { hash: '', pathname: '/', search: '', href: 'http://127.0.0.1:18100/' };
globalThis.history = { replaceState() {}, pushState() {} };
globalThis.sessionStorage = { getItem: () => null, setItem() {}, removeItem() {} };
globalThis.matchMedia = () => ({ matches: false, addEventListener() {} });
globalThis.requestAnimationFrame = (fn) => setTimeout(fn, 0);
globalThis.cancelAnimationFrame = (id) => clearTimeout(id);

const { dashboardSnapshot, miniatureBrainGraph } = (await import('../static/app.js')).__editorTestSurface;
const ready = dashboardSnapshot({service:{verdict:'ready',queued_operations:2},indexing:{active:1,failed_rows:3},repositories:{unavailable:0},errors:{indexing_failures:3}});

const expectedOrder = ['OpenMausBot','Bot Schedules','Agent Chat','Memory Graph','Office Viewer'];
for (const expected of [...expectedOrder, 'Reference documents', 'System knowledge', 'Diagnostics', 'RepoQL Cheat Sheet', 'AI Usage', 'Memory Architecture', 'Orchestration Architecture']) {
  assert.ok(ready.includes(expected), expected);
}
for (const diagnosticLabel of ['Harness Control Center', 'Live Agents', 'Execution History']) {
  assert.ok(ready.includes(diagnosticLabel), `${diagnosticLabel} should remain available inside diagnostics`);
}
assert.ok(!ready.includes('System status'));
assert.ok(!ready.includes('RepoQL health'));
assert.ok(ready.includes('Primary workspaces'));
assert.ok(ready.includes('Operations overview'));
assert.equal((ready.match(/class="command-overview-value"/g)||[]).length,4,'four source-backed status fields');
assert.ok(!ready.includes('Designed for faster access'), 'promotional hero subtitle should be absent');
assert.ok(!ready.includes('11 workspaces'))
assert.ok(!ready.includes('Built for your workflow'))
const primaryCards = ready.split('<div class="command-links command-links-priority command-links-visual">')[1];
const positions = expectedOrder.map(label => primaryCards.indexOf(label));
assert(positions.every((pos, index) => pos >= 0 && (index === 0 || pos > positions[index - 1])), 'primary workspace order should match the curated priority');

const cards = [...ready.matchAll(/<a class="command-link command-workspace([^"]*)" data-accent="([^"]+)" href="#([^"]+)">([\s\S]*?)<\/a>/g)];
assert.equal(cards.length, 5, 'only five operational workspaces are primary cards');
assert.equal((ready.match(/class=\"command-rank\"/g) || []).length, 0, 'numeric rank badges should be absent from the curated cards');
const featuredRoutes = [];
assert.deepEqual(cards.filter(card => card[1].includes('command-workspace-feature')).map(card => card[3]), featuredRoutes,
  'all five primary tiles are equal; none is featured');
for (const card of cards) {
  assert.match(card[4], /class="command-card-icon" aria-hidden="true"/, `icon badge missing for ${card[3]}`);
  assert.match(card[4], /class="command-card-illustration" aria-hidden="true"/, `decorative illustration missing for ${card[3]}`);
  const art = {'/openmausbot/chat':'openmausbot','/openmausbot':'bots','/agentchat':'lounge','/unified/graph':'memory','/office':'office-room'}[card[3]];
  assert.ok(art, `unexpected workspace route ${card[3]}`);
  assert.match(card[4], new RegExp(`/assets/tiles/${art}\\.webp[^\"]*\"[^>]*alt=\"\"`), `local decorative artwork missing for ${card[3]}`);
}
assert.equal((ready.match(/class="command-card-illustration"/g) || []).length, expectedOrder.length, 'all workspace cards should now carry decorative artwork');
assert.equal(new Set(cards.map(card => card[3])).size, expectedOrder.length, 'all destinations remain distinct');
// System knowledge contains these links exactly once, with no duplicated primary cards.
const knowledgeSection = ready.split('<details class="command-more block" data-accent="memory" open>')[1]
  .split('</details>')[0];
for (const [label, route] of [['RepoQL Dashboard','/repoql/control'],['Tencent Dashboard','/unified/tencent']]) {
  assert.ok(!cards.some(card => card[3] === route), `${label} should not be a primary card`);
  assert.equal((knowledgeSection.match(new RegExp(`href="#${route}"`, 'g')) || []).length, 1,
    `${label} should have exactly one System knowledge link`);
}

assert.equal((ready.match(/<details class="command-more block"[^>]* open>/g) || []).length, 3, 'all command center sections should start open');
assert.ok(!ready.includes('lower-priority diagnostics'), 'diagnostics should not be ranked as low priority');
const sidebar = fs.readFileSync(new URL('../static/index.html', import.meta.url), 'utf8');
assert.deepEqual([...sidebar.matchAll(/<details class="nav-more" id="([^"]+)"/g)].map(match => match[1]), ['nav-reference','nav-knowledge','nav-more'], 'three distinct sidebar sections remain available; saved state controls expansion');

assert.ok(!ready.includes('Neural control surface'), 'decorative marketing copy should be absent');
assert.ok(ready.includes('href="#/diagnostics"'));
assert.ok(ready.includes('href="#/indexing"'));
assert.ok(ready.includes('href="#/knowledge/connectors"'));
assert.ok(ready.includes('href="#/links"'));
assert(!ready.includes('data-live="true"'), 'illustrated cards must not invent live state');

// dashboardSnapshot is a fixed workspace shell; it does not accept service data.
assert.equal(dashboardSnapshot(), ready, 'workspace shell does not depend on supplied service state');
const miniature = miniatureBrainGraph();
assert.equal((miniature.match(/<circle class="mini-/g)||[]).length,74,'static graph thumbnail preserves illustrative density');
assert.equal(miniature,miniatureBrainGraph(),'illustrative preview is deterministic');
assert(!miniature.includes('api('),'thumbnail never needs a data endpoint');
const js = fs.readFileSync(new URL('../static/app.js',import.meta.url),'utf8');
const home = js.split('async function viewDashboard() {')[1].split('// ------------------------------------------------------------ chart + graph')[0];
assert(home.includes("api('/api/embed/kanzo/handshake'"),'optional counts come from existing Kanzo read endpoint');
assert(home.includes("api('/api/agentchat/presence'"),'agent count comes from Agent Chat presence');
assert(home.includes('void loadOverview()'),'dashboard mounts before optional status requests');
assert(!home.includes('schedule('),'dashboard navigation must not start telemetry polling');
console.log('Dashboard command center contracts PASS (priority, visual thumbnails, no diagnostics gate, local decorative artwork)');

if (process.env.RENDER_DASHBOARD_FIXTURE) {
  const skeleton=fs.readFileSync(new URL('../static/index.html',import.meta.url),'utf8');
  const html=skeleton.replace('    <div class="loading">Loading RepoQL state…</div>',dashboardSnapshot()).replace('<script type="module" src="/app.js"></script>','');
  fs.writeFileSync(process.env.RENDER_DASHBOARD_FIXTURE,html);
}
