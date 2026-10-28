// nanny.mjs — V3.3.11 (operator order 2026-09-19): the always-on babysitter.
//
// "We shouldn't be having to babysit it" — this module IS the babysitter: a
// timer-driven FREE-chain supervisor that observes every orchestration run
// and takes the bounded, previously-human remediation actions automatically.
//
// MODEL DISCIPLINE (operator requirement; ticket 255, 2026-10-03): the
// supervisor/narrator roles run the Go-plan managed Muse first, with an
// automatic free failover chain for failure/rate-limit/out-of-credit windows:
//   opencode-go/muse-spark-1.3-contributor#xhigh (managed)
//     -> opencode/space-bunny-free
//     -> opencode/ling-3.1-flash-free
//     -> opencode/longcat-2.5-preview-free
// (V3.3.25: lightning REMOVED from the chain — operator hard-deny for
// (all FREE, 0 freebucks; lib/free-model-registry.mjs SUPERVISOR chain walks
// automatically on rate limits/failures. If every free engine is limited, the
// DETERMINISTIC checks below still run — AI judgement is advisory, never a
// prerequisite. NO paid engines, NO Sol, NO freebucks by design.)
//
// AUTONOMY BOUNDARY (fail-closed). The nanny may ONLY, per run:
//   1. RESUME (max 2/run): run state RUNNING but coordinator dead -> spawn the
//      proven detached `bun orchestrate.mjs resume --go`.
//   2. RE_DRIVE_HOLD (max 1/run): final acceptance HELD + staged deployed
//      evidence is STALE (V3.3.10 freshness check) -> same resume path; the
//      gate then re-judges fresh evidence instead of a human re-poking it.
//   3. ESCALATE (unlimited, never auto-fixed): worker stall, repeated holds,
//      caps reached, anything unrecognized -> alert file + MQTT via the
//      controller relay, so HA can notify the operator.
// The nanny NEVER: edits state.json, spawns/closes worker sessions, overrides
// verdicts, touches premium engines, or nags terminal (COMPLETED*) runs.
//
// Single-instance: O_EXCL pid lock (runs/NANNY.lock) refreshed every cycle;
// a lock older than STALE_LOCK_MINUTES is stolen (crashed daemon).
// Alerts: append-only runs/nanny-alerts.jsonl (one JSON per line); the
// controller orch-nanny-relay timer tails it into MQTT ha/orch_nanny/alert.
import { readFileSync, writeFileSync, existsSync, statSync, appendFileSync, openSync, closeSync, readdirSync, unlinkSync, copyFileSync } from "node:fs";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { coordinatorStatus } from "./coordinator-status.mjs";
import { stagedEvidenceFreshness } from "./evidence-pack.mjs";
import { taskTitle, composeNarrativeSync } from "./narrator.mjs";
import { readHostLoad } from "./start-guard.mjs"; // V3.3.19 incident-033 load standdown

export const NANNY_VERSION = "V3.3.29";
export const NANNY_LIMITS = Object.freeze({
  MAX_RESUMES_PER_RUN: 2,     // hard cap: coordinator-revive attempts per run
  MAX_HOLD_REDRIVES: 1,       // hard cap: held-acceptance re-drives per run
  MAX_TOTAL_ACTIONS: 4,       // hard cap: ALL actions combined per run
  COOLDOWN_MS: 30 * 60 * 1000,// per-run cooldown after ANY action
  STALE_LOCK_MINUTES: 10,     // NANNY.lock older than this = stolen
  // V3.3.19 (incident 033): host-overload standdown + zombie-resume refusal.
  // 2026-09-27 (claude, operator report "no 5-min updates"): these caps were
  // left behind by the 2026-09-26 loadguard recalibration (12.0 / 8000). The
  // nanny therefore stood down in the 8-12 load band that loadguard considers
  // perfectly healthy — ~40% of cycles in the 24h before the fix, and exactly
  // during the busy runs the operator most wants narrated. Keep them EQUAL to
  // LG_LOAD1_HIGH / PROCS_HIGH in /usr/local/bin/orch-loadguard.sh.
  MAX_LOAD1: 12.0,            // above this 1-min load: no actions, NO model calls
  MAX_PROCS: 8000,            // above this process count: same standdown
  MAX_STALE_RESUME_MINUTES: 60, // run.log quiet this long -> never auto-resume
});
const TERMINAL_STATES = new Set(["COMPLETED", "COMPLETED_UNREVIEWED", "COMPLETED_OPERATOR_ACCEPTED", "ABORTED"]);
// non-terminal states a coordinator may legitimately re-drive via `resume --go`
// (V3.3.12): PLANNED + REMEDIATION_EXHAUSTED + NEEDS_HUMAN_REVIEW included so a
// never-engaged or exhausted run is still actionable, not invisible.
const RESUMEABLE_STATES = new Set(["RUNNING", "PLANNED", "REMEDIATION_EXHAUSTED", "NEEDS_HUMAN_REVIEW"]);

// V3.3.28 (ticket 041, Sol FIX PLAN item 7 refinement): durable machine-readable
// operator intent. A plain flag file `runs/<id>/HALTED` makes an operator halt
// (e.g. issue-040 Kodak) visible to EVERY automatic path: observeRun never
// declares it actionable, the stale sweeper alerts instead of aborting, and
// boot reconciliation skips it. Removal is an explicit operator action only.
export function isHalted(runsDir, runId) {
  try { return existsSync(join(runsDir, runId, "HALTED")); } catch { return false; }
}
const log = (...a) => console.log(`[${new Date().toISOString()}] [nanny]`, ...a);

