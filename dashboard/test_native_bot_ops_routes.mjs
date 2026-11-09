import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {viewOpenMausOps} from './static/openmausbot_ops.js';

function element() {
  return {innerHTML: '', textContent: '', dataset: {},
    classList: {toggle() {}, add() {}, remove() {}},
    addEventListener() {}, removeEventListener() {}, appendChild() {},
    querySelector() { return null; }, querySelectorAll() { return []; }};
}
globalThis.document = {getElementById: element, querySelectorAll() { return []; },
  querySelector() { return null; }, addEventListener() {}, removeEventListener() {},
  createElement: element, body: element(), hidden: false};
globalThis.location = {hash: '', pathname: '/', href: 'http://127.0.0.1:18100/'};
const replaced = [];
globalThis.history = {replaceState(_state, _title, url) { replaced.push(url); }};
globalThis.sessionStorage = {getItem() { return null; }, setItem() {}};
globalThis.matchMedia = () => ({matches: false, addEventListener() {}});
globalThis.window = {addEventListener() {}, scrollTo() {}};
const esc = value => String(value ?? '').replaceAll('&', '&amp;').replaceAll('<', '&lt;')
  .replaceAll('>', '&gt;').replaceAll('"', '&quot;');
const snapshot = {generated_at: Date.now(), sources: {routines: {state: 'ok'}, bots: {state: 'ok'}},
  bots: [{id: 'bot-alpha', name: 'Alpha'}], ghost_bot_id: 'bot-alpha',
  routines: [], runs: [], occurrences: [], attention: [], now: {running: [], upcoming: []}, history: {kept_runs: 0}};

for (let variant = 1; variant <= 4; variant++) {
  window.__SINGULARITY_VARIANT__ = {variant, features: {ghost: true, office: variant % 2 === 0}};
  const {__editorTestSurface: surface} = await import(`./static/app.js?bot-ops-${variant}`);
  for (const suffix of ['', '/calendar', '/attention', '/history', '/fleet']) {
    assert.equal(surface.featureAllowed('/openmausbot' + suffix), true);
  }
  assert.equal(surface.featureAllowed('/bots'), true);
  assert.equal(surface.featureAllowed('/ghost'), false);
  assert.doesNotMatch(surface.dashboardSnapshot(), /Ghost|companion/);
  for (const tab of ['now', 'calendar', 'attention', 'history']) {
    const app = element(), requests = [];
    let cleanup;
    await viewOpenMausOps({app, esc, pageHead: title => `<h1>${title}</h1>`, current: () => true,
      api: async path => { requests.push(path); return snapshot; },
      tab, params: {bot: 'ghost', tab: 'ghost'}, includeGhost: false,
      workspaceHref: 'http://127.0.0.1:18211/', setCleanup: fn => { cleanup = fn; }});
    cleanup();
    assert.deepEqual(requests.map(path => path.split('?')[0]), ['/api/openmausbot/ops']);
    assert.match(app.innerHTML, new RegExp(`data-tab="${tab}"`));
    for (const label of ['Now', 'Calendar', 'Needs attention', 'Run history']) assert.ok(app.innerHTML.includes(label));
    assert.match(app.innerHTML, /href="http:\/\/127\.0\.0\.1:18211\/"/);
    assert.doesNotMatch(app.innerHTML, /Ghost|ghost|★/);
    assert.doesNotMatch(replaced.at(-1), /ghost/);
  }
}

delete window.__SINGULARITY_VARIANT__;
const app = element(), requests = [];
let cleanup;
await viewOpenMausOps({app, esc, pageHead: title => `<h1>${title}</h1>`, current: () => true,
  api: async path => { requests.push(path); return path.startsWith('/api/ghost/')
    ? {collector: 'ok', generatedAt: Date.now(), runs: []} : snapshot; },
  setCleanup: fn => { cleanup = fn; }});
cleanup();
assert.ok(requests.includes('/api/ghost/status'));
assert.match(app.innerHTML, /Ghost's downstream runner/);
assert.match(app.innerHTML, /href="#\/openmausbot\/chat"/);
const source = readFileSync(new URL('./static/app.js', import.meta.url), 'utf8');
assert.doesNotMatch(source, /^import .*ghost\/dashboard\.js/m);
assert.match(source, /await import\('\.\/ghost\/dashboard\.js'\)/);
assert.match(source, /if \(path === "\/bots" \|\| path\.startsWith\("\/bots\/"\)\)/);
assert.doesNotMatch(source, /windowsOmbTabStrip|windowsOmbIncludesGhost|viewOpenMausBotWindows/);
console.log('Shared bot operations passed for all Windows variants and legacy Linux.');
