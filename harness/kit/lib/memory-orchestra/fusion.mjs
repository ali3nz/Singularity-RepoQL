// lib/memory-orchestra/fusion.mjs — MemOS gap-closure addendum (2026-10-23)
// directive §9 (multi-channel rank fusion). Gate ordering is the hard contract:
//   eligibility gates FIRST (never overridable by any score) → dedupe by
//   stable evidence id → RRF fusion → MMR diversity → adaptive threshold.
// A high RRF score can NEVER override scope isolation, rejected knowledge
// (tombstones), invalidated facts, skill approval, technical authority
// (precedence), or privacy controls — those are gate drops, recorded per
// candidate for the instrumentation ledger. Ranks are comparable within a
// channel; cross-engine similarity scores are NOT treated as probabilities.
// Gated by lib/memory-orchestra/flags.mjs (default OFF). No embedding calls
// anywhere: diversity uses deterministic token-Jaccard MMR.

import { flags, enabledWhen } from "./flags.mjs";
import { createHash } from "node:crypto";

// --- normalization helpers (deterministic; stdlib only) ----------------------

// Tokenize for Jaccard/MMR overlap. Bounded length; lower-case alnum tokens.
function tokensOf(s) {
  return String(s ?? "").toLowerCase().replace(/[^a-z0-9 _:/.\-]/g, " ").split(/\s+/).filter((t) => t.length > 2);
}
function jaccard(a, b) {
  const A = new Set(tokensOf(a));
  const B = new Set(tokensOf(b));
  if (!A.size || !B.size) return 0;
  let inter = 0;
  for (const t of A) if (B.has(t)) inter++;
  return inter / (A.size + B.size - inter);
}

// --- hard eligibility gates (§9: run BEFORE ranking, always) -----------------
// Each gate returns { pass, reason }. `gateCtx` carries the request side:
// { team, agent, user, allowConfidential, tombstones (optional preloaded list) }.

