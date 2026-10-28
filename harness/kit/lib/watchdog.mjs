// watchdog.mjs — V3.2 §12-17: separate FREE read-only Watchdog AI.
//
// READ-ONLY with respect to orchestration: it NEVER starts/stops/resumes a
// run, kills processes, spawns workers, edits target code or orchestration
// source, touches state.json / pool.json, changes routing, invokes premium
// reasoning, or alters verdicts. Its job: observe, detect, summarize, report.
//
// Sources: run.log, status-alpha.md, state.json, pool.json, engine-state.json,
// engine-usage.jsonl, coordinator lock (via lib/coordinator-status.mjs).
// NOTE: the Watchdog does NOT use the browser (workers have one) — its sources
// remain logs/state/telemetry; never spend browser calls on heartbeat/status work.
// Incremental: per-source byte offsets + hashes persisted in
// runs/<RUN_ID>/watchdog-state.json (Watchdog-owned, NOT canonical state).
//
// Free-only AI summarizer (registry.watchdog). AI is optional: when no
// approved free model is available, WATCHDOG_AI=UNAVAILABLE and the
// deterministic event detection + heartbeat continue unchanged. No paid
// fallback, no Freebucks.
import { readFileSync, writeFileSync, renameSync, existsSync, statSync } from "node:fs";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { coordinatorStatus, COORDINATOR_STATES } from "./coordinator-status.mjs";
import { recordInvocation, initTelemetry } from "./invocation-telemetry.mjs";
import { callFreeRole } from "./free-role-router.mjs"; // V3.3 §2.5: chain-walking free caller

const SEVERITY = Object.freeze({ OK: "OK", INFO: "INFO", WARNING: "WARNING", BLOCKER: "BLOCKER" });

// Per-source incremental reader: returns only the NEW bytes since offset.
function readIncremental(path, offset) {
  try {
    const size = statSync(path).size;
    if (size <= offset) return { text: "", offset }; // no growth (or truncated reset handled by caller)
    const fd = readFileSync(path);
    const text = fd.slice(offset).toString("utf8");
    return { text, offset: size };
  } catch {
    return { text: "", offset };
  }
}

// Load/save Watchdog-owned cursor state (per run).
function wdStateFile(runsDir, runId) {
  return join(runsDir, runId, "watchdog-state.json");
}
export function loadWatchdogState(runsDir, runId) {
  try { return JSON.parse(readFileSync(wdStateFile(runsDir, runId), "utf8")); }
  catch { return { offsets: {}, heartbeats: 0, aiCalls: 0, lastEventTs: null, lastHeartbeatTs: null }; }
}
function saveWatchdogState(runsDir, runId, st) {
  try {
    const tmp = wdStateFile(runsDir, runId) + ".tmp-" + process.pid;
    writeFileSync(tmp, JSON.stringify(st, null, 2));
    renameSync(tmp, wdStateFile(runsDir, runId));
  } catch { /* best-effort */ }
}

