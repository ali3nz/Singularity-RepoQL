import { nativeMemoryPolicyEnabled, nativeCandidatePolicy, nativeCandidateTransition, nativeCandidateTtl } from "./native-memory-policy.mjs";
// lib/memory-candidate-v2.mjs — second-brain delta 1 (hub ticket 180, Sol consult
// 2026-09-29T10-07-37-757-85087). Memory-candidate-v2: provenance-first schema with
// the operator-ladder lifecycle split. Design contract (Sol verdict, turn 2):
//   maturityState = OBSERVATION | CANDIDATE | VERIFIED   — epistemic state
//   memoryClass   = knowledge | wisdom | rule            — KIND of promoted memory
// RULE is a CLASS, never a higher confidence ("rule is not more true than verified
// knowledge"). Provenance is the hard invariant: a candidate with missing provenance
// may be logged as an observation but can NEVER advance to VERIFIED or carry a
// memoryClass ("memory without provenance should never outrank evidence").
//
// Backward compatibility: v1 candidates (lib/memory-learning.mjs validateCandidate
// output) upgrade mechanically via upgradeV1Candidate() — no v1 mutation, no
// backfill of existing Concepts (Sol: do not rewrite the existing 25 Concepts).
import { createHash } from "node:crypto";
import { candidateTemporal } from "./memory-temporal.mjs"; // ticket 191: optional bi-temporal pass-through (leaf module, no cycle)

export const MATURITY_STATES = new Set(["OBSERVATION", "CANDIDATE", "VERIFIED"]);
export const MEMORY_CLASSES = new Set(["knowledge", "wisdom", "rule"]);
// Where can a claim come from. `derived` marks memory generated from prior memory
// (feedback-loop defense — see isDerivedProvenance / hasIndependentProvenance).
export const PROVENANCE_KINDS = new Set([
  "live-evidence", "hub-doc", "journal", "conversation", "test", "operator-decision", "derived",
]);
// Precedence classes (Sol further-issue 2). NOT numeric confidence — never averaged,
// never arithmetically combined. Their one job: make "current truth is live evidence
// + hub docs" machine-visible when the conflict gate must decide which side of a
// contradiction is CURRENT. Compare only via precedenceRank(a) vs precedenceRank(b).
export const SOURCE_PRECEDENCE = {
  LIVE_EVIDENCE: 100,
  OPERATOR_DECISION: 95,
  CURRENT_HUB_DOC: 80,
  VERIFIED_CONCEPT: 70,
  JOURNAL_EVENT: 40,
  CONVERSATION: 20,
};
export function precedenceOfKind(kind) {
  const key = String(kind ?? "").toUpperCase().replace(/-/g, "_");
  return SOURCE_PRECEDENCE[key] ?? null;
}
// Highest precedence among a candidate's provenance kinds (null when unanchored).
export function precedenceRank(cand) {
  if (nativeMemoryPolicyEnabled()) return nativeCandidatePolicy(cand).precedenceRank;
  const prov = Array.isArray(cand?.provenance) ? cand.provenance : [];
  const ranks = prov.map((p) => precedenceOfKind(p.kind)).filter((r) => r != null);
  return ranks.length ? Math.max(...ranks) : null;
}

const sha16 = (s) => createHash("sha256").update(String(s ?? "")).digest("hex").slice(0, 16);

function normSubject(s) {
  return String(s ?? "").toLowerCase().replace(/[^a-z0-9:/.-]/g, "").replace(/\.+$/, "").slice(0, 120);
}