// 1. Scope isolation — a cross-team/cross-agent/cross-user candidate never
//    enters no matter how it ranks (Tencent isolation boundary; §29).
//    Fail-closed on MISSING identity for scoped-memory origins (Sol close-out
//    748 HOLD P0: a scoped candidate without a verifiable identity is not
//    permission to proceed) — global authorities (repoql/concept/docs) and
//    explicitly authorized globals are exempt.
//    Round-3 (Sol HOLD): scoped rows must also carry a scope PROOF — evidence
//    of how the identity was established (engine push-down, engine row scope,
//    or the publisher approval boundary). Requester identities copied onto
//    rows without proof are NOT ownership evidence; rows without a proof fail
//    closed ("scope:unproven"), and a row missing an identity the REQUESTER
//    carries fails closed too ("scope:incomplete") unless the row's proof
//    covers the enforceable dimension (e.g. agent-only memory stores).
//    Round-4 (Sol HOLD): completeness is per-proof — the agent dimension is
//    INSIDE the completeness test (previously omitted), and each proof name
//    states exactly which dimensions its owning transport enforces:
//      engine-agent-pushdown  — memorycore L0/L1: the server partitions the
//        chunk store by AGENT BLOCK ONLY (lib/memorycore-client search takes
//        agent; there is no server-side user/team partitioning), so this
//        proof establishes the agent dimension alone; team/user absence is
//        tolerated ONLY under this proof, and agent must be present.
//      engine-row-scope       — the engine's own per-row ownership envelope:
//        ALL requester-carried dimensions must be claimed by the row.
//      own-store-caseRun-pushdown — the kit's own step ledger, filtered on
//        caseRun equality inside scanSteps (the push-down equivalent): the
//        caseRun dimension is enforced, so caseRun must be claimed.
const SCOPED_ORIGINS = new Set(["memorycore", "kit", "steps"]);
// Round-5 (Sol HOLD G1): each proof states EXACTLY the dimensions its owning
// transport establishes server-side. An agent-only proof establishes agent
// ONLY — it must never waive caseRun, team, or user; a caseRun push-down
// proof establishes caseRun ONLY. Completeness = every requester-carried
// dimension must be claimed by the row (strict pairwise check) or established
// by the row's proof (present in this set). Unproven dimensions drop.
// engine-row-scope claims the full envelope the engine returned; anything the
// row omits is unproven and must come from these establish-sets.
const PROOF_ESTABLISHES = Object.freeze({
  "engine-agent-pushdown": Object.freeze(["agent"]), // memorycore L0/L1: agent block partition only
  "own-store-caseRun-pushdown": Object.freeze(["caseRun"]), // kit step ledger: caseRun equality filter
  // Engine-row-scope establishes NOTHING for omission purposes: the envelope
  // IS the claim — a dimension the row omits is unproven (round-4 evidence
  // preserved: a row-scope row missing the agent dimension drops). The proof
  // only makes the CLAIMED values trustworthy (strict pairwise comparison).
  "engine-row-scope": Object.freeze([]),
});
// Authority-served channels: access is enforced at the serving boundary, not
// by row scope identity — the approved-skill reader serves ONLY
// publisher-manifest APPROVED content for the exact contentHash with provenance
// checks (lib/skill-publish.mjs). Requester scope comparison would be
// meaningless here (published skills are deliberately fleet-readable).
// P0 §8 (2026-10-23): canonical hub docs are AUTHORITY-SERVED, like approved
// skills. They are not per-requester private material, so demanding a
// requester scope envelope rejected every legitimate docs candidate
// (scope:missing). The exemption is deliberately narrow: only these channel
// ids, only rows whose proof is the docs authority marker, and the reader is
// bounded to the hub docs tree. Everything else still fails closed.
const AUTHORITY_CHANNELS = new Set(["skill-approved", "docs-current", "procedure-runbook"]);
const DOCS_AUTHORITY_PROOF = "hub-docs-authority";
function gateScope(c, ctx) {
  // Explicitly UNAUTHORIZED global sources handled separately: a caller may
  // pre-authorize exact "${origin}::${id}" entries or whole origins for
  // cross-scope retrieval. Authorization is opt-in and names WHAT is allowed;
  // everything else falls through to the strict same-scope check below
  // (Sol close-out HOLD: no silent global widening, no default-on).
  const auth = ctx.authorizedGlobals ?? null;
  if (Array.isArray(auth) || auth instanceof Set) {
    if (auth instanceof Set ? auth.has(`${c.origin}::${c.id}`) : auth.includes(`${c.origin}::${c.id}`)) return { pass: true, reason: null, authorized: true };
    if (auth instanceof Set ? auth.has(c.origin) : auth.includes(c.origin)) return { pass: true, reason: null, authorized: true };
  }
  if (String(c.scopeProof ?? "") === DOCS_AUTHORITY_PROOF && AUTHORITY_CHANNELS.has(String(c.channel))) {
    return { pass: true, reason: null, authority: true, basis: "hub-docs-authority" };
  }
  if (AUTHORITY_CHANNELS.has(String(c.channel))) return { pass: true, reason: null, authority: true };
  const scoped = SCOPED_ORIGINS.has(String(c.origin));
  if (scoped) {
    if (!c.scope?.agent && !c.scope?.user && !c.scope?.caseRun) return { pass: false, reason: "scope:missing" };
    // Round-3 P0: a scope envelope from an unproven source is not evidence.
    // Accepted proofs and the dimensions each establishes are documented at
    // SCOPED_ORIGINS above. Anything else — in particular a bare
    // requester-identity copy — fails closed.
    const proof = String(c.scopeProof ?? "");
    const okProofs = new Set(["engine-agent-pushdown", "engine-row-scope", "own-store-caseRun-pushdown"]);
    if (c.channel !== "skill-approved" && !okProofs.has(proof)) return { pass: false, reason: "scope:unproven" };
    // Identity dimensions the row actually claims are compared strictly.
    if (c.scope?.team && ctx.team && c.scope.team !== ctx.team) return { pass: false, reason: "scope:team" };
    if (c.scope?.agent && ctx.agent && c.scope.agent !== ctx.agent) return { pass: false, reason: "scope:agent" };
    if (c.scope?.user && ctx.user && c.scope.user !== ctx.user) return { pass: false, reason: "scope:user" };
    if (c.scope?.caseRun && ctx.caseRun && c.scope.caseRun !== ctx.caseRun) return { pass: false, reason: "scope:caseRun" };
    // Round-5 completeness: every requester-carried dimension must be either
    // claimed by the row (strict pairwise check above) or ESTABLISHED by the
    // row's proof — the per-proof establish-sets at PROOF_ESTABLISHES. An
    // agent-only proof establishes agent only and can never waive caseRun,
    // team, or user (and vice versa); a caseRun push-down proof establishes
    // caseRun only. Unproven dimensions fail closed.
    const missing = [];
    if (ctx.team && !c.scope?.team) missing.push("team");
    if (ctx.agent && !c.scope?.agent) missing.push("agent");
    if (ctx.user && !c.scope?.user) missing.push("user");
    if (ctx.caseRun && !c.scope?.caseRun) missing.push("caseRun");
    if (missing.length) {
      const established = PROOF_ESTABLISHES[proof] ?? [];
      if (!missing.every((m) => established.includes(m))) {
        return { pass: false, reason: `scope:incomplete:${missing.join(",")}` };
      }
    }
  }
  return { pass: true, reason: null };
}