// ---------------- single-instance lock ----------------
export function acquireNannyLock(runsDir, { now = Date.now() } = {}) {
  const p = join(runsDir, "NANNY.lock");
  try {
    const body = JSON.parse(readFileSync(p, "utf8"));
    if (body.pid && existsSync(`/proc/${body.pid}`)) {
      const cmd = readFileSync(`/proc/${body.pid}/cmdline`, "utf8").replace(/\0/g, " ");
      if (cmd.includes("orchestrate.mjs") && cmd.includes("nanny")) return { ok: false, holder: body.pid };
      // pid alive but not a nanny (pid reuse) -> steal
    } else {
      // staleness is judged on body.at (the daemon refreshes the lock every
      // cycle) with mtime as the fallback for hand-made/legacy locks
      const at = Number(body.at) || statSync(p).mtimeMs;
      if (now - at < NANNY_LIMITS.STALE_LOCK_MINUTES * 60_000) return { ok: false, holder: null };
    }
  } catch { /* no lock file — fall through to create */ }
  try {
    const fd = openSync(p, "wx"); // O_EXCL create
    closeSync(fd);
  } catch { try { unlinkSync(p); } catch { return { ok: false, holder: null }; } }
  try { writeFileSync(p, JSON.stringify({ pid: process.pid, at: now }) + "\n"); } catch { /* best effort */ }
  return { ok: true, holder: process.pid };
}

// ---------------- per-run nanny state (crash-safe) ----------------
function nannyStatePath(runsDir, runId) { return join(runsDir, runId, "nanny-state.json"); }
function loadNannyState(runsDir, runId) {
  try {
    const s = JSON.parse(readFileSync(nannyStatePath(runsDir, runId), "utf8"));
    return { actions: [], resumes: 0, holdRedrives: 0, totalActions: 0, lastActionAt: 0, ...s };
  } catch { return { actions: [], resumes: 0, holdRedrives: 0, totalActions: 0, lastActionAt: 0 }; }
}
function saveNannyState(runsDir, runId, st) {
  try { writeFileSync(nannyStatePath(runsDir, runId), JSON.stringify(st, null, 1) + "\n"); } catch { /* never fatal */ }
}

