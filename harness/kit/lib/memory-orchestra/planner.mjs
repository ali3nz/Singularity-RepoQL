// lib/memory-orchestra/planner.mjs — MemOS gap-closure addendum (2026-10-23)
// directive §5/§8/§17/§25/§28. One deterministic retrieval planner over the two
// fleet authorities (Tencent MemoryCore = experience; RepoQL = technical
// authority). It NEVER scans a corpus in the orchestrator: every channel is an
// OWNED-ENGINE call with pushed-down scope + filters + topK, and the
// orchestrator only fuses returned bounded candidate pools. No cross-database
// joins anywhere (§5): fusion happens in lib/memory-orchestra/fusion.mjs.
//
// Channels are declarative; executors are bound by the caller
// (createPlanner({ executors })) so tests bind fake transports and production
// binds lib/memorycore-client.mjs + lib/repoql-client.mjs directly. An
// executor that fails returns a typed degraded channel result — a channel
// outage never fabricates candidates (ticket 776 P0 discipline).
//
// All feature behaviour gated by lib/memory-orchestra/flags.mjs (default OFF).

import { flags, enabledWhen } from "./flags.mjs";
import { createHash } from "node:crypto";

// ---------------------------------------------------------------------------
// Channel table — directive §8 (13 rows). topK pushes a bounded LIMIT down;
// filters are the native scoping fields (team/agent/user/task via the memorycore
// client; uriGlob/views via repoql client). rrfWeight: closed-league weights
// (exact evidence outranks recollection; design §2). DEPRECATED scores are
// never treated as comparable probabilities (contract §8).
// ---------------------------------------------------------------------------
export const CHANNELS = [
  { id: "tencent-l1-semantic", layer: "L1", executor: "memorycore.search", topK: 3, rrfWeight: 1.0 },
  // L2/L3 (2026-10-24, Sol ruling): the deployed MemoryCore exposes no scene or
  // persona read route, so these channels read the generated artifacts through
  // the read-only backend (client-l23 `backend: artifact`). A scope that cannot
  // be resolved is a typed SCOPE_UNRESOLVED — never another scope's content.
  { id: "tencent-l2-scene", layer: "L2", executor: "l23.sceneTop", topK: 1, rrfWeight: 1.0 },
  { id: "tencent-l3-persona", layer: "L3", executor: "l23.coreRead", topK: 1, rrfWeight: 1.1 },
  { id: "tencent-l0-keyword", layer: "L0", executor: "memorycore.search", topK: 3, rrfWeight: 0.8 },
  { id: "error-signature-exact", layer: "step", executor: "steps.byErrorSignature", topK: 5, rrfWeight: 2.0, exact: true },
  { id: "exact-identifier", layer: "any", executor: "steps.byIdentifier", topK: 5, rrfWeight: 1.8, exact: true },
  { id: "repoql-code-symbol", layer: "code", executor: "repoql.explore", topK: 4, rrfWeight: 1.3 },
  { id: "repoql-concept", layer: "concept", executor: "repoql.concepts", topK: 4, rrfWeight: 1.4 },
  { id: "docs-current", layer: "docs", executor: "docs.read", topK: 3, rrfWeight: 1.4 },
  { id: "temporal-fact", layer: "temporal", executor: "temporal.recall", topK: 3, rrfWeight: 1.0 },
  { id: "entity-relationship", layer: "graph", executor: "repoql.relationships", topK: 4, rrfWeight: 1.2 },
  { id: "procedure-runbook", layer: "docs", executor: "docs.read", topK: 3, rrfWeight: 1.4 },
  { id: "skill-approved", layer: "skill", executor: "memorycore.skillList", topK: 4, rrfWeight: 1.5, approvalGated: true },
  { id: "episode-historical", layer: "episode", executor: "steps.episodes", topK: 3, rrfWeight: 1.0 },
  { id: "policy-insight", layer: "policy", executor: "steps.policies", topK: 3, rrfWeight: 1.1, approvalGated: true },
];
export const CHANNEL_BY_ID = Object.fromEntries(CHANNELS.map((c) => [c.id, c]));

