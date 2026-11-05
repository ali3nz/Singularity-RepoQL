// lib/confidentiality.mjs — V3.3.35 D13 (ticket 085): confidentiality label
// propagation. `ask --confidential` used to filter promotional endpoints, but
// the full start/plan/review/final-acceptance flows hard-coded the label to
// false. This module is the ONE policy surface every non-router boundary
// consults BEFORE transmission:
//   - router candidate filtering (rc46 skip) stays in engine-router.mjs —
//     it already consumes caseState.confidential; the orchestrate.mjs call
//     sites now pass the REAL label through instead of hard-coding false.
//   - retrieval: skill injection is suppressed entirely for confidential runs
//     (model-generated history must not be handed to or built from private
//     task text through the free extractor chain).
//   - delivery: hub lessons digest, MEX notes, and any promotional-endpoint
//     attachment flow call assertNoConfidentialDelivery() first — fail-closed
//     typed refusal, never a silent leak.
// Design rule (plan D13): the label travels with the run (state.json +
// every caseState + telemetry notes); boundaries filter or refuse; nothing
// here ever widens transmission — a missing label is treated as
// confidential=false ONLY by explicit caller choice, and every new boundary
// added later must call these helpers rather than re-derive policy.

import { RC } from "./bridge-result.mjs";

// Endpoints whose operators are promotional/free tiers — never eligible for
// confidential material. Mirrors engine-router's `startsWith("opencode")`
// skip plus the openrouter free vision/text endpoints, in one place.
export function isPromotionalEndpoint(engine) {
  const e = String(engine ?? "");
  return e.startsWith("opencode") || e.startsWith("openrouter-free");
}

// Typed decision for one candidate at one boundary. Pure — no side effects.
// Returns { allow, rc?, reason }.
export function confidentialityDecision({ confidential = false, engine = "", boundary = "" } = {}) {
  if (!confidential) return { allow: true, reason: "non-confidential run" };
  if (isPromotionalEndpoint(engine)) {
    return { allow: false, rc: RC.PRIVACY, reason: `confidential run: promotional endpoint "${engine}" refused at ${boundary || "unspecified boundary"}` };
  }
  return { allow: true, reason: "confidential run, trusted endpoint" };
}

// Fail-closed delivery gate for DURABLE surfaces (hub digest, MEX, external
// reports, attachments to a destination engine). Throws a typed error when a
// confidential run must not be delivered; callers catch and log-skip.
export function assertNoConfidentialDelivery({ confidential = false, dest = "", engine = "" } = {}) {
  if (!confidential) return;
  if (engine && isPromotionalEndpoint(engine)) {
    const e = new Error(`confidentiality delivery denied (D13): dest="${dest}" engine="${engine}" is promotional`);
    e.rc = RC.PRIVACY;
    e.code = RC.PRIVACY;
    throw e;
  }
  if (dest) {
    // Durable non-engine destinations (hub docs, MEX, Discord, wiki) never
    // receive confidential-run material — the run's task text and lessons
    // derive from it. Delivery targets are enumerated explicitly; anything
    // unrecognized is refused (fail-closed).
    const e = new Error(`confidentiality delivery denied (D13): confidential runs deliver to no durable destination (dest="${dest}") — operator must decide`);
    e.rc = RC.PRIVACY;
    e.code = RC.PRIVACY;
    throw e;
  }
}

// Retrieval boundary: confidential runs inject NO harvested skills (their
// selection is keyed on task text, and the free extractor chain that builds
// skills is itself promotional).
export function filterSkillsForConfidentiality({ confidential = false, skills = [] } = {}) {
  if (!confidential) return skills;
  return [];
}

// Evidence/attachment boundary: attachments may ride ONLY to trusted engines.
export function attachmentsAllowed({ confidential = false, engine = "" } = {}) {
  const d = confidentialityDecision({ confidential, engine, boundary: "attachments" });
  return d;
}

// ---- D13: the run-scoped label, read the same way everywhere -------------
// A run is confidential when its start command carried --confidential. The
// label is persisted at start (cmdStart → state.json) and stamped into every
// gate call site's caseState; resume/deriveState re-reads state.json. Every
// boundary consults THIS function (or caseState.confidential, which is kept
// equal to it) — never re-derives from the task text.
export function isConfidentialRun(stateOrCaseState = {}) {
  if (!stateOrCaseState || typeof stateOrCaseState !== "object") return false;
  return stateOrCaseState.confidential === true;
}

// ---- Journal boundary (ticket 164 Phase 5: hub journal is the durable store)
// Shells out to `fleet-log` on controller via the caller-provided spawnFn
// (spawnSync); fail-open for non-confidential runs (journal availability must
// never break a run) and fail-CLOSED for confidential ones (the event is
// skipped, never transmitted — D13 suppression behavior preserved).
export function mexNote(confidential, msg, { spawnFn = null, host = "controller", cwd = null } = {}) {
  const text = String(msg ?? "").slice(0, 300);
  if (confidential) return { delivered: false, reason: "D13: confidential run — journal note suppressed" };
  if (!spawnFn) return { delivered: false, reason: "no spawnFn provided (test/dry context)" };
  try {
    const r = spawnFn("ssh", [host, `fleet-log --source orchestra --type NOTE --status current '${text.replace(/'/g, "")}'`], { encoding: "utf8", timeout: 20_000 });
    return { delivered: r?.status === 0, reason: r?.status === 0 ? "ok" : `fleet-log rc=${r?.status}` };
  } catch (e) {
    return { delivered: false, reason: `fleet-log failed: ${String(e?.message ?? e).slice(0, 80)}` };
  }
}
