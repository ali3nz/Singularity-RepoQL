#!/usr/bin/env node
// ticket 658 — MemoryCore capture-only consumer.
// Sol gate-2 verdict 2026-10-14: ACCEPTED WITH CONDITIONS; capture-only implementation APPROVED,
// production enablement HELD pending consumer-level acceptance evidence.
//
// Properties required by that verdict:
//   * out-of-process and read-only at the source (SQLite opened readOnly:true)
//   * single logical worker, no new service/database/queue/distributed coordination
//   * disabled by default (CAPTURE_ENABLED must be "1")
//   * stable source-derived task_id, reused across retries (reconciliation key, NOT an idempotency key)
//   * reconcile against existing destination rows BEFORE writing; reconcile ambiguous outcomes after failure
//   * multiset reconciliation, because content hashes alone cannot tell a legitimate repeated message from
//     a duplicate (Sol, explicit)
//   * verify the write actually landed (read-after-write) before advancing anything
//   * atomic ledger persistence; cursor advances only after verification succeeds
//   * isolation mapped to session_v2.agent, fail-closed when it is null/empty
//
// Node 22 built-ins only: node:sqlite, fetch, node:fs. No dependencies.

import { DatabaseSync } from 'node:sqlite';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

// F4a (Sol turn 4): declared before the configuration so the character budget can be required to EXCEED
// the marker, and so the marker is counted inside that budget.
const TRUNC_MARK = '\n[...truncated]';
// F4b: per-unit truncation count, produced by the transform itself. Inferring truncation from a content
// suffix would misclassify naturally occurring source text that ends with the marker string.
let truncatedInUnit = 0;

const cfg = {
  enabled: (process.env.CAPTURE_ENABLED ?? '0') === '1',
  srcDb: process.env.SRC_DB || '',
  destUrl: process.env.DEST_URL || 'http://tencent-memorycore:8420',
  teamId: process.env.TEAM_ID || 'fleet',
  userId: process.env.USER_ID || 'operator',
  apiKey: process.env.TDAI_GATEWAY_API_KEY || '',
  serviceId: process.env.TDAI_SERVICE_ID || 'default',
  ledgerPath: process.env.LEDGER_PATH || '/ledger/capture-ledger.json',
  stabilitySeconds: Number(process.env.STABILITY_SECONDS || 900),
  maxUnits: Number(process.env.MAX_UNITS || 50),
  fault: process.env.CONSUMER_FAULT || '',
  // F2 (Sol-authorized): the destination limit is 8192 CHARACTERS, measured from its own
  // validation error -- "messages.0.content: Too big: expected string to have <=8192 characters".
  // Content over the limit is REJECTED, never trimmed, so the client must cut it before sending.
  maxContent: Number(process.env.CONSUMER_MAX_CHARS || 8192),
  // F1 (Sol-authorized): the destination rejects any add carrying more than 100 messages --
  // "messages: Too big: expected array to have <=100 items".
  maxMessagesPerAdd: Number(process.env.CONSUMER_MAX_PER_ADD || 100),
  // F3 (Sol NEXT ACTION 1): CONSUMER_MAX_BYTES is REJECTED outright below -- see the configuration
  // validation block. The byte budget was superseded by the measured 8192-character limit.
  faultAfterChunk: Number(process.env.CONSUMER_FAULT_AFTER_CHUNK || 1), // testability: fail between batches
  delayMs: Number(process.env.CONSUMER_DELAY_MS || 0), // testability: widen the write window
  delayBeforeFinalityMs: Number(process.env.CONSUMER_DELAY_BEFORE_FINALITY_MS || 0), // testability: race window
  dryRun: (process.env.CAPTURE_DRY_RUN ?? '0') === '1', // inspect only: never writes, never advances
  onlySession: process.env.CAPTURE_ONLY_SESSION || '', // bound a production run to ONE session
  // ticket 732: registry snapshot mapping capture agent NAMES to the registered ids the Hub renders.
  // Without it the consumer used to write team=fleet/user=operator/agent=<name>, rows no Hub block
  // can ever read. Generation and freshness rules: documentation/services/tencent-memorycore.md.
  identityMapPath: process.env.AGENT_IDENTITY_MAP || '/config/agent-identity.json',
  // ticket 793: optional logical-Task binding file (default OFF: absent file == no behaviour change).
  taskBindingsPath: process.env.CAPTURE_TASK_BINDINGS || '/config/capture-task-bindings.json',
  // ---- rollout guards (Sol rollout verdict 2026-10-15T03-20-39-678-103035, conditions 2 and 3) ----
  allowAgents: (process.env.CAPTURE_ALLOW_AGENTS ?? '').split(',').map((s) => s.trim()).filter(Boolean),
  dailyMaxUnits: Number(process.env.CAPTURE_DAILY_MAX_UNITS || 500),
  dailyMaxMessages: Number(process.env.CAPTURE_DAILY_MAX_MESSAGES || 20000),
  maxFailures: Number(process.env.CONSUMER_MAX_FAILURES || 5),
};

