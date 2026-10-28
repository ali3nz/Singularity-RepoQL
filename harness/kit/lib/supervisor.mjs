// supervisor.mjs — V3.2 §11: FREE Supervisor / Organiser AI.
//
// NOT a second coordinator. Canonical truth remains orchestrate.mjs +
// runs/<RUN_ID>/state.json. The Supervisor consumes a compact snapshot of
// orchestration state and returns a STRUCTURED decision (CONTINUE / NUDGE /
// BLOCKED / ...) as advice. The coordinator (or operator) acts on it.
//
// Free-only: models come from FREE_MODEL_REGISTRY.supervisor via pickModel().
// If no approved free model is available: SUPERVISOR_AI=UNAVAILABLE and the
// deterministic orchestration continues unchanged. NO paid fallback, NO
// Freebucks (opencode calls are 0 freebucks).
//
// The Supervisor MAY NOT: create a second coordinator, rewrite state.json /
// pool.json, bypass locks, falsify verdicts, mark failed tests as passing,
// implement the target project, or invoke premium AI.
import { readFileSync, existsSync, statSync } from "node:fs";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { callFreeRole } from "./free-role-router.mjs"; // V3.3 §2.5: chain-walking free caller
import { recordInvocation, initTelemetry } from "./invocation-telemetry.mjs";

const SUPERVISOR_DECISIONS = Object.freeze([
  "CONTINUE", "NUDGE_WORKER", "RETRY_PHASE", "REQUEST_REVIEW",
  "REQUEST_REMEDIATION", "BLOCKED", "COMPLETE", "COORDINATOR_MISSING",
  "STATE_INCONSISTENT",
]);

// Build the compact snapshot (§11 input list). Reads only; never writes.
export function buildSnapshot(runsDir, runId, { notepadChars = 3000, logChars = 4000 } = {}) {
  const runDir = join(runsDir, runId);
  const snap = { runId, task: null, plan: null, currentPhase: null, completedThrough: null,
    phaseVerdicts: null, workers: null, notepadTail: null, logTail: null,
    coordinator: null, warnings: [], blockers: [] };
  try {
    const st = JSON.parse(readFileSync(join(runDir, "state.json"), "utf8"));
    snap.task = (st.task ?? "").slice(0, 400);
    snap.plan = (st.plan?.phases ?? []).map((p) => ({ n: p.n, title: p.title }));
    snap.currentPhase = st.currentPhase;
    snap.completedThrough = st.completedThrough;
    snap.phaseVerdicts = st.phaseVerdicts ?? {};
    snap.runState = st.runState;
    snap.workers = st.workers ?? [];
    snap.threads = st.threads ? Object.keys(st.threads) : [];
  } catch (e) {
    snap.blockers.push(`state.json unreadable: ${String(e.message ?? e).slice(0, 80)}`);
  }
  try {
    const np = readFileSync(join(runDir, "status-alpha.md"), "utf8");
    snap.notepadTail = np.slice(-notepadChars);
  } catch { snap.notepadTail = null; }
  try {
    const log = readFileSync(join(runDir, "run.log"), "utf8");
    snap.logTail = log.slice(-logChars);
    // Freshness: how stale is the run log? (>15 min quiet on a RUNNING run is a warning)
    const m = statSync(join(runDir, "run.log")).mtimeMs;
    snap.logAgeMinutes = Math.round((Date.now() - m) / 60000);
    if (snap.runState === "RUNNING" && snap.logAgeMinutes > 15) {
      snap.warnings.push(`run.log quiet for ${snap.logAgeMinutes} min while state=RUNNING`);
    }
  } catch { snap.logTail = null; }
  return snap;
}

