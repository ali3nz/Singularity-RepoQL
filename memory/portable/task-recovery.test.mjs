import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { linkedCaptureUnits, recoverBoundTask } from './task-recovery.mjs';
const taskId = 'task-abcdef1234';
const identity = { team_id: 't1', user_id: 'u1', agent_id: 'a1' };
const unit = (task, status = 'reconciled', agent = 'agent-alpha') => ({ task_id: task,
  task_id_source: 'binding', agent, session_id: 's1', first_seq: 1, last_seq: 2, status, at: '2026-11-12T00:00:00Z' });
const ledger = { units: { 'oc:s1:1-2': unit(taskId), 'oc:s2:1-2': unit('task-other12345'),
  'oc:s3:1-2': unit(taskId, 'failed'), 'fake': unit(taskId) } };
const dir = mkdtempSync(join(tmpdir(), 'singularity-task-recovery-'));
const ledgerPath = join(dir, 'ledger.json');
writeFileSync(ledgerPath, JSON.stringify(ledger));
const args = { ledgerPath, taskId, agent: 'agent-alpha', identity, query: 'incident', verifyTask: async () => true };
const core = async (endpoint, body) => {
  assert.equal(body.task_id, taskId);
  assert.equal(body.agent_id, identity.agent_id);
  return endpoint.includes('/atomic/') ? { code: 0, data: { atoms: [
    { id: 'l1a', task_id: taskId, session_id: 's1', content: 'valid', timestamp: '2026-11-12T11:00:00Z' },
    { id: 'leak', task_id: 'task-other12345', content: 'wrong task' },
    { id: 'alien', task_id: taskId, session_id: 's2', content: 'unlinked session' },
    { id: 'foreign', task_id: taskId, session_id: 's1', agent_id: 'other', content: 'other agent' },
  ] } } : { code: 0, data: { messages: [
    { id: 'l0a', task_id: taskId, session_id: 's1', content: 'support', timestamp: '2026-11-12T09:00:00Z' },
    { id: 'leak2', task_id: 'task-other12345', content: 'wrong task' },
  ] } };
};
test('only exact trusted bound units are accepted', () => {
  assert.deepEqual(linkedCaptureUnits(ledger, taskId, 'agent-alpha').map(x => x.unitId), ['oc:s1:1-2']);
  assert.equal(linkedCaptureUnits(ledger, taskId, 'agent-beta').length, 0);
});
test('authorization must be verified before memory read', async () => {
  let queried = false;
  const r = await recoverBoundTask({ ...args, verifyTask: async () => false, core: async () => { queried = true; } });
  assert.equal(r.code, 'KANZO_AUTHORIZATION_NOT_VERIFIED');
  assert.equal(queried, false);
});
test('missing verifier fails closed', async () => {
  assert.equal((await recoverBoundTask({ ...args, verifyTask: undefined, core })).code, 'INVALID_OR_UNAUTHORIZED_REQUEST');
});
test('L1/L0 scoped recovery is chronological and re-filters leaking server rows', async () => {
  const r = await recoverBoundTask({ ...args, core });
  assert.equal(r.ok, true);
  assert.deepEqual(r.refs.map(x => x.id), ['l0a', 'l1a']);
  assert.equal(r.omitted.length, 4);
  assert.equal(r.units.length, 1);
});
test('no task link is an explicit insufficient-evidence result', async () => {
  let queried = false;
  const r = await recoverBoundTask({ ...args, taskId: 'task-9876543', core: async () => { queried = true; } });
  assert.equal(r.code, 'NO_TASK_LINKED_EVIDENCE');
  assert.equal(queried, false);
});
test('missing ledger cannot be treated as empty authoritative history', async () => {
  const r = await recoverBoundTask({ ...args, ledgerPath: join(dir, 'missing'), core });
  assert.equal(r.code, 'CAPTURE_LEDGER_UNAVAILABLE');
});
test('an engine error never returns partial cross-task evidence', async () => {
  let called = 0;
  const r = await recoverBoundTask({ ...args, core: async () => ++called === 1 ?
    { code: 0, data: { atoms: [{ id: 'good', task_id: taskId }] } } : { code: 1 } });
  assert.equal(r.code, 'MEMORYCORE_RECALL_FAILED');
  assert.deepEqual(r.refs, []);
});
test('exact task evidence cannot exceed unit budget', async () => {
  const r = await recoverBoundTask({ ...args, maxUnits: 0, core });
  assert.equal(r.code, 'TASK_UNIT_BUDGET_EXCEEDED');
});

test('Windows Kanzo numeric task IDs are accepted only through explicit binding', () => {
  const l = { units: { 'oc:s1:1-2': unit('kanzo:1219') } };
  assert.equal(linkedCaptureUnits(l, 'kanzo:1219', 'agent-alpha').length, 1);
  assert.equal(linkedCaptureUnits(l, '1219', 'agent-alpha').length, 0);
  assert.equal(linkedCaptureUnits(l, 'kanzo:0001219', 'agent-alpha').length, 0);
});
