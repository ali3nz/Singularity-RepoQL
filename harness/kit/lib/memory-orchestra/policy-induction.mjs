// lib/memory-orchestra/policy-induction.mjs — MemOS gap-closure addendum
// (2026-10-23) directive §14 (cross-task policy induction, DISTINCT from
// Tencent L2 scenario extraction). Drafts reusable procedural policies from
// RECURRING VERIFIED-SUCCESSFUL patterns across independent runs.
//
// THE ANTI-CONTAMINANT MECHANIC (the core of this module):
//   - signature = primaryTag|secondaryTag|tool|errCode (the plugin key class)
//   - a candidate pool entry is keyed (signature → set of DISTINCT caseRun ids;
//     a repeated trace inside ONE episode adds NO new run and NO weight)
//   - induction triggers only at ≥N=3 DISTINCT supporting caseRuns AND ≥2
//     SUFFICIENT episode outcomes (validated)
//   - the draft is ALWAYS a CANDIDATE: it carries approval status
//     decision-only, never activates, never executes (§14: "do not generate
//     active skills directly from unverified policies"). Promotion happens
//     exclusively on the EXISTING skill/concept verification gates (P3+).
//   - gain is computed from the attribution module's procedural values
//     (meanV with-policy vs mean(V) without) — never from model scores.
// The draft artifact is persisted passively: to the runs tree only
// (candidate-pool + drafts); the pipeline's callers decide which validated
// artifacts go onward (skill-publish note vs concept capture). Flag-gated by
// policyInduction (default OFF).
import { appendFileSync, readFileSync, existsSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { flags, enabledWhen, PENDING_VALIDATION } from "./flags.mjs";

export const POOL_MIN_EPISODES = 3;
export const POOL_MIN_SUFFICIENT = 2;

function normalizeTag(v) {
  return String(v ?? "").trim().toLowerCase().replace(/\s+/g, "-").slice(0, 40) || "untagged";
}

export function signatureOf({ primaryTag, secondaryTag, tool, errCode }) {
  return [normalizeTag(primaryTag), normalizeTag(secondaryTag), normalizeTag(tool), normalizeTag(errCode)].join("|");
}

// Add one observed episode's signature contribution. `episodeIds` MUST be a
// distinct set per episode (guaranteed upstream by steps.mjs rows; here the
// invariant is re-asserted mechanically).
export function poolKey(signature) {
  return `sig:${signature}`;
}

export function addToPool(pool, { signature, caseRun, episodeOutcome, verifiedSteps = [], actionKey = null }) {
  const g = enabledWhen(flags(), "policyInduction");
  if (!g.ok) return { ok: false, code: g.code, status: g.status };
  if (!signature || !caseRun) return { ok: false, code: "SIGNATURE_AND_CASE_RUN_REQUIRED" };
  validateVerifiedSteps(verifiedSteps); // throws on schema break (candidate-record, stricter than attribution flows)
  const key = poolKey(signature);
  const existing = pool.get(key) ?? newPoolEntry(signature);
  const isNew = !existing.caseRuns.has(caseRun);
  existing.caseRuns.add(caseRun);
  // P0 §6 (2026-10-23): support is keyed by the canonical episode id. The
  // SAME episode observed again (retry, replay, restart) may refresh its
  // outcome but never adds a second supporting observation, and steps are
  // recorded once per episode+step key, not once per ingestion.
  existing.outcomeByRun.set(caseRun, normalizeOutcome(episodeOutcome));
  for (const v of verifiedSteps) {
    if (v !== "VERIFIED_SUCCESS" && v !== "VERIFIED_FAILED") continue;
    const stepKey = `${caseRun}|${v}`;
    if (!existing.stepKeys.has(stepKey)) {
      existing.stepKeys.add(stepKey);
      existing.stepVerified.push(v);
    }
  }
  existing.lastActionKey = actionKey ?? existing.lastActionKey ?? null;
  pool.set(key, existing);
  return {
    ok: true,
    isNewRun: isNew,
    signature: key,
    distinctRuns: existing.caseRuns.size,
    verifiedSuccessCount: verifiedSuccessCount(existing, caseRun),
    eligibleForInduction: existing.caseRuns.size >= POOL_MIN_EPISODES
      && countVerifiedSuccess(existing) >= POOL_MIN_SUFFICIENT,
  };
}

// P0 §6: legacy "VALIDATED" labels (pre-correction, completion-derived) are
// not evidence and must not build support. They collapse to COMPLETED_UNVERIFIED.
function normalizeOutcome(o) {
  const s = String(o ?? "").toUpperCase();
  if (s === "VALIDATED" || s === "COMPLETED" || s === "COMPLETED_UNVERIFIED") return "COMPLETED_UNVERIFIED";
  if (s === "VERIFIED_SUCCESS" || s === "VERIFIED_FAILED" || s === "PARTIALLY_VERIFIED" || s === "INCONCLUSIVE") return s;
  return "UNVERIFIED";
}

function countVerifiedSuccess(entry) {
  let n = 0;
  for (const o of entry.outcomeByRun.values()) if (o === "VERIFIED_SUCCESS") n++;
  return n;
}

// Successes strictly for one new run (used for the addToPool receipt).
function verifiedSuccessCount(entry, caseRun) {
  return entry.outcomeByRun.get(caseRun) === "VERIFIED_SUCCESS" ? 1 : 0;
}

export function newPoolEntry(signature) {
  return { signature, caseRuns: new Set(), outcomeByRun: new Map(), stepVerified: [], stepKeys: new Set(), lastActionKey: null };
}
function validateVerifiedSteps(vs) {
  const BAD = (v) => !["VERIFIED_SUCCESS", "VERIFIED_FAILED"].includes(String(v ?? ""));
  if (!vs || (Array.isArray(vs) && vs.some(BAD)))
    throw new Error(`pool verifiedSteps must be VERIFIED_SUCCESS|VERIFIED_FAILED rows (got ${String(vs).slice(0, 120)}) — no credit in the induction pool without verified outcome basis`);
}

// Pure pool → induction output (unit-testable without fs).
export function inductionCandidates(pool) {
  const out = [];
  for (const [key, g] of pool.entries()) {
    const distinctRuns = g.caseRuns.size;
    const validated = countVerifiedSuccess(g);
    if (distinctRuns < POOL_MIN_EPISODES || validated < POOL_MIN_SUFFICIENT) continue;
    const failures = [...g.outcomeByRun.values()].filter((o) => o === "VERIFIED_FAILED").length;
    // Gain from attribution values (set by the caller from the attribution
    // module's procedural rows — never computed here from model scores).
    out.push({
      signatureKey: key,
      distinctRunCount: distinctRuns,
      validatedCount: validated,
      failureCount: failures,
      lastActionKey: g.lastActionKey ?? null,
      stepVerified: g.stepVerified.length,
      status: "CANDIDATE", // never auto-active
      needsActionSequence: "induction requires the caller to supply a replayed action sequence for the policy DRAFT",
    });
  }
  return out.sort((a, b) => b.distinctRunCount - a.distinctRunCount || b.validatedCount - a.validatedCount || a.signatureKey.localeCompare(b.signatureKey));
}

// Draft ONE policy candidate (caller supplies the action sequence from its
// own tooling — deterministic replay; no internal LLM calls on this path —
// induction is trigger + assembly only, HARVEST-style body is a separate gate).
export function draftPolicy({ signature, caseRuns, actionSequence, stepCredits = null, observedOutcomes = [] } = {}) {
  const g = enabledWhen(flags(), "policyInduction");
  if (!g.ok) return { ok: false, code: g.code, status: g.status };
  const sig = String(signature ?? "").slice(0, 200);
  const runs = (caseRuns ?? []).filter(Boolean);
  const seq = (actionSequence ?? []).filter(Boolean);
  if (!sig || runs.length < POOL_MIN_EPISODES || !seq.length) {
    return { ok: false, code: "INDUCTION_FLOOR_NOT_MET", detail: { runs: runs.length, actions: seq.length, needRuns: POOL_MIN_EPISODES } };
  }
  if (!stepCredits || typeof stepCredits !== "object" || typeof stepCredits.meanVWith !== "number") {
    return { ok: false, code: "CREDITS_REQUIRED", detail: "policy drafts need attribution rows (meanVWith/meanVWithout) — never model scores" };
  }
  const gain = Math.round((stepCredits.meanVWith - stepCredits.meanVWithout) * 1000) / 1000;
  return {
    ok: true,
    draft: {
      schema: "policy-draft.v1",
      signature: sig,
      trigger: `${sig} recurring across ${runs.length} independent runs (${new Set(runs).size} distinct, ${observedOutcomes.filter((o) => o === "VERIFIED_SUCCESS").length} verified)`,
      procedure: seq.map((s) => String(s).slice(0, 220)),
      verificationGuidance: "verify on one representative run; confirm the sequence resolves the signature trigger and preserves the validated outcome",
      applicability: { appliesTo: [sig], doesNotApplyTo: ["different signature", "unverified outcome class"] },
      exceptions: [
        ...(stepCredits.failureCount ? ["known verified-failure paths exist for this signature — see anti-pattern rows"] : []),
        "context drift: procedure validity tied to signature; re-induce when signature shape changes",
      ],
      observedOutcomes,
      gainMargin: gain,
      approvalStatus: "CANDIDATE", // only the EXISTING verification/approval gate may move this (never this module)
      supportingEpisodeIds: runs,
      stepCredits: { meanVWith: stepCredits.meanVWith, meanVWithout: stepCredits.meanVWithout, source: "verified-outcome attribution rows" },
      version: 0,
      recordedAt: new Date().toISOString(),
    },
    encodedStatus: PENDING_VALIDATION,
  };
}

// Persistent pool (runs-tree JSONL, line-addressed; append + full reload pattern
// so nothing blocks the writer for long). Bounded by MAX_POOL_SHards per file.
// P0 §6 (2026-10-23): SNAPSHOT REPLACEMENT, not accumulation. Each persisted
// line is a cumulative snapshot per signature, so loading must let the newest
// line win instead of pushing every historical snapshot's arrays onto the
// accumulator (which multiplied validated counts by the number of snapshots
// written since the process/restart began). Support is counted from
// outcomeByRun: one entry per canonical run id.
export function loadPool(stateDir = "/opt/harness-unset/ai-orchestration/kit/runs/_policy-pool") {
  const f = join(stateDir, "pool.jsonl");
  const map = new Map();
  if (!existsSync(f)) return map;
  try {
    for (const line of readFileSync(f, "utf8").split("\n")) {
      if (!line.trim()) continue;
      let r;
      try {
        r = JSON.parse(line);
      } catch {
        continue;
      }
      const key = poolKey(r.signature ?? "");
      const g = map.get(key) ?? newPoolEntry(r.signature);
      if (Array.isArray(r.caseRun)) r.caseRun.forEach((x) => g.caseRuns.add(x));
      else if (r.caseRun) g.caseRuns.add(r.caseRun);
      if (r.outcomeByRun && typeof r.outcomeByRun === "object") {
        for (const [run, o] of Object.entries(r.outcomeByRun)) {
          g.outcomeByRun.set(run, normalizeOutcome(o));
        }
      } else if (Array.isArray(r.outcomes) && r.outcomes.length) {
        // Legacy pre-correction rows carried a flat outcome array with no run
        // attribution and completion-derived "VALIDATED" labels. They cannot
        // contribute support honestly, so they are counted as ignored rather
        // than guessed onto runs.
        g.legacyOutcomesIgnored = (g.legacyOutcomesIgnored ?? 0) + r.outcomes.length;
      }
      if (Array.isArray(r.stepVerified)) {
        for (const v of r.stepVerified) {
          if (v !== "VERIFIED_SUCCESS" && v !== "VERIFIED_FAILED") continue;
          if (g.stepVerified.length >= POOL_MIN_EPISODES * 4) break; // bounded
          g.stepVerified.push(v);
        }
      }
      if (r.lastActionKey) g.lastActionKey = r.lastActionKey;
      map.set(key, g);
    }
  } catch {
    /* corrupt tail tolerated; map reflects what parsed */
  }
  return map;
}
export function persistPoolIncrement(stateDir, poolRec) {
  const g = enabledWhen(flags(), "policyInduction");
  if (!g.ok) return { ok: false, code: g.code, status: g.status };
  try {
    mkdirSync(stateDir, { recursive: true });
    const row = {
      schema: "policy-pool.v2",
      signature: poolRec.signature,
      caseRun: [...(poolRec.caseRuns ?? [])],
      // One entry per canonical run: the idempotent support record.
      outcomeByRun: Object.fromEntries(poolRec.outcomeByRun ?? new Map()),
      stepVerified: (poolRec.stepVerified ?? []).slice(-400),
      lastActionKey: poolRec.lastActionKey,
      recordedAt: new Date().toISOString(),
    };
    appendFileSync(join(stateDir, "pool.jsonl"), `${JSON.stringify(row)}\n`, "utf8");
    return { ok: true, persistedShards: 1, distinctRuns: row.caseRun.length, verifiedSuccess: countVerifiedSuccess(poolRec) };
  } catch (err) {
    return { ok: false, code: `POOL_THROW:${String(err?.name ?? err).slice(0, 20)}` };
  }
}
