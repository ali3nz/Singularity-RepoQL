// lib/memory-orchestra/attribution.mjs — MemOS gap-closure addendum
// (2026-10-23) directive §13 (verified step-level credit assignment).
// Evidence-grounded, NOT model-score-grounded ("do not copy model-generated
// reward scores as unquestioned facts").
//
//   u_t  = run-outcome basis: VERIFIED_SUCCESS ⇒ +1, VERIFIED_FAILURE ⇒ −1,
//          COMPLETED_UNVERIFIED / PARTIALLY_VERIFIED / INCONCLUSIVE ⇒ 0
//          (a completed run is not a verified success — P0 §5)
//          (and a 0-basis step can NEVER be positively credited).
//   V_T  = R (the run's outcome); here R comes ONLY from the episode rollup
//          (buildEpisode/runStateToOutcome), i.e. terminal states that are
//          themselves validated by the EXISTING run discipline (operator
//          acceptance, deploy receipts, Sol verdicts). UNVERIFIED runs
//          contribute V ≡ 0 for ALL their steps (no positive credit anywhere).
//   V_t  = α_t·R + (1−α_t)·γ·V_{t+1}   (γ=0.85; α_t later ⇒ 0.80, earlier 0.55;
//          explicit-code/doc-engineering steps are capped at α=0.55 — that
//          class of step must not dominate an epistemic outcome).
//  PROCEDURAL VALUE of an action = mean(V) over DISTINCT episodes where the
//          action occurs (anti-contamination: repeated occurrences inside ONE
//          episode may not raise its own weight — distinct-episode identity is
//          the guard, the same rule as the policy-induction pool).
//  NEGATIVE EXAMPLES are first-class: repeated ineffective actions and
//          verified-failure contributors surface as anti-patterns for
//          decision-repair ("avoid this step"), never as positive credit.
// Pure functions only; storage lives in lib/steps store files (FETCHED by the
// caller as plain objects) — nothing here reads the filesystem (leaf-pure).
// Gated: caller checks flags.attribution (this module's exports are inert data
// transforms that cannot act without input rows — reads none, writes none).

// Step record contract (from lib/memory-orchestra/steps.mjs rows):
// { runId, ordering, tool, actionType, summaryRep, actionRep, outcomeRep,
//   errorSignature, verified: VERIFIED_SUCCESS | VERIFIED_FAILED | UNVERIFIED }

const GAMMA = 0.85;

export function basisOfStep(step) {
  if (step?.verified === "VERIFIED_SUCCESS") return "VERIFIED_SUCCESS";
  if (step?.verified === "VERIFIED_FAILED") return "VERIFIED_FAILED";
  return "UNVERIFIED";
}

export function creditRun(steps, runOutcome) {
  // P0 §5 (2026-10-23): the run basis is evidence-only. COMPLETED_UNVERIFIED /
  // PARTIALLY_VERIFIED / INCONCLUSIVE / UNVERIFIED all yield R = 0 and grant no
  // positive credit — a finished run is not a verified success. Legacy
  // "VALIDATED" labels from pre-correction rollups are treated as unverified.
  if (runOutcome !== "VERIFIED_SUCCESS" && runOutcome !== "VERIFIED_FAILURE") {
    return steps.map((s) => ({ ...s, V: 0, eligibleForCredit: false, basis: basisOfStep(s) }));
  }
  const R = runOutcome === "VERIFIED_SUCCESS" ? 1 : -1;
  const n = steps.length;
  const out = steps.map((s, i) => ({ ...s, basis: basisOfStep(s) }));
  const depth = (i) => (n <= 1 ? 0 : i / Math.max(1, n - 1)); // 0 (early) → 1 (last)
  for (let i = n - 1; i >= 0; i--) {
    let alpha = 0.55 + 0.25 * depth(i); // later ⇒ higher α
    if (/^(code|doc|tool=doc|documentation)$/i.test(String(steps[i]?.tool ?? ""))) alpha = Math.min(alpha, 0.55);
    let V;
    if (i === n - 1) {
      V = R;
    } else {
      const next = out[i + 1].V ?? 0;
      V = alpha * R + (1 - alpha) * GAMMA * next;
    }
    out[i].V = Math.round(V * 1000) / 1000;
    out[i].alpha = Math.round(alpha * 100) / 100;
    out[i].eligibleForCredit = out[i].basis === "VERIFIED_SUCCESS" && out[i].V > 0;
    out[i].antiPattern = out[i].basis === "VERIFIED_FAILED" ? "verified-failed contributor" : out[i].V < -0.2 ? "negative-path step" : false;
  }
  return out;
}

