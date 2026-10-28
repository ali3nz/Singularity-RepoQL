#!/usr/bin/env bun
// heartbeat-child.mjs — V3.3.2 (2026-09-19, operator directive: "an update
// every 2 minutes"). The coordinator spends most of a run blocked inside
// spawnSync() during gate/worker-turn calls — a setInterval IN-PROCESS would
// never fire exactly then. So the heartbeat is an INDEPENDENT child process:
//
//   spawn:  bun lib/heartbeat-child.mjs <runDir> [intervalSec]
//   output: <runDir>/heartbeat.log  (JSONL, one beat per tick)
//   stop:   SIGTERM (coordinator stop), or self-exit on terminal runState
//           (one final beat is written first — by design), or when the
//           coordinator lock names a dead pid (crash orphan cleanup).
//
// A pidfile lock (<runDir>/heartbeat.lock) guarantees a single writer across
// resume flows. Pure local-FS reads only: state.json, status-*.md, NOTEPAD.md,
// the telemetry ledger, the coordinator lock — no network, no API.
import { readFileSync, writeFileSync, appendFileSync, existsSync, rmSync } from "node:fs";
import { join, basename } from "node:path";

const runDir = process.argv[2];
const intervalSec = Math.max(15, parseInt(process.argv[3] ?? "120", 10) || 120);
if (!runDir || !existsSync(runDir)) { console.error("heartbeat: runDir missing"); process.exit(2); }
const RUNS = join(runDir, "..");
const LOG = join(runDir, "heartbeat.log");
const LOCK = join(runDir, "heartbeat.lock");

// ---- single-writer lock (wx + stale-pid takeover, mirrors the kit pattern) ----
function tryLock() {
  try { writeFileSync(LOCK, String(process.pid), { flag: "wx" }); return true; } catch (e) {
    if ((e ?? {}).code !== "EEXIST") return true;
    let stale = true;
    try {
      const old = parseInt(readFileSync(LOCK, "utf8").trim(), 10);
      stale = !Number.isInteger(old) || old === process.pid || !existsSync(`/proc/${old}/cmdline`);
    } catch { stale = true; }
    if (!stale) return false;
    try { rmSync(LOCK, { force: true }); } catch { /* */ }
    try { writeFileSync(LOCK, String(process.pid), { flag: "wx" }); return true; } catch { return false; }
  }
}

if (!tryLock()) process.exit(0); // another heartbeat owns this run — exit silently
process.on("SIGTERM", () => { try { rmSync(LOCK, { force: true }); } catch {} process.exit(0); });
process.on("exit", () => { try { if (readFileSync(LOCK, "utf8").trim() === String(process.pid)) rmSync(LOCK, { force: true }); } catch { /* */ } });

const TERMINAL = new Set(["COMPLETED", "COMPLETED_UNREVIEWED", "NEEDS_HUMAN_REVIEW", "REMEDIATION_EXHAUSTED"]);
const runId = basename(runDir);
let missedState = 0;

function statusWord(id) {
  try {
    const first = readFileSync(join(runDir, `status-${id}.md`), "utf8").split("\n")[0] ?? "";
    return (first.match(/^#\s*Status:\s*(\w+)/i)?.[1] ?? "unknown").toLowerCase();
  } catch { return "missing"; }
}

function lastLedgerRow() {
  try {
    const lines = readFileSync(join(RUNS, "engine-usage.jsonl"), "utf8").trim().split("\n");
    for (let i = lines.length - 1; i >= 0 && i >= lines.length - 5; i--) {
      try {
        const d = JSON.parse(lines[i]);
        if (d.engine) return { ts: d.timestamp, engine: d.engine, purpose: d.purpose ?? d.stage ?? null, rc: d.rc };
      } catch { /* skip malformed */ }
    }
  } catch { /* */ }
  return null;
}

function notepadTail() {
  try {
    const lines = readFileSync(join(runDir, "NOTEPAD.md"), "utf8").split("\n").filter((l) => l.trim());
    return (lines[lines.length - 1] ?? "").slice(0, 140);
  } catch { return null; }
}

function coordinatorDead() {
  // Ticket 189 K2: concurrent runs register in runs/ACTIVE/<runId> (pid of THEIR
  // coordinator). A registered run whose pid is gone is dead; unregistered runs
  // fall through to the legacy single-lock check.
  try {
    const rec = JSON.parse(readFileSync(join(RUNS, "ACTIVE", runId), "utf8"));
    if (Number.isInteger(rec?.pid) && rec.pid > 1) return !existsSync(`/proc/${rec.pid}/cmdline`);
  } catch { /* no registry entry — legacy check below */ }
  try {
    const pid = parseInt(readFileSync(join(RUNS, "COORDINATOR.lock"), "utf8").trim(), 10);
    return Number.isInteger(pid) && !existsSync(`/proc/${pid}/cmdline`);
  } catch { return false; } // no lock: keep beating (resume flow re-creates it)
}

function beat() {
  let st = null;
  try { st = JSON.parse(readFileSync(join(runDir, "state.json"), "utf8")); } catch { st = null; }
  if (!st) {
    if (++missedState >= 10) process.exit(0); // state gone for 10 ticks: orphan, stop
    return;
  }
  missedState = 0;
  const workers = {};
  for (const w of st.workers ?? []) workers[w] = statusWord(w);
  let poolAlive = 0;
  try {
    const pool = JSON.parse(readFileSync(join(RUNS, "pool.json"), "utf8"));
    const reuse = 55; // cfg.sessionReuseMinutes; approximate — only for the live count
    for (const e of Object.values(pool)) if (e?.threadId && Date.now() - e.spawnedAt < reuse * 60_000) poolAlive++;
  } catch { /* */ }
  const row = {
    ts: new Date().toISOString(), runId, intervalSec,
    runState: st.runState ?? "RUNNING",
    phase: st.currentPhase ?? null,
    completedThrough: st.completedThrough ?? 0,
    totalPhases: (st.plan?.phases ?? []).length || null,
    workers, poolAlive,
    lastEngine: lastLedgerRow(),
    notepad: notepadTail(),
  };
  try { appendFileSync(LOG, JSON.stringify(row) + "\n"); } catch { /* never crash on IO */ }
  if (TERMINAL.has(row.runState)) process.exit(0); // final beat written — clean exit
}

beat(); // first beat immediately (the operator sees life within a second of start)
const timer = setInterval(beat, intervalSec * 1000);
// Crash-orphan sweep: also check on every tick via beat(); add a light interval guard
setInterval(() => { if (coordinatorDead()) { try { rmSync(LOCK, { force: true }); } catch {} process.exit(0); } }, intervalSec * 1000);
timer.unref?.();
