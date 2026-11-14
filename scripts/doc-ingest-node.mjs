#!/usr/bin/env node
// doc-ingest-node.mjs — automatic MemoryCore documentation ingestion, in Node.
//
// This is the SAME engine and the SAME ledger the Python helper
// (scripts/memory-doc-ingest.py) maintains, reimplemented without a Python
// runtime so the Claude Code hooks work on native Windows (where `python3` is a
// Microsoft Store stub) and in any Node-only install. The filesystem document
// stays the source of truth; a retrieval failure never overwrites it, and a
// failed ingestion never deactivates a previously verified revision.
//
//   DOC_INGEST_INDEXED    ingested, all chunks persisted AND verified searchable
//   DOC_INGEST_UNCHANGED  source hash equals the verified active revision — no write
//   DOC_INGEST_PENDING    persisted but not yet verified searchable (retryable)
//   DOC_INGEST_FAILED     write/verification failed; previous revision stays active
//   DOC_INGEST_BLOCKED    eligibility/security/size refusal; nothing partial is claimed
//
// Commands (identical JSON surface to the Python CLI):
//   ingest --file DOC [--root ROOT] [--session S]
//   retry  [--file DOC | --all] [--root ROOT]
//   status [--file DOC] [--all] [--root ROOT]
//   verify --file DOC [--root ROOT]
//   search QUERY [--limit N] [--stale] [--root ROOT]
//
// Environment (read at call time, never at import time):
//   MEMORY_SECRETS              memory.json path
//   KNOWLEDGE_INDEX_BASE_URL    memory gateway base (default http://127.0.0.1:8420)
//   SINGULARITY_DOC_DATA        state dir (default ./data)
//   SINGULARITY_DOC_ROOTS       extra allowlist roots, OS path-delimiter separated (; on Windows)
//   DOC_INDEX_TEAM/DOC_INDEX_USER   shared documentation scope
//
// Both Python and Node use the SAME owner-tagged atomic lock directory.
// Never automatically reap it by age: a remote memory request may outlive the
// stale threshold, and deleting a live lock can lose ledger records. A crash
// requires operator recovery after verifying both engines are stopped.
import { createHash, randomUUID } from "node:crypto";
import {
  closeSync,
  existsSync,
  fsyncSync,
  mkdirSync,
  openSync,
  readFileSync,
  realpathSync,
  renameSync,
  rmdirSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { delimiter, dirname, extname, isAbsolute, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { isDeepStrictEqual } from "node:util";
import { commitNativeDocLedger, nativeDocIndexPolicyEnabled, requestNativeDocIndexPolicy, writeNativeDocChunk } from "./document-learning-rust.mjs";

export class Blocked extends Error {}

const DEFAULT_DOC_DATA = "./data";
const DEFAULT_MEMORY_SECRETS = "./data/opencode/config/product-secrets/memory.json";
const DEFAULT_BASE_URL = "http://127.0.0.1:8420";
const DOCS_SESSION = "singularity-documentation";
const MAX_DOC_BYTES = 200 * 1024;
const MAX_CHUNK_CHARS = 7000;
const MAX_CHUNKS = 64;
const VERIFY_TIMEOUT_MS = 30_000;
const VERIFY_POLL_MS = 3_000;
const SEARCH_LIMIT_DEFAULT = 5;
const MEMORY_TIMEOUT_MS = 10_000;
const LOCK_TIMEOUT_MS = 10_000;

// Secret-shaped content is rejected, never redacted silently into the store.
const SECRET_PATTERNS = [
  /\bsk-[A-Za-z0-9][A-Za-z0-9_-]{8,}\b/,
  /\b(?:ghp|gho|github_pat)_[A-Za-z0-9_]{16,}\b/,
  /\bAKIA[A-Z0-9]{12,}\b/,
  /-----BEGIN [A-Z ]*PRIVATE KEY-----/,
];
const SECRET_FILENAMES = /(^|\/)(\.env[^/]*|id_rsa[^/]*|secrets?[^/]*|credentials*\.md|.*\.pem|.*\.key[^/]*|.*password.*|.*\.secrets\..*)$/i;

// ── small helpers ────────────────────────────────────────────────────────────

function ctxOf(opts = {}) {
  return {
    env: opts.env || process.env,
    fetchImpl: opts.fetchImpl || globalThis.fetch,
    sleep: opts.sleep || ((ms) => new Promise((done) => setTimeout(done, ms))),
    now: opts.now || (() => new Date()),
    lockTimeoutMs: opts.lockTimeoutMs ?? LOCK_TIMEOUT_MS,
    verifyTimeoutMs: opts.verifyTimeoutMs ?? VERIFY_TIMEOUT_MS,
    verifyPollMs: opts.verifyPollMs ?? VERIFY_POLL_MS,
  };
}

export const sha = (text) => createHash("sha256").update(String(text), "utf8").digest("hex");
const sha8 = (text) => sha(text).slice(0, 8);
const normalizeDocText = (text) => String(text).replace(/\r\n/g, "\n").replace(/\r/g, "\n");
const toPosix = (p) => String(p).replace(/\\/g, "/");
const timestamp = (date) => date.toISOString().replace(/\.\d{3}Z$/, "Z");

export function dataDir(env = process.env) {
  return resolve(String(env.SINGULARITY_DOC_DATA || DEFAULT_DOC_DATA));
}

/**
 * Mirror the CLI contract: `--root X` with no SINGULARITY_DOC_DATA means the
 * ledger lives in `<X>/data`. Applied once per call so a nested retry cannot
 * switch ledgers mid-flight.
 */
function envForRoot(env, root) {
  const base = env || process.env;
  if (root === undefined || root === null || base.SINGULARITY_DOC_DATA) return base;
  return { ...base, SINGULARITY_DOC_DATA: join(resolve(root), "data") };
}

export function ledgerPath(env = process.env) {
  return join(dataDir(env), "doc-index", "ledger.json");
}

function lockDirPath(env = process.env) {
  // Same lock DIRECTORY the Python helper uses: mkdir is atomic on POSIX and
  // Windows, so both runtimes serialise on one primitive for the same ledger.
  return join(dataDir(env), "doc-index", ".ledger.lock.d");
}

/** str.splitlines() boundaries (kept identical for chunk parity). */
function splitLines(text) {
  const source = String(text);
  if (source === "") return [];
  const lines = source.split(/\r\n|[\n\r\u000b\u000c\u001c\u001d\u001e\u0085\u2028\u2029]/);
  // str.splitlines() does not emit a final empty line for a trailing break.
  if (lines.length && lines[lines.length - 1] === "") lines.pop();
  return lines;
}

/** json.dumps(indent=2, sort_keys=True, ensure_ascii=True) byte parity. */
function ledgerJson(ledger) {
  return `${JSON.stringify(sortKeysDeep(ledger), null, 2).replace(/[^\x00-\x7f]/g, (ch) =>
    `\\u${ch.charCodeAt(0).toString(16).padStart(4, "0")}`)}\n`;
}

function baseUrl(env = process.env, cfg = {}) {
  // The native Claude installer supplies a single MemoryCore configuration.
  // A workspace cwd cannot decide which gateway receives shared runbooks.
  return String(env.KNOWLEDGE_INDEX_BASE_URL || cfg.hostBaseUrl || cfg.baseUrl || DEFAULT_BASE_URL).replace(/\/+$/, "");
}

function scopeOf(env = process.env) {
  return {
    team_id: String(env.DOC_INDEX_TEAM || "singularity-docs"),
    user_id: String(env.DOC_INDEX_USER || "shared"),
    agent_id: "docs-keeper",
  };
}

function sleepSync(ms) {
  try {
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
  } catch {
    /* best effort: a busy loop is worse than a coarse wait */
  }
}

function sortKeysDeep(value) {
  if (Array.isArray(value) || value === null || typeof value !== "object") return value;
  const out = {};
  for (const key of Object.keys(value).sort()) out[key] = sortKeysDeep(value[key]);
  return out;
}

/** The root-scoped identity of a document: sha(root)[:8]::rel. */
export function documentIdentity(rootAbs, rel) {
  const rootId = sha8(toPosix(rootAbs));
  return { rootId, key: `${rootId}::${rel}`, docId: sha8(`${rootId}::${rel}`) };
}

// ── memory gateway client ────────────────────────────────────────────────────

function configPath(env) {
  return resolve(String(env.SINGULARITY_MEMORY_CONFIG || env.MEMORY_SECRETS || DEFAULT_MEMORY_SECRETS));
}

export function loadConfig(env = process.env) {
  const p = configPath(env);
  let cfg;
  try {
    cfg = JSON.parse(readFileSync(p, "utf8"));
  } catch (e) {
    throw new Blocked(`cannot read memory secrets (${p}): ${e?.message || e}`);
  }
  if (!cfg || !cfg.gatewayKey) throw new Blocked(`memory secrets have no gatewayKey: ${p}`);
  return cfg;
}

function ensureSuccess(resp, context = "memory request") {
  if (resp === null || resp === undefined) throw new Error(`${context}: empty memory response — not treated as success`);
  if (Array.isArray(resp) || typeof resp !== "object") throw new Error(`${context}: malformed memory response (expected object) — not treated as success`);
  const code = resp.code;
  if (code !== undefined && code !== null) {
    const ok = Number.parseInt(String(code), 10) === 0;
    if (!ok) throw new Error(`${context}: memory API reported application code ${code} — not treated as success`);
  }
  if (resp.error) throw new Error(`${context}: memory API reported an application error — not treated as success`);
  return resp;
}

function cfgAuth(cfg) {
  return {
    authPrefix: cfg.authPrefix ?? cfg.auth_prefix ?? "Bearer ",
    gatewayKey: cfg.gatewayKey,
    serviceId: cfg.serviceId ?? cfg.service_id,
    userKey: cfg.userKey ?? cfg.user_key,
  };
}

async function memoryCall(path, payload, ctx, cfg) {
  const auth = cfgAuth(cfg);
  const headers = {
    "Content-Type": "application/json",
    Authorization: `${auth.authPrefix}${auth.gatewayKey}`,
    "x-tdai-service-id": auth.serviceId,
    "x-tdai-user-key": auth.userKey,
  };
  let res;
  try {
    res = await ctx.fetchImpl(`${baseUrl(ctx.env,cfg)}/v3${path}`, {
      method: "POST",
      redirect: "error",
      headers,
      body: JSON.stringify(payload),
      signal: typeof AbortSignal !== "undefined" && typeof AbortSignal.timeout === "function" ? AbortSignal.timeout(MEMORY_TIMEOUT_MS) : undefined,
    });
  } catch (e) {
    throw new Error(`memory request failed: ${e?.message || e}`);
  }
  if (!res || res.ok !== true) throw new Error(`memory request failed: HTTP ${res?.status ?? "unknown"}`);
  const text = await res.text();
  try {
    return JSON.parse(text);
  } catch {
    throw new Error("memory response was not JSON");
  }
}

async function searchOnce(cfg, query, limit, ctx) {
  const found = ensureSuccess(
    await memoryCall("/conversation/search", { ...scopeOf(ctx.env), query, limit }, ctx, cfg),
    "documentation search",
  );
  return (found.data || {}).messages || [];
}

async function markerVisible(cfg, marker, limit, ctx) {
  const binary = ctx.env.SINGULARITY_DOC_WRITE_RUST_BIN;
  if (binary) return writeNativeDocChunk({ ...scopeOf(ctx.env), query:marker, limit },
    {binary, config:configPath(ctx.env), origin:baseUrl(ctx.env,cfg),
      serviceId:cfgAuth(cfg).serviceId, env:ctx.env, marker:true});
  return (await searchOnce(cfg, marker, limit, ctx)).some(m => String(m?.content || "").includes(marker));
}

async function markerSearchable(cfg, marker, deadline, ctx) {
  for (;;) {
    try {
      if (await markerVisible(cfg, marker, SEARCH_LIMIT_DEFAULT, ctx)) return true;
    } catch {
      /* eventual indexing: transient gateway errors keep polling */
    }
    if (Date.now() >= deadline) return false;
    await ctx.sleep(ctx.verifyPollMs);
  }
}

async function nativeIntentVerified(cfg, taskId, messages, ctx) {
  const binary = ctx.env.SINGULARITY_DOC_WRITE_RUST_BIN;
  if (binary) return writeNativeDocChunk({
    ...scopeOf(ctx.env), session_id: DOCS_SESSION, task_id: taskId, messages,
  }, {binary, config:configPath(ctx.env), origin:baseUrl(ctx.env,cfg), serviceId:cfgAuth(cfg).serviceId, env:ctx.env, verify:true});
  const response = ensureSuccess(await memoryCall("/conversation/query", {
    ...scopeOf(ctx.env), session_id: DOCS_SESSION, task_id: taskId, offset: 0, limit: 100,
  }, ctx, cfg), "documentation task readback");
  const rows = response.data?.messages;
  if (!Array.isArray(rows) || rows.length >= 100) return false;
  const normalize = content => {
    const i = content.indexOf("\n\n");
    if (i < 0) return content;
    return content.slice(0, i).replace(/^ingested: [^\n]+$/gm, "ingested:") + content.slice(i);
  };
  return messages.every(message => rows.some(row => row?.task_id === taskId &&
    row.role === message.role && typeof row.content === "string" &&
    normalize(row.content) === normalize(message.content)));
}

function nativeTarget(cfg, ctx) {
  const auth = cfgAuth(cfg);
  const scope = scopeOf(ctx.env);
  return sha(JSON.stringify([baseUrl(ctx.env,cfg), scope.team_id, scope.user_id,
    scope.agent_id, auth.serviceId ?? null]));
}

async function writeChunk(cfg, chunkTask, chunkText, recordedAt, ctx, rec, intent, publish) {
  const binary = ctx.env.SINGULARITY_DOC_WRITE_RUST_BIN;
  try {
    let searchable;
    try {
      searchable = await markerVisible(cfg, chunkTask.marker, 10, ctx);
    } catch (error) {
      if (binary) return "uncertain";
      throw error;
    }
    const messages = [
      { role: "user", content: chunkText, recorded_at: recordedAt },
      { role: "assistant", content: `Documentation record ${chunkTask.marker} acknowledged.`, recorded_at: recordedAt },
    ];
    // Search absence alone cannot distinguish a lost response from a
    // committed write whose index has not caught up. A single search hit can
    // also be a partial write. Require exact task readback of both messages.
    if (intent.includes(chunkTask.taskId)) {
      try {
        if (searchable && await nativeIntentVerified(cfg, chunkTask.taskId, messages, ctx)) return "present";
      } catch { /* an unavailable query cannot authorize another write */ }
      return "uncertain";
    }
    if (searchable) return "present";
    const body = {...scopeOf(ctx.env), session_id: DOCS_SESSION, task_id: chunkTask.taskId, messages};
    if (binary) {
      rec.write_target = nativeTarget(cfg, ctx);
      intent.push(chunkTask.taskId);
      publish();
      try {
        writeNativeDocChunk(body, {binary, config:configPath(ctx.env),
          origin:baseUrl(ctx.env,cfg), serviceId:cfgAuth(cfg).serviceId, env:ctx.env});
        if (!(await nativeIntentVerified(cfg, chunkTask.taskId, messages, ctx))) return "uncertain";
      } catch {
        // Never retry or substitute the JavaScript HTTP path.
        return "uncertain";
      }
    } else {
      ensureSuccess(await memoryCall("/conversation/add", body, ctx, cfg), `chunk add ${chunkTask.taskId}`);
    }
    return "written";
  } catch (e) {
    if (e instanceof Blocked) throw e;
    throw new Error(`chunk write failed (${chunkTask.taskId}): ${e?.message || e}`);
  }
}

async function writeSupersession(cfg, docId8, oldRev, newRev, ctx, rec, publish) {
  const marker = `[docs-superseded:${docId8}:${oldRev}->${newRev}]`;
  const taskId = marker.slice(1, -1);
  const messages = [{
    role: "user",
    content: `${marker} Documentation revision ${oldRev} of document ${docId8} is SUPERSEDED by revision ${newRev}. Never present revision ${oldRev} as current guidance.`,
    recorded_at: timestamp(ctx.now()),
  }];
  const binary = ctx.env.SINGULARITY_DOC_WRITE_RUST_BIN;
  const pending = rec.supersession_intent;
  try {
    const searchable = await markerVisible(cfg, marker, 5, ctx);
    if (pending !== undefined) {
      return searchable && await nativeIntentVerified(cfg, taskId, messages, ctx) ? "present" : "uncertain";
    }
    if (searchable) return "present";
    const body = {...scopeOf(ctx.env), session_id:DOCS_SESSION, task_id:taskId, messages};
    if (binary) {
      rec.supersession_intent = taskId;
      rec.write_target = nativeTarget(cfg, ctx);
      publish();
      try {
        writeNativeDocChunk(body, {binary, config:configPath(ctx.env), origin:baseUrl(ctx.env,cfg), serviceId:cfgAuth(cfg).serviceId, env:ctx.env});
        return await nativeIntentVerified(cfg, taskId, messages, ctx) ? "written" : "uncertain";
      } catch { return "uncertain"; }
    }
    ensureSuccess(await memoryCall("/conversation/add", body, ctx, cfg), "supersession tombstone");
    return "written";
  } catch (e) {
    if (e instanceof Blocked) throw e;
    return pending !== undefined || binary ? "uncertain" : `failed: ${e?.message || e}`;
  }
}

// ── eligibility and safety ───────────────────────────────────────────────────

function isInside(parent, child) {
  const rel = relative(resolve(parent), resolve(child));
  return rel !== "" && !isAbsolute(rel) && rel !== ".." && !rel.startsWith(`..${"/"}`) && !rel.startsWith(`..\\`);
}

export function docRoots(rootArg, env = process.env) {
  const roots = [];
  // An explicit --root is an exclusive scope: environment roots are a default
  // only when the invocation did not choose a workspace.
  const candidates = rootArg
    ? [rootArg]
    : String(env.SINGULARITY_DOC_ROOTS || "").split(delimiter).filter(Boolean);
  for (const item of candidates) {
    const rp = resolve(item);
    if (!roots.includes(rp)) roots.push(rp);
  }
  return roots;
}

/** Return { rel, title, root } or throw Blocked. Symlink-traversal safe. */
export function classifySource(filePath, roots) {
  let real;
  try {
    real = realpathSync(filePath);
  } catch (e) {
    throw new Blocked(`cannot resolve document: ${e?.message || e}`);
  }
  const name = String(filePath).split(/[\\/]/).pop();
  if (SECRET_FILENAMES.test(name)) throw new Blocked(`secret-like filename refused: ${name}`);
  if (extname(real).toLowerCase() !== ".md") throw new Blocked(`only .md documentation is eligible: ${name}`);
  let size;
  try {
    size = statSync(real).size;
  } catch (e) {
    throw new Blocked(`cannot stat document: ${e?.message || e}`);
  }
  if (size === 0) throw new Blocked("document is empty");
  if (size > MAX_DOC_BYTES) throw new Blocked(`document too large to ingest safely (${size} > ${MAX_DOC_BYTES} bytes); split it`);
  const inside = roots.filter((r) => isInside(r, real));
  if (!inside.length) throw new Blocked("path is outside the documentation allowlist roots (pass --root)");
  const root = inside[0];
  const lexical = resolve(filePath);
  if (!isInside(root, lexical)) throw new Blocked("symlink traversal outside the authorized root");
  const rel = toPosix(relative(root, real));
  const text = readFileSync(real, "utf8");
  const title = splitLines(text).map((line) => line.trim()).find((line) => line.startsWith("#"))?.replace(/^[# ]+/, "").trim() || rel;
  return { rel, title, root };
}

export function rejectSensitive(text, rel) {
  if ((String(text).match(/```/g) || []).length % 2 !== 0) {
    throw new Blocked("unbalanced code fences — refusing to guess chunk boundaries");
  }
  for (const pattern of SECRET_PATTERNS) {
    if (pattern.test(text)) {
      throw new Blocked(`sensitive content detected in ${rel} (pattern ${pattern.source.slice(0, 28)}...); reject or redact per local policy before ingestion`);
    }
  }
  if (/\b(?:api[_-]?key|secret|password|token)\b\s*[:=]\s*"?[\w./+=-]{8,}"?/i.test(text)) {
    throw new Blocked(`sensitive assignment detected in ${rel}; reject or redact per local policy`);
  }
}

/** Exact-result native doc policy. Credential screening precedes this call
 * in the canonical ingest path. Native selection cannot bypass the Node
 * source contract or turn an unverified revision into current guidance. */
function checkedDocIndex(command, request, reference, env) {
  if (!nativeDocIndexPolicyEnabled(env)) return reference;
  let actual;
  try { actual = requestNativeDocIndexPolicy(command, request, env); }
  catch { throw new Blocked("native documentation policy unavailable or disagrees with the source contract"); }
  if (!isDeepStrictEqual(actual, reference)) {
    throw new Blocked("native documentation policy unavailable or disagrees with the source contract");
  }
  return actual;
}

/** Split into <=7,000 *Unicode code points* per chunk, never silently
 * truncating or accumulating an oversized physical line. */
export function chunkMarkdown(text, env = process.env) {
  const lines = splitLines(text);
  const chunks = [];
  let current = [];
  let currentChars = 0;
  let fence = false;
  function flush() {
    if (current.length) chunks.push(current.join("\n"));
    current = [];
    currentChars = 0;
  }
  for (const line of lines) {
    if (line.trim().startsWith("```")) fence = !fence;
    const isHeading = !fence && /^#{1,3} /.test(line);
    if (isHeading && currentChars >= MAX_CHUNK_CHARS * 0.6 && current.length) flush();
    const units = Array.from(line);
    if (units.length + 1 > MAX_CHUNK_CHARS) {
      flush();
      for (let i = 0; i < units.length; i += MAX_CHUNK_CHARS) {
        const part = units.slice(i, i + MAX_CHUNK_CHARS).join("");
        if (part && Array.from(part).length === MAX_CHUNK_CHARS) chunks.push(part);
        else {
          current = [part];
          currentChars = Array.from(part).length + 1;
        }
        if (chunks.length > MAX_CHUNKS) throw new Blocked(`document needs more than ${MAX_CHUNKS} chunks; split it into smaller docs`);
      }
      continue;
    }
    if (current.length && currentChars + units.length + 1 > MAX_CHUNK_CHARS) flush();
    current.push(line);
    currentChars += units.length + 1;
    if (chunks.length > MAX_CHUNKS) throw new Blocked(`document needs more than ${MAX_CHUNKS} chunks; split it into smaller docs`);
  }
  flush();
  if (chunks.length > MAX_CHUNKS) throw new Blocked(`document needs ${chunks.length} chunks (max ${MAX_CHUNKS}); split it into smaller docs`);
  return checkedDocIndex('doc-index-chunks', {text}, {ok:true,chunks}, env).chunks;
}

function chunkWritePlan(chunks, rel, title, rootId, docId8, rev, ts, env) {
  const scope = scopeOf(env);
  const tasks = chunks.map((body, index) => {
    const i = index + 1;
    const chunkHash = sha8(body);
    const taskId = `docs-${docId8}-r${rev}-c${String(i).padStart(2, '0')}`;
    const marker = `[doc-ref:${rel}#${rev} chunk ${i}/${chunks.length} hash ${chunkHash}]`;
    const header = `${marker}\ntitle: ${title}\nsource: ${rel} (canonical file on disk — this memory record is its indexed copy)\n` +
      `revision: ${rev}\nroot-id: ${rootId}\nchunk: ${i}/${chunks.length}\ncontent-hash: ${chunkHash}\n` +
      `scope: ${scope.team_id}/${scope.user_id}\ningested: ${ts}\n\n`;
    return {task_id:taskId,marker,text:header+body,hash:chunkHash};
  });
  const checked = checkedDocIndex('doc-index-plan', {
    chunks, rel, title, rootId, docId:docId8, rev, timestamp:ts,
    team:scope.team_id, user:scope.user_id,
  }, {ok:true,tasks}, env);
  return checked.tasks.map(({task_id,marker,text,hash}) => ({taskId:task_id,marker,text,hash}));
}

// ── ledger (atomic + lock directory) ─────────────────────────────────────────

function acquireLock(lockDir, ctx) {
  mkdirSync(dirname(lockDir), { recursive: true });
  const start = Date.now();
  const ownerPath = join(lockDir, "owner");
  for (;;) {
    try {
      mkdirSync(lockDir);
      const owner = randomUUID();
      try {
        writeFileSync(ownerPath, owner, { flag: "wx", mode: 0o600 });
      } catch (e) {
        try { rmdirSync(lockDir); } catch { /* uncertain ownership: fail closed */ }
        throw e;
      }
      const assertOwner = () => {
        // A replaced lock must NEVER be used by the old writer.
        try {
          if (readFileSync(ownerPath, "utf8") !== owner) {
            throw new Error(`ledger lock ownership changed: ${lockDir}`);
          }
        } catch (e) {
          if (e?.code !== "ENOENT") throw e;
          throw new Error(`ledger lock disappeared while held: ${lockDir}`);
        }
      };
      return {
        owner,
        assertOwner,
        release() {
          assertOwner();
          rmSync(ownerPath);
          rmdirSync(lockDir);
        },
      };
    } catch (e) {
      if (e?.code !== "EEXIST") throw e;
      if (Date.now() - start > ctx.lockTimeoutMs) {
        throw new Error(`ledger lock busy: ${lockDir} (never auto-reaped; verify both writers stopped before manual recovery)`);
      }
      sleepSync(50);
    }
  }
}

export async function withLedger(fn, opts = {}) {
  const ctx = ctxOf(opts);
  const file = ledgerPath(ctx.env);
  mkdirSync(dirname(file), { recursive: true });
  const lock = acquireLock(lockDirPath(ctx.env), ctx);
  try {
    const ledger = loadLedger(ctx.env);
    const publish = () => {
      const serialized = ledgerJson(ledger);
      const tmp = join(dirname(file), `.ledger-${randomUUID()}.tmp`);
      const fd = openSync(tmp, "wx", 0o600);
      let published = false;
      try {
        try {
          writeFileSync(fd, serialized, "utf8");
          fsyncSync(fd);
        } finally {
          closeSync(fd);
        }
        lock.assertOwner();
        if (ctx.env.SINGULARITY_DOC_LEDGER_COMMIT_RUST_BIN) {
          try {
            const result = commitNativeDocLedger({
              schema: "singularity-doc-ledger-commit/v1",
              temp: tmp, owner: lock.owner,
            }, ctx.env);
            if (!isDeepStrictEqual(result, {ok: true, published: true}) || existsSync(tmp)
              || !statSync(file).isFile() || statSync(file).size !== Buffer.byteLength(serialized, "utf8")
              || !readFileSync(file).equals(Buffer.from(serialized, "utf8")))
              throw new Error("unconfirmed publication");
          } catch {
            // The child may have committed before a missing response. No fallback.
            throw new Blocked("native document ledger commit unconfirmed; inspect ledger before retry");
          }
        } else {
          renameSync(tmp, file);
        }
        published = true;
      } finally {
        if (!published) rmSync(tmp, { force: true });
      }
    };
    const result = await fn(ledger, publish);
    publish();
    return result;
  } finally {
    lock.release();
  }
}

export function loadLedger(env = process.env) {
  const file = ledgerPath(env);
  if (!existsSync(file)) return { version: 1, docs: {} };
  let ledger;
  try {
    ledger = JSON.parse(readFileSync(file, "utf8"));
  } catch (e) {
    if (e instanceof SyntaxError) throw new Blocked("DOC_LEDGER_CORRUPT: invalid JSON; preserve the file and recover it manually");
    throw e;
  }
  if (!ledger || Array.isArray(ledger) || typeof ledger !== "object" ||
      ledger.version !== 1 || !ledger.docs || Array.isArray(ledger.docs) ||
      typeof ledger.docs !== "object") {
    throw new Blocked("DOC_LEDGER_CORRUPT: invalid ledger structure; preserve the file and recover it manually");
  }
  return ledger;
}

// ── core ingest ──────────────────────────────────────────────────────────────

/**
 * Ingest one document end to end. Expected refusals (eligibility/security/size)
 * are returned as DOC_INGEST_BLOCKED, never raised.
 */
export async function ingestFile(filePath, opts = {}) {
  const ctx = ctxOf({ ...opts, env: envForRoot(opts.env, opts.root) });
  const ts = timestamp(ctx.now());
  let rel;
  let title;
  let rootDir;
  let text;
  try {
    const classified = classifySource(filePath, docRoots(opts.root, ctx.env));
    rel = classified.rel;
    title = classified.title;
    rootDir = classified.root;
    text = normalizeDocText(readFileSync(realpathSync(filePath), "utf8"));
    rejectSensitive(text, rel);
  } catch (e) {
    if (e instanceof Blocked) return { status: "DOC_INGEST_BLOCKED", file: String(filePath), reason: e.message };
    throw e;
  }

  const rootId = sha8(toPosix(resolve(rootDir)));
  const key = `${rootId}::${rel}`;
  const rev = sha8(text);
  // Optional explicitly approved recovery operation: refuse stale requests
  // before opening a ledger transaction or making any MemoryCore writes.
  if(opts.expectedRevision!==undefined && opts.expectedRevision!==rev)
    return {status:'DOC_INGEST_BLOCKED',file:rel,reason:'EXPECTED_SOURCE_REVISION_CHANGED'};
  const docId8 = sha8(key);

  return withLedger(async (ledger, publish) => {
    const entry = ledger.docs[key] || { rel, root: toPosix(resolve(rootDir)), root_id: rootId, doc_id: docId8, title, active_rev: null, revs: {} };
    ledger.docs[key] = entry;
    entry.root = toPosix(resolve(rootDir));
    entry.root_id = rootId;
    entry.rel = rel;
    entry.doc_id = docId8;
    entry.title = title;
    entry.revs = entry.revs && typeof entry.revs === "object" ? entry.revs : {};
    const report = { file: rel, root: rootId, identity: key, doc_id: docId8, rev, title, session: opts.session ?? null };

    if (entry.active_rev === rev && entry.revs[rev]?.status === "DOC_INGEST_INDEXED") {
      report.status = "DOC_INGEST_UNCHANGED";
      report.reason = "verified active revision matches source hash";
      entry.last_checked = ts;
      return report;
    }

    // A pending tombstone may already have changed the remote revision
    // chain. A later edit cannot commit around that uncertain transition.
    if (Object.entries(entry.revs).some(([other, row]) =>
        other !== rev && row && Object.hasOwn(row, 'supersession_intent')))
      throw new Blocked("DOC_NATIVE_PRIOR_SUPERSESSION_UNCONFIRMED");

    let chunks;
    try {
      chunks = chunkMarkdown(text, ctx.env);
    } catch (e) {
      if (!(e instanceof Blocked)) throw e;
      const rec = entry.revs[rev] || {};
      rec.status = "DOC_INGEST_BLOCKED";
      rec.reason = e.message.slice(0, 400);
      entry.revs[rev] = rec;
      report.status = "DOC_INGEST_BLOCKED";
      report.reason = rec.reason;
      return report;
    }

    let chunkTasks;
    try {
      chunkTasks = chunkWritePlan(chunks, rel, title, rootId, docId8, rev, ts, ctx.env);
    } catch (e) {
      if (!(e instanceof Blocked)) throw e;
      const rec = entry.revs[rev] || {};
      rec.status = "DOC_INGEST_BLOCKED";
      rec.reason = e.message.slice(0, 400);
      entry.revs[rev] = rec;
      report.status = "DOC_INGEST_BLOCKED";
      report.reason = rec.reason;
      return report;
    }

    const rec = entry.revs[rev] || { status: "DOC_INGEST_PENDING", chunks: chunks.length, ingested_at: ts };
    rec.task_ids = chunkTasks.map((t) => t.taskId);
    rec.hashes = chunkTasks.map((t) => t.hash);
    rec.chunks = chunks.length;
    const intent = Object.hasOwn(rec, 'write_intents') ? rec.write_intents : [];
    if (!Array.isArray(intent) || intent.some(id => !rec.task_ids.includes(id)) ||
        new Set(intent).size !== intent.length)
      throw new Blocked("DOC_LEDGER_WRITE_INTENT_INVALID");
    if (intent.length || ctx.env.SINGULARITY_DOC_WRITE_RUST_BIN) rec.write_intents = intent;
    rec.status = "DOC_INGEST_PENDING";
    delete rec.reason;
    // Parity with the Python engine: a new record always carries `session`
    // (null when absent), and an explicit session wins over a recorded one.
    rec.session = opts.session || rec.session || null;
    entry.revs[rev] = rec;

    let cfg;
    try {
      cfg = loadConfig(ctx.env);
    } catch (e) {
      if (!(e instanceof Blocked)) throw e;
      rec.status = "DOC_INGEST_BLOCKED";
      rec.reason = e.message.slice(0, 400);
      report.status = rec.status;
      report.reason = rec.reason;
      return report;
    }

    const expectedSupersession = entry.active_rev && entry.active_rev !== rev
      ? `docs-superseded:${docId8}:${entry.active_rev}->${rev}` : null;
    if (Object.hasOwn(rec, 'supersession_intent') && rec.supersession_intent !== expectedSupersession)
      throw new Blocked("DOC_LEDGER_SUPERSESSION_INTENT_INVALID");
    if (Object.hasOwn(rec, 'write_target') && rec.write_target !== nativeTarget(cfg, ctx))
      throw new Blocked("DOC_NATIVE_WRITE_TARGET_CHANGED");

    // Persist the intent while holding the shared owner lock. The previous
    // active revision remains current until successful readback.
    publish();
    for (const task of chunkTasks) {
      try {
        if (await writeChunk(cfg, task, task.text, ts, ctx, rec, intent, publish) === "uncertain") {
          rec.reason = "DOC_NATIVE_WRITE_UNCONFIRMED: wait for readback or reconcile before retry";
          return {...report, status: rec.status, reason: rec.reason};
        }
      } catch (e) {
        if (e instanceof Blocked) throw e;
        rec.status = "DOC_INGEST_FAILED";
        rec.reason = String(e?.message || e).slice(0, 400);
        report.status = rec.status;
        report.reason = rec.reason;
        return report;
      }
    }

    const deadline = Date.now() + ctx.verifyTimeoutMs;
    const missing = [];
    for (const task of chunkTasks) {
      if (!(await markerSearchable(cfg, task.marker, deadline, ctx))) missing.push(task.taskId);
    }
    if (missing.length) {
      rec.status = "DOC_INGEST_PENDING";
      rec.reason = `persisted but not yet searchable: ${missing.length}/${chunkTasks.length} chunks (retry)`;
      report.status = "DOC_INGEST_PENDING";
      report.reason = rec.reason;
      return report;
    }

    let superseded = null;
    if (expectedSupersession) {
      superseded = await writeSupersession(cfg, docId8, entry.active_rev, rev, ctx, rec, publish);
      if (superseded === "uncertain") {
        rec.reason = "DOC_NATIVE_SUPERSESSION_UNCONFIRMED: verify the prior revision before retry";
        return {...report, status: rec.status, reason: rec.reason};
      }
    }
    delete rec.write_intents;
    delete rec.write_target;
    delete rec.supersession_intent;
    rec.status = "DOC_INGEST_INDEXED";
    rec.verified_at = ts;
    entry.active_rev = rev;
    entry.last_verified = ts;
    report.status = "DOC_INGEST_INDEXED";
    report.chunks = chunks.length;
    report.bytes = text.length;
    report.superseded = superseded;
    return report;
  }, { ...opts, env: ctx.env });
}

// ── retry / status / verify / search (root-persisted path resolution) ────────

export function rootIdOf(rootArg) {
  return sha8(toPosix(resolve(rootArg)));
}

function locateEntryIndexReference(candidates, rootPinned) {
  let first = null;
  for (const [index, [matches, rootMatches]] of candidates.entries()) {
    if (!matches) continue;
    if (rootPinned) {
      if (rootMatches) return index;
    } else if (first === null) {
      first = index;
    } else {
      return null;
    }
  }
  return first;
}

export function locateEntryKey(ledger, filePath, rootArg, env = process.env) {
  const given = toPosix(filePath);
  const rootPin = rootArg !== undefined && rootArg !== null ? rootIdOf(rootArg) : null;
  const keys = [];
  const candidates = [];
  for (const [key, entry] of Object.entries(ledger.docs || {})) {
    const rel = entry?.rel || key.split("::").slice(1).join("::");
    const rootAbs = entry?.root;
    const matches = given === rel || given.endsWith(`/${rel}`) ||
      Boolean(isAbsolute(given) && rootAbs && given === toPosix(join(rootAbs, rel)));
    keys.push(key);
    candidates.push([matches, rootPin !== null && key.split("::")[0] === rootPin]);
  }
  const rootPinned = rootPin !== null;
  const index = locateEntryIndexReference(candidates, rootPinned);
  const checked = checkedDocIndex("doc-index-locate", {candidates, rootPinned}, {ok:true,index}, env);
  return checked.index === null ? null : keys[checked.index];
}


export function resolveEntryTarget(entry) {
  const rootAbs = entry?.root;
  const rel = entry?.rel;
  if (!rootAbs || !rel || !isAbsolute(rootAbs)) return null; // legacy entry: cannot be resolved safely
  const target = join(rootAbs, rel);
  if (!isInside(realpathSyncSafe(rootAbs), realpathSyncSafe(target))) {
    throw new Blocked(`stored document path escaped its authorised root (${rootAbs}); retry refused`);
  }
  return target;
}

function realpathSyncSafe(p) {
  try {
    return realpathSync(p);
  } catch {
    return resolve(p);
  }
}

function sameWorkspaceRoot(a, b) {
  const norm = (p) => toPosix(String(p)).replace(/\/+$/, "");
  // Windows filesystems are case-insensitive; a Python-created ledger may also
  // store backslashes where Node stores forward slashes.
  return process.platform === "win32"
    ? norm(a).toLowerCase() === norm(b).toLowerCase()
    : norm(a) === norm(b);
}

function rootIsCurrentlyAuthorised(entryRoot, roots) {
  if (!entryRoot) return false;
  if (!roots.length) return true;
  const ap = resolve(entryRoot);
  return roots.some((r) => sameWorkspaceRoot(ap, r) || isInside(r, ap));
}

export async function retryDocuments(opts = {}) {
  // Pin the invocation's data dir before resolving any ledger entry. Without
  // this, a nested ingest with `root: entry.root` would point at a DIFFERENT
  // ledger (`<entry.root>/data`) than the one retry just read, which is not
  // what the Python CLI does and would silently split the ledger.
  const env = { ...envForRoot(opts.env, opts.root) };
  if (!env.SINGULARITY_DOC_DATA) env.SINGULARITY_DOC_DATA = dataDir(env);
  const ctx = ctxOf({ ...opts, env });
  const { filePath = null, all = false, root = undefined } = opts;
  const results = [];
  const roots = docRoots(root, env);
  const ledger = loadLedger(env);
  let wantedKey = null;
  if (!all && filePath) {
    wantedKey = locateEntryKey(ledger, filePath, root, env);
    if (wantedKey === null) {
      return [{ status: "DOC_INGEST_BLOCKED", file: String(filePath), reason: "no ledger record matches --file (nothing recorded for this document)" }];
    }
  }
  const keys = Object.keys(ledger.docs || {}).sort();
  for (const key of keys) {
    if (!all && key !== wantedKey) continue;
    const entry = ledger.docs[key];
    if (!rootIsCurrentlyAuthorised(entry?.root, roots)) {
      results.push({
        status: "DOC_INGEST_BLOCKED",
        file: entry?.rel || key,
        reason: "recorded root is not inside the currently authorised documentation roots — pass the matching --root or update SINGULARITY_DOC_ROOTS",
      });
      continue;
    }
    let target;
    try {
      target = resolveEntryTarget(entry);
    } catch (e) {
      if (!(e instanceof Blocked)) throw e;
      results.push({ status: "DOC_INGEST_BLOCKED", file: entry?.rel || key, reason: e.message });
      continue;
    }
    if (target === null) continue;
    results.push(await ingestFile(target, { ...opts, env, root: entry.root }));
  }
  return results;
}

/** The hook entrypoint: retry every PENDING/FAILED document for this workspace. */
export async function retryPendingIngestion(root, opts = {}) {
  return retryDocuments({ ...opts, all: true, root });
}

function statusRow(entry, fallbackRel) {
  const active = entry?.active_rev;
  const rec = active ? entry?.revs?.[active] || {} : {};
  const rel = entry?.rel || fallbackRel;
  let stale = null;
  if (entry?.root && rel) {
    const p = join(entry.root, rel);
    if (existsSync(p)) {
      try {
        stale = sha8(normalizeDocText(readFileSync(p, "utf8"))) !== active;
      } catch {
        stale = null;
      }
    }
  }
  return {
    file: rel,
    root: entry?.root_id,
    doc_id: entry?.doc_id,
    active_rev: active ?? null,
    status: rec.status || "DOC_INGEST_PENDING",
    chunks: rec.chunks ?? null,
    verified_at: rec.verified_at ?? null,
    stale_source: stale,
    title: entry?.title,
  };
}

export function statusReport(opts = {}) {
  const env = envForRoot(opts.env, opts.root);
  const { filePath = null, all = false, root = undefined } = opts;
  const ledger = loadLedger(env);
  const rootPin = root !== undefined && root !== null ? rootIdOf(root) : null;
  const out = [];
  if (filePath && !all) {
    const wanted = locateEntryKey(ledger, filePath, root, env);
    if (wanted !== null) out.push(statusRow(ledger.docs[wanted], filePath));
    return out;
  }
  for (const key of Object.keys(ledger.docs || {}).sort()) {
    const entry = ledger.docs[key];
    if (rootPin !== null && entry?.root_id !== rootPin) continue;
    out.push(statusRow(entry, entry?.rel || key.split("::").slice(1).join("::")));
  }
  return out;
}

/**
 * Independent completion evidence for one document — the LEDGER decides.
 * A caller-claimed status is never trusted: every fact is re-derived from
 * recorded ledger evidence plus the current source hash.
 */
export function verifyFile(rel, opts = {}) {
  const env = envForRoot(opts.env, opts.root);
  const root = opts.root;
  const ledger = loadLedger(env);
  const roots = docRoots(root, env);
  const candidates = [];
  for (const key of Object.keys(ledger.docs || {}).sort()) {
    const entry = ledger.docs[key];
    const relE = entry?.rel || key.split("::").slice(1).join("::");
    if (relE !== rel) continue;
    if (!rootIsCurrentlyAuthorised(entry?.root, roots)) continue;
    if (root !== undefined && root !== null) {
      const expected = toPosix(resolve(root));
      if (entry?.root && !sameWorkspaceRoot(entry.root, expected)) {
        return { status: "DOC_INGEST_NOT_VERIFIED", file: relE, reason: "recorded under a different workspace root; wrong workspace/scope" };
      }
      if (entry?.root_id && entry.root_id !== rootIdOf(root)) continue;
    }
    candidates.push([key, entry]);
  }
  if (!candidates.length) {
    return { status: "DOC_INGEST_NOT_VERIFIED", file: rel, reason: "no ledger record for this document in this workspace/scope" };
  }
  if (candidates.length > 1) {
    return { status: "DOC_INGEST_NOT_VERIFIED", file: rel, reason: "ambiguous: the same relative path is recorded under several roots; pass --root" };
  }
  const [, entry] = candidates[0];
  const relE = entry?.rel || candidates[0][0].split("::").slice(1).join("::");
  return entryEvidence(entry, relE);
}

/** Re-derive completion evidence for one exact ledger entry. */
function entryEvidence(entry, relE) {
  let target;
  try {
    target = resolveEntryTarget(entry);
  } catch (e) {
    if (!(e instanceof Blocked)) throw e;
    return { status: "DOC_INGEST_NOT_VERIFIED", file: relE, reason: e.message };
  }
  if (target === null) {
    return { status: "DOC_INGEST_NOT_VERIFIED", file: relE, reason: "ledger record has no stored authorised root (legacy entry); re-ingest with --root" };
  }
  let targetIsFile = false;
  try {
    targetIsFile = statSync(target).isFile();
  } catch {
    targetIsFile = false;
  }
  if (!targetIsFile) {
    return { status: "DOC_INGEST_NOT_VERIFIED", file: relE, reason: "documented source file missing on disk" };
  }
  const active = entry.active_rev;
  const rec = active ? entry.revs?.[active] || {} : {};
  const current = sha8(normalizeDocText(readFileSync(target, "utf8")));
  if (active && current !== active) {
    return { status: "DOC_INGEST_NOT_VERIFIED", file: relE, reason: "changed source was never indexed successfully (stale hash)" };
  }
  if (rec.status !== "DOC_INGEST_INDEXED" || !rec.verified_at) {
    const claimed = active ? rec.status : "missing active revision";
    return { status: "DOC_INGEST_NOT_VERIFIED", file: relE, reason: `active revision verification record is '${claimed}', not a verified index` };
  }
  const chunks = rec.chunks || 0;
  const taskIds = rec.task_ids || [];
  const hashes = rec.hashes || [];
  if (!chunks || taskIds.length !== chunks || hashes.length !== chunks || hashes.some((h) => !h)) {
    return { status: "DOC_INGEST_NOT_VERIFIED", file: relE, reason: "incomplete chunk records (task ids/hashes not accounted for)" };
  }
  const newerUnresolved = Object.keys(entry.revs || {}).sort().filter((r) =>
    r !== active &&
    ["DOC_INGEST_PENDING", "DOC_INGEST_FAILED"].includes(entry.revs[r]?.status) &&
    String(entry.revs[r]?.ingested_at || "") > String(rec.verified_at || ""));
  if (newerUnresolved.length) {
    return { status: "DOC_INGEST_NOT_VERIFIED", file: relE, reason: `newer unresolved revision(s) ${newerUnresolved.join(", ")}; retry ingestion before claiming completion` };
  }
  return { status: "DOC_INGEST_VERIFIED", file: relE, root: entry.root_id, revision: active, chunks, verified_at: rec.verified_at };
}

/**
 * Bounded search of the shared documentation knowledge. Only records whose
 * document identity AND revision match a verified active ledger revision in the
 * same scope are current guidance; absent/superseded records need `stale`.
 */
function selectDocIndicesReference(candidates, limit, includeStale, rootsRestricted) {
  const selected = [];
  const seen = new Set();
  for (const row of candidates) {
    if (row.superseded || !row.validMarker) continue;
    if (rootsRestricted && (!row.hasEntry || !row.rootAllowed)) continue;
    if (!includeStale && (!row.activeRevMatches || !row.verifiedActive)) continue;
    const key = `${row.rootId}\u0000${row.rel}\u0000${row.rev}`;
    if (seen.has(key)) continue;
    seen.add(key);
    selected.push(row.index);
    if (selected.length >= limit) break;
  }
  return selected;
}

/**
 * Project only equality-preserving synthetic IDs to the Rust deduplication
 * policy. Canonical root, relative document name and revision remain in JS.
 */
function nativeRetrievalFacts(facts) {
  const groups = new Map();
  return facts.map(({rootId, rel, rev, ...flags}) => {
    const key = JSON.stringify([rootId, rel, rev]);
    if (!groups.has(key)) groups.set(key, String(groups.size));
    return {...flags, rootId:groups.get(key), rel:'', rev:''};
  });
}

/**
 * Current documentation is verified against the canonical source and revision
 * ledger BEFORE the native policy process sees any facts. Rust sees no
 * credentials, retrieved message body or document identity.
 */
export async function searchDocs(query, opts = {}) {
  const ctx = ctxOf({ ...opts, env: envForRoot(opts.env, opts.root) });
  const limit = opts.limit ?? SEARCH_LIMIT_DEFAULT;
  const includeStale = Boolean(opts.stale);
  const cfg = loadConfig(ctx.env);
  const messages = await searchOnce(cfg, query, includeStale ? limit * 4 : limit * 2, ctx);
  const ledger = loadLedger(ctx.env);
  const authorisedRoots = docRoots(opts.root, ctx.env);
  const entries = new Map();
  for (const [key, entry] of Object.entries(ledger.docs || {})) {
    entries.set(`${entry?.root_id ?? ''}\u0000${entry?.rel || key.split('::').slice(1).join('::')}`, entry);
  }
  const facts = [];
  const displays = new Map();
  for (const [index,message] of messages.entries()) {
    const content = String(message?.content || '');
    const superseded = content.includes('docs-superseded:');
    const ref = superseded ? null : content.match(/\[doc-ref:([^#\]]+)#([0-9a-f]{8})/);
    const valid = Boolean(ref);
    const rel = ref?.[1] ?? '';
    const rev = ref?.[2] ?? '';
    const rootHit = valid ? (content.match(/^root-id: ([0-9a-f]{8})$/m)?.[1] ?? null) : null;
    const entry = valid ? entries.get(`${rootHit ?? ''}\u0000${rel}`) : null;
    const allowed = authorisedRoots.length ? Boolean(entry && rootIsCurrentlyAuthorised(entry.root, authorisedRoots)) : Boolean(entry);
    const current = Boolean(entry?.active_rev && entry.active_rev === rev);
    let verified = false;
    if (!includeStale && current && (!authorisedRoots.length || allowed)) {
      const evidence = entryEvidence(entry, rel);
      verified = evidence.status === 'DOC_INGEST_VERIFIED' && evidence.revision === rev;
    }
    facts.push({index,validMarker:valid,superseded,hasEntry:Boolean(entry),rootAllowed:allowed,
                activeRevMatches:current,verifiedActive:verified,rootId:rootHit ?? '',rel,rev});
    if (valid) displays.set(index,{source:rel,root:rootHit,revision:rev,content:content.slice(0,1200)});
  }
  const indices = selectDocIndicesReference(facts, limit, includeStale, Boolean(authorisedRoots.length));
  const checked = checkedDocIndex('doc-index-select', {
    candidates:nativeRetrievalFacts(facts), limit, includeStale,
    rootsRestricted:Boolean(authorisedRoots.length),
  }, {ok:true,indices}, ctx.env);
  return checked.indices.map((index) => displays.get(index));
}

// ── CLI ──────────────────────────────────────────────────────────────────────

function parseCli(argv) {
  const args = [...argv];
  const command = args.shift();
  const flags = { file: null, root: null, session: null, all: false, limit: SEARCH_LIMIT_DEFAULT, stale: false, query: null };
  const positional = [];
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a === "--file") flags.file = args[++i];
    else if (a === "--root") flags.root = args[++i];
    else if (a === "--session") flags.session = args[++i];
    else if (a === "--all") flags.all = true;
    else if (a === "--stale") flags.stale = true;
    else if (a === "--limit") flags.limit = Number.parseInt(args[++i], 10) || SEARCH_LIMIT_DEFAULT;
    else if (a.startsWith("--")) throw new Blocked(`unknown option: ${a}`);
    else positional.push(a);
  }
  if (command === "search") flags.query = positional[0] ?? null;
  return { command, flags };
}

export async function main(argv = process.argv.slice(2), opts = {}) {
  const baseEnv = opts.env || process.env;
  const env = { ...baseEnv };
  let parsed;
  try {
    parsed = parseCli(argv);
  } catch (e) {
    process.stdout.write(`${JSON.stringify({ status: "DOC_INGEST_BLOCKED", reason: e.message })}\n`);
    return 1;
  }
  const { command, flags } = parsed;
  const runOpts = { ...opts, env, root: flags.root ?? undefined };
  try {
    if (command === "ingest") {
      const out = await ingestFile(flags.file, { ...runOpts, session: flags.session });
      process.stdout.write(`${JSON.stringify(out)}\n`);
      return 0;
    }
    if (command === "retry") {
      const out = await retryDocuments({ ...runOpts, filePath: flags.file, all: flags.all });
      process.stdout.write(`${JSON.stringify({ results: out })}\n`);
      return 0;
    }
    if (command === "status") {
      process.stdout.write(`${JSON.stringify(statusReport({ ...runOpts, filePath: flags.file, all: flags.all }))}\n`);
      return 0;
    }
    if (command === "verify") {
      process.stdout.write(`${JSON.stringify(verifyFile(flags.file, runOpts))}\n`);
      return 0;
    }
    if (command === "search") {
      const items = await searchDocs(flags.query, { ...runOpts, limit: flags.limit, stale: flags.stale });
      process.stdout.write(`${JSON.stringify({ items })}\n`);
      return 0;
    }
    throw new Blocked("a command is required: ingest | retry | status | verify | search");
  } catch (e) {
    if (e instanceof Blocked) {
      process.stdout.write(`${JSON.stringify({ status: "DOC_INGEST_BLOCKED", reason: e.message })}\n`);
      return 1;
    }
    throw e;
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const code = await main(process.argv.slice(2));
  process.exitCode = code;
}
