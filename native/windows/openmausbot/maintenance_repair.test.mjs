import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync, mkdirSync, writeFileSync, readFileSync, readdirSync, existsSync, rmSync} from 'node:fs';
import {join, dirname} from 'node:path';
import {tmpdir} from 'node:os';
import {fileURLToPath} from 'node:url';
import {detect, repair, runCli} from './maintenance_repair.mjs';

// The owned installer treats any byte that differs from its own template as a
// user-modified (foreign) file, so the drift fixture must use the real template.
const TEMPLATE = readFileSync(join(dirname(fileURLToPath(import.meta.url)), 'AGENTS.md'), 'utf8');

function sandbox({withRules = false, rules = 'owned rules\n', withReceipt = false} = {}) {
  const root = mkdtempSync(join(tmpdir(), 'singularity-repair-'));
  const dataDir = join(root, '.openmausbot');
  const home = join(root, 'home');
  const workspace = join(root, 'source');
  for (const d of [dataDir, home, workspace]) mkdirSync(d, {recursive: true});
  mkdirSync(join(dataDir, 'bots'), {recursive: true});
  if (withRules) writeFileSync(join(dataDir, 'bots', 'AGENTS.md'), rules);
  if (withReceipt) writeFileSync(join(dataDir, 'bots', '.singularity-openmausbot-rules.json'), JSON.stringify({schema: 1, target: join(dataDir, 'bots', 'AGENTS.md'), sha256: 'stale'}));
  return {root, dataDir, home, workspace};
}

const paths = (s) => ({home: s.home, dataDir: s.dataDir, workspace: s.workspace});
const rules = (s) => join(s.dataDir, 'bots', 'AGENTS.md');
const reports = (s) => {
  const dir = join(s.home, 'reports', 'maintenance');
  return existsSync(dir) ? readdirSync(dir).filter((f) => f.endsWith('.md')) : [];
};
const outbox = (s) => {
  const f = join(s.home, 'reports', 'maintenance', '.outbox.json');
  return existsSync(f) ? JSON.parse(readFileSync(f, 'utf8')) : {schema: 1, pending: {}};
};

test('missing owned rules are repaired and independently verified', () => {
  const s = sandbox();
  const r = repair(paths(s), {allowFixture: true});
  assert.equal(r.status, 'fixed-and-verified');
  assert.equal(r.changed.includes(rules(s)), true);
  assert.equal(existsSync(join(s.dataDir, 'bots', '.singularity-openmausbot-rules.json')), true);
  assert.equal(reports(s).length, 1);
  assert.equal(detect(paths(s)).defect, null);
});

test('a verified fix is idempotent: retry adds no report and no second chat', () => {
  const s = sandbox();
  const sent = [];
  repair(paths(s), {allowFixture: true, sendChat: (m) => { sent.push(m); return true; }});
  const again = repair(paths(s), {allowFixture: true, sendChat: (m) => { sent.push(m); return true; }});
  assert.equal(again.status, 'already-fixed');
  assert.equal(again.duplicate, true);
  assert.equal(sent.length, 1);
  assert.equal(reports(s).length, 1);
});

test('a genuine recurrence of the same defect is repaired again, never suppressed', () => {
  const s = sandbox();
  const sent = [];
  const sendChat = (m) => { sent.push(m); return true; };
  const first = repair(paths(s), {allowFixture: true, sendChat});
  assert.equal(first.status, 'fixed-and-verified');
  assert.equal(first.occurrences, 1);
  rmSync(rules(s), {force: true});                        // the same defect recurs
  assert.equal(detect(paths(s)).defect, 'OMB_SHARED_RULES_MISSING');
  const second = repair(paths(s), {allowFixture: true, sendChat});
  assert.equal(second.status, 'fixed-and-verified');
  assert.equal(second.duplicate, false);
  assert.equal(second.recurrence, true);
  assert.equal(second.occurrences, 2);
  assert.equal(existsSync(rules(s)), true);
  assert.equal(reports(s).length, 2);
  assert.equal(sent.length, 2);
  assert.equal(detect(paths(s)).defect, null);
});

