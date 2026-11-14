// Windows uses a native test transport; fixture responses are not product Rust parity.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { writeNativeCliFixture } from '../../native/windows/native_cli_fixture.mjs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { recoverBoundTask } from './task-recovery.mjs';

const taskId = 'task-abcdef1234';
const agent = 'agent-alpha';
const identity = { team_id: 't1', user_id: 'u1', agent_id: 'a1' };
const temp = mkdtempSync(join(tmpdir(), 'task-rust-boundary-'));
const ledgerPath = join(temp, 'ledger.json');
writeFileSync(ledgerPath, JSON.stringify({ units: {
  'oc:s1:1-2': { task_id: taskId, task_id_source: 'binding', agent,
    session_id: 's1', first_seq: 1, last_seq: 2, status: 'reconciled', at: '2026-11-12T00:00:00Z' },
  'oc:foreign:2-4': { task_id: 'task-foreign123', task_id_source: 'binding', agent,
    session_id: 'foreign', first_seq: 2, last_seq: 4, status: 'reconciled' },
} }));
const response = (endpoint) => endpoint.includes('/atomic/')
  ? { code: 0, data: { atoms: [
    { id: 'l1', task_id: taskId, session_id: 's1', content: 'valid', timestamp: '2026-11-12T10:00:00Z' },
    { id: 'alien', task_id: taskId, session_id: 'foreign', content: 'wrong session' },
  ] } }
  : { code: 0, data: { messages: [
    { id: 'l0', task_id: taskId, session_id: 's1', content: 'valid', timestamp: '2026-11-12T09:00:00Z' },
    { id: 'foreign', task_id: 'task-foreign123' },
  ] } };
const args = { ledgerPath, taskId, agent, identity, query: 'incident',
  verifyTask: async () => true, core: async (endpoint) => response(endpoint) };
const expectedUnits = [{ unitId: 'oc:s1:1-2', sessionId: 's1', firstSeq: 1,
  lastSeq: 2, capturedAt: '2026-11-12T00:00:00Z' }];
const key = 'SINGULARITY_RUST_MEMORY_POLICY_BIN';
function fakeNative(output, exitCode = 0, fakeUnits = []) {
  const script = join(temp, `fake-${Date.now()}-${Math.random().toString(16).slice(2)}`);
  const body = `#!/usr/bin/env node\nif(!["task-recovery-snapshot","task-links"].includes(process.argv[2]))process.exit(5);\n` +
    `let b="";process.stdin.on("data",s=>b+=s);process.stdin.on("end",()=>{` +
    `const req=JSON.parse(b);if(process.argv[2]==="task-links") {` +
    `process.stdout.write(JSON.stringify({ok:true,units:req.taskId===${JSON.stringify(taskId)}?${JSON.stringify(fakeUnits)}:[]}));return;}` +
    `if(req.ledger?.units?.["oc:foreign:2-4"])process.exit(6);` +
    `process.stdout.write(${JSON.stringify(JSON.stringify(output))});process.exit(${exitCode});});\n`;
  return writeNativeCliFixture(script, body);
}
async function withBin(bin, action) {
  const old = process.env[key];
  process.env[key] = bin;
  try { return await action(); }
  finally { if (old === undefined) delete process.env[key]; else process.env[key] = old; }
}
test('trusted JS authorization and transport precede native post-processing', async () => {
  const original = process.env[key]; delete process.env[key];
  let expected;
  try { expected = await recoverBoundTask(args); }
  finally { if (original !== undefined) process.env[key] = original; }
  assert.deepEqual(expected.refs.map(r => r.id), ['l0', 'l1']);
  const bin = fakeNative({ ok: true, value: expected }, 0, expected.units);
  const actual = await withBin(bin, () => recoverBoundTask(args));
  assert.deepEqual(actual, expected);
});
test('native result cannot widen task scope or substitute different memory', async () => {
  const bad = { ok: true, code: 'TASK_EVIDENCE_RECOVERED', taskId, units: [],
    refs: [{ layer: 'L1', id: 'leak', taskId }], omitted: [], advisory: true };
  const result = await withBin(fakeNative({ ok: true, value: bad }, 0, expectedUnits), () => recoverBoundTask(args));
  assert.deepEqual(result, { ok: false, code: 'RUST_TASK_RECOVERY_MISMATCH', refs: [] });
});
test('failed native process cannot fall back to JavaScript results', async () => {
  const result = await withBin(fakeNative({ ok: true }, 7, expectedUnits), () => recoverBoundTask(args));
  assert.deepEqual(result, { ok: false, code: 'RUST_TASK_RECOVERY_UNVERIFIED', refs: [] });
});
test('unverified Kanzo ownership blocks MemoryCore queries and native calls', async () => {
  let called = 0;
  const result = await withBin('/nonexistent/task-native', () => recoverBoundTask({ ...args,
    verifyTask: async () => false, core: async () => { called++; return {}; } }));
  assert.deepEqual(result, { ok: false, code: 'KANZO_AUTHORIZATION_NOT_VERIFIED', refs: [] });
  assert.equal(called, 0);
});
test('no task links are never invented by Rust', async () => {
  const result = await withBin(fakeNative({ ok: true, value: null }, 0, expectedUnits), () => recoverBoundTask({ ...args,
    taskId: 'task-23456789', core: async () => { throw Error('must not call'); } }));
  assert.equal(result.code, 'NO_TASK_LINKED_EVIDENCE');
});
test('a forged native task link fails closed before querying MemoryCore', async () => {
  let called = 0;
  const fabricated = [{ ...expectedUnits[0], sessionId: 'foreign' }];
  const result = await withBin(fakeNative({ ok: true, value: null }, 0, fabricated),
    () => recoverBoundTask({ ...args, core: async () => { called++; return {}; } }));
  assert.deepEqual(result, { ok: false, code: 'RUST_TASK_LINKS_UNVERIFIED', refs: [] });
  assert.equal(called, 0);
});
test('cleanup test fixtures', () => { rmSync(temp, { force: true, recursive: true }); });