// 2. Rejected knowledge — tombstone evaluation against the claim text when the
//    caller supplied tombstones (lib/memory-tombstone.mjs owns promotion/decay;
//    fusion only refuses entry).
function gateTombstones(c, ctx, evalFn) {
  // Per-candidate tombstone evaluation (Sol close-out HOLD-2: rejection is
  // per candidate; unavailable mandatory tombstone evidence is NEVER an
  // affirmative eligibility decision). fn(c) => { evaluated, rejected, name?
  // }|null — lib/memory-tombstone.mjs claimIsRejected() is the canonical impl
  // (canonical claim equality, active-only, scope applies).
  if (typeof evalFn === "function") {
    try {
      const r = evalFn(c);
      if (r && r.evaluated) {
        if (r.rejected) return { pass: false, reason: `tombstone:${r.name ?? "rejected"}` };
        return { pass: true, reason: null, tombstoneEvaluated: true };
      }
    } catch {
      /* evaluator threw — fail closed below, never guess */
    }
  }
  if (ctx.allowUnevaluatedTombstones === true) return { pass: true, reason: null, authorized: true };
  return { pass: false, reason: "tombstone:unevaluated" }; // fail closed
}

// 3. Validity — executor-reported terminal validity is honoured verbatim;
//    never re-inferred, never repaired here.
function gateValidity(c) {
  const v = String(c.validity ?? "CURRENT").toUpperCase();
  if (v !== "CURRENT") return { pass: false, reason: `validity:${v}` };
  return { pass: true, reason: null };
}

// 4. Skill/insight approval — approvalGated channels require APPROVED.
function gateApproval(c) {
  const st = String(c.approvalStatus ?? "").toUpperCase();
  // Missing/unset approval status FAILS CLOSED for approval-gated candidates
  // (Sol close-out HOLD-1: an absent status is never read as an affirmative).
  if (!st) return { pass: false, reason: "approval:unset" };
  if (st === "APPROVED") return { pass: true, reason: null };
  // Round-4 (Sol HOLD F3): the supersession lane serves retained,
  // independently hash-verified previously-approved bytes labelled
  // SUPERSEDED_PENDING (lib/skill-publish.mjs serveApprovedContent only ever
  // emits that label after the live hash / provenance / approvedHash integrity
  // chain succeeds). Eligible for recall — but ONLY with the manifest
  // verification tag proving it came through that boundary; the general gate
  // stays strict (any other non-APPROVED word drops).
  if (st === "SUPERSEDED_PENDING" && String(c.verification ?? "").startsWith("manifest-approved")) {
    return { pass: true, reason: null, superseded: true };
  }
  return { pass: false, reason: `approval:${st}` };
}

// 5. Privacy — confidential candidates stay out unless the caller's scope
//    explicitly marks the session confidential-cleared.
function gatePrivacy(c, ctx) {
  if (c.confidentiality === "confidential" && !ctx.allowConfidential) return { pass: false, reason: "privacy:confidential" };
  return { pass: true, reason: null };
}