// Normalize one provenance entry. kind must be in enum; at least one locatable
// anchor (uri/caseId/runId/evidenceSha256) required. Returns {value} or {error}.
function normProvenance(p) {
  const e = typeof p === "string" ? { kind: "live-evidence", uri: p } : (p ?? {});
  const kind = String(e.kind ?? "live-evidence");
  if (!PROVENANCE_KINDS.has(kind)) return { error: `provenance.kind not in enum: ${kind}` };
  const out = {
    kind,
    uri: String(e.uri ?? "").slice(0, 300) || null,
    caseId: e.caseId != null ? String(e.caseId).slice(0, 80) : null,
    runId: e.runId != null ? String(e.runId).slice(0, 80) : null,
    observedAt: String(e.observedAt ?? "").slice(0, 40) || null,
    evidenceSha256: String(e.evidenceSha256 ?? "").slice(0, 64) || null,
  };
  if (!out.uri && !out.caseId && !out.runId && !out.evidenceSha256) return { error: "provenance entry needs uri/caseId/runId/evidenceSha256 anchor" };
  return { value: out };
}

// Validate + normalize a v2 candidate. Deterministic; throws on schema violations
// (same coordinator-validation discipline as memory-learning.validateCandidate).
export function validateCandidateV2(raw, { runNumber = null, caseId = null, phase = null, createdBy = null, seq = 1 } = {}) {
  const claim = String(raw?.claim ?? "").trim();
  if (!claim) throw new Error("memoryCandidateV2.claim required");
  const maturityState = String(raw?.maturityState ?? "OBSERVATION").toUpperCase();
  if (!MATURITY_STATES.has(maturityState)) throw new Error(`memoryCandidateV2.maturityState not in enum: ${maturityState}`);
  const memoryClass = raw?.memoryClass != null ? String(raw.memoryClass) : null;
  if (memoryClass != null && !MEMORY_CLASSES.has(memoryClass)) throw new Error(`memoryCandidateV2.memoryClass not in enum: ${memoryClass}`);

  // Provenance: normalize entries, keep invalid ones as {error} markers (never
  // silently dropped — a broken anchor must be visible, not vanish).
  const provIn = Array.isArray(raw?.provenance) ? raw.provenance : [];
  const provenance = [];
  const provProblems = [];
  for (const p of provIn.slice(0, 10)) {
    const n = normProvenance(p);
    if (n.error) { provProblems.push(n.error); provenance.push({ error: n.error, raw: typeof p === "string" ? p.slice(0, 200) : null }); }
    else provenance.push(n.value);
  }
  const anchored = provenance.some((p) => !p.error);

  // Hard invariant: memoryClass ONLY on VERIFIED + anchored provenance.
  if (memoryClass != null && maturityState !== "VERIFIED") {
    throw new Error("memoryCandidateV2.memoryClass requires maturityState=VERIFIED (class is assigned at promotion, not at observation)");
  }
  if (memoryClass != null && !anchored) {
    throw new Error("memoryCandidateV2.memoryClass requires anchored provenance (memory without provenance never outranks evidence)");
  }
  // VERIFIED without anchored provenance is equally forbidden.
  if (maturityState === "VERIFIED" && !anchored) {
    throw new Error("memoryCandidateV2.VERIFIED requires anchored provenance");
  }

  const kind = raw?.kind != null ? String(raw.kind).slice(0, 60) : null;
  // Optional bi-temporal metadata (ticket 191; Sol Gate 1): validFrom/validTo/
  // recordedAt pass through ONLY when actually known — absent stays absent,
  // invalid ISO throws (never synthesized, never backfilled). Kept OUT of
  // contentDigest so claim-identity/dedupe semantics are unchanged.
  const temporal = candidateTemporal(raw);
  return {
    schema: 2,
    id: `MC2${String(seq).padStart(4, "0")}`,
    runNumber, caseId, phase, createdBy,
    kind,
    claim: claim.slice(0, 500),
    whyItMatters: String(raw?.whyItMatters ?? "").slice(0, 500),
    subject: normSubject(raw?.subject),
    maturityState,
    memoryClass,
    provenance,
    verification: raw?.verification != null ? String(raw.verification).slice(0, 300) : null,
    ttlDays: raw?.ttlDays != null ? Math.max(1, Math.min(3650, Math.floor(Number(raw.ttlDays)))) : null,
    relevance: String(raw?.relevance ?? "").slice(0, 200) || null,
    confidentiality: raw?.confidentiality === "confidential" ? "confidential" : "normal",
    ...temporal,
    status: maturityState === "OBSERVATION" ? "observation" : (maturityState === "CANDIDATE" ? "candidate" : "verified"),
    provenanceProblems: provProblems,
    contentDigest: sha16(`${maturityState}|${memoryClass ?? ""}|${claim}|${provenance.filter((p) => !p.error).map((p) => `${p.kind}:${p.uri ?? p.caseId ?? p.runId ?? p.evidenceSha256}`).join(",")}`),
  };
}

