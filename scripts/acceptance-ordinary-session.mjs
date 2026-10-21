#!/usr/bin/env node
// scripts/acceptance-ordinary-session.mjs — REAL ordinary-session memory
// acceptance for Claude Code:
//
//   TWO genuinely independent `claude` sessions, both routed through the
//   production memory proxy (exactly what the installer configures), prove
//   automatic CAPTURE of a unique fact from a normal conversation and
//   NEW-session RECALL of that fact without reusing the first session's
//   transcript or a manually injected answer.
//
// Evidence contract (the installer gate consumes evidence, never claims):
//   every evidence file records the five stages the proof is composed of:
//
//     SERVICE_REACHABLE → AUTHENTICATED → CAPTURE_VERIFIED → PERSISTED
//     → NEW_SESSION_RECALL_VERIFIED
//
// Requirements enforced here:
//   - a unique per-run tag (never a shared or replayed identifier);
//   - two DISTINCT Claude session ids (the recall is never the old transcript);
//   - the recall prompt does NOT contain the fact — only the memory loop can
//     supply it;
//   - the persisted record is searchable through the REAL memory service the
//     runtime uses — never a stand-in;
//   - bounded cleanup: both disposable workspaces are removed afterwards;
//   - no secrets and no raw conversations in the evidence file.
//
// Usage:
//   node scripts/acceptance-ordinary-session.mjs run [--runtime claude-code|openchamber] [--option 3|4] [--evidence <outfile>] [--keep]
//   node scripts/acceptance-ordinary-session.mjs verify --evidence <file>
//
// Spinner: `--runtime openchamber` (or --option 3|4) uses the NATIVE OpenChamber
// driver (§4 production round): two genuine `opencode run` primary-agent
// sessions at the target's OWN capture roots through the TARGET's installed
// capture plugin (`product-office` plugin) — the plugin's own scope + reconcile
// code produces the memory, no Claude Code dependency, no synthetic capture.
//
// If the provable environment is absent (no authenticated `claude`, memory
// stack down), nothing is faked: the run reports INCOMPLETE and prints the
// exact supervised procedure for a human. The install gate fails closed on
// INCOMPLETE.
import { spawnSync } from "node:child_process";
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join, resolve } from "node:path";
import { randomUUID } from "node:crypto";
import { dirname } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { callMemoryCore, loadGhostMemoryConfig } from "../ghost/ghost-memory.mjs";
import { discoverOpenchamber, resolveConfigDir } from "./attach-openchamber.mjs";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const FACT_NUMBER = "731";
/** The unique, harmless acceptance fact a capture session states verbatim. */
const APP_FACT = (tag) => `Singularity acceptance fact: ${tag} = ${FACT_NUMBER}`;
const OPENCODE_SESSION_RE = /^ses_[A-Za-z0-9_-]{8,}$/; // OpenCode-native session id shape
export const EVKIND = "singularity-ordinary-session";
export const EVVERSION = 2;
export const STAGES = ["SERVICE_REACHABLE", "AUTHENTICATED", "CAPTURE_VERIFIED", "PERSISTED", "NEW_SESSION_RECALL_VERIFIED"];

/**
 * Canonical installation-option identity. The CLI accepts "3"/"4" (strings),
 * older fixtures and the installer once used numbers, and JSON files can hold
 * either. Every comparison goes through this helper so a real CLI-generated
 * evidence file and the installer gate agree, while option 3 still never
 * satisfies option 4 (or a Claude Code option). Returns null for anything that
 * is not exactly one of the four options.
 */
export function normalizeOptionId(value) {
  if (value === null || value === undefined || value === "") return null;
  const s = String(value).trim();
  return ["1", "2", "3", "4"].includes(s) ? s : null;
}
export const RUNTIMES = {
  "claude-code": "two headless `claude` sessions through the production memory proxy (installation options 1 and 2)",
  "openchamber": "two genuine OpenChamber/OpenCode-native sessions through the installed capture plugin (installation options 3 and 4)",
};

export function record(stage, ok, detail = "") {
  return { stage, state: ok ? "VERIFIED" : "FAILED", detail: String(detail).slice(0, 200) };
}

const nowIso = () => new Date().toISOString();

/** Run one disposable headless session; returns { ok, sessionId, answer, detail }. */
export function runClaudeSession({ workspace, prompt, env, timeoutMs = 240_000 }) {
  const r = spawnSync("claude", ["-p", prompt, "--output-format", "json"], {
    cwd: workspace,
    env,
    encoding: "utf8",
    timeout: timeoutMs,
    windowsHide: true,
  });
  if (r.error || r.status !== 0) {
    const err = String((r.error && r.error.message) || r.stderr || `exit ${r.status}`);
    return { ok: false, sessionId: null, answer: "", detail: `claude session failed: ${err.slice(0, 160)}` };
  }
  let j = null;
  try { j = JSON.parse(r.stdout || "{}"); } catch { /* non-JSON */ }
  const answer = typeof j?.result === "string" ? j.result : String(r.stdout || "").slice(0, 2000);
  return { ok: true, sessionId: typeof j?.session_id === "string" ? j.session_id : null, answer, detail: "" };
}

/** Fresh parent-routing env for a session: the production proxy + scoped key. */
export function sessionEnv(cfg, extra = {}) {
  return {
    ...process.env,
    ANTHROPIC_BASE_URL: `${cfg.claudeProxyUrl}`,
    ANTHROPIC_AUTH_TOKEN: cfg.userKey,
    ...extra,
  };
}

/**
 * The full automated proof. Returns { ok, state, evidence|null, detail }.
 * Config: SINGULARITY_MEMORY_CONFIG or the product default (production config).
 */
