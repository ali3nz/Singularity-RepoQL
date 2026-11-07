// Claim/lease semantics over the Kanzo task view, with HMAC-signed receipts.
// Deliberately small: TTL, heartbeat, scope-overlap refusal, expiry, release.
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { ClaimStore, ensurePrivateDir } from './store.mjs';

export const DEFAULT_TTL_MS = 90_000;
export const MAX_TTL_MS = 15 * 60_000;

export function normalizeScope(scope) {
  if (typeof scope !== 'string') throw new Error('invalid_scope');
  const cleaned = scope.trim().replace(/\\/g, '/').replace(/\/+$/, '');
  if (!cleaned || cleaned.length > 512 || cleaned.split('/').some((part) => part === '..')) {
    throw new Error('invalid_scope');
  }
  return cleaned;
}

function overlaps(a, b) {
  return a === b || a.startsWith(b + '/') || b.startsWith(a + '/');
}

function canonical(claim) {
  return JSON.stringify([
    claim.id, claim.scope, claim.session, claim.owner, claim.created_at,
    claim.expires_at, claim.status, claim.task_id ?? null,
  ]);
}

export class ClaimLayer {
  constructor({ stateDir, now = Date.now, ttlMs = DEFAULT_TTL_MS } = {}) {
    if (!stateDir) throw new Error('state_dir_required');
    this.dir = ensurePrivateDir(stateDir);
    this.keyPath = path.join(this.dir, 'claim-key');
    this.now = now;
    this.ttlMs = ttlMs;
    this.key = this._loadOrCreateKey();
    this.store = new ClaimStore(this.dir, { now });
  }

  _loadOrCreateKey() {
    try {
      const buf = fs.readFileSync(this.keyPath);
      if (buf.length < 32) throw new Error('claim_key_invalid');
      return buf;
    } catch (err) {
      if (err.code !== 'ENOENT') throw err;
      const key = crypto.randomBytes(32);
      const fd = fs.openSync(this.keyPath, 'wx', 0o600);
      try { fs.writeSync(fd, key); fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
      return key;
    }
  }

  _sign(claim) {
    return crypto.createHmac('sha256', this.key).update(canonical(claim)).digest('base64url');
  }

  _verify(claim) {
    if (!claim || typeof claim.sig !== 'string') return false;
    const expected = this._sign(claim);
    const a = Buffer.from(expected);
    const b = Buffer.from(claim.sig);
    return a.length === b.length && crypto.timingSafeEqual(a, b);
  }

  _expire(doc) {
    const now = this.now();
    for (const claim of doc.claims) {
      if (claim.status !== 'active') continue;
      if (!this._verify(claim)) {
        claim.status = 'rejected';
        doc.rejected = (doc.rejected ?? 0) + 1;
        continue;
      }
      if (claim.expires_at <= now) claim.status = 'expired';
    }
  }

  _active(doc) {
    return doc.claims.filter((c) => c.status === 'active');
  }

  _receipt(claim) {
    return Object.freeze({
      claim_id: claim.id, scope: claim.scope, session: claim.session,
      owner: claim.owner, status: claim.status,
      created_at: new Date(claim.created_at).toISOString(),
      expires_at: new Date(claim.expires_at).toISOString(),
      task_id: claim.task_id ?? null, sig: claim.sig,
    });
  }

  async checkWork({ scope }) {
    const wanted = normalizeScope(scope);
    const doc = this.store.read();
    this._expire(doc);
    const active = this._active(doc);
    const conflicts = active.filter((c) => overlaps(c.scope, wanted));
    return {
      scope: wanted,
      available: conflicts.length === 0,
      conflicts: conflicts.map((c) => this._receipt(c)),
      active_claims: active.length,
      tampered: (doc.rejected ?? 0) > 0,
    };
  }

  async claimWork({ scope, session, owner, ttlSeconds }) {
    const wanted = normalizeScope(scope);
    if (typeof session !== 'string' || !session.trim()) throw new Error('session_required');
    const ttl = Math.min(Math.max(Number(ttlSeconds ?? 0) * 1000 || this.ttlMs, 1_000), MAX_TTL_MS);
    return this.store.mutate((doc) => {
      this._expire(doc);
      const clash = this._active(doc).find((c) => overlaps(c.scope, wanted));
      if (clash) {
        const err = new Error('scope_conflict');
        err.conflict = this._receipt(clash);
        throw err;
      }
      const now = this.now();
      const claim = {
        id: crypto.randomUUID(), scope: wanted, session: session.trim(),
        owner: (owner || session).toString().slice(0, 200),
        created_at: now, expires_at: now + ttl, status: 'active', task_id: null,
      };
      claim.sig = this._sign(claim);
      doc.claims.push(claim);
      return this._receipt(claim);
    });
  }

  async heartbeat({ claim_id, session, ttlSeconds }) {
    return this.store.mutate((doc) => {
      this._expire(doc);
      const claim = doc.claims.find((c) => c.id === claim_id);
      if (!claim) throw new Error('claim_not_found');
      if (claim.session !== session) throw new Error('claim_not_owned');
      if (claim.status !== 'active') throw new Error('claim_not_active');
      const ttl = Math.min(Math.max(Number(ttlSeconds ?? 0) * 1000 || this.ttlMs, 1_000), MAX_TTL_MS);
      claim.expires_at = this.now() + ttl;
      claim.sig = this._sign(claim);
      return this._receipt(claim);
    });
  }

  async closeWork({ claim_id, session }) {
    return this.store.mutate((doc) => {
      this._expire(doc);
      const claim = doc.claims.find((c) => c.id === claim_id);
      if (!claim) throw new Error('claim_not_found');
      if (claim.session !== session) throw new Error('claim_not_owned');
      if (claim.status !== 'active') throw new Error('claim_not_active');
      claim.status = 'released';
      claim.sig = this._sign(claim);
      return this._receipt(claim);
    });
  }

  async createWork({ scope, title, session, taskId }) {
    const wanted = normalizeScope(scope);
    if (typeof title !== 'string' || !title.trim()) throw new Error('title_required');
    return this.store.mutate((doc) => {
      const now = this.now();
      const task = {
        id: taskId || crypto.randomUUID(), scope: wanted, title: title.trim().slice(0, 200),
        session: typeof session === 'string' ? session.trim() : 'local', created_at: now,
        status: 'open',
      };
      doc.tasks.push(task);
      return task;
    });
  }

  async listTasks() {
    const doc = this.store.read();
    return { tasks: doc.tasks };
  }
}
