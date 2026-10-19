import { closeSync, existsSync, fsyncSync, mkdirSync, openSync, readFileSync, renameSync, rmdirSync, statSync, unlinkSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";

/**
 * Durable monthly Cohere attempt ledger, byte-compatible with the in-process L1
 * ledger (MemoryCore/src/core/record/l1-cohere-quota.ts).
 *
 * Cross-process safety: the L1 chain runs inside the
 * MemoryCore container while the L2/L3 router runs in a separate container, and
 * both share this file. A lock directory (`<file>.lock` via mkdir) serialises the
 * read-modify-write so two processes cannot reserve the same slot. mkdir is
 * atomic on POSIX and works across containers on a shared volume.
 */
const LOCK_TIMEOUT_MS = 2000;
const LOCK_STALE_MS = 10000;
const retrySleep = new Int32Array(new SharedArrayBuffer(4));

function sleepMs(ms) {
  Atomics.wait(retrySleep, 0, 0, ms);
}

function acquireLock(lockPath) {
  const started = Date.now();
  for (;;) {
    try {
      mkdirSync(lockPath);
      return true;
    } catch (error) {
      if (error?.code !== "EEXIST") throw error;
      // Break a lock left behind by a crashed process.
      try {
        const age = Date.now() - statSync(lockPath).mtimeMs;
        if (age > LOCK_STALE_MS) { try { rmdirSync(lockPath); } catch {} continue; }
      } catch { /* lock vanished; retry */ }
      if (Date.now() - started > LOCK_TIMEOUT_MS) return false;
      sleepMs(10);
    }
  }
}

function releaseLock(lockPath) {
  try { rmdirSync(lockPath); } catch { /* already gone */ }
}

export function cohereQuota({ file, monthlyCap = 800, reserve = 200, now = Date.now() }) {
  const limit = monthlyCap - reserve;
  if (limit <= 0) return { allowed: false, reason: "cap-reserve-not-positive", attempts: 0, limit };
  try {
    mkdirSync(dirname(file), { recursive: true });
  } catch {
    return { allowed: false, reason: "unwritable-ledger", attempts: 0, limit };
  }
  const lockPath = `${file}.lock`;

  if (!acquireLock(lockPath)) {
    return { allowed: false, reason: "ledger-locked", attempts: 0, limit };
  }
  try {
    const month = new Date(now).toISOString().slice(0, 7);
    const empty = { month, attempts: 0, updated_at: new Date(0).toISOString() };
    let state = empty;
    if (existsSync(file)) {
      try {
        const parsed = JSON.parse(readFileSync(file, "utf8"));
        if (typeof parsed.month !== "string" || !Number.isFinite(parsed.attempts) || parsed.attempts < 0) {
          return { allowed: false, reason: "malformed-ledger", attempts: 0, limit };
        }
        state = parsed.month === month
          ? { month, attempts: Math.floor(parsed.attempts), updated_at: String(parsed.updated_at ?? "") }
          : empty;
      } catch {
        return { allowed: false, reason: "unreadable-ledger", attempts: 0, limit };
      }
    }
    if (state.attempts >= limit) return { allowed: false, reason: "routine-limit-reached", attempts: state.attempts, limit };

    const next = { month, attempts: state.attempts + 1, updated_at: new Date(now).toISOString() };
    const tmp = `${file}.tmp`;
    let fd;
    try {
      fd = openSync(tmp, "wx", 0o600);
      writeFileSync(fd, JSON.stringify(next), "utf8");
      fsyncSync(fd); closeSync(fd); fd = undefined;
      renameSync(tmp, file);
      const dirFd = openSync(dirname(file), "r");
      try { fsyncSync(dirFd); } finally { closeSync(dirFd); }
    } catch {
      return { allowed: false, reason: "unwritable-ledger", attempts: state.attempts, limit };
    } finally {
      if (fd !== undefined) closeSync(fd);
      try { unlinkSync(tmp); } catch { /* renamed */ }
    }
    return { allowed: true, attempts: next.attempts, limit };
  } finally {
    releaseLock(lockPath);
  }
}
