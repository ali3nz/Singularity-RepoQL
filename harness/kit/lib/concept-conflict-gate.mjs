// lib/concept-conflict-gate.mjs — second-brain delta 2 (hub ticket 180, Sol consult
// 2026-09-29T10-07-37-757-85087). evaluateCandidateConflict(): the epistemic gate
// that decides whether a memory candidate may safely proceed to promotion.
//
// CONTRACT (Sol, inviolable):
//   - Dispositions: NO_CONFLICT | DUPLICATE | SUPERSEDES | CONTRADICTS | UNCERTAIN.
//   - Epistemic ONLY: this module never routes to a store (hub/journal/RepoQL
//     routing is the promotion router's job) and never writes — captureConcept()
//     stays the single mechanical effect.
//   - The model proposes relations; review adjudicates: CONTRADICTS/UNCERTAIN stop
//     automatic capture and go to review; SUPERSEDES requires an explicit
//     supersedesRef; the model never silently mutates existing Concepts.
//   - Extends the existing explore-first gate (findSemanticNearMatches /
//     findDuplicateConcept), NOT the inside of captureConcept().
//   - Negative knowledge (fleet rule): "no hit" is "not observed", NEVER "observed
//   - "Absence of evidence is not evidence of absence" — encoded as retrieval
//     triage (Sol evidence-turn 2026-09-29T19-08-31): retrievalStatus=OK with
//     zero hits is valid NEGATIVE search evidence (may evaluate NO_CONFLICT);
//     retrievalStatus=FAILED (RepoQL unreachable/timeout/expired) returns
//     UNCERTAIN + requiresReview — the conflict plane was uninspectable, so no
//     capture may proceed. ZERO_RESULTS ≠ REPOQL_UNREACHABLE.
//   - Memory never verifies itself: a candidate whose only provenance is derived
//     (memory about memory) or which shares its source uri with the matched
//     capsule cannot CONFIRM a conflict against that capsule (hasIndependentProvenance).
//   - Contradiction vs a RepoQL `rule` capsule = rule contradiction -> requiresSol
//     (Sol trigger: contradiction with an existing rule). Ordinary factual
//     contradictions do NOT auto-call Sol (turn-2 narrowing) — they hold for review.
import { findDuplicateConcept, findSemanticNearMatches, isUniversalRelevance } from "./concept-capture.mjs";
import { hasIndependentProvenance, isDerivedProvenance, precedenceRank } from "./memory-candidate-v2.mjs";
import { evaluateTombstones } from "./memory-tombstone.mjs"; // ticket 191: rejected-value enforcement
import { nativeMemoryPolicyEnabled, nativeConflictSignal, nativeExtractInvariant, nativeParseCapsule } from "./native-memory-policy.mjs";

export const CONFLICT_DISPOSITIONS = new Set(["NO_CONFLICT", "DUPLICATE", "SUPERSEDES", "CONTRADICTS", "UNCERTAIN", "TOMBSTONED"]);
// Sol-review triggers (turn-2 narrowing to the operator plan's exact table):
// only these dispositions on rule-class material escalate to Sol automatically.
export const SOL_TRIGGERS = new Set(["NEW_GLOBAL_RULE", "RULE_CONTRADICTION", "HIGH_IMPACT_BEHAVIOUR"]);

// Extract the invariant claim from a capsule body (existing capsule format:
// "**Invariant**\n<text until next **Bold** heading>").
function jsExtractInvariant(body) {
  const m = String(body ?? "").match(/\*\*Invariant\*\*\s*\n([\s\S]*?)(?=\n\*\*|$)/);
  return (m?.[1] ?? "").trim();
}