// Code-level Companion refusal. Sol (rollout verdict, explicit): enforce BOTH the allowlist AND a
// code-level refusal for the canonical companion identity, so an incorrectly configured allowlist can
// never cause the Letta Companion to be captured or queried. Checked by CANONICAL agent identity only --
// persona names such as "Ghost Protocol" are deliberately NOT recognised here.
// Load-bearing (material finding 2026-10-15): `session_v2.agent` holds live `companion` sessions.
// 2026-10-19 (operator directive; ticket 734) -- supersedes the Sol rollout condition (2026-10-15):
// the `companion` refusal is LIFTED. The companion has migrated to MemoryCore (Letta retired;
// `ghost`/`companion` resolve to a registered agent id), so companion sessions are admitted like any
// allowlisted agent. The (now empty) set is kept so a future condition can re-introduce refusals;
// the allowlist and per-message provenance checks still gate every capture.
const FORBIDDEN_AGENTS = new Set([]);
const ALLOW_AGENTS = new Set(cfg.allowAgents);

// Redaction before write (Sol rollout condition 2). Applied to source content on the way in, AND to
// destination content during reconciliation, so a value already stored unredacted still matches its
// redacted expected form (no duplicate writes on the migration boundary).
let redactionsTotal = 0;
let delegatedUserMessagesExcluded = 0;
const REDACT_PATTERNS = [
  [/-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/g, '[REDACTED-KEY]'],
  [/\bBearer\s+[A-Za-z0-9._~+/=-]{12,}/gi, 'Bearer [REDACTED]'],
  [/\b(?:sk-[A-Za-z0-9_-]{12,}|gh[pors]_[A-Za-z0-9]{20,}|xox[baprs]-[A-Za-z0-9-]{10,}|(?:AKIA|ASIA)[A-Z0-9]{16})\b/g, '[REDACTED]'],
  [/\b(?:password|passwd|pwd|api[_-]?key|apikey|secret|token|access[_-]?key|private[_-]?key|client[_-]?secret|connection[_-]?string)\b\s*[:=]\s*["']?[^\s"'\n]{6,}/gi, '[REDACTED]'],
  [/[a-z][a-z0-9+.-]*:\/\/[^\s/:@]+:[^\s/:@]+@/gi, (m) => m.replace(/:[^\s/:@]+@$/, ':[REDACTED]@')],
];
function redact(text, count = false) {
  let out = String(text ?? '');
  for (const [re, rep] of REDACT_PATTERNS) {
    const m = out.match(re);
    if (!m) continue;
    if (count) redactionsTotal += m.length;
    out = out.replace(re, rep);
  }
  return out;
}

const emit = (ev, extra = {}) => console.log(JSON.stringify({ at: new Date().toISOString(), ev, ...extra }));
const die = (code, msg, extra = {}) => {
  console.error(JSON.stringify({ at: new Date().toISOString(), ev: 'fatal', code, msg, ...extra }));
  process.exit(code);
};

// ------------------------------------------------ ticket 793: logical Task binding (OFF by default)
// A recurring routine (Ghost's nightly audit) runs as MANY separate source sessions, so each execution used to
// capture under its own unit key `oc:<session>:<first>-<last>`; a meta Task id could therefore never match a
// captured row. An OPTIONAL binding renames only the DESTINATION task_id of new units for bound sessions.
// Reconciliation stays session-scoped and the ledger keeps the unit key and seq range, so idempotency,
// provenance and permissions are unchanged. No bindings file => no behaviour change.
// Keys: "<agent>:<session title>" (preferred) or "<session title>". Values: meta Task ids (task-...).
const TASK_BINDINGS = (() => {
  const map = new Map();
  let raw;
  try { raw = fs.readFileSync(cfg.taskBindingsPath, 'utf8'); }
  catch (e) {
    if (e && e.code !== 'ENOENT') emit('task-binding-unreadable', { path: cfg.taskBindingsPath, error: String(e.message || e).slice(0, 200) });
    return map;
  }
  let parsed;
  try { parsed = JSON.parse(raw); }
  catch { emit('task-binding-ignored', { path: cfg.taskBindingsPath, reason: 'invalid json' }); return map; }
  for (const [k, v] of Object.entries(parsed?.bindings ?? {})) {
    if (typeof v !== 'string' || !/^task-[a-z0-9]{6,40}$/.test(v)) { emit('task-binding-ignored', { key: k, reason: 'invalid task id' }); continue; }
    map.set(k, v);
  }
  return map;
})();
const boundTaskId = (s) => TASK_BINDINGS.get(`${s.agent}:${s.title}`) || TASK_BINDINGS.get(String(s.title || '')) || '';
if (TASK_BINDINGS.size > 0) emit('task-bindings-loaded', { count: TASK_BINDINGS.size });

if (!cfg.enabled) { emit('disabled', { note: 'CAPTURE_ENABLED!=1 — nothing read, nothing written' }); process.exit(0); }
if (!cfg.srcDb || !cfg.apiKey) die(2, 'SRC_DB and TDAI_GATEWAY_API_KEY are required');
// Rollout guard (Sol condition 2): an ENABLED run must declare its scope. An empty/absent allowlist is a
// misconfiguration and fails LOUDLY rather than silently capturing nothing.
if (ALLOW_AGENTS.size === 0) die(2, 'CAPTURE_ALLOW_AGENTS is required when CAPTURE_ENABLED=1 (fail closed)');
// Identity contract (ticket 732). Every destination call must carry the REGISTERED team/user/agent ids:
// the Hub resolves a block from asset id chat_memory-<team>-<agent>, so a label-scoped write is stored but
// unreadable. The map is a registry snapshot; an unreadable or empty map is a fatal misconfiguration, and
// an agent missing from the map is skipped per unit (fail closed) rather than written under labels.
function loadIdentityMap(p) {
  let raw;
  try { raw = fs.readFileSync(p, 'utf8'); } catch (e) { die(3, 'AGENT_IDENTITY_MAP is unreadable', { path: p, error: String((e && e.message) || e) }); }
  let parsed;
  try { parsed = JSON.parse(raw); } catch (e) { die(3, 'AGENT_IDENTITY_MAP is not valid JSON', { path: p, error: String((e && e.message) || e) }); }
  const agents = parsed && parsed.agents;
  if (!agents || typeof agents !== 'object' || Object.keys(agents).length === 0) die(3, 'AGENT_IDENTITY_MAP declares no agents', { path: p });
  let bad = 0;
  for (const [name, v] of Object.entries(agents)) {
    if (!v || !v.agent_id || !v.team_id || !v.user_id) { bad++; console.error(JSON.stringify({ at: new Date().toISOString(), ev: 'identity-map-entry-invalid', agent: name })); }
  }
  if (bad > 0) die(3, 'AGENT_IDENTITY_MAP has entries missing agent_id/team_id/user_id', { path: p, invalid: bad });
  return parsed;
}
const IDENTITY = loadIdentityMap(cfg.identityMapPath);
const identityFor = (name) => (IDENTITY.agents && IDENTITY.agents[name]) || null;
// Rollout guard (Sol condition 3): the volume caps must be finite and positive.
if (!Number.isFinite(cfg.dailyMaxUnits) || cfg.dailyMaxUnits <= 0) die(2, 'CAPTURE_DAILY_MAX_UNITS must be a positive number');
if (!Number.isFinite(cfg.dailyMaxMessages) || cfg.dailyMaxMessages <= 0) die(2, 'CAPTURE_DAILY_MAX_MESSAGES must be a positive number');

// ---------------------------------------------------------------- configuration validation (F3)
// Sol NEXT ACTION 1 (consult 2026-10-14T08-32-14-995-66010 turn 3). The verified destination limits are
// 100 messages per add and 8192 CHARACTERS per message; a configuration exceeding either re-creates the
// rejections F1/F2 exist to prevent, and CONSUMER_MAX_BYTES belongs to the superseded byte budget. Both
// must fail LOUDLY rather than be silently accepted.
if (process.env.CONSUMER_MAX_BYTES) {
  die(2, 'CONSUMER_MAX_BYTES is rejected: the byte budget was superseded by the measured 8192-character limit',
      { value: process.env.CONSUMER_MAX_BYTES });
}
function boundedEnv(name, def, max, min = 1) {
  const raw = process.env[name];
  if (raw === undefined || raw === '') return def;
  if (!/^[0-9]+$/.test(String(raw).trim())) die(2, name + ' must be a positive integer', { value: raw, max, min });
  const n = Number(String(raw).trim());
  if (n < min || n > max) die(2, name + ' out of range ' + min + '..' + max, { value: raw, max, min });
  return n;
}
cfg.maxMessagesPerAdd = boundedEnv('CONSUMER_MAX_PER_ADD', 100, 100);
// F4a: the budget must exceed the marker, otherwise a truncated value could not carry the marker and
// stay inside the budget (a 1-character budget previously produced a 15-character result).
cfg.maxContent = boundedEnv('CONSUMER_MAX_CHARS', 8192, 8192, TRUNC_MARK.length + 1);

// ---------------------------------------------------------------- single-worker ownership
// Single-writer lock. Sol (2026-10-15T04-44-50) correctly flagged that a PID-liveness probe is UNSOUND
// across container PID namespaces: each `docker run` gets a fresh namespace in which PID 1 always exists,
// so a lock left by a crashed run would look permanently "live" and block capture forever. Staleness is
// therefore judged by AGE, bounded by the service TimeoutStartSec (1800 s) with margin.
const lockPath = cfg.ledgerPath + '.lock';
const LOCK_STALE_MS = Number(process.env.CONSUMER_LOCK_STALE_MS || 2100000); // 35 min
fs.mkdirSync(path.dirname(cfg.ledgerPath), { recursive: true });
const lockBody = JSON.stringify({ pid: process.pid, at: new Date().toISOString(), host: os.hostname() });
try {
  fs.writeFileSync(lockPath, lockBody, { flag: 'wx' });
} catch (e) {
  if (e.code !== 'EEXIST') die(2, 'lock error', { error: String(e) });
  let prev = null;
  try { prev = JSON.parse(fs.readFileSync(lockPath, 'utf8')); } catch { prev = null; }
  const ageMs = prev && prev.at ? Date.now() - Date.parse(prev.at) : Infinity;
  if (Number.isFinite(ageMs) && ageMs < LOCK_STALE_MS) die(3, 'another consumer holds the lock (fresh)', { lock: prev, ageMs });
  fs.writeFileSync(lockPath, lockBody); // stale lock, take it
}
process.on('exit', () => { try { fs.unlinkSync(lockPath); } catch {} });

// ---------------------------------------------------------------- ledger (atomic)
let ledger = { version: 1, units: {}, cursor: {} };
try { ledger = JSON.parse(fs.readFileSync(cfg.ledgerPath, 'utf8')); } catch {}
ledger.units ??= {};
ledger.cursor ??= {};
ledger.daily ??= {}; // per-UTC-day volume accounting for the rollout caps
function saveLedger() {
  if (cfg.dryRun) return; // dry run mutates nothing
  const tmp = cfg.ledgerPath + '.tmp';
  const fd = fs.openSync(tmp, 'w');
  fs.writeSync(fd, JSON.stringify(ledger, null, 1));
  fs.fsyncSync(fd);
  fs.closeSync(fd);
  fs.renameSync(tmp, cfg.ledgerPath);
}

// ---------------------------------------------------------------- destination
async function dest(pathname, body) {
  let r;
  try {
    r = await fetch(cfg.destUrl + pathname, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        authorization: 'Bearer ' + cfg.apiKey,
        'x-tdai-service-id': cfg.serviceId,
      },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(20000),
    });
  } catch (e) {
    // Rollout guard (Sol condition 3, failure isolation): an unreachable or erroring destination is a
    // FAILURE, never a crash. Returning status 0 lets the caller count it and honour the failure cutoff.
    return { status: 0, json: null, text: '', error: String((e && e.message) || e) };
  }
  const text = await r.text();
  let json = null;
  try { json = JSON.parse(text); } catch {}
  return { status: r.status, json, text };
}
// ticket 732: scope from the resolved identity, never from cfg.teamId/cfg.userId. Kept as one helper so a
// capture path cannot reintroduce a label-scoped call by copy-paste.
const scoped = (ident, extra) => ({ team_id: ident.team_id, user_id: ident.user_id, agent_id: ident.agent_id, ...extra });

