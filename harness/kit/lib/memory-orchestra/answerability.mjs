// lib/memory-orchestra/answerability.mjs — MemOS gap-closure addendum
// (2026-10-23) directive §10 (query-time answerability) and §22 (query-aware
// enhancement). Bounded evidence-sufficiency layer over a fused packet.
// Deterministic FIRST: coverage is measured against the intent's required
// evidence dimensions using channel hits and gate outcomes — never a bare
// similarity score. An optional LLM judge may refine the verdict ONLY on the
// DEEP tier when the caller binds a judge function; its result may LOWER a
// mechanical verdict to PARTIAL/INSUFFICIENT (never upgrade, never grant
// scope — §29). Bound: at most one targeted expansion round per call
// (caller executes it and calls judgePacket again; recursion is refused).
//
// STATE CONTRACT (returned as `state`):
//   SUFFICIENT  — required dimensions all covered
//   PARTIAL     — some dimensions missing; `missing` names the evidence TYPE,
//                 `targetedExpansion` names ONE channel to expand (§22)
//   CONFLICTED  — two registered authorities disagree on validity for the same
//                 subject; `conflict` records both sides (RepoQL wins by
//                 priority: issue-law, not a new rule)
//   INSUFFICIENT — no gate-keeping evidence at all: report honestly, guess
//                  nothing ("do not repeatedly ask the model to guess")

import { isDeepStrictEqual } from "node:util";
import { nativeMemoryPolicyEnabled, nativeAnswerability, NativeMemoryPolicyError } from "../native-memory-policy.mjs";

export const ANSWERABILITY = ["SUFFICIENT", "PARTIAL", "CONFLICTED", "INSUFFICIENT"];

// Required evidence dimensions by intent (planner INTENTS). A dimension is
// covered when at least one kept candidate from a serving channel maps to it.
const DIMENSIONS = {
  exact: ["exact-match"],
  "how-to": ["procedure", "authority"],
  "what-happened": ["episode-evidence"],
  "why-recurring": ["pattern", "episode-evidence"],
  "where-am-i": ["authority"],
  temporal: ["temporal-evidence"],
};

const CHANNEL_TO_DIMENSION = {
  "error-signature-exact": "exact-match",
  "exact-identifier": "exact-match",
  "recipe-runbook": "procedure", // typo guard — canonical id is procedure-runbook
  "procedure-runbook": "procedure",
  "skill-approved": "procedure",
  "repoql-code-symbol": "authority",
  "repoql-concept": "authority",
  "docs-current": "procedure",
  "episode-historical": "episode-evidence",
  "tencent-l0-keyword": "episode-evidence",
  "tencent-l1-semantic": "pattern",
  "policy-insight": "pattern",
  "temporal-fact": "temporal-evidence",
  "entity-relationship": "authority",
};

function coverageOf(candidates, intent) {
  const dims = DIMENSIONS[intent] ?? ["episode-evidence"];
  const covered = new Set();
  for (const c of candidates) {
    const d = CHANNEL_TO_DIMENSION[c.channel];
    if (d) covered.add(d);
    if (c.exact) covered.add("exact-match");
  }
  return { dims, covered, missing: dims.filter((d) => !covered.has(d)) };
}

// Conflicts: same normalized subject (first 12 tokens of claim) reported
// CURRENT by one origin and non-CURRENT by another — deterministic suspect
// pairing; the OUTER caller resolves with precedencePlane() before packet
// emission when present.
function sameSubjectKey(c) {
  return String(c.claimText ?? "").toLowerCase().split(/\s+/).slice(0, 12).join(" ");
}
function detectConflictsLocal(candidates) {
  const bySubject = new Map();
  for (const c of candidates) {
    const k = sameSubjectKey(c);
    const cur = bySubject.get(k) ?? [];
    cur.push(c);
    bySubject.set(k, cur);
  }
  const conflicts = [];
  for (const [subject, group] of bySubject) {
    if (group.length < 2) continue;
    const validityClasses = new Set(group.map((x) => String(x.validity ?? "CURRENT").toUpperCase()));
    if (validityClasses.size > 1) {
      conflicts.push({ subject, candidates: group.map((x) => ({ id: x.id, origin: x.origin, channel: x.channel, validity: x.validity })) });
      break; // one conflict verdict per packet is enough for the LLM consumer
    }
  }
  return conflicts;
}

