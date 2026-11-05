// bridge-result.mjs — V2 unified bridge result codes + V3 typed failures.
// 0 ok · 42 quota · 43 auth · 44 provider down · 45 transient ·
// 46 privacy-skip · 47 invalid structured output · 48 read-only violation ·
// 49 local config unsupported · 1 unknown (fail closed)
// V3 (run 2026-09-18T03-07-04, runbook §19/§20): RC values are the unchanged
// V2 contract; the 13 typed failure classes below normalize RCs and give
// callers (validation stages, the router) a premium-failover eligibility
// predicate. TEST_FAILURE/VALIDATION_FAILURE are deterministic, non-provider
// outcomes and are ENFORCED as never premium-failover-eligible.
export const RC = {
  OK: 0, QUOTA: 42, AUTH: 43, PROVIDER: 44, TRANSIENT: 45,
  PRIVACY: 46, INVALID: 47, READONLY: 48, CONFIG: 49, UNKNOWN: 1,
  GATEWAY_BUSY: 53, // V3.3.35 ticket 085: sol bridge typed gateway-busy (busy/blocked browser) — infra, engine NOT drained
  // ticket 378: the Sol bridge exits 54 when the request was SUBMITTED (or may
  // have been) and the outcome is unknown: unparseable/non-JSON gateway reply,
  // post-submit parse failure, or a killed call. Never re-sent, never hopped,
  // never substituted by another engine.
  SUBMITTED_UNKNOWN: 54,
};

export function ok(output, meta = {}) {
  return { code: RC.OK, output, ...meta };
}

// ---- V3 typed failure classes (runbook §19, additive 2026-09-18) ----------
// Canonical 13-class taxonomy. Classes without an RC mapping yet
// (CONTEXT_LIMIT, TEST_FAILURE, VALIDATION_FAILURE, VISION_UNAVAILABLE) are
// produced by callers (validation stages, vision probes) that pass the class
// itself; the RC→class map covers every provider-side bridge outcome.
export const FAILURE_CLASS = Object.freeze({
  NONE: "NONE",
  QUOTA: "QUOTA",
  RATE_LIMIT: "RATE_LIMIT",
  AUTH: "AUTH",
  PROVIDER_DOWN: "PROVIDER_DOWN",
  CONTEXT_LIMIT: "CONTEXT_LIMIT",
  TOOL_FAILURE: "TOOL_FAILURE",
  TEST_FAILURE: "TEST_FAILURE",
  MODEL_FAILURE: "MODEL_FAILURE",
  CONFIG_ERROR: "CONFIG_ERROR",
  VALIDATION_FAILURE: "VALIDATION_FAILURE",
  VISION_UNAVAILABLE: "VISION_UNAVAILABLE",
  UNKNOWN: "UNKNOWN",
  // ticket 378 (additive, NOT in PREMIUM_FAILOVER_ELIGIBLE => fail closed):
  // ACCOUNT_THROTTLE = Sol 45 (429 / circuit OPEN): the same account is
  // throttled, so neither a same-engine retry nor an engine/host hop may
  // evade it. GATEWAY_BUSY = Sol 53: bridge-level host hop already happened;
  // engine-level failover to other models is forbidden. SUBMITTED_UNKNOWN =
  // Sol 54: accepted-state unknown, never re-sent.
  ACCOUNT_THROTTLE: "ACCOUNT_THROTTLE",
  GATEWAY_BUSY: "GATEWAY_BUSY",
  SUBMITTED_UNKNOWN: "SUBMITTED_UNKNOWN",
});

// RC → failure class. TRANSIENT (45) normalizes to RATE_LIMIT (transport
// backoff family: HTTP 429/timeouts — §19 example "HTTP 429 -> RATE_LIMIT").
// PRIVACY (46) is a deliberate routing skip, not a provider failure: classed
// UNKNOWN and never premium-failover-eligible (not in the eligible set).
const RC_FAILURE_CLASS = Object.freeze({
  [RC.OK]: FAILURE_CLASS.NONE,
  [RC.QUOTA]: FAILURE_CLASS.QUOTA,
  [RC.AUTH]: FAILURE_CLASS.AUTH,
  [RC.PROVIDER]: FAILURE_CLASS.PROVIDER_DOWN,
  [RC.TRANSIENT]: FAILURE_CLASS.RATE_LIMIT,
  [RC.PRIVACY]: FAILURE_CLASS.UNKNOWN,
  [RC.INVALID]: FAILURE_CLASS.MODEL_FAILURE,
  [RC.GATEWAY_BUSY]: FAILURE_CLASS.PROVIDER_DOWN, // ticket 085: busy/blocked gateway is INFRA (retryable), never a model verdict
  [RC.READONLY]: FAILURE_CLASS.TOOL_FAILURE,
  [RC.CONFIG]: FAILURE_CLASS.CONFIG_ERROR,
  [RC.UNKNOWN]: FAILURE_CLASS.UNKNOWN,
  [RC.SUBMITTED_UNKNOWN]: FAILURE_CLASS.SUBMITTED_UNKNOWN,
});