export function applyEligibilityGates(candidates, gateCtx = {}) {
  const gated = [];
  for (const c of candidates) {
    const drops = [];
    const g1 = gateScope(c, gateCtx);
    if (!g1.pass) drops.push(g1.reason);
    const g2 = gateTombstones(c, gateCtx, gateCtx.tombstoneEval ?? null);
    if (!g2.pass) drops.push(g2.reason);
    const g3 = gateValidity(c);
    if (!g3.pass) drops.push(g3.reason);
    if (c.approvalGated || CHANNEL_APPROVAL_IDS.has(c.channel) || (c.layer === "skill" || c.layer === "policy")) {
      const g4 = gateApproval(c);
      if (!g4.pass) drops.push(g4.reason);
    }
    const g5 = gatePrivacy(c, gateCtx);
    if (!g5.pass) drops.push(g5.reason);
    gated.push({ candidate: c, reasons: drops, kept: drops.length === 0 });
  }
  return gated;
}

const CHANNEL_APPROVAL_IDS = new Set(["skill-approved", "policy-insight"]);

// --- dedupe (stable identity, never similarity-only) -------------------------
// Identity: origin + id when present, else normalized claim text digest. Two
// engines may cite the SAME underlying fact; the earliest-rank wins and the
// loser's channel is recorded as corroboration (adds no text bytes).
export function dedupeByStableId(candidates) {
  const seen = new Map();
  const out = [];
  for (const c of candidates) {
    const key = c.id && !/^(repoql|memorycore|kit):$/.test(c.id)
      ? `${c.origin}::${c.id}`
      : `${c.origin}::${normClaim(c.claimText)}`;
    if (!seen.has(key)) {
      const c2 = { ...c, corroboratedBy: [] };
      seen.set(key, c2);
      out.push(c2);
    } else {
      seen.get(key).corroboratedBy.push({ channel: c.channel, rank: c.rank });
    }
  }
  return out;
}
function normClaim(s) {
  return String(s ?? "").toLowerCase().replace(/\s+/g, " ").trim().slice(0, 160);
}
// FULL canonical claim identity for folds (normClaim keeps its historical
// 160-char bounded form for other callers): unbounded lowercase-whitespace
// canonicalization so two claims sharing only a prefix never collide.
// Empty claims return "" and can never form a fold key.
function canonicalClaimKey(s) {
  return String(s ?? "").toLowerCase().replace(/\s+/g, " ").trim();
}
// Round-4 (Sol HOLD F2): toCandidate bounds the DISPLAY excerpt to 400 chars,
// so a canonical key over claimText is still a prefix of the source claim.
// Rows that provide a claimDigest (sha256 over the FULL untruncated canonical
// source text — see planner.toCandidate) fold on it; rows without one fold
// only on their own text key and never mix namespaces, so a truncated display
// row can only fold with another identical-truncated row, never swallow a
// source claim that diverges beyond the excerpt.
function claimFoldKey(c) {
  if (c.claimDigest) return `d:${c.claimDigest}`;
  const k = canonicalClaimKey(c.claimText);
  return k ? `t:${k}` : null;
}

// --- Reciprocal Rank Fusion --------------------------------------------------
// rrf = Σ_ch w_ch / (k + rank_ch); k=60 (industry default), per-channel weights
// from the CHANNEL table (fusion reads them as plain weights, keeps scores
// bounded away from any probability claim).
export function rrfFuse(perChannel, weights = null, k = 60) {
  const scores = new Map();
  const seenInChannel = new Set();
  for (const ch of perChannel) {
    const w = weights?.[ch.channelId] ?? 1.0;
    ch.results.forEach((c) => {
      // Aggregate by STABLE SOURCE identity, origin included (Sol close-out
      // HOLD-2: rrfFuse previously keyed on c.id alone, which could combine
      // distinct sources that share an identifier).
      const key = `${c.origin || "?"}||${c.id}`;
      const chanKey = `${key}@@${ch.channelId}`;
      if (seenInChannel.has(chanKey)) return; // no double-counting inside ONE channel
      seenInChannel.add(chanKey);
      const prev = scores.get(key) ?? { top: c, rrf: 0, channels: [] };
      // Cross-channel occurrence: accumulate the weighted contribution and
      // record a corroboration row on the surviving candidate (its own
      // channel payload is kept when it is the FIRST occurrence).
      if (scores.has(key)) {
        if (!prev.channels.includes(ch.channelId)) prev.channels.push(ch.channelId);
        prev.top.corroboratedBy = Array.isArray(prev.top.corroboratedBy) ? prev.top.corroboratedBy : [];
        prev.top.corroboratedBy.push({ channel: c.channel ?? ch.channelId, rank: c.rank ?? 1 });
      }
      prev.rrf += w / (k + (c.rank ?? 1));
      scores.set(key, prev);
    });
  }
  return [...scores.values()].map((x) => ({ ...x.top, rrfScore: x.rrf })).sort((a, b) => b.rrfScore - a.rrfScore);
}

