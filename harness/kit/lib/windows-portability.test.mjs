import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { deriveFleetHealth } from './run-health.mjs';
import { findLiveCoordinators } from './start-guard.mjs';
import { coordinatorLiveness, classifySession, closeOrphanedGuarded } from './consult-liveness.mjs';

function workspace(fn) {
  const root = mkdtempSync(join(tmpdir(), 'singularity-native-portability-'));
  try { return fn(root); } finally { rmSync(root, { recursive: true, force: true }); }
}

test('ESM fleet health enumerates persisted runs instead of invoking CommonJS require', () => workspace(root => {
  const run = join(root, '2026-10-29T10-00-00');
  mkdirSync(run);
  writeFileSync(join(run, 'state.json'), JSON.stringify({ runId: 'fixture', runState: 'COMPLETED' }));
  const rows = deriveFleetHealth(root);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].worker, 'complete');
}));

test('Windows /proc absence cannot establish coordinator death', () => {
  const lv = coordinatorLiveness(1234, { cmdlineIncludes: 'orchestrate.mjs' }, { platform: 'win32' });
  assert.equal(lv.alive, false);
  assert.equal(lv.reason, 'process-ownership-unverified');
  const cls = classifySession({ state: 'open', coordinatorPid: 1234, lastAt: 1 }, { platform: 'win32', now: Date.now() });
  assert.equal(cls.status, 'UNVERIFIED');
  assert.notEqual(cls.status, 'ORPHANED');
  const done = classifySession({ state: 'done', lastAt: 1 }, { platform: 'win32' });
  assert.equal(done.status, 'CLOSED');
});

test('Windows refuses legacy orphan-close without native Rust ownership proof', () => workspace(root => {
  const file = join(root, 'meta.json');
  const initial = JSON.stringify({ state: 'open', lastAt: 1 });
  writeFileSync(file, initial);
  const result = closeOrphanedGuarded(file, root, () => ({ status: 'ORPHANED' }), 'test', { platform: 'win32' });
  assert.equal(result.closed, false);
  assert.match(result.reason, /native-authority/);
  assert.equal(readFileSync(file, 'utf8'), initial);
}));

test('legacy orphan race cannot replace a concurrent writer with its rejected candidate', () => workspace(root => {
  const file = join(root, 'meta.json');
  writeFileSync(file, JSON.stringify({ state: 'open', lastAt: 1, owner: 'old' }));
  const result = closeOrphanedGuarded(file, root, () => {
    writeFileSync(file, JSON.stringify({ state: 'open', lastAt: 2, owner: 'new-writer' }));
    return { status: 'ORPHANED' };
  }, 'test', { platform: 'linux' });
  assert.equal(result.closed, false);
  assert.equal(JSON.parse(readFileSync(file, 'utf8')).owner, 'new-writer');
}));

test('Windows start guard fails closed instead of treating missing /proc as no active coordinator', () => {
  assert.throws(() => findLiveCoordinators({ platform: 'win32' }), /NATIVE_WINDOWS_COORDINATOR_PROBE_REQUIRED/);
  assert.deepEqual(findLiveCoordinators({ platform: 'linux', listPids: [1], selfPid: 1 }), []);
});
