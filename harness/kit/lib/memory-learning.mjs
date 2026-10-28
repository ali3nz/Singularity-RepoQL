// lib/memory-learning.mjs — V3.4.0 Phases 7-9 (plan §11). Memory candidates:
// workers PROPOSE, existing REVIEW disposes, FINAL_ACCEPTANCE binds staged
// bytes. This module is deterministic bookkeeping ONLY — it is explicitly NOT
// a semantic reviewer (plan §19). MEX staging happens through the existing
// closeout mechanisms; no second MEX writer exists here.
import { createHash } from "node:crypto";

export const CANDIDATE_KINDS = new Set([
  "architecture_decision", "design_rationale", "implementation_invariant",
  "implementation_gotcha", "requirement", "operational_pattern", "known_risk",
  "known_defect", "failed_approach", "temporary_state", "handoff_fact",
]);
export const REVIEW_DISPOSITIONS = new Set([
  "verify", "amend", "reject", "duplicate", "case_only", "needs_operator", "supersede_existing",
]);
const DURABLE_KINDS = new Set([
  "architecture_decision", "design_rationale", "implementation_invariant",
  "implementation_gotcha", "requirement", "operational_pattern", "known_risk",
  "known_defect", "failed_approach",
]);
const TRANSIENT_HINTS = /(quota|429|rate limit|right now|currently blocked|transient|timed out this run|today only)/i;

export function sha16(s) { return createHash("sha256").update(String(s ?? "")).digest("hex").slice(0, 16); }

// Validate + normalize one candidate (plan §11.2 schema). Throws on schema
// violations (deterministic validation is coordinator work — D07).
export function validateCandidate(raw, { runNumber = null, caseId = null, caseRev = null, phase = null, createdBy = null, seq = 1 } = {}) {
  const claim = String(raw?.claim ?? "").trim();
  if (!claim) throw new Error("memoryCandidate.claim required");
  const kind = String(raw?.kind ?? "implementation_gotcha");
  if (!CANDIDATE_KINDS.has(kind)) throw new Error(`memoryCandidate.kind not in enum: ${kind}`);
  const durability = DURABLE_KINDS.has(kind) ? "long_term" : "short_term";
  const id = `MC${String(seq).padStart(4, "0")}`;
  return {
    schema: 1, id, runNumber, caseId, caseRev, phase, createdBy,
    kind,
    claim: claim.slice(0, 500),
    whyItMatters: String(raw?.whyItMatters ?? "").slice(0, 500),
    scope: (Array.isArray(raw?.scope) ? raw.scope : []).map((s) => String(s).slice(0, 80)).slice(0, 10),
    evidenceRefs: (Array.isArray(raw?.evidenceRefs) ? raw.evidenceRefs : []).map((s) => String(s).slice(0, 200)).slice(0, 10),
    durability,
    proposedDestination: DURABLE_KINDS.has(kind) ? "mex" : "case",
    confidentiality: raw?.confidentiality === "confidential" ? "confidential" : "normal",
    status: "candidate",
    contentDigest: sha16(`${kind}|${claim}|${(raw?.scope ?? []).join(",")}`),
  };
}

export function validateCandidates(rawList, ctx = {}) {
  // Caller may pass a starting seq (multi-file harvest continues numbering
  // across files); default starts at 1 as before.
  const start = Number.isInteger(ctx.seq) && ctx.seq > 0 ? ctx.seq : 1;
  return (Array.isArray(rawList) ? rawList : []).map((r, i) => {
    const { seq: _ignored, ...rest } = ctx;
    return validateCandidate(r, { ...rest, seq: start + i });
  });
}

// Deterministic duplicate identity: same normalized claim + kind = duplicate
// (acceptance 39). Cross-checks against prior candidates AND existing MEX refs
// supplied by the caller (existing MEX search stays in the closeout path).
export function isDuplicateCandidate(cand, priorCandidates = []) {
  return priorCandidates.some((p) => p.contentDigest === cand.contentDigest && p.id !== cand.id);
}

// Transient-state guard (plan §11.4, acceptance 37): temporary_state /
// transient-looking claims stay case-local — they must never be staged to MEX.
export function isTransientCandidate(cand) {
  return cand.kind === "temporary_state" || TRANSIENT_HINTS.test(cand.claim) || cand.durability === "short_term";
}

// Apply a REVIEW disposition (plan §11.6). Returns the updated candidate list +
// staging plan. needs_operator candidates are surfaced, never auto-staged.
export function applyReviewDisposition(candidates, { candidateId, disposition, amendment = null, supersedeRef = null, reviewer = "review" }) {
  const cand = candidates.find((c) => c.id === candidateId);
  if (!cand) throw new Error(`unknown candidateId ${candidateId}`);
  if (!REVIEW_DISPOSITIONS.has(disposition)) throw new Error(`disposition not in enum: ${disposition}`);
  cand.status = disposition === "verify" ? "verified" : disposition;
  if (disposition === "amend" && amendment) {
    cand.claim = String(amendment.claim ?? cand.claim).slice(0, 500);
    cand.whyItMatters = String(amendment.whyItMatters ?? cand.whyItMatters).slice(0, 500);
    cand.amendedBy = reviewer;
  }
  if (disposition === "supersede_existing") {
    cand.supersedeRef = supersedeRef ?? null; // MEX entity being superseded (§11.9) — no silent overwrite
  }
  cand.reviewedBy = reviewer;
  return cand;
}

// Staging plan: which verified candidates become MEX staging entries (§11.8).
// Confidential candidates NEVER auto-stage (D32/§18.2 — case-local by default).
export function buildStagingPlan(candidates, { runNumber = null, caseId = null } = {}) {
  const staged = [];
  const heldBack = [];
  for (const c of candidates) {
    if (c.status !== "verified" && c.status !== "amend") { heldBack.push({ id: c.id, reason: `status=${c.status}` }); continue; }
    if (c.confidentiality === "confidential") { heldBack.push({ id: c.id, reason: "confidential — case-local by default (needs explicit policy path)" }); continue; }
    if (isTransientCandidate(c)) { heldBack.push({ id: c.id, reason: "transient state — case-local only" }); continue; }
    if (c.status === "amend" && !c.amendedBy) { heldBack.push({ id: c.id, reason: "amend without amendment text" }); continue; }
    staged.push({
      candidateId: c.id,
      destination: "mex",
      provenance: { runNumber, caseId, candidateDigest: c.contentDigest },
      supersedeRef: c.supersedeRef ?? null,
      stagedBytes: `mex-note:${c.id}:${c.contentDigest}`, // exact staged bytes identity — bound into acceptance subject (§11.8 step 5)
    });
  }
  return { staged, heldBack };
}
