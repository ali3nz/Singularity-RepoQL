// case-state.mjs — canonical machine state for a gated task (case.json),
// rendered to case.md for models/humans. transcript.md remains audit-only.
import { readFileSync, writeFileSync, renameSync, existsSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { createHash } from "node:crypto";

export const CASE_SCHEMA = 2;

// V3.3.32 Phase 1 (ticket 076, Sol consult 2026-09-24T02-15-15): policyVersion 2
// stamps NEW cases only. policyVersion-1 cases (no policyVersion field) load
// unchanged forever — compliance/checkpoint readers must tolerate their absence.
export const POLICY_VERSION = 2;

const CHECKPOINT_CAP = 500; // drop-oldest guard; engine events repeat per turn

export function newCase({ id, task, target, constraints = [], confidential = false, visionRequired = false }) {
  return {
    schemaVersion: CASE_SCHEMA,
    policyVersion: POLICY_VERSION,
    id,
    task,
    target: target ?? { host: "controller", path: null },
    risk: "NORMAL",
    confidential,
    visionRequired,
    verifiedFacts: [],
    assumptions: [],
    constraints,
    approvedPlan: null,       // gate-v2 plan object (or legacy compat)
    approvedBy: null,         // owner engine that signed the plan
    implementation: [],       // {step, action, exitCode, evidenceRef, at}
    latestEvidenceManifest: null,
    lastVerdict: null,        // last review gate verdict
    fixPlan: null,
    // Phase 1 authority/compliance block (Sol-approved shape, verbatim):
    authority: {
      technicalOwner: "buffy",
      coordinatorRole: "launcher-watcher-narrator",
      // V3.3.34 Phase 5: stamped at case creation from the caller class
      // (engine-router resolveCaller). Gives the pre-write gate real teeth:
      // a coordinator-launched v2 case can never pass preWrite because the
      // technical owner is buffy and the launcher is not.
      launchedBy: null,
    },
    compliance: {
      preWrite: { status: "pending" },
      closeout: { status: "pending" },
      consultSignoff: { status: "pending" },
    },
    checkpoints: [],           // [{event, at, detail?}] — append-only event log
    discord: {},               // thread identity lands here in Phase 2
    ownerEngine: null,        // sticky premium owner
    engineHistory: [],        // [{engine, stage, verdict|rc, at}]
    reviewRound: 0,
    status: "discovery",      // discovery|planning|awaiting-impl|implementing|reviewing|fixing|complete|blocked
  };
}

export function casePaths(consultDir) {
  return {
    caseJson: join(consultDir, "case.json"),
    caseMd: join(consultDir, "case.md"),
    transcript: join(consultDir, "transcript.md"),
    evidenceDir: join(consultDir, "evidence"),
  };
}

// Append a checkpoint event (idempotent-adjacent: consecutive identical
// event+detail duplicates within the same second are collapsed, honest repeats
// across turns are kept). Fail-open by design: callers wrap in try/catch.
export function recordCheckpoint(cs, event, detail) {
  if (!cs || typeof cs !== "object") return cs;
  if (!Array.isArray(cs.checkpoints)) cs.checkpoints = [];
  const at = new Date().toISOString();
  const last = cs.checkpoints[cs.checkpoints.length - 1];
  // Detail equality is STRUCTURAL (JSON), not reference — callers build fresh
  // objects per call, so `===` would never collapse and the log would spam.
  const sameDetail = JSON.stringify(last?.detail ?? null) === JSON.stringify(detail ?? null);
  if (last && last.event === event && sameDetail &&
      Math.abs(new Date(last.at) - new Date(at)) < 1500) return cs;
  cs.checkpoints.push(detail === undefined ? { event, at } : { event, at, detail });
  if (cs.checkpoints.length > CHECKPOINT_CAP) cs.checkpoints = cs.checkpoints.slice(-CHECKPOINT_CAP);
  return cs;
}

// Consult lifecycle (Sol Phase 1): every runs/consult/<id>/ carries its own
// authoritative case.json. Idempotent — an existing case is returned untouched
// (so turns on a session never re-stamp `created`).
export function initConsultCase(consultDir, { id, issue = "", engine = null } = {}) {
  const existing = loadCase(consultDir);
  if (existing) return existing;
  const cs = newCase({ id, task: (issue || `duo consult ${id}`).slice(0, 2000), target: { host: "controller", path: `runs/consult/${id}` } });
  recordCheckpoint(cs, "created", { engine });
  saveCase(consultDir, cs);
  return cs;
}

// Run side: derive deterministic checkpoints from a state.json snapshot.
// Pure — no I/O beyond load/save. Terminal = any runState the coordinator
// itself never re-enters (COMPLETED / COMPLETED_UNREVIEWED / NEEDS_HUMAN_REVIEW /
// ABORTED / FAILED). Emergency paths that write state.json WITHOUT writeState
// (nanny reconcile) skip checkpointing by design — honest Phase-1 limitation.
export const RUN_TERMINAL_STATES = new Set(["COMPLETED", "COMPLETED_UNREVIEWED", "NEEDS_HUMAN_REVIEW", "ABORTED", "FAILED"]);

export function deriveRunCheckpoints(st = {}) {
  const ev = [];
  const workers = Array.isArray(st.workers) ? st.workers : (Array.isArray(st.seats) ? st.seats : []);
  const stat = (w) => String(w?.status ?? "").toLowerCase();
  if (workers.some((w) => ["working", "started", "running", "active"].includes(stat(w)))) ev.push("worker_started");
  if (workers.some((w) => ["done", "complete", "completed", "terminal", "failed", "aborted", "missing"].includes(stat(w)))) ev.push("worker_terminal");
  if (st.phaseVerdicts && Object.keys(st.phaseVerdicts).length > 0) ev.push("validation_recorded");
  if (st.completedThrough != null && Number(st.completedThrough) > 0) ev.push("validation_recorded");
  if (RUN_TERMINAL_STATES.has(st.runState)) ev.push("terminal");
  return ev;
}

// Upsert the case.json for a run dir from its state.json snapshot (called from
// the writeState funnel). Creates a v2 case on first sight (created checkpoint);
// records derived checkpoints only when the LAST occurrence of that event name
// carries different detail (state.json is rewritten on many transitions —
// routine rewrites must not spam the log). Emergency paths that write
// state.json WITHOUT writeState (nanny reconcile) skip checkpointing by
// design — honest Phase-1 limitation.
export function upsertRunCase(runDir, stateSnapshot = {}, { callerClass = null } = {}) {
  let cs = loadCase(runDir);
  if (!cs) {
    cs = newCase({ id: stateSnapshot.runId ?? runDir.split(/[\\/]/).pop(), task: String(stateSnapshot.task ?? "orchestration run").slice(0, 2000), target: { host: "controller", path: `runs/${stateSnapshot.runId ?? ""}` } });
    recordCheckpoint(cs, "created", stateSnapshot.runState ?? null);
  }
  // Phase 5: authority tie-in — stamp the launcher class once (first writer
  // wins; a v2 case never changes launch identity mid-flight).
  if (callerClass && !cs.authority?.launchedBy) {
    cs.authority = { ...(cs.authority ?? {}), launchedBy: callerClass };
  }
  const events = deriveRunCheckpoints(stateSnapshot);
  try { if (existsSync(join(runDir, "closeout-receipt.json"))) events.push("closeout_passed"); } catch { /* tolerate */ }
  for (const ev of events) {
    const detail = stateSnapshot.runState ?? null;
    let lastSame = false;
    for (let i = cs.checkpoints.length - 1; i >= 0; i--) {
      if (cs.checkpoints[i].event === ev) { lastSame = cs.checkpoints[i].detail === detail; break; }
    }
    if (!lastSame) recordCheckpoint(cs, ev, detail);
  }
  saveCase(runDir, cs);
  return cs;
}

export function loadCase(dir) {
  const p = casePaths(dir);
  try {
    return JSON.parse(readFileSync(p.caseJson, "utf8"));
  } catch {
    return null;
  }
}

// ---- V3.3.34 Phase 5: deterministic pre-write gate (Sol items 11-12) -------
// Stamp compliance.preWrite from machine evidence the coordinator gathered.
// The gate NEVER decides whether the plan is technically good — that judgment
// already happened (plan artifact + the requester's ownership). It verifies presence,
// shape and authority only. consultRef is REQUIRED only when the task needs a
// Sol consult under the standing rules; callers pass it when one exists.
export function stampPreWrite(cs, { rulesSha256, planRef, evidenceCheckpoint, consultRef } = {}) {
  if (!cs) return cs;
  cs.compliance = cs.compliance ?? {};
  cs.compliance.preWrite = {
    status: "pass",
    rulesSha256: String(rulesSha256 ?? ""),
    technicalOwner: cs.authority?.technicalOwner ?? "buffy",
    planRef: planRef ?? null,
    evidenceCheckpoint: evidenceCheckpoint ?? null,
    ...(consultRef ? { consultRef } : {}),
    at: new Date().toISOString(),
  };
  return cs;
}

const HEX64 = /^[0-9a-f]{64}$/;

// Deterministic verifier (Sol item 12, verbatim checks). Pure except the
// optional consult-case lookup; offline-testable with a resolver stub.
export function preWriteCheck(cs, { consultCaseResolver = null } = {}) {
  const reasons = [];
  const pw = cs?.compliance?.preWrite;
  if (!pw || pw.status !== "pass") reasons.push("preWrite not stamped pass");
  if (!pw || !HEX64.test(String(pw.rulesSha256 ?? ""))) reasons.push("rules hash not recorded (sha256)");
  if (!pw || pw.technicalOwner !== "buffy") reasons.push("technical owner is not the requester");
  if (!pw || !pw.planRef || typeof pw.planRef !== "string") reasons.push("planRef missing");
  if (pw?.planRef) { try { if (!existsSync(pw.planRef)) reasons.push(`planRef artifact missing: ${pw.planRef}`); } catch { reasons.push("planRef unreadable"); } }
  if (!pw || !pw.evidenceCheckpoint) reasons.push("evidenceCheckpoint missing");
  // Case must be live: not terminal, not stale-blocked.
  if (["complete", "blocked"].includes(String(cs?.status ?? ""))) reasons.push(`case is ${cs.status}`);
  // Authority: the launcher must not be the coordinator (Phase 4 tie-in).
  if (String(cs?.authority?.launchedBy ?? "") === "coordinator") reasons.push("launchedBy=coordinator — coordinator may not launch write-capable workers (ticket 076 Phase 5)");
  // Required consult completed signoff — only when a consultRef is present.
  if (pw?.consultRef) {
    const ref = String(pw.consultRef).replace(/^consult-/, "");
    const ccs = consultCaseResolver ? consultCaseResolver(ref) : null;
    const signoff = ccs?.compliance?.consultSignoff?.status;
    if (signoff !== "pass" && signoff !== "signed") reasons.push(`consult ${pw.consultRef} has no completed signoff (status=${signoff ?? "none"})`);
  }
  return { ok: reasons.length === 0, reasons };
}

// ---- V3.3.34 Phase 6: closeout as the second deterministic gate ------------
// A policy-v2 CASE may go terminal only when: worker terminal, live
// validation recorded, and a fleet-agent-closeout PASS receipt is recorded in
// the run dir (closeout-receipt.json, status PASS). Discord terminal summary
// is a consult-side requirement (Phase 2b hard gate); run narration is
// fire-and-forget by design and is NOT a closeout precondition (documented
// interpretation, ticket 076).
export function closeoutCheck(cs) {
  const reasons = [];
  const co = cs?.compliance?.closeout;
  if (!co || co.status !== "pass") reasons.push("closeout receipt not recorded");
  const evs = Array.isArray(cs?.checkpoints) ? cs.checkpoints.map((c) => c.event) : [];
  if (!evs.includes("worker_terminal")) reasons.push("worker terminal not recorded");
  if (!evs.includes("validation_recorded")) reasons.push("live validation not recorded");
  if (!evs.includes("closeout_passed")) reasons.push("fleet-agent-closeout PASS receipt not recorded");
  return { ok: reasons.length === 0, reasons };
}

// Apply terminal compliance from machine evidence. Called from the writeState
// funnel when a v2 run reaches a runState terminal state: the run may report
// COMPLETED (workers done) while the CASE stays non-terminal until the
// closeout receipt lands — evidence presence, never a model decision.
export function applyTerminalCompliance(cs, runDir) {
  if (!cs) return cs;
  let receipt = null;
  try { receipt = JSON.parse(readFileSync(join(runDir, "closeout-receipt.json"), "utf8")); } catch { /* absent */ }
  const passed = !!(receipt && String(receipt.status ?? receipt.result ?? "").toUpperCase() === "PASS");
  cs.compliance = cs.compliance ?? {};
  cs.compliance.closeout = passed
    ? { status: "pass", receiptPath: "closeout-receipt.json", at: new Date().toISOString() }
    : { status: "blocked", reason: "fleet-agent-closeout PASS receipt missing from run dir" };
  if (passed) recordCheckpoint(cs, "closeout_passed", { receipt: "closeout-receipt.json" });
  // Case status: complete ONLY on a passing closeout gate (Phase 6).
  const co = closeoutCheck(cs);
  cs.status = co.ok ? "complete" : (String(cs.status ?? "") === "complete" ? "implementing" : cs.status ?? "implementing");
  return cs;
}

// ---- V3.3.35 (ticket 085, D05/D06): supported case writes go through
// lib/case-store.writeCase (per-case lock + monotonic revision CAS). Legacy
// saveCase remains ONLY for first-creation (initConsultCase / upsertRunCase
// before any concurrency exists) and legacy callers; concurrent writers must
// use writeCase. renderCaseMd is re-exported as the projection renderer.
export { renderCaseMd as renderCaseMdProjection } from "./case-state.mjs";

export function saveCase(dir, cs) {
  const p = casePaths(dir);
  mkdirSync(p.evidenceDir, { recursive: true });
  const tmp = p.caseJson + ".tmp-" + process.pid;
  writeFileSync(tmp, JSON.stringify(cs, null, 2) + "\n");
  renameSync(tmp, p.caseJson);
  writeFileSync(p.caseMd, renderCaseMd(cs));
  return p;
}

export function renderCaseMd(cs) {
  const lines = [];
  lines.push(`# Case ${cs.id} — ${cs.task}`);
  lines.push("");
  lines.push(`- status: ${cs.status} · risk: ${cs.risk} · confidential: ${cs.confidential} · vision: ${cs.visionRequired}`);
  lines.push(`- target: ${JSON.stringify(cs.target)}`);
  if (cs.policyVersion) lines.push(`- policyVersion: ${cs.policyVersion}`);
  if (cs.authority) lines.push(`- authority: technicalOwner=${cs.authority.technicalOwner ?? "?"} coordinatorRole=${cs.authority.coordinatorRole ?? "?"}`);
  if (cs.compliance) lines.push(`- compliance: preWrite=${cs.compliance.preWrite?.status ?? "-"} closeout=${cs.compliance.closeout?.status ?? "-"} consultSignoff=${cs.compliance.consultSignoff?.status ?? "-"}`);
  if (cs.ownerEngine) lines.push(`- owner engine: ${cs.ownerEngine}`);
  lines.push("");
  if (cs.verifiedFacts?.length) {
    lines.push("## Verified facts");
    cs.verifiedFacts.forEach((f, i) => lines.push(`${i + 1}. ${f}`));
    lines.push("");
  }
  if (cs.assumptions?.length) {
    lines.push("## Assumptions");
    cs.assumptions.forEach((f, i) => lines.push(`${i + 1}. ${f}`));
    lines.push("");
  }
  if (cs.constraints?.length) {
    lines.push("## Constraints");
    cs.constraints.forEach((f, i) => lines.push(`${i + 1}. ${f}`));
    lines.push("");
  }
  if (cs.approvedPlan) {
    lines.push("## Approved plan");
    lines.push("```json");
    lines.push(JSON.stringify(cs.approvedPlan, null, 2));
    lines.push("```");
    lines.push("");
  }
  if (cs.implementation?.length) {
    lines.push("## Implementation record");
    cs.implementation.forEach((r, i) =>
      lines.push(`${i + 1}. [rc=${r.exitCode ?? "?"}] ${r.action}${r.evidenceRef ? ` (evidence: ${r.evidenceRef})` : ""}`));
    lines.push("");
  }
  if (Array.isArray(cs.checkpoints) && cs.checkpoints.length) {
    lines.push("## Checkpoints");
    cs.checkpoints.slice(-40).forEach((c) => lines.push(`- ${c.at} ${c.event}${c.detail != null ? ` — ${JSON.stringify(c.detail)}` : ""}`));
    lines.push("");
  }
  if (cs.lastVerdict) lines.push(`## Last review verdict: ${cs.lastVerdict}`);
  if (cs.fixPlan) {
    lines.push("## Signed fix plan");
    lines.push("```json");
    lines.push(JSON.stringify(cs.fixPlan, null, 2));
    lines.push("```");
  }
  return lines.join("\n");
}

// Evidence manifest: file hashes for the relevance set + runtime evidence.
// The manifest digest feeds the plan-cache fingerprint (cursor fix D).
export function buildEvidenceManifest(evidenceDir, files = []) {
  mkdirSync(evidenceDir, { recursive: true });
  const entries = [];
  for (const f of files) {
    try {
      const buf = readFileSync(f);
      entries.push({
        path: f,
        sha256: createHash("sha256").update(buf).digest("hex"),
        bytes: buf.length,
      });
    } catch { /* vanished between discovery and hashing — skip */ }
  }
  const manifest = { builtAt: new Date().toISOString(), files: entries };
  writeFileSync(join(evidenceDir, "manifest.json"), JSON.stringify(manifest, null, 2) + "\n");
  manifest.digest = createHash("sha256")
    .update(entries.map((e) => `${e.path}:${e.sha256}`).join("\n"))
    .digest("hex");
  return manifest;
}
