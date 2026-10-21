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
//   node scripts/acceptance-ordinary-session.mjs run [--evidence <outfile>] [--keep]
//   node scripts/acceptance-ordinary-session.mjs verify --evidence <file>
//
// If the provable environment is absent (no authenticated `claude`, memory
// stack down), nothing is faked: the run reports INCOMPLETE and prints the
// exact supervised procedure for a human. The install gate fails closed on
// INCOMPLETE.
import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { randomUUID } from "node:crypto";
import { dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { callMemoryCore, loadGhostMemoryConfig } from "../ghost/ghost-memory.mjs";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const FACT_NUMBER = "731";
export const EVKIND = "singularity-ordinary-session";
export const EVVERSION = 1;
export const STAGES = ["SERVICE_REACHABLE", "AUTHENTICATED", "CAPTURE_VERIFIED", "PERSISTED", "NEW_SESSION_RECALL_VERIFIED"];

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
    const allVerified = STAGES.every((s) => ev.stages.some((x) => x.stage === s && x.state === "VERIFIED"));
    return {
      ok: !!evidence && allVerified,
      state: evidence ? (allVerified ? "VERIFIED" : "INCOMPLETE") : state,
      evidence: evidence ? ev : null,
      detail,
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
    const searchA = await searchTag(tag, memoryConfig, fetchImpl);
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

async function searchTag(tag, cfg, fetchImpl) {
  const q = (key) => callMemoryCore(key, { team_id: cfg.identity.team_id, user_id: cfg.identity.user_id, query: tag, limit: 4 }, cfg, fetchImpl);
  const conv = await q("/v3/conversation/search").catch(() => null);
  const atom = await q("/v3/atomic/search").catch(() => null);
  const hitsOf = (r, key) => {
    const arr = r && !r.error ? (Array.isArray(r.data) ? r.data : (r.data?.results || [])) : [];
    return JSON.stringify(arr).includes(tag);
  };
  return {
    conversation: hitsOf(conv, "v3/conversation/search"),
    atomic: hitsOf(atom, "v3/atomic/search"),
    hits: hitsOf(conv) || hitsOf(atom) ? 1 : 0,
  };
}

function commandOnPath(bin) {
  const r = spawnSync(bin, ["--version"], { encoding: "utf8", timeout: 30_000, windowsHide: true });
  return !r.error && r.status === 0;
}

/** Evidence verification — the ONLY thing the install gate accepts. */
export function evidenceVerdict(e, { clockSkewMs = 10 * 60 * 1000 } = {}) {
  if (!e || typeof e !== "object") return { ok: false, state: "INCOMPLETE", detail: "no ordinary-session evidence" };
  if (e.kind !== EVKIND || e.version !== EVVERSION || e.runtime !== "claude-code")
    return { ok: false, state: "INCOMPLETE", detail: "evidence kind/version mismatch" };
  const raw = JSON.stringify(e);
  if (/sk-[A-Za-z0-9]{6,}/.test(raw)) return { ok: false, state: "FAILED", detail: "evidence contains key-shaped material — refuse and re-run" };
  const missingStage = STAGES.find((s) => !e.stages?.some((x) => x.stage === s && x.state === "VERIFIED"));
  if (missingStage) return { ok: false, state: "INCOMPLETE", detail: `evidence does not verify stage ${missingStage}` };
  const ids = (e.sessions || []).map((s) => s.id).filter((x) => x && x !== "unknown");
  const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
  if (ids.length < 2 || new Set(ids).size !== ids.length || !e.distinctSessions)
    return { ok: false, state: "INCOMPLETE", detail: "evidence does not record two DISTINCT real session ids" };
  if (!ids.every((x) => uuid.test(x)))
    return { ok: false, state: "INCOMPLETE", detail: "session ids are not Claude Code session ids (UUID shape) — evidence is not from a real run" };
  if (!String(e.tag || "").startsWith("SING-ORD-")) return { ok: false, state: "INCOMPLETE", detail: "evidence tag is not a unique per-run identifier" };
  const t0 = Date.parse(e.startedAt), t1 = Date.parse(e.completedAt);
  if (Number.isNaN(t0) || Number.isNaN(t1) || t1 < t0 || t1 - t0 > 2 * 3600_000 + clockSkewMs)
    return { ok: false, state: "INCOMPLETE", detail: "evidence timestamps are missing or implausible" };
  const staleMs = e.maxAgeMs || 14 * 24 * 3600 * 1000; // evidence older than 14 days is stale
  if (Date.now() - t1 > staleMs) return { ok: false, state: "INCOMPLETE", detail: "ordinary-session evidence is stale" };
  return { ok: true, state: "VERIFIED", detail: `ordinary-session evidence verified: tag ${e.tag}, sessions ${ids.join(" → ")}` };
}

/**
 * LIVE corroboration: the acceptance tag must STILL be searchable through the
 * memory service the evidence claims. Schema-complete evidence alone is a
 * document, not proof — a run whose capture never reached the store cannot
 * pass, and a fabricator without the real stack cannot produce this either.
 */
export async function verifyEvidenceLive(e, { env = process.env, fetchImpl = globalThis.fetch } = {}) {
  if (!e || !e.tag) return { ok: false, state: "INCOMPLETE", detail: "no tag to re-verify" };
  const cfg = loadGhostMemoryConfig(env);
  const s = await searchTag(e.tag, cfg, fetchImpl).catch(() => ({ hits: 0 }));
  return s.hits > 0
    ? { ok: true, state: "VERIFIED", detail: `tag ${e.tag} is still searchable through the live memory service` }
    : { ok: false, state: "INCOMPLETE", detail: `tag ${e.tag} is NOT searchable through the live memory service — evidence is not corroborated (re-run the acceptance)` };
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
    const v = evidenceVerdict(e);
    console.log(`${v.ok ? "PASS" : v.state}: ${v.detail}`);
    if (!v.ok) return 1;
    const lv = await verifyEvidenceLive(e);
    console.log(`${lv.ok ? "PASS" : lv.state}: ${lv.detail}`);
    return lv.ok ? 0 : 1;
  }
  const outFile = get("--evidence");
  const keep = argv.includes("--keep");
  const res = await runOrdinaryAcceptance({ env: process.env, keep });
  if (res.evidence && outFile) {
    mkdirSync(dirname(resolve(outFile)), { recursive: true });
    writeFileSync(outFile, `${JSON.stringify(res.evidence, null, 2)}\n`, { mode: 0o600 });
    console.log(`evidence written: ${outFile}`);
  }
  for (const s of res.evidence?.stages || []) console.log(`  [${s.state}] ${s.stage} — ${s.detail}`);
  console.log(`${res.state}: ${res.detail}`);
  if (res.state !== "VERIFIED") {
    console.log(`
SUPERVISED PROCEDURE (run this yourself, then attach the evidence):
  1. Verify stack + proxy:   scripts/start-memory-stack.sh && curl -sS "http://127.0.0.1:$(grep PROXY_PORT memory/upstream/.env | cut -d= -f2)/claude-code/default" -o /dev/null -w '%{http_code}\\n'
  2. Session 1 (capture):    cd "$(mktemp -d)" && claude -p 'Say exactly: Singularity acceptance fact: <your-unique-tag> = 731'
  3. Session 2 (recall):     cd "$(mktemp -d)" && claude -p 'Only using persistent memory, what number is stored for label <your-unique-tag>?'
     Session 2 must answer 731 WITHOUT the label or the sentence being in its prompt, and its session id must differ from session 1.
  4. Attach this JSON as evidence (kind singularity-ordinary-session, stages CAPTURE_VERIFIED/PERSISTED/NEW_SESSION_RECALL_VERIFIED verified, two distinct session ids).`);
  }
  return res.state === "VERIFIED" ? 0 : (res.state === "INCOMPLETE" ? 3 : 1);
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  process.exit(await main(process.argv.slice(2)));
}