export function validateCandidatesV2(rawList, ctx = {}) {
  const start = Number.isInteger(ctx.seq) && ctx.seq > 0 ? ctx.seq : 1;
  return (Array.isArray(rawList) ? rawList : []).map((r, i) => {
    const { seq: _ignored, ...rest } = ctx;
    return validateCandidateV2(r, { ...rest, seq: start + i });
  });
}

// Hard invariant check (mechanical form): anchored = at least one valid provenance
// entry with a locatable anchor.
export function hasAnchoredProvenance(cand) {
  if (nativeMemoryPolicyEnabled()) return nativeCandidatePolicy(cand).hasAnchoredProvenance;
  return (Array.isArray(cand?.provenance) ? cand.provenance : []).some((p) => !p.error && (p.uri || p.caseId || p.runId || p.evidenceSha256));
}

export function canVerify(cand) {
  return hasAnchoredProvenance(cand);
}

// Derived-memory detection (Sol further-issue 4, "probably the most important
// subtle issue"): true when every provenance entry is `derived`. Such candidates
// are memory about memory and must never count as independent verification.
export function isDerivedProvenance(cand) {
  if (nativeMemoryPolicyEnabled()) return nativeCandidatePolicy(cand).isDerivedProvenance;
  const prov = (Array.isArray(cand?.provenance) ? cand.provenance : []).filter((p) => !p.error);
  return prov.length > 0 && prov.every((p) => p.kind === "derived");
}

// Independent-verification check: at least one provenance entry that is neither
// derived-from-memory nor tracing to the SAME source uri as the reference. Used by
// the conflict gate so a Concept cannot verify its own paraphrase.
export function hasIndependentProvenance(cand, { excludeUri = null } = {}) {
  if (nativeMemoryPolicyEnabled()) return nativeCandidatePolicy(cand, excludeUri).hasIndependentProvenance;
  const prov = (Array.isArray(cand?.provenance) ? cand.provenance : []).filter((p) => !p.error);
  return prov.some((p) => p.kind !== "derived" && !(excludeUri && p.uri && p.uri === excludeUri));
}

// v1 -> v2 mechanical upgrade (conservative; no v1 mutation):
//   status verified|amend -> VERIFIED, else OBSERVATION
//   kind implementation_invariant -> rule class (mapCandidatesToConcepts semantics);
//   known_defect/known_risk -> knowledge; operational_pattern -> wisdom
//   evidenceRefs -> provenance {kind: live-evidence, uri}
export function upgradeV1Candidate(v1, { seq = 1 } = {}) {
  const status = String(v1?.status ?? "candidate");
  const verified = status === "verified" || status === "amend";
  const kindToClass = { implementation_invariant: "rule", known_defect: "knowledge", known_risk: "knowledge", operational_pattern: "wisdom" };
  const refs = (Array.isArray(v1?.evidenceRefs) ? v1.evidenceRefs : []).filter(Boolean);
  // Sol invariant, mechanical form: a verified v1 candidate WITHOUT evidence refs
  // cannot be VERIFIED-with-class under v2 (no provenance). Demote to OBSERVATION
  // (never lost — observation is the safe floor), never throw: run closeout must
  // not break on legacy candidates.
  const canPromote = verified && refs.length > 0;
  return validateCandidateV2(
    {
      claim: v1?.claim,
      whyItMatters: v1?.whyItMatters,
      maturityState: canPromote ? "VERIFIED" : "OBSERVATION",
      memoryClass: canPromote ? (kindToClass[v1?.kind] ?? "knowledge") : null,
      subject: (Array.isArray(v1?.scope) ? v1.scope[0] : null) ?? null,
      provenance: refs.map((r) => ({ kind: "live-evidence", uri: r })),
      kind: v1?.kind ?? null,
      confidentiality: v1?.confidentiality ?? "normal",
    },
    { runNumber: v1?.runNumber ?? null, caseId: v1?.caseId ?? null, phase: v1?.phase ?? null, createdBy: v1?.createdBy ?? null, seq },
  );
}

