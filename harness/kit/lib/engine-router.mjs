// engine-router.mjs — V3 role-based gate router.
// Chooses an engine per stage (plan|review|ask|consult) following config.routing
// roleChains, sticky premium owner, persistent engine-state, and the bridge rc
// contract (fall through on quota/provider/transient; fail closed on unknown).
import { resolveEffort } from "./effort.mjs"; // ticket 189 item 11
import { spawnSync } from "node:child_process";
import { readFileSync, writeFileSync, renameSync, mkdirSync, existsSync, appendFileSync, rmSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { RC, classify, failureClass, FAILURE_CLASS, premiumFailoverEligible } from "./bridge-result.mjs";
import { EngineState, CLAUDE_DISABLED } from "./engine-state.mjs";
import { tryParseGateV2, tryParseLegacyGate, explainParseFailure } from "./gate-parser.mjs";
import { readSolOutfile } from "./sol-outfile.mjs"; // V3.3.1: Sol output is file-based
import { recordInvocation, initTelemetry } from "./invocation-telemetry.mjs";

// V3.3.30 (layered enforcement, Sol-approved consult
// 2026-09-24T02-15-15): caller-class fail-closed boundary on premium engines.
// The coordinator layer must be a LAUNCHER/WATCHER/NARRATOR only; it may not
// spend premium quota or own technical-approval calls. Enforcement lives in
// CODE here, not in prompts: any caller whose ORCH_CALLER env classifies as
// coordinator is denied premium engines (openai-sol/codex/cursor/openrouter-
// paid-reasoning) before any bridge spawn. openai-sol additionally refuses a
// coordinator caller outright (rc 49), even unpinned, so the free auto-chain
// cannot be used to launder a Sol call. ORCH_CALLER is an env tag attached by
// the launch path (openchamber guard tags ORCH_CALLER=openchamber); anything
// untagged defaults to legacy/buffy so existing behavior is unchanged.
export const CALLER_CLASSES = new Set(["coordinator", "buffy", "worker", "legacy"]);
// Surface-name aliases → canonical class. The openchamber forced-command guard
// tags ORCH_CALLER=openchamber; that IS the coordinator surface (ticket 076).
const CALLER_ALIASES = { openchamber: "coordinator", opencode: "coordinator" };
export function resolveCaller(env = process.env) {
  const raw = String(env.ORCH_CALLER ?? "legacy").toLowerCase();
  if (CALLER_ALIASES[raw]) return CALLER_ALIASES[raw];
  return CALLER_CLASSES.has(raw) ? raw : "legacy";
}
const COORDINATOR_DENIED_ENGINES = new Set(["openai-sol", "codex", "cursor", "openrouter-paid-reasoning"]);
// V3.3.34 Phase 7 (Sol items 15-16): the coordinator may not invoke the
// AUTHORITY gate stages AT ALL — any engine, any chain. plan/review/
// final-acceptance verdicts ARE technical approval; the coordinator is a
// launcher/watcher/narrator. ask/consult are not authority stages (consult is
// separately refused for coordinator callers in cmdConsult; ask is Q&A).
export const AUTHORITY_STAGES = new Set(["plan", "review", "final-acceptance"]);

export function callerAuthorityCheck(engine, caller = resolveCaller()) {
  engine = normalizeEngineId(engine);
  if (caller !== "coordinator") return { allowed: true, caller };
  if (COORDINATOR_DENIED_ENGINES.has(engine)) {
    return { allowed: false, caller, rc: RC.CONFIG, error: `authority denied: caller=coordinator may not invoke premium engine "${engine}" — route technical consultation through the requester` };
  }
  return { allowed: true, caller };
}

// Audit trail for every denied authority check (jsonl; best-effort, never fatal).
const AUDIT_FILE = (() => {
  try { return join(dirname(fileURLToPath(import.meta.url)), "..", "runs", "caller-audit.jsonl"); } catch { return null; }
})();
export function auditCallerDeny(entry) {
  try { if (AUDIT_FILE) appendFileSync(AUDIT_FILE, JSON.stringify(entry) + "\n"); } catch { /* never fatal */ }
}

export const PREMIUM = new Set(["openai-sol", "codex", "cursor", "openrouter-paid-reasoning"]); // V3.3: Sol = main paid brain
// V3.4.5 (ticket 155, operator order 2026-09-28): the "fable" engine
// (claude-fable-5.1 via the freemodels-api adapter) was REMOVED ENTIRELY —
// upstream identity was never verifiable and the operator judged it a fraud.
// There is no selectable second reasoning engine anymore: Sol is the only
// premium reasoning brain. Leftover fable selections fail CLOSED (see
// normalizeEngineId/_bridgeScript) and never fall back to Sol or anything else.
export const SOL_FIRST = ["openai-sol"]; // §5: Sol leads every high-value chain
// V3.3.34 Phase 3 (ticket 076, Sol item 7): Sol host fallback is allowed ONLY
// for transport-class failures — the request provably never reached the
// gateway. Classified from openai-sol-bridge.sh source (never guessed):
//   42 QUOTA · 43 AUTH · 44 PROVIDER_DOWN (pre-submission connection/staging
//   only) · 45 RATE_LIMIT (429 / circuit OPEN / watch BLOCKED-after-submission)
//   · 47 MODEL_FAILURE · 48 scrub residue · 49 CONFIG_ERROR · 53 GATEWAY_BUSY
//   (busy/blocked browser, ticket 723: legacy busy exit 46 re-typed to 53 —
//   46 stays privacy/skip; busy semantics live in the V3.3.35 gate below).
// 45/47/48/49 and 42/43 are account/request outcomes — dodging them via the
// other gateway would bypass the shared 429 circuit for the SAME account.
export const SOL_TRANSPORT_RCS = new Set([44]);
export const SOL_NO_FALLBACK_RCS = new Set([42, 43, 45, 47, 48, 49]);
// V3.3.35 GATEWAY-BUSY FAILOVER GATE (operator mandate 2026-09-25, ticket 085):
// rc53 = gateway busy/blocked (typed by the bridge's vision gate — 429 modal or
// occupied browser), NOT a model failure. Failover-eligible ONE hop to the
// other host's catgpt (the BRIDGE performs the hop and re-checks the shared
// circuit first; the router only treats 53 as retryable-infra so the ENGINE
// is never drained and the chain never hard-stops). No free-model fallback is
// implied: 53 is eligible only within the Sol host pair.
export const SOL_GATEWAY_BUSY_RC = 53;
export const SOL_BUSY_ELIGIBLE_RCS = new Set([44, 53]);
export const CLAUDE_SHORT_CIRCUIT = CLAUDE_DISABLED;

// V3.2 §5.7: retire the ambiguous openrouter-glm alias. One engine ID must
// never imply two billing classes — the legacy ID meant PAID GLM reasoning,
// but a switch-case collision made it resolve to the FREE model. Translated
// explicitly at the boundary; canonical identities are openrouter-free-vision
// and openrouter-paid-reasoning.
export function normalizeEngineId(engine) {
  if (engine === "openrouter-glm") return "openrouter-paid-reasoning";
  if (engine === "sol" || engine === "openai") return "openai-sol"; // V3.3 friendly aliases
  return engine;
}
// NOTE ticket 155: "fable" used to normalize as itself (V3.4.4); the engine is
// removed. A leftover "fable" id now reaches _bridgeScript() and fails closed
// there — no translation, no substitution.

export function getRoleChains(cfg) {
  // V3 role-based chains (§14, §17). Returns the chain for a given role.
  const chains = cfg.routing?.roleChains ?? {
    // Ticket 255 (operator order 2026-10-03): Go-plan managed Muse leads every
    // automatic chain; the free tail (space-bunny -> ling-3.1 -> longcat) is
    // the failover, including the out-of-credit case.
    NORMAL: ["opencode-muse-free", "opencode-longcat", "opencode-space-bunny", "opencode-ling31", "openrouter-laguna-free", "openrouter-sante-free"],
    IMPLEMENTATION: ["opencode-muse-free", "opencode-longcat", "opencode-space-bunny", "opencode-ling31", "openrouter-laguna-free", "openrouter-sante-free"],
    VISION: ["opencode-muse-free", "opencode-longcat", "opencode-space-bunny"],
    // V3.3 §5 + operator directive 2026-09-26: Sol heads EVERY default gate
    // chain (catgpt GPT-5.6-sol HIGH = free/unlimited per operator). codex is
    // PIN-ONLY (§23: out of all automatic chains; explicit --codex/--engine
    // still works). paid openrouter is pin-only.
    // Ticket 206 (operator order 2026-10-01, "Sol via catgpt unless operator
    // overrides this"): cursor removed from every default gate chain — premium
    // authority is Sol ONLY; Sol unavailability must be REPORTED, never
    // substituted (cursor signed its own BLOCKED verdict 2026-10-01). cursor
    // stays reachable ONLY via explicit --engine cursor pins.
    // Ticket 255: the gate tail after Sol is the managed Muse then the free tail.
    PREMIUM_REASONING: ["openai-sol", "opencode-muse-free", "opencode-longcat", "opencode-space-bunny", "opencode-ling31", "openrouter-laguna-free", "openrouter-sante-free"],
    PLANNER: ["openai-sol", "opencode-muse-free", "opencode-longcat", "opencode-space-bunny", "opencode-ling31", "openrouter-laguna-free", "openrouter-sante-free"],
    REVIEW: ["openai-sol", "opencode-muse-free", "opencode-longcat", "opencode-space-bunny", "opencode-ling31", "openrouter-laguna-free", "openrouter-sante-free"],
    FINAL_ACCEPTANCE: ["openai-sol", "opencode-muse-free", "opencode-longcat", "opencode-space-bunny", "opencode-ling31", "openrouter-laguna-free", "openrouter-sante-free"],
    CONSULT: ["openai-sol", "opencode-muse-free", "opencode-longcat", "opencode-space-bunny", "opencode-ling31", "openrouter-laguna-free", "openrouter-sante-free"],
  };
  return chains;
}

export function buildFallbacks({ confidential = false, vision = false } = {}) {
  // V3: ask/normal/plan/consult premium chain — role PREMIUM_REASONING
  const chains = getRoleChains({ routing: { roleChains: {} } }); // will be overridden by caller passing cfg
  // Default fallback if roleChains not available (backwards compat)
  return confidential ? [] : ["opencode-muse-free", "opencode-longcat", "opencode-space-bunny", "opencode-ling31", "openrouter-laguna-free", "openrouter-sante-free"];
}

export function buildAskFallbacks({ confidential = false, vision = false } = {}) {
  // V3: ask is free-first by design (premium only with --premium)
  // NORMAL role: managed Muse -> free tail (space-bunny -> ling-3.1 -> longcat)
  if (confidential) return [];
  return ["opencode-muse-free", "opencode-longcat", "opencode-space-bunny", "opencode-ling31", "openrouter-laguna-free", "openrouter-sante-free"];
}

// Operator directive (2026-09-18): review is the peer-review/quality gate on
// real changes — it must never grade its own homework using a free/cheap
// engine. Only codex and paid openrouter are trusted reviewers (claude is
// disabled, Phase-1 Claude-off); cursor and the free opencode tier are good
// enough to draft/plan but not to sign off on whether a fix is correct.
export function buildReviewFallbacks() {
  // V3.3 §3/§4: Sol leads the review chain; codex is FAILOVER-ONLY (explicit
  // pinned consults never come through this automatic path).
  // V3.3 §2.2: a caseState owner that is NOT a chain member (stale owner, e.g.
  // claude-disabled, or codex after its demotion) must not displace the chain.
  return ["opencode-muse-free", "opencode-longcat", "opencode-space-bunny", "opencode-ling31", "openrouter-laguna-free", "openrouter-sante-free"];
}

// Ticket 255 (code-review finding 2): --free-only runs (ORCH_FREE_ONLY=1, set by
// cmdStart/cmdResume for free-only mode) must never touch the subscription
// seat. Pinned engines bypass the filter (explicit operator pins stay pinned).
export function applyFreeOnlyFilter(candidates, { freeOnly = process.env.ORCH_FREE_ONLY === "1", requestedEngine = "auto" } = {}) {
  if (!freeOnly || requestedEngine !== "auto") return candidates;
  return candidates.filter((e) => e !== "opencode-managed-muse");
}

export function isPremium(engine) { return PREMIUM.has(engine); }

export class EngineRouter {
  constructor({ cfg, runsDir, log = console.log }) {
    this.cfg = cfg;
    this.runsDir = runsDir;
    this.log = log;
    this.state = new EngineState(runsDir);
    // V3.2 §6: byte-size stats keep their own file — the ATTEMPT ledger lives
    // in runs/engine-usage.jsonl (lib/invocation-telemetry.mjs) and must not
    // be polluted by the legacy size-record schema.
    this.usageFile = join(runsDir, "bridge-io-sizes.jsonl");
    // V3.3 §2.1: bind telemetry to THIS router's runsDir. Test routers get
    // sandbox ledgers; the production ledger is only ever written by routers
    // constructed with the real runs dir. No global fallback during tests.
    initTelemetry(runsDir);
  }

  _here() { return new URL("..", import.meta.url).pathname; }

  _bridgeScript(engine) {
    engine = normalizeEngineId(engine); // §5.7 defensive: helpers normalize too
    if (engine === "claude") throw new Error(`claude-bridge disabled (${CLAUDE_DISABLED.disabledReason}) — Phase-1 Claude-off`);
    const base = this._here();
    switch (engine) {
      case "openai-sol": return join(base, "openai-sol-bridge.sh"); // V3.3 §6: main reasoning brain
      case "codex": return join(base, "codex-bridge.sh");
      case "claude": return join(base, "claude-bridge.sh");
      case "cursor": return join(base, "cursor-bridge.sh");
      case "opencode-nemotron":
      case "opencode-space-bunny":
      case "opencode-ling31":
      case "opencode-longcat":
      case "opencode-muse-free":
      case "opencode-muse": return join(base, "opencode-bridge.sh");
      // Ticket 230b: PAID managed subscription engine — runs inside the openchamber
      // container (opencode-go credential) via openchamber-managed-seat.mjs.
      case "opencode-managed-muse": return join(base, "opencode-managed-bridge.sh");
      // §5.7: NO openrouter-glm case — normalizeEngineId() translates it to
      // openrouter-paid-reasoning before this switch is reached.
      case "openrouter-free-vision":
      case "openrouter-laguna-free":
      case "openrouter-sante-free":
      case "openrouter-paid-reasoning": return join(base, "openrouter-bridge.sh");
      // 2026-10-19 operator directive: FCC Ghost leads the VISION chain.
      case "fcc-ghost-vision": return join(base, "fcc-ghost-bridge.sh");
      default: throw new Error(`unknown engine: ${engine}`);
    }
  }

  _engineModel(engine) {
    engine = normalizeEngineId(engine);
    switch (engine) {
      case "opencode-nemotron": return this.cfg.opencode.textModel;
      case "opencode-space-bunny": return this.cfg.opencode.textModel ?? "opencode/space-bunny-free";
      case "opencode-ling31": return this.cfg.opencode.lingModel ?? "opencode/ling-3.1-flash-free";
      case "opencode-longcat": return this.cfg.opencode.longcatModel ?? "opencode/longcat-2.5-preview-free";
      case "opencode-muse": return this.cfg.opencode.museModel ?? this.cfg.opencode.textModelFallback;
      case "opencode-muse-free": return this.cfg.opencode.museModel ?? "opencode/muse-spark-1.3-contributor-free";
      case "openrouter-laguna-free": return this.cfg.openrouter?.lagunaFreeModel ?? "poolside/laguna-s-2.1:free";
      case "openrouter-sante-free": return this.cfg.openrouter?.santeFreeModel ?? "inclusionai/ling-3.0-flash-sante:free";
      case "opencode-managed-muse": return this.cfg.opencode.managedMuseModel ?? "opencode-go/muse-spark-1.3-contributor#xhigh";
      case "openai-sol": return this.cfg.openaiSol?.model ?? "catgpt-browser"; // §25: telemetry carries the real model id
      case "fcc-ghost-vision": return this.cfg.fccGhost?.visionModel ?? "nvidia_nim/meta/llama-3.2-11b-vision-instruct"; // 2026-10-19 operator directive
      default: return null;
    }
  }

  // V3.2 §5.3: real image delivery for ACTUAL vision requests. The smoke path
  // staged its image via env vars, but ordinary ask/task routing dropped the
  // image — the model was told an image existed and never received it. Both
  // bridge env conventions are set (each bridge reads its own; the extra var
  // is inert): ORCH_VISION_IMAGE (opencode-bridge.sh), OPENROUTER_IMAGE_FILE
  // (openrouter-bridge.sh). First existing image wins (single-image bridges).
  _visionImageEnv(images) {
    const first = (images ?? []).find((p) => { try { return p && existsSync(p); } catch { return false; } });
    if (!first) return {};
    return { ORCH_VISION_IMAGE: first, OPENROUTER_IMAGE_FILE: first, FCC_GHOST_IMAGE_FILE: first };
  }

  callEngine(engine, { promptFile, stage, effort = null, extraEnv = {}, telemetryCtx = {}, solSessionId = null, solAttach = null }) {
    engine = normalizeEngineId(engine); // §5.7: one ID = one billing class
    // V3.3.30 (ticket 076): caller boundary — deny coordinator→premium BEFORE
    // any spawn, side effect, or cost. Audited + telemetered here directly
    // (the injected test-rc path below is intentionally shadowed: the deny is
    // uniform behavior regardless of fault injection).
    const authz = callerAuthorityCheck(engine);
    if (!authz.allowed) {
      const out = { code: RC.CONFIG, error: authz.error, engine, output: "" };
      auditCallerDeny({ at: new Date().toISOString(), caller: authz.caller, engine, stage: stage ?? null, denied: true, reason: "coordinator-premium-denied" });
      try {
        recordInvocation({
          runId: telemetryCtx.runId ?? null,
          component: telemetryCtx.component ?? "orchestrator",
          role: telemetryCtx.role ?? null,
          purpose: telemetryCtx.purpose ?? stage ?? "premium-deny",
          engine, model: null, billingClass: "premium_quota", attempt: 1,
          success: false, failureClass: FAILURE_CLASS.CONFIG_ERROR, rc: RC.CONFIG,
          paid: false, visionUsed: false, durationMs: 0, fallbackFrom: null,
          note: "caller=coordinator premium engine denied",
        });
      } catch { /* never break routing */ }
      return out;
    }
    const t0 = Date.now();
    const _tel = (res) => {
      // V3.2 §6: EVERY attempt (success or failure) lands in the ledger.
      try {
        recordInvocation({
          runId: telemetryCtx.runId ?? null,
          component: telemetryCtx.component ?? "orchestrator",
          role: telemetryCtx.role ?? this._resolveRole(stage, null),
          purpose: telemetryCtx.purpose ?? stage,
          engine,
          model: this._engineModel(engine) ?? telemetryCtx.model ?? null,
          billingClass: engine === "openai-sol" ? "subscription_included"
            : engine === "opencode-managed-muse" ? "subscription_included"
            : isPremium(engine) ? (engine === "cursor" ? "included" : "premium_quota") : "free",
          attempt: telemetryCtx.attempt ?? 1,
          success: res.code === RC.OK,
          failureClass: res.code === RC.OK ? FAILURE_CLASS.NONE : failureClass(res.code),
          rc: res.code,
          // Ticket 164 §19.16 (audit finding G, operator ruling #2): COST and
          // QUOTA are separate. Sol/CatGPT fronts the operator's ChatGPT
          // subscription — no metered spend, paid:false. Only paid OpenRouter
          // is metered money; codex/cursor burn subscription quotas.
          paid: engine === "openrouter-paid-reasoning",
          visionUsed: !!(telemetryCtx.visionUsed ?? (extraEnv.ORCH_VISION_IMAGE || extraEnv.OPENROUTER_IMAGE_FILE)),
          durationMs: Date.now() - t0,
          fallbackFrom: telemetryCtx.fallbackFrom ?? null,
          note: res.error?.slice(0, 150),
      // §25: Sol token usage arrives via the bridge's sidecar and flows
      // through telemetryCtx — never inside the gate text itself. Flat
      // fields so usageSummary() can aggregate without special cases.
      ...(engine === "openai-sol" && telemetryCtx.solUsage ? {
        inputTokens: telemetryCtx.solUsage.inputTokens,
        outputTokens: telemetryCtx.solUsage.outputTokens,
        totalTokens: telemetryCtx.solUsage.totalTokens,
      } : {}),
        });
      } catch { /* never break routing */ }
    };
    // Map engine aliases for test RC (backwards compat with bridge-test)
    // Check both old and new engine names for test RC
    const testEngines = [engine];
    if (engine === "openrouter-paid-reasoning") testEngines.push("openrouter-glm");
    if (engine === "openrouter-glm") testEngines.push("openrouter-paid-reasoning");
    if (engine === "openrouter-free-vision") testEngines.push("openrouter-glm");
    let testRc = null;
    for (const te of testEngines) {
      const rc = process.env[`ORCH_TEST_BRIDGE_${te.toUpperCase().replace(/-/g, "_")}_RC`];
      if (rc) { testRc = rc; break; }
    }
    if (testRc) {
      const rc = parseInt(testRc, 10);
      const out = rc === 0
        ? { code: RC.OK, output: JSON.stringify({
            schema: "orchestration-gate-v2", stage,
            verdict: "APPROVED",
            risk: "NORMAL",
            ...(stage === "plan" ? {
              planSignoff: "APPROVED",
              plan: [{ step: 1, action: "test", reason: "t", validation: "v" }],
              phases: [{ title: "Synthetic test phase", goal: "test goal", acceptance: ["synthetic criterion"], alpha: "echo test ok", beta: "WAIT" }],
              signoffReason: "synthetic fault-injection gate",
            } : { fixPlanSignoff: "NOT_REQUIRED" }),
          }), engine }
        : { code: rc, error: `synthetic rc=${rc} from ORCH_TEST_BRIDGE_${engine.toUpperCase()}_RC`, engine, output: "" };
      _tel(out);
      return out;
    }
    const script = this._bridgeScript(engine);
    // V3.3.26 (ticket 041, operator): Sol may legitimately WATCH a slow
    // browser-side ChatGPT generation for up to SOL_WATCH_BUDGET (3600 s)
    // plus a same-session retrieval turn after the HTTP path gives up, so the
    // spawnSync ceiling must not use the shared 900 s default for Sol.
    // cfg.openaiSol.bridgeTimeoutSec raises it; every other engine keeps
    // routing.bridgeTimeoutSec (other bridges are unaffected).
    const timeoutSec = engine === "openai-sol"
      ? (this.cfg.openaiSol?.bridgeTimeoutSec ?? this.cfg.routing?.bridgeTimeoutSec ?? 900)
      : (this.cfg.routing?.bridgeTimeoutSec ?? 900);
    const env = {
      ...process.env,
      ...this._engineEnv(engine, effort, solSessionId ?? extraEnv.SOL_SESSION_ID ?? null), // 2026-10-01 openchamber: restore V3.3.24 affinity — the callEngine solSessionId OPTION (consult-<id>/run-<id>) was dropped here, forcing every routed Sol call into sol-default
      ...extraEnv,
      BRIDGE_STAGE: stage ?? "",
      BRIDGE_TIMEOUT_SEC: String(timeoutSec),
      // V3.3.35b: browser-native attachments for the Sol bridge (ticket 085).
      ...(engine === "openai-sol" && solAttach?.length ? { SOL_ATTACH: solAttach.join(":") } : {}),
    };
    const outArg = engine === "openai-sol" ? `${promptFile}.sol-out` : "";
    // V3.3.1: pre-spawn cleanup. This prompt path is reused (format-repair,
    // retried gates) — a leftover outfile or usage sidecar from a previous
    // call must never be read as THIS call's output/telemetry.
    if (engine === "openai-sol") {
      try { rmSync(`${promptFile}.sol-out`, { force: true }); } catch { /* */ }
      try { rmSync(`${promptFile}.usage.json`, { force: true }); } catch { /* */ }
    }
    // V3.3 §25: give the Sol bridge a real output file (next to the prompt) so
    // its usage sidecar lands at <promptFile>.usage.json for token telemetry.
    // Empty-string OUT_FILE previously suppressed the sidecar entirely.
    //
    // V3.3.1 ROOT-CAUSE FIX (2026-09-19): the Sol bridge's output contract is
    // FILE-based — content is written to <promptFile>.sol-out and stdout is
    // intentionally EMPTY. callEngine used to write that outfile and never
    // read it back, so every routed Sol call returned "" (rc=0 with no
    // content): gate parsing failed 3× the night of 2026-09-18, cascading
    // into cursor/openrouter failover and the "no eligible reasoning engine
    // remains" hard-stop. The outfile is read back below, on BOTH the
    // success and failure paths.
    const r = spawnSync("bash", [script, promptFile, outArg], {
      encoding: "utf8", timeout: (timeoutSec + 60) * 1000, env,
    });
    const out = ((r.stdout ?? "") + (r.stderr ?? "")).trim();
    // §25: the Sol bridge writes <outfile>.usage.json — read + stash it for
    // telemetry, then delete the sidecar so it can never enter the gate text.
    if (engine === "openai-sol") {
      try {
        const sidecar = `${promptFile}.usage.json`;
        if (existsSync(sidecar)) {
          telemetryCtx.solUsage = JSON.parse(readFileSync(sidecar, "utf8"));
          rmSync(sidecar, { force: true });
        }
      } catch { /* usage capture is best-effort */ }
    } else {
      // Defensive: a stale sidecar from a previous Sol call on this path must
      // never attach free token telemetry to a different engine's record.
      try { rmSync(`${promptFile}.usage.json`, { force: true }); } catch { /* */ }
    }    let res;
    if (engine === "openai-sol") {
      const solFileOut = readSolOutfile(promptFile); // consumes + deletes
      if (r.status === 0 && solFileOut) {
        res = { code: RC.OK, output: solFileOut, engine };
      } else if (r.status === 0) {
        // stdout fallback (bridge called without outfile, or future change).
        // ticket 378: STDOUT ONLY — the bridge's progress/diagnostic lines go to
        // stderr and must never become the consult answer.
        res = { code: RC.OK, output: String(r.stdout ?? "").trim(), engine };
      } else {
        // ticket 378: a spawnSync timeout/kill (status null) is typed by the
        // Sol classifier as SUBMITTED_UNKNOWN (accepted-state unknown).
        const cls = classify({ status: r.status, stdout: r.stdout ?? "", stderr: r.stderr ?? "",
          signal: r.signal ?? null, timedOut: r.error?.code === "ETIMEDOUT" }, engine);
        res = { ...cls, engine, output: "" };
      }
    } else if (r.status === 0) {
      res = { code: RC.OK, output: out, engine };
    } else {
      const cls = classify({ status: r.status, stdout: r.stdout ?? "", stderr: r.stderr ?? "" }, engine);
      res = { ...cls, engine, output: "" };
    }
    _tel(res);
    return res;
  }

  _engineEnv(engine, effort, solSessionId = null) {
    engine = normalizeEngineId(engine); // §5.7 defensive: helpers normalize too
    const e = {};
    switch (engine) {
      case "claude": {
        e.CLAUDE_SSH_HOST = this.cfg.claude.sshHost;
        e.CLAUDE_CONTAINER = this.cfg.claude.container;
        e.CLAUDE_MODEL = this.cfg.claude.model;
        if (effort) e.CLAUDE_EFFORT = effort;
        e.CLAUDE_CONSULT = "1";
        break;
      }
      case "openai-sol": { // V3.3 §6-7: GPT-5.6-sol via the CatGPT browser-emulation gateway
        // V3.3.34 Phase 3 (ticket 076, Sol-approved): primary/fallback hosts +
        // ONE fixed 429 rate-limit host. Legacy `sshHost` parser stays first
        // (policyVersion-1 compat): it fills primary when the new fields are
        // absent. The 429 pacing anchor / cooldown history / circuit breaker
        // MUST coordinate through rateLimitHost regardless of where the
        // request runs — both catgpt gateways front the SAME ChatGPT account.
        const sol = this.cfg.openaiSol ?? {};
        const primary = sol.primarySshHost ?? sol.sshHost ?? "controller";
        e.SOL_SSH_HOST = primary;
        if (sol.fallbackSshHost && sol.fallbackSshHost !== primary) e.SOL_FALLBACK_HOST = sol.fallbackSshHost;
        e.SOL_LIMIT_HOST = sol.rateLimitHost ?? primary;
        e.SOL_BASE_URL = sol.baseUrl ?? "http://127.0.0.1:8300/v1";
        e.SOL_MODEL = sol.model ?? "catgpt-browser";
        // V3.3.28 (ticket 041, Sol FIX PLAN item 3 — dead-wiring fix): the
        // configured Sol ceiling (openaiSol.bridgeTimeoutSec, 5400) was NEVER
        // mapped into the bridge environment, so every Sol call ran at the
        // bridge default 600s and long extractions (~18 min observed) paid a
        // wasted rc28 give-up + watch cycle. Invariant (Sol turn-3): configured
        // timeout -> SOL_TIMEOUT_SEC -> bridge first-request give-up; anything
        // longer -> existing V3.3.26 watch mode. 429/pacing/watch untouched.
        // Stringified (child env must be strings); Sol-ONLY mapping (no other
        // engine may receive SOL_TIMEOUT_SEC accidentally).
        e.SOL_TIMEOUT_SEC = String(
          this.cfg.openaiSol?.bridgeTimeoutSec ??
          this.cfg.routing?.bridgeTimeoutSec ??
          600
        );
        // V3.3.24 (ticket 041, operator): SESSION AFFINITY — the gateway maps
        // each x-session-id to one persistent ChatGPT conversation. A fresh
        // timestamp id per call (the old fallback) created a brand-new chat
        // for EVERY Sol call. Deterministic per-context ids now flow in:
        // consult session → consult-<id>, one orchestration run → run-<id>.
        e.SOL_SESSION_ID = solSessionId ?? this.cfg.openaiSol?.sessionId
          ?? "sol-default";
        break;
      }
      case "codex":
        e.CODEX_SSH_HOST = this.cfg.codex.sshHost;
        e.CODEX_MODEL = this.cfg.codex.model;
        if (effort) e.CODEX_EFFORT = effort;
        break;
      case "cursor":
        e.CURSOR_SSH_HOST = this.cfg.cursor.sshHost;
        e.CURSOR_MODEL = this.cfg.cursor.model;
        break;
      case "opencode-nemotron":
      case "opencode-space-bunny":
      case "opencode-ling31":
      case "opencode-longcat":
      case "opencode-muse-free":
      case "opencode-muse":
        e.OPENCODE_SSH_HOST = this.cfg.opencode.sshHost;
        e.OPENCODE_MODEL = this._engineModel(engine);
        e.OPENCODE_AGENT = this.cfg.opencode.agent;
        { // ticket 189 item 11: highest reasoning variant (Muse -> xhigh). Bridge retries without it on rejection.
          const eff = resolveEffort(e.OPENCODE_MODEL, { enforce: this.cfg.effort?.enforce !== false, exempt: this.cfg.effort?.exempt ?? undefined });
          if (eff.variant) e.OPENCODE_VARIANT = eff.variant;
        }
        break;
      case "opencode-managed-muse":
        // Ticket 255: wire the configured managed model + ssh host through so a
        // config change can never silently diverge from the bridge defaults.
        e.OPENCODE_MANAGED_SSH_HOST = this.cfg.opencode.sshHost;
        e.OPENCODE_MANAGED_MODEL = this._engineModel("opencode-managed-muse");
        break;
      case "fcc-ghost-vision":
        // 2026-10-19 operator directive: FCC Ghost vision via the host-local
        // router (the bridge sshes to the host; the container cannot reach it).
        e.FCC_GHOST_SSH_HOST = this.cfg.fccGhost?.sshHost ?? "controller";
        e.FCC_GHOST_BASE_URL = this.cfg.fccGhost?.baseUrl ?? "http://127.0.0.1:8084/v1";
        e.FCC_GHOST_MODEL = this._engineModel("fcc-ghost-vision");
        e.FCC_GHOST_MAX_TOKENS = String(this.cfg.fccGhost?.maxTokens ?? 1500);
        break;
      case "openrouter-free-vision":
        e.OPENROUTER_SSH_HOST = this.cfg.openrouter.sshHost;
        e.OPENROUTER_MODEL = this.cfg.openrouter.freeVision?.model ?? "openrouter/free";
        e.OPENROUTER_MAX_TOKENS = String(this.cfg.openrouter.freeVision?.maxTokens ?? this.cfg.openrouter.maxTokens ?? 1500);
        break;
      case "openrouter-laguna-free":
      case "openrouter-sante-free": {
        // Ticket 343: explicit verified-free OpenRouter endpoints (native IDs,
        // :free suffix preserved end-to-end; never a paid sibling).
        e.OPENROUTER_SSH_HOST = this.cfg.openrouter.sshHost;
        e.OPENROUTER_MODEL = this._engineModel(engine);
        e.OPENROUTER_MAX_TOKENS = String(this.cfg.openrouter.maxTokens ?? 1500);
        break;
      }
      case "openrouter-paid-reasoning":
        // §5.7: NO openrouter-glm case here — the alias normalized upstream.
        e.OPENROUTER_SSH_HOST = this.cfg.openrouter.sshHost;
        e.OPENROUTER_MODEL = this.cfg.openrouter.paidReasoning?.model ?? this.cfg.openrouter.model;
        e.OPENROUTER_MAX_TOKENS = String(this.cfg.openrouter.paidReasoning?.maxTokens ?? this.cfg.openrouter.maxTokens ?? 1500);
        break;
    }
    return e;
  }

  async _repairOnce(engine, { stage, promptFile, previousOutput, confidential = false }) {
    const pf = promptFile + ".repair";
    const prev = readFileSync(promptFile, "utf8");
    writeFileSync(pf, `${prev}\n\n# FORMAT REPAIR (previous response was not valid gate JSON)\nReturn ONLY one valid orchestration-gate-v2 JSON object for stage="${stage}". No markdown fences, no commentary. Your previous invalid output:\n${previousOutput.slice(0, 4000)}\n`);
    try {
      return this.callEngine(engine, { promptFile: pf, stage, extraEnv: { BRIDGE_FORMAT_REPAIR: "1", ...(confidential ? { SOL_WATCH: "0" } : {}) }, telemetryCtx: this._repairTelCtx ?? { purpose: `${stage}-repair` }, solSessionId: this._repairSolSessionId ?? null });
    } finally {    try {
      rmSync(pf, { force: true });
    } catch { /* ignore */ }
  }
  }

  // Determine role from caseState / stage
  _resolveRole(stage, caseState) {
    if (caseState?.role) return caseState.role;
    // V3.3.6: visionRequired auto-engages the VISION chain for ask-stage calls
    // only. Previously the check ran before the stage checks, so a plan gate
    // with visionRequired recorded role VISION in the ledger (observed live:
    // `role: VISION, purpose: plan` rows) and would have re-routed gate chains
    // had VISION logic ever applied to gate stages. Gates keep their own roles.
    if (stage === "ask" && caseState?.visionRequired) return "VISION"; // V3 §36: vision auto-engages (ask only)
    if (stage === "ask") return "NORMAL";
    if (stage === "final-acceptance") return "FINAL_ACCEPTANCE"; // V3.3 §3/§5
    if (stage === "plan") return "PLANNER";   // V3.3.6: own role chain (was: PREMIUM_REASONING)
    if (stage === "consult") return "CONSULT"; // V3.3.6: own role chain (was: PREMIUM_REASONING)
    if (stage === "review") return "REVIEW";
    return "NORMAL";
  }

  // Main router: returns {source, engine, gate|output, premiumCall, attempts[]}.
  async routeGate({
    stage, promptFile, caseState = null, requestedEngine = "auto",
    forcePremium = false, expectGate = true,
  }) {
    if (!["plan", "review", "ask", "consult", "final-acceptance"].includes(stage)) throw new Error(`bad stage ${stage}`);
    const confidential = caseState?.confidential ?? false;
    const vision = caseState?.visionRequired ?? false;
    const risk = caseState?.risk ?? "NORMAL";
    const escalated = risk === "HIGH" || risk === "CRITICAL" || caseState?.escalated;
    const effort = ["codex"].includes(requestedEngine) || escalated ? (escalated ? "high" : "medium") : null;
    const role = this._resolveRole(stage, caseState);
    requestedEngine = normalizeEngineId(requestedEngine); // §5.7 boundary translation

    // V3.4.5 (ticket 155): the per-stage/run reasoning-engine selection
    // ("use fable" / "plan with sol" caseState.selection) was retired with the
    // fable engine. Stage chains resolve from roleChains exactly as before
    // V3.4.4; an explicit engine pin still works via requestedEngine.

    // V3.3.34 Phase 7 (ticket 076, Sol items 15-16): coordinator callers are
    // denied every authority gate stage regardless of engine — the coordinator
    // checks deterministic case.json compliance instead; it does not approve.
    const _phase7Caller = resolveCaller();
    if (AUTHORITY_STAGES.has(stage) && _phase7Caller === "coordinator") {
      auditCallerDeny({ at: new Date().toISOString(), caller: _phase7Caller, engine: requestedEngine, stage, denied: true, reason: "coordinator-authority-stage-denied" });
      const err = new Error(`authority denied: caller=coordinator may not invoke the ${stage} gate — technical approval is the requester's authority`);
      err.rc = RC.CONFIG;
      throw err;
    }

    let candidates;
    if (requestedEngine !== "auto") {
      candidates = [requestedEngine];
    } else if (stage === "ask") {
      // ask is free-first by design (premium only with forcePremium). V3 §36:
      // vision tasks auto-engage the VISION role chain (opencode-mimo →
      // openrouter-free-vision) — image detected ⇒ vision chain, still free.
      if (forcePremium) candidates = this._getChain("PREMIUM_REASONING");
      else if (vision) candidates = this._getChain("VISION");
      else candidates = this._getChain("NORMAL");
    } else if (stage === "final-acceptance") {
      // V3.3 §3/§5: dedicated FINAL_ACCEPTANCE role chain (Sol-first).
      candidates = this._getChain("FINAL_ACCEPTANCE");
    } else if (stage === "review") {
      // Operator directive: review uses trusted reviewers only
      const reviewChain = this._getChain("REVIEW");
      candidates = caseState?.ownerEngine && reviewChain.includes(caseState.ownerEngine)
        ? [caseState.ownerEngine, ...reviewChain.filter((e) => e !== caseState.ownerEngine)]
        : reviewChain;
    } else {
      // V3.3.6: plan/consult route through their OWN role chains from config
      // (PLANNER / CONSULT — Sol-first, then cursor, paid reasoning, and the
      // free opencode tail). They were previously hardwired to
      // PREMIUM_REASONING (no free tail): when every premium engine was
      // quota-exhausted (observed live 2026-09-19 ~03:07Z), the planning gate
      // hard-stopped while opencode-nemotron sat available. Premium-first
      // order is unchanged; the free tail only engages after ALL premium
      // candidates have failed.
      candidates = this._getChain(stage === "consult" ? "CONSULT" : "PLANNER");
    }

    // Ticket 255: --free-only zero-paid contract — strip the subscription seat
    // from automatic candidates (explicit pins unaffected).
    candidates = applyFreeOnlyFilter(candidates, { requestedEngine });

    // Confidential cases never OFFER free promotional endpoints (candidate-
    // list level privacy). Pinned engines bypass this filter — the runtime
    // rc-46 skip below still applies to an explicit operator pin.
    if (confidential && requestedEngine === "auto") {
      // ticket 378 precedent: confidential content never leaves to off-box
      // providers. fcc-ghost-vision (hosted NVIDIA NIM upstream) is excluded
      // exactly like the promotional opencode endpoints — confidential
      // vision stays fail-closed, never silently uploaded.
      candidates = candidates.filter((e) => !String(e).startsWith("opencode") && e !== "fcc-ghost-vision");
    }

    // Backwards compat: if roleChains not in config, fall back to buildFallbacks
    if (!this.cfg.routing?.roleChains && candidates.length === 0) {
      candidates = buildFallbacks({ confidential, vision });
    }

    const attempts = [];
    let repairUsed = false;
    // V3.3 §2.2: runId propagates into EVERY ledger record (attempts, skips,
    // retries, format repairs) — no record loses its run context.
    const runId = caseState?.runId ?? null;
    const telCtx = { runId, component: "orchestrator", role, purpose: stage };
    // V3.2 §5.3: deliver the ACTUAL image on every vision-routed call.
    const visionImages = Array.isArray(caseState?.visionImages) ? caseState.visionImages.filter(Boolean) : [];
    const visionEnv = vision && visionImages.length ? this._visionImageEnv(visionImages) : {};
    // ticket 378: confidential work must not upload a ChatGPT-page screenshot
    // to the separate BYOK vision provider. Keep file/liveness polling only.
    if (confidential) visionEnv.SOL_WATCH = "0";

    // V3.2 §6/§41: pre-call routing decisions (skips) are visible in the
    // ledger too — a candidate never attempted still explains the route.
    const _skip = (engine, rc, note) => {
      attempts.push({ engine, rc, note });
      try {
        recordInvocation({
          ...telCtx, engine,
          model: this._engineModel(engine), billingClass: isPremium(engine) ? "premium_quota" : "free",
          success: false, failureClass: failureClass(rc) ?? "UNKNOWN", rc,
          paid: engine === "openrouter-paid-reasoning", note,
        });
      } catch { /* never break routing */ }
    };

    // Ticket 206 (operator order 2026-10-01, "Sol via catgpt unless operator
    // overrides this"): when the AUTO chain leads with Sol, no other premium
    // engine may be reached by automatic failover. They are removed from the
    // candidate list BEFORE the walk and each removal is ledgered (rc46) — a
    // Sol failure then surfaces as a typed chain stop reported to the
    // operator, never as a substitution. Incident prevented: cursor walked in
    // at chain position 2 on 2026-10-01 and signed its own BLOCKED planning
    // verdict. Explicit operator pins (requestedEngine !== "auto") bypass
    // this guard by design; --consultant sol chains contain Sol only anyway.
    if (requestedEngine === "auto" && candidates[0] === "openai-sol") {
      const skippedPremium = candidates.filter((x) => PREMIUM.has(x) && x !== "openai-sol");
      for (const s of skippedPremium) {
        _skip(s, 46, `SOL_ONLY (ticket 206): ${s} never attempted — no automatic premium failover off Sol; Sol unavailability must be REPORTED to the operator, not substituted`);
      }
      if (skippedPremium.length) candidates = candidates.filter((x) => !skippedPremium.includes(x));
    }

    for (const engine of candidates) {
      // V3.4.5 (ticket 155): fail-closed tombstone for the removed fable engine.
      // An operator leftover selection (old run state, muscle-memory flag,
      // stale case.json) must NEVER fall through to another engine — the
      // no-silent-cross-model-fallback rule from ticket 104 is preserved even
      // though the engine itself is gone.
      if (engine === "fable") {
        const e = new Error(`engine "fable" is REMOVED (ticket 155, operator order 2026-09-28 — freemodels adapter retired as untrusted). Pinned invocations fail closed; no cross-model fallback.`);
        e.rc = RC.CONFIG;
        e.failureClass = "CONFIG_ERROR";
        e.attempts = attempts;
        throw e;
      }
      // Phase-1 Claude-off: the engine is permanently excluded from routing.
      if (engine === "claude") {
        if (requestedEngine === "claude") {
          const e = new Error(`claude is disabled (${CLAUDE_DISABLED.disabledReason}) — explicit short-circuit; use --codex, --engine <name>, or the auto chain (auto routing is NOT re-enabled by this flag)`);
          e.rc = RC.CONFIG;
          e.attempts = attempts;
          throw e;
        }
        _skip(engine, RC.CONFIG, `claude disabled (${CLAUDE_DISABLED.disabledReason}) — short-circuited, not called`);
        continue;
      }
      // Confidentiality: promotional opencode free endpoints never see confidential work.
      if (confidential && engine.startsWith("opencode")) {
        _skip(engine, 46, "confidential case: promotional free endpoint skipped");
        this.state.markPrivacySkip(engine);
        continue;
      }
      if (forcePremium && !isPremium(engine) && candidates.length > 1) {
        _skip(engine, 46, "forcePremium: skipping non-premium");
        continue;
      }
      if (requestedEngine === "auto" && !this.state.available(engine)) {
        // V3.3.1 diagnostics: an operator reading "no eligible reasoning engine
        // remains" must be able to see WHY each candidate was skipped without
        // spelunking ledgers — carry the unavailability reason + retry time.
        const es = this.state.get(engine);
        const retryAt = es?.retryAt ?? es?.cooldownUntil ?? null;
        _skip(engine, 42, `engine-state says unavailable (${es?.state})${retryAt ? ` — retry allowed at ${retryAt}` : ""}`);
        continue;
      }
      if (requestedEngine !== "auto" && !this.state.available(engine)) {
        attempts.push({ engine, rc: 42, note: "pinned engine unavailable per state - attempting anyway (operator pin)" });
      }

      let callPromptFile = promptFile;
      let res;
      {
        res = this.callEngine(engine, {
          promptFile: callPromptFile, stage, effort,
          extraEnv: caseState?.contextFiles?.length && engine.startsWith("opencode")
            ? { ...visionEnv, ORCH_CONTEXT_FILES: caseState.contextFiles.join(":") }
            : visionEnv,
          telemetryCtx: { ...telCtx, visionUsed: !!visionEnv.ORCH_VISION_IMAGE },
          // V3.3.24: session affinity — caller-supplied per-context id wins
          // (consult session, orchestration run); without it the bridge default
          // applies (see _engineEnv).
          solSessionId: caseState?.solSessionId ?? null,
          // V3.3.35b (ticket 085, operator directive): browser-native file
          // attachments. caseState.solAttach (colon-separated LOCAL paths) is
          // forwarded as SOL_ATTACH — the Sol bridge stages them remotely and
          // the gateway uploads them through the real ChatGPT file input, so
          // evidence travels as FILES (no inline-prompt quota burn).
          solAttach: caseState?.solAttach ?? null,
        });
      }

      if (res.code !== RC.OK) {
        attempts.push({ engine, rc: res.code, note: res.error?.slice(0, 120) });
        this._recordFailure(engine, res);
        // Ticket 164 §19.15 SOL RELIABILITY — same-turn recovery for empty/busy
        // Sol results (audit finding B: 27% Sol failures, runs 125–128 all
        // failed at turn 1). rc53 (gateway busy — the bridge already hopped
        // hosts or typed busy) and rc47-from-sol (empty content, gateway idle:
        // the known transient Sol glitch) are recoverable by ONE bounded retry
        // on the SAME engine. The retry is same-turn, once per engine per call
        // (no loop), and NEVER creates a duplicate consult: it re-enters the
        // same bridge invocation with the same promptFile/session binding.
        // After the retry fails, normal classification takes over (failover or
        // typed stop) — recovery is bounded by construction.
        const solEmptyBusy = engine === "openai-sol" && (res.code === RC.GATEWAY_BUSY || res.code === RC.INVALID)
          && !attempts.some((a) => a.engine === engine && a.note?.includes("same-turn recovery"));
        // ticket 378: for Sol this retry re-enters the bridge, i.e. a second
        // submission after a possibly ACCEPTED turn. It is therefore opt-in only
        // (solSameTurnRecovery === true); the default is off.
        if (solEmptyBusy && this.cfg.routing?.solSameTurnRecovery === true) {
          const backoff = res.code === RC.GATEWAY_BUSY ? 20000 + Math.floor(Math.random() * 10000) : 4000;
          attempts.push({ engine, rc: res.code, note: `same-turn recovery: one ${backoff}ms-bounded retry (${res.code === RC.GATEWAY_BUSY ? "busy" : "empty"})` });
          await new Promise((s) => setTimeout(s, backoff));
          const retry = await this.callEngine(engine, {
            promptFile, stage, effort, extraEnv: visionEnv,
            telemetryCtx: { ...telCtx, attempt: 3 },
            solSessionId: caseState?.solSessionId ?? null,
            solAttach: caseState?.solAttach ?? null,
          });
          if (retry.code === RC.OK) {
            res = retry;
            attempts.push({ engine, rc: 0, note: "same-turn recovery succeeded" });
          }
          // Retry failed → fall through to normal classification below
          // (re-attempted with the ORIGINAL res only if retry not OK).
          else if (retry.code !== RC.OK) {
            res = retry;
            attempts.push({ engine, rc: res.code, note: "same-turn recovery exhausted" });
          }
        }
        if (res.code !== RC.OK) {
        // ticket 378: never a same-engine transient retry for Sol — a 45 is the
        // account-wide 429/circuit and a retry is exactly the throttle evasion
        // the shared circuit forbids.
        if (res.code === RC.TRANSIENT && engine !== "openai-sol" && this.cfg.routing?.transientRetries !== 0) {
          await new Promise((s) => setTimeout(s, 1500 + Math.random() * 1500));
          const retry = this.callEngine(engine, { promptFile, stage, effort, extraEnv: visionEnv, solSessionId: caseState?.solSessionId ?? null });
          if (retry.code === RC.OK) {
            res = retry;
            attempts.push({ engine, rc: 0, note: "transient retry succeeded" });
          } else {
            this.state.markTransient(engine);
            continue;
          }
        } else {
          // V3.2 §5.1: typed-failure failover gate. Provider/model-availability
          // classes may walk to the next engine; deterministic/local classes
          // (CONFIG_ERROR, UNKNOWN, TEST_FAILURE, VALIDATION_FAILURE,
          // TOOL_FAILURE, VISION_UNAVAILABLE, privacy skips) STOP the chain —
          // the same class never silently retries elsewhere.
          // ticket 378: a typed class from the engine classifier (Sol 45/53/54)
          // wins over the generic RC mapping.
          const fc = res.failureClass ?? failureClass(res.code);
          if (!premiumFailoverEligible(fc)) {
            attempts.push({ engine, rc: res.code, note: `typed failure ${fc} — failover NOT eligible, chain stopped` });
            const e = new Error(`engine ${engine} failed with ${fc} (rc=${res.code}); failover not eligible`);
            e.rc = res.code;
            e.failureClass = fc;
            e.attempts = attempts;
            throw e;
          }
          continue;
        }
        }
      }

      // success path: validate gate if expected
      if (expectGate) {
        let gate = tryParseGateV2(res.output, stage);
        if (!gate?.valid) {
          // V3.3.1 diagnosability: never discard the raw output on a gate
          // parse failure — the operator cannot fix what they cannot see
          // (weakness #5 from the 2026-09-18 failed run).
          // V3.3.7: capture is PER-ENGINE (the old single .failed-output
          // was overwritten by each successive engine attempt, destroying
          // the first engine's evidence — observed live when Sol's
          // full-size 5,075-token gate response was replaced by the free
          // tail's bash-denied transcript before anyone could read it).
          const stamp = new Date().toISOString().replace(/[:.]/g, "-");
          try { writeFileSync(`${promptFile}.failed-output.${engine}.${stamp}`, String(res.output ?? "")); } catch { /* */ }
          try { writeFileSync(`${promptFile}.parse-error.${engine}.${stamp}`, explainParseFailure(res.output, stage)); } catch { /* */ }
          const legacy = tryParseLegacyGate(res.output, stage);
          if (legacy) {
            attempts.push({ engine, rc: 0, note: "legacy gate format (compat mode)" });
            this.state.markSuccess(engine);
            this._recordUsage(engine, stage, promptFile, res.output); // input/output size stats only — attempt ledger is written in callEngine // input/output size stats only — attempt ledger is written in callEngine // input/output size stats only — attempt ledger is written in callEngine
            if (caseState && !caseState.ownerEngine && isPremium(engine)) caseState.ownerEngine = engine;
            return { source: "engine", engine, gate: legacy, output: res.output, premiumCall: isPremium(engine), attempts, compatibilityMode: true, degraded: attempts.filter((a) => a.rc !== 0).length > 0 };
          }            if (!repairUsed) {
            repairUsed = true;
            attempts.push({ engine, rc: 47, note: `invalid gate JSON - one format repair (${explainParseFailure(res.output, stage)})` });
            this._repairTelCtx = { ...telCtx, purpose: `${stage}-repair`, attempt: 2 };
            this._repairSolSessionId = caseState?.solSessionId ?? null; // V3.3.24: repair lands in the SAME ChatGPT thread
            const repaired = await this._repairOnce(engine, { stage, promptFile, previousOutput: res.output, confidential });
            if (repaired.code === RC.OK) {
              const g2 = tryParseGateV2(repaired.output, stage);
              if (g2?.valid) {
                gate = g2;
                res = repaired;
                attempts.push({ engine, rc: 0, note: "format repair succeeded" });
              }
            }
          }
        }
        if (!gate?.valid) {
          // V3.3.7: carry the parse-failure CLASSIFICATION in the attempts
          // log itself — "rc47" no longer hides whether it was empty text,
          // invalid JSON, or schema/verdict rejection.
          const why = explainParseFailure(res.output, stage);
          attempts.push({ engine, rc: 47, note: `gate still invalid after repair - treating as MODEL_FAILURE (${why})` });
          // V3.2 §5.1: an engine that cannot produce a parseable gate produced
          // a bad model output, not a provider outage. Previously this fell
          // through after markSuccess (a dishonest success record + unlimited
          // chain walk). Now: record the failure honestly; stop unless the
          // class is failover-eligible.
          this._recordFailure(engine, { code: RC.INVALID, failureClass: FAILURE_CLASS.MODEL_FAILURE });
          const fc = FAILURE_CLASS.MODEL_FAILURE;
          if (!premiumFailoverEligible(fc)) {
            const e = new Error(`engine ${engine} produced an invalid gate (MODEL_FAILURE); failover not eligible`);
            e.rc = RC.INVALID;
            e.failureClass = fc;
            e.attempts = attempts;
            throw e;
          }
          continue;
        }
        this.state.markSuccess(engine);
        this._recordUsage(engine, stage, promptFile, res.output); // input/output size stats only — attempt ledger is written in callEngine
        if (caseState && !caseState.ownerEngine && isPremium(engine)) caseState.ownerEngine = engine;
        if (stage === "plan" && caseState && gate.gate.verdict === "APPROVED") {
          caseState._planCacheCandidate = { gate: gate.gate, engine };
        }
        return { source: "engine", engine, gate: gate.gate, output: res.output, premiumCall: isPremium(engine), attempts, degraded: attempts.filter((a) => a.rc !== 0).length > 0 };
      }

      // non-gate output (raw ask)
      this.state.markSuccess(engine);
      this._recordUsage(engine, stage, promptFile, res.output); // input/output size stats only — attempt ledger is written in callEngine
      if (caseState && !caseState.ownerEngine && isPremium(engine)) caseState.ownerEngine = engine;
      return { source: "engine", engine, output: res.output, premiumCall: isPremium(engine), attempts, degraded: attempts.filter((a) => a.rc !== 0).length > 0 };
    }

    // V3.3.1 diagnostics: the error message itself must carry WHY each
    // candidate failed (skip notes include engine-state reasons + retry
    // times; attempt notes include bridge errors) — no ledger spelunking.
    // V3.3.6: the message must also stop driver agents from freelancing —
    // during the 2026-09-19 exhaustion incident the opencode driver read
    // this failure and started implementing the plan itself. This tool
    // PLANS and REVIEWS; it never delegates implementation by default.
    const e = new Error(
      `no eligible reasoning engine remains (attempts: ${attempts.map((a) => `${a.engine}:rc${a.rc}${a.note ? ` — ${a.note}` : ""}`).join("; ")}). ` +
      `STOP — do NOT implement the task yourself and do not code from your own judgment: ` +
      `this orchestrator plans and reviews only. Report the block to the operator, or retry when ` +
      `quota resets (engine retry times: run \`bun orchestrate.mjs engines\`).`
    );
    e.rc = 1;
    e.attempts = attempts;
    throw e;
  }

  _getChain(role) {
    const chains = this.cfg.routing?.roleChains ?? {};
    const chain = chains[role];
    if (Array.isArray(chain) && chain.length > 0) return chain;
    // Fallbacks for missing roles
    const fallbacks = {
      NORMAL: ["opencode-muse-free", "opencode-longcat", "opencode-space-bunny", "opencode-ling31", "openrouter-laguna-free", "openrouter-sante-free"],
      IMPLEMENTATION: ["opencode-muse-free", "opencode-longcat", "opencode-space-bunny", "opencode-ling31", "openrouter-laguna-free", "openrouter-sante-free"],
      VISION: ["opencode-muse-free", "opencode-longcat", "opencode-space-bunny"],
      PREMIUM_REASONING: ["openai-sol", "opencode-muse-free", "opencode-longcat", "opencode-space-bunny", "opencode-ling31", "openrouter-laguna-free", "openrouter-sante-free"], // ticket 206: Sol-only premium, no cursor; ticket 255 tail
    };
    return fallbacks[role] ?? fallbacks.NORMAL;
  }

  _recordFailure(engine, res) {
    // Use typed failure class from classify result
    const fc = res.failureClass ?? (res.code ? (res.code === RC.QUOTA ? FAILURE_CLASS.QUOTA : res.code === RC.TRANSIENT ? FAILURE_CLASS.RATE_LIMIT : res.code === RC.AUTH ? FAILURE_CLASS.AUTH : res.code === RC.PROVIDER ? FAILURE_CLASS.PROVIDER_DOWN : res.code === RC.INVALID ? FAILURE_CLASS.MODEL_FAILURE : res.code === RC.READONLY ? FAILURE_CLASS.TOOL_FAILURE : res.code === RC.CONFIG ? FAILURE_CLASS.CONFIG_ERROR : FAILURE_CLASS.UNKNOWN) : FAILURE_CLASS.UNKNOWN);

    // Update engine state with failure class
    if (fc === FAILURE_CLASS.QUOTA) this.state.markQuotaExhausted(engine, res.resetAt);
    else if (fc === FAILURE_CLASS.AUTH) this.state.markAuthFailure(engine);
    else if (fc === FAILURE_CLASS.PROVIDER_DOWN) {
      // V3.3.35 GATEWAY-BUSY FAILOVER GATE (ticket 085): rc53 = busy/blocked
      // browser typed by the bridge's vision gate — momentary infra, NOT an
      // outage. The engine stays available (no provider-down cooldown); the
      // bridge already performed the gateway-to-gateway hop or typed rc53 for
      // retry-after-backoff. Never drains the engine, never a model verdict.
      if (res.code !== RC.GATEWAY_BUSY) this.state.markProviderDown(engine);
    }
    else if (fc === FAILURE_CLASS.RATE_LIMIT) this.state.markTransient(engine);
    else if (fc === FAILURE_CLASS.MODEL_FAILURE) { /* model failure - could add specific handling */ }
    // TEST_FAILURE/VALIDATION_FAILURE/VISION_UNAVAILABLE are NOT provider failures - don't mark engine state
  }

  _recordUsage(engine, stage, promptFile, output) {
    try {
      const rec = {
        at: new Date().toISOString(), engine, stage,
        inputBytes: existsSync(promptFile) ? readFileSync(promptFile).length : 0,
        outputBytes: (output ?? "").length,
      };
      appendFileSync(this.usageFile, JSON.stringify(rec) + "\n");
    } catch { /* telemetry must never break routing */ }
  }
}