test('an unacknowledged chat is queued with a stable send id and retried once, then delivered', () => {
  const s = sandbox();
  const first = repair(paths(s), {allowFixture: true, sendChat: () => false});
  assert.equal(first.status, 'fixed-and-verified');
  assert.equal(first.chatDelivered, false);
  assert.equal(first.chatState, 'CHAT_DELIVERY_PENDING');
  const queued = outbox(s).pending;
  assert.equal(Object.keys(queued).length, 1);
  const key = Object.keys(queued)[0];
  assert.equal(queued[key].attempts, 1);

  const sends = [];
  const retry = repair(paths(s), {allowFixture: true,
    sendChat: (message, opts) => { sends.push(opts.sendId); return {acknowledged: true}; }});
  assert.equal(retry.status, 'already-fixed');           // no repair, only the retry
  assert.equal(retry.chatRetried, 1);
  assert.equal(retry.chatPending, 0);
  assert.deepEqual(sends, [queued[key].sendId]);          // same idempotency key, sent once
  assert.equal(Object.keys(outbox(s).pending).length, 0);

  const third = repair(paths(s), {allowFixture: true, sendChat: () => { throw new Error('must not be called'); }});
  assert.equal(third.chatRetried, 0);
});

test('a throwing sender keeps the message pending with an attempt count', () => {
  const s = sandbox();
  repair(paths(s), {allowFixture: true, sendChat: () => { throw new Error('OMB_CHAT_UNREACHABLE'); }});
  repair(paths(s), {allowFixture: true, sendChat: () => { throw new Error('OMB_CHAT_UNREACHABLE'); }});
  const entry = Object.values(outbox(s).pending)[0];
  assert.ok(entry, 'the message is still queued');
  assert.equal(entry.attempts >= 2, true);
  assert.match(entry.lastError, /OMB_CHAT_UNREACHABLE/);
});

test('a user-modified AGENTS.md is preserved and reported approval-blocked', () => {
  const s = sandbox({withRules: true, rules: 'user owned instructions\n'});
  const before = readFileSync(rules(s), 'utf8');
  const r = repair(paths(s), {allowFixture: true});
  assert.equal(r.status, 'approval-blocked');
  assert.equal(readFileSync(rules(s), 'utf8'), before);
  assert.equal(reports(s).length, 0);
});

test('a stale receipt over an identical file is repaired without touching user content', () => {
  const s = sandbox({withRules: true, rules: TEMPLATE, withReceipt: true});
  assert.equal(detect(paths(s)).defect, 'OMB_RULES_RECEIPT_DRIFT');
  const r = repair(paths(s), {allowFixture: true});
  assert.equal(r.status, 'fixed-and-verified');
  assert.equal(detect(paths(s)).defect, null);
});

test('failed verification restores the original bytes and says so only after readback', () => {
  const s = sandbox({withRules: true, rules: TEMPLATE, withReceipt: true});
  const receipt = join(s.dataDir, 'bots', '.singularity-openmausbot-rules.json');
  const beforeReceipt = readFileSync(receipt, 'utf8');
  const r = repair(paths(s), {
    allowFixture: true,
    deps: {verifyRules: () => { throw new Error('RULES_NOT_INSTALLED_OR_CHANGED'); }},
  });
  assert.equal(r.status, 'attempted-unverified');
  assert.equal(r.rollback, 'restored-and-verified');
  assert.equal(readFileSync(receipt, 'utf8'), beforeReceipt);   // original state back
  assert.equal(reports(s).length, 0);
  assert.equal(r.chatDelivered, false);
});

test('a failing restore is reported as rollback-failed, never as restored', () => {
  const s = sandbox({withRules: true, rules: TEMPLATE, withReceipt: true});
  const r = repair(paths(s), {
    allowFixture: true,
    deps: {verifyRules: () => { throw new Error('RULES_NOT_INSTALLED_OR_CHANGED'); },
      copyFile: () => { throw new Error('EACCES'); }},
  });
  assert.equal(r.status, 'attempted-unverified');
  assert.equal(r.rollback, 'rollback-failed:EACCES');
  assert.equal(r.chatDelivered, false);
});

