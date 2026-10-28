// lib/run-registry.mjs — V3.4.0 Phase 1 (ticket 088, plan §7 / D09-D11).
// Global permanent run identity: ONE append-only ledger shared by
// orchestrations and consults, first new run = Run 001, numbers never reused.
//
// Authority (plan §4.1, §7.1): the LEDGER is authoritative for number
// allocation and alias mapping ONLY — never for case phase. case.json remains
// the workflow authority; the registry holds alias/title/thread metadata.
//
// Storage: the ledger lives at <stateDir>/run-ledger.jsonl (stateDir defaults
// to <kit>/runs/state, a new persistent location under the existing runs tree).
// One JSON event per line. Allocation = exclusive mkdir lock + max(runNumber)+1
// + append + fsync before the lock is released (plan §7.2).
//
// Torn-tail invariant (Sol sign-off round 1, item 3, amendment A3): a malformed
// trailing record means the append was interrupted — allocation enters the
// typed BLOCKED state and REFUSES to hand out numbers until a human repairs or
// explicitly truncates. A torn record is never silently skipped and never
// silently recomputed from max(): a crash-mid-append means we CANNOT know
// whether the torn record carried the next number. Truncating the tail loses
// at most one reserved number (gap), which the plan prefers over duplicates.
// Repair tool: repairTornTail() truncates the torn line and appends an
// explicit ledger_repaired record (auditable, never silent).
import { mkdirSync, readFileSync, writeFileSync, openSync, writeSync, fsyncSync, closeSync, existsSync, rmSync, renameSync } from "node:fs";
import { join } from "node:path";

export const LEDGER_SCHEMA = 1;
const LOCK_TIMEOUT_MS = 10_000;

export class RunRegistryError extends Error {
  constructor(code, message) { super(message); this.name = "RunRegistryError"; this.code = code; }
}

function regErr(code, msg) { return new RunRegistryError(code, msg); }

// ---------- atomic exclusive lock (same idiom as case-store.mjs) ----------
function lockStale(lockDir) {
  // TRUE only when a lock dir exists with an owner file proving a DEAD owner
  // or an expired lease. A missing owner file = someone is mid-handshake
  // (mkdir won, owner write pending) — that is NOT stale, retry instead.
  let owner;
  try { owner = JSON.parse(readFileSync(join(lockDir, "owner"), "utf8")); }
  catch { return false; } // absent/unreadable owner = handshake in flight
  const age = Date.now() - (owner.at ?? 0);
  const pidAlive = owner.pid === process.pid || existsSync(`/proc/${owner.pid}`);
  return !pidAlive || age > 120_000;
}

export function withRegistryLock(stateDir, fn) {
  const lockDir = join(stateDir, "registry.lock");
  mkdirSync(stateDir, { recursive: true });
  const deadline = Date.now() + LOCK_TIMEOUT_MS;
  for (;;) {
    try {
      mkdirSync(lockDir); // EEXIST if held
      writeFileSync(join(lockDir, "owner"), JSON.stringify({ pid: process.pid, at: Date.now() }));
      break;
    } catch (e) {
      if (e?.code !== "EEXIST") throw e;
      if (Date.now() > deadline) throw regErr("LOCK_TIMEOUT", `registry lock held >${LOCK_TIMEOUT_MS}ms`);
      if (lockStale(lockDir)) {
        // Steal only if the owner file is UNCHANGED between the staleness
        // check and the rmdir — closes the check-then-act race where a live
        // holder recreated the lock between our read and our remove.
        let before = null;
        try { before = readFileSync(join(lockDir, "owner"), "utf8"); } catch { before = null; }
        const spin = Date.now() + 3;
        while (Date.now() < spin) { /* tiny settle delay */ }
        let after = null;
        try { after = readFileSync(join(lockDir, "owner"), "utf8"); } catch { after = null; }
        if (before === after) { try { rmSync(lockDir, { recursive: true, force: true }); } catch { /* raced */ } }
        continue;
      }
      const spin = Date.now() + 25 + Math.floor(Math.random() * 25);
      while (Date.now() < spin) { /* bounded spin */ }
      continue;
    }
  }
  try { return fn(); }
  finally { try { rmSync(lockDir, { recursive: true, force: true }); } catch { /* next writer steals */ } }
}