// Render the supervisor prompt (structured-decision contract).
export function renderSupervisorPrompt(snap) {
  return [
    "You are the FREE Supervisor AI for an engineering orchestration run.",
    "You OBSERVE and ADVISE. You do not run commands or rewrite state.",
    "The single deterministic coordinator (orchestrate.mjs) remains authoritative.",
    "",
    "CAPABILITY NOTE: workers have a working browser available. When a worker",
    "is trying to solve a browser/UI problem only through source inspection,",
    "or a deployment/frontend change lacks live UI confirmation, recommend it",
    "in operatorMessage/warning (e.g. NUDGE_WORKER with a browser-verify hint).",
    "Do not browse yourself; you have no browser and do not need one.",
    "",
    "Respond with ONE JSON object, nothing else:",
    '{"status":"CONTINUE|NUDGE_WORKER|RETRY_PHASE|REQUEST_REVIEW|REQUEST_REMEDIATION|BLOCKED|COMPLETE|COORDINATOR_MISSING|STATE_INCONSISTENT",',
    ' "reason":"<one line>", "action":"NONE|NUDGE_ALPHA|NUDGE_BETA|RESUME|REQUEST_STATUS",',
    ' "targetWorker":null|"alpha"|"beta", "operatorMessage":"<one line for the operator>", "warning":null|"..."}',
    "",
    "RUN SNAPSHOT:",
    JSON.stringify(snap, null, 2),
  ].join("\n");
}

// Parse + validate the model's decision. Anything malformed => null (caller
// treats as SUPERVISOR_AI=UNAVAILABLE this cycle — never guess).
export function parseSupervisorDecision(text) {
  const m = String(text ?? "").match(/\{[\s\S]*\}/);
  if (!m) return null;
  try {
    const j = JSON.parse(m[0]);
    if (!SUPERVISOR_DECISIONS.includes(j.status)) return null;
    return {
      status: j.status,
      reason: String(j.reason ?? "").slice(0, 300),
      action: ["NONE", "NUDGE_ALPHA", "NUDGE_BETA", "RESUME", "REQUEST_STATUS"].includes(j.action) ? j.action : "NONE",
      targetWorker: j.targetWorker === "alpha" || j.targetWorker === "beta" ? j.targetWorker : null,
      operatorMessage: String(j.operatorMessage ?? "").slice(0, 300),
      warning: j.warning ? String(j.warning).slice(0, 300) : null,
    };
  } catch {
    return null;
  }
}

// One supervised cycle: free-role chain call -> parse -> telemetry (router
// already recorded per-attempt invocations with runId). Returns
// { available, model, decision, raw } — never throws.
export function superviseCycle(runsDir, runId, { sshHost = "controller", timeoutSec = 120 } = {}) {
  initTelemetry(runsDir); // V3.3 §2.1: bind ledger to the caller's runsDir
  const snap = buildSnapshot(runsDir, runId);
  const prompt = renderSupervisorPrompt(snap);
  const r = callFreeRole("supervisor", prompt, {
    runsDir, runId, component: "supervisor", purpose: "observe",
    sshHost, timeoutSec, readOnly: true,
  });
  if (!r.ok) {
    // §2.4: record the actual failure class; deterministic monitoring continues.
    try {
      recordInvocation({
        component: "supervisor", role: "SUPERVISOR", purpose: "observe",
        engine: "opencode", model: null, billingClass: "free",
        success: false, failureClass: r.failureClass, rc: 1, paid: false,
        durationMs: r.durationMs, note: (r.reason ?? "all free supervisor models failed").slice(0, 200),
      });
    } catch { /* never break */ }
    return { available: true, model: null, decision: null, raw: r.reason ?? "free-role chain exhausted", durationMs: r.durationMs };
  }
  const decision = parseSupervisorDecision(r.output);
  // A cycle is only successful when a STRUCTURED decision came back (§5.2:
  // rc=0 + no provider rejection is necessary but not sufficient).
  const ok = !!decision;
  if (!ok) {
    try {
      recordInvocation({
        component: "supervisor", role: "SUPERVISOR", purpose: "observe",
        engine: "opencode", model: r.model, billingClass: "free",
        success: false, failureClass: "MODEL_FAILURE", rc: 0, paid: false,
        durationMs: r.durationMs, note: "unparseable supervisor output",
      });
    } catch { /* never break */ }
  }
  return { available: true, model: r.model, decision, raw: r.output.slice(0, 500), durationMs: r.durationMs };
}
