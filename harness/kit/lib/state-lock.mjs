// state-lock.mjs — V3.5.4 (ticket 188, review NEEDS_FIX fixPlan step 1). The
// smallest cross-process serialization primitive for the WP-A JSON state
// stores (runs/resource-leases.json, runs/deployment-intents.json).
//
// Defect (delta Phase 3 review, MEDIUM — VERIFIED REAL by alpha): the stores'
// load → in-memory mutate → save(temp-file + renameSync) sequences are not
// mutually exclusive across processes. Atomic rename protects one replacement
// write, not the whole read-modify-write transaction, so two processes can
// read the same prior state and independently commit incompatible successor
// states (lost updates, double acquisition of one resource, duplicated
// generations).
//
// Fix shape: an advisory MUTEX around each RMW transaction — the classic
// mkdir/lockfile exclusive-create protocol from SQLite and Debian apt:
//   1. try mkdir(L): atomic across processes on POSIX (EEXIST = taken)
//   2. write owner metadata (pid, proc-starttime, case, time)
//   3. run the read-modify-write transaction inside the directory
//   4. rmdir(L) — idempotent cleanup
// A stale lock (owner pid provably dead / zombie — same 4-factor discipline
// as the lease liveness checks: readable-but-EMPTY /proc/<pid>/cmdline means
// ZOMBIE, and zombies hold nothing) may be stolen after graceMs; a LIVE owner
// is never stolen from. If the lock cannot be taken within the budget the
// caller receives a TYPED timeout failure and NOTHING was mutated — fail
// closed, matching every other WP-A refusal.
//
// Deliberately OUT of scope: worker leases (INVARIANT A), reason codes, force
// semantics, the deployGate kill switch, all record shapes — those are
// untouched. This module adds only the serialization layer.
//
// Single-process re-entrancy: a process holding the mutex may call back into
// withStateLockSync on the SAME lock path. The owner record's pid + proc
// starttime make re-entrancy detectable; a re-entrant acquire runs without a
// second owner record and the OUTERMOST withStateLockSync performs the single
// real release.