// Read the YAML-lite frontmatter fields the lifecycle + gate need. Line-based on
// purpose (no YAML dep; the capsule emitter writes simple one-line keys + the
// verified: block). Returns { description, category, relevance, verification, ttl,
// verifiedDate, title } — unknown keys ignored, unparseable file returns {}.
function jsParseCapsule(body) {
  const out = { title: null, description: null, category: null, relevance: null, verification: null, ttl: null, verifiedDate: null };
  if (body == null) return out;
  const text = String(body);
  const titleM = text.match(/^#\s+(.+)$/m);
  if (titleM) out.title = titleM[1].trim();
  const fm = text.match(/^---\n([\s\S]*?)\n---/);
  if (!fm) return out;
  const lines = fm[1].split("\n");
  let inVerified = false;
  for (const line of lines) {
    const kv = line.match(/^(\w[\w-]*):\s*(.*)$/);
    if (!kv) continue;
    const [, k, rawV] = kv;
    const v = String(rawV).trim().replace(/^["']|["']$/g, "");
    if (k === "verified") { inVerified = true; continue; }
    if (inVerified && k === "date") { out.verifiedDate = v; inVerified = false; continue; }
    inVerified = false;
    if (k === "description") out.description = v;
    else if (k === "category") out.category = v;
    else if (k === "relevance") out.relevance = v;
    else if (k === "verification") out.verification = v;
    else if (k === "ttl") out.ttl = Number(v) || null;
  }
  return out;
}

// Negation-aware contradiction test between two claims. Deterministic, conservative:
// - normalized equality -> not a conflict (dup check owns that path)
// - one-sided negation ("X is not Y" vs "X is Y") -> CONTRADICTS
// - explicit antonym pairs -> CONTRADICTS
// - otherwise null (caller treats as UNCERTAIN only if other signals say so)
const ANTONYMS = [
  ["required", "forbidden"], ["required", "optional"], ["never", "always"], ["must", "must not"],
  ["enabled", "disabled"], ["up", "down"], ["true", "false"], ["is", "is not"],
  ["retired", "active"], ["deprecated", "supported"], ["primary", "retired"], ["allowed", "rejected"],
];
function jsContradictionSignal(claimA, claimB) {
  const norm = (s) => String(s ?? "").toLowerCase().replace(/[^a-z0-9 ]/g, " ").replace(/\s+/g, " ").trim();
  const a = norm(claimA), b = norm(claimB);
  if (!a || !b) return null;
  if (a === b) return null; // identity is the duplicate checker's job, not conflict
  for (const [x, y] of ANTONYMS) {
    const hasAx = a.includes(` ${x} `) || a.startsWith(`${x} `) || a.endsWith(` ${x}`);
    const hasBx = b.includes(` ${x} `) || b.startsWith(`${x} `) || b.endsWith(` ${x}`);
    const hasAy = a.includes(` ${y} `) || a.startsWith(`${y} `) || a.endsWith(` ${y}`);
    const hasBy = b.includes(` ${y} `) || b.startsWith(`${y} `) || b.endsWith(` ${y}`);
    // Antonym present in BOTH is not automatically a conflict (could be discussing
    // the same polarity); one side has x where the other has y on a shared subject
    // stem IS the classic contradiction shape.
    const stem = (s, w) => s.split(` ${w} `)[0].trim();
    if (hasAx && hasBy) { const sa = stem(a, x), sb = stem(b, y); if (sa && sb && (sa.includes(sb) || sb.includes(sa))) return `antonym ${x}/${y} on shared subject "${(sa.length <= sb.length ? sa : sb).slice(-40)}"`; }
    if (hasAy && hasBx) { const sa = stem(a, y), sb = stem(b, x); if (sa && sb && (sa.includes(sb) || sb.includes(sa))) return `antonym ${y}/${x} on shared subject "${(sa.length <= sb.length ? sa : sb).slice(-40)}"`; }
  }
  return null;
}

// Numeric-divergence signal: same normalized skeleton with different numbers
// ("window is 14 days" vs "window is 30 days"). Near-matches with divergent
// numbers are possible changed-value facts — NEVER silently merged (delta 4
// would expire one side on a wrong premise); they hold for review instead.
function jsNumericDivergenceSignal(claimA, claimB) {
  const norm = (s) => String(s ?? "").toLowerCase().replace(/[^a-z0-9 ]/g, " ").replace(/\s+/g, " ").trim();
  const a = norm(claimA), b = norm(claimB);
  if (!a || !b) return null;
  const skel = (s) => s.replace(/\d+/g, "#");
  if (skel(a) !== skel(b)) return null;
  const numsA = a.match(/\d+/g) ?? [];
  const numsB = b.match(/\d+/g) ?? [];
  if (!numsA.length) return null;
  return numsA.some((n, i) => n !== numsB[i]) ? `numeric divergence (${numsA.join("/")} vs ${numsB.join("/")})` : null;
}

// Rust may replace these pure calculations when explicitly enabled. The
// production conflict/review decision remains owned by this module.
export function extractInvariant(body) {
  return nativeMemoryPolicyEnabled() ? nativeExtractInvariant(String(body ?? "")) : jsExtractInvariant(body);
}

export function parseCapsule(body) {
  return nativeMemoryPolicyEnabled() ? nativeParseCapsule(body == null ? null : String(body)) : jsParseCapsule(body);
}

export function contradictionSignal(claimA, claimB) {
  return nativeMemoryPolicyEnabled()
    ? nativeConflictSignal("contradiction-signal", String(claimA ?? ""), String(claimB ?? ""))
    : jsContradictionSignal(claimA, claimB);
}

export function numericDivergenceSignal(claimA, claimB) {
  return nativeMemoryPolicyEnabled()
    ? nativeConflictSignal("numeric-divergence", String(claimA ?? ""), String(claimB ?? ""))
    : jsNumericDivergenceSignal(claimA, claimB);
}

function dupShapeToDisposition(dup) {
  if (!dup?.duplicate) return null;
  return "DUPLICATE";
}

// The gate. Inputs stay bounded; no direct writes anywhere.
//   candidate : memory-candidate-v2 (validateCandidateV2 output) — needs claim,
//               provenance, optional subject
//   matches   : pre-retrieved existing-memory hits [{uri, body, title?, category?}]
//               (caller = the explore-first step; the gate stays pure)
//   opts      : { findDuplicate: null | fn(conceptsDir, {name, invariant}) -> dup,
//                 conceptsDir, claimOverrides }
// Returns { disposition, matches, reason, requiresReview, requiresSol?, trigger? }.
export function evaluateCandidateConflict(candidate, { matches = [], findDuplicate = null, conceptsDir = null, candidateName = null, retrievalStatus = "OK", tombstones = [] } = {}) {
  const result = { disposition: "NO_CONFLICT", matches: [], reason: "", requiresReview: false, requiresSol: false, trigger: null };

  // 0a. Retrieval triage (fail-closed): a failed semantic lookup means the gate
  //     could NOT inspect the existing knowledge corpus — hold, never capture
  //     blind. OK + zero matches remains the only path to evidence-backed
  //     NO_CONFLICT on the semantic plane.
  if (retrievalStatus !== "OK") {
    result.disposition = "UNCERTAIN";
    result.reason = `retrievalStatus=${retrievalStatus} — conflict plane uninspectable (absence of evidence is not no-conflict)`;
    result.requiresReview = true;
    return result;
  }

  // 0b. Rejected-value tombstone check (ticket 191; Sol Gate 1). Decisive and
  //      provenance-independent: even an independently-evidenced candidate is
  //      blocked while the tombstone is active — the ONLY override is governed
  //      tombstone retirement (memory-tombstone.retireTombstone). Tombstone
  //      matches are passed in pre-loaded (tombstones: [{...}]) so this gate
  //      stays pure, mirroring the `matches` contract; callers that cannot
  //      load the index must NOT call this function with unknown state — they
  //      hold upstream (applyFindings holds on TOMBSTONE_INDEX_UNREADABLE).
  if (Array.isArray(tombstones) && tombstones.length) {
    const ev = evaluateTombstones({ subject: candidateName ?? candidate.subject ?? null, field: null, claim: candidate.claim, scope: candidate.relevance ?? null, tombstones }); // ticket 305: was opts.tombstones (undefined) — ReferenceError whenever a tombstone index reached the gate
    if (ev.blocked) {
      result.disposition = "TOMBSTONED";
      result.reason = ev.reason;
      result.matches.push({ uri: ev.tombstone.file ?? null, kind: "tombstone", via: "rejected-value" });
      result.requiresReview = true; // override goes through governed retirement, never re-adjudication here
      return result;
    }
  }

  // 0. Derived-only provenance: memory about memory may proceed as observation but
  //    can never be auto-promoted — hold for review (feedback-loop defense).
  if (isDerivedProvenance(candidate)) {
    result.disposition = "UNCERTAIN";
    result.reason = "all provenance is derived (memory about memory) — not independent evidence (Sol further-issue 4)";
    result.requiresReview = true;
    return result;
  }

  // 1. Hard duplicate check (existing mechanical identity) when a finder is given.
  if (findDuplicate && conceptsDir && candidateName) {
    const dup = findDuplicate(conceptsDir, { name: candidateName, invariant: candidate.claim });
    const d = dupShapeToDisposition(dup);
    if (d) {
      result.disposition = d;
      result.reason = dup.reason ?? "mechanical duplicate";
      result.matches.push({ uri: dup.file ?? null, kind: "duplicate", via: "hard-dedupe" });
      result.requiresReview = true; // merge/reject is a review decision, not auto-delete
      return result;
    }
  }

  // 2. Evaluate retrieved matches. Precedence of dispositions within the gate:
  //    CONTRADICTS > SUPERSEDES > UNCERTAIN > NO_CONFLICT.
  let worst = "NO_CONFLICT";
  let worstReason = "";
  for (const m of matches) {
    const entry = { uri: m.uri ?? null, category: m.category ?? null, via: m.via ?? "retrieval", relation: null };
    result.matches.push(entry);
    const independent = hasIndependentProvenance(candidate, { excludeUri: m.uri });
    const invariant = m.invariant ?? (extractInvariant(m.body ?? "") || m.headline || "");
    const sig = contradictionSignal(candidate.claim, invariant || m.description || "");
    if (sig) {
      if (!independent) {
        // Same-source or derived-only backing: cannot confirm a contradiction against
        // this capsule — memory does not verify itself; downgrade to UNCERTAIN.
        entry.relation = "UNCERTAIN";
        entry.reason = `contradiction signal (${sig}) but provenance not independent of ${m.uri}`;
        if (worst === "NO_CONFLICT") { worst = "UNCERTAIN"; worstReason = entry.reason; }
        continue;
      }
      // Which side is CURRENT? Precedence classes (never numeric confidence):
      // if the existing side outranks the candidate's evidence, the new claim is
      // stale -> SUPERSEDES-shaped hold rather than a truth flip; if the candidate
      // is at least as authoritative, it is a genuine CONTRADICTS for review.
      const candRank = precedenceRank(candidate) ?? 20;
      const existingRank = m.precedence ?? (m.category === "rule" || m.category === "knowledge" || m.category === "wisdom" ? 70 : 40);
      if (existingRank > candRank) {
        entry.relation = "SUPERSEDES";
        entry.reason = `conflicting (${sig}) but existing side outranks candidate evidence (${existingRank} > ${candRank}) — candidate is stale, review before any supersede`;
        if (worst === "NO_CONFLICT" || worst === "UNCERTAIN") { worst = "SUPERSEDES"; worstReason = entry.reason; }
      } else {
        entry.relation = "CONTRADICTS";
        entry.reason = `contradicts existing ${m.category ?? "memory"}: ${sig}`;
        if (worst !== "CONTRADICTS") { worst = "CONTRADICTS"; worstReason = entry.reason; }
      }
      continue;
    }
    // Semantic near-match with no contradiction signal: the explore-first contract
    // says merge evidence into the existing capsule rather than capture anew —
    // UNLESS the near-match carries numeric divergence (possible changed value),
    // which holds for review instead of merging.
    if (m.semanticNear) {
      const numeric = numericDivergenceSignal(candidate.claim, invariant || m.description || "");
      if (numeric) {
        entry.relation = "UNCERTAIN";
        entry.reason = `semantic near match with ${numeric} — review before any merge/expire`;
        if (worst === "NO_CONFLICT") { worst = "UNCERTAIN"; worstReason = entry.reason; }
      } else {
        entry.relation = "DUPLICATE";
        entry.reason = "semantic near match — merge evidence into existing capsule";
        if (worst === "NO_CONFLICT") { worst = "DUPLICATE"; worstReason = entry.reason; }
      }
    }
  }

  // 3. Escalation + review flags. Everything except NO_CONFLICT stops automatic
  //    capture (review = human/Sol decision); only a CONTRADICTS against a
  //    `rule` capsule (or an explicit rule-class candidate conflicting) escalates
  //    to Sol automatically; ordinary factual contradictions hold for review
  //    WITHOUT Sol (turn-2 narrowing).
  if (worst !== "NO_CONFLICT") result.requiresReview = true;
  if (worst === "CONTRADICTS") {
    const ruleHit = result.matches.find((m) => m.relation === "CONTRADICTS" && m.category === "rule");
    if (ruleHit || candidate?.memoryClass === "rule") {
      result.requiresSol = true;
      result.trigger = "RULE_CONTRADICTION";
    }
  }

  result.disposition = worst;
  result.reason = worstReason;
  return result;
}

// Convenience shape for callers that want the mechanical post-evaluator object
// from the Sol NEXT ACTIONS (kept separate from the gate itself).
export function conflictResultShape(evaluation) {
  return {
    disposition: evaluation.disposition,
    matches: evaluation.matches,
    reason: evaluation.reason,
    requiresReview: evaluation.requiresReview,
  };
}

// Promotion routing (the OTHER independent decision — where does it belong?).
// Kept in this module as the explicit counterpart to the epistemic gate so nobody
// glues them together: gate first (may it proceed?), routing second (where to?).
// Post-164 MEX translation: historical event -> journal/fleet-log.
export function routePromotion(candidate, evaluation) {
  if (evaluation.disposition === "TOMBSTONED") return { route: null, reason: `rejected value is tombstoned — ${evaluation.reason ?? "governed retirement is the only override"}` };
  if (evaluation.disposition === "CONTRADICTS" || evaluation.disposition === "UNCERTAIN") return { route: null, reason: `not promotable while ${evaluation.disposition}` };
  if (evaluation.disposition === "DUPLICATE") return { route: "merge-existing", reason: evaluation.reason };
  if (evaluation.disposition === "SUPERSEDES") return { route: "supersede-review", reason: "requires explicit supersedesRef + review" };
  if (evaluation.requiresSol) return { route: "sol-review", reason: `trigger ${evaluation.trigger}` };
  // NO_CONFLICT routing per the operator plan table (post-164 translation):
  if (candidate?.memoryClass === "rule") return { route: "repoql-rule", reason: "behavioural invariant -> RepoQL rule" };
  if (candidate?.memoryClass === "wisdom") return { route: "repoql-wisdom", reason: "reusable lesson -> RepoQL wisdom" };
  if (candidate?.memoryClass === "knowledge") return { route: "repoql-knowledge-ttl", reason: "externally changing fact -> RepoQL knowledge + TTL" };
  if (candidate?.maturityState === "VERIFIED") return { route: "hub-doc-current-truth", reason: "current truth -> hub docs" };
  return { route: "journal-event", reason: "historical event -> journal/fleet-log (post-MEX)" };
}

// Live retrieval helper for callers that want the gate fed from RepoQL directly.
// Bounded: explore over concept:/// + optional hub scope; failures degrade to
// empty matches (negative knowledge: no retrieval is NOT evidence of absence).
export async function retrieveRelevantMemory(repoql, { meaning, limit = 6, timeoutMs = 12000 } = {}) {
  if (!repoql || !meaning) return { ok: false, matches: [], code: "NO_QUERY" };
  try {
    const r = await repoql.query({ q: meaning, scope: "concepts", limit });
    if (!r?.ok) return { ok: false, matches: [], code: r?.code ?? "QUERY_FAILED" };
    const matches = (r.results ?? []).slice(0, limit).map((h) => ({
      uri: h.uri, headline: String(h.headline ?? "").slice(0, 200), via: "repoql-explore", semanticNear: true,
    }));
    return { ok: true, matches };
  } catch (e) {
    return { ok: false, matches: [], code: "THREW", detail: String(e?.message ?? e).slice(0, 120) };
  }
}

export { isUniversalRelevance }; // re-export for callers composing the old checks
