// Regression tests for the Tencent memory-editor helpers served by static/app.js.
// Runs from the dashboard root:  node tests/app_test.mjs
// (bun's `node` shim is fine; pure assertions only, no network).
//
// app.js is a browser ES module: the shim below lets bootstrap finish on the
// signpost branch (empty session, no key) without any fetch, timer or view run;
// the exported test surface then exposes only pure helpers.
import assert from 'node:assert/strict';

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
globalThis.window = globalThis.document; // addEventListener/no-op surface
globalThis.location = { hash: '', pathname: '/', search: '', href: 'http://127.0.0.1:18100/' };
globalThis.history = { replaceState() {}, pushState() {} };
globalThis.sessionStorage = {
  getItem: () => null, setItem() {}, removeItem() {},
};
globalThis.matchMedia = () => ({ matches: false, addEventListener() {} });
globalThis.requestAnimationFrame = (fn) => setTimeout(fn, 0);
globalThis.cancelAnimationFrame = (id) => clearTimeout(id);

const { rowsOf, contentOf, createDiscoveryGuard, applyHarnessRefresh, harnessInterval } =
  (await import('../static/app.js')).__editorTestSurface;

const results = [];
// checks run sequentially in declaration order (state is shared); fn may be async.
const checks = [];
const check = (name, fn) => checks.push([name, fn]);

// -- discovery: every envelope shape the panel routes actually return -------
check('rowsOf: data.items list (team-assets/mine/my-agents)', () => {
  const payload = { code: 0, data: { items: [{ id: 'chat_memory-team-a-agt-b' }, { id: 'chat_memory-team-a-agt-c' }] } };
  assert.equal(rowsOf(payload).length, 2);
});
check('rowsOf: items at top level', () => {
  assert.equal(rowsOf({ items: [1, 2] }).length, 2);
});
check('rowsOf: records array (layer reads)', () => {
  assert.equal(rowsOf({ data: { records: [{ body: 'x' }] } })[0].body, 'x');
});
check('rowsOf: memories and rows keys', () => {
  assert.equal(rowsOf({ data: { memories: [{}] } }).length, 1);
  assert.equal(rowsOf({ rows: [{}] }).length, 1);
});
check('rowsOf: nested data.data.items', () => {
  assert.equal(rowsOf({ data: { data: { items: [{}] } } }).length, 1);
});

// -- empty and malformed responses must not crash discovery ------------------
check('rowsOf: empty items -> []', () => {
  assert.deepEqual(rowsOf({ code: 0, data: { items: [], total: 0 } }), []);
});
check('rowsOf: all-null payload -> []', () => {
  assert.deepEqual(rowsOf(null), []);
  assert.deepEqual(rowsOf(undefined), []);
  assert.deepEqual(rowsOf({}), []);
});
check('rowsOf: error envelope (code 400) -> [] (no throw)', () => {
  assert.deepEqual(rowsOf({ code: 400, message: 'MISSING_TEAM_ID', data: null }), []);
});
check('rowsOf: non-array items ignored -> []', () => {
  assert.deepEqual(rowsOf({ data: { items: 'garbage' } }), []);
});

// -- selection/editable-text semantics ---------------------------------------
check('contentOf: body preferred', () => {
  assert.equal(contentOf({ body: 'b', content: 'c', text: 't' }), 'b');
});
check('contentOf: content then text fallbacks', () => {
  assert.equal(contentOf({ content: 'c', text: 't' }), 'c');
  assert.equal(contentOf({ text: 't' }), 't');
});
check('contentOf: non-string fields -> null (record stays uneditable)', () => {
  assert.equal(contentOf({ body: 12345 }), null);
  assert.equal(contentOf({ body: null }), null);
  assert.equal(contentOf({}), null);
});
check('contentOf: empty string is still editable, not null', () => {
  assert.equal(contentOf({ body: '' }), '');
});

// -- WS-2 regression: the refresh setting drives the browser polling ---------
check('applyHarnessRefresh: valid seconds applied (settings-driven)', () => {
  applyHarnessRefresh(45);
  assert.equal(harnessInterval(), 45000);
});
check('applyHarnessRefresh: bounds reject out-of-range seconds', () => {
  applyHarnessRefresh(45);
  applyHarnessRefresh(2);    // below minimum -> ignored, value unchanged
  applyHarnessRefresh(1000); // above maximum -> ignored, value unchanged
  assert.equal(harnessInterval(), 45000, 'out-of-range values never applied');
});
check('applyHarnessRefresh: invalid values leave the setting unchanged', () => {
  applyHarnessRefresh(45);
  applyHarnessRefresh(NaN); applyHarnessRefresh('soon');
  assert.equal(harnessInterval(), 45000);
});
check('harnessInterval never below the 5s safety floor', () => {
  applyHarnessRefresh(6);
  assert.ok(harnessInterval() >= 5000);
});

// Native Tencent MemoryPanel superseded the old inline editor. Verify that
// the route opens the native panel; the historical editor guard is no longer
// part of the active UI and must not gate the new implementation.
import { readFileSync } from 'node:fs';
check('Tencent route uses the native panel instead of the removed editor', () => {
  const src = readFileSync(new URL('./app.js', import.meta.url), 'utf8');
  assert.ok(src.includes('if (path === "/unified/tencent") return await viewTencentNative();'));
  assert.ok(src.includes('async function viewTencentNative()'));
  assert.ok(src.includes("return viewNativePanel('tencent')"));
});

check('discovery guard: stale async loser cannot publish (behavioral)', async () => {
  const g = createDiscoveryGuard();
  const staleToken = g.take();
  const loser = (async () => {
    await new Promise(r => setTimeout(r, 15));   // simulates the older fetch resolving late
    return staleToken;
  })();
  const currentToken = g.take();                // second discovery starts before it resolves
  const lateToken = await loser;
  assert.ok(!g.isCurrent(lateToken), 'late reply from the older discovery is stale');
  assert.ok(g.isCurrent(currentToken), 'current token still publishes');
  g.invalidate();                               // team change while a reply is pending
  assert.ok(!g.isCurrent(currentToken), 'team change invalidates the pending reply');
});

let failed = 0;
for (const [name, fn] of checks) {
  try { await fn(); results.push(['PASS', name]); }
  catch (error) { results.push(['FAIL', `${name}: ${error.message}`]); }
}
for (const [state, name] of results) {
  console.log(`${state}  ${name}`);
  if (state === 'FAIL') failed += 1;
}
console.log(`${results.length - failed}/${results.length} editor-helper checks passed`);
process.exit(failed ? 1 : 0);
