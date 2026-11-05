// case-store.mjs — V3.3.35 Phase 1 (ticket 085, plan D05/D06/D07).
// ONE supported case writer with per-case serialisation, monotonic revision
// and stale-writer reassessment; plus the authoritative ops journal for
// durable remote-operation intents. case.json remains THE authoritative case
// state; case.md is a projection (written after the authoritative rename).
//
// Serialisation: per-case advisory lock dir `case.lock` created O_EXCL under
// the case dir with an owner-pid + deadline; a crashed owner's lock is stolen
// after LOCK_STALE_MS (default 30s) or immediately when the pid is dead.
// CAS: writer supplies expectedRev (case.rev); commit re-reads the file and
// refuses (rc 'stale') when the on-disk rev differs — loser re-loads and
// reassesses instead of overwriting. No multi-file atomicity is claimed.
//
// Ops journal (D07): runs/<id>/ops.jsonl — append-only intents BEFORE any
// consequential remote effect (worker thread create, phase message post,
// consultant submit, report deliver). The actor rewrites the intent line to
// done|failed|unknown WITH remote ids/receipts after the effect; crash
// recovery reconciles observable remote state before any retry and keeps
// `unknown` when proof is unavailable. Journal is fail-closed for the actor:
// an intent that cannot be persisted blocks the consequential call.

import { openSync, writeSync, closeSync, mkdirSync, readFileSync, writeFileSync,
         renameSync, existsSync, rmSync, statSync, readdirSync } from "node:fs";
import { createHash } from "node:crypto";
import { join } from "node:path";

const LOCK_STALE_MS = 30_000;

// ---------- per-case advisory lock ----------
function tryLock(dir) {
  const lockPath = join(dir, "case.lock");
  try {
    mkdirSync(lockPath); // EEXIST if held
    writeFileSync(join(lockPath, "owner"), JSON.stringify({ pid: process.pid, at: Date.now() }));
    return true;
  } catch (e) {
    if ((e ?? {}).code !== "EEXIST") throw e;
    return false;
  }
}

function lockStale(dir) {
  const lockPath = join(dir, "case.lock");
  try {
    const owner = JSON.parse(readFileSync(join(lockPath, "owner"), "utf8"));
    if (!Number.isInteger(owner.pid) || owner.pid === process.pid) return true;
    try { readFileSync(`/proc/${owner.pid}/cmdline`); } catch { return true; } // dead pid
    return (Date.now() - (owner.at ?? 0)) > LOCK_STALE_MS;
  } catch { return true; } // unreadable owner = stale
}

export function withCaseLock(dir, fn, { attempts = 40, backoffMs = 50 } = {}) {
  for (let i = 0; i < attempts; i++) {
    if (tryLock(dir)) {
      try { return fn(); }
      finally { try { rmSync(join(dir, "case.lock"), { recursive: true, force: true }); } catch { /* next writer steals */ } }
    }
    if (lockStale(dir)) { try { rmSync(join(dir, "case.lock"), { recursive: true, force: true }); } catch { /* raced */ } continue; }
    const wait = backoffMs * Math.min(i + 1, 10); // linear backoff, capped
    const end = Date.now() + wait;
    while (Date.now() < end) { /* bounded spin */ }
  }
  return { ok: false, code: "LOCK_TIMEOUT" };
}

// ---------- monotonic-revision CAS writer ----------
// mutate(cs) returns the new case object (pure-ish). Commit re-reads the
// on-disk case and refuses when its rev differs from expectedRev — the caller
// gets { ok:false, code:"stale", case: fresh } and MUST reassess (re-read,
// re-decide, retry) rather than force.
export function writeCase(dir, expectedRev, mutate, { maxRetries = 3, render = null } = {}) {
  const caseJson = join(dir, "case.json");
  return withCaseLock(dir, () => {
    let fresh = null;
    try { fresh = JSON.parse(readFileSync(caseJson, "utf8")); } catch { fresh = null; }
    const diskRev = fresh?.rev ?? 0;
    if (expectedRev !== null && expectedRev !== diskRev) {
      return { ok: false, code: "stale", expectedRev, diskRev, case: fresh };
    }
    const next = mutate(fresh);
    if (!next || typeof next !== "object") return { ok: false, code: "bad-mutation" };
    next.rev = diskRev + 1; // monotonic — every supported write bumps rev
    next.revAt = new Date().toISOString();
    next.revWriter = process.pid;
    const tmp = caseJson + ".tmp-" + process.pid;
    writeFileSync(tmp, JSON.stringify(next, null, 2) + "\n");
    renameSync(tmp, caseJson); // atomic within the same directory
    // Projection after authority: case.md readers never see a newer md than json.
    try { if (render) writeFileSync(join(dir, "case.md"), render(next)); } catch { /* md projection is best-effort; json is authoritative */ }
    return { ok: true, case: next, rev: next.rev };
  });
}

// ---------- ops journal (D07) ----------
// journal: runs/<dir>/ops.jsonl — one JSON object per line.
// intent: { opId, op, caseId, phase?, requestDigest, state:"pending", at }
// completion rewrite: { ...intent, state:"done"|"failed"|"unknown",
//                       remoteId?, receipt?, errorClass?, completedAt }
export function opsJournalPath(dir) { return join(dir, "ops.jsonl"); }

export function journalIntent(dir, { opId, op, caseId = null, phase = null, requestDigest = null, meta = null }) {
  if (!opId || !op) throw new Error("journalIntent: opId and op are required");
  const line = JSON.stringify({ opId, op, caseId, phase, requestDigest, state: "pending", meta, at: new Date().toISOString() }) + "\n";
  // Fail-closed: the intent MUST be on disk (fsync) before the caller may
  // perform the consequential remote effect.
  const fd = openSync(opsJournalPath(dir), "a");
  try { writeSync(fd, line); } finally { closeSync(fd); }
  return { opId, state: "pending" };
}

export function journalComplete(dir, opId, { state, remoteId = null, receipt = null, errorClass = null } = {}) {
  if (!["done", "failed", "unknown"].includes(state)) throw new Error(`journalComplete: bad state ${state}`);
  const lines = readJournal(dir);
  let found = false;
  const out = lines.map((l) => {
    if (l.opId === opId && l.state === "pending") {
      found = true;
      return { ...l, state, remoteId, receipt, errorClass, completedAt: new Date().toISOString() };
    }
    return l;
  });
  if (!found) return false; // never fabricate a completion for an unknown op
  const body = out.map((o) => JSON.stringify(o) + "\n").join("");
  const tmp = opsJournalPath(dir) + ".tmp-" + process.pid;
  writeFileSync(tmp, body);
  renameSync(tmp, opsJournalPath(dir));
  return true;
}

export function readJournal(dir) {
  try {
    return readFileSync(opsJournalPath(dir), "utf8").split("\n").filter(Boolean).map((l) => {
      try { return JSON.parse(l); } catch { return { opId: "?", state: "corrupt-line", raw: l }; }
    });
  } catch { return []; }
}

// Pending intents = declared-but-never-resolved consequential effects.
// Crash recovery enumerates these; the actor reconciles OBSERVABLE remote
// state first, and keeps `unknown` where proof is unavailable (never blind
// resubmits).
export function pendingIntents(dir) {
  return readJournal(dir).filter((l) => l.state === "pending");
}

export function requestDigestOf(payload) {
  // deterministic digest of the exact request about to be sent
  return createHash("sha256").update(JSON.stringify(payload ?? null)).digest("hex");
}