// Deterministic event detection over NEW log bytes + full cheap state files.
// Returns [{ severity, event, detail }] — pure function of inputs, no AI.
export function detectEvents(runsDir, runId, prev, current) {
  const events = [];
  const state = current.state ?? {};
  const prevState = prev.state ?? {};

  // Coordinator transitions (from the previous cycle's stored view)
  if (prev.coordinatorState && current.coordinatorState !== prev.coordinatorState) {
    if (current.coordinatorState === COORDINATOR_STATES.RUNNING && prev.coordinatorState !== COORDINATOR_STATES.RUNNING) {
      events.push({ severity: SEVERITY.INFO, event: "coordinator_started", detail: `pid ${current.coordinatorPid}` });
    } else if (prev.coordinatorState === COORDINATOR_STATES.RUNNING && current.coordinatorState !== COORDINATOR_STATES.RUNNING) {
      events.push({ severity: SEVERITY.BLOCKER, event: "coordinator_died", detail: `was pid ${prev.coordinatorPid}, now ${current.coordinatorState}` });
    } else if (current.coordinatorState === COORDINATOR_STATES.STALE_LOCK) {
      events.push({ severity: SEVERITY.WARNING, event: "stale_coordinator_lock", detail: current.coordinatorDetail ?? "" });
    } else if (current.coordinatorState === COORDINATOR_STATES.MULTIPLE) {
      events.push({ severity: SEVERITY.BLOCKER, event: "multiple_coordinators", detail: current.coordinatorDetail ?? "" });
    }
  }

  // Phase transitions
  if (prevState.currentPhase !== state.currentPhase && state.currentPhase != null) {
    events.push({ severity: SEVERITY.INFO, event: "phase_started", detail: `phase ${state.currentPhase}` });
  }
  if ((prevState.completedThrough ?? 0) < (state.completedThrough ?? 0)) {
    events.push({ severity: SEVERITY.INFO, event: "phase_completed", detail: `completed through ${state.completedThrough}` });
  }
  const terminalStates = ["COMPLETED", "COMPLETED_UNREVIEWED", "REMEDIATION_EXHAUSTED", "ABORTED"];
  if (prevState.runState !== state.runState && terminalStates.includes(state.runState)) {
    events.push({ severity: state.runState === "REMEDIATION_EXHAUSTED" ? SEVERITY.WARNING : SEVERITY.INFO, event: "run_completed", detail: `final state ${state.runState}` });
  }

  // Worker changes (pool.json)
  if (prev.workers && current.workers) {
    for (const [wid, w] of Object.entries(current.workers)) {
      const before = prev.workers[wid];
      if (!before && w.alive) events.push({ severity: SEVERITY.INFO, event: "worker_started", detail: wid });
      if (before?.alive && !w.alive) events.push({ severity: SEVERITY.WARNING, event: "worker_thread_disappeared", detail: wid });
      if (before && before.alive && w.alive && before.lastRunId !== w.lastRunId) {
        events.push({ severity: SEVERITY.INFO, event: "worker_reused", detail: `${wid} now on ${w.lastRunId}` });
      }
    }
  }

  // New log lines: scan for notable patterns (cheap, deterministic)
  for (const line of (current.newLogLines ?? [])) {
    const l = line.toLowerCase();
    if (l.includes("review phase") && l.includes("approved")) events.push({ severity: SEVERITY.INFO, event: "review_passed", detail: line.slice(0, 120) });
    else if (l.includes("review phase") && (l.includes("needs_work") || l.includes("needs work"))) events.push({ severity: SEVERITY.WARNING, event: "review_failed", detail: line.slice(0, 120) });
    else if (l.includes("nudged")) events.push({ severity: SEVERITY.WARNING, event: "worker_stalled_nudged", detail: line.slice(0, 120) });
    else if (l.includes("remediation")) events.push({ severity: SEVERITY.WARNING, event: "remediation_started", detail: line.slice(0, 120) });
    else if (l.includes("selftest") && l.includes("fail")) events.push({ severity: SEVERITY.WARNING, event: "test_failure", detail: line.slice(0, 120) });
    else if (l.includes("quota") || l.includes("at capacity") || l.includes("overloaded")) events.push({ severity: SEVERITY.WARNING, event: "capacity_or_quota_failure", detail: line.slice(0, 120) });
    else if (l.includes("premium") && (l.includes("unexpected") || l.includes("flag was absent"))) events.push({ severity: SEVERITY.BLOCKER, event: "unexpected_premium_usage", detail: line.slice(0, 120) });
    else if (l.includes("claude") && (l.includes("attempt") || l.includes("called")) && !l.includes("disabled") && !l.includes("off")) events.push({ severity: SEVERITY.BLOCKER, event: "claude_attempt", detail: line.slice(0, 120) });
  }

  // Usage deltas (engine-usage.jsonl)
  for (const u of (current.newUsageEvents ?? [])) {
    if (u.paid) events.push({ severity: SEVERITY.WARNING, event: "premium_call", detail: `${u.engine} for ${u.purpose ?? "?"} (rc=${u.rc})` });
    // V3.3 §22: Sol calls are SANCTIONED (chain-head reasoning authority) —
    // INFO with token accounting, not a WARNING like unexpected premium use.
    if (u.engine === "openai-sol" && u.success) events.push({ severity: SEVERITY.INFO, event: "sol_call", detail: `${u.purpose ?? "?"} tokens in=${u.inputTokens ?? "?"} out=${u.outputTokens ?? "?"}${u.reasoningTokens != null ? ` reasoning=${u.reasoningTokens}` : ""} (openai_api)` });
    if (u.visionUsed) events.push({ severity: SEVERITY.INFO, event: "vision_call", detail: `${u.engine} success=${u.success}` });
    if (u.engine === "claude") events.push({ severity: SEVERITY.BLOCKER, event: "claude_attempt", detail: "claude invocation in ledger" });
  }

  return events;
}

