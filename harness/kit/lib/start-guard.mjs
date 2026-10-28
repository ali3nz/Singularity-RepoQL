// start-guard.mjs — V3.3.19 (incident 033, 2026-09-21): deterministic
// circuit breakers so an external agent session (or anything else) can never
// again spawn-storm controller into a hard wedge.
//
// Incident 033 recap: an OpenChamber orchestrator session looped
// `ai-orchestra start` / `stop --yes` / `pkill -f orchestrate.mjs` /
// COORDINATOR.lock deletion over SSH while the nanny auto-resumed the zombie
// run it kept killing — load 16.7, 5,027 processes, 28% iowait, host died
// (Proxmox had to SIGKILL VM 100). Every guard here is FAIL-CLOSED and
// DETERMINISTIC: no model calls, no judgement, just thresholds.
//
// Guards (all bypassable ONLY by the explicit operator flag --force-start):
//   G1 START_BURST  — >2 start attempts in a rolling 30-min window
//   G2 START_GAP    — two start attempts <90 s apart (rapid-fire loop)
//   G3 OVERLOAD     — host 1-min load >8 or process count >4800 at spawn time
//                     (read from /proc/loadavg, which is host-wide inside the
//                     freebuff container; field 4 also carries running/total)
//   G4 STALE_RUN    — a non-terminal run whose run.log is >60 min old is a
//                     zombie; refuse new starts until it is reset/resumed
//   G5 RUN_ACTIVE   — one run at a time: refuse a new start while ANY
//                     non-terminal run exists (fresh ones included)
//   G6 LIVE_COORD   — a live `orchestrate.mjs start|resume` process exists
//                     (lock deleted out from under it) -> never double-spawn
import { readFileSync, writeFileSync, existsSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";

export const START_GUARD_LIMITS = Object.freeze({
  MAX_STARTS_PER_WINDOW: 2,        // G1
  WINDOW_MS: 30 * 60 * 1000,       // G1 rolling window
  MIN_GAP_MS: 90 * 1000,           // G2
  MAX_LOAD1: 8.0,                  // G3 (6-core box; incident saw 16.7)
  MAX_PROCS: 4800,                 // G3 (baseline ~3500-4500; incident saw 5027)
  STALE_RUN_MINUTES: 60,           // G4 (nanny auto-resume uses the same line)
  HISTORY_KEEP_MS: 6 * 60 * 60 * 1000, // attempts file pruning
});

// ---------------- host load (host-wide even inside the container) ----------------
export function readHostLoad({ procLoadavgPath = "/proc/loadavg", readFile = (p) => readFileSync(p, "utf8") } = {}) {
  try {
    const parts = readFile(procLoadavgPath).trim().split(/\s+/);
    const load1 = Number(parts[0]);
    const total = Number(String(parts[3] ?? "").split("/")[1]);
    return {
      load1: Number.isFinite(load1) ? load1 : null,
      procs: Number.isFinite(total) ? total : null,
    };
  } catch {
    return { load1: null, procs: null }; // probe unavailable -> G3 silently skips
  }
}

// ---------------- G6: live coordinator scan (container /proc) ----------------
// Returns the pid of another live `orchestrate.mjs start|resume` process, or
// null. listPids is injectable for tests. Never matches `nanny`/`status`/etc.
export function findLiveCoordinator(opts = {}) { return findLiveCoordinators(opts)[0] ?? null; }

// Ticket 189 K3: every OTHER live `orchestrate.mjs start|resume` process (array).
export function findLiveCoordinators({ selfPid = process.pid, listPids = null, readCmdline = (pid) => { try { return readFileSync(`/proc/${pid}/cmdline`, "utf8").replace(/\0/g, " "); } catch { return ""; } }, readPpid = (pid) => { try { const s = readFileSync(`/proc/${pid}/stat`, "utf8"); return Number(s.slice(s.lastIndexOf(")") + 2).split(" ")[1]) || 0; } catch { return 0; } } } = {}) {
  let pids = listPids;
  if (!pids) {
    try { pids = readdirSync("/proc").filter((d) => /^\d+$/.test(d)).map(Number); } catch { return []; }
  }
  // Ancestor exclusion (2026-09-27 canary false-positive): a start wrapped in
  // `timeout N bun orchestrate.mjs start` carries the SAME start-pattern in
  // the wrapper's cmdline — the wrapper is an ANCESTOR of this very process,
  // so excluding the selfPid's ancestor chain makes G6 self-match-proof
  // without weakening detection of genuine OTHER coordinators.
  const ancestors = new Set();
  for (let cur = selfPid, i = 0; i < 16 && cur > 1; i++) { const p = readPpid(cur); if (!p) break; ancestors.add(p); cur = p; }
  const found = [];
  for (const pid of pids) {
    if (pid === selfPid || ancestors.has(pid)) continue;
    const cmd = readCmdline(pid);
    if (/bun\s+.*orchestrate\.mjs\s+(start|resume)\b/.test(cmd)) found.push(pid);
  }
  return found;
}

// ---------------- G4/G5: non-terminal run scan ----------------
// stale run = oldest-relevant non-terminal run with a run.log older than
// maxStaleMinutes (or no run.log at all). Returns { runId, runState,
// logAgeMinutes, stale } for the FIRST non-terminal run found (ids are ISO
// timestamps, so lexicographic sort = newest first), or null.
export function findBlockingRun(runsDir, { now = Date.now(), maxStaleMinutes = START_GUARD_LIMITS.STALE_RUN_MINUTES, listDir = (d) => readdirSync(d), stat = (p) => statSync(p), exists = (p) => existsSync(p) } = {}) {
  let dirs = [];
  try {
    dirs = listDir(runsDir)
      .filter((d) => /^2026-/.test(d) && exists(join(runsDir, d, "state.json")))
      .sort()
      .reverse();
  } catch { return null; }
  for (const id of dirs) {
    try {
      const st = JSON.parse(readFileSync(join(runsDir, id, "state.json"), "utf8"));
      if (!["RUNNING", "PLANNED", "REMEDIATION_EXHAUSTED", "NEEDS_HUMAN_REVIEW"].includes(st.runState)) continue;
      let logAgeMinutes = null;
      try { logAgeMinutes = Math.round((now - stat(join(runsDir, id, "run.log")).mtimeMs) / 60000); } catch { logAgeMinutes = Infinity; }
      return { runId: id, runState: st.runState ?? "?", logAgeMinutes, stale: logAgeMinutes == null ? false : logAgeMinutes >= maxStaleMinutes };
    } catch { continue; }
  }
  return null;
}

// Ticket 189 K3: ALL non-terminal runs (newest first), each with its stale flag.
export function findBlockingRuns(runsDir, { now = Date.now(), maxStaleMinutes = START_GUARD_LIMITS.STALE_RUN_MINUTES, listDir = (d) => readdirSync(d), stat = (p) => statSync(p), exists = (p) => existsSync(p) } = {}) {
  let dirs = [];
  try {
    dirs = listDir(runsDir).filter((d) => /^2026-/.test(d) && exists(join(runsDir, d, "state.json"))).sort().reverse();
  } catch { return []; }
  const out = [];
  for (const id of dirs) {
    try {
      const st = JSON.parse(readFileSync(join(runsDir, id, "state.json"), "utf8"));
      if (!["RUNNING", "PLANNED", "REMEDIATION_EXHAUSTED", "NEEDS_HUMAN_REVIEW"].includes(st.runState)) continue;
      let logAgeMinutes = null;
      try { logAgeMinutes = Math.round((now - stat(join(runsDir, id, "run.log")).mtimeMs) / 60000); } catch { logAgeMinutes = Infinity; }
      out.push({ runId: id, runState: st.runState ?? "?", logAgeMinutes, stale: logAgeMinutes == null ? false : logAgeMinutes >= maxStaleMinutes });
    } catch { continue; }
  }
  return out;
}

// ---------------- history (runs/start-guard.json) ----------------
const historyPath = (runsDir) => join(runsDir, "start-guard.json");
export function loadStartHistory(runsDir, { readFile = readFileSync } = {}) {
  try {
    const j = JSON.parse(readFile(historyPath(runsDir), "utf8"));
    return Array.isArray(j.attempts) ? j.attempts : [];
  } catch { return []; }
}
export function recordStartAttempt(runsDir, { now = Date.now(), ok, reason = null, write = writeFileSync } = {}) {
  const attempts = loadStartHistory(runsDir)
    .filter((a) => now - a.at < START_GUARD_LIMITS.HISTORY_KEEP_MS)
    .concat([{ at: now, ok: !!ok, reason }]);
  try { write(historyPath(runsDir), JSON.stringify({ attempts }, null, 1) + "\n"); } catch { /* never fatal */ }
  return attempts;
}

// ---------------- the pure decision ----------------
export function evaluateStartGuard({ now = Date.now(), history = [], load1 = null, procs = null, blockingRun = null, blockingRuns = null, maxRuns = 1, limits = START_GUARD_LIMITS } = {}) {
  const reasons = [];
  const recent = history.filter((a) => now - a.at < limits.WINDOW_MS);
  if (recent.length >= limits.MAX_STARTS_PER_WINDOW) {
    reasons.push({ code: "START_BURST", msg: `${recent.length} start attempts in the last ${Math.round(limits.WINDOW_MS / 60000)} min (max ${limits.MAX_STARTS_PER_WINDOW}) — cooldown active; observe with 'status'/'updates' instead of retrying` });
  }
  const last = history.map((a) => a.at).sort((a, b) => b - a)[0];
  if (last != null && now - last < limits.MIN_GAP_MS) {
    reasons.push({ code: "START_GAP", msg: `last start attempt ${Math.round((now - last) / 1000)} s ago (min gap ${Math.round(limits.MIN_GAP_MS / 1000)} s) — NEVER loop start/stop/pkill (incident 033 wedged the host exactly this way)` });
  }
  if (load1 != null && load1 > limits.MAX_LOAD1) {
    reasons.push({ code: "OVERLOAD", msg: `host 1-min load ${load1} > ${limits.MAX_LOAD1} — refusing to spawn while the box is saturating` });
  }
  if (procs != null && procs > limits.MAX_PROCS) {
    reasons.push({ code: "OVERLOAD", msg: `host process count ${procs} > ${limits.MAX_PROCS} — refusing to spawn while the box is process-exploding` });
  }
  if (Array.isArray(blockingRuns)) {
    // Ticket 189 K3: zombies still refuse; fresh runs refuse only at >= maxRuns.
    const stale = blockingRuns.find((r) => r.stale);
    const fresh = blockingRuns.filter((r) => !r.stale);
    if (stale) reasons.push({ code: "STALE_RUN", msg: `run ${stale.runId} is ${stale.runState} with run.log ${stale.logAgeMinutes === Infinity ? "missing" : `${stale.logAgeMinutes} min`} old — zombie; clear it with 'reset --yes --run ${stale.runId}' (or 'resume --go' if genuinely alive) before starting anything new` });
    if (fresh.length >= maxRuns) reasons.push({ code: "RUN_ACTIVE", msg: `${fresh.length} run(s) already active (${fresh.map((r) => r.runId).join(", ")}) — max ${maxRuns} concurrent; 'status' to inspect, 'stop --run <id>'/'resume --go'/'reset --yes --run <id>' to clear` });
  } else if (blockingRun) {
    if (blockingRun.stale) {
      reasons.push({ code: "STALE_RUN", msg: `run ${blockingRun.runId} is ${blockingRun.runState} with run.log ${blockingRun.logAgeMinutes === Infinity ? "missing" : `${blockingRun.logAgeMinutes} min`} old — zombie; clear it with 'reset --yes' (or 'resume --go' if genuinely alive) before starting anything new` });
    } else {
      reasons.push({ code: "RUN_ACTIVE", msg: `run ${blockingRun.runId} is ${blockingRun.runState} (log fresh) — one run at a time; 'status' to inspect, 'stop'/'resume --go'/'reset --yes' to clear` });
    }
  }
  return { ok: reasons.length === 0, reasons };
}
