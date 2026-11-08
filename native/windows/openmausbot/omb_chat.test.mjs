import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync} from 'node:fs';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {mcpSession, ombChatSender, ensureMaintainerRoutine, readMaintainerRoutine} from './omb_chat.mjs';

/** A vendor-shaped MCP server: line-delimited JSON-RPC on stdin/stdout, reading
 *  and writing the same shared JSON file, so a real subprocess is exercised. */
const FAKE_CLI = `
import {readFileSync, writeFileSync, existsSync} from 'node:fs';
const statePath = process.env.FAKE_OMB_STATE;
const read = () => existsSync(statePath) ? JSON.parse(readFileSync(statePath, 'utf8')) : {routines: [], sends: []};
const write = (s) => writeFileSync(statePath, JSON.stringify(s));
const out = [];
const lines = readFileSync(0, 'utf8').split(/\\r?\\n/).filter(Boolean);
for (const line of lines) {
  const frame = JSON.parse(line);
  if (frame.method === 'initialize') {
    out.push({jsonrpc: '2.0', id: frame.id, result: {protocolVersion: '2024-11-05', capabilities: {}, serverInfo: {name: 'fake-omb'}}});
    continue;
  }
  if (frame.method !== 'tools/call') continue;
  const name = frame.params.name;
  const args = frame.params.arguments ?? {};
  const state = read();
  let payload;
  if (name === 'list_bots') payload = {bots: [{id: 'bot-1', name: 'Singularity Maintainer', chiefOfStaff: true}]};
  else if (name === 'send_bot_message') {
    if (process.env.FAKE_OMB_SILENT === '1') payload = {accepted: true};
    else { state.sends.push({bot_id: args.bot_id, text: args.text, send_id: args.send_id}); write(state); payload = {taskId: 'task-' + state.sends.length}; }
  } else if (name === 'trigger') {
    state.routines.push({id: 'trig-1', name: args.name, enabled: true,
      nextRunAt: new Date(Date.now() + 3600000).toISOString(), schedule: args.schedule, for_bot_id: args.for_bot_id});
    state.creates = (state.creates ?? 0) + 1;
    write(state);
    payload = {created: true};
  } else if (name === 'trigger_info') payload = {routines: state.routines};
  else payload = {unknown: name};
  out.push({jsonrpc: '2.0', id: frame.id, result: {content: [{type: 'text', text: JSON.stringify(payload)}]}});
}
process.stdout.write(out.map((f) => JSON.stringify(f)).join('\\n') + '\\n');
`;

function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'singularity-omb-chat-'));
  const dir = join(root, 'omb');
  mkdirSync(dir, {recursive: true});
  const cli = join(dir, 'cli.js');
  writeFileSync(cli, FAKE_CLI);
  const state = join(dir, 'state.json');
  return {root, cli, state, env: {FAKE_OMB_STATE: state}};
}

const routine = () => ({
  name: 'Singularity maintenance sweep',
  instructions: 'Run the bounded sweep and report the exact result.',
  schedule: {type: 'interval', everyMinutes: 360, anchorAt: new Date().toISOString()},
});

test('one MCP session answers calls in order without inventing answers', () => {
  const f = fixture();
  const [bots, routines] = mcpSession({cli: f.cli, port: 18211, env: f.env,
    calls: [{name: 'list_bots'}, {name: 'trigger_info', arguments: {action: 'list'}}]});
  assert.equal(bots.bots[0].name, 'Singularity Maintainer');
  assert.deepEqual(routines.routines, []);
  // An unknown tool is returned as the vendor sent it: never invented, never swallowed.
  const [unknown] = mcpSession({cli: f.cli, port: 18211, env: f.env, calls: [{name: 'nope'}]});
  assert.deepEqual(unknown, {unknown: 'nope'});
});

test('the chat sender acknowledges only a vendor receipt and reuses the idempotency key', () => {
  const f = fixture();
  const send = ombChatSender({cli: f.cli, port: 18211, env: f.env});
  const ack = send('Singularity Maintainer: FIXED x', {sendId: 'singularity-maintainer-abc123'});
  assert.equal(ack.acknowledged, true);
  assert.equal(ack.messageId, 'task-1');
  const sent = JSON.parse(readFileSync(f.state, 'utf8')).sends;
  assert.equal(sent[0].send_id, 'singularity-maintainer-abc123');
  assert.equal(sent[0].bot_id, 'bot-1');

  const silent = fixture();
  const noReceipt = ombChatSender({cli: silent.cli, port: 18211,
    env: {...silent.env, FAKE_OMB_SILENT: '1'}})('text', {sendId: 'k'});
  assert.equal(noReceipt.acknowledged, false);
  assert.equal(noReceipt.reason, 'OMB_CHAT_NO_RECEIPT');

  const missingKey = ombChatSender({cli: f.cli, port: 18211, env: f.env})('text', {});
  assert.equal(missingKey.acknowledged, false);
  assert.equal(missingKey.reason, 'OMB_CHAT_SEND_ID_REQUIRED');
});

test('the routine is created through the vendor trigger tool and verified by readback', () => {
  const f = fixture();
  const first = ensureMaintainerRoutine({cli: f.cli, port: 18211, env: f.env, routine: routine()});
  assert.equal(first.created, true);
  assert.equal(first.verified, true);
  assert.equal(first.enabled, true);
  assert.equal(first.triggerId, 'trig-1');
  const saved = JSON.parse(readFileSync(f.state, 'utf8'));
  assert.equal(saved.creates, 1);
  assert.equal(saved.routines[0].schedule.type, 'interval');
  assert.equal(saved.routines[0].schedule.everyMinutes, 360);
  assert.equal(saved.routines[0].for_bot_id, 'bot-1');

  const again = ensureMaintainerRoutine({cli: f.cli, port: 18211, env: f.env, routine: routine()});
  assert.equal(again.created, false, 'an existing routine is never created twice');
  assert.equal(again.verified, true);
  assert.equal(JSON.parse(readFileSync(f.state, 'utf8')).creates, 1);
});

test('a routine that cannot be observed is reported unverified, not assumed', () => {
  const f = fixture();
  const read = readMaintainerRoutine({cli: f.cli, port: 18211, name: routine().name, env: f.env});
  assert.equal(read.present, false);
  assert.equal(read.verified, false);
  assert.equal(read.reason, 'OMB_ROUTINE_NOT_OBSERVED');
});