export function failureClass(rc) {
  if (rc === 0) return FAILURE_CLASS.NONE;
  return RC_FAILURE_CLASS[rc] ?? FAILURE_CLASS.UNKNOWN;
}

// Premium failover eligibility (runbook §20). TEST_FAILURE and
// VALIDATION_FAILURE are DETERMINISTIC, non-provider outcomes: a failed
// implementation goes back to the implementation worker with the actual test
// output — it must NEVER walk the premium provider chain (codex → cursor →
// paid openrouter). Escalation to premium reasoning may only happen later,
// per the configured repair limit, not as provider failover.
// Eligible (§20 "include" list plus AUTH as a provider-side credential
// failure, matching V2 fall-through behavior): QUOTA, RATE_LIMIT, AUTH,
// PROVIDER_DOWN, CONTEXT_LIMIT, MODEL_FAILURE.
export const NON_PREMIUM_FAILOVER = Object.freeze(new Set([
  FAILURE_CLASS.TEST_FAILURE,
  FAILURE_CLASS.VALIDATION_FAILURE,
]));
export const PREMIUM_FAILOVER_ELIGIBLE = Object.freeze(new Set([
  FAILURE_CLASS.QUOTA, FAILURE_CLASS.RATE_LIMIT, FAILURE_CLASS.AUTH,
  FAILURE_CLASS.PROVIDER_DOWN, FAILURE_CLASS.CONTEXT_LIMIT,
  FAILURE_CLASS.MODEL_FAILURE,
]));

// Accepts a V2 rc (number) or a FAILURE_CLASS string. Fail-closed: anything
// unrecognized is NOT premium-failover-eligible.
export function premiumFailoverEligible(rcOrClass) {
  const cls = typeof rcOrClass === "string" ? rcOrClass : failureClass(rcOrClass);
  if (NON_PREMIUM_FAILOVER.has(cls)) return false;
  return PREMIUM_FAILOVER_ELIGIBLE.has(cls);
}

// Classify a failed child-process result (spawnSync-style: status/stdout/stderr).
// Detection strings are live-verified: codex emits "You've hit your usage limit";
// claude emits "session limit"/"usage limit"; openrouter 402 = credits.
// ticket 378 — Sol-specific typing. For the openai-sol bridge the numeric exit
// code has ENGINE-SPECIFIC meaning and must not go through the generic text
// heuristics or the generic transient-retry semantics:
//   0  ok
//   44 provider/transport failure BEFORE submission (eligible as before)
//   45 account-wide 429 / circuit OPEN => ACCOUNT_THROTTLE (never retried or
//      hopped; the 429 circuit is shared by both gateways)
//   53 gateway busy after the bridge's own host hop => GATEWAY_BUSY (never an
//      engine-level free-model fallback)
//   54 submitted, outcome unknown => SUBMITTED_UNKNOWN (never re-sent)
// A killed/timed-out call (spawnSync status null with timedOut/signal) is
// accepted-state unknown => SUBMITTED_UNKNOWN; a plain null status without a
// kill stays the generic fail-closed UNKNOWN.
export const SOL_ENGINE_ID = "openai-sol";
function classifySol({ status, timedOut, signal, text }) {
  if (status === null || status === undefined) {
    if (timedOut || signal) {
      return { code: RC.SUBMITTED_UNKNOWN, failureClass: FAILURE_CLASS.SUBMITTED_UNKNOWN,
        error: `sol bridge killed (${timedOut ? "timeout" : signal}) — accepted-state unknown; not re-sent`, text: text.slice(0, 400) };
    }
    return null;
  }
  switch (status) {
    case RC.PROVIDER:
      return { code: RC.PROVIDER, failureClass: FAILURE_CLASS.PROVIDER_DOWN, error: text.slice(0, 400) };
    case RC.TRANSIENT:
      return { code: RC.TRANSIENT, failureClass: FAILURE_CLASS.ACCOUNT_THROTTLE, error: text.slice(0, 400) };
    case RC.GATEWAY_BUSY:
      return { code: RC.GATEWAY_BUSY, failureClass: FAILURE_CLASS.GATEWAY_BUSY, error: text.slice(0, 400) };
    case RC.SUBMITTED_UNKNOWN:
      return { code: RC.SUBMITTED_UNKNOWN, failureClass: FAILURE_CLASS.SUBMITTED_UNKNOWN, error: text.slice(0, 400) };
    default:
      return null; // 0 / 42 / 43 / 47 / 48 / 49 / other: generic mapping below
  }
}