// --- MMR diversification (λ=0.7; deterministic token overlap; capped n) ------
export function mmrSelect(candidates, { lambda = 0.7, n = 8 } = {}) {
  const sel = [];
  const pool = candidates.slice();
  while (sel.length < Math.min(n, pool.length + sel.length) && pool.length) {
    let bestIdx = -1;
    let bestVal = -Infinity;
    for (let i = 0; i < pool.length; i++) {
      const maxSim = sel.length ? Math.max(...sel.map((s) => jaccard(pool[i].claimText, s.claimText))) : 0;
      const val = lambda * pool[i].rrfScore - (1 - lambda) * Math.max(maxSim, 0);
      if (val > bestVal) {
        bestVal = val;
        bestIdx = i;
      }
    }
    sel.push(pool.splice(bestIdx, 1)[0]);
  }
  return sel;
}

// Adaptive relevance threshold: relative floor on the leader + an absolute
// minimum so a single-hit channel cannot dominate an otherwise-empty packet.
export function thresholdFilter(candidates, { relFloor = 0.35, absFloor = 1 / 60 / 30 } = {}) {
  if (!candidates.length) return [];
  const top = candidates[0].rrfScore;
  const min = Math.max(top * relFloor, absFloor);
  const kept = candidates.filter((c) => c.rrfScore >= min);
  if (kept.length === 0) return [candidates[0]]; // never return an empty packet when a gate-passing leader exists
  return kept;
}

// --- fusion entry (directive §9 ordering, gated) ------------------------------
export function fuse({ plan, scope = {}, tombstoneEval = null, authorizedGlobals = null, allowUnevaluatedTombstones = false, keptN = 8, lambda = 0.7, weightsById = { "error-signature-exact": 2.0, "skill-approved": 1.5, "docs-current": 1.4, "repoql-concept": 1.4, "procedure-runbook": 1.4, "repoql-code-symbol": 1.3, "exact-identifier": 1.8 } } = {}) {
  const fs = flags();
  const gate = enabledWhen(fs, "fusion");
  if (!gate.ok) return { ok: false, code: gate.code, flag: gate.flag, status: gate.status };
  if (!plan?.ok) return { ok: false, code: plan?.code ?? "NO_PLAN" };

  // 1) gather all candidates with their channel weights attached.
  const all = [];
  for (const ch of plan.perChannel ?? []) {
    const w = weightsById[ch.channelId] ?? 1.0;
    for (const cand of ch.results) all.push({ ...cand, _w: w });
  }
  // 2) HARD gates first, before any ranking (§9), WITH the requester's scope
  //    identities (Sol close-out HOLD P0: the gate context must actually carry
  //    team/agent/user or the scope isolation check can never fire).
  const gateCtx = {
    team: scope?.team ?? null, agent: scope?.agent ?? null, user: scope?.user ?? null, caseRun: scope?.caseRun ?? null,
    tombstoneEval, authorizedGlobals, allowUnevaluatedTombstones,
  };
  const gated = applyEligibilityGates(all, gateCtx);
  const keepers = gated.filter((g) => g.kept).map((g) => g.candidate);
  const drops = gated.filter((g) => !g.kept).map((g) => ({ id: g.candidate.id, channel: g.candidate.channel, reasons: g.reasons }));
  // 3) Per-channel grouping BEFORE fusion (same-key repeats inside ONE channel
  //    are folded by rrfFuse's seenInChannel guard — no double counting).
  // 4) RRF FIRST (Sol close-out HOLD-2: cross-channel occurrences of a stable
  //    identity must keep their weighted contributions; identity-dedupe AFTER
  //    fusion, on the rrf-ordered list, would have dropped them pre-accumulation).
  //    rrfFuse keys origin||id; distinct ids citing the SAME underlying claim
  //    are folded afterwards by dedupeByStableId (highest-rrf winner, loser
  //    recorded as corroboration) — dedupe never precedes the accumulation.
  const byCh = dedupeChannels(keepers);
  const fused = claimDedupe(rrfFuse(byCh, weightsById));
  // 5) MMR diversity, 6) adaptive threshold.
  const diversified = mmrSelect(fused, { lambda, n: keptN });
  const final = thresholdFilter(diversified);
  return {
    ok: true,
    candidates: final.map((c) => ({ ...c, rrf: c.rrfScore, gates: "ELIGIBLE", corroboratedBy: c.corroboratedBy ?? [] })),
    dropped: drops,
    stats: { gateIn: all.length, gateKept: keepers.length, fused: fused.length, kept: final.length },
  };
}