// fsync'd append (plan §7.2: "Append and fsync the allocation record before
// releasing the lock")
function appendFsync(line) {
  const fd = openSync(line.path, "a");
  try { writeSync(fd, line.data); fsyncSync(fd); } finally { closeSync(fd); }
}

// ---------- ledger reading ----------
// Returns { events, tornTail: null | { line, lineno, error } }.
// A malformed record ANYWHERE treats the whole ledger as torn (data integrity
// over availability): only a clean prefix is trusted.
export function readLedger(ledgerPath) {
  let raw = "";
  try { raw = readFileSync(ledgerPath, "utf8"); } catch (e) {
    if (e?.code === "ENOENT") return { events: [], tornTail: null };
    throw e;
  }
  const events = [];
  const lines = raw.split("\n");
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (line === "" && i === lines.length - 1) continue; // trailing newline
    let ev;
    try { ev = JSON.parse(line); } catch (e) {
      return { events, tornTail: { line, lineno: i + 1, error: String(e?.message ?? e) } };
    }
    if (!ev || typeof ev !== "object" || typeof ev.event !== "string") {
      return { events, tornTail: { line, lineno: i + 1, error: "record missing event field" } };
    }
    events.push(ev);
  }
  return { events, tornTail: null };
}

// Typed BLOCKED state (plan amendment A3): torn tail -> allocation refuses
// until repairTornTail() or a human fixes the file. Never skip, never recompute.
export function allocationBlocked(ledgerPath) {
  const { tornTail } = readLedger(ledgerPath);
  return tornTail ? { blocked: true, ...tornTail } : { blocked: false };
}

export function repairTornTail(ledgerPath, { actor = "operator" } = {}) {
  return withRegistryLock(dirnameOf(ledgerPath), () => {
    const { tornTail } = readLedger(ledgerPath);
    if (!tornTail) return { repaired: false, reason: "no torn tail" };
    const kept = readLedger(ledgerPath).events; // clean prefix
    const tmp = ledgerPath + ".repair-tmp";
    const body = kept.map((e) => JSON.stringify(e)).join("\n") + (kept.length ? "\n" : "");
    writeFileSync(tmp, body);
    const fd = openSync(tmp, "r+");
    try { fsyncSync(fd); } finally { closeSync(fd); }
    // rename over, then append the explicit repair record
    renameSync(tmp, ledgerPath);
    appendFsync({ path: ledgerPath, data: JSON.stringify({
      schema: LEDGER_SCHEMA, event: "ledger_repaired", actor,
      at: new Date().toISOString(),
      removedLine: (tornTail.line ?? "").slice(0, 200),
      removedLineno: tornTail.lineno,
    }) + "\n" });
    return { repaired: true, removedLineno: tornTail.lineno, removedLine: tornTail.line };
  });
}
function dirnameOf(p) { const i = p.lastIndexOf("/"); return i > 0 ? p.slice(0, i) : "."; }