export function classify({ status, stdout = "", stderr = "", signal = null, timedOut = false } = {}, engine = "") {
  const text = `${stdout}\n${stderr}`;
  if (engine === SOL_ENGINE_ID) {
    const solCls = classifySol({ status, timedOut, signal, text });
    if (solCls) return solCls;
  }
  const rc = status ?? 1;
  if (/you'?ve hit your usage limit|usage limit|session limit|rate.?limit.*exhaust|resets? (daily|weekly)|try again at/i.test(text) && rc !== 0) {
    const reset = text.match(/try again at ([^.\n]+[AP]M|[^\n"]+)/i)?.[1]?.trim() ?? null;
    return { code: RC.QUOTA, error: text.slice(0, 400), resetAt: reset };
  }
  if (/invalid api key|unauthorized|authentication|401|api key (missing|not set)/i.test(text)) {
    return { code: RC.AUTH, error: text.slice(0, 400) };
  }
  if (/insufficient credits|402|credit/i.test(text) && rc !== 0) {
    return { code: RC.QUOTA, error: text.slice(0, 400) }; // openrouter credits exhausted
  }
  if (/model not found|no such model|provider.*(unavailable|down)|overloaded|at capacity|capacity.*exhausted|5\d\d (from|error)/i.test(text)) {
    return { code: RC.PROVIDER, error: text.slice(0, 400) };
  }
  if (/timed? ?out|ETIMEDOUT|ECONNRESET|ECONNREFUSED|temporary failure|temporarily|HTTP 429|429 too many|too many requests/i.test(text)) {
    return { code: RC.TRANSIENT, error: text.slice(0, 400) };
  }
  if (/privacy|confidential|not allowed for (personal|confidential)/i.test(text)) {
    return { code: RC.PRIVACY, error: text.slice(0, 400) };
  }
  if (/readonly violation|attempted (write|edit)|modified files/i.test(text)) {
    return { code: RC.READONLY, error: text.slice(0, 400) };
  }
  if (/flag|option|config|not supported|unknown command/i.test(text) && rc === 49) {
    return { code: RC.CONFIG, error: text.slice(0, 400) };
  }
  // V3.3.1 (2026-09-19): rc=47 is the V2 INVALID/MODEL_FAILURE code — the
  // bridges exit 47 on "answered but empty/unusable output" (both
  // openrouter-bridge and openai-sol-bridge do, by documented contract).
  // With no explicit mapping it fell through to UNKNOWN (rc=1), which is NOT
  // premium-failover-eligible: an openrouter empty-response hard-stopped the
  // whole chain (live, 2026-09-18T22:53) instead of walking to the free
  // fallback. Exit codes are the transport truth; map 47 explicitly.
  if (rc === 47) return { code: RC.INVALID, error: text.slice(0, 400) };
  // V3.3.35 GATEWAY-BUSY FAILOVER GATE (ticket 085): the sol bridge types a
  // busy/blocked browser (429 modal, occupied conversation) as rc53 — an INFRA
  // condition that is retryable/failover-eligible within the Sol host pair and
  // must NEVER be classified as engine exhaustion or a model verdict.
  if (rc === 53) return { code: RC.GATEWAY_BUSY, error: text.slice(0, 400) };
  // rc=0 is success, full stop — the exit code is the transport truth. Text
  // heuristics (e.g. the /config/ pattern above matching a JSON gate body)
  // must never reclassify a zero exit into UNKNOWN/CONFIG.
  if (rc === 0) return { code: RC.OK };
  return { code: rc === 124 ? RC.TRANSIENT : RC.UNKNOWN, error: text.slice(0, 400) };
}

export function describe(code) {
  return {
    0: "ok", 1: "unknown (fail closed)", 42: "quota exhausted", 43: "auth unavailable",
    44: "provider/model unavailable", 45: "transient transport (rate limit family)",
    46: "privacy prohibits route", 47: "invalid structured response (model failure)",
    48: "read-only violation (tool failure)", 49: "unsupported config (config error)",
    53: "gateway busy/blocked (infra — retry after shared backoff; engine not drained)",
  }[code] ?? `rc=${code}`;
}