function judgePacketLocal({ plan, fused, budgetMs = 250 }) {
  if (!fused?.ok) {
    return { state: "INSUFFICIENT", reason: fused?.code ?? "no fused packet", missing: [], targetedExpansion: null };
  }
  const intent = plan?.intent ?? "what-happened";
  const kept = fused.candidates ?? [];
  if (!kept.length) {
    return { state: "INSUFFICIENT", reason: "zero gate-keeping candidates", missing: [], targetedExpansion: null };
  }
  const { dims, covered, missing } = coverageOf(kept, intent);
  if (!missing.length) {
    return { state: "SUFFICIENT", reason: `all required dims covered (${[...covered].join("+")})`, missing: [], targetedExpansion: null, dimCoverage: { dims, covered: [...covered] } };
  }
  // Missing dims -> ONE targeted channel expansion (deterministic map; §22).
  const expansionMap = {
    "exact-match": "error-signature-exact",
    procedure: "procedure-runbook",
    "episode-evidence": "episode-historical",
    pattern: "policy-insight",
    authority: "repoql-concept",
    "temporal-evidence": "temporal-fact",
  };
  const targeted = missing.map((m) => expansionMap[m]).filter(Boolean)[0] ?? null;
  return { state: "PARTIAL", reason: `missing dims: ${missing.join(",")}`, missing, targetedExpansion: targeted, dimCoverage: { dims, covered: [...covered] }, conflicts: [] };
}

// Second pass AFTER the caller execs one targeted expansion round. Returns
// CONFLICTED when the expanded packet now contains conflicting authorities.
function judgeExpandedLocal(plan, fusedNew) {
  const base = judgePacketLocal({ plan, fused: fusedNew });
  const conflicts = detectConflictsLocal(fusedNew?.candidates ?? []);
  if (conflicts.length) {
    return { ...base, state: "CONFLICTED", conflicts, reason: `${base.reason}; validity conflict detected (${conflicts[0].subject})` };
  }
  return base;
}

// This is a pure policy leaf. Storage, retrieval, expansion and LLM review
// remain with their current owners. When explicitly enabled, the native
// result must agree with the independently calculated JS verdict; disagreement
// blocks packet emission instead of letting the Rust process decide authority.
function selectedNativeVerdict(command, payload, expected) {
  if (!nativeMemoryPolicyEnabled()) return expected;
  const native = nativeAnswerability(command, payload);
  // JSON CLI cannot preserve object fields whose value is undefined.
  // Compare the actual cross-process contract, not in-memory JS-only keys.
  if (!isDeepStrictEqual(native, JSON.parse(JSON.stringify(expected)))) {
    throw new NativeMemoryPolicyError("NATIVE_ANSWERABILITY_MISMATCH");
  }
  return native;
}

export function detectConflicts(candidates) {
  const expected = detectConflictsLocal(candidates);
  return selectedNativeVerdict("answerability-conflicts", { candidates }, expected);
}

export function judgePacket({ plan, fused, budgetMs = 250 }) {
  const expected = judgePacketLocal({ plan, fused, budgetMs });
  return selectedNativeVerdict("answerability-packet", { plan, fused }, expected);
}

export function judgeExpandedCancellation(plan, fusedNew) {
  const expected = judgeExpandedLocal(plan, fusedNew);
  return selectedNativeVerdict("answerability-expanded", { plan, fused: fusedNew }, expected);
}

// DEEP-tier optional LLM judge (bounded): judge(text) -> "SUFFICIENT"|"PARTIAL"|
// "CONFLICTED"|"INSUFFICIENT". Only refines DOWNWARD; never upgrades, never
// re-scopes. Insufficient budget -> mechanical verdict stands.
export async function llmRefine(verdict, { judge, tier = "BALANCED" } = {}) {
  if (typeof judge !== "function" || tier !== "DEEP") return verdict;
  let r = null;
  try {
    r = await Promise.race([
      Promise.resolve(judge(JSON.stringify({ state: verdict.state, reason: verdict.reason, missing: verdict.missing }))),
      new Promise((res) => setTimeout(() => res(null), budgetMsOf(verdict.budgetMs ?? 250))),
    ]);
  } catch {
    return verdict; // judge trouble never degrades below mechanical verdict
  }
  if (!r || !ANSWERABILITY.includes(String(r).toUpperCase())) return verdict;
  const up = r.toUpperCase();
  if (up === "SUFFICIENT") return verdict; // no upgrade path (§29)
  return { ...verdict, state: up, refinedBy: "llm-judge" };
}
function budgetMsOf(ms) {
  return Math.max(1, Math.min(5000, Number(ms) || 250));
}