export async function runOrdinaryAcceptance({ env = process.env, fetchImpl = globalThis.fetch, keep = false } = {}) {
  const cfgBase = loadGhostMemoryConfig(env);
  const memoryConfig = {
    ...cfgBase,
    // parent sessions run under the proxy's claude-code/default client scope
    claudeProxyUrl: env.SINGULARITY_MAIN_AGENT_PROXY_URL
      || `http://127.0.0.1:${(env.PROXY_PORT || "8096")}/claude-code/default`,
  };
  const stages = [];
  const done = (detail, evidence = null, state = "INCOMPLETE") => {
    const base = {
      kind: EVKIND, version: EVVERSION, runtime: "claude-code",
      startedAt: new Date().toISOString(), completedAt: nowIso(),
      stages, sessions: [], distinctSessions: false, cleanupScope: [],
      identityScope: { team_id: memoryConfig.identity.team_id, user_id: memoryConfig.identity.user_id },
      note: env.SINGULARITY_ORDINARY_SESSION_NOTE || "",
    };
    const ev = { ...base, ...(evidence || {}) };
    const verdict = evidence ? completionVerdict(ev, { runtime: "claude-code" }) : null;
    const verified = !!(evidence && verdict.ok);
    return {
      ok: verified,
      state: evidence ? (verified ? "VERIFIED" : "INCOMPLETE") : state,
      evidence: evidence ? ev : null,
      detail: verified || !evidence ? detail : `${detail} — evidence rejected by the gate: ${verdict.detail}`,
    };
  };
  for (const s of STAGES) stages.push(record(s, false, "not reached"));

  // 1. SERVICE_REACHABLE: the parent-session proxy lane must answer.
  if (!commandOnPath("claude")) {
    return done("no authenticated `claude` CLI on PATH — the automated proof needs a live Claude Code runtime");
  }
  const probe = await callMemoryCore("/v3/meta/auth/verify", { user_key: memoryConfig.userKey }, memoryConfig, fetchImpl).catch((e) => ({ error: String(e?.message || e) }));
  const reachable = probe && !probe.error;
  stages[0] = record("SERVICE_REACHABLE", reachable, reachable ? `memory core reachable at ${memoryConfig.baseUrl}` : `memory core unreachable: ${String(probe?.error || "no response").slice(0, 120)}`);
  if (!reachable) return done("the memory service is not reachable — start the stack (scripts/start-memory-stack.sh)");

  // 2. AUTHENTICATED: a live auth/verify with the NON-administrative scoped key.
  const valid = probe && probe.data && probe.data.valid === true;
  stages[1] = record("AUTHENTICATED", valid, valid ? `scoped identity verified (team=${memoryConfig.identity.team_id})` : `auth/verify rejected the scoped key (never an administrative credential)`);
  if (!valid) return done("the scoped memory identity did not verify live (auth/verify data.valid != true)");

  const tag = `SING-ORD-${randomUUID().slice(0, 8)}`;
  const fact = APP_FACT(tag);
  const w1 = mkdtempSync(join(tmpdir(), "sing-ordinary-a-"));
  const w2 = mkdtempSync(join(tmpdir(), "sing-ordinary-b-"));
  const workspaces = [w1, w2];
  // env for the disposable workspaces: a workspace-scoped CLAUDE project config
  // keeps the user's real projects out of the test path entirely.
  const envA = sessionEnv(memoryConfig);
  const envB = sessionEnv(memoryConfig);

  try {
    // 3/4. CAPTURE_VERIFIED + PERSISTED: session A states the unique fact.
    const sA = runClaudeSession({
      workspace: w1,
      prompt: `Repeat exactly this line as your final answer and nothing else: "${fact}"`,
      env: envA,
    });
    const capture = sA.ok && sA.answer.includes(tag);
    stages[2] = record("CAPTURE_VERIFIED", capture, capture ? `ordinary session captured the unique fact (session ${sA.sessionId || "unknown"})` : `session A did not produce the fact line (${(sA.detail || "unrelated response").slice(0, 120)})`);

    // PERSISTED must come from the REAL service: search for the exact tag.
    const searchA = await searchTag(tag, memoryConfig, fetchImpl, env);
    const persisted = capture && searchA.hits > 0;
    stages[3] = record("PERSISTED", persisted, persisted ? `the record is searchable through the live service after session A (conversation=${searchA.conversation}, atomic=${searchA.atomic})` : `the tag is not searchable after session A (conversation=${searchA.conversation}, atomic=${searchA.atomic}) — capture did not persist`);

    // 5. NEW_SESSION_RECALL_VERIFIED: session B is genuinely independent —
    //    different workspace, different session id, prompt states NOTHING about
    //    the fact. Only the memory loop can answer it.
    const sB = runClaudeSession({
      workspace: w2,
      prompt: `A previous session stored a labelled acceptance fact in this installation's persistent memory (team ${memoryConfig.identity.team_id}). Look it up with memory/search if a tool is available. Label: exactly "${tag}". Reply with only the number stored for that label, or ONLY "?" if you cannot find it.`,
      env: envB,
    });
    const distinct = sB.ok && sB.sessionId && sA.sessionId && sB.sessionId !== sA.sessionId;
    const recalled = distinct && sB.answer.includes(FACT_NUMBER) && !sB.answer.includes("?");
    stages[4] = record("NEW_SESSION_RECALL_VERIFIED", recalled,
      recalled ? `new session ${sB.sessionId} recalled the fact (${FACT_NUMBER}) through the memory loop, never through session ${sA.sessionId}'s transcript`
               : `new session did NOT recall the fact (distinct=${distinct}, answer-with-number=${sB.answer.includes(FACT_NUMBER)}) — ${(sB.detail || "memory loop did not supply the value").slice(0, 120)}`);

    const evidence = {
      tag, factLabel: tag, factNumber: FACT_NUMBER,
      stages: [...stages],
      sessions: [
        { id: sA.sessionId || "unknown", role: "capture", workspace: w1 },
        { id: sB.sessionId || "unknown", role: "recall", workspace: w2 },
      ],
      distinctSessions: !!distinct,
      cleanupScope: keep ? ["workspaces kept by --keep (operator-owned now)"] : ["both disposable workspaces removed"],
      note: env.SINGULARITY_ORDINARY_SESSION_NOTE || "",
    };
    const finalAnswersAllVerified = STAGES.every((s) => evidence.stages.some((x) => x.stage === s && x.state === "VERIFIED"));
    const res = {
      ok: finalAnswersAllVerified,
      state: finalAnswersAllVerified ? "VERIFIED" : "INCOMPLETE",
      evidence,
      detail: finalAnswersAllVerified
        ? "real ordinary-session capture and NEW-session recall verified end to end via the production proxy and memory service"
        : "the ordinary-session acceptance did not fully verify — see per-stage details",
    };
    if (!keep) for (const w of workspaces) rmSync(w, { recursive: true, force: true });
    return res;
  } catch (e) {
    if (!keep) for (const w of workspaces) rmSync(w, { recursive: true, force: true });
    return done(`harness failure: ${String(e?.message || e).slice(0, 160)}`);
  }
}

async function searchTag(tag, cfg, fetchImpl, env = {}) {
  // The claude-code lane captures under the proxy's URL-path client scope
  // (/{agent}/{spaceId}/… → service partition `default`), which overrides the
  // configured service id — so the search MUST use the same partition the
  // capture was written under.
  const searchCfg = { ...cfg, serviceId: env.m?.SINGULARITY_CC_SEARCH_SERVICE_ID || "default" };
  const identity = cfg.identity || loadGhostMemoryConfig(env.m).identity;
  const q = (key) => callMemoryCore(key, { team_id: identity.team_id, user_id: identity.user_id, query: tag, limit: 4 }, searchCfg, fetchImpl);
  const conv = await q("/v3/conversation/search").catch(() => null);
  const atom = await q("/v3/atomic/search").catch(() => null);
  // Real response shapes on this kernel: conversation/search -> {data:{messages:[…]}},
  // atomic/search -> {data:{items:[…]}} (legacy {data:[…]} and {data:{results:[…]}}
  // accepted too). A shape the search does not answer with can never "hit".
  const hitsOf = (r) => { const d = r && !r.error ? (r.data ?? r) : null; const arr = Array.isArray(d) ? d : (d?.results || d?.messages || d?.items || []); return JSON.stringify(arr).includes(tag); };
  return {
    conversation: hitsOf(conv),
    atomic: hitsOf(atom),
    hits: hitsOf(conv) || hitsOf(atom) ? 1 : 0,
  };
}

