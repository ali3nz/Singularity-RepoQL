// session-watch.mjs — V3.3.29 (ticket 041, Sol turn-5 verdict, consult session
// 2026-09-22T11-07-40): VISIBILITY AND EARLY WARNING for prepaid session
// lifetimes. NOT a recovery controller — Sol: "Its value is visibility and
// early warning. The highest-risk mistake would be automatically nudging or
// restarting consult work just because a transcript has been quiet."
//
// Runs inside the EXISTING nanny cycle (no new timer, no new authority):
//   ordering: session-watch (observation phase) -> standdown -> sweeper ->
//   boot reconcile -> normal logic. During load-standdown (FROZEN) this
//   module still does clock math, local file reads, and DEDUPED alerts —
//   and nothing else (no vision, no ssh, no mutation, no recovery) — the
//   clean incident-033 boundary drawn by Sol turn 5.
//
// Semantics pinned by Sol's corrections:
//   - sessionReuseMinutes (55) is a POOL REUSE WINDOW deadline, NOT a proven
//     hard provider expiry. Alerts say "POOL REUSE WINDOW", never "expires".
//   - Salvage is ADVISORY ONLY: surface the exact command, never invoke it.
//   - pool.json is read-only here (the kit coordinator owns it).
//   - "transcript quiet" is NOT causality: a quiet transcript plus an ACTIVE
//     bridge = LONG_WAIT (legitimate; the gateway has 18-min extraction
//     windows). Only a dead/failed bridge signal classifies LIKELY_STALLED.
//
// V3.3.29: pool.json read-only, bridge-state.json read-only, dedupe state
// file read-write. see.mjs property (Sol item 7, PROVEN from source): vision
// classifies via the OPENROUTER endpoint (work/vision/see.mjs fetches
// https://openrouter.ai/api/v1/chat/completions) and only GETs the gateway's
// read-only /v1/screenshot.png — it never POSTs to the catgpt request path,
// never reads SOL_MIN_GAP state, never consumes a 429 cooldown slot. The
// vision SPAWN itself lives in the CALLER (cmdNanny), never in this module.
import { readFileSync, writeFileSync, existsSync, statSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { appendAlert } from "./nanny.mjs";
import { coordinatorStatus } from "./coordinator-status.mjs"; // ticket 189: slot-aware liveness

export const SESSION_WATCH_VERSION = "V3.3.29";
const STATE_FILE = "session-watch.json";
// Thresholds (Sol item 5: conservative; a 20-min quiet transcript is NOT a
// failure). Env overrides are for tests only — prod never weaker.
export const WARN_REUSE_MIN = Number(process.env.SESSION_WATCH_WARN_MIN ?? 15);
export const CONSULT_LONG_WAIT_MIN = Number(process.env.SESSION_WATCH_LONGWAIT_MIN ?? 20);
export const CLASSIFY_GAP_MIN = Number(process.env.SESSION_WATCH_CLASSIFY_GAP_MIN ?? 15);

function loadDedupe(runsDir) {
  try { return JSON.parse(readFileSync(join(runsDir, STATE_FILE), "utf8")); }
  catch { return { sessions: {}, consults: {} }; }
}
function saveDedupe(runsDir, st) {
  try { writeFileSync(join(runsDir, STATE_FILE), JSON.stringify(st, null, 1)); }
  catch { /* fail-closed: worst case a repeated alert */ }
}

// ---- pool reuse-window clocks (read-only) ---------------------------------
// Returns advisory events for pooled worker sessions approaching/past the
// reuse deadline. Deduped per worker per threshold via the state file so the
// 5-min nanny cycle never repeats an alert.
export function poolClockEvents(runsDir, { now = Date.now(), reuseMinutes = 55, dedupe = null, platform = process.platform } = {}) {
  const events = [];
  let pool = {};
  try { pool = JSON.parse(readFileSync(join(runsDir, "pool.json"), "utf8")) ?? {}; } catch { return { events, st: dedupe ?? { sessions: {}, consults: {} } }; }
  let st = dedupe ?? { sessions: {}, consults: {} };
  let current = "";
  try { current = readFileSync(join(runsDir, "CURRENT"), "utf8").trim(); } catch { /* none */ }
  // A Windows /proc miss is not evidence that another coordinator is idle.
  // Advisory salvage must only be suggested when an authoritative platform
  // check can say the coordinator is absent.
  let coordRunning = process.platform !== "linux" || platform !== "linux";
  try {
    const lockPid = parseInt(readFileSync(join(runsDir, current ?? "", "COORDINATOR.lock"), "utf8").trim(), 10);
    if (process.platform === "linux" && platform === "linux") coordRunning = Number.isInteger(lockPid) && existsSync(`/proc/${lockPid}`);
  } catch { /* unknown ownership stays non-idle on native Windows */ }
  // Ticket 189: with concurrent runs "a coordinator is running" means ANY live
  // slot/registry holder — pooled sessions are not idle while either run works.
  try { if (!coordRunning && coordinatorStatus(runsDir, { platform }).state === "RUNNING") coordRunning = true; } catch { /* keep legacy answer */ }

  for (const [workerId, e] of Object.entries(pool)) {
    if (!e || typeof e.spawnedAt !== "number") continue;
    const deadline = e.spawnedAt + reuseMinutes * 60_000;
    const remainingMin = Math.round((deadline - now) / 60_000);
    const sess = (st.sessions[workerId] ??= {});
    if (remainingMin > 0 && remainingMin <= WARN_REUSE_MIN && !sess.warned15) {
      sess.warned15 = now;
      events.push({
        severity: "warn", event: "session-reuse-warn",
        detail: `worker ${workerId}: POOL REUSE WINDOW T-${remainingMin}min (spawned ${new Date(e.spawnedAt).toISOString()}, lastRun ${e.lastRunId ?? "?"}) — finish or checkpoint work in that thread; salvage --reuse can still spend the window`,
      });
    }
    if (remainingMin <= 0 && !sess.expired) {
      sess.expired = now;
      events.push({
        severity: "info", event: "session-reuse-expired-unused",
        detail: `worker ${workerId}: POOL REUSE WINDOW closed (was ~${reuseMinutes}min). Prepaid window gone — record for the freebudget metric; no action taken.`,
      });
    }
    // Advisory salvage surface: reusable time left, no coordinator owner.
    // Sol item 3: advisory ONLY — print the command, never invoke it.
    if (remainingMin > 0 && !coordRunning && !sess.salvageSurfaced) {
      sess.salvageSurfaced = now;
      events.push({
        severity: "info", event: "salvage-available",
        detail: `worker ${workerId} has ~${remainingMin}min reuse window left and no coordinator owner — advisory: bun orchestrate.mjs salvage --reuse "<task>" (NOT invoked automatically)`,
      });
    }
  }
  return { events, st };
}

// ---- consult lifecycle classification (Sol items 4+5) ---------------------
// Reads the deterministic bridge-state file cmdConsult persists per turn:
//   { consultId, startedAt, state: "active"|"done"|"failed", rc, completedAt }
// Classification (Sol: fixture-testable, quiet != failed):
//   quiet + bridge active                 -> LONG_WAIT  (legitimate)
//   quiet + bridge dead/failed (2nd signal) -> LIKELY_STALLED
//   quiet + bridge deadline exceeded      -> TIMEOUT
export function classifyConsult(dir, { now = Date.now(), bridgeTimeoutSec = 5400, lockHeld = true } = {}) {
  if (!lockHeld || !existsSync(dir)) return null;
  let mtimeMs = 0, turns = 0;
  try { mtimeMs = Math.max(mtimeMs, statSync(join(dir, "transcript.md")).mtimeMs); } catch { /* optional */ }
  try { mtimeMs = Math.max(mtimeMs, statSync(join(dir, "NOTEPAD.md")).mtimeMs); } catch { /* optional */ }
  if (!mtimeMs) return null;
  const quietMin = Math.round((now - mtimeMs) / 60_000);
  if (quietMin < CONSULT_LONG_WAIT_MIN) return null;
  let bs = null;
  try { bs = JSON.parse(readFileSync(join(dir, "bridge-state.json"), "utf8")); } catch { bs = null; }
  const ambiguous = !bs || bs.state === "active";
  const base = { quietMin, event: "consult-long-wait", severity: "info", visionAsk: ambiguous };
  if (ambiguous) {
    const activeMin = bs?.startedAt ? Math.round((now - bs.startedAt) / 60_000) : null;
    if (activeMin != null && activeMin * 60_000 > bridgeTimeoutSec * 1000) {
      return { ...base, event: "consult-bridge-timeout", severity: "warn",
        detail: `consult ${dir.split("/").at(-1)}: transcript quiet ${quietMin}min AND bridge call ${activeMin}min > deadline ${Math.round(bridgeTimeoutSec / 60)}min — bridge-state says active but the deadline passed (advisory only)` };
    }
    return { ...base,
      detail: `consult ${dir.split("/").at(-1)}: no transcript progress for ${quietMin}min while the lock is held, bridge call${activeMin != null ? ` ACTIVE ${activeMin}min` : " state UNKNOWN (pre-V3.3.29 consult?)"} — LONG_WAIT, not failed (gateway extraction can take 18+min). Advisory only.` };
  }
  // bridge dead or failed: the SECOND signal that upgrades quiet -> stalled.
  if (bs.state === "failed" || bs.state === "dead") {
    return { quietMin, event: "consult-likely-stalled", severity: "warn",
      detail: `consult ${dir.split("/").at(-1)}: transcript quiet ${quietMin}min AND bridge-state=${bs.state} (rc=${bs.rc ?? "?"} at ${bs.completedAt ? new Date(bs.completedAt).toISOString() : "?"}) — LIKELY_STALLED. Advisory: the driving agent should re-check or re-brief; no auto action.` };
  }
  return base;
}

// ---- per-cycle entry (called from nannyCycle BEFORE the standdown return) --
// FROZEN cycles still get clock math + deduped alerts (Sol item 1's ordering
// requirement). The caller may pass `visionHook` — an injected async fn for
// the ambiguous LONG_WAIT case (Sol item 5: one read-only classify, then ≥15
// min gap). The hook is CALLER-owned; this module never spawns. The caller
// (cmdNanny) refuses to provide the hook when FROZEN (Sol item 6).
export async function sessionWatchCycle(runsDir, { now = Date.now(), reuseMinutes = 55, apply = true, frozen = false, bridgeTimeoutSec = 5400, visionHook = null } = {}) {
  const events = [];
  const st = loadDedupe(runsDir);
  try {
    const pool = poolClockEvents(runsDir, { now, reuseMinutes, dedupe: st });
    events.push(...pool.events);
  } catch (e) {
    events.push({ severity: "error", event: "session-watch-failed", detail: `pool clocks: ${String(e.message ?? e).slice(0, 120)}` });
  }
  // Consult classification: only the CURRENT consult, lock-held, and ONLY the
  // deterministic bridge-state signal. During FROZEN this still runs (local
  // reads + deduped alerts); vision is NEVER used here (Sol item 6).
  try {
    const cdir = join(runsDir, "consult");
    let current = "";
    try { current = readFileSync(join(cdir, "CURRENT"), "utf8").trim(); } catch { current = ""; }
    const lockHeld = existsSync(join(runsDir, "CONSULT.lock"));
    if (current && lockHeld) {
      const cls = classifyConsult(join(cdir, current), { now, bridgeTimeoutSec, lockHeld: true });
      if (cls) {
        const key = `${current}:${cls.event}`;
        const last = st.consults[key] ?? 0;
        const gapMs = CLASSIFY_GAP_MIN * 60_000;
        if (now - last >= gapMs) {
          st.consults[key] = now;
          events.push({ severity: cls.severity, event: cls.event, detail: cls.detail });
          // Sol item 5: on an AMBIGUOUS long wait (bridge state unknown or
          // "active"), ONE read-only vision classify — but never during a
          // FROZEN cycle (caller passes no hook then). Gap enforced by the
          // same dedupe entry as the alert itself.
          if (cls.visionAsk && !frozen && typeof visionHook === "function") {
            try {
              const v = await visionHook(current);
              if (v) events.push({ severity: "info", event: "session-watch-vision", detail: `gateway classify for consult ${current}: ${String(v).slice(0, 80)} (read-only screenshot path; openrouter-side model)` });
            } catch (e) {
              events.push({ severity: "info", event: "session-watch-vision-failed", detail: String(e.message ?? e).slice(0, 100) });
            }
          }
        }
      }
    }
  } catch (e) {
    events.push({ severity: "error", event: "session-watch-failed", detail: `consult classify: ${String(e.message ?? e).slice(0, 120)}` });
  }
  if (apply) saveDedupe(runsDir, st);
  if (frozen && events.length) {
    events.push({ severity: "info", event: "session-watch-frozen-note", detail: "FROZEN cycle: session-watch emitted clock/alert events only (no vision, no ssh, no mutation) per the incident-033 boundary" });
  }
  // Durable operator alerts (nanny-alerts.jsonl) for warn+ events.
  if (apply) {
    for (const e of events) {
      if (e.severity === "warn" || e.severity === "error") {
        try { appendAlert(runsDir, e.severity, `session-watch: ${e.event}: ${e.detail}`); } catch { /* non-fatal */ }
      }
    }
  }
  return { events, version: SESSION_WATCH_VERSION };
}