// Reconciliation is scoped by team + agent + SESSION (+ the unit's own task_id when filtering).
// task_id must never become a global identity across unrelated capture contexts (Sol, explicit).
async function queryRows(sessionId, ident) {
  const rows = [];
  for (let offset = 0; offset < 2000; offset += 100) {
    const res = await dest('/v3/conversation/query',
      { ...scoped(ident), session_id: sessionId, limit: 100, offset });
    const msgs = res.json?.data?.messages;
    if (res.status !== 200 || !Array.isArray(msgs)) return { ok: false, status: res.status, rows };
    rows.push(...msgs);
    if (msgs.length < 100) break;
  }
  return { ok: true, status: 200, rows };
}

// ---------------------------------------------------------------- source (read-only)
const db = new DatabaseSync(cfg.srcDb, { readOnly: true });

const msgKey = (role, content, stamp) => role + '\u0000' + content + '\u0000' + stamp;
const bump = (m, k) => m.set(k, (m.get(k) || 0) + 1);

function extract(row) {
  let d;
  try { d = JSON.parse(row.data); } catch { return null; }
  if (row.type === 'user') {
    return d.text ? { role: 'user', content: redact(d.text, true) } : null;
  }
  if (row.type === 'assistant') {
    const parts = Array.isArray(d.content) ? d.content : [];
    // text parts only: raw reasoning is deliberately NOT captured (no chain-of-thought egress)
    const text = parts.filter((p) => p && p.type === 'text' && typeof p.text === 'string')
      .map((p) => p.text).join('\n').trim();
    return text ? { role: 'assistant', content: redact(text, true) } : null;
  }
  return null; // idle/system/synthetic/switch/compaction events are not conversations
}