function commandOnPath(bin) {
  const r = spawnSync(bin, ["--version"], { encoding: "utf8", timeout: 30_000, windowsHide: true });
  return !r.error && r.status === 0;
}

/** Evidence verification — the ONLY thing the install gate accepts.
 *  The evidence is BOUND to its runtime (harness) and installation option:
 *  a Claude Code file cannot satisfy an OpenChamber installation, and an
 *  Option 3 file cannot satisfy an Option 4 check. `expectRuntime` defaults
 *  to claude-code (the gate that historically ran this probe); explicit
 *  consumers pass their own binding. Legacy version-1 evidence (claude-code
 *  only) stays verdict-valid for the Claude gate.
 */
/**
 * The ONE completion rule: a real run reports VERIFIED only when its five
 * stages verified AND the produced evidence satisfies the SAME gate the
 * installer/downstream verifier applies (eventObserved, scope, ids, tag,
 * timestamps). Used by both native drivers' `done()` so a standalone run can
 * never claim VERIFIED on evidence its own verifier would reject.
 */
export function completionVerdict(ev, { runtime, option = null } = {}) {
  const stagesOk = STAGES.every((s) => ev?.stages?.some((x) => x.stage === s && x.state === "VERIFIED"));
  if (!stagesOk) return { ok: false, state: "INCOMPLETE", detail: "five acceptance stages are not all verified" };
  const v = evidenceVerdict(ev, { expectRuntime: runtime, expectOption: option });
  return { ok: v.ok, state: v.ok ? "VERIFIED" : "INCOMPLETE", detail: v.detail };
}

export function evidenceVerdict(e, { clockSkewMs = 10 * 60 * 1000, expectRuntime = "claude-code", expectOption = null } = {}) {
  if (!e || typeof e !== "object") return { ok: false, state: "INCOMPLETE", detail: "no ordinary-session evidence" };
  if (e.kind !== EVKIND)
    return { ok: false, state: "INCOMPLETE", detail: "evidence kind mismatch" };
  const isLegacy = e.version === 1;
  if (!isLegacy && e.version !== EVVERSION)
    return { ok: false, state: "INCOMPLETE", detail: `evidence version mismatch (got ${e.version})` };
  if (expectRuntime && e.runtime !== expectRuntime)
    return { ok: false, state: "INCOMPLETE", detail: `evidence was produced on harness "${e.runtime || "unknown"}", but this gate verifies the "${expectRuntime}" runtime — the acceptance must be re-run on the installed option's OWN driver` };
  // Fail CLOSED when an expectation was supplied but is not a real option: an
  // invalid gate value must never silently skip the binding (consult finding).
  const hasExpectation = !(expectOption === null || expectOption === undefined || String(expectOption).trim() === "");
  if (hasExpectation) {
    const expectedOption = normalizeOptionId(expectOption);
    if (!expectedOption)
      return { ok: false, state: "INCOMPLETE", detail: `the gate supplied an invalid installation option (${String(expectOption).slice(0, 20)}) — refusing rather than skipping the option binding` };
    const evidenceOption = normalizeOptionId(e.option);
    if (evidenceOption !== expectedOption)
      return { ok: false, state: "INCOMPLETE", detail: `evidence was bound to installation option ${e.option ?? "(none)"}, but this gate verifies option ${expectOption} — options never share acceptance evidence` };
  }
  const raw = JSON.stringify(e);
  if (/sk-[A-Za-z0-9]{6,}/.test(raw)) return { ok: false, state: "FAILED", detail: "evidence contains key-shaped material — refuse and re-run" };
  const missingStage = STAGES.find((s) => !e.stages?.some((x) => x.stage === s && x.state === "VERIFIED"));
  if (missingStage) return { ok: false, state: "INCOMPLETE", detail: `evidence does not verify stage ${missingStage}` };
  const ids = (e.sessions || []).map((s) => s.id).filter((x) => x && x !== "unknown");
  const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
  if (ids.length < 2 || new Set(ids).size !== ids.length || !e.distinctSessions)
    return { ok: false, state: "INCOMPLETE", detail: "evidence does not record two DISTINCT real session ids" };
  if (e.runtime === "claude-code" && !ids.every((x) => uuid.test(x)))
    return { ok: false, state: "INCOMPLETE", detail: "session ids are not Claude Code session ids (UUID shape) — evidence is not from a real run" };
  if (e.runtime === "openchamber" && !ids.every((x) => /^ses_[A-Za-z0-9_-]+$/.test(x)))
    return { ok: false, state: "INCOMPLETE", detail: "session ids are not OpenChamber/OpenCode-native session identifiers (ses_… shape) — evidence is not from a real native run" };
  if (!String(e.tag || "").startsWith("SING-ORD-")) return { ok: false, state: "INCOMPLETE", detail: "evidence tag is not a unique per-run identifier" };
  if (expectRuntime === "openchamber") {
    // §4: the capture must be observed from the actual lifecycle events of the
    // installed plugin — the evidence must SAY whether the native session end
    // event was the capture trigger (synthetic/direct API paths cannot claim it).
    if (!(e.sessions || []).every((s) => s.eventObserved === true))
      return { ok: false, state: "INCOMPLETE", detail: "the OpenChamber evidence does not record the observed native lifecycle events — capture from the installed plugin, not a direct memory API path" };
    if (!e.memoryScope || !e.memoryScope.serviceId || !e.memoryScope.teamId)
      return { ok: false, state: "INCOMPLETE", detail: "the OpenChamber evidence does not bind the memory scope the capture used" };
  }
  const t0 = Date.parse(e.startedAt), t1 = Date.parse(e.completedAt);
  if (Number.isNaN(t0) || Number.isNaN(t1) || t1 < t0 || t1 - t0 > 2 * 3600_000 + clockSkewMs)
    return { ok: false, state: "INCOMPLETE", detail: "evidence timestamps are missing or implausible" };
  const staleMs = e.maxAgeMs || 14 * 24 * 3600 * 1000; // evidence older than 14 days is stale
  if (Date.now() - t1 > staleMs) return { ok: false, state: "INCOMPLETE", detail: "ordinary-session evidence is stale" };
  return { ok: true, state: "VERIFIED", detail: `ordinary-session evidence verified: runtime ${e.runtime}${e.option ? `, option ${e.option}` : ""}, tag ${e.tag}, sessions ${ids.join(" → ")}` };
}