// Lifecycle transitions (delta 4 primitive; deterministic, fail-closed):
//   OBSERVATION -> CANDIDATE : requires anchored provenance
//   CANDIDATE   -> VERIFIED  : requires anchored provenance + verification anchor
//   VERIFIED    -> EXPIRED | SUPERSEDED | INVALIDATED (delta 4; record-level, no deletion)
// Anything else (sideways moves, silent widening, unknown targets) throws.
export const TERMINAL_MEMORY_STATES = new Set(["EXPIRED", "SUPERSEDED", "INVALIDATED"]);
export function validateLifecycleTransition(cand, toState, { verification = null } = {}) {
  if (nativeMemoryPolicyEnabled()) {
    const closedAt = TERMINAL_MEMORY_STATES.has(toState) ? new Date().toISOString() : null;
    return nativeCandidateTransition(cand, toState, { verification, closedAt });
  }
  const from = cand?.maturityState ?? "OBSERVATION";
  if (toState === "CANDIDATE") {
    if (from !== "OBSERVATION") throw new Error(`lifecycle: ${from}->CANDIDATE not allowed`);
    if (!hasAnchoredProvenance(cand)) throw new Error("lifecycle: OBSERVATION->CANDIDATE requires anchored provenance");
    return { ...cand, maturityState: "CANDIDATE", status: "candidate" };
  }
  if (toState === "VERIFIED") {
    if (from !== "CANDIDATE") throw new Error(`lifecycle: ${from}->VERIFIED not allowed (must pass through CANDIDATE)`);
    if (!hasAnchoredProvenance(cand)) throw new Error("lifecycle: CANDIDATE->VERIFIED requires anchored provenance");
    if (!verification && !cand?.verification) throw new Error("lifecycle: CANDIDATE->VERIFIED requires a verification anchor");
    return { ...cand, maturityState: "VERIFIED", status: "verified", verification: verification ?? cand.verification };
  }
  if (TERMINAL_MEMORY_STATES.has(toState)) {
    if (from !== "VERIFIED" && from !== "CANDIDATE") throw new Error(`lifecycle: ${from}->${toState} not allowed`);
    return { ...cand, maturityState: toState, status: toState.toLowerCase(), lifecycleClosedAt: new Date().toISOString() };
  }
  throw new Error(`lifecycle: unknown target state ${toState}`);
}

// TTL evaluation (delta 4): does this concept-shaped record need revalidation now?
// Pure date math — the CALLER decides what "revalidated" means (mechanical jobs
// identify; they never rewrite knowledge, per the Sol contract).
export function isTtlDue(cand, { now = new Date() } = {}) {
  if (nativeMemoryPolicyEnabled()) return nativeCandidateTtl(cand, now);
  if (cand?.ttlDays == null) return { due: false, reason: "no ttl" };
  if (cand?.maturityState !== "VERIFIED") return { due: false, reason: `state ${cand.maturityState} is not TTL-managed` };
  const base = cand?.verifiedAt ?? cand?.promotedAt ?? cand?.observedAt ?? null;
  if (!base) return { due: true, reason: "VERIFIED with ttlDays but no verifiable timestamp" };
  const t = Date.parse(base);
  if (Number.isNaN(t)) return { due: true, reason: "unparseable timestamp" };
  const ageDays = (now.getTime() - t) / 86_400_000;
  return ageDays > Number(cand.ttlDays) ? { due: true, reason: `age ${Math.floor(ageDays)}d > ttl ${cand.ttlDays}d` } : { due: false, reason: `age ${Math.floor(ageDays)}d <= ttl ${cand.ttlDays}d` };
}