function expectedEntries(session, afterSeq, excludeChildUser = false) {
  const rows = db.prepare(
    `select id, type, seq, time_created, data from session_message
      where session_id = ? and type in ('user','assistant') and seq > ?
      order by seq asc`).all(session.id, afterSeq);
  const out = [];
  for (const r of rows) {
    if (excludeChildUser && r.type === 'user') {
      delegatedUserMessagesExcluded++;
      continue;
    }
    const e = extract(r);
    if (!e) continue;
    let content = e.content;
    content = trimToLimit(content);
    out.push({
      role: e.role,
      content,
      recorded_at: new Date(Number(r.time_created)).toISOString(),
      seq: Number(r.seq),
    });
  }
  return out;
}


// Character-limit truncation (F2, Sol-authorized 2026-10-14).
// The destination counts CHARACTERS (code points), stated in its own rejection message, and it REJECTS
// over-limit content rather than trimming it -- so the client must cut before sending. The former
// 7600-BYTE budget was a misdiagnosis: it discarded content the destination stores verbatim (a
// 24000-byte, 8000-character CJK message lost 5474 characters). The truncation marker is included
// INSIDE the character budget, so the stored value is always <= the destination limit.
function trimToLimit(text) {
  const cps = [...text];                      // code points, matching the destination's counter
  if (cps.length <= cfg.maxContent) return text;
  truncatedInUnit++;                          // F4b: counted here, never inferred from the suffix
  return cps.slice(0, cfg.maxContent - TRUNC_MARK.length).join('') + TRUNC_MARK;
}

