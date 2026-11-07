import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import readline from 'node:readline';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const SERVER = path.join(HERE, '..', 'server.mjs');

class Client {
  constructor(stateDir, env = {}) {
    this.nextId = 1;
    this.pending = new Map();
    this.child = spawn(process.execPath, [SERVER], {
      env: { ...process.env, ...env, KANZO_CLAIM_STATE_DIR: stateDir },
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    this.stderr = '';
    this.child.stderr.on('data', (chunk) => { this.stderr += chunk.toString(); });
    readline.createInterface({ input: this.child.stdout }).on('line', (line) => {
      let msg;
      try { msg = JSON.parse(line); } catch { return; }
      const waiter = this.pending.get(msg.id);
      if (waiter) { this.pending.delete(msg.id); waiter(msg); }
    });
  }

  request(method, params) {
    const id = this.nextId++;
    const msg = { jsonrpc: '2.0', id, method };
    if (params !== undefined) msg.params = params;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error(`timeout waiting for ${method}`)), 5000);
      this.pending.set(id, (reply) => { clearTimeout(timer); resolve(reply); });
      this.child.stdin.write(JSON.stringify(msg) + '\n');
    });
  }

  async call(name, args) {
    const reply = await this.request('tools/call', { name, arguments: args });
    const text = reply.result?.content?.[0]?.text ?? '{}';
    return { isError: reply.result?.isError === true, body: JSON.parse(text) };
  }

  close() { this.child.stdin.end(); this.child.kill(); }
}

function stateDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'kanzo-mcp-'));
}

test('initialize and tools/list expose the claim surface', async () => {
  const c = new Client(stateDir());
  try {
    const init = await c.request('initialize', { protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 'test' } });
    assert.equal(init.result.serverInfo.name, 'singularity-kanzo-claim');
    assert.ok(init.result.capabilities.tools);
    const list = await c.request('tools/list', {});
    const names = list.result.tools.map((t) => t.name).sort();
    assert.deepEqual(names, ['check_work', 'claim_work', 'close_work', 'create_work', 'heartbeat', 'list_tasks']);
  } finally { c.close(); }
});

test('two sessions: second is refused, then succeeds after release', async () => {
  const dir = stateDir();
  const a = new Client(dir);
  const b = new Client(dir);
  try {
    const first = await a.call('claim_work', { scope: 'dashboard/setup-health', session: 'session-a', ttl_seconds: 60 });
    assert.equal(first.isError, false);
    assert.equal(first.body.status, 'active');

    const check = await b.call('check_work', { scope: 'dashboard/setup-health' });
    assert.equal(check.body.available, false);

    const clash = await b.call('claim_work', { scope: 'dashboard/setup-health', session: 'session-b' });
    assert.equal(clash.isError, true);
    assert.equal(clash.body.error, 'scope_conflict');
    assert.equal(clash.body.conflict.session, 'session-a');

    const released = await a.call('close_work', { claim_id: first.body.claim_id, session: 'session-a' });
    assert.equal(released.body.status, 'released');

    const second = await b.call('claim_work', { scope: 'dashboard/setup-health', session: 'session-b', ttl_seconds: 60 });
    assert.equal(second.isError, false);
    assert.equal(second.body.session, 'session-b');
  } finally { a.close(); b.close(); }
});

test('heartbeat keeps a claim, and TTL expiry releases it', async () => {
  const dir = stateDir();
  const a = new Client(dir);
  const b = new Client(dir);
  try {
    const claimed = await a.call('claim_work', { scope: 'installer/msi', session: 'a', ttl_seconds: 2 });
    const beat = await a.call('heartbeat', { claim_id: claimed.body.claim_id, session: 'a', ttl_seconds: 3 });
    assert.equal(beat.isError, false);
    await new Promise((r) => setTimeout(r, 1200));
    const still = await b.call('check_work', { scope: 'installer/msi' });
    assert.equal(still.body.available, false, 'heartbeat must keep the claim alive');
    await new Promise((r) => setTimeout(r, 2200));
    const after = await b.call('check_work', { scope: 'installer/msi' });
    assert.equal(after.body.available, true, 'claim must expire after its TTL');
  } finally { a.close(); b.close(); }
});

test('concurrent startup in one state dir keeps one shared key', async () => {
  // Multi-agent is the normal case: several MCP servers initialise the same
  // state dir at once and must all survive and agree on ONE HMAC key.
  const dir = stateDir();
  const clients = Array.from({ length: 4 }, () => new Client(dir));
  try {
    const claims = await Promise.all(clients.map((c, i) =>
      c.call('claim_work', { scope: `concurrent/${i}`, session: `session-${i}`, ttl_seconds: 60 })));
    claims.forEach((reply, i) => {
      assert.equal(reply.isError, false, `client ${i} must start and claim: ${JSON.stringify(reply.body)}`);
      assert.equal(reply.body.status, 'active');
    });
    const key = fs.readFileSync(path.join(dir, 'claim-key'));
    assert.ok(key.length >= 32);
    // The shared key is what makes cross-session refusal real: a claim signed by
    // client 0 must verify (not be rejected as tampered) in client 3.
    const check = await clients[3].call('check_work', { scope: 'concurrent/0' });
    assert.equal(check.body.available, false);
    assert.equal(check.body.tampered, false, 'claims from another session must verify');
    assert.equal(check.body.conflicts[0].session, 'session-0');
  } finally { clients.forEach((c) => c.close()); }
});

test('a claim survives an MCP server restart', async () => {
  // Restart is a fresh process over the same state dir: the claim must still be
  // enforced, must still verify against the shared key, and must still be
  // releasable by its owning session.
  const dir = stateDir();
  const first = new Client(dir);
  let claimId;
  try {
    const claimed = await first.call('claim_work', {
      scope: 'restart/scope', session: 'session-a', ttl_seconds: 60, task_id: 'fleet#893',
    });
    assert.equal(claimed.isError, false);
    claimId = claimed.body.claim_id;
    assert.equal(claimed.body.task_id, 'fleet#893');
  } finally { first.close(); }
  await new Promise((r) => setTimeout(r, 150));

  const second = new Client(dir);
  try {
    const check = await second.call('check_work', { scope: 'restart/scope' });
    assert.equal(check.body.available, false, 'restart must not drop an active claim');
    assert.equal(check.body.tampered, false, 'the restarted server must share the HMAC key');
    assert.equal(check.body.conflicts[0].claim_id, claimId);

    const clash = await second.call('claim_work', { scope: 'restart/scope', session: 'session-b', ttl_seconds: 60 });
    assert.equal(clash.isError, true);
    assert.equal(clash.body.error, 'scope_conflict');

    const released = await second.call('close_work', { claim_id: claimId, session: 'session-a' });
    assert.equal(released.isError, false);
    assert.equal(released.body.status, 'released');
    const after = await second.call('check_work', { scope: 'restart/scope' });
    assert.equal(after.body.available, true);
  } finally { second.close(); }
});

test('unknown tool and missing state dir fail loudly', async () => {
  const c = new Client(stateDir());
  try {
    const bad = await c.request('tools/call', { name: 'nope', arguments: {} });
    assert.equal(bad.error.code, -32602);
  } finally { c.close(); }

  const child = spawn(process.execPath, [SERVER], {
    env: { ...process.env, KANZO_CLAIM_STATE_DIR: '' },
    stdio: ['ignore', 'ignore', 'pipe'],
  });
  const code = await new Promise((resolve) => child.on('exit', resolve));
  assert.equal(code, 2);
});