/**
 * LIVE corroboration: the acceptance tag must STILL be searchable through the
 * memory service the evidence claims, AND that service must be the SAME
 * capture target the evidence used (matched by its scoped identity — the
 * evidence's memoryScope against the target's loadMemoryConfig identity).
 * The gate refuses a package-default identity that does not match the bound
 * scope: an OpenChamber-targeted gate passes its own env so package-default
 * identity can never spuriously confirm an OpenChamber-native run.
 * Schema-complete evidence alone is a document, not proof — a run whose
 * capture never reached the store cannot pass, and a fabricator without the
 * real stack cannot produce this either.
 */
export async function verifyEvidenceLive(e, { env = process.env, fetchImpl = globalThis.fetch } = {}) {
  if (!e || !e.tag) return { ok: false, state: "INCOMPLETE", detail: "no tag to re-verify" };
  const cfg = loadGhostMemoryConfig(env);
  if (e.runtime === "openchamber" && e.memoryScope) {
    // SCOPE-BOUND corroboration: the tag must be found by searching EXACTLY the
    // evidence's recorded scope through the real service with the target's own
    // credentials — a fabricator without the real stack cannot produce that,
    // and a record stored under any other identity never satisfies it.
    const ms = e.memoryScope;
    if (!ms.teamId || !ms.userId)
      return { ok: false, state: "INCOMPLETE", detail: "openchamber evidence lacks a bindable memory scope (teamId/userId)" };
    const body = { team_id: ms.teamId, user_id: ms.userId, agent_id: ms.agentId || "build", query: e.tag, limit: 4 };
    const conv = await callMemoryCore("/v3/conversation/search", body, cfg, fetchImpl).catch(() => null);
    const atom = await callMemoryCore("/v3/atomic/search", body, cfg, fetchImpl).catch(() => null);
    const hit = [conv, atom].some((r) => r && !r.error && JSON.stringify(r.data ?? r).includes(e.tag));
    return hit
      ? { ok: true, state: "VERIFIED", detail: `tag ${e.tag} is STILL searchable under the recorded scope ${ms.serviceId}/${ms.teamId.slice(0, 16)}… through the live memory service` }
      : { ok: false, state: "INCOMPLETE", detail: `tag ${e.tag} is NOT searchable under the recorded scope ${ms.serviceId}/${ms.teamId.slice(0, 16)}… — evidence is not corroborated (re-run the native acceptance)` };
  }
  const s = await searchTag(e.tag, cfg, fetchImpl, env).catch(() => ({ hits: 0 }));
  return s.hits > 0
    ? { ok: true, state: "VERIFIED", detail: `tag ${e.tag} is still searchable through the live memory service` }
    : { ok: false, state: "INCOMPLETE", detail: `tag ${e.tag} is NOT searchable through the live memory service — evidence is not corroborated (re-run the acceptance)` };
}

// ── OPENCHAMBER-NATIVE HARNESS (installation options 3 and 4) ───────────────
// Same evidence contract, different driver: NO Claude Code dependency. Two
// genuine primary-agent OpenCode sessions (the target's installed runtime via
// its real `opencode` CLI) prove automatic capture through the target's own
// installed plugin and NEW-session recall through the same plugin's live
// context hook — the memory loop's native path, not a manual memory write.
// Requirements kept from the Claude Code driver: a unique per-run tag, two
// DISTINCT real session ids, a recall prompt without the fact, verification
// through the real memory service, bounded cleanup, no secrets in evidence.
// Fail-closed everywhere: a missing `opencode`, plugin or storage layout
// reports INCOMPLETE with the exact supervised procedure — nothing is faked.

/** Locate the target OpenChamber configuration directory (the installed one). */
function resolveOpenchamberConfigDir(env = process.env) {
  const explicit = env.SINGULARITY_OPENCHAMBER_CONFIG_DIR || "";
  if (explicit) {
    if (!existsSync(explicit)) throw new Error(`SINGULARITY_OPENCHAMBER_CONFIG_DIR does not exist: ${explicit}`);
    return explicit;
  }
  const target = discoverOpenchamber({ docker: false }); // host-side: native installation only
  if (target.kind === "native") return target.configDir;
  throw new Error(`no native OpenChamber config found (detected: ${target.kind}) — pass SINGULARITY_OPENCHAMBER_CONFIG_DIR; containerized targets are accepted by the SUPERVISED procedure, not automated here`);
}

/** Read the target plugin's memory config (scoped credentials; never printed). */
function loadTargetMemoryConfig(configDir) {
  const p = join(configDir, "product-secrets", "memory.json");
  let raw = null;
  try { raw = JSON.parse(readFileSync(p, "utf8")); } catch { /* absent */ }
  if (!raw || typeof raw.userKey !== "string" || !raw.userKey)
    throw new Error(`the target's plugin memory config is missing or has no userKey (${p}) — attach first with scripts/attach-openchamber.mjs`);
  // A containerized target's baseUrl (http://memory-core:8420) is not
  // host-resolvable; the loopback shim binds 8420 on 127.0.0.1, so the
  // host-side corroboration rewrites ONLY the container alias, never a foreign host.
  const baseUrl = String(raw.baseUrl || "http://127.0.0.1:8420")
    .replace(/\/+$/, "")
    .replace(/^http:\/\/memory-core(?=:|$)/, "http://127.0.0.1");
  return { config: { baseUrl, authPrefix: raw.authPrefix || "Bearer ", gatewayKey: raw.gatewayKey || raw.userKey, userKey: raw.userKey, serviceId: raw.serviceId || "openchamber" }, memoryConfigPath: p, serviceId: raw.serviceId || "openchamber" };
}

/**
 * The TARGET's own installed capture plugin — imported, not re-implemented.
 * The verification therefore uses the same scope and reconcile code that the
 * real OpenChamber instance runs, so a divergent copy can never let the
 * harness "verify" something the target would not do.
 */
async function loadTargetScopeFactory(configDir) {
  const candidates = [join(configDir, "plugins", "product-office", "memory-reconcile.js"), join(ROOT, "openchamber", "plugins", "product-office", "memory-reconcile.js")];
  for (const p of candidates) {
    if (!existsSync(p)) continue;
    const mod = await import(pathToFileURL(p).href);
    if (typeof mod?.scopeForSession !== "function" || typeof mod?.withinMemoryRoots !== "function" || typeof mod?.memoryRoots !== "function")
      throw new Error(`the capture plugin module does not expose the scope API: ${p}`);
    return { scopeForSession: mod.scopeForSession, withinMemoryRoots: mod.withinMemoryRoots, memoryRoots: mod.memoryRoots, source: p };
  }
  throw new Error(`the OpenChamber memory plugin is NOT installed in ${configDir}/plugins/product-office — attach first (scripts/attach-openchamber.mjs)`);
}