// ---------------------------------------------------------------- range -> expected entries
function toEntries(rows, excludeChildUser = false) {
  const out = [];
  for (const r of rows) {
    if (excludeChildUser && r.type === 'user') {
      delegatedUserMessagesExcluded++;
      continue;
    }
    const e = extract(r);
    if (!e) continue;
    let content = e.content;
    content = trimToLimit(content);
    out.push({ role: e.role, content, recorded_at: new Date(Number(r.time_created)).toISOString(), seq: Number(r.seq) });
  }
  return out;
}
function expectedSeqRange(session, from, to, excludeChildUser = false) {
  return toEntries(db.prepare(
    `select id, type, seq, time_created, data from session_message
      where session_id = ? and type in ('user','assistant') and seq >= ? and seq <= ? order by seq asc`)
    .all(session.id, from, to), excludeChildUser);
}

// Message-level attribution (Sol rollout condition 2, REQUIRED VERIFICATION).
// A session's agent id is NOT sufficient: measured on the live source, 27 of 52 observed
// (session, message) agent pairs differ and 47 sessions are multi-agent. Assistant messages carry their
// OWN `agent`.
//
// Sol (provenance-gap correction, consult 2026-10-15T04-16-28): returning a distinct agent SET is NOT
// enough. A session with two ALLOWLISTED agents (e.g. code-reviewer + standalone) would pass the
// set-membership test and a session-labelled unit could misattribute one agent's material to the other.
// The rule is therefore STRICT: a unit is captured only when the session has EXACTLY ONE distinct
// assistant-message agent, that agent equals the session agent, and there is NO unattributed assistant
// message. Provenance is refused, never guessed.
function sessionProvenance(sessionId) {
  const rows = db.prepare(
    `select json_extract(data, '$.agent') as a from session_message
      where session_id = ? and type = 'assistant'`).all(sessionId);
  const agents = new Set();
  let unattributed = 0;
  for (const r of rows) { if (r.a) agents.add(r.a); else unattributed++; }
  return { agents, unattributed, total: rows.length };
}