// Roll episodes → action-keycentred procedural values. `actionKeyOf` gives the
// caller control (default: tool + actionType + normalized summary verb head).
export function proceduralValue(creditsPerEpisode, { actionKeyOf = defaultActionKey, minEpisodes = 2, minVerifiedValidated = 1 } = {}) {
  const groups = new Map();
  for (const { caseRun, steps, outcome } of creditsPerEpisode) {
    for (const s of steps) {
      const k = actionKeyOf(s);
      if (!k) continue;
      const g = groups.get(k) ?? { key: k, episodes: new Set(), values: [], outcomeByEpisode: new Map() };
      g.episodes.add(caseRun);
      g.values.push({ V: s.V ?? 0, basis: s.basis ?? "UNVERIFIED", eligible: s.eligibleForCredit === true });
      // P0 §6: an episode's outcome is counted ONCE per episode, not once per
      // step — otherwise a 20-step run reports 20 "validated runs".
      g.outcomeByEpisode.set(caseRun, outcome ?? "UNVERIFIED");
      groups.set(k, g);
    }
  }
  const out = [];
  for (const g of groups.values()) {
    const eligible = g.values.filter((x) => x.eligible);
    const distinctEpisodes = g.episodes.size;
    const validatedRuns = [...g.outcomeByEpisode.values()].filter((o) => o === "VERIFIED_SUCCESS").length;
    const meanV = g.values.length ? g.values.reduce((a, x) => a + x.V, 0) / g.values.length : 0;
    const failureCount = g.values.filter((x) => x.basis === "VERIFIED_FAILED").length;
    out.push({
      key: g.key,
      distinctEpisodes,
      meanV: Math.round(meanV * 1000) / 1000,
      eligibleCount: eligible.length,
      validatedRuns,
      failureCount,
      // Conservative floors: fewer than minEpisodes distinct runs or zero
      // validated outcomes ⇒ NOT creditable (§13 "a small number of successes
      // must not create unjustified confidence" is enforced at the P3 skill
      // crystallisation stage with stricter floors; here neutral value only).
      creditable: distinctEpisodes >= minEpisodes && validatedRuns >= minVerifiedValidated && eligible.length > 0,
      antiPattern: failureCount >= 2 && eligible.length === 0,
    });
  }
  return out.sort((a, b) => (b.meanV - a.meanV) || b.failureCount - a.failureCount || a.key.localeCompare(b.key));
}

// Recency decay for value evidence within ONE group (bounded exponential on
// age in days; recognizable, documented reduction — not hidden arithmetic).
export function recencyDecayWeight(ageDays, { halfLifeDays = 45 } = {}) {
  const d = Math.max(0, Number(ageDays) || 0);
  return Math.pow(0.5, d / halfLifeDays);
}

function defaultActionKey(s) {
  const verb = String(s?.actionRep ?? s?.actionType ?? "").toLowerCase().split(/\s+/)[0] ?? "";
  const tool = String(s?.tool ?? "").toLowerCase().slice(0, 24);
  const err = s?.errorSignature ? `|${String(s.errorSignature).slice(0, 48)}` : "";
  if (!verb && !tool && !err) return null;
  return `${verb}|${tool}${err}`;
}