// ---------------- deterministic observation (no AI required) ----------------
export function observeRun(runsDir, runId, { now = Date.now(), coordinatorProbe = null, freshnessProbe = null } = {}) {
  const o = { runId, exists: false, runState: null, currentPhase: null, completedThrough: 0,
    workers: [], workerStatuses: {}, logAgeMinutes: null, finalAcceptance: null,
    findings: [], actionable: null };
  const rd = join(runsDir, runId);
  if (!existsSync(join(rd, "state.json"))) return o;
  o.exists = true;
  try {
    const st = JSON.parse(readFileSync(join(rd, "state.json"), "utf8"));
    o.runState = st.runState ?? null;
    o.currentPhase = st.currentPhase ?? null;
    o.completedThrough = st.completedThrough ?? 0;
    o.workers = st.workers ?? ["alpha"];
    o.finalAcceptance = st.finalAcceptance ?? null;
  } catch (e) { o.findings.push(`state.json unreadable: ${String(e.message ?? e).slice(0, 80)}`); return o; }

  for (const w of o.workers) {
    try {
      const m = readFileSync(join(rd, `status-${w}.md`), "utf8").match(/^# Status:\s*(\S+)/m);
      o.workerStatuses[w] = m ? m[1] : "unknown";
    } catch { o.workerStatuses[w] = "missing"; }
  }
  try { o.logAgeMinutes = Math.round((now - statSync(join(rd, "run.log")).mtimeMs) / 60000); } catch { o.logAgeMinutes = null; }

  const TERMINAL = o.runState == null || TERMINAL_STATES.has(o.runState);
  if (TERMINAL) return o; // nothing to observe on terminal/absent runs
  // V3.3.28: operator HALTED marker — every automatic path refuses. Plain
  // informational finding, actionable stays null (no RESUME, no ESCALATE).
  if (isHalted(runsDir, runId)) {
    o.findings.push("run is HALTED (operator marker file present) — automatic paths refuse; removal is an explicit operator action");
    return o;
  }

  // 1) coordinator died mid-run -> bounded revive
  const coordRaw = coordinatorProbe ? coordinatorProbe() : coordinatorStatus(runsDir, { runId });
  // V3.3.13: coordinatorStatus() can return an object (e.g. MULTIPLE detail);
  // findings are operator-facing strings — never "[object Object]".
  const coord = typeof coordRaw === "string" ? coordRaw : String(coordRaw?.state ?? JSON.stringify(coordRaw));
  o.coordinatorState = coord;
  if (o.runState === "RUNNING" && coord !== "RUNNING") {
    o.findings.push(`coordinator ${coord} while run is RUNNING`);
    o.actionable = { kind: "RESUME", why: "coordinator died mid-run; detached resume --go is the proven recovery" };
    return o;
  }
  // 2) held acceptance + stale staged evidence -> one bounded re-drive
  if (o.runState === "NEEDS_HUMAN_REVIEW" && o.finalAcceptance?.verdict === "NEEDS_HUMAN_REVIEW") {
    const fr = freshnessProbe
      ? freshnessProbe()
      : (() => { try { const f = stagedEvidenceFreshness(join(rd, "deployed"), rd); return { stale: !f.fresh, signalName: f.signalName ?? "" }; } catch { return { stale: false, signalName: "" }; } })();
    o.staleEvidence = fr.stale;
    if (fr.stale) {
      o.findings.push(`held acceptance with staged evidence older than ${fr.signalName || "latest gate signal"} (remediation landed after the snapshot)`);
      o.actionable = { kind: "RE_DRIVE_HOLD", why: "acceptance re-judged pre-fix evidence; one fresh-evidence re-drive is bounded" };
    } else {
      o.findings.push("final acceptance HELD with current evidence — operator decision required");
      o.actionable = { kind: "ESCALATE", why: "held acceptance is a genuine operator decision" };
    }
    return o;
  }
  // 1b) V3.3.12 (evaluated after the held-acceptance branch so a
  // NEEDS_HUMAN_REVIEW run with a real finalAcceptance verdict keeps its
  // evidence-freshness logic): plan approved but coordinator never engaged,
  // or another resume-able non-terminal state with no coordinator running
  // at all -> the same bounded revive. resume --go waits for any in-flight
  // phase, never re-assigns done phases, and is a no-op on a complete run.
  if (RESUMEABLE_STATES.has(o.runState) && o.runState !== "RUNNING" &&
      !(o.runState === "NEEDS_HUMAN_REVIEW" && o.finalAcceptance?.verdict) &&
      coord !== "RUNNING") {
    o.findings.push(`run is ${o.runState} (age ${o.logAgeMinutes ?? "?"}min) with coordinator ${coord}`);
    o.actionable = { kind: "RESUME", why: `${o.runState} run not engaged; bounded resume --go` };
    return o;
  }
  // 3) quiet RUNNING run (no coordinator finding above means it IS running):
  //    a worker may be stalled — never auto-fixed, escalate after a grace window.
  if (o.runState === "RUNNING" && o.logAgeMinutes != null && o.logAgeMinutes >= 20) {
    o.findings.push(`run.log quiet ${o.logAgeMinutes}min while RUNNING (worker stall?)`);
    o.actionable = { kind: "ESCALATE", why: "possible worker stall" };
  }
  return o;
}

// ---------------- V3.3.23.2 (ticket 041, Sol-authorized): stale-run reconciliation sweeper ----------------
// The 2026-09-22 incident left TEN verifiably-dead zombie runs (Sep 15–18)
// STALE_RUN-blocking every new start; recovery was manual. Sol verdict (turn 3,
// consult 2026-09-21T20-11-12, Q4 CONFIRMED): reconciliation belongs INSIDE the
// deterministic nanny, using the V3.3.22 coordinator-recovery discipline
// EXACTLY — all criteria simultaneously, idempotent, minimum mutation, evidence
// preserved. Non-terminal run is marked ABORTED only when:
//   (a) coordinatorStatus() reports NO live coordinator for it;
//   (b) the PID stored in its COORDINATOR.lock has no live /proc entry (empty
//       or missing lock also counts as no-owner);
//   (c) the lock is re-read immediately before mutation and still holds the
//       same (dead) owner;
//   (d) coordinatorStatus() re-checked after cleanup before returning;
//   plus §5: run.log unchanged for > STALE_RUN_LOG_MINUTES (60).
// Rules intact by construction: never bypasses G1–G6 (start-guard is untouched
// and a quarantined/guarded run still qualifies ONLY via these deadness
// criteria — a recoverable-but-guarded run has a live coordinator or fresh log
// and never qualifies); runs during load-standdown are refused (return above).
export const STALE_RUN_LOG_MINUTES = 60;
const ABORT_STATES = TERMINAL_STATES; // writes land in this set only

export function reconcileStaleRuns(runsDir, { now = Date.now(), apply = false, coordinatorProbe = null, pidProbe = null } = {}) {
  const events = [];
  let candidates;
  try {
    candidates = readdirSync(runsDir).filter((d) => /^2026-/.test(d) &&
      existsSync(join(runsDir, d, "state.json")));
  } catch { return { events, reconciled: 0, checked: 0 }; }
  let reconciled = 0;
  for (const rid of candidates.sort()) {
    let st;
    try { st = JSON.parse(readFileSync(join(runsDir, rid, "state.json"), "utf8")); }
    catch { continue; }
    if (st.runState == null || ABORT_STATES.has(st.runState)) continue; // terminal/unknown: never mutated
    // V3.3.28: HALTED runs are never converted to ABORTED — the operator owns
    // that run's lifecycle; journal event (not appendAlert — no Discord spam
    // from a permanent marker) keeps the skip visible every cycle.
    if (isHalted(runsDir, rid)) {
      events.push({ severity: "warn", event: "halted-run-skipped", detail: `run ${rid} is HALTED (operator marker) — stale sweeper did NOT convert it; operator decides` });
      continue;
    }
    // §5 log-freshness criterion. V3.3.23.3 (Sol turn-1 fix): a MISSING log
    // is NOT proof of staleness — a just-created run has no run.log yet, and
    // "missing = Infinity" aborted fresh runs at startup. Fallback age source:
    // state.json mtime (the run's own creation/update evidence); if that is
    // unreadable too, skip — absence of evidence never proves death.
    let logAge = null;
    try {
      logAge = Math.round((now - statSync(join(runsDir, rid, "run.log")).mtimeMs) / 60000);
    } catch {
      try { logAge = Math.round((now - statSync(join(runsDir, rid, "state.json")).mtimeMs) / 60000); }
      catch { continue; }
    }
    if (logAge <= STALE_RUN_LOG_MINUTES) continue;
    // (a) no live coordinator (probe injectable for tests)
    const coordRaw = coordinatorProbe ? coordinatorProbe() : coordinatorStatus(runsDir, { runId: rid });
    const coord = typeof coordRaw === "string" ? coordRaw : String(coordRaw?.state ?? "");
    if (coord === "RUNNING" && coordRaw?.runId === rid) continue; // live coordinator OWNS this run
    const lockPath = join(runsDir, rid, "COORDINATOR.lock");
    let lockPid = null;
    try { lockPid = parseInt(readFileSync(lockPath, "utf8").trim(), 10); } catch { lockPid = null; }
    // (b) stored pid has no live /proc entry (empty/missing lock = no owner)
    const pidAlive = pidProbe ? pidProbe(lockPid) : (lockPid != null && existsSync(`/proc/${lockPid}`));
    if (pidAlive) continue; // a live owner process exists: NEVER touch
    // (c) re-read immediately before mutation — same dead owner
    let lockPid2 = null;
    try { lockPid2 = parseInt(readFileSync(lockPath, "utf8").trim(), 10); } catch { lockPid2 = null; }
    if (lockPid2 !== lockPid) continue; // lock changed under us: skip this cycle
    // V3.3.23.3 (Sol turn-1 fix): mutation-boundary revalidation. Everything
    // above ran BEFORE this point; the V3.3.22 rule is that the criteria must
    // hold SIMULTANEOUSLY at commit time. Re-read state.json (a concurrent
    // writer may have advanced/terminated it — never overwrite newer state
    // with our older snapshot) and re-check coordinator + pid liveness NOW.
    const statePath = join(runsDir, rid, "state.json");
    let latest;
    try { latest = JSON.parse(readFileSync(statePath, "utf8")); }
    catch { continue; }
    if (latest.runState == null || ABORT_STATES.has(latest.runState)) continue;
    const coordNow = coordinatorProbe ? coordinatorProbe() : coordinatorStatus(runsDir, { runId: rid });
    const coordNowState = typeof coordNow === "string" ? coordNow : String(coordNow?.state ?? "");
    if (coordNowState === "RUNNING" && (coordNow?.runId == null || coordNow?.runId === rid)) continue;
    const pidNowAlive = pidProbe ? pidProbe(lockPid) : (lockPid != null && existsSync(`/proc/${lockPid}`));
    if (pidNowAlive) continue;
    // mutate: minimum metadata only — runState -> ABORTED + reason, with a
    // state.json backup preserving full evidence (nothing is deleted). The
    // FRESHLY READ object is mutated, never the older loop snapshot.
    if (apply) {
      try {
        copyFileSync(statePath, join(runsDir, rid, "state.json.bak.nanny-reconcile"));
        latest.runState = "ABORTED";
        latest.abortedReason = `nanny stale-run reconciliation ${new Date(now).toISOString()}: coordinator dead, stale-source age ${logAge}min, lock owner ${lockPid ?? "none"} not live (V3.3.22 rules a-d + §5, revalidated at mutation boundary)`;
        writeFileSync(statePath, JSON.stringify(latest, null, 2) + "\n");
        reconciled += 1;
        events.push({ severity: "action", event: "stale-run-reconciled", detail: `run ${rid} ABORTED <- dead ${logAge}min-quiet zombie (backup: state.json.bak.nanny-reconcile)` });
        appendAlert(runsDir, "action", `nanny reconciled stale run ${rid} -> ABORTED (coordinator dead, stale age ${logAge}min)`);
      } catch (e) {
        events.push({ severity: "error", event: "stale-run-reconcile-failed", detail: `run ${rid}: ${String(e.message ?? e).slice(0, 120)}` });
      }
    } else {
      events.push({ severity: "warn", event: "stale-run-candidate", detail: `run ${rid} qualifies (stale-source age ${logAge}min, no live coordinator/owner) — DRY-RUN, not mutated` });
    }
  }
  // (d) re-check coordinator status after any mutation pass
  const post = coordinatorProbe ? coordinatorProbe() : coordinatorStatus(runsDir);
  const postState = typeof post === "string" ? post : String(post?.state ?? "");
  return { events, reconciled, checked: candidates.length, coordinatorAfter: postState };
}

// ---------------- alerts (append-only; relayed to MQTT by controller) ----------------
export function appendAlert(runsDir, severity, msg) {
  const line = JSON.stringify({ at: new Date().toISOString(), severity, msg: String(msg).slice(0, 900) }) + "\n";
  try { appendFileSync(join(runsDir, "nanny-alerts.jsonl"), line); } catch { /* never fatal */ }
  log(`alert[${severity}] ${msg}`);
}

// V3.3.12: per-cycle heartbeat for ACTIVE runs -> nanny-heartbeat.jsonl.
// Consumed by the controller relay as Discord-only 5-min operator updates
// (MQTT/HA stays alert-only so phones are not buzzed every 5 minutes).
export function appendHeartbeat(runsDir, msg) {
  // 1900 cap: the bridge parses this inner JSON to promote narratives; a
  // 900-char cut could truncate the JSON mid-string and break that parse
  // (narrator text alone is up to 1500 chars). Bridge posts cap at 1900 too.
  const line = JSON.stringify({ at: new Date().toISOString(), severity: "info", msg: String(msg).slice(0, 1900) }) + "\n";
  try { appendFileSync(join(runsDir, "nanny-heartbeat.jsonl"), line); } catch { /* never fatal */ }
}

// ---------------- V3.3.28 (ticket 041, Sol FIX PLAN item 6, turn-3 CONFIRMED refinements): boot reconciliation ----------------
// After a host crash/reboot (VM100 incident 2026-09-22) NOTHING re-drove
// interrupted runs — by design (guards), which read to the operator as
// "everything stopped". This pass runs INSIDE the deterministic nanny on the
// FIRST SAFE CYCLE of a new boot (never a fixed uptime window — a long FROZEN
// period must not make the pass permanently missed), after the stale sweeper
// has already ABORTed provably-dead old runs, so only fresh crash-interrupted
// runs remain. Sol's refinements, all implemented:
//   - pending-until-safe (boot marker written ONLY after the pass completes;
//     a crashed pass replays, per-run idempotency via existing nanny state
//     + the boot ledger, never double-spawning);
//   - existing eligibility predicates (RESUMEABLE_STATES incl. the
//     NEEDS_HUMAN_REVIEW-with-verdict exclusion) — no second state machine;
//   - HALTED runs untouched; no live coordinator (criteria a-b) revalidated
//     at the mutation boundary; log freshness <= STALE_RUN_LOG_MINUTES;
//   - BOOT_RESUME is a new REASON inside existing accounting (counts toward
//     MAX_TOTAL_ACTIONS + MAX_RESUMES_PER_RUN + cooldown), boot-scoped caps:
//     1 per run per boot, 2 per boot (durable ledger .boot-resume-<bootId>);
//   - CURRENT-only resume: `resume --go` drives the CURRENT run, so eligible
//     non-CURRENT runs are ALERTED for the operator/babysitter, not resumed;
//   - load re-checked at mutation time; over cap or FROZEN flag => no action
//     and NO marker (pass stays pending for the next safe cycle).
export function reconcileAfterBoot(runsDir, { now = Date.now(), apply = false, resumeProbe = null, bootId = null, loadProbe = null, frozenProbe = null, coordinatorProbe = null } = {}) {
  const events = [];
  if (bootId == null) {
    try {
      const m = readFileSync("/proc/stat", "utf8").match(/^btime\s+(\d+)/m);
      bootId = m ? m[1] : null;
    } catch { bootId = null; }
  }
  if (!bootId) return { events, bootPending: false, resumed: 0, reason: "boot-id unavailable" };
  const marker = join(runsDir, `.boot-reconciled-${bootId}`);
  if (existsSync(marker)) return { events, bootPending: false, resumed: 0 };
  // Mutation-time safety net (the cycle-level standdown already returned above;
  // this re-check covers a load spike DURING the pass and the loadguard FROZEN
  // flag: neither state may produce a resume or a completion marker).
  const load = loadProbe ? loadProbe() : readHostLoad();
  const L = NANNY_LIMITS;
  const overCap = (load.load1 != null && load.load1 > L.MAX_LOAD1) || (load.procs != null && load.procs > L.MAX_PROCS);
  if (overCap) {
    events.push({ severity: "warn", event: "boot-reconcile-deferred", detail: `host load ${load.load1} / procs ${load.procs} over cap — boot reconciliation stays PENDING (marker not written)` });
    return { events, bootPending: true, resumed: 0 };
  }
  const frozen = frozenProbe ? frozenProbe() : existsSync("/var/lib/orch-loadguard/FROZEN");
  if (frozen) {
    events.push({ severity: "warn", event: "boot-reconcile-deferred", detail: "loadguard FROZEN flag present — boot reconciliation stays PENDING (marker not written)" });
    return { events, bootPending: true, resumed: 0 };
  }
  let dirs;
  try {
    dirs = readdirSync(runsDir).filter((d) => /^2026-/.test(d) && existsSync(join(runsDir, d, "state.json"))).sort();
  } catch { return { events, bootPending: true, resumed: 0 }; }
  let current = null;
  try { current = readFileSync(join(runsDir, "CURRENT"), "utf8").trim() || null; } catch { current = null; }
  const ledgerPath = join(runsDir, `.boot-resume-${bootId}.jsonl`);
  const ledger = [];
  try { for (const l of readFileSync(ledgerPath, "utf8").split("\n")) { if (l.trim()) { try { ledger.push(JSON.parse(l)); } catch { } } } } catch { }
  let bootResumes = ledger.length;
  let resumed = 0;
  for (const rid of dirs) {
    let st;
    try { st = JSON.parse(readFileSync(join(runsDir, rid, "state.json"), "utf8")); } catch { continue; }
    if (st.runState == null || TERMINAL_STATES.has(st.runState)) continue;
    if (isHalted(runsDir, rid)) {
      events.push({ severity: "warn", event: "boot-reconcile-halted-skip", detail: `run ${rid} is HALTED (operator marker) — boot reconciliation did NOT touch it` });
      continue;
    }
    // Existing nanny eligibility predicates (Sol: no second state machine).
    if (!RESUMEABLE_STATES.has(st.runState)) continue;
    if (st.runState === "NEEDS_HUMAN_REVIEW" && st.finalAcceptance?.verdict) continue;
    // Fresh crash-interrupted only (the sweeper already took the stale ones).
    let logAge = null;
    try { logAge = Math.round((now - statSync(join(runsDir, rid, "run.log")).mtimeMs) / 60000); }
    catch { try { logAge = Math.round((now - statSync(join(runsDir, rid, "state.json")).mtimeMs) / 60000); } catch { continue; } }
    if (logAge == null || logAge > STALE_RUN_LOG_MINUTES) {
      events.push({ severity: "info", event: "boot-reconcile-stale-skip", detail: `run ${rid} not fresh (${logAge ?? "?"}min) — left for the operator (stale sweeper owns old runs)` });
      continue;
    }
    // No live coordinator for THIS run (criteria a-b, revalidated at mutation).
    const coordRaw = coordinatorProbe ? coordinatorProbe() : coordinatorStatus(runsDir, { runId: rid });
    const coord = typeof coordRaw === "string" ? coordRaw : String(coordRaw?.state ?? "");
    if (coord === "RUNNING" && (coordRaw?.runId == null || coordRaw?.runId === rid)) {
      events.push({ severity: "info", event: "boot-reconcile-live-skip", detail: `run ${rid} has a live coordinator — untouched` });
      continue;
    }
    let lockPid = null;
    try { lockPid = parseInt(readFileSync(join(runsDir, rid, "COORDINATOR.lock"), "utf8").trim(), 10); } catch { lockPid = null; }
    if (lockPid != null && existsSync(`/proc/${lockPid}`)) continue; // live owner process
    // Boot-scoped idempotency (durable across crashed passes).
    if (ledger.some((e) => e.runId === rid)) continue; // 1 per run per boot
    if (bootResumes >= 2) {
      events.push({ severity: "warn", event: "boot-reconcile-cap", detail: `boot cap (2 BOOT_RESUME) reached — run ${rid} left for the operator/babysitter` });
      continue;
    }
    // CURRENT-only resume: `resume --go` attaches to runs/CURRENT.
    if (rid !== current) {
      events.push({ severity: "warn", event: "boot-reconcile-noncurrent", detail: `run ${rid} is crash-interrupted and eligible but not CURRENT (CURRENT=${current ?? "none"}) — alerting instead of resuming; operator/babysitter decides` });
      if (apply) appendAlert(runsDir, "warn", `post-boot: run ${rid} (${st.runState}, log ${logAge}min) is interrupted and resume-eligible but not CURRENT — no auto-resume`);
      continue;
    }
    // Existing per-run action accounting (Sol: BOOT_RESUME is a reason, not a
    // new authority pool): caps + cooldown + totalActions all still apply.
    const nst = loadNannyState(runsDir, rid);
    const sinceLast = now - (nst.lastActionAt ?? 0);
    if (nst.totalActions >= L.MAX_TOTAL_ACTIONS) {
      events.push({ severity: "warn", event: "boot-reconcile-cap", detail: `run ${rid}: total-action cap (${L.MAX_TOTAL_ACTIONS}) reached — no BOOT_RESUME` });
      continue;
    }
    if (sinceLast <= L.COOLDOWN_MS) {
      events.push({ severity: "warn", event: "boot-reconcile-cooldown", detail: `run ${rid}: action cooldown active — no BOOT_RESUME this cycle` });
      continue;
    }
    if (nst.resumes >= L.MAX_RESUMES_PER_RUN) {
      events.push({ severity: "warn", event: "boot-reconcile-cap", detail: `run ${rid}: resume cap (${L.MAX_RESUMES_PER_RUN}) reached — no BOOT_RESUME` });
      continue;
    }
    // Mutation boundary: re-read state fresh; abort run if it changed under us.
    let latest;
    try { latest = JSON.parse(readFileSync(join(runsDir, rid, "state.json"), "utf8")); } catch { continue; }
    if (latest.runState !== st.runState || isHalted(runsDir, rid)) continue;
    if (!apply) {
      events.push({ severity: "warn", event: "boot-reconcile-candidate", detail: `run ${rid} (${latest.runState}, log ${logAge}min, CURRENT) qualifies for BOOT_RESUME — DRY-RUN, not spawned` });
      continue;
    }
    const spawn = resumeProbe ?? (() => {
      const r = spawnSync("setsid", ["bash", "-c",
        "nohup bun orchestrate.mjs resume --go >> /workspace/work/ai-orchestration/runs/nanny-resume.log 2>&1 &"],
        { cwd: "/workspace/work/ai-orchestration", encoding: "utf8", timeout: 15_000 });
      return !r.error;
    });
    if (!spawn()) {
      events.push({ severity: "error", event: "boot-resume-spawn-failed", detail: `run ${rid}: detached resume spawn failed` });
      continue;
    }
    // Record through existing accounting BEFORE any further mutation.
    nst.totalActions += 1;
    nst.resumes += 1;
    nst.lastActionAt = now;
    nst.actions.push({ at: new Date(now).toISOString(), kind: "BOOT_RESUME", detail: `post-boot revival (log ${logAge}min)` });
    saveNannyState(runsDir, rid, nst);
    try { appendFileSync(ledgerPath, JSON.stringify({ at: new Date(now).toISOString(), runId: rid }) + "\n"); } catch { }
    bootResumes += 1;
    resumed += 1;
    events.push({ severity: "action", event: "BOOT_RESUME", detail: `run ${rid} (${latest.runState}) revived after boot (log ${logAge}min; boot resume ${bootResumes}/2)` });
    appendAlert(runsDir, "action", `boot reconciliation: run ${rid} BOOT_RESUMEd after host boot (log ${logAge}min)`);
  }
  // Marker ONLY after the pass completed (Sol: crash-safe idempotency).
  if (apply) {
    try { writeFileSync(marker, new Date(now).toISOString() + "\n"); } catch { }
  }
  return { events, bootPending: false, resumed };
}

// ---------------- one cycle ----------------
export async function nannyCycle(runsDir, { runId = null, apply = false, now = Date.now(), coordinatorProbe = null, resumeProbe = null, loadProbe = null, frozenProbe = null, narrate = true, visionHook = null } = {}) {
  const events = [];
  // V3.3.29: the session-lifecycle watch runs even when NO run exists —
  // pooled worker sessions and open consults outlive runs, and the operator's
  // exact complaint was sessions dying in that run-less state. Load probes
  // happen here so the standdown classification below is already known.
  const L0 = NANNY_LIMITS;
  const load = loadProbe ? loadProbe() : readHostLoad();
  // 2026-09-27 (claude): loadguard no longer stops orch-nanny.timer (the freeze
  // used to black out Discord updates entirely). The action-quarantine it wants
  // is preserved HERE instead: a latched FROZEN flag is a standdown exactly like
  // an over-cap load — no actions, no model calls — while the cycle still runs
  // and still emits its deterministic narration downstream.
  // Two paths because the nanny runs INSIDE the freebuff container, which
  // mounts /workspace only: /var/lib/orch-loadguard is the host truth, and
  // runs/LOADGUARD-FROZEN is the mirror orch-loadguard.sh writes for us.
  const lgFrozen = frozenProbe
    ? !!frozenProbe()
    : (existsSync("/var/lib/orch-loadguard/FROZEN") || existsSync(join(runsDir, "LOADGUARD-FROZEN")));
  const overload = lgFrozen ||
    (load.load1 != null && load.load1 > L0.MAX_LOAD1) ||
    (load.procs != null && load.procs > L0.MAX_PROCS);
  try {
    const { sessionWatchCycle } = await import("./session-watch.mjs");
    const sw = await sessionWatchCycle(runsDir, { now, apply, frozen: overload, visionHook: overload ? null : (visionHook ?? null) });
    for (const e of sw.events) events.push(e);
  } catch (e) {
    events.push({ severity: "error", event: "session-watch-failed", detail: String(e.message ?? e).slice(0, 120) });
  }
  // ticket 370: finalise orphaned session-consult pointers (child gone, still
  // RUNNING/DISPATCHED) as ok:false so callers stop polling forever. Skipped
  // in FROZEN (overload) cycles per the incident-033 boundary.
  if (!overload) {
    try {
      const { reapConsultPointers } = await import("./consult-pointer-reaper.mjs");
      const rp = reapConsultPointers(runsDir, { now, apply });
      for (const e of rp.events) {
        events.push(e);
        if (apply) appendAlert(runsDir, e.severity, `consult-pointer-reaper: ${e.event}: ${e.detail}`);
      }
    } catch (e) {
      events.push({ severity: "error", event: "consult-pointer-reap-failed", detail: String(e.message ?? e).slice(0, 120) });
    }
  }
  if (!runId) {
    const dirs = readdirSync(runsDir)
      .filter((d) => /^2026-/.test(d) && existsSync(join(runsDir, d, "state.json")))
      .sort();
    runId = dirs.at(-1) ?? null;
  }
  if (!runId) {
    if (overload) {
      events.push({ severity: "warn", event: "load-standdown", detail: `host load ${load.load1} / procs ${load.procs} over cap (${L0.MAX_LOAD1}/${L0.MAX_PROCS})${lgFrozen ? " [loadguard FROZEN latched]" : ""} — nanny standing down: no actions, no model calls this cycle (incident 033 guard)` });
      return { events, runId: null, acted: false, observation: null, loadStanddown: true };
    }
    log("no runs found");
    return { events, runId: null, acted: false };
  }

  // V3.3.19 (incident 033): host-overload standdown. While the box is
  // saturating the nanny takes NO actions and makes NO model calls — the
  // per-cycle narrator/supervisor spawns were a major contributor to the
  // spawn storm. Pure deterministic note, nothing else. (loadProbe injectable
  // for tests; /proc/loadavg is host-wide inside the container.)
  // V3.3.29 session-watch ALREADY ran above (before the runId early-return).
  if (overload) {
    events.push({ severity: "warn", event: "load-standdown", detail: `host load ${load.load1} / procs ${load.procs} over cap (${L0.MAX_LOAD1}/${L0.MAX_PROCS})${lgFrozen ? " [loadguard FROZEN latched]" : ""} — nanny standing down: no actions, no model calls this cycle (incident 033 guard)` });
    return { events, runId, acted: false, observation: null, loadStanddown: true };
  }

  const o = observeRun(runsDir, runId, { now, coordinatorProbe });
  // V3.3.28 (Sol turn-3 ordering, FIX PLAN items 6+7): the stale-run sweeper
  // moves BEFORE the terminal-current early return — matching its documented
  // "before any other return" contract. Its real job (aborting provably-dead
  // old runs) matters MOST on a post-reboot box where the newest run is
  // terminal; the old placement silently skipped it in exactly that state.
  // Ordering from here: standdown -> sweeper -> boot reconciliation -> normal
  // per-run logic (Sol: the sweeper gets first ownership of dead old runs, so
  // boot reconciliation only ever sees fresh crash-interrupted ones).
  try {
    const rec = reconcileStaleRuns(runsDir, { now, apply });
    for (const e of rec.events) events.push(e);
  } catch (e) {
    events.push({ severity: "error", event: "stale-run-reconcile-failed", detail: String(e.message ?? e).slice(0, 120) });
  }
  // V3.3.28 boot reconciliation (Sol FIX PLAN item 6, turn-3 refinements):
  // pending-until-first-safe-cycle, existing eligibility predicates, existing
  // action accounting (BOOT_RESUME is a REASON, not a new authority pool).
  try {
    const boot = reconcileAfterBoot(runsDir, { now, apply, resumeProbe, loadProbe, frozenProbe, coordinatorProbe });
    for (const e of boot.events) events.push(e);
  } catch (e) {
    events.push({ severity: "error", event: "boot-reconcile-failed", detail: String(e.message ?? e).slice(0, 120) });
  }
  const L = NANNY_LIMITS;
  // V3.3.28: state.json may have been removed/renamed mid-cycle — guard the
  // recheck (the pre-V3.3.28 code had the same guard via the early return).
  if (!o.exists || !existsSync(join(runsDir, runId, "state.json"))) {
    events.push({ severity: "info", event: "skip", detail: `run ${runId} — no state.json; nothing to observe` });
    return { events, runId, acted: false, observation: o };
  }
  // V3.3.23.2/3: terminal-current recheck AFTER the sweepers — reconciliation
  // may legitimately have terminated the observed run (observeRun output above
  // was read earlier); then the per-run RESUME path below must not act.
  if (TERMINAL_STATES.has(JSON.parse(readFileSync(join(runsDir, runId, "state.json"), "utf8")).runState ?? "")) {
    events.push({ severity: "info", event: "skip", detail: `run ${runId} — reconciled to terminal this cycle; skipping RESUME` });
    return { events, runId, acted: false, observation: o };
  }
  // NOTE: V3.3.28 moved the stale-run sweeper + added boot reconciliation
  // BEFORE this point. The previous early return on a terminal CURRENT run
  // ("skip: terminal, nothing to do") is superseded: the sweepers now run on
  // every non-standdown cycle regardless of the newest run's state.
  if (TERMINAL_STATES.has(JSON.parse(readFileSync(join(runsDir, runId, "state.json"), "utf8")).runState ?? "")) {
    events.push({ severity: "info", event: "skip", detail: `run ${runId} — reconciled to terminal this cycle; skipping RESUME` });
    return { events, runId, acted: false, observation: o };
  }

  const nst = loadNannyState(runsDir, runId);
  for (const f of o.findings) events.push({ severity: o.actionable ? "warn" : "info", event: "finding", detail: f });

  let acted = false;
  const sinceLast = now - (nst.lastActionAt ?? 0);
  const canAct = apply && sinceLast > L.COOLDOWN_MS && nst.totalActions < L.MAX_TOTAL_ACTIONS;
  if (apply && o.actionable && !canAct) {
    events.push({ severity: "warn", event: "cap-or-cooldown",
      detail: nst.totalActions >= L.MAX_TOTAL_ACTIONS
        ? `action cap (${L.MAX_TOTAL_ACTIONS}) reached — escalating instead of acting`
        : `cooldown: last action ${Math.round(sinceLast / 60000)}min ago` });
  }

  const spawnResume = resumeProbe
    ? resumeProbe
    : () => {
        const r = spawnSync("setsid", ["bash", "-c",
          "nohup bun orchestrate.mjs resume --go >> /workspace/work/ai-orchestration/runs/nanny-resume.log 2>&1 &"],
          { cwd: "/workspace/work/ai-orchestration", encoding: "utf8", timeout: 15_000 });
        return !r.error;
      };

  const take = (kind, detail) => {
    // V3.3.19 (incident 033): a run whose run.log has been quiet for over an
    // hour is a zombie — auto-resume would just re-create the storm. Escalate
    // to the operator instead of spawning.
    if (kind === "RESUME" && o.logAgeMinutes != null && o.logAgeMinutes > L.MAX_STALE_RESUME_MINUTES) {
      events.push({ severity: "alert", event: "stale-run", detail: `run.log quiet ${o.logAgeMinutes}min — refusing auto-resume of a zombie run (incident 033 guard); operator: 'reset --yes' or investigate` });
      return false;
    }
    if (kind === "RESUME" && nst.resumes >= L.MAX_RESUMES_PER_RUN) {
      events.push({ severity: "alert", event: "cap", detail: `resume cap (${L.MAX_RESUMES_PER_RUN}) reached — repeated coordinator death is a deeper failure; escalating` });
      return false;
    }
    if (kind === "RE_DRIVE_HOLD" && nst.holdRedrives >= L.MAX_HOLD_REDRIVES) {
      events.push({ severity: "alert", event: "cap", detail: `hold re-drive cap (${L.MAX_HOLD_REDRIVES}) reached — a second hold needs the operator; escalating` });
      return false;
    }
    if (!canAct) return false;
    if (!spawnResume()) { events.push({ severity: "error", event: kind + "-spawn-failed", detail }); return false; }
    nst.totalActions += 1;
    if (kind === "RESUME") nst.resumes += 1;
    if (kind === "RE_DRIVE_HOLD") nst.holdRedrives += 1;
    nst.lastActionAt = now;
    nst.actions.push({ at: new Date(now).toISOString(), kind, detail: detail.slice(0, 200) });
    saveNannyState(runsDir, runId, nst);
    events.push({ severity: "action", event: kind, detail });
    return true;
  };

  if (o.actionable?.kind === "RESUME") {
    acted = take("RESUME", o.runState === "RUNNING"
      ? `coordinator dead while RUNNING -> detached resume --go (run ${runId})`
      : `${o.runState} run not engaged (coordinator ${o.coordinatorState ?? "?"}) -> detached resume --go (run ${runId})`);
  } else if (o.actionable?.kind === "RE_DRIVE_HOLD") {
    acted = take("RE_DRIVE_HOLD", `held acceptance + stale staged evidence -> fresh-evidence re-drive (run ${runId})`);
  }

  const escalate = o.actionable?.kind === "ESCALATE" || (o.actionable && !acted);
  // V3.3.12: findings on a NON-actionable non-terminal run (e.g. still stuck
  // after caps/cooldown) surface to the operator — but V3.3.13 dedupes:
  // alerts fire when the SITUATION CHANGES (state/finding/action key), not
  // every 5-min cycle. The narrated heartbeat keeps flowing every cycle.
  const stuck = !o.actionable && o.findings.length > 0;
  const alertKey = [o.runState, acted ? "acted" : o.actionable?.kind ?? "none", o.findings[0] ?? ""].join("|");
  const isNewSituation = nst.lastAlertKey !== alertKey;
  const summary = `run ${runId} state=${o.runState} — ${o.findings.join("; ") || "no findings"}; ${acted ? "ACTION TAKEN" : o.actionable ? `needs ${o.actionable.kind}` : stuck ? "operator attention" : "no action"}`;
  if (escalate || acted || stuck) {
    if (acted || isNewSituation) {
      appendAlert(runsDir, escalate ? "alert" : acted ? "action" : "warn", summary);
      nst.lastAlertKey = alertKey;
      saveNannyState(runsDir, runId, nst);
    }
  }
  events.push({ severity: escalate ? "alert" : acted ? "action" : stuck ? "warn" : "info", event: "summary", detail: summary + (isNewSituation || acted ? "" : " (unchanged — not re-alerted)") });
  // V3.3.13 heartbeat: an ACTIVE (non-terminal) run emits one narrated
  // Discord-bound update per cycle (task-name title + NOW/ISSUES/FIXES/NEEDED
  // prose). Display-only LLM use; deterministic fallback when every narrator
  // model fails so the stream never goes quiet. narrate=false (selftest /
  // hermetic callers) skips the model call entirely — no spawns, no ledger.
  if (narrate && !TERMINAL_STATES.has(o.runState ?? "")) {
    try {
      const st = JSON.parse(readFileSync(join(runsDir, runId, "state.json"), "utf8"));
      const bundle = {
        runs: [{
          runId,
          title: taskTitle(st.task, runId),
          runState: o.runState,
          currentPhase: o.currentPhase,
          completedThrough: o.completedThrough,
          workers: Object.entries(o.workerStatuses).map(([w, s]) => `${w}:${s}`),
          findings: o.findings,
        }],
        issues: [],
        engineNote: null,
      };
      // recent run.log error/warn lines as orchestration-issue evidence
      try {
        const logTxt = readFileSync(join(runsDir, runId, "run.log"), "utf8");
        const errLines = logTxt.split("\n").filter((l) => /error|fail|BLOCKED|degrad|refus|exhaust/i.test(l)).slice(-6);
        if (errLines.length) bundle.issues.push(...errLines.map((l) => l.replace(/^\[[^\]]+\]\s*/, "").slice(0, 160)));
      } catch { /* log optional */ }
      // narrator model health note (which model composed the last update)
      const nar = composeNarrativeSync(bundle, { runsDir, runId, timeoutSec: 150 });
      appendHeartbeat(runsDir, JSON.stringify({ kind: "narrative", runId, title: bundle.runs[0].title, by: nar.model ?? "fallback", text: nar.text }));
    } catch { /* heartbeat is display-only; never break the cycle */ }
  }
  return { events, runId, acted, observation: o };
}
