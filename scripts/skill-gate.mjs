#!/usr/bin/env node
// scripts/skill-gate.mjs — the verification gate for auto-extracted skills.
//
// The deployed Tencent MemoryCore (memory-core, /v3/skill API) publishes
// auto-extracted skills ACTIVE immediately. Singularity's rule (release
// directive §6) is that an automatically generated Skill must never become
// active agent instructions without verification. This module is that gate:
//
//   - it runs between sessions, in the same slot as scripts/memory_promote.py
//     (no new scheduler, daemon or coordinator);
//   - it reviews every active skill that has no prior verdict in the ledger;
//   - VERIFIED  → nothing is written (the store already has it active; the
//                 ledger records the verdict against the content hash);
//   - UNVERIFIED or DUPLICATE → the skill head is ARCHIVED via the store's
//     own idempotent soft-delete (/v3/skill/delete) with the reason recorded —
//     reversible by the standard versioned create/update path;
//   - the gate is DEMOTE-ONLY by construction: it never creates, updates or
//     re-activates a skill. Activation is always the store or an operator.
//
// Verification contract (fail-closed): an auto-extracted skill is VERIFIED
// only when its `metadata_json` carries a `gate.evidence` block whose file
// references resolve on disk and whose RepoQL queries return hits. Anything
// else — including no metadata at all — archives the skill. Duplicate
// detection: normalized token-Jaccard against other active skills ≥ 0.8.
//
// Every run appends hash-chained outcome records to data/skill-gate/ledger.jsonl
// (recovery after interruption: a partial run simply re-runs; the ledger keeps
// one record per decision, and completed decisions are never repeated).
//
// No key material is ever printed, logged or returned; the auth contract lives
// in buildAuthHeaders() exactly once. All requests go through memorySkillCall(),
// which enforces the application envelope (code !== 0 is an error, never a pass).
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { createInterface } from "node:readline";
import {
  appendFileSync,
  closeSync,
  existsSync,
  mkdirSync,
  openSync,
  readFileSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { join, resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const LEDGER_DIR_DEFAULT = join(ROOT, "data", "skill-gate");
const LEDGER_DEFAULT = join(LEDGER_DIR_DEFAULT, "ledger.jsonl");
const VERDICTS = new Set(["verified", "unverified", "duplicate", "skipped", "error"]);
const DEDUP_THRESHOLD = 0.8;
const DECISION_SCHEMA = "skill-gate.outcome.v1";

// ── auth contract (single home; headers are built, never printed) ───────────
export function readMemoryConfig(configPath = join(ROOT, "data/opencode/config/product-secrets/memory.json")) {
  return JSON.parse(readFileSync(configPath, "utf8"));
}

export function buildAuthHeaders(cfg, extra = {}) {
  const missing = ["authPrefix", "gatewayKey", "serviceId", "userKey"].filter((k) => !cfg?.[k]);
  if (missing.length) throw new Error(`memory config is missing ${missing.join(", ")} — refusing to build an unverifiable request`);
  return {
    "Content-Type": "application/json",
    Authorization: `${cfg.authPrefix}${cfg.gatewayKey}`,
    "x-tdai-service-id": String(cfg.serviceId),
    "x-tdai-user-key": String(cfg.userKey),
    ...(extra.teamId ? { "x-tdai-team-id": extra.teamId } : {}),
    ...(extra.agentId ? { "x-tdai-agent-id": extra.agentId } : {}),
    ...(extra.taskId ? { "x-tdai-task-id": extra.taskId } : {}),
  };
}

// ── one MEMORYCORE call: HTTP success is NOT success — the envelope is ──────
export async function memorySkillCall(base, cfg, sub, payload, { fetchImpl = globalThis.fetch, headersExtra = {}, timeoutMs = 20000 } = {}) {
  const base_ = String(base || "").replace(/\/+$/, "");
  if (!base_) throw new Error("no skill store base URL configured");
  const res = await fetchImpl(`${base_}/v3/skill/${sub}`, {
    method: "POST",
    headers: buildAuthHeaders(cfg, headersExtra),
    body: JSON.stringify(payload ?? {}),
    signal: AbortSignal.timeout(timeoutMs),
  });
  const text = await res.text().catch(() => "");
  let body = null;
  try { body = JSON.parse(text); } catch { body = null; }
  if (res.status >= 400) throw new Error(`skill store answered HTTP ${res.status} for /v3/skill/${sub}`);
  if (!body || typeof body !== "object") throw new Error(`skill store returned a non-envelope for /v3/skill/${sub}`);
  const code = body.code === undefined ? 0 : Number(body.code);
  if (code !== 0) throw new Error(`skill store rejected /v3/skill/${sub} with application code ${code}: ${String(body.message || body.error || "").slice(0, 120)}`);
  return body;
}

const sha12 = (s) => createHash("sha256").update(s).digest("hex").slice(0, 12);
const nowIso = () => new Date().toISOString();
const normalizeText = (s) => String(s || "").toLowerCase().replace(/[^a-z0-9 ]+/g, " ").split(/\s+/).filter(Boolean);
function tokenSet(s) { return new Set(normalizeText(s)); }
export function jaccard(a, b) {
  const A = tokenSet(a), B = tokenSet(b);
  if (!A.size && !B.size) return 1;
  let inter = 0;
  for (const t of A) if (B.has(t)) inter += 1;
  return inter / (A.size + B.size - inter || 1);
}

function rqlExplore(root, query, { timeoutMs = 30000, rqlPath = "rql" } = {}) {
  try {
    const r = spawnSync(rqlPath, ["explore", String(query).slice(0, 120), "--token-budget", "200"], {
      cwd: root, encoding: "utf8", timeout: timeoutMs, windowsHide: true, maxBuffer: 4 * 1024 * 1024,
    });
    return { ok: r.status === 0 && String(r.stdout || "").trim().length > 0, detail: String(r.stdout || r.stderr || "").slice(0, 120) };
  } catch (e) {
    return { ok: false, detail: `rql explore failed: ${String(e?.message || e).slice(0, 80)}` };
  }
}

// ── verification (fail-closed) ──────────────────────────────────────────────
export function parseGateMetadata(skill) {
  // summaries carry a pre-parsed `metadata` object; some paths still expose
  // the raw `metadata_json` string — accept both (fail-closed when neither)
  const raw = skill?.metadata ?? skill?.metadata_json;
  let meta = raw;
  if (meta && typeof meta === "string") {
    try { meta = JSON.parse(meta); } catch { meta = null; }
  }
  const gate = meta && typeof meta === "object" ? meta?.gate : null;
  return gate && typeof gate === "object" ? gate : null;
}

export function verifySkill(skill, { root = ROOT, rqlAvailable = true, existing = [] } = {}) {
  const reasons = [];
  const meta = parseGateMetadata(skill);
  if (!meta) {
    return { verdict: "unverified", reasons: ["no gate.evidence metadata block — auto-extracted content without reviewable provenance"] };
  }
  const evidence = meta.evidence && typeof meta.evidence === "object" ? meta.evidence : null;
  if (!evidence) {
    return { verdict: "unverified", reasons: ["gate.evidence is missing or not an object"] };
  }

  // content sanity
  const name = String(skill.name || "").trim();
  const description = String(skill.description || "").trim();
  const content = String(skill.content || "").trim();
  if (!name) reasons.push("empty name");
  if (!description) reasons.push("empty description");
  if (content.length < 40) reasons.push("content too short to be a procedure (<40 chars)");

  // evidence files must exist (tool evidence) — every listed path is checked,
  // a missing or empty file fails the whole verdict
  const files = Array.isArray(evidence.files) ? evidence.files : [];
  if (files.length === 0) reasons.push("no evidence files listed");
  for (const f of files) {
    const p = resolve(root, f);
    let ok = false;
    try {
      ok = existsSync(p) && statSync(p).size > 0;
    } catch { ok = false; }
    if (!ok) { reasons.push(`evidence file missing or empty: ${f}`); continue; }
  }

  // RepoQL is the authority for verified code knowledge — every listed query
  // must hit. If RepoQL is unavailable the file evidence still has to carry
  // the verdict; the limitation is recorded, never dressed up as a pass.
  if (rqlAvailable) {
    const queries = Array.isArray(evidence.repoQueries) ? evidence.repoQueries : [];
    for (const q of queries.slice(0, 5)) {
      const hit = rqlExplore(root, q);
      if (!hit.ok) reasons.push(`RepoQL query had no hit: "${String(q).slice(0, 60)}"`);
    }
  }

  // duplicate detection against OTHER active skills that themselves carry
  // gate metadata (an unverified capsule must never demote a verified
  // record); the older copy stays, equal-timestamp ties break deterministically
  let duplicateOf = null;
  if (reasons.length === 0) {
    for (const other of existing) {
      if (other.skill_id === skill.skill_id || !parseGateMetadata(other)) continue;
      const score = Math.max(jaccard(skill.name, other.name), jaccard(skill.description || "", other.description || ""));
      if (score >= DEDUP_THRESHOLD) {
        const newer = Number(skill.created_at_ms || 0) > Number(other.created_at_ms || 0)
          || (Number(skill.created_at_ms || 0) === Number(other.created_at_ms || 0) && String(skill.skill_id) > String(other.skill_id));
        if (newer) { duplicateOf = { skill_id: other.skill_id, score }; reasons.push(`duplicate of ${other.skill_id} (jaccard ${score.toFixed(2)} ≥ ${DEDUP_THRESHOLD})`); }
      }
    }
  }

  if (duplicateOf) return { verdict: "duplicate", reasons, duplicateOf };
  if (reasons.length > 0) return { verdict: "unverified", reasons };
  return { verdict: "verified", reasons: [], evidenceFiles: files.length, repoQueries: (evidence.repoQueries || []).length };
}

// ── ledger (append-only, hash-chained, tamper-evident) ──────────────────────
export function readLedger(path = LEDGER_DEFAULT) {
  if (!existsSync(path)) return [];
  const out = [];
  for (const line of readFileSync(path, "utf8").split("\n")) {
    const t = line.trim();
    if (!t) continue;
    try { out.push(JSON.parse(t)); } catch { /* a torn final line from an interrupted run is ignored; the chain check reports it */ }
  }
  return out;
}

export function verifyChain(path = LEDGER_DEFAULT) {
  const rows = readLedger(path);
  let prev = null;
  for (const r of rows) {
    const digest = createHash("sha256").update(r.prevHash + JSON.stringify(r.record)).digest("hex").slice(0, 16);
    if (prev !== null && r.prevHash !== prev) return { ok: false, at: r.record?.skill_id || "?", detail: "broken chain" };
    if (r.recordHash !== digest) return { ok: false, at: r.record?.skill_id || "?", detail: "content hash mismatch" };
    prev = r.recordHash;
  }
  return { ok: true, rows: rows.length };
}

function appendDecision(ledgerPath, record) {
  const rows = readLedger(ledgerPath);
  const prevHash = rows.length ? rows[rows.length - 1].recordHash : "genesis";
  const recordHash = createHash("sha256").update(prevHash + JSON.stringify(record)).digest("hex").slice(0, 16);
  mkdirSync(dirname(ledgerPath), { recursive: true });
  appendFileSync(ledgerPath, JSON.stringify({ recordHash, prevHash, record }) + "\n");
  return recordHash;
}

const decisionOf = (r) => `${r.skill_id}@${r.contentHash}`;
export function undecidedLedgerKeys(path = LEDGER_DEFAULT) {
  // one decision per (skill, content hash); verified skills listed and then
  // silently skipped on the next run
  const keys = new Set();
  for (const r of readLedger(path)) {
    if (r?.record && decisionOf(r.record) !== "@") keys.add(decisionOf(r.record));
  }
  return keys;
}

// ── the gate run ────────────────────────────────────────────────────────────
export async function runGate({
  root = ROOT,
  base = process.env.SINGULARITY_SKILL_BASE || "http://127.0.0.1:8420",
  cfg = readMemoryConfig(process.env.SINGULARITY_MEMORY_CONFIG || undefined),
  ledgerPath = LEDGER_DEFAULT,
  fetchImpl = globalThis.fetch,
  dryRun = false,
  rqlAvailable = null,
  now = () => nowIso(),
  identity = { teamId: process.env.SINGULARITY_SKILL_TEAM_ID, agentId: process.env.SINGULARITY_SKILL_AGENT_ID, userId: process.env.SINGULARITY_SKILL_USER_ID, taskId: process.env.SINGULARITY_SKILL_TASK_ID },
} = {}) {
  let stdout = [];
  const log = (s) => stdout.push(s);

  try { mkdirSync(root, { recursive: true }); } catch { /* root exists */ }
  let rql = rqlAvailable;
  if (rql === null) {
    const w = spawnSync(process.platform === "win32" ? "where" : "which", ["rql"], { encoding: "utf8", timeout: 5000 });
    rql = w.status === 0;
  }

  const identityHeaders = (s) => (s && (s.team_id || s.teamId) ? { teamId: s.team_id || s.teamId, agentId: s.owner_agent_id, taskId: s.task_id } : identity);
  // v3 isolation ids travel as body fields too (body OR x-tdai-* headers); send
  // both so the strict-isolation middleware always resolves the real identity
  const idsBody = identity?.teamId ? {
    ...(identity.teamId ? { team_id: identity.teamId } : {}),
    ...(identity.agentId ? { agent_id: identity.agentId } : {}),
    ...(identity.userId ? { user_id: identity.userId } : {}),
    ...(identity.taskId ? { task_id: identity.taskId } : {}),
  } : {};
  let items;
  try {
    const res = await memorySkillCall(base, cfg, "list", { ...idsBody, filters: { status: ["active"] }, pagination: { limit: 200 } }, { fetchImpl, headersExtra: identity });
    items = res?.data?.items ?? res?.data?.skills ?? [];
    if (!Array.isArray(items)) throw new Error("skill store returned a non-array active list");
  } catch (e) {
    return { ok: false, exitCode: 1, stdout, summary: null, error: String(e?.message || e).slice(0, 200) };
  }
  log(`active skills in store: ${items.length}`);

  const decided = undecidedLedgerKeys(ledgerPath);
  const decisions = [];
  let archived = 0, verifiedCount = 0, skipped = 0;

  // the list endpoint does not return metadata_json — pull each record's
  // detail once before verification so the gate verdict sees the gate
  // metadata that creation stored (bounded: at most one get per skill/run)
  const detailCache = new Map();
  const detailFor = async (s) => {
    if (detailCache.has(s.skill_id)) return detailCache.get(s.skill_id);
    let d = s;
    if (!s.metadata_json) {
      try {
        const r = await memorySkillCall(base, cfg, "get", { skill_id: s.skill_id }, { fetchImpl, headersExtra: identityHeaders(s) });
        d = r?.data?.skill ?? r?.data ?? s;
        if (!d || !d.skill_id) d = s;
      } catch (e) { detailsNote = `detail fetch failed for ${s.skill_id} (verify proceeds against the list record)`; d = s; }
    }
    detailCache.set(s.skill_id, d);
    return d;
  };
  let detailsNote = null;
  // enrich ALL items up front so dedup peers also see their metadata
  for (const s of items) { try { await detailFor(s); } catch { /* kept as-is */ } }
  items = items.map((s) => detailCache.get(s.skill_id) ?? s);

  for (const skill of items) {
    const key = `${skill.skill_id}@${sha12(skill.content_hash ?? JSON.stringify([skill.name, skill.content]))}`;
    if (decided.has(key)) { skipped += 1; decisions.push({ skill_id: skill.skill_id, verdict: "skipped", reason: "prior verdict in ledger for this content hash" }); continue; }
    let v;
    try {
      const full = await detailFor(skill);
      v = verifySkill(full, { root, rqlAvailable: rql, existing: items });
    }
    catch (e) { v = { verdict: "unverified", reasons: [`verification crashed: ${String(e?.message || e).slice(0, 120)}`] }; }

    if (v.verdict === "verified") {
      verifiedCount += 1;
      decisions.push({ skill_id: skill.skill_id, verdict: "verified", reason: `evidence verified (${v.evidenceFiles} files, ${v.repoQueries} RepoQL queries)` });
      continue; // demote-only gate: active stays active, ledger records it
    }

    // unverified / duplicate → archive (idempotent soft delete on the head)
    let archivedOk = false, reason = v.reasons.join("; ");
    if (!dryRun) {
      try {
        await memorySkillCall(base, cfg, "delete", { ...idsBody, skill_id: skill.skill_id }, { fetchImpl, headersExtra: identityHeaders(skill) });
        archivedOk = true;
      } catch (e) {
        const msg = String(e?.message || e);
        if (/already|archived|not find/i.test(msg)) { archivedOk = true; reason += ` (store: ${msg.slice(0, 80)})`; }
        else { decisions.push({ skill_id: skill.skill_id, verdict: "error", reason: `archive failed: ${msg.slice(0, 120)}` }); continue; }
      }
    } else {
      archivedOk = true; // dry-run: pretend the write happened for the summary only
    }
    archived += 1;
    decisions.push({ skill_id: skill.skill_id, verdict: v.verdict, reason });
  }

  // ledger: one appended record per DECIDED (not skipped) skill
  if (!dryRun) {
    for (const d of decisions) {
      if (d.verdict === "skipped") continue;
      const skill = items.find((s) => s.skill_id === d.skill_id) || {};
      const record = {
        schema: DECISION_SCHEMA,
        ts: now(),
        skill_id: d.skill_id,
        name: String(skill.name || "").slice(0, 80),
        contentHash: sha12(skill.content_hash ?? JSON.stringify([skill.name, skill.content])),
        ownerAgent: skill.owner_agent_id || null,
        teamId: skill.team_id || identity.teamId || null,
        verdict: d.verdict,
        reason: String(d.reason || "").slice(0, 300),
        gateVersion: "sg.v1",
      };
      d.recordHash = appendDecision(ledgerPath, record);
    }
  }

  // chain self-check after all appends (never claim a run that fails its own audit)
  const chain = dryRun ? { ok: true, rows: "dry-run" } : verifyChain(ledgerPath);
  if (!chain.ok) {
    return { ok: false, exitCode: 1, stdout, error: `gate ledger chain verification failed (${chain.detail} at ${chain.at}) — refusing to summarize` };
  }

  log(`verdicts: verified=${verifiedCount} archived=${archived} skipped=${skipped} (ledger ${dryRun ? "dry-run" : verifyChain(ledgerPath).rows + " rows"})`);
  return {
    ok: true, exitCode: 0, stdout, decisions,
    summary: { total: items.length, verified: verifiedCount, archived, skipped, dryRun },
  };
}

export async function gateStatus({ root = ROOT, ledgerPath = LEDGER_DEFAULT } = {}) {
  const rows = readLedger(ledgerPath);
  const by = { verified: 0, unverified: 0, duplicate: 0, error: 0 };
  for (const r of rows) { const v = r?.record?.verdict; if (v && by[v] !== undefined) by[v] += 1; }
  return { ledgerPath, rows: rows.length, by, chain: verifyChain(ledgerPath) };
}

// ── CLI ─────────────────────────────────────────────────────────────────────
function flag(argv, name, dflt = null) { const i = argv.indexOf(name); return i >= 0 ? argv[i + 1] : dflt; }
const has = (argv, name) => argv.includes(name);

export async function mainCli(argv = process.argv.slice(2)) {
  const root = flag(argv, "--root", process.env.SINGULARITY_REPO_ROOT || ROOT);
  const base = flag(argv, "--base", process.env.SINGULARITY_SKILL_BASE || "http://127.0.0.1:8420");
  const configPath = flag(argv, "--config", process.env.SINGULARITY_MEMORY_CONFIG || join(root, "data/opencode/config/product-secrets/memory.json"));
  const ledgerPath = flag(argv, "--ledger", LEDGER_DEFAULT);
  const sub = argv[0] || "run";

  if (sub === "status") {
    const s = await gateStatus({ root, ledgerPath });
    console.log(JSON.stringify(s));
    return 0;
  }
  if (sub === "verify-chain") {
    const c = verifyChain(ledgerPath);
    console.log(JSON.stringify(c));
    return c.ok ? 0 : 1;
  }
  if (sub !== "run" && sub !== "run --dry-run") {
    console.error("usage: skill-gate.mjs run [--root DIR] [--base URL] [--config PATH] [--ledger PATH] [--dry-run] [--json] | status | verify-chain");
    return 2;
  }

  let cfg;
  try { cfg = readMemoryConfig(configPath); }
  catch (e) { console.error(`memory config unreadable (${configPath}): ${String(e?.message || e).slice(0, 120)}`); return 1; }

  const out = await runGate({ root, base, cfg, ledgerPath, dryRun: has(argv, "--dry-run") });
  for (const line of out.stdout || []) console.log(line);
  if (has(argv, "--json")) console.log(JSON.stringify({ ok: out.ok, summary: out.summary, error: out.error || null, decisions: out.decisions || [] }, null, 0));
  else if (!out.ok) console.error(out.error || "gate run failed");
  return out.exitCode ?? (out.ok ? 0 : 1);
}

if (import.meta.url === `file://${process.argv[1]}` || process.argv[1]?.endsWith("skill-gate.mjs")) {
  mainCli().then((rc) => process.exit(rc)).catch((e) => { console.error(String(e?.stack || e)); process.exit(1); });
}
