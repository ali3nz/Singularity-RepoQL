// Durable, single-writer claim store. No dependency on the production Kanzo
// board: the state directory is caller-supplied (RC/throwaway in tests).
import fs from 'node:fs';
import path from 'node:path';

const LOCK_STALE_MS = 10_000;
const LOCK_TIMEOUT_MS = 4_000;

function sleep(ms) { return new Promise((resolve) => setTimeout(resolve, ms)); }

export function ensurePrivateDir(dir) {
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  const st = fs.statSync(dir);
  if (process.platform !== 'win32' && (st.mode & 0o777) !== 0o700) fs.chmodSync(dir, 0o700);
  return dir;
}

async function withLock(dir, fn) {
  const lockPath = path.join(dir, 'claims.lock');
  const started = Date.now();
  for (;;) {
    try {
      const fd = fs.openSync(lockPath, 'wx', 0o600);
      try {
        fs.writeSync(fd, String(process.pid));
        return await fn();
      } finally {
        fs.closeSync(fd);
        try { fs.unlinkSync(lockPath); } catch { /* already gone */ }
      }
    } catch (err) {
      if (err.code !== 'EEXIST') throw err;
      try {
        const st = fs.statSync(lockPath);
        if (Date.now() - st.mtimeMs > LOCK_STALE_MS) { fs.unlinkSync(lockPath); continue; }
      } catch { /* raced away */ }
      if (Date.now() - started > LOCK_TIMEOUT_MS) throw new Error('claims_lock_timeout');
      await sleep(20);
    }
  }
}

export class ClaimStore {
  constructor(stateDir, { now = Date.now } = {}) {
    this.dir = ensurePrivateDir(stateDir);
    this.path = path.join(this.dir, 'claims.json');
    this.now = now;
  }

  empty() { return { version: 1, claims: [], tasks: [] }; }

  readUnlocked() {
    try {
      const raw = fs.readFileSync(this.path, 'utf8');
      if (raw.length > 4 * 1024 * 1024) throw new Error('claims_store_oversized');
      const doc = JSON.parse(raw);
      if (!doc || doc.version !== 1 || !Array.isArray(doc.claims) || !Array.isArray(doc.tasks)) {
        throw new Error('claims_store_invalid');
      }
      return doc;
    } catch (err) {
      if (err.code === 'ENOENT') return this.empty();
      throw err;
    }
  }

  read() { return this.readUnlocked(); }

  writeUnlocked(doc) {
    const tmp = path.join(this.dir, `claims.json.${process.pid}.${Date.now()}.tmp`);
    fs.writeFileSync(tmp, JSON.stringify(doc), { mode: 0o600 });
    fs.renameSync(tmp, this.path);
  }

  async mutate(fn) {
    return withLock(this.dir, async () => {
      const doc = this.readUnlocked();
      const result = await fn(doc);
      this.writeUnlocked(doc);
      return result;
    });
  }
}