// One watchdog cycle: incremental read -> detect -> (optional AI summary) ->
// append operator-feed.log. Returns { events, aiSummary, heartbeat }.
export function watchdogCycle(runsDir, runId, { currentRunId = null, sshHost = "controller", heartbeatEverySec = 120, useAI = true } = {}) {
  initTelemetry(runsDir); // V3.3 §2.1: bind ledger to the caller's runsDir
  const wd = loadWatchdogState(runsDir, runId);
  const runDir = join(runsDir, runId);

  // --- gather (read-only) ---
  let state = null;
  try { state = JSON.parse(readFileSync(join(runDir, "state.json"), "utf8")); } catch { state = null; }
  const log = readIncremental(join(runDir, "run.log"), wd.offsets?.runLog ?? 0);
  const notepad = readIncremental(join(runDir, "status-alpha.md"), wd.offsets?.notepad ?? 0);
  let pool = {};
  try { pool = JSON.parse(readFileSync(join(runsDir, "pool.json"), "utf8")); } catch { pool = {}; }
  const workers = {};
  for (const [wid, w] of Object.entries(pool)) {
    workers[wid] = { alive: !!(w.threadId && (Date.now() - (w.spawnedAt ?? 0)) < 55 * 60_000), lastRunId: w.lastRunId ?? null };
  }
  const cs = coordinatorStatus(runsDir);
  const usage = readIncremental(join(runsDir, "engine-usage.jsonl"), wd.offsets?.usage ?? 0);
  const newUsageEvents = usage.text.split("\n").filter(Boolean)
    .map((l) => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean);

  const current = {
    state, workers,
    coordinatorState: cs.state, coordinatorPid: cs.pid, coordinatorDetail: cs.detail,
    newLogLines: log.text.split("\n").filter((l) => l.trim()),
    newUsageEvents,
  };
  const prev = { state: wd.lastState, workers: wd.lastWorkers, coordinatorState: wd.coordinatorState, coordinatorPid: wd.coordinatorPid, newLogLines: [], newUsageEvents: [] };

  // --- detect ---
  const events = detectEvents(runsDir, runId, prev, current);

  // --- persist cursors ---
  wd.offsets = { ...(wd.offsets ?? {}), runLog: log.offset, notepad: notepad.offset, usage: usage.offset };
  wd.lastState = state ? { currentPhase: state.currentPhase, completedThrough: state.completedThrough, runState: state.runState } : null;
  wd.lastWorkers = workers;
  wd.coordinatorState = cs.state;
  wd.coordinatorPid = cs.pid;

  // --- heartbeat policy (§16): significant events immediately; otherwise a
  // deterministic heartbeat at most every heartbeatEverySec, with NO AI call
  // when nothing material changed.
  const now = Date.now();
  const lastHb = wd.lastHeartbeatTs ?? 0;
  const material = events.length > 0;
  const hbDue = now - lastHb >= heartbeatEverySec * 1000;
  let aiSummary = null;
  if (material && useAI) {
    // V3.3 §2.4/§2.5: use the shared free-role router. A summary counts as
    // successful only when rc==0 AND output has no provider rejection AND
    // usable text exists — callFreeRole enforces all three, walks the chain,
    // and records the real failure class on every attempt.
    const prompt = [
      "You are the read-only Watchdog AI for an orchestration run.",
      "Summarize the following detected events for the operator in <=3 short lines. No commands, no state changes, just the summary.",
      `Events: ${JSON.stringify(events.map((e) => ({ s: e.severity, e: e.event, d: e.detail })))}`,
      `Run: ${runId} phase=${state?.currentPhase} done=${state?.completedThrough} state=${state?.runState}`,
    ].join("\n");
    const r = callFreeRole("watchdog", prompt, {
      runsDir, runId, component: "watchdog", purpose: "summarize",
      sshHost, timeoutSec: 90, readOnly: true,
    });
    if (r.ok) {
      aiSummary = { model: r.model, text: r.output.slice(0, 400) };
      wd.aiCalls = (wd.aiCalls ?? 0) + 1;
    } else {
      const why = r.attempts?.length
        ? r.attempts.map((a) => a.skipped ? `${a.model}:cooldown` : `${a.model}:${a.failureClass}`).join(", ")
        : (r.reason ?? "no model");
      recordInvocation({ component: "watchdog", role: "WATCHDOG", purpose: "summarize", engine: "opencode", model: null, billingClass: "free", success: false, failureClass: r.failureClass, rc: 1, paid: false, durationMs: r.durationMs, note: why.slice(0, 200) });
      aiSummary = { model: null, text: `WATCHDOG_AI=UNAVAILABLE (${why}) — deterministic monitoring continues` };
    }
  }
  if (material || hbDue) {
    wd.heartbeats = (wd.heartbeats ?? 0) + 1;
    wd.lastHeartbeatTs = now;
  }

  // --- operator feed (§15) ---
  const ts = new Date().toISOString();
  const lines = [];
  if (material || hbDue) {
    lines.push(`[${ts}] WATCHDOG v3.2 — run=${runId} phase=${state?.currentPhase ?? "?"} done=${state?.completedThrough ?? "?"} state=${state?.runState ?? "?"}`);
    lines.push(`  coordinator: ${cs.state}${cs.pid ? ` pid=${cs.pid}` : ""}`);
    const live = Object.entries(workers).filter(([, w]) => w.alive);
    lines.push(`  workers: ${live.length ? live.map(([id]) => id).join(",") : "none live"} | heartbeats=${wd.heartbeats} aiCalls=${wd.aiCalls ?? 0}`);
    for (const e of events) lines.push(`  [${e.severity}] ${e.event}: ${e.detail}`);
    if (aiSummary?.text) lines.push(`  AI: ${aiSummary.text.replace(/\n+/g, " | ")}`);
    if (!material && hbDue) lines.push("  (deterministic heartbeat — nothing material changed)");
  }
  if (lines.length) {
    try {
      const { appendFileSync, mkdirSync } = require("node:fs");
      mkdirSync(runDir, { recursive: true });
      appendFileSync(join(runDir, "operator-feed.log"), lines.join("\n") + "\n");
    } catch { /* read-only-ish: feed is best-effort */ }
  }
  saveWatchdogState(runsDir, runId, wd);
  return { events, aiSummary, heartbeat: material || hbDue, coordinator: cs };
}