/** Sessions under the plugin's capture roots only — the plugin's own contract. */
function workspaceUnderCaptureRoots(roots, env = process.env) {
  // The WORKSPACE the native runtime sees is inside the target (container path).
  // The harness only needs a host-side dir it can spawn from: the bind-mounted
  // workspaces root (SING_OPENCODE_WORKSPACE_HOST_ROOT), the product checkout
  // (SING_ORDINARY_NATIVE_WORKSPACE_BASE/ROOT) or a plain temp dir — the scope
  // derivation uses the REAL directory from the session record (or the mapped
  // container path), never this host path.
  const hostRoot = env.SING_OPENCODE_WORKSPACE_HOST_ROOT || env.SING_ORDINARY_NATIVE_WORKSPACE_BASE || ROOT;
  const wl = join(hostRoot, ".sing-ordinary", String(process.pid));
  try { mkdirSync(wl, { recursive: true }); return wl; } catch { return null; }
}

/** Map a host workspace path onto its target-side path (host-prefix->target-prefix). */
export function mappedWorkspaceDir(w, env = process.env) {
  const map = String(env.SING_OPENCODE_WORKSPACE_MAP || "");
  if (!map) return w;
  const i = map.indexOf("->");
  if (i <= 0) return w;
  const from = map.slice(0, i), to = map.slice(i + 2);
  return w.startsWith(from) ? to + w.slice(from.length) : w;
}

/**
 * One REAL headless OpenCode primary-agent session. Returns { ok, sessionId,
 * answer, detail }. The session id comes FIRST from the runtime's own
 * `--format json` event stream (OpenCode ≥ the shipped versions stream
 * { type, sessionID, part } events; the text parts are the model's answer)
 * and ONLY falls back to the session-store scan — never from a fabricated
 * marker; `knownSessionIds` keeps earlier runs' ids out of the claim.
 */
export function runOpenchamberSession({ workspace, prompt, env = process.env, bin, timeoutMs = 300_000, knownSessionIds = new Set(), storageRoot, sinceMs }) {
  const b = bin || env.SING_OPENCODE_BIN || "opencode";
  const r = spawnSync(b, ["run", prompt, "--format", "json"], { cwd: workspace, env, encoding: "utf8", timeout: timeoutMs, windowsHide: true, maxBuffer: 64 * 1024 * 1024 });
  if (r.error && r.error.code === "ENOENT")
    return { ok: false, sessionId: null, answer: "", detail: `"${b}" not found on PATH — the native driver needs the target's installed OpenCode runtime` };
  // Parse the event stream: OpenCode emits one JSON event per line (older
  // builds may stream differently or exit non-zero on partial streams — the
  // parse is best-effort with the store-scan fallback below).
  let sid = null;
  const texts = [];
  for (const line of String(r.stdout || "").split(/\r?\n/)) {
    if (!line.startsWith("{")) continue;
    try {
      const ev = JSON.parse(line);
      if (typeof ev.sessionID === "string" && /^ses_[A-Za-z0-9_-]+$/.test(ev.sessionID)) sid = ev.sessionID;
      if (ev.type === "text" && typeof ev.part?.text === "string") texts.push(ev.part.text);
    } catch { /* non-JSON line; ignore (the stream tolerates it) */ }
  }
  if (!sid) {
    const m = /ses_[A-Za-z0-9_-]{8,}/.exec(String(r.stdout || "") + String(r.stderr || ""));
    if (m) sid = m[0];
  }
  if (r.error || (r.status !== 0 && !sid)) {
    const err = String((r.error && r.error.message) || r.stderr || `exit ${r.status}`);
    return { ok: false, sessionId: null, answer: texts.join("\n").slice(0, 2000), detail: `opencode session failed: ${err.slice(0, 160)}` };
  }
  const answer = (texts.join("\n") || String(r.stdout || "")).slice(0, 2000);
  if (!sid) {
    const scan = findNewSessionId(storageRoot, knownSessionIds, sinceMs);
    if (!scan) return { ok: true, sessionId: null, answer, detail: "run succeeded but no session id was recoverable from the event stream or the OpenCode storage — the session id could not be proven" };
    sid = scan;
  }
  return { ok: true, sessionId: sid, answer, detail: "" };
}

function listSessionFiles(dir, out = [], depth = 0) {
  if (depth > 4 || out.length > 2000) return out;
  let entries;
  try { entries = readdirSync(dir, { withFileTypes: true }); } catch { return out; }
  for (const e of entries) {
    const full = join(dir, e.name);
    if (e.isDirectory()) listSessionFiles(full, out, depth + 1);
    else if (e.isFile() && /^ses_[A-Za-z0-9_-]+\.json$/.test(e.name)) out.push(full);
  }
  return out;
}

export function findNewSessionId(storageRoot, knownSessionIds, sinceMs) {
  if (!storageRoot) return null;
  const files = listSessionFiles(storageRoot);
  const parsed = [];
  for (const f of files) {
    const id = /^ses_[A-Za-z0-9_-]+/.exec(basename(f))?.[0];
    if (!id || knownSessionIds.has(id)) continue;
    try { if (sinceMs && statSync(f).mtimeMs + 500 < sinceMs) continue; } catch { /* raced file */ }
    if (sinceMs) { const st = statSync(f); if (st.mtimeMs < sinceMs - 1500) continue; }
    parsed.push({ f, st: statSync(f) });
  }
  parsed.sort((a, b) => b.st.mtimeMs - a.st.mtimeMs);
  const winner = parsed[0];
  if (!winner) return null;
  // Two new records written within the same second are not attributable to the
  // session this run just executed — refuse instead of guessing.
  if (parsed[1] && Math.abs(winner.st.mtimeMs - parsed[1].st.mtimeMs) < 1000) return null;
  // The store file NAME carries the real id; a path is never a session id.
  const id = /^ses_[A-Za-z0-9_-]+/.exec(basename(winner.f))?.[0] || null;
  return id && OPENCODE_SESSION_RE.test(id) ? id : null;
}

/**
 * The FULL native proof. Returns { ok, state, evidence|null, detail }.
 * The harness NEVER writes memory itself: the capture record is produced by
 * the target's installed plugin reacting to the real session lifecycle events,
 * and the recall is served by the plugin's live context hook from the store.
 */
