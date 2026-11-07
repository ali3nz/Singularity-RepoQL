import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { ClaimLayer } from '../lib/layer.mjs';

function clock(start = 1_760_000_000_000) {
  const box = { t: start };
  box.now = () => box.t;
  box.advance = (ms) => { box.t += ms; };
  return box;
}

function freshLayer(now, ttlMs = 90_000) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'kanzo-claim-'));
  const layer = new ClaimLayer({ stateDir: dir, now, ttlMs });
  return { dir, layer };
}

test('state dir and key are private', () => {
  const { dir } = freshLayer(clock().now);
  assert.equal(fs.statSync(dir).mode & 0o777, 0o700);
  assert.equal(fs.statSync(path.join(dir, 'claim-key')).mode & 0o777, 0o600);
  assert.ok(fs.readFileSync(path.join(dir, 'claim-key')).length >= 32);
});

test('claim succeeds and a second session is refused on the same scope', async () => {
  const c = clock();
  const { layer, dir } = freshLayer(c.now);
  const other = new ClaimLayer({ stateDir: dir, now: c.now });
  const receipt = await layer.claimWork({ scope: 'dashboard/auth', session: 'session-a' });
  assert.equal(receipt.status, 'active');
  assert.ok(receipt.sig);

  const check = await other.checkWork({ scope: 'dashboard/auth' });
  assert.equal(check.available, false);
  assert.equal(check.conflicts.length, 1);

  await assert.rejects(
    () => other.claimWork({ scope: 'dashboard/auth', session: 'session-b' }),
    (err) => err.message === 'scope_conflict' && err.conflict.session === 'session-a',
  );
});

test('overlap is refused on parent and child scopes, allowed when disjoint', async () => {
  const c = clock();
  const { layer } = freshLayer(c.now);
  await layer.claimWork({ scope: 'native/windows/kanzo-claim', session: 'a' });
  await assert.rejects(() => layer.claimWork({ scope: 'native/windows', session: 'b' }), /scope_conflict/);
  await assert.rejects(() => layer.claimWork({ scope: 'native/windows/kanzo-claim/lib', session: 'b' }), /scope_conflict/);
  const ok = await layer.claimWork({ scope: 'native/windows/provision', session: 'b' });
  assert.equal(ok.session, 'b');
});

test('release frees the scope; only the owner may release', async () => {
  const c = clock();
  const { layer } = freshLayer(c.now);
  const r = await layer.claimWork({ scope: 'installer', session: 'a' });
  await assert.rejects(() => layer.closeWork({ claim_id: r.claim_id, session: 'b' }), /claim_not_owned/);
  const closed = await layer.closeWork({ claim_id: r.claim_id, session: 'a' });
  assert.equal(closed.status, 'released');
  const again = await layer.claimWork({ scope: 'installer', session: 'b' });
  assert.equal(again.session, 'b');
  assert.equal((await layer.checkWork({ scope: 'installer' })).available, false);
});

test('heartbeat extends an active claim past its original expiry', async () => {
  const c = clock();
  const { layer } = freshLayer(c.now, 30_000);
  const r = await layer.claimWork({ scope: 'docs', session: 'a' });
  c.advance(20_000);
  const hb = await layer.heartbeat({ claim_id: r.claim_id, session: 'a', ttlSeconds: 60 });
  assert.ok(new Date(hb.expires_at).getTime() > new Date(r.expires_at).getTime());
  c.advance(40_000);
  assert.equal((await layer.checkWork({ scope: 'docs' })).available, false);
  await assert.rejects(() => layer.heartbeat({ claim_id: r.claim_id, session: 'b' }), /claim_not_owned/);
});

test('claim expires at TTL and a different session may then claim it', async () => {
  const c = clock();
  const { layer } = freshLayer(c.now, 10_000);
  const r = await layer.claimWork({ scope: 'memory', session: 'a' });
  c.advance(10_001);
  assert.equal((await layer.checkWork({ scope: 'memory' })).available, true);
  await assert.rejects(() => layer.heartbeat({ claim_id: r.claim_id, session: 'a' }), /claim_not_active/);
  const next = await layer.claimWork({ scope: 'memory', session: 'b' });
  assert.equal(next.session, 'b');
});

test('claims survive a restart and stay enforced', async () => {
  const c = clock();
  const { layer, dir } = freshLayer(c.now, 120_000);
  const r = await layer.claimWork({ scope: 'provisioner', session: 'a' });
  const reopened = new ClaimLayer({ stateDir: dir, now: c.now });
  const check = await reopened.checkWork({ scope: 'provisioner' });
  assert.equal(check.available, false);
  assert.equal(check.tampered, false);
  assert.equal(check.conflicts[0].claim_id, r.claim_id);
});

test('a tampered claim signature is rejected, not trusted', async () => {
  const c = clock();
  const { layer, dir } = freshLayer(c.now);
  const r = await layer.claimWork({ scope: 'gateway', session: 'a' });
  const file = path.join(dir, 'claims.json');
  const doc = JSON.parse(fs.readFileSync(file, 'utf8'));
  doc.claims[0].expires_at = doc.claims[0].expires_at + 86_400_000; // extend without re-signing
  fs.writeFileSync(file, JSON.stringify(doc));
  const reopened = new ClaimLayer({ stateDir: dir, now: c.now });
  const check = await reopened.checkWork({ scope: 'gateway' });
  assert.equal(check.available, true);
  assert.equal(check.tampered, true);
  assert.equal((await reopened.checkWork({ scope: 'gateway' })).conflicts.length, 0);
});

test('create_work records a task and lists it', async () => {
  const c = clock();
  const { layer } = freshLayer(c.now);
  const task = await layer.createWork({ scope: 'dashboard', title: 'Setup health panel', session: 'a' });
  assert.equal(task.status, 'open');
  const { tasks } = await layer.listTasks();
  assert.equal(tasks.length, 1);
  assert.equal(tasks[0].title, 'Setup health panel');
});

test('invalid scopes are refused', async () => {
  const c = clock();
  const { layer } = freshLayer(c.now);
  await assert.rejects(() => layer.claimWork({ scope: '../escape', session: 'a' }), /invalid_scope/);
  await assert.rejects(() => layer.claimWork({ scope: '   ', session: 'a' }), /invalid_scope/);
  await assert.rejects(() => layer.claimWork({ scope: 'ok', session: '' }), /session_required/);
});
