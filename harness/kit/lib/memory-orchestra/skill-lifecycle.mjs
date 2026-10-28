// lib/memory-orchestra/skill-lifecycle.mjs — MemOS gap-closure addendum
// (2026-10-23) directive §19 (skill crystallisation and reliability).
// Extends the EXISTING Hermes-style pipeline (lib/skill-harvest.mjs →
// lib/skill-publish.mjs, whose approval boundary [STAGED, AWAITING_APPROVAL,
// APPROVED, REVOKED] REMAINS the authoritative one) with the full lifecycle
// vocabulary the directive names, plus a statistically conservative reliability
// estimate derived ONLY from observed verified outcomes — never model
// self-ratings (§13/§19; markSkillUsed's conflation is NOT repeated here).
//
// State mapping (kit-local lifecycle vs the hub/publisher state). Kit-side is
// the vocabulary; transitions to APPROVED happen ONLY through the existing
// approval records (nextApprovalRecord/content-hash re-approval), so this
// module can PROPOSE but never EXECUTE an approval transition.
export const SKILL_STATES = ["CANDIDATE", "QUARANTINED", "VERIFIED", "APPROVED", "ACTIVE", "PROBATIONARY", "SUPERSEDED", "RETIRED"];
// Map onto the existing publisher approval states (one-way values; the
// lifecycle stays kit-local until the publisher is extended — skill-publish's
// boundary is untouched by this phase).
export function mapToApprovalState(skillState) {
  const s = String(skillState ?? "").toUpperCase();
  if (!SKILL_STATES.includes(s)) return null;
  if (s === "APPROVED" || s === "ACTIVE") return "APPROVED";
  if (s === "SUPERSEDED" || s === "RETIRED") return "REVOKED";
  return "STAGED";
}

// Legal kit-side transitions (fail-closed; QUARANTINED is the re-entry valve
// for verified-but-flaky skills; only PROBATIONARY emits auto re-verification
// scheduling — nothing here mutates a skill file).
const TRANSITIONS = {
  CANDIDATE: ["QUARANTINED", "VERIFIED", "RETIRED"],
  QUARANTINED: ["VERIFIED", "CANDIDATE", "RETIRED"],
  VERIFIED: ["APPROVED", "PROBATIONARY", "RETIRED"],
  APPROVED: ["ACTIVE"],
  ACTIVE: ["PROBATIONARY", "SUPERSEDED", "RETIRED"],
  PROBATIONARY: ["ACTIVE", "QUARANTINED", "RETIRED"],
  SUPERSEDED: [],
  RETIRED: [],
};

export function canTransition(from, to) {
  const f = String(from ?? "").toUpperCase();
  const t = String(to ?? "").toUpperCase();
  if (!SKILL_STATES.includes(f) || !SKILL_STATES.includes(t)) return { allowed: false, reason: "unknown-state" };
  return TRANSITIONS[f].includes(t) ? { allowed: true, reason: null } : { allowed: false, reason: `${f}->${t} not in transition table` };
}

// Reliability: Beta(1,1) prior — posterior mean η = (1+successes)/(2+n) over
// OBSERVED VERIFIED outcomes only. A single success yields η≈0.67, which is
// intentionally UNCONFIDENT; the probationaryTrials requirement keeps
// confidence out of promotion decisions until observed n is meaningful.
export function reliability({ verifiedSuccesses = 0, verifiedFailures = 0, priorOnly = null }) {
  const s = Math.max(0, Math.floor(Number(verifiedSuccesses) || 0));
  const f = Math.max(0, Math.floor(Number(verifiedFailures) || 0));
  const n = s + f;
  const eta = n === 0 ? 0.5 : (1 + s) / (2 + n);
  // Variance of the posterior (conservative width indicator).
  const variance = n === 0 ? 1 / 12 : (s + 1) * (f + 1) / ((2 + n) ** 2 * (3 + n));
  return {
    eta: Math.round(eta * 1000) / 1000,
    sampleN: n,
    variance: Math.round(variance * 10000) / 10000,
    // Confidence gates the CALLER decides; this module only states what the
    // sample can support. These floors are deliberately strict.
    trustworthy: n >= 3 && eta >= 0.6,
    probationRequired: n > 0 && n < 3,
    priorNote: "Beta(1,1); observed verified outcomes only; no model self-ratings consume into estimate",
  };
}

// Eligibility floors for crystallisation attempts (skill pipeline calls this
// before even DRAFTING a skill from a policy draft): directive §19 requires
// verified trigger, reusable procedure, supporting episodes, prerequisites,
// verification instructions, boundaries. Mechanical: all-named fields present.
export function eligibilityCheck(draft = {}) {
  const missing = [];
  if (!draft?.triggerElement) missing.push("trigger");
  if (!draft?.procedure?.length) missing.push("procedure");
  if (!draft?.supportingEpisodeIds?.length) missing.push("supporting-episodes");
  if (!draft?.verificationGuidance) missing.push("verification-instructions");
  if (!draft?.applicability) missing.push("boundaries");
  if (draft?.stepCredits?.meanVWith == null) missing.push("verified-outcome-gain");
  // Small-sample conservative cap: fewer than 3 supporting runs ⇒ provisional
  // status even when mechanically eligible (§19: statistical reliability floor).
  const provisional = (draft?.supportingEpisodeIds?.length ?? 0) < 3;
  return { eligible: missing.length === 0 && !provisional, provisional, missing, status: missing.length === 0 && !provisional ? "VERIFIED" : "CANDIDATE" };
}