export async function runOpenchamberAcceptance({ env = process.env, fetchImpl = globalThis.fetch, keep = false, timeoutMs = 300_000, option = null } = {}) {
  const started = Date.now();
  const stages = STAGES.map((s) => record(s, false, "not reached"));
  const done = (detail, evidence = null, state = "INCOMPLETE") => {
    const ev = { kind: EVKIND, version: EVVERSION, runtime: "openchamber", option: normalizeOptionId(option), startedAt: new Date(started).toISOString(), completedAt: nowIso(), stages, sessions: [], distinctSessions: false, cleanupScope: [], memoryScope: null, note: env.SINGULARITY_ORDINARY_SESSION_NOTE || "", ...(evidence || {}) };
    const verdict = evidence ? completionVerdict(ev, { runtime: "openchamber", option: normalizeOptionId(option) }) : null;
    const verified = !!(evidence && verdict.ok);
    return { ok: verified, state: evidence ? (verified ? "VERIFIED" : "INCOMPLETE") : state, evidence: evidence ? ev : null, detail: verified || !evidence ? detail : `${detail} — evidence gate: ${verdict.detail}` };
  };

  // ── resolve the TARGET (option-specific config, never the package default) ─
  let configDir; try { configDir = resolveOpenchamberConfigDir(env); } catch (e) { return done(`target resolution failed: ${String(e?.message || e).slice(0, 160)}`); }
  let scopeFactory, memTarget;
  try { scopeFactory = await loadTargetScopeFactory(configDir); } catch (e) { return done(`capture plugin check failed: ${String(e?.message || e).slice(0, 160)}`); }
  try { memTarget = loadTargetMemoryConfig(configDir); } catch (e) { return done(`target memory configuration failed: ${String(e?.message || e).slice(0, 160)}`); }
  const cfg = memTarget.config;

  // 1. SERVICE_REACHABLE against the TARGET's own memory base URL.
  const probe = await callMemoryCore("/v3/meta/auth/verify", { user_key: cfg.userKey }, { ...cfg, identity: cfg }, fetchImpl).catch((e) => ({ error: String(e?.message || e) }));
  const reachable = probe && !probe.error;
  stages[0] = record("SERVICE_REACHABLE", reachable, reachable ? `the target's memory service reaches ${cfg.baseUrl} (serviceId ${cfg.serviceId})` : `the target's memory service does not answer: ${String(probe?.error || "no response").slice(0, 120)}`);
  if (!reachable) return done("the target's memory service is not reachable through its configured identity");

  // 2. AUTHENTICATED (scoped, never the administrative credential).
  const valid = probe?.data?.valid === true;
  stages[1] = record("AUTHENTICATED", valid, valid ? `the plugin's scoped identity verified live (serviceId ${cfg.serviceId})` : "the plugin's scoped key did not verify (auth/verify data.valid != true)");
  if (!valid) return done("the target's plugin key did not verify live");

  // Workspace: a disposable dir under the plugin's OWN capture roots — the
  // plugin only captures sessions inside them, so the harness must obey.
  const roots = scopeFactory.memoryRoots(env);
  const w1 = workspaceUnderCaptureRoots(roots, env);
  if (!w1) return done("no usable capture root could host a disposable workspace (the native driver never expands the plugin's capture roots)");
  const workspaces = [w1];
  const known = new Set();
  const storageRoot = env.SING_OPENCODE_STORAGE || null;
  try {
    // 3. CAPTURE_VERIFIED: session A states the unique fact as a normal turn.
    const tag = `SING-ORD-${randomUUID().slice(0, 8)}`;
    const fact = APP_FACT(tag);
    const sA = runOpenchamberSession({ workspace: w1, prompt: `Answer exactly with this line and nothing else: ${fact}`, env, timeoutMs, knownSessionIds: known, storageRoot, sinceMs: started });
    stages[2] = record("CAPTURE_VERIFIED", sA.ok && sA.answer.includes(tag),
      sA.ok && sA.answer.includes(tag)
        ? `the native session produced the fact line${sA.sessionId ? ` (session ${sA.sessionId.slice(0, 24)})` : ", but no proof-bearing session id was recoverable"}`
        : `session A did not produce the fact line (${(sA.detail || "unrelated response").slice(0, 120)})`);
    if (sA.sessionId) known.add(sA.sessionId);
    if (!sA.ok || !sA.answer.includes(tag) || !sA.sessionId) return done("the native capture stage did not verify", null, "INCOMPLETE");

    // The plugin's own scope contract decides the memory scope the record used.
    const sessionARecord = await readOpenCodeSessionRecord(storageRoot, sA.sessionId)
      ||  (storageRoot && { directory: mappedWorkspaceDir(w1, env), projectID: undefined });
    const directory = sessionARecord?.directory || mappedWorkspaceDir(w1, env);
    const projectID = sessionARecord?.projectID || "";
    if (!scopeFactory.withinMemoryRoots(directory)) return done(`session workspace ${directory} is outside the plugin's capture roots — the record is not attributable to the plugin`);
    let scope;
    try { scope = scopeFactory.scopeForSession({ location: { directory }, projectID }, "build"); }
    catch (e) { return done(`the plugin's own scope derivation refused the session: ${String(e?.message || e).slice(0, 120)}`); }

    // Capture/store read-back through the plugin's OWN reconcile query path
    // (the plugin posts to memoryRequest(path) = baseUrl + /v3 + path, so the
    // read-back must use the same surface).
    const queryBody = { ...scope, session_id: sA.sessionId, offset: 0, limit: 50 };
    const rows = await callMemoryCore("/v3/conversation/query", queryBody, cfg, fetchImpl).catch(() => null);
    const convRows = rows && !rows.error ? (rows.messages || rows.data?.messages || []) : [];
    const capturedStore = JSON.stringify(convRows).includes(tag);
    stages[2] = record("CAPTURE_VERIFIED", !!capturedStore, capturedStore ? `the installed plugin wrote the turn for session ${sA.sessionId.slice(0, 24)} (scope ${scope.team_id.slice(0, 12)}…; ${convRows.length} row(s))` : `no conversation row for session ${sA.sessionId.slice(0, 24)} under the derived scope — capture never persisted`);

    // 4. PERSISTED: the record is searchable through the REAL service scope.
    const searchA = await searchTagScoped(tag, cfg, scope, fetchImpl);
    const persisted = capturedStore && searchA.hits > 0;
    stages[3] = record("PERSISTED", persisted, persisted ? `the record is searchable from the real scope (conversation=${searchA.conversation}, atomic=${searchA.atomic})` : `the tag is not searchable from the real scope after session A (conversation=${searchA.conversation}, atomic=${searchA.atomic}) — persistence not verified`);
    if (!persisted) return done("persistence through the real scope not verified", null);

    // The atomic index is updated by the memory service's ASYNC extraction pass
    // (it can take a few minutes after the conversation row lands), and the
    // recall hook reads exactly that index. A recall fired immediately would
    // therefore see nothing and fail — never claim that. Wait (bounded) until
    // the tag becomes searchable through the atomic surface before session B.
    const waitMs = Math.max(0, Math.min(Number(env.SING_ORDINARY_RECALL_WAIT_MS) || 180_000, 300_000));
    const waitStart = Date.now();
    let atomicReady = false;
    const sc = await searchTagScoped(tag, cfg, scope, fetchImpl).catch(() => null);
    if (sc && sc.atomic) atomicReady = true;
    while (!atomicReady && Date.now() - waitStart < waitMs) {
      await new Promise((done) => setTimeout(done, 8000));
      const s2 = await searchTagScoped(tag, cfg, scope, fetchImpl).catch(() => null);
      if (s2 && s2.atomic) atomicReady = true;
    }
    stages[3] = record("PERSISTED", true, `${stages[3].detail || ""} (atomic-index ${atomicReady ? "ready after" : "NOT seen after"} ${Math.round((Date.now() - waitStart) / 1000)}s)`);

    // 5. NEW_SESSION_RECALL_VERIFIED: a GENUINELY NEW native session — new id,
    // new OpenCode turn, and its recall path is the plugin's live context hook
    // (atomic search) from the SAME scope. The prompt contains only the LABEL.
    const recallPrompt = `A prior session in this workspace stored a labelled fact in this installation's project memory. Using memory recall ONLY, reply with ONLY the number stored for label "${tag}", or "?" if you cannot find it.`;
    const sB = runOpenchamberSession({ workspace: w1, prompt: recallPrompt, env, timeoutMs, knownSessionIds: known, storageRoot, sinceMs: Date.now() });
    if (sB.sessionId) known.add(sB.sessionId);
    const distinct = sA.sessionId && sB.sessionId && sA.sessionId !== sB.sessionId;
    // "?" only fails the check as the ANSWER's verdict (the contract's not-found
    // reply); a model that recalled the number and merely MENTIONED the '?'
    // convention genuinely used the memory loop.
    const refused = /^\s*\?\s*$/.test(sB.answer)
      || /\b(can(?:not|'t|not)|could not|no (?:stored|matching|relevant) )\b/i.test(sB.answer) && !sB.answer.includes(FACT_NUMBER);
    const recalled = distinct && sB.answer.includes(FACT_NUMBER) && !refused;
    stages[4] = record("NEW_SESSION_RECALL_VERIFIED", !!recalled,
      recalled ? `new session ${sB.sessionId.slice(0, 24)} recalled the fact (${FACT_NUMBER}) through the project-scope memory loop, never from session ${sA.sessionId.slice(0, 24)}`
        : `new session did NOT recall the fact (distinct=${distinct}, answer-with-number=${sB.answer.includes(FACT_NUMBER)}) — ${(sB.detail || sB.answer && "unrelated answer" || "memory loop did not supply the value").slice(0, 120)}`);

    // eventObserved is EVIDENCE-BACKED, never asserted: a session counts as
    // observed only when the installed plugin's own conversation rows exist for
    // that runtime session id (the plugin writes them on real lifecycle events).
    const readRows = async (sid, waitMs = 0) => {
      if (!sid) return [];
      const started = Date.now();
      for (;;) {
        const r = await callMemoryCore("/v3/conversation/query", { ...scope, session_id: sid, offset: 0, limit: 50 }, cfg, fetchImpl).catch(() => null);
        const arr = r && !r.error ? (r.messages || r.data?.messages || []) : [];
        if (arr.length || Date.now() - started >= waitMs) return arr;
        await new Promise((done) => setTimeout(done, 5000));
      }
    };
    const convRowsB = await readRows(sB.sessionId, 20_000);
    const eventObservedA = !!capturedStore;
    const eventObservedB = convRowsB.length > 0;
    const evidence = {
      tag, factLabel: tag, factNumber: FACT_NUMBER, option: normalizeOptionId(option), // set by callers when the harness runs under an explicit install option
      stages: [...stages],
      sessions: [
        { id: sA.sessionId, role: "capture", workspace: w1, eventObserved: eventObservedA },
        { id: sB.sessionId || "unknown", role: "recall", workspace: w1, eventObserved: eventObservedB },
      ],
      eventEvidence: {
        source: "installed plugin conversation rows per runtime session id",
        captureRows: convRows.length,
        recallRows: convRowsB.length,
      },
      distinctSessions: !!distinct,
      captureStore: "conversation",
      memoryScope: { serviceId: cfg.serviceId || memTarget.serviceId, teamId: scope.team_id, agentId: scope.agent_id || "build", userId: scope.user_id },
      cleanupScope: keep ? ["workspace kept by --keep (operator-owned now)"] : ["the disposable workspace was removed"],
      runtimeDetail: { configDir: configDir.split(/[\\/]/).pop(), scopeSource: scopeFactory.source, memoryConfigPath: memTarget.memoryConfigPath.split(/[\\/]/).pop(), openCodeStorage: storageRoot || "(runtime default)" },
      note: env.SINGULARITY_ORDINARY_SESSION_NOTE || "",
    };
    if (!keep) try { rmSync(w1, { recursive: true, force: true }); } catch { /* keep operator data intact otherwise */ }
    // The same envelope `done()` uses: addressable, versioned, runtime-bound —
    // the file the gate reads is always a complete verdict artifact, and the
    // standalone verdict applies the SAME evidence gate as the installer.
    const evidenceFull = { kind: EVKIND, version: EVVERSION, runtime: "openchamber", startedAt: new Date(started).toISOString(), completedAt: nowIso(), ...evidence };
    const verdict = completionVerdict(evidenceFull, { runtime: "openchamber", option: normalizeOptionId(option) });
    return { ok: verdict.ok, state: verdict.state, evidence: evidenceFull, detail: verdict.ok ? "OpenChamber-native capture and NEW-session recall verified end to end through the target's installed plugin and live memory service" : `the ordinary-session OpenChamber-native acceptance did not fully verify — ${verdict.detail}` };
  } catch (e) {
    if (!keep) try { rmSync(w1, { recursive: true, force: true }); } catch { /* best effort */ }
    return done(`harness failure: ${String(e?.message || e).slice(0, 160)}`);
  }
}

/** Scoped variant of searchTag: binds the search to the derived project scope. */
async function searchTagScoped(tag, cfg, scope, fetchImpl) {
  const q = (key) => callMemoryCore(key, { team_id: scope.team_id, user_id: scope.user_id, agent_id: scope.agent_id, query: tag, limit: 4 }, cfg, fetchImpl);
  const conv = await q("/v3/conversation/search").catch(() => null);
  const atom = await q("/v3/atomic/search").catch(() => null);
  // Real response shapes on this kernel: conversation/search -> {data:{messages:[…]}},
  // atomic/search -> {data:{items:[…]}} (legacy {data:[…]} and {data:{results:[…]}}
  // accepted too). A shape the search does not answer with can never "hit".
  const hitsOf = (r) => { const d = r && !r.error ? (r.data ?? r) : null; const arr = Array.isArray(d) ? d : (d?.results || d?.messages || d?.items || []); return JSON.stringify(arr).includes(tag); };
  return { conversation: hitsOf(conv), atomic: hitsOf(atom), hits: hitsOf(conv) || hitsOf(atom) ? 1 : 0 };
}

function readOpenCodeSession(storageRoot, sessionId) {
  if (!storageRoot || !sessionId) return null;
  const files = listSessionFiles(storageRoot).filter((f) => basename(f) === `${sessionId}.json`);
  for (const f of files) { try { return JSON.parse(readFileSync(f, "utf8")); } catch { /* try next */ } }
  return null;
}

/**
 * The REAL session record for the produced session id, from the target's OWN
 * OpenCode storage. Primary source: the modern SQLite storage (opencode.db,
 * typically bind-mounted) — read from a byte COPY so the live database is
 * never locked or written. Fallback: the legacy per-session JSON layout.
 * Returns { id, projectID, directory } — exactly what the plugin's own
 * scopeForSession hashes, so the derived scope matches the real capture.
 */
export async function readOpenCodeSessionRecord(storageRoot, sessionId) {
  if (!storageRoot || !sessionId) return null;
  const dbPath = join(storageRoot, "opencode.db");
  if (existsSync(dbPath)) {
    let tmp = null;
    try {
      const { DatabaseSync } = await import("node:sqlite");
      tmp = join(tmpdir(), `sing-ocdb-${randomUUID().slice(0, 8)}.db`);
      copyFileSync(dbPath, tmp);
      for (const ext of ["-wal", "-shm"]) {
        try { copyFileSync(dbPath + ext, tmp + ext); } catch { /* absent */ }
      }
      const db = new DatabaseSync(tmp);
      try {
        const row = db.prepare("SELECT id, project_id, directory FROM session_v2 WHERE id = ?").get(sessionId);
        if (row && row.directory) return { id: row.id, projectID: row.project_id, directory: row.directory };
      } finally { db.close(); }
    } catch { /* fall through to the json layout */ }
    finally { if (tmp) for (const p of [tmp, tmp + "-wal", tmp + "-shm"]) { try { rmSync(p, { force: true }); } catch { /* gone */ } } }
  }
  return readOpenCodeSession(storageRoot, sessionId);
}

export function evidenceFromDisk(p) {
  try { return JSON.parse(readFileSync(p, "utf8")); } catch { return null; }
}

async function main(argv) {
  const get = (k) => { const i = argv.indexOf(k); return i >= 0 ? argv[i + 1] : null; };
  if (argv[0] === "verify") {
    const p = get("--evidence");
    if (!p || !existsSync(p)) { console.error("verify needs --evidence <file> that exists"); return 2; }
    const e = evidenceFromDisk(p);
    const v = evidenceVerdict(e, { expectRuntime: get("--runtime") || undefined, expectOption: get("--option") || undefined });
    console.log(`${v.ok ? "PASS" : v.state}: ${v.detail}`);
    if (!v.ok) return 1;
    const lv = await verifyEvidenceLive(e);
    console.log(`${lv.ok ? "PASS" : lv.state}: ${lv.detail}`);
    return lv.ok ? 0 : 1;
  }
  if (argv[0] !== "run") {
    console.error("usage: acceptance-ordinary-session.mjs run [--runtime claude-code|openchamber] [--option 3|4] [--evidence <file>] [--keep] | verify --evidence <file>");
    return 2;
  }
  const outFile = get("--evidence");
  const keep = argv.includes("--keep");
  const runtime = get("--runtime")
    || ((get("--option") && ["3", "4"].includes(get("--option"))) ? "openchamber" : "claude-code");
  if (!["claude-code", "openchamber"].includes(runtime)) {
    console.error(`unknown runtime "${runtime}" — claude-code (options 1/2) or openchamber (options 3/4)`);
    return 2;
  }
  const optionValue = get("--option");
  const res = runtime === "openchamber"
    ? await runOpenchamberAcceptance({ env: process.env, keep, option: optionValue && ["3", "4"].includes(optionValue) ? optionValue : null })
    : await runOrdinaryAcceptance({ env: process.env, keep });
  if (res.evidence && outFile) {
    mkdirSync(dirname(resolve(outFile)), { recursive: true });
    writeFileSync(outFile, `${JSON.stringify(res.evidence, null, 2)}\n`, { mode: 0o600 });
    console.log(`evidence written: ${outFile}`);
  }
  for (const s of res.evidence?.stages || []) console.log(`  [${s.state}] ${s.stage} — ${s.detail}`);
  console.log(`${res.state}: ${res.detail}`);
  if (res.state !== "VERIFIED") {
    if (runtime === "openchamber") {
      console.log(`
SUPERVISED OPENCHAMBER PROCEDURE (options 3/4, run on a host WITH the target OpenChamber install):
  1. Target must carry the installed runtime: <config>/plugins/product-office (capture plugin) +
     <config>/plugins/singularity-runtime/scripts (shared policy) + <config>/product-secrets/memory.json
     (searched from SINGULARITY_OPENCHAMBER_CONFIG_DIR first, then the native ~/.config/opencode).
  2. Capture:   cd <dir-under-target-capture-roots> && opencode run 'Say exactly: Singularity acceptance fact: <tag> = 731'
  3. Recall:    in a DIFFERENT workspace under the same capture roots, opencode run 'Look in project memory: what number is stored for label <tag>? Reply with only the number, or "?" if not found.'
     The recall session must be a NEW session id (ses_…), its prompt must NOT contain 731, and it must answer 731.
  4. Attach the JSON evidence (runtime "openchamber"): two distinct ses_… ids, eventObserved true on each,
     memoryScope matching the target's configured identity. A Claude Code evidence file can never satisfy an OpenChamber option.
`);
    } else {
      console.log(`
SUPERVISED PROCEDURE (run this yourself, then attach the evidence):
  1. Verify stack + proxy:   scripts/start-memory-stack.sh && curl -sS "http://127.0.0.1:$(grep PROXY_PORT memory/upstream/.env | cut -d= -f2)/claude-code/default" -o /dev/null -w '%{http_code}\\n'
  2. Session 1 (capture):    cd "$(mktemp -d)" && claude -p 'Say exactly: Singularity acceptance fact: <your-unique-tag> = 731'
  3. Session 2 (recall):     cd "$(mktemp -d)" && claude -p 'Only using persistent memory, what number is stored for label <your-unique-tag>?'
     Session 2 must answer 731 WITHOUT the label or the sentence being in its prompt, and its session id must differ from session 1.
  4. Attach this JSON as evidence (kind singularity-ordinary-session, stages CAPTURE_VERIFIED/PERSISTED/NEW_SESSION_RECALL_VERIFIED verified, two distinct session ids).`);
    }
  }
  return res.state === "VERIFIED" ? 0 : (res.state === "INCOMPLETE" ? 3 : 1);
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  process.exit(await main(process.argv.slice(2)));
}