// ---------------------------------------------------------------- reconcile ONE unit
// Multiplicity-aware: compares the expected multiset of (role, content, recorded_at) against the rows the
// destination currently holds for THIS task_id, and writes only what is missing. Verifies the write landed
// (read-after-write) before reporting success. Never trusts the ledger alone.
async function reconcileUnit(session, ident, taskId, expected) {
  const q1 = await queryRows(session.id, ident);
  if (!q1.ok) return { ok: false, reason: 'query-failed', status: q1.status, written: 0 };
  const observed = new Map();
  // redact destination content too, so a pre-guard row is compared in the same redacted space as its
  // expected form (prevents a spurious "missing" -> duplicate write on the migration boundary).
  for (const row of q1.rows) if (row.task_id === taskId) bump(observed, msgKey(row.role, redact(row.content), row.timestamp));

  const missing = [];
  for (const e of expected) {
    const k = msgKey(e.role, e.content, e.recorded_at);
    const have = observed.get(k) || 0;
    if (have > 0) { observed.set(k, have - 1); continue; }  // multiplicity matched
    missing.push({ role: e.role, content: e.content, recorded_at: e.recorded_at });
  }
  if (missing.length === 0) return { ok: true, reason: 'already-complete', missing, written: 0, acceptedIds: [] };

  if (cfg.delayMs > 0) await new Promise((r) => setTimeout(r, cfg.delayMs));
  // fault injection: the destination persists a PROPER SUBSET, then the call fails (Sol check 2)
  if (cfg.fault === 'partial_write' && missing.length >= 2) {
    const half = Math.max(1, Math.ceil(missing.length / 2));
    const part = await dest('/v3/conversation/add',
      { ...scoped(ident), session_id: session.id, task_id: taskId, messages: missing.slice(0, half) });
    emit('fault-partial-write', { taskId, committed: half, of: missing.length, status: part.status });
    return { ok: false, reason: 'injected-partial-write', status: part.status, missing, written: 0 };
  }
  if (cfg.dryRun) return { ok: true, reason: 'dry-run', missing, written: 0, acceptedIds: [] };
  // F1 (Sol-authorized): send in chunks of <= maxMessagesPerAdd. A single add carrying more than 100
  // messages is REJECTED with 400 and NOTHING is stored, which made any unit above 100 messages fail
  // entirely. On a mid-run failure the unit is reported unverified with `missing` unchanged, so a retry
  // reconciles against what actually landed (chunks already accepted are seen as present).
  const acceptedIds = [];
  let batchesDone = 0;
  for (let i = 0; i < missing.length; i += cfg.maxMessagesPerAdd) {
    const batch = missing.slice(i, i + cfg.maxMessagesPerAdd);
    const res = await dest('/v3/conversation/add',
      { ...scoped(ident), session_id: session.id, task_id: taskId, messages: batch });
    if (res.status !== 200 || res.json?.code !== 0) {
      return { ok: false, reason: 'write-unverified', status: res.status, body: res.text.slice(0, 200),
               missing, written: acceptedIds.length, acceptedIds, failedBatch: { index: i, size: batch.length } };
    }
    for (const id of (res.json?.data?.accepted_ids || [])) acceptedIds.push(id);
    batchesDone++;
    // Testability (Sol NEXT ACTION 2): simulate the destination failing on a LATER batch after earlier
    // batches were accepted. The destination does not guarantee idempotent writes, so what makes this
    // safe is reconciliation on the retry -- the unit reports unverified with `missing` UNCHANGED, and
    // the next run queries the destination and writes only what is genuinely absent.
    if (cfg.fault === 'fail_after_chunk' && batchesDone >= cfg.faultAfterChunk) {
      emit('fault-injected', { where: 'between-accepted-batches', acceptedBatches: batchesDone,
                               acceptedIds: acceptedIds.length, remaining: missing.length - acceptedIds.length });
      return { ok: false, reason: 'injected-chunk-failure', status: 0,
               body: 'simulated failure between accepted batches', missing,
               written: acceptedIds.length, acceptedIds,
               failedBatch: { index: i + cfg.maxMessagesPerAdd, size: 0 } };
    }
  }

  // read-after-write
  const q2 = await queryRows(session.id, ident);
  const after = new Map();
  for (const row of q2.rows) if (row.task_id === taskId) bump(after, msgKey(row.role, redact(row.content), row.timestamp));
  let complete = q2.ok;
  for (const e of expected) {
    const k = msgKey(e.role, e.content, e.recorded_at);
    const have = after.get(k) || 0;
    if (have <= 0) { complete = false; break; }
    after.set(k, have - 1);
  }
  return { ok: complete, reason: complete ? 'reconciled' : 'read-after-write-unconfirmed', missing, written: missing.length, acceptedIds };
}

// ---------------------------------------------------------------- main
const dayKey = new Date().toISOString().slice(0, 10);
const day = (ledger.daily[dayKey] ??= { units: 0, messages: 0 });
const now = Date.now();
const stableBefore = now - cfg.stabilitySeconds * 1000;
// Bounded eligibility by OUTCOME. The approved gate-2 design (capture-only-design.md §1.2, Sol open item
// 7.1) admits ONLY idle_outcome = 'succeeded' in the first increment: "failed and interrupted are
// recorded as ineligible-and-why, NOT captured". The earlier predicate filtered only
// `idle_outcome is not null`, so failed/interrupted sessions WERE eligible. Found 2026-10-15 by the Phase-2
// derivation ladder (interrupted sessions present in the eligible set), and 12 of the 40 already-captured
// sessions (7 failed + 5 interrupted) are non-succeeded now. Restored to the approved design; the excluded
// set is counted and emitted below, so the refusal is recorded rather than silent.
const BASE_SELECT = `select id, parent_id, agent, title, time_idle, idle_outcome, resume_attempts from session_v2
    where idle_outcome = 'succeeded' and time_idle is not null and time_idle <= ?`;
const sessions = cfg.onlySession
  ? db.prepare(BASE_SELECT + ' and id = ? order by time_idle asc').all(stableBefore, cfg.onlySession)
  : db.prepare(BASE_SELECT + ' order by time_idle asc').all(stableBefore);

// Design §1.2: failed/interrupted are "recorded as ineligible-and-why". Count them so the refusal is visible.
const notSucceeded = db.prepare(
  `select count(*) c from session_v2 where idle_outcome is not null and idle_outcome <> 'succeeded'
     and time_idle is not null and time_idle <= ?`).get(stableBefore).c;
emit('discovered', { terminalStableSessions: sessions.length, skippedNotSucceeded: Number(notSucceeded), stabilitySeconds: cfg.stabilitySeconds, dryRun: cfg.dryRun, onlySession: cfg.onlySession || null });
if (cfg.delayBeforeFinalityMs > 0) {
  emit('delay-before-finality', { ms: cfg.delayBeforeFinalityMs });
  await new Promise((r) => setTimeout(r, cfg.delayBeforeFinalityMs));
}