import { mkdirSync, rmSync, writeFileSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";

// Same liveness discipline as resource-lease.mjs: /proc/<pid>/cmdline
// readable AND non-empty => alive; unreadable (gone) or empty (zombie) =>
// provably not running.
function pidAlive(pid) {
  try { return readFileSync(`/proc/${pid}/cmdline`, "utf8").length > 0; } catch { return false; }
}

function procStart(pid) {
  try {
    const stat = readFileSync(`/proc/${pid}/stat`, "utf8");
    const afterExec = stat.slice(stat.lastIndexOf(")") + 2);
    return Number(afterExec.split(" ")[19]);
  } catch { return null; }
}

function lockPaths(lockPath) {
  return {
    dir: lockPath,
    owner: join(lockPath, "owner.json"),
  };
}

// Try to grab the lock directory with mkdir exclusivity. Returns true on
// success, false when it already exists.
function tryMkdir(lockPath) {
  try { mkdirSync(lockPath, { recursive: false }); return true; } catch { return false; }
}

// Read and classify an existing lock: live / stale / malformed.
function classifyHolder(lockPath) {
  let raw;
  try { raw = readFileSync(lockPaths(lockPath).owner, "utf8"); } catch { return "malformed"; }
  let rec;
  try { rec = JSON.parse(raw); } catch { return "malformed"; }
  if (typeof rec?.pid !== "number" || typeof rec.startTime !== "number" || !Number.isFinite(rec.startTime)) return "malformed";
  // Re-entrant call from this same process requires an exact PID + starttime
  // match; missing starttime is never treated as ownership proof.
  if (rec.pid === process.pid) {
    const selfStart = procStart(process.pid);
    if (selfStart != null && rec.startTime === selfStart) return "self";
  }
  if (!pidAlive(rec.pid)) return "stale";
  if (procStart(rec.pid) !== rec.startTime) return "stale"; // pid reused by a new process
  return "live";
}

function stealStale(lockPath) {
  rmSync(lockPath, { recursive: true, force: true });
}

function reapStaleLock(lockPath, { graceMs, now }) {
  // Serialize stale-lock cleanup itself. Without this sibling guard, two
  // contenders can both observe one dead owner; the later rmSync could delete
  // the first contender's newly acquired live lock.
  const reaperPath = `${lockPath}.reap`;
  if (!tryMkdir(reaperPath)) return false;
  try {
    // A malformed owner is NOT proof of death (it may be a creator paused
    // between mkdir and owner.json). It fails closed rather than being stolen.
    if (classifyHolder(lockPath) !== "stale") return false;
    let ageMs = 0;
    try { ageMs = Math.max(0, now() - statSync(lockPath).mtimeMs); } catch { return false; }
    if (ageMs <= graceMs) return false;
    stealStale(lockPath);
    return true;
  } finally {
    rmSync(reaperPath, { recursive: true, force: true });
  }
}

// Acquire the mutex. Returns { ok:true, depth } or { ok:false, reason }.
export function acquireStateLock(lockPath, { timeoutMs = 10_000, pollMs = 5, graceMs = 30_000, now = Date.now } = {}) {
  const deadline = now() + timeoutMs;
  for (;;) {
    if (tryMkdir(lockPath)) {
      try {
        writeFileSync(lockPaths(lockPath).owner, JSON.stringify({
          pid: process.pid,
          startTime: procStart(process.pid),
          acquiredAt: new Date().toISOString(),
        }));
        return { ok: true };
      } catch {
        // Could not write the owner record (fs race or failure): release and
        // retry — never leave a record-less lock behind.
        rmSync(lockPath, { recursive: true, force: true });
      }
    }
    const cls = classifyHolder(lockPath);
    if (cls === "self") {
      // Re-entrant acquisition. Depth is tracked on the owner record via a
      // local module map (record rewrite would race with holders); allow it.
      return { ok: true, reentrant: true };
    }
    if (cls === "stale") {
      // A recorded dead owner may be reaped only after a grace period and
      // while holding the sibling reaper guard. Malformed locks are never
      // inferred dead; they time out fail-closed for operator inspection.
      let ageMs = 0;
      try { ageMs = Math.max(0, now() - statSync(lockPath).mtimeMs); } catch { ageMs = 0; }
      if (ageMs > graceMs && reapStaleLock(lockPath, { graceMs, now })) continue;
    }
    if (now() >= deadline) {
      return { ok: false, reason: "STATE_LOCK_TIMEOUT", holderClass: cls, lockPath };
    }
    // Busy-wait with a tiny sleep: the critical sections are sub-millisecond
    // JSON RMWs, so pollMs below the scheduler tick is plenty and keeps the
    // batteries deterministic.
    const end = now() + pollMs;
    while (now() < end) { /* bounded spin */ }
  }
}

export function releaseStateLock(lockPath) {
  let rec;
  try { rec = JSON.parse(readFileSync(lockPaths(lockPath).owner, "utf8")); } catch { rec = null; }
  // Never release a lock we do not own (pid + proc start match, or a
  // re-entrant holder whose owner record was consumed by a nested release).
  if (!rec) return { ok: false, reason: "owner-record-unreadable", lockPath };
  const owned = rec.pid === process.pid
    && typeof rec.startTime === "number"
    && rec.startTime === procStart(process.pid);
  if (!owned) return { ok: false, reason: "not-lock-owner", lockPath };
  rmSync(lockPath, { recursive: true, force: true });
  return { ok: true };
}

// Serialize a read-modify-write transaction under the mutex. fn receives
// nothing and must be SYNCHRONOUS (the RMW helpers are sync by design).
// On any failure path the lock is released and nothing partial escapes.
export function withStateLockSync(lockPath, fn, opts = {}) {
  const got = acquireStateLock(lockPath, opts);
  if (!got.ok) return got; // typed refusal; caller decides fail-closed shape
  let out;
  try {
    out = fn();
  } finally {
    // A re-entrant acquire did not create a new owner record; the outermost
    // withStateLockSync's finally performs the single real release.
    if (!got.reentrant) releaseStateLock(lockPath);
  }
  return { ok: true, value: out };
}

// Test helpers
export function _classifyHolderForTest(lockPath) { return classifyHolder(lockPath); }
export function _pidAliveForTest(pid) { return pidAlive(pid); }