// ---------- allocation ----------
// Validates + normalizes a title; consults get the "Consult | " prefix here so
// every naming surface (Discord thread, summary, observer) agrees (D11).
export function buildRunTitle({ runType, title }) {
  const clean = String(title ?? "").replace(/[`*_~|]/g, "").replace(/\s+/g, " ").trim().slice(0, 80);
  const base = clean || (runType === "consult" ? "consult session" : "orchestration run");
  return runType === "consult" ? `Consult | ${base}`.slice(0, 100) : base.slice(0, 100);
}

export function allocateRunNumber(stateDir, { runType, caseId, title, issueNumber = null, now = new Date() } = {}) {
  if (runType !== "orchestration" && runType !== "consult") {
    throw regErr("BAD_RUN_TYPE", `runType must be orchestration|consult, got ${runType}`);
  }
  if (!caseId || typeof caseId !== "string") throw regErr("BAD_CASE_ID", "caseId required");
  const ledgerPath = join(stateDir, "run-ledger.jsonl");
  return withRegistryLock(stateDir, () => {
    // Re-check torn state INSIDE the lock (another process may have appended).
    const blocked = allocationBlocked(ledgerPath);
    if (blocked.blocked) {
      throw regErr("LEDGER_TORN", `run ledger torn at line ${blocked.lineno}: ${blocked.error} — allocation BLOCKED (repair with repairTornTail or fix the file; a torn append may have consumed the next number)`);
    }
    const { events } = readLedger(ledgerPath);
    const allocated = new Set(events.filter((e) => e.event === "run_allocated").map((e) => e.runNumber));
    let next = 1;
    while (allocated.has(next)) next++; // first gap = never-reuse even after crash (§7.2)
    const runNumber = next;
    const rec = {
      schema: LEDGER_SCHEMA, event: "run_allocated", runNumber, caseId,
      runType, title: buildRunTitle({ runType, title }),
      // 2026-09-27: the hub issue this run belongs to, when the brief names one.
      // null (never absent) so a consumer can tell "no issue" from "old record".
      issueNumber: issueNumber == null ? null : Number(issueNumber),
      createdAt: now.toISOString(),
    };
    appendFsync({ path: ledgerPath, data: JSON.stringify(rec) + "\n" });
    return rec;
  });
}

// ---------- projections + lookup ----------
// Derived index — rebuildable from the ledger at any time (plan §7.3). A
// projection rebuild NEVER repairs the ledger; torn state still blocks lookup
// of records after the tear.
export function buildRunIndex(stateDir) {
  const ledgerPath = join(stateDir, "run-ledger.jsonl");
  const { events, tornTail } = readLedger(ledgerPath);
  if (tornTail) throw regErr("LEDGER_TORN", `ledger torn at line ${tornTail.lineno} — index refused (projection must never mask a torn tail)`);
  const byNumber = {};
  for (const e of events) {
    if (e.event === "run_allocated") {
      byNumber[e.runNumber] = { caseId: e.caseId, type: e.runType, title: e.title, status: "ACTIVE", discordThreadId: null, runType: e.runType };
    } else if (e.event === "discord_thread_bound" && byNumber[e.runNumber]) {
      byNumber[e.runNumber].discordThreadId = e.threadId ?? null;
    } else if (e.event === "run_completed" || e.event === "run_failed" || e.event === "run_stopped") {
      if (byNumber[e.runNumber]) byNumber[e.runNumber].status = e.event === "run_completed" ? "COMPLETED" : (e.event === "run_failed" ? "FAILED" : "STOPPED");
    } else if (e.event === "run_paused") {
      if (byNumber[e.runNumber]) byNumber[e.runNumber].status = "PAUSED";
    }
  }
  return byNumber;
}

// Human reference resolution (plan §7.4): "Run 42" / "run 42" / "#42" / "42".
export function parseRunRef(text) {
  const m = String(text ?? "").trim().match(/^(?:run\s*|run:|#)(\d{1,6})$/i) ?? String(text ?? "").trim().match(/^(\d{1,6})$/);
  return m ? { runNumber: parseInt(m[1], 10) } : null;
}

export function resolveRunRef(stateDir, text) {
  const ref = parseRunRef(text);
  if (!ref) return null;
  const idx = buildRunIndex(stateDir);
  const hit = idx[ref.runNumber];
  if (!hit) return null;
  return { runNumber: ref.runNumber, caseId: hit.caseId, title: hit.title, status: hit.status, runType: hit.type, discordThreadId: hit.discordThreadId };
}

// Zero-padded DISPLAY form only (D09/§7.5: canonical number stays integer).
export function displayRunNumber(n) { return `Run ${String(n).padStart(3, "0")}`; }

// ---------- issue numbers + the canonical Discord thread-title contract ----------
// 2026-09-27 (operator): "Run #number ... and the issue number as well ... if it's
// a run and issue. Then the subject." The hub issue number is the fleet's other
// permanent identifier (documentation/issues/NNN-slug.md), so a thread that
// belongs to an issue carries BOTH.
// 2026-10-04 (ticket 275; Sol Run 373 CONTRADICTED, Run 375 CONFIRMED): extraction
// is ownership-scoped, not first-match. The first textual "issue N" anywhere in
// a brief is often background context (Run 367 was tagged Ticket 111 via
// "restored per ticket 111" inside a RepoQL-262 brief; Run 373 was tagged 161
// from a passing mention and filed into the old Issue-161 thread). Only a
// LEADING ownership declaration counts — after common framing punctuation
// (markdown headings, quotes, list markers) — so "Ticket 262 ...",
// "Ticket 77 ...", "issue-131 follow-up" and "for ticket 262 ..." own their
// number, while mid-text mentions and bare numbers ("RepoQL 262", "port 8300",
// "run 45") yield null and the Issue segment is omitted.
const OWNERSHIP_RE = /^\s*(?:for\s+)?(?:issues?|tickets?)\s*[#:_-]?\s*(\d{1,4})\b/i;

export function extractIssueNumber(text) {
  const s = String(text ?? "").replace(/^[\s#>"'(\[]+/, "");
  const m = OWNERSHIP_RE.exec(s);
  if (!m) return null;
  const n = Number(m[1]);
  return Number.isInteger(n) && n > 0 && n < 10000 ? n : null;
}

export function displayIssueNumber(n) { return `Issue ${String(n).padStart(3, "0")}`; }

// THE canonical thread title. Every surface (kit consult watcher, orchestrate
// run open, the Python bridge) renders through this one contract so a thread
// can never flap between two formats again:
//   "Run NNN | Issue MMM | <topic> — <suffix>"
// Issue segment omitted when the work has no hub issue; suffix omitted when
// empty. Truncation eats the TOPIC only — the identifiers always survive.
export function buildThreadTitle({ runNumber = null, issueNumber = null, topic = "", suffix = "", max = 100 } = {}) {
  const ids = [];
  if (runNumber != null) ids.push(displayRunNumber(runNumber));
  if (issueNumber != null) ids.push(displayIssueNumber(issueNumber));
  const prefix = ids.length ? ids.join(" | ") + " | " : "";
  const tail = String(suffix ?? "").replace(/[`*_~|]/g, "").trim();
  // Leading markdown headings ("# DUO CONSULT - ...") are brief boilerplate,
  // not a topic; strip the markup so the subject itself leads.
  let t = String(topic ?? "").replace(/[`*_~|#]/g, "").replace(/\s+/g, " ").trim();
  const fixed = prefix.length + (tail ? tail.length + 3 : 0);
  const room = max - fixed;
  if (t && t.length > room) t = room > 12 ? t.slice(0, room - 1).trimEnd() + "\u2026" : "";
  if (!t) return (prefix + tail).slice(0, max) || (prefix ? prefix.replace(/\s*\|\s*$/, "") : "orchestration run");
  return `${prefix}${t}${tail ? " \u2014 " + tail : ""}`.slice(0, max);
}

// Display-only label WITHOUT the "Run" prefix (for templates that add their own prefix).
export function displayRunNo(n) { return String(n).padStart(3, "0"); }

// ---------- metadata events (title change D11 / thread binding) ----------
export function recordEvent(stateDir, ev) {
  const ledgerPath = join(stateDir, "run-ledger.jsonl");
  return withRegistryLock(stateDir, () => {
    const blocked = allocationBlocked(ledgerPath);
    if (blocked.blocked) throw regErr("LEDGER_TORN", `ledger torn at line ${blocked.lineno} — metadata events refused until repair`);
    const { events } = readLedger(ledgerPath);
    const known = events.some((e) => e.event === "run_allocated" && e.runNumber === ev.runNumber);
    if (!known) throw regErr("UNKNOWN_RUN", `runNumber ${ev.runNumber} not allocated — refusing to record ${ev.event}`);
    appendFsync({ path: ledgerPath, data: JSON.stringify(ev) + "\n" });
    return true;
  });
}