const summary = { dryRun: cfg.dryRun, unitsProcessed: 0, rowsWritten: 0, rowsRepaired: 0, skippedNullAgent: 0, skippedNotFinal: 0, skippedNotSucceeded: Number(notSucceeded), skippedForbiddenAgent: 0, skippedNotAllowed: 0, skippedForbiddenSession: 0, skippedAmbiguousAgent: 0, skippedUnmappedAgent: 0, ambiguous: 0, alreadyComplete: 0, failures: 0, dailyCapReached: false, failureCutoff: false, allowAgents: cfg.allowAgents, identityMap: cfg.identityMapPath };

for (const s of sessions) {
  if (summary.unitsProcessed >= cfg.maxUnits) break;
  // Rollout guard (Sol condition 3): bounded failure cutoff, and a finite daily volume cap.
  if (summary.failures >= cfg.maxFailures) { summary.failureCutoff = true; emit('failure-cutoff', { failures: summary.failures }); break; }
  if (day.units >= cfg.dailyMaxUnits || day.messages >= cfg.dailyMaxMessages) {
    summary.dailyCapReached = true; emit('daily-cap-reached', { units: day.units, messages: day.messages }); break;
  }

  if (!s.agent) { summary.skippedNullAgent++; continue; }   // fail closed
  if (FORBIDDEN_AGENTS.has(s.agent)) { summary.skippedForbiddenAgent++; continue; } // code-level Companion refusal
  if (!ALLOW_AGENTS.has(s.agent)) { summary.skippedNotAllowed++; continue; }         // allowlist scope (fail closed)
  // ticket 732: no registered identity means no block in the Hub. Skip rather than write a label row.
  const ident = identityFor(s.agent);
  if (!ident) { summary.skippedUnmappedAgent++; emit('identity-unmapped', { session: s.id, agent: s.agent }); continue; }
  // REQUIRED VERIFICATION (Sol): a session-level allowlist is NOT sufficient. Re-check every message's
  // own agent; refuse the session on forbidden or AMBIGUOUS provenance (strict single-agent rule).
  {
    const prov = sessionProvenance(s.id);
    let forbidden = false, ambiguous = false;
    for (const a of prov.agents) { if (FORBIDDEN_AGENTS.has(a)) forbidden = true; else if (!ALLOW_AGENTS.has(a)) ambiguous = true; }
    if (prov.unattributed > 0) ambiguous = true;                               // unattributed assistant message -> never assume provenance
    if (prov.agents.size !== 1 || !prov.agents.has(s.agent)) ambiguous = true;  // strict single-agent provenance, matching the session
    if (forbidden) { summary.skippedForbiddenSession++; continue; }            // a Companion MESSAGE in any session -> refuse the session
    if (ambiguous) { summary.skippedAmbiguousAgent++; continue; }              // ambiguous provenance -> refuse
  }

  const late = db.prepare(
    'select count(*) c, max(time_created) m from session_message where session_id = ? and time_created > ?')
    .get(s.id, s.time_idle);
  if (Number(late.c) > 0) { summary.skippedNotFinal++; continue; } // bounded finality, not merely idle

  // I11 (ticket 799): in a child session EVERY user-role message is delegated/director task traffic, not
  // an operator standing preference -- the first brief AND later directives on a resumed subagent.
  // Exclude all of them; keep every child assistant result and every parent-session row. Deliberate
  // conservative tradeoff: an operator message typed directly inside a child session is not captured
  // (parent-session operator preferences remain captured). Existing captured rows are never deleted.
  const excludeChildUser = Boolean(s.parent_id);

  // PHASE 1 — repair the most recent captured unit for this session.
  // A cursor alone cannot repair a partial loss inside an already-captured range.
  const mine = Object.entries(ledger.units)
    .filter(([, u]) => u.session_id === s.id)
    .map(([tid, u]) => ({ tid, u }))
    .sort((a, b) => b.u.last_seq - a.u.last_seq);
  if (mine.length > 0) {
    const { tid, u } = mine[0];
    const rep = expectedSeqRange(s, u.first_seq, u.last_seq, excludeChildUser);
    if (cfg.dryRun) emit('dry-repair-check', { session: s.id, taskId: tid, expected: rep.length });
    // Sol (daily-cap boundary): bound the REPAIR write before committing, too.
    if (!cfg.dryRun && day.messages + rep.length > cfg.dailyMaxMessages) {
      summary.dailyCapReached = true; emit('daily-cap-message-bound', { phase: 'repair', session: s.id, remaining: cfg.dailyMaxMessages - day.messages, need: rep.length }); break;
    }
    // ticket 793: a bound unit's rows live under the bound Task id, not under the ledger key.
    const r1 = await reconcileUnit(s, ident, u.task_id || tid, rep);
    if (!r1.ok) { emit('repair-failed', { session: s.id, taskId: tid, reason: r1.reason }); summary.ambiguous++; summary.failures++; continue; }
    if (r1.written > 0) {
      summary.rowsRepaired += r1.written;
      ledger.units[tid].written += r1.written;
      ledger.units[tid].restored_at = new Date().toISOString();
      day.messages += r1.written;   // repaired rows count toward the daily volume, persisted with the ledger
      saveLedger();
      emit('unit-repaired', { session: s.id, taskId: tid, restored: r1.written });
    }
    if (cfg.fault === 'after_write_before_ledger' && r1.written > 0) { emit('fault-injected', { where: 'repair' }); process.exit(9); }
  }

  // PHASE 2 — forward: anything after the cursor is a new capture unit.
  const cursorSeq = Number(ledger.cursor[s.id] ?? -1);
  truncatedInUnit = 0;                        // F4b: count THIS unit's truncations only
  const expected = expectedEntries(s, cursorSeq, excludeChildUser);
  if (expected.length === 0) { summary.alreadyComplete++; continue; }
  // Sol (daily-cap boundary): bound the WRITE before committing, so one unit can never exceed the
  // remaining daily message allowance (checking only at the top of the loop is not sufficient).
  if (day.messages + expected.length > cfg.dailyMaxMessages) {
    summary.dailyCapReached = true; emit('daily-cap-message-bound', { phase: 'forward', session: s.id, remaining: cfg.dailyMaxMessages - day.messages, need: expected.length }); break;
  }

  const firstSeq = expected[0].seq;
  const lastSeq = expected[expected.length - 1].seq;
  const unitKey = `oc:${s.id}:${firstSeq}-${lastSeq}`; // stable source-derived unit identity
  // ticket 793: a bound session writes under its logical Task id; the unit key still names the ledger record.
  const boundTask = boundTaskId(s);
  const taskId = boundTask || unitKey;

  if (cfg.dryRun) {
    const roles = expected.reduce((m, e) => (m[e.role] = (m[e.role] || 0) + 1, m), {});
    emit('dry-unit', {
      session: s.id, unit: unitKey, taskId, agent: s.agent, agent_id: ident.agent_id, team_id: ident.team_id, outcome: s.idle_outcome, idle: s.time_idle,
      first_seq: firstSeq, last_seq: lastSeq, messages: expected.length, roles,
      ordered: expected.every((e, i) => i === 0 || e.seq > expected[i - 1].seq),
      sample: expected.slice(0, 3).map((e) => ({ role: e.role, at: e.recorded_at, len: e.content.length })),
    });
    summary.unitsProcessed++;
    continue;
  }

  const r2 = await reconcileUnit(s, ident, taskId, expected);
  if (!r2.ok) {
    emit('unit-incomplete', { session: s.id, unit: unitKey, taskId, reason: r2.reason, status: r2.status });
    summary.ambiguous++;
    summary.failures++;
    continue; // no cursor advance
  }

  if (cfg.fault === 'after_write_before_ledger') {
    emit('fault-injected', { where: 'after_write_before_ledger', session: s.id, taskId, written: r2.written });
    process.exit(9);
  }

  ledger.units[unitKey] = {
    session_id: s.id, agent: s.agent, first_seq: firstSeq, last_seq: lastSeq,
    // ticket 793: the destination task_id used for these rows, and why. The ledger key stays the unit key so
    // per-unit lineage (and repair ranges) survive across executions of a bound routine.
    task_id: taskId, task_id_source: boundTask ? 'binding' : 'unit',
    expected: expected.length, written: r2.written, accepted_ids: r2.acceptedIds,
    // Sol's marker ruling: keep truncation status in the existing unit record (no new metadata system)
    truncated: truncatedInUnit,               // F4b: authoritative count from the transform
    // Capture-time provenance. The design REQUIRES this (capture-only-design.md §1.2 item 4: "Provenance
    // recorded with every unit: idle_outcome, resume_attempts, time_suspended, time_archived, time_idle,
    // and the seq range") and the earlier record omitted it -- so after the fact there was no way to tell
    // whether a unit had been captured while failed/interrupted or had become so later (idle_outcome is
    // mutable, design §1.1). Recorded now so future audits can distinguish the two cases.
    outcome: s.idle_outcome, resume_attempts: s.resume_attempts ?? null, time_idle: s.time_idle ?? null,
    status: 'reconciled', at: new Date().toISOString(),
  };
  ledger.cursor[s.id] = lastSeq;
  // Rollout cap accounting MUST be persisted in the same atomic write as the cursor, otherwise the
  // daily counter is lost on restart (caught by the guard suite's restart test).
  day.units++;
  day.messages += r2.written;
  saveLedger();
  summary.unitsProcessed++;
  summary.rowsWritten += r2.written;
  emit('unit-reconciled', { session: s.id, unit: unitKey, taskId, expected: expected.length, written: r2.written, verified: true });
}

summary.redactions = redactionsTotal;
summary.delegatedUserMessagesExcluded = delegatedUserMessagesExcluded;
emit('done', summary);
process.exit(0);