test('failed verification with nothing to back up never claims a restore', () => {
  const s = sandbox();                                   // bots dir, no rules, no receipt
  const r = repair(paths(s), {
    allowFixture: true,
    deps: {installRules: () => {}, verifyRules: () => { throw new Error('RULES_NOT_INSTALLED_OR_CHANGED'); }},
  });
  assert.equal(r.status, 'attempted-unverified');
  assert.equal(r.rollback, 'rollback-failed:no-backup');
});

test('a concurrent run is refused by the exclusive lock instead of repairing twice', () => {
  const s = sandbox();
  const dir = join(s.home, 'reports', 'maintenance');
  mkdirSync(dir, {recursive: true});
  writeFileSync(join(dir, '.lock'), JSON.stringify({pid: process.pid, at: new Date().toISOString()}));
  const sent = [];
  const r = repair(paths(s), {allowFixture: true, sendChat: (m) => { sent.push(m); return true; }});
  assert.equal(r.status, 'busy');
  assert.equal(r.reason, 'MAINTENANCE_LOCK_HELD');
  assert.equal(existsSync(rules(s)), false);
  assert.equal(sent.length, 0);
  assert.equal(reports(s).length, 0);
});

test('a stale lock from a dead process is replaced and the repair proceeds', () => {
  const s = sandbox();
  const dir = join(s.home, 'reports', 'maintenance');
  mkdirSync(dir, {recursive: true});
  writeFileSync(join(dir, '.lock'), JSON.stringify({pid: 999999, at: new Date(0).toISOString()}));
  const r = repair(paths(s), {allowFixture: true});
  assert.equal(r.status, 'fixed-and-verified');
  assert.equal(existsSync(join(dir, '.lock')), false);
});

test('an uninstalled OpenMausBot is not repaired', () => {
  const s = sandbox();
  rmSync(join(s.dataDir, 'bots'), {recursive: true, force: true});
  const r = repair(paths(s), {allowFixture: true});
  assert.equal(r.status, 'unable-to-repair');
  assert.equal(r.changed.length, 0);
});

test('absolute locations are required', () => {
  assert.throws(() => detect({home: './h', dataDir: '/d', workspace: '/w'}), /ABSOLUTE/);
});

test('the verified claim is split: files on disk versus the live bot and its gates', () => {
  const s = sandbox();
  const r = repair(paths(s), {allowFixture: true});
  assert.equal(r.status, 'fixed-and-verified');
  assert.equal(r.onDiskVerified, true);
  assert.equal(r.loadedIntoActiveTurn, false);
  assert.equal(r.gateEnforcementVerified, false);
  assert.equal(r.reloadRequired, true);
  assert.match(String(r.operatorAction), /reload or restart/);
  const body = readFileSync(r.report, 'utf8');
  assert.match(body, /On-disk verification: verified/);
  assert.match(body, /Live gate enforcement: NOT VERIFIED/);
  assert.match(body, /Live bot loaded the rules: NOT VERIFIED/);
});

// --- production CLI boundary and occurrence identity ------------------------

function cliSandbox() {
  const root = mkdtempSync(join(tmpdir(), 'singularity-cli-'));
  const stage = join(root, 'stage', 'omb');
  const dataDir = join(root, 'state', 'omb');
  const home = join(root, 'home');
  for (const d of [stage, dataDir, home, join(dataDir, 'bots')]) mkdirSync(d, {recursive: true});
  writeFileSync(join(stage, 'cli.js'), '');
  writeFileSync(join(dataDir, 'instance.json'), JSON.stringify({payload: stage, data_dir: dataDir,
    mode: 'headless-no-pair-task', task: 'pair_task_windows', port: 47123, pid: process.pid}));
  return {root, stage, dataDir, home, workspace: root};
}

