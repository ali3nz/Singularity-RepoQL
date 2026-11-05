// free-model-registry.mjs — V3.2 §9: ONE central registry for all NEW free
// components (Supervisor / Watchdog / quality / normal-ask chains). Model IDs
// are never scattered through source. Every entry is an explicit allowlist —
// "free by promotion" models are NOT auto-approved (§9).
//
// Health/capability state (§10) is cached in runs/free-model-health.json with
// TTL: a recently verified model is not re-probed every run; transient
// capacity failures set a cooldown but never permanently disable a model.
import { readFileSync, writeFileSync, renameSync, existsSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { spawnSync } from "node:child_process";

// V3.3.25 HARD DENY (operator order 2026-09-22, hallucination evidence):
// opencode/nemotron-3.5-lightning-free is BANNED from every executable path —
// registries, seat failover, nudge pins, bridge defaults, text-model defaults.
// Not a preference reorder: pickModel/failover selection must never return it,
// and assertFreeOnly raises if it is ever REQUESTED explicitly.
export const DENY_FREE_MODELS = Object.freeze([
  "opencode/nemotron-3.5-lightning-free",
]);

// Operator order 2026-10-11 ("I want nemotron gone"; worker ban 2026-09-28):
// EVERY nemotron id is hard-denied, whatever the provider prefix.
const DENY_PATTERN = /nemotron/i;
function isDenied(modelId) {
  return DENY_FREE_MODELS.includes(String(modelId)) || DENY_PATTERN.test(String(modelId));
}

function denyError(modelId) {
  return `hard-deny: ${modelId} is operator-banned (hallucination evidence, 2026-09-22) — remove it from the chain/pin/config that requested it`;
}

// §9 registry — order = preference. Ticket 343 (operator order 2026-10-07, zero-cost
// routing): canonical chain muse-free -> longcat-free -> nemotron-ultra-free
// (smoke-passed 2026-10-07, prior 404 note stale) -> space-bunny-free -> ling-free,
// then explicit OpenRouter :free (laguna, nemotron-ultra, nemotron-lightning, sante
// spare), then STOP. MiMo stays retired (ticket 255, Sol Q2); zen lightning stays
// HARD-DENIED (Sol Q1); delisted deepseek:free + qwen:free omitted, never paid.
// V3.3.25: lightning removed from EVERY role; guard asserts it can never be
// re-added silently.
// Ticket 230b note SUPERSEDED by ticket 343: free Muse IS now the default first
// assignment in every role below (Go allowance exhausted). Explicit opt-in paths
// (--free-only, explicit roster/free seats) continue to work unchanged.
// Ticket 255 (operator order 2026-10-03): MiMo retired. These lists are the FREE
// FAILOVER TAIL — the role caller attempts the Go-plan managed Muse first
// (opencode-managed-muse) and walks into this tail on failure or out-of-credit.
export const FREE_MODEL_REGISTRY = Object.freeze({
  supervisor: [
    "opencode/muse-spark-1.3-contributor-free",
    "opencode/longcat-2.5-preview-free",
    "opencode/space-bunny-free",
    "opencode/ling-3.1-flash-free",
    "openrouter/poolside/laguna-s-2.1:free",
    "openrouter/inclusionai/ling-3.0-flash-sante:free",
  ],
  watchdog: [
    "opencode/muse-spark-1.3-contributor-free",
    "opencode/longcat-2.5-preview-free",
    "opencode/space-bunny-free",
    "opencode/ling-3.1-flash-free",
    "openrouter/poolside/laguna-s-2.1:free",
    "openrouter/inclusionai/ling-3.0-flash-sante:free",
  ],
  qualityReview: [
    "opencode/muse-spark-1.3-contributor-free",
    "opencode/longcat-2.5-preview-free",
    "opencode/space-bunny-free",
    "opencode/ling-3.1-flash-free",
    "openrouter/poolside/laguna-s-2.1:free",
    "openrouter/inclusionai/ling-3.0-flash-sante:free",
  ],
  qualityFix: [
    "opencode/muse-spark-1.3-contributor-free",
    "opencode/longcat-2.5-preview-free",
    "opencode/space-bunny-free",
    "opencode/ling-3.1-flash-free",
    "openrouter/poolside/laguna-s-2.1:free",
    "openrouter/inclusionai/ling-3.0-flash-sante:free",
  ],
  qualityAudit: [
    "opencode/muse-spark-1.3-contributor-free",
    "opencode/longcat-2.5-preview-free",
    "opencode/space-bunny-free",
    "opencode/ling-3.1-flash-free",
    "openrouter/poolside/laguna-s-2.1:free",
    "openrouter/inclusionai/ling-3.0-flash-sante:free",
  ],
  normalAsk: [
    "opencode/muse-spark-1.3-contributor-free",
    "opencode/longcat-2.5-preview-free",
    "opencode/space-bunny-free",
    "opencode/ling-3.1-flash-free",
    "openrouter/poolside/laguna-s-2.1:free",
    "openrouter/inclusionai/ling-3.0-flash-sante:free",
  ],
  // V3.3.13: narrator — composes the Discord operator updates (display-only;
  // the action path stays deterministic). Fast on-box models first; ticket 255:
  // managed Muse primary (caller-side) then this free tail.
  narrator: [
    "opencode/muse-spark-1.3-contributor-free",
    "opencode/longcat-2.5-preview-free",
    "opencode/space-bunny-free",
    "opencode/ling-3.1-flash-free",
    "openrouter/poolside/laguna-s-2.1:free",
    "openrouter/inclusionai/ling-3.0-flash-sante:free",
  ],
});
// V3.3.25: the registry must never list a denied model (belt-and-braces vs a
// future merge re-adding lightning by accident).
for (const [role, models] of Object.entries(FREE_MODEL_REGISTRY)) {
  const bad = models.find((m) => isDenied(m));
  if (bad) throw new Error(`registry invariant violated: ${role} lists denied model ${bad}`);
}


// Every model in the registry must be free-classified on an approved provider:
// opencode-hosted ("opencode/<model>-free") or OpenRouter ":free" slugs
// (V3.3.13, ticket 028: cross-provider fallbacks; live catalog verified
// 2026-09-20 — old openai/gpt-oss-120b:free + deepseek-v4-flash:free slugs are
// DEAD upstream, do not reintroduce them). Paid slugs still rejected hard.
export function assertFreeOnly(modelId) {
  const id = String(modelId);
  if (isDenied(id)) throw new Error(denyError(id));
  const okOpenCode = id.startsWith("opencode/") && id.endsWith("-free");
  const okOpenRouter = id.startsWith("openrouter/") && id.endsWith(":free");
  if (!okOpenCode && !okOpenRouter) {
    throw new Error(`free-only violation: ${modelId} is not an approved free model (opencode/*-free or openrouter/*:free)`);
  }
  return true;
}

const HEALTH_TTL_MS = 30 * 60_000;        // verified-healthy cache TTL (§10: don't re-probe every run)
const COOLDOWN_MS = 10 * 60_000;          // transient capacity/rate-limit cooldown (§33: not permanent)

function healthFile(runsDir) {
  return join(runsDir, "free-model-health.json");
}

function loadHealth(runsDir) {
  try { return JSON.parse(readFileSync(healthFile(runsDir), "utf8")); } catch { return { models: {} }; }
}

function saveHealth(runsDir, h) {
  try {
    mkdirSync(runsDir, { recursive: true });
    const tmp = healthFile(runsDir) + ".tmp-" + process.pid;
    writeFileSync(tmp, JSON.stringify(h, null, 2));
    renameSync(tmp, healthFile(runsDir));
  } catch { /* health cache is best-effort */ }
}

// Is this model currently usable? Checks cached health: verified-healthy
// within TTL => yes; cooled-down => no; unknown => probe on demand.
export function modelAvailable(modelId, runsDir, { now = Date.now() } = {}) {
  assertFreeOnly(modelId);
  const h = loadHealth(runsDir).models[modelId];
  if (!h) return { ok: true, reason: "never-probed (probe on first use)" };
  if (h.cooldownUntil && now < h.cooldownUntil) {
    return { ok: false, reason: `cooldown until ${h.cooldownUntil} (${h.lastFailureClass})` };
  }
  if (h.lastSuccess && now - h.lastSuccess < HEALTH_TTL_MS) {
    return { ok: true, reason: `verified ${Math.round((now - h.lastSuccess) / 60000)} min ago` };
  }
  return { ok: true, reason: "stale-healthy (re-probe at next use)" };
}

// Record a probe/usage outcome. Transient classes cool down; they never
// permanently disable (§10). Success clears cooldown + records TTL.
export function recordModelOutcome(modelId, runsDir, { success, failureClass = null, durationMs = null } = {}) {
  assertFreeOnly(modelId);
  const h = loadHealth(runsDir);
  const m = (h.models[modelId] ??= { lastSuccess: null, lastFailure: null, lastFailureClass: null, cooldownUntil: null, lastDurationMs: null, probes: 0 });
  m.probes++;
  const now = Date.now();
  if (success) {
    m.lastSuccess = now;
    m.cooldownUntil = null;
    m.lastFailureClass = null;
  } else {
    m.lastFailure = now;
    m.lastFailureClass = failureClass ?? "UNKNOWN";
    if (["PROVIDER_DOWN", "RATE_LIMIT", "QUOTA"].includes(m.lastFailureClass)) {
      m.cooldownUntil = now + COOLDOWN_MS;
    }
  }
  if (durationMs != null) m.lastDurationMs = durationMs;
  saveHealth(runsDir, h);
  return m;
}

// §10 tiny live smoke: one real opencode call asking for a fixed marker.
// Uses the fleet-reviewer path via ssh to controller (same as opencode-bridge).
// Returns { ok, failureClass, durationMs, output } — never throws.
export function smokeModel(modelId, { sshHost = "controller", timeoutSec = 90 } = {}) {
  assertFreeOnly(modelId);
  const t0 = Date.now();
  try {
    const r = spawnSync("ssh", [sshHost,
      `timeout ${timeoutSec} /root/.opencode/bin/opencode run --model '${modelId}' --agent fleet-reviewer 'Reply with exactly: SMOKE-OK' </dev/null 2>&1 | tail -c 400`,
    ], { encoding: "utf8", timeout: (timeoutSec + 30) * 1000 });
    const out = (r.stdout ?? "").trim();
    const dur = Date.now() - t0;
    if (r.status === 0 && /SMOKE-OK/i.test(out)) {
      return { ok: true, failureClass: null, durationMs: dur, output: out.slice(0, 200) };
    }
    const text = `${out}\n${r.stderr ?? ""}`;
    let failureClass = "PROVIDER_DOWN";
    if (/at capacity|capacity exhausted|overloaded|503/i.test(text)) failureClass = "PROVIDER_DOWN";
    else if (/429|too many requests|rate limit/i.test(text)) failureClass = "RATE_LIMIT";
    else if (/usage limit|quota|credit/i.test(text)) failureClass = "QUOTA";
    else if (/unauthorized|invalid api key/i.test(text)) failureClass = "AUTH";
    else if (r.status === 124 || /timed? ?out/i.test(text)) failureClass = "RATE_LIMIT";
    return { ok: false, failureClass, durationMs: dur, output: text.slice(0, 200) };
  } catch (e) {
    return { ok: false, failureClass: "UNKNOWN", durationMs: Date.now() - t0, output: String(e.message ?? e).slice(0, 200) };
  }
}

// Pick the first available model for a role; optionally probe candidates live
// when none have cached health. Returns { model, reason } or null (§9: NEVER
// silently substitute a non-approved or paid model).
export function pickModel(role, runsDir, { probeIfUnknown = false, sshHost = "controller" } = {}) {
  const candidates = (FREE_MODEL_REGISTRY[role] ?? []).filter((m) => !isDenied(m));
  if (!candidates?.length) return null;
  for (const m of candidates) {
    const avail = modelAvailable(m, runsDir);
    if (avail.ok) return { model: m, reason: avail.reason };
  }
  if (probeIfUnknown) {
    // All cooled down or unknown — probe the freshest candidate directly.
    for (const m of candidates) {
      const s = smokeModel(m, { sshHost });
      recordModelOutcome(m, runsDir, { success: s.ok, failureClass: s.failureClass, durationMs: s.durationMs });
      if (s.ok) return { model: m, reason: `live smoke OK (${s.durationMs}ms)` };
    }
  }
  return null;
}
