import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync} from 'node:fs';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {EventEmitter} from 'node:events';
import {PassThrough} from 'node:stream';
import {createInterface} from 'node:readline';
import {mcpSession, ombChatSender, ensureMaintainerRoutine, readMaintainerRoutine} from './omb_chat.mjs';

/** A vendor-shaped MCP server: line-delimited JSON-RPC on stdin/stdout, reading
 *  and writing the same shared JSON file. Calls are answered as they arrive, so
 *  the real subprocess exercises the handshake and request/response pacing. */
const FAKE_CLI = `
import {readFileSync, writeFileSync, existsSync} from 'node:fs';
import {createInterface} from 'node:readline';
const statePath = process.env.FAKE_OMB_STATE;
const read = () => existsSync(statePath) ? JSON.parse(readFileSync(statePath, 'utf8')) : {routines: [], sends: [], events: []};
const write = (s) => writeFileSync(statePath, JSON.stringify(s));
const send = (frame) => process.stdout.write(JSON.stringify(frame) + '\\n');
const input = createInterface({input: process.stdin, crlfDelay: Infinity});
let inFlight = 0;
input.on('line', (line) => {
  const frame = JSON.parse(line);
  if (frame.method === 'initialize') {
    const state = read();
    state.events.push('initialize');
    write(state);
    send({jsonrpc: '2.0', id: frame.id, result: {protocolVersion: '2024-11-05', capabilities: {}, serverInfo: {name: 'fake-omb'}}});
    return;
  }
  if (frame.method === 'notifications/initialized') {
    const state = read();
    state.events.push('initialized');
    write(state);
    return;
  }
  if (frame.method !== 'tools/call') return;
  const name = frame.params.name;
  const args = frame.params.arguments ?? {};
  const state = read();
  state.events.push('call:' + name + (inFlight ? ':overlap' : ''));
  write(state);
  inFlight++;
  setTimeout(() => {
    const current = read();
    let payload;
    if (name === 'list_bots') payload = {bots: [{id: 'bot-1', name: 'Singularity Maintainer', chiefOfStaff: true}]};
    else if (name === 'send_bot_message') {
      if (process.env.FAKE_OMB_SILENT === '1') payload = {accepted: true};
      else { current.sends.push({bot_id: args.bot_id, text: args.text, send_id: args.send_id}); payload = {taskId: 'task-' + current.sends.length}; }
    } else if (name === 'trigger') {
      current.routines.push({id: 'trig-1', name: args.name, enabled: true,
        nextRunAt: new Date(Date.now() + 3600000).toISOString(), schedule: args.schedule, for_bot_id: args.for_bot_id});
      current.creates = (current.creates ?? 0) + 1;
      payload = {created: true};
    } else if (name === 'trigger_info') payload = {routines: current.routines};
    else payload = {unknown: name};
    current.events.push('reply:' + name);
    write(current);
    send({jsonrpc: '2.0', id: frame.id, result: {content: [{type: 'text', text: JSON.stringify(payload)}]}});
    inFlight--;
  }, name === 'list_bots' ? 25 : 0);
});
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

test('one MCP session answers calls in order without inventing answers', async () => {
  const f = fixture();
  const [bots, routines] = await mcpSession({cli: f.cli, port: 18211, env: f.env,
    calls: [{name: 'list_bots'}, {name: 'trigger_info', arguments: {action: 'list'}}]});
  assert.equal(bots.bots[0].name, 'Singularity Maintainer');
  assert.deepEqual(routines.routines, []);
  const events = JSON.parse(readFileSync(f.state, 'utf8')).events;
  assert.deepEqual(events, ['initialize', 'initialized', 'call:list_bots', 'reply:list_bots',
    'call:trigger_info', 'reply:trigger_info']);
  // An unknown tool is returned as the vendor sent it: never invented, never swallowed.
  const [unknown] = await mcpSession({cli: f.cli, port: 18211, env: f.env, calls: [{name: 'nope'}]});
  assert.deepEqual(unknown, {unknown: 'nope'});
});

test('EOF rejects the pending request and terminates the child', async () => {
  let fakeChild;
  const spawnChild = () => {
    const child = new EventEmitter();
    child.stdin = new PassThrough();
    child.stdout = new PassThrough();
    child.exitCode = null;
    child.signalCode = null;
    child.killed = false;
    child.kill = () => {
      child.killed = true;
      child.signalCode = 'SIGTERM';
      child.stdout.end();
      child.emit('close', null, 'SIGTERM');
      return true;
    };
    const input = createInterface({input: child.stdin, crlfDelay: Infinity});
    input.on('line', (line) => {
      const frame = JSON.parse(line);
      if (frame.method === 'initialize') {
        const response = JSON.stringify({jsonrpc: '2.0', id: frame.id,
          result: {protocolVersion: '2024-11-05', capabilities: {}, serverInfo: {name: 'fake'}}}) + '\n';
        setImmediate(() => {
          child.stdout.write(response.slice(0, 11));
          setImmediate(() => child.stdout.write(response.slice(11)));
        });
      } else if (frame.method === 'tools/call') {
        setImmediate(() => child.stdout.end());
      }
    });
    fakeChild = child;
    return child;
  };

  await assert.rejects(mcpSession({cli: 'fake-cli.js', port: 18211,
    calls: [{name: 'wait_forever'}], spawnChild}), /OMB_MCP_NO_REPLY:wait_forever/);
  assert.equal(fakeChild.killed, true);
});

test('the chat sender acknowledges only a vendor receipt and reuses the idempotency key', async () => {
  const f = fixture();
  const send = ombChatSender({cli: f.cli, port: 18211, env: f.env});
  const ack = await send('Singularity Maintainer: FIXED x', {sendId: 'singularity-maintainer-abc123'});
  assert.equal(ack.acknowledged, true);
  assert.equal(ack.messageId, 'task-1');
  const sent = JSON.parse(readFileSync(f.state, 'utf8')).sends;
  assert.equal(sent[0].send_id, 'singularity-maintainer-abc123');
  assert.equal(sent[0].bot_id, 'bot-1');

  const silent = fixture();
  const noReceipt = await ombChatSender({cli: silent.cli, port: 18211,
    env: {...silent.env, FAKE_OMB_SILENT: '1'}})('text', {sendId: 'k'});
  assert.equal(noReceipt.acknowledged, false);
  assert.equal(noReceipt.reason, 'OMB_CHAT_NO_RECEIPT');

  const missingKey = await ombChatSender({cli: f.cli, port: 18211, env: f.env})('text', {});
  assert.equal(missingKey.acknowledged, false);
  assert.equal(missingKey.reason, 'OMB_CHAT_SEND_ID_REQUIRED');
});

test('the routine is created through the vendor trigger tool and verified by readback', async () => {
  const f = fixture();
  const first = await ensureMaintainerRoutine({cli: f.cli, port: 18211, env: f.env, routine: routine()});
  assert.equal(first.created, true);
  assert.equal(first.verified, true);
  assert.equal(first.enabled, true);
  assert.equal(first.triggerId, 'trig-1');
  const saved = JSON.parse(readFileSync(f.state, 'utf8'));
  assert.equal(saved.creates, 1);
  assert.equal(saved.routines[0].schedule.type, 'interval');
  assert.equal(saved.routines[0].schedule.everyMinutes, 360);
  assert.equal(saved.routines[0].for_bot_id, 'bot-1');

  const again = await ensureMaintainerRoutine({cli: f.cli, port: 18211, env: f.env, routine: routine()});
  assert.equal(again.created, false, 'an existing routine is never created twice');
  assert.equal(again.verified, true);
  assert.equal(JSON.parse(readFileSync(f.state, 'utf8')).creates, 1);
});

test('a routine that cannot be observed is reported unverified, not assumed', async () => {
  const f = fixture();
  const read = await readMaintainerRoutine({cli: f.cli, port: 18211, name: routine().name, env: f.env});
  assert.equal(read.present, false);
  assert.equal(read.verified, false);
  assert.equal(read.reason, 'OMB_ROUTINE_NOT_OBSERVED');
});