function fakeVendor(state) {
  return (node, args, opts) => {
    const frames = String(opts.input || '').split('\n').filter(Boolean).map((line) => JSON.parse(line));
    const replies = [];
    for (const frame of frames) {
      if (frame.id === 1) {
        replies.push({jsonrpc: '2.0', id: 1,
          result: {protocolVersion: '2024-11-05', capabilities: {}, serverInfo: {name: 'fake'}}});
        continue;
      }
      if (frame.method !== 'tools/call') continue;
      const name = frame.params.name;
      state.calls.push(name);
      if (name === 'list_bots') {
        replies.push({jsonrpc: '2.0', id: frame.id,
          result: {structuredContent: {bots: [{id: 'bot-1', name: 'Singularity Maintainer'}]}}});
      } else if (name === 'send_bot_message') {
        state.sendIds.push(frame.params.arguments.send_id);
        replies.push({jsonrpc: '2.0', id: frame.id,
          result: {structuredContent: state.ack === false ? {} : {messageId: 'm-1'}}});
      } else {
        replies.push({jsonrpc: '2.0', id: frame.id, result: {structuredContent: {}}});
      }
    }
    return {status: 0, stdout: replies.map((r) => JSON.stringify(r)).join('\n') + '\n'};
  };
}

const cliArgs = (s) => ['--apply', '--fixture', '--home', s.home, '--data-dir', s.dataDir, '--workspace', s.workspace];

test('the production CLI wires the vendor sender itself', () => {
  const s = cliSandbox();
  const state = {calls: [], sendIds: []};
  const r = runCli(cliArgs(s), {run: fakeVendor(state)});
  assert.equal(r.status, 'fixed-and-verified');
  assert.equal(r.chatDelivered, true);
  assert.equal(r.chatState, 'delivered');
  assert.ok(state.calls.includes('send_bot_message'), 'wired through the vendor MCP tools');
  assert.match(state.sendIds[0], /^singularity-maintainer-[0-9a-f]{16}-1$/);
  assert.equal(r.chatReason, undefined);
});

test('a recurrence sends a new id while the earlier pending message is retried, not replaced', () => {
  const s = cliSandbox();
  const first = {calls: [], sendIds: [], ack: false};
  const r1 = runCli(cliArgs(s), {run: fakeVendor(first)});
  assert.equal(r1.chatState, 'CHAT_DELIVERY_PENDING');
  assert.match(r1.sendId, /-1$/);
  const box = JSON.parse(readFileSync(join(s.home, 'reports', 'maintenance', '.outbox.json'), 'utf8'));
  assert.deepEqual(Object.keys(box.pending), [r1.sendId]);

  rmSync(join(s.dataDir, 'bots', 'AGENTS.md'));
  const second = {calls: [], sendIds: []};
  const r2 = runCli(cliArgs(s), {run: fakeVendor(second)});
  assert.equal(r2.occurrences, 2);
  assert.match(r2.sendId, /-2$/);
  assert.notEqual(r2.sendId, r1.sendId);
  assert.ok(second.sendIds.includes(r1.sendId), 'the older pending occurrence is retried first');
  assert.ok(second.sendIds.includes(r2.sendId));
  const after = JSON.parse(readFileSync(join(s.home, 'reports', 'maintenance', '.outbox.json'), 'utf8'));
  assert.equal(Object.keys(after.pending).length, 0);
});

test('an unverifiable instance reports a bounded reason instead of claiming chat', () => {
  const s = cliSandbox();
  rmSync(join(s.dataDir, 'instance.json'));
  const state = {calls: [], sendIds: []};
  const r = runCli(cliArgs(s), {run: fakeVendor(state)});
  assert.equal(r.status, 'fixed-and-verified');
  assert.equal(r.chatDelivered, false);
  assert.equal(r.chatReason, 'OMB_INSTANCE_RECORD_MISSING');
  assert.equal(state.calls.length, 0);
});