// Query intent classes (design §2; directive §20 progressive disclosure).
export const INTENTS = ["how-to", "what-happened", "why-recurring", "where-am-i", "temporal", "exact"];
const INTENT_MATCHERS = [
  ["exact", /\b(error|signature|id |sha|commit |hash|exact|line \d+|err[- _]?code)\b/i],
  ["how-to", /\b(how (to|do|can)|procedure|steps? to|runbook|where'?s the (command|script)|fix)\b/i],
  ["what-happened", /\b(what happened|last time|did (we|i) |previously|history of)\b/i],
  ["why-recurring", /\b(why (does|it|is|kept|do)|keeps? happening|recurring|pattern)\b/i],
  ["where-am-i", /\b(what (env|environment|service|release)|where am i|current (state|config|setup))\b/i],
  ["temporal", /\b(used to|before|earlier|since when|when did|was true|valid)\b/i],
];

// Reduced noise: collapse whitespace before matching so the multi-line briefs
// typical of fleet prompts classify stably.
export function classifyIntent(text) {
  const t = String(text ?? "").replace(/\s+/g, " ").trim();
  if (!t) return { intent: "exact", confidence: 0, reason: "empty query treated as exact lookup" };
  const pairs = [];
  for (const [intent, re] of INTENT_MATCHERS) {
    const m = new RegExp(re.source, re.flags.replace(/g/g, "")).exec(t);
    if (m) pairs.push({ intent, at: m.index });
  }
  if (!pairs.length) {
    // Default: experience lookup — the most common failed-recall class.
    return { intent: "what-happened", confidence: 0, reason: "no anchor phrase; safe default" };
  }
  pairs.sort((a, b) => a.at - b.at);
  const first = pairs[0];
  // Later anchors shift confidence up (mixed-intent briefs need the wider tiers).
  const conf = Math.min(1, (first.at === 0 ? 0.6 : 0.4) + pairs.length * 0.1);
  return { intent: first.intent, confidence: conf, reason: `anchor:${first.intent} >> ${pairs.map((p) => p.intent).join(",")}` };
}

// Channels per intent (§20 "select by task need"): exact intent keeps its
// exact-match channel even if similarity ranks it low (§9 preserve rule).
export function channelsForIntent(intent) {
  const t = {
    "how-to": ["skill-approved", "procedure-runbook", "repoql-code-symbol", "docs-current"],
    "what-happened": ["episode-historical", "tencent-l0-keyword", "tencent-l1-semantic", "error-signature-exact"],
    "why-recurring": ["policy-insight", "error-signature-exact", "episode-historical", "tencent-l1-semantic"],
    "where-am-i": ["repoql-code-symbol", "repoql-concept", "docs-current", "entity-relationship"],
    temporal: ["temporal-fact", "episode-historical", "docs-current"],
    exact: ["error-signature-exact", "exact-identifier", "repoql-code-symbol", "tencent-l0-keyword"],
  }[intent] ?? [];
  return t;
}

// ---------------------------------------------------------------------------
// Hook policy table — directive §17. Each hook is a named row: which channels,
// tier ceiling, injected-token budget. Hooks not wired to call sites yet are
// declared here so the contract is the table, not scattered if-s (design §6).
// Within one execution stage, the same injected packet must never be
// re-injected — dedupe is the caller's job via packet fingerprint.
// ---------------------------------------------------------------------------
export const HOOKS = {
  TURN_START: { channels: "intent-default", tierMax: "BALANCED", tokenBudget: 1500 },
  TOOL_FAILURE: { channels: ["error-signature-exact", "episode-historical", "skill-approved", "procedure-runbook"], tierMax: "BALANCED", tokenBudget: 1200 },
  TOOL_SUCCESS_WHEN_LEARNING: { channels: ["episode-historical"], tierMax: "FAST", tokenBudget: 500 },
  SKILL_INVOCATION: { channels: ["skill-approved", "procedure-runbook"], tierMax: "FAST", tokenBudget: 800 },
  SUBAGENT_SPAWN: { channels: ["repoql-concept", "tencent-l1-semantic", "skill-approved"], tierMax: "FAST", tokenBudget: 600 },
  DECISION_REPAIR: { channels: ["error-signature-exact", "skill-approved", "procedure-runbook", "policy-insight"], tierMax: "DEEP", tokenBudget: 1800 },
  INCIDENT_INVESTIGATION: { channels: ["episode-historical", "temporal-fact", "tencent-l1-semantic", "repoql-concept", "tencent-l3-persona", "tencent-l2-scene"], tierMax: "DEEP", tokenBudget: 2000 },
  DOCUMENTATION_AUTHORING: { channels: ["docs-current", "repoql-code-symbol", "repoql-concept"], tierMax: "BALANCED", tokenBudget: 1800 },
  RUN_COMPLETION: { channels: ["episode-historical", "tencent-l1-semantic"], tierMax: "FAST", tokenBudget: 600 },
  // S08 fix (2026-10-24): episode rollups and policy induction are still
  // P4/P5 pending, so this hook's original channel pair could only ever answer
  // INSUFFICIENT while the reflection caller itself was wired. Reflection must
  // be able to cite what DOES exist today (verified concepts, distilled L1
  // experience); the pending channels stay first so they take over when they
  // land, and neither is invented when empty.
  REFLECTION: { channels: ["episode-historical", "policy-insight", "repoql-concept", "tencent-l1-semantic"], tierMax: "BALANCED", tokenBudget: 1200 },
  DREAM_CONSOLIDATION: { channels: ["policy-insight", "temporal-fact", "repoql-concept", "tencent-l3-persona", "tencent-l2-scene"], tierMax: "DEEP", tokenBudget: 2000 },
};

// Tier budgets — directive §28. Deterministic first; LLM allowed ONLY where the
// row says so, never on FAST.
export const TIERS = {
  FAST: { perChannelTop: 3, channelsCeiling: 2, allowLlm: false, expansionRounds: 0 },
  BALANCED: { perChannelTop: 6, channelsCeiling: 4, allowLlm: false, expansionRounds: 1 },
  DEEP: { perChannelTop: 8, channelsCeiling: 6, allowLlm: true, expansionRounds: 2 },
};

// Resolve the effective plan rows for one retrieval call. Also the boundary
// that honours flags: disabled planner => typed FLAG_DISABLED (enabledWhen).
export function plan({ hook = "TURN_START", query, explicitChannels = null, tier = null, scope = {} } = {}) {
  const fs = flags();
  const gate = enabledWhen(fs, "planner");
  if (!gate.ok) return gate;
  const h = HOOKS[hook];
  if (!h) return { ok: false, code: "UNKNOWN_HOOK", hook };
  const cls = classifyIntent(query);
  let ids;
  if (explicitChannels && Array.isArray(explicitChannels) && explicitChannels.length) {
    ids = explicitChannels.filter((c) => CHANNEL_BY_ID[c]);
    if (!ids.length) return { ok: false, code: "UNKNOWN_CHANNEL", requested: explicitChannels };
  } else if (Array.isArray(h.channels)) {
    ids = h.channels.slice();
  } else {
    ids = channelsForIntent(cls.intent);
  }
  const maxTier = tier && TIERS[tier] ? tier : h.tierMax;
  const eff = TIERS[maxTier];
  return {
    ok: true,
    hook, intent: cls.intent, intentReason: cls.reason,
    tier: maxTier, tierBudget: eff, tokenBudget: h.tokenBudget,
    channels: ids.slice(0, Math.max(1, eff.channelsCeiling)).map((id) => CHANNEL_BY_ID[id]),
  };
}

// Normalise one engine response into the common candidate contract (§8): stable
// id, origin, channel, layer, scope, locator, validity, verification, rank,
// excerpt. Executors return raw rows; every unknown field is dropped rather
// than passed through (no accidental scope leaks through unfiltered passthrough).
export function toCandidate(channel, raw, { rank }) {
  // Round-4 (Sol HOLD F2): the display excerpt stays bounded (400), but fold
  // identity is computed over the FULL untruncated source text — the claim
  // digest is what fusion's claim-identity fold keys on, so two source claims
  // that diverge beyond the excerpt never fold. Empty source text → null
  // digest (the row can never form a digest key; text keys are namespace-
  // separated, so partial rows only fold with identical partial rows).
  const full = String(raw?.body ?? raw?.excerpt ?? "");
  const fullCanonical = full.toLowerCase().replace(/\s+/g, " ").trim();
  const claimDigest = fullCanonical ? createHash("sha256").update(fullCanonical).digest("hex").slice(0, 32) : null;
  const excerpt = full.slice(0, 400);
  return {
    id: String(raw?.id ?? `${channel}:${sha8(excerpt)}`),
    origin: String(raw?.origin ?? (channel.startsWith("repoql") ? "repoql" : channel.startsWith("tencent") ? "memorycore" : "kit")),
    channel,
    layer: CHANNEL_BY_ID[channel]?.layer ?? String(raw?.layer ?? "any"),
    sourceRevision: raw?.revision ?? raw?.sourceRevision ?? null,
    // Scope identities: prefer the row's own nested scope envelope, then the
    // flat fields (Sol close-out HOLD P0: planner previously read ONLY the
    // flat fields, so executor-provided nested scope was silently lost and
    // scoped-memory candidates reached the gate with no verifiable identity).
    scope: {
      team: raw?.scope?.team ?? raw?.team ?? null,
      agent: raw?.scope?.agent ?? raw?.agent ?? null,
      user: raw?.scope?.user ?? raw?.user ?? null,
      session: raw?.scope?.session ?? raw?.session ?? null,
      caseRun: raw?.scope?.caseRun ?? raw?.caseRun ?? null,
    },
    // Scope PROOF (Sol round-3 P0): how the row's identity was established —
    // engine-agent-pushdown / engine-row-scope / publisher-approval-boundary.
    // Rows without a proof fail closed in the fusion scope gate; requester
    // identity is never accepted as ownership evidence.
    scopeProof: raw?.scopeProof ?? null,
    claimDigest,
    entityRefs: Array.isArray(raw?.entityRefs) ? raw.entityRefs : [],
    evidenceLocator: raw?.locator ?? raw?.url ?? null,
    claimText: excerpt,
    validity: raw?.validity ?? "CURRENT", // executor-owned verdicts only; never inferred here
    verification: raw?.verification ?? null,
    approvalStatus: raw?.status ?? raw?.approvalStatus ?? null,
    confidentiality: raw?.confidentiality === "confidential" ? "confidential" : "normal",
    createdAt: raw?.created_at ?? raw?.createdAt ?? null,
    score: Number.isFinite(Number(raw?.score)) ? Number(raw.score) : null, // NOT comparable across engines
    rank, // comparable within channel only
    exact: !!raw?.exact || !!CHANNEL_BY_ID[channel]?.exact,
    tags: Array.isArray(raw?.tags) ? raw.tags : [],
  };
}

function sha8(s) {
  // small stable digest for id shims — crypto not needed for identity here
  let h = 5381;
  const str = String(s ?? "");
  for (let i = 0; i < str.length; i++) h = ((h << 5) + h + str.charCodeAt(i)) >>> 0;
  return h.toString(16).padStart(8, "0");
}

// Execute ONE channel through its bound executor with the plan's pushed-down
// constraints. Executors are async (arg) => { ok, results:[raw rows], code? }.
// Failures degrade the channel (never fabricate candidates). Timing collected
// for ledger instrumentation (§23).
export async function runChannel(channel, executors, { scope, tierBudget, deadlineMs = null }) {
  const ex = channel.executor.split(".");
  const holder = executors[ex[0]];
  const fn = holder && typeof holder[ex[1]] === "function" ? holder[ex[1]] : null;
  const started = Date.now();
  if (!fn) {
    return { channelId: channel.id, ok: false, code: "EXECUTOR_NOT_BOUND", ms: 0, results: [] };
  }
  try {
    const r = await fn({
      query: scope.queryText ?? "",
      scope,
      topK: Math.min(channel.topK, tierBudget.perChannelTop),
      intent: scope.intent,
      channel: channel.id,
      deadlineMs,
    });
    const ms = Date.now() - started;
    if (!r?.ok) return { channelId: channel.id, ok: false, code: r?.code ?? "EXECUTOR_ERROR", ms, results: [] };
    const rows = Array.isArray(r.results) ? r.results.slice(0, Math.min(channel.topK, tierBudget.perChannelTop)) : [];
    return { channelId: channel.id, ok: true, ms, results: rows.map((raw, i) => toCandidate(channel.id, raw, { rank: i + 1 })) };
  } catch (err) {
    return { channelId: channel.id, ok: false, code: `EXECUTOR_THROW:${String(err?.name ?? err).slice(0, 24)}`, ms: Date.now() - started, results: [] };
  }
}

// planAndFetch — classify → fan out bounded parallel channel calls → typed
// plan result with per-channel outcomes. Fusion is a SEPARATE stage (§9) so
// gate failures stay inspectable in the ledger.
// Sol performance ruling 2026-10-24 (consult 2026-10-23T21-54-39-590-80449):
// advisory retrieval must be BOUNDED. Channels still run concurrently, but one
// slow engine may no longer define hook latency: a channel that exceeds the
// deadline becomes a typed DEGRADED_CHANNEL:TIMEOUT (never an empty success),
// and the deadline is handed to the executor so its child process is killed
// rather than orphaned. 0 disables the deadline (previous behaviour).
// Default 12000 ms. Measured cold explores are 2.9 s (single file), ~6-11.6 s
// (hub docs, 177 files) and ~22 s (concept corpus); a 6 s cap made repoql-concept
// time out where it previously returned evidence, which is the failure mode Sol
// warned about. 12 s bounds a runaway without discarding normal retrievals;
// repeats hit the in-process cache. Tune with ORCH_MORCH_CHANNEL_DEADLINE_MS
// (0 disables). The ~22 s concept scope is the next optimisation target.
export function channelDeadlineMs() {
  const n = Number(process.env.ORCH_MORCH_CHANNEL_DEADLINE_MS ?? 12000);
  return Number.isFinite(n) && n >= 0 ? Math.floor(n) : 12000;
}

async function withDeadline(channel, executors, ctx, deadlineMs) {
  if (!(deadlineMs > 0)) return runChannel(channel, executors, ctx);
  const started = Date.now();
  let timer;
  const timeout = new Promise((resolve) => {
    timer = setTimeout(() => resolve({ channelId: channel.id, ok: false, code: "DEGRADED_CHANNEL:TIMEOUT", ms: deadlineMs, results: [], degraded: true, deadlineMs }), deadlineMs);
  });
  try {
    const work = runChannel(channel, executors, { ...ctx, deadlineMs })
      .catch((err) => ({ channelId: channel.id, ok: false, code: `EXECUTOR_THROW:${String(err?.name ?? err).slice(0, 24)}`, ms: Date.now() - started, results: [] }));
    return await Promise.race([work, timeout]);
  } finally {
    clearTimeout(timer);
  }
}

export async function planAndFetch({ executors, hook, query, scope = {}, explicitChannels, tier } = {}) {
  const p = plan({ hook, query, explicitChannels, tier });
  if (!p.ok) return p;
  const t0 = Date.now();
  const deadlineMs = channelDeadlineMs();
  const per = await Promise.all(p.channels.map((c) => withDeadline(c, executors, { scope: { ...scope, intent: p.intent, queryText: query }, tierBudget: p.tierBudget }, deadlineMs)));
  return { ...p, perChannel: per, msTotal: Date.now() - t0, deadlineMs, degraded: per.filter((x) => !x.ok).map((x) => ({ channelId: x.channelId, code: x.code })) };
}