// Claim-identity fold applied AFTER accumulation (fusion stage ordering, not
// the dedupeByStableId API — that function is left unchanged per the reviewer's
// instruction). Two different row ids (ANY origin) with the SAME COMPLETE
// canonical claim text fold to the highest-rrf winner (Sol round-3: the fold
// key is the FULL canonicalized claim — no 160-char prefix truncation, two
// claims sharing only a prefix never fold; empty/whitespace claims are
// already dropped upstream so every key is non-empty). The loser's accumulated
// RRF weight merges into the winner (corroboration raises rank); its primary
// origin/channel/rank row joins the winner's corroboration list AND any
// corroboration rows the loser already accumulated are preserved verbatim,
// so the merged provenance chain never loses a contribution (round-3 fix).
function claimDedupe(list) {
  const seen = new Map();
  const out = [];
  for (const c of list) {
    const key = claimFoldKey(c);
    if (!key) continue; // never fold on absent identity; gated upstream anyway
    if (!seen.has(key)) {
      const c2 = { ...c, corroboratedBy: Array.isArray(c.corroboratedBy) ? c.corroboratedBy.slice() : [] };
      seen.set(key, c2);
      out.push(c2);
    } else {
      const w = seen.get(key);
      w.rrfScore = Number.isFinite(w.rrfScore) ? w.rrfScore : 0;
      if (Number.isFinite(c.rrfScore)) w.rrfScore += c.rrfScore;
      w.corroboratedBy.push({ origin: c.origin, channel: c.channel, rank: c.rank ?? 1 });
      if (Array.isArray(c.corroboratedBy)) {
        for (const x of c.corroboratedBy) w.corroboratedBy.push({ ...x });
      }
    }
  }
  // A merged winner may now outrank entries positioned above it in the rrfFuse
  // order — re-sort so thresholdFilter's leader-relative floor stays honest.
  return out.sort((a, b) => (b.rrfScore ?? 0) - (a.rrfScore ?? 0));
}

// regroup candidates by channel for RRF input (rank-preserving; within-channel
// repeats of the same stable identity fold to their best rank here so a stray
// duplicate row can never double-count even before rrfFuse's own guard).
function dedupeChannels(list) {
  const m = new Map();
  const seenInCh = new Map();
  for (const c of list) {
    if (!m.has(c.channel)) m.set(c.channel, { channelId: c.channel, results: [] });
    const key = `${c.origin || "?"}||${c.id}`;
    const seen = seenInCh.get(c.channel) ?? new Set();
    if (seen.has(key)) continue; // fold: first (best-rank) occurrence wins in-channel
    seen.add(key);
    seenInCh.set(c.channel, seen);
    m.get(c.channel).results.push({ ...c, rank: c.rank ?? 1 });
  }
  return [...m.values()];
}
