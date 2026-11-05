// lib/repoql-client.mjs — V3.4.3 ticket 094 (Sol FIX PLAN items 6+7): the ONE
// deterministic RepoQL retrieval boundary. Mirrors lib/qmd-client.mjs shape:
// every call returns { ok:true, ... } or { ok:false, code } — NEVER throws on
// RepoQL trouble (outage degrades exactly like QMD, plan §30).
//
// Confidentiality (Sol: gate at the client boundary before dispatch, workers
// cannot bypass): this client offers ONLY local-class operations (status,
// explore/search, read). Cloud-class RepoQL operations (explain, ask(),
// cloud embeddings/rerank, Uplink) are NOT exposed here at all, so a
// confidential run can never reach them through the kit path. When
// confidential=true the client additionally refuses any target scope outside
// the local workspace mount (defense in depth) and stamps mode local-only.
//
// exec via `rql` CLI (json output where supported). Timeouts on every call.
import { spawn } from "node:child_process";
import { appendFileSync, existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { HARNESS_PATHS } from "./kit-paths.mjs";

// One JSONL line per RepoQL operation, so production behaviour is measurable
// without a new service (Sol O1/O8, still open). Bounded, fail-open, off with
// ORCH_REPOQL_METRICS=0. Query text is represented by length + a short hash,
// never in full: the ledger is about latency and uniqueness, not content.
const METRICS_OFF = process.env.ORCH_REPOQL_METRICS === "0";
function queryHash(q) {
  let h = 2166136261;
  const s = String(q ?? "");
  for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 16777619); }
  return (h >>> 0).toString(36);
}
function metric(evt) {
  if (METRICS_OFF) return;
  try {
    const dir = process.env.ORCH_METRICS_DIR || join(process.cwd(), "runs");
    appendFileSync(join(dir, "repoql-metrics.jsonl"), JSON.stringify({ at: new Date().toISOString(), ...evt }) + "\n");
  } catch { /* telemetry never breaks retrieval */ }
}

const DEFAULT_TIMEOUT_MS = 8000;
// Per-op timeout bounds (ticket 094 Phase 2, plan §5.6): derived from the plan's
// measurement starting ranges, env-overridable. status 3-5s, explore 15-30s,
// focused read 10-20s, SQL count 10s. explain/ask/Uplink are NOT exposed here
// (cloud-class, confidentiality boundary) so no timeout is assigned to them.
// V3.5.7 (ticket 094 follow-on, Sol-approved P2): explicit response budgets for
// explore/read (docs: "The token budget caps the response"). Env-overridable with
// numeric-positive validation; fall back to defaults on garbage.
const _posInt = (v, d) => { const n = Number(v); return Number.isFinite(n) && n > 0 ? Math.floor(n) : d; };
const BUDGETS = {
  explore: _posInt(process.env.REPOQL_TOKEN_BUDGET_EXPLORE, 900),
  // Read must be able to HOLD the document: rql fails closed (rc=2) when the
  // requested budget is smaller than the document instead of truncating, so the
  // previous 1200 failed every doc over ~1.2k tokens (services/doc-program.md is
  // 2.6k). The response is still sliced to maxBytes here, so a generous budget
  // costs server-side tokens only and makes the read correct.
  read: _posInt(process.env.REPOQL_TOKEN_BUDGET_READ, 6000),
};

// `--cache-seconds` exists on `rql query` ONLY (explore rejects it), so the SQL
// paths use the host cache while advisory explore needs its own bounded cache.
const QUERY_CACHE_SECONDS = _posInt(process.env.ORCH_REPOQL_CACHE_SECONDS ?? process.env.REPOQL_CACHE_SECONDS, 300);
const cacheArgs = () => (QUERY_CACHE_SECONDS > 0 ? ["--cache-seconds", String(QUERY_CACHE_SECONDS)] : []);

// Explore cache (measured 2026-10-24): `rql explore --uri-glob` costs 2.9 s for a
// single file, ~6-11 s for the 177-file hub docs scope and ~22 s for concepts,
// with no host-side cache for explore at all. Advisory retrieval repeats the
// same (glob, query) across hooks in one run, so a small TTL+LRU cache removes
// most of that cost WITHOUT touching the retrieval algorithm. Key includes the
// rql binary + working directory (host identity), scope glob, query, limit and
// token budget, so two scopes can never share an entry. Freshness-sensitive
// callers must not use this at all; it is advisory-only by contract.
const EXPLORE_CACHE_MS = _posInt(process.env.ORCH_REPOQL_EXPLORE_CACHE_MS, 300_000);
const EXPLORE_CACHE_MAX = _posInt(process.env.ORCH_REPOQL_EXPLORE_CACHE_MAX, 200);

const OP_TIMEOUTS = {
  status: Number(process.env.REPOQL_TIMEOUT_STATUS_MS ?? 5000),
  explore: Number(process.env.REPOQL_TIMEOUT_EXPLORE_MS ?? 30000),
  read: Number(process.env.REPOQL_TIMEOUT_READ_MS ?? 20000),
  query: Number(process.env.REPOQL_TIMEOUT_QUERY_MS ?? 10000),
  // `read <scope> => concepts` resolves applicability against the index; the
  // measured cost is ~2.7 s for one file, so it takes the read bound.
  concepts: Number(process.env.REPOQL_TIMEOUT_CONCEPTS_MS ?? 20000),
  // `rql concept hints` is a filesystem/glob match, not a semantic search: it
  // measured 77-89 ms on controller versus 3.9-4.4 s for scoped explore. The
  // bound is generous for a cold host start and still far below explore's.
  hints: Number(process.env.REPOQL_TIMEOUT_HINTS_MS ?? 8000),
};
// Use the rql shim at /usr/local/bin/rql when in container (it handles SSH to controller)
// or the direct binary when on controller.
// Ticket 164 Phase 1: explicit kit config v34.repoql.bin is honored as the middle
// precedence layer (env REPOQL_BIN > config v34.repoql.bin > built-in default).
// Config is read lazily+cached so this module stays import-light for tests.
let CFG_BIN = undefined;
function configBin() {
  if (CFG_BIN !== undefined) return CFG_BIN;
  try {
    const cfg = JSON.parse(readFileSync(join(process.cwd(), "config.json"), "utf8"));
    CFG_BIN = cfg?.v34?.repoql?.bin ?? null;
  } catch { CFG_BIN = null; }
  return CFG_BIN;
}
const RQL = () => process.env.RQL_BIN ?? configBin() ?? "/usr/local/bin/rql";

// ---- Typed error taxonomy (ticket 094 Phase 2, plan §5.1) ----------------
// Ambiguous codes like EXPLORE_RC_undefined / EXPLORE_RC_1 are GONE from the
// production path: every rql failure maps to exactly one of the plan's minimum
// classifications, carrying diagnostic evidence (stderr excerpt + rc). Unknown
// shapes still classify (UNKNOWN_FAILURE) — never undefined.
export const FAILURE_TAXONOMY = [
  "TIMEOUT", "HOST_UNAVAILABLE", "AUTH_REQUIRED", "AUTH_FAILED",
  "SCOPE_NOT_FOUND", "SCOPE_EMPTY", "INDEX_NOT_READY", "ZERO_RESULTS",
  "REPOQL_UNREACHABLE", "PARSE_FAILED", "READ_FAILED", "MALFORMED_RESPONSE", "POLICY_BLOCKED",
  "CONFIDENTIALITY_BLOCKED", "RATE_LIMITED", "UNKNOWN_FAILURE",
];
export function classifyRqlFailure({ code, rc, err = "", out = "" } = {}) {
  const hay = `${err}\n${out}`.toLowerCase();
  const detail = String(err || out || "").slice(0, 200);
  if (code === "TIMEOUT") return { code: "TIMEOUT", detail, retryable: true };
  if (code === "SPAWN_FAILED") return { code: "HOST_UNAVAILABLE", detail, retryable: true };
  if (/not logged in|login required|device code|run .*account login|authentication required/.test(hay))
    return { code: "AUTH_REQUIRED", detail, retryable: false };
  if (/invalid token|auth.*fail|401|forbidden|expired session/.test(hay))
    return { code: "AUTH_FAILED", detail, retryable: false };
  if (/rate limit|429|too many requests|quota exceeded/.test(hay))
    return { code: "RATE_LIMITED", detail, retryable: true };
  if (/unknown (scope|command)|no such scope|invalid scope|scope.*not.*found/.test(hay))
    return { code: "SCOPE_NOT_FOUND", detail, retryable: false };
  if (/policy|blocked by|disallowed|not permitted/.test(hay))
    return { code: "POLICY_BLOCKED", detail, retryable: false };
  if (/index.*(not.*ready|initializing|building)|reindex.*(required|in progress)/.test(hay))
    return { code: "INDEX_NOT_READY", detail, retryable: true };
  if (/connection refused|econnrefused|could not resolve|unreachable|ssh.*fail|connect.*timeout/.test(hay))
    return { code: "HOST_UNAVAILABLE", detail, retryable: true };
  // Ticket 164 Phase 1 item 13: an explicit typed unreachable code so callers can
  // distinguish "retrieval path down" from "healthy index, zero hits" (ZERO_RESULTS)
  // and from other failures. Emitted by status() when the host is not queryable.
  if (code === "REPOQL_UNREACHABLE") return { code: "REPOQL_UNREACHABLE", detail, retryable: true };
  // Exec-level failure of the rql binary itself (rc 126/127) is the binary/
  // shim being missing or unexecutable → the host is effectively unavailable.
  if (typeof rc === "number" && (rc === 126 || rc === 127)) return { code: "HOST_UNAVAILABLE", detail: `rql exec failed rc=${rc}`, retryable: true };
  if (typeof rc === "number" && rc !== 0) return { code: "UNKNOWN_FAILURE", detail: `rc=${rc} ${detail}`, retryable: false };
  return { code: "UNKNOWN_FAILURE", detail, retryable: false };
}

// Parity scope fallback set (ticket 094 Phase 1): mirrors config/repoql-scopes.json
// (the canonical registry). In the portable export the globs come from
// harness.config.json features.repoql.scopes, so this file names no host or repo.
// Used only when the registry config file is unreadable.
// Precedence: PARITY_SCOPES < registry < caller.
// Portable harness: the fallback scope set is declared in harness.config.json
// (features.repoql.scopes) rather than naming one fleet's published repos.
export const PARITY_SCOPES = { ...HARNESS_PATHS.parityScopes };

// Load scope registry from config file (single source of truth)
let SCOPE_REGISTRY = null;
function loadScopeRegistry() {
  if (SCOPE_REGISTRY) return SCOPE_REGISTRY;
  try {
    const configPath = process.env.REPOQL_SCOPES_CONFIG ??
      join(process.cwd(), "config", "repoql-scopes.json");
    const raw = readFileSync(configPath, "utf8");
    SCOPE_REGISTRY = JSON.parse(raw);
    return SCOPE_REGISTRY;
  } catch (e) {
    // Registry unreadable: the same declarative fallback, never a fleet literal.
    SCOPE_REGISTRY = {
      scopes: Object.fromEntries(
        Object.entries(HARNESS_PATHS.parityScopes).map(([key, uriGlob]) => [key, { name: key, uriGlob, confidentialityClass: "local" }]),
      ),
    };
    return SCOPE_REGISTRY;
  }
}

// The RepoQL host is selected by WORKING DIRECTORY. Running the kit from its
// own checkout therefore addresses a different (project-scoped) host whose
// concept/docs scopes are empty — the 2026-10-23 remediation found every
// concept-backed hook returning INSUFFICIENT for exactly this reason. Query
// the canonical consolidated host explicitly unless the caller overrides it.
function rqlCwd() {
  const override = String(process.env.REPOQL_CWD ?? "").trim();
  if (override) return override;
  // Portable harness: the host cwd is declared once (features.repoql.cwd in
  // harness.config.json). Unset = query from the caller's cwd.
  return HARNESS_PATHS.repoqlCwdCandidate ?? process.cwd();
}

function runRql(args, timeoutMs = DEFAULT_TIMEOUT_MS) {
  return new Promise((resolve) => {
    let settled = false;
    const done = (r) => { if (!settled) { settled = true; resolve(r); } };
    let child;
    try {
      child = spawn(RQL(), args, { stdio: ["ignore", "pipe", "pipe"], cwd: rqlCwd() });
    } catch (e) {
      return done({ ok: false, code: "SPAWN_FAILED", detail: String(e?.message ?? e).slice(0, 120) });
    }
    const timer = setTimeout(() => { try { child.kill("SIGKILL"); } catch {} done({ ok: false, code: "TIMEOUT", detail: "rql " + args[0] + " exceeded " + timeoutMs + "ms" }); }, timeoutMs);
    let out = "", err = "";
    child.stdout?.on?.("data", (d) => { out += d; });
    child.stderr?.on?.("data", (d) => { err += d; });
    child.on("error", (e) => done({ ok: false, code: "SPAWN_FAILED", detail: String(e?.message ?? e).slice(0, 120) }));
    child.on("close", (rc) => { clearTimeout(timer); done({ ok: settled ? undefined : rc === 0, code: settled ? "TIMEOUT" : rc === 0 ? "OK" : "RQL_FAILED", rc, out, err: err.slice(0, 400) }); });
  });
}

// Scheme-aware workspace check for confidential gating (ticket 094 Phase 1).
// Local-class corpora are DEPLOYMENT topology, not product constants: the
// defaults are portable (the container workspace, the docs root, RepoQL state,
// Concepts and the on-disk corpus), and ORCH_LOCAL_CORPUS_PREFIXES adds this
// host's own indexed prefixes as a semicolon-separated list. External imports
// (github://<other-org>) stay OUTSIDE the local class. D13-confidential content
// never lives in any of these (confidential runs are suppressed).
const DEFAULT_LOCAL_CORPUS_PREFIXES = ["freebuff/workspace/", "documentation/", ".mex/", "elderpoints/"];
function localCorpusPrefixes() {
  const raw = String(process.env.ORCH_LOCAL_CORPUS_PREFIXES ?? "").trim();
  const extra = raw ? raw.split(";").map((s) => s.trim()).filter(Boolean) : [];
  return [...DEFAULT_LOCAL_CORPUS_PREFIXES, ...extra];
}
function isWorkspacePath(uriOrGlob) {
  const raw = String(uriOrGlob ?? "");
  if (/^concept:\/\//.test(raw)) return true;
  const p = raw.replace(/^\w+:\/\//, "").replace(/^\/+/, "").replace(/^(\*\*\/)+/, "");
  if (/(^|\/)\.repoql(-imports)?(\/|$)/.test(p)) return true;
  return localCorpusPrefixes().some((prefix) => p.startsWith(prefix));
}

// Convert a scope uriGlob to a SQL LIKE pattern for count queries (scopeHealth).
// Scheme prefixes are kept verbatim; schemeless globs get a leading % wildcard.
export function globToLike(glob) {
  const m = String(glob ?? "").match(/^(\w+:\/\/)(.*)$/);
  const prefix = m ? m[1] : "%";
  const body = (m ? m[2] : String(glob ?? "")).split("**").join("%").split("*").join("%").split("?").join("_");
  return prefix + body;
}

export function createRepoqlClient({ timeoutMs, confidential = false, scopes = null } = {}) {
  // Per-client bounded explore cache + in-flight dedupe (advisory only).
  const exploreCache = new Map();
  const exploreInflight = new Map();
  // Hints are deterministic glob matches, so the same key is always safe to
  // reuse; keyed like explore (binary + host cwd + every request argument).
  const hintsCache = new Map();
  // `read => concepts` is resolved once per (scope, budget) for the life of the
  // client: Sol's contract is one call per edit batch, reused until the scope
  // changes. Keyed on binary + host cwd + exact scope + budget.
  const applicabilityCache = new Map();
  // Timeout resolution (plan §5.6): per-op bounds govern production; an
  // explicitly-passed constructor timeoutMs acts as a CAP (tests can shorten,
  // never silently lengthen past the op bound).
  const cap = typeof timeoutMs === "number" && timeoutMs > 0 ? timeoutMs : null;
  const opT = (op) => (cap != null ? Math.min(cap, OP_TIMEOUTS[op]) : OP_TIMEOUTS[op]);
  const registry = loadScopeRegistry();
  const regGlobs = {};
  for (const [key, val] of Object.entries(registry.scopes ?? {})) {
    regGlobs[key] = val.uriGlob;
  }
  // Merge: built-in parity defaults < config registry < caller-supplied scopes.
  const merged = { ...PARITY_SCOPES, ...regGlobs, ...(scopes && typeof scopes === "object" ? scopes : {}) };
  const scopeMap = merged;

  // Evidence identity (ticket 094 Phase 2, plan §5.10): every RepoQL result
  // entering a gated stage carries enough identity to trace it. No new
  // mechanism where the context pack already provides one — the manifest IS
  // the identity record; these fields ride inside each result + the manifest.
  const evidenceIdentity = () => ({
    host: process.env.REPOQL_HOST_ID ?? "repoql-local",
    mode: confidential ? "local-only" : "local",
    scopeRegistryVersion: registry.version ?? null,
    capturedAt: new Date().toISOString(),
  });

  // Ticket 164 Phase 1 item 13: typed agent-issue emission on ACTUAL connectivity
  // failure (REPOQL_UNREACHABLE / HOST_UNAVAILABLE / TIMEOUT on status). Deduped
  // per client instance; fail-open (an issue-log write failure never breaks
  // retrieval); reuses lib/agent-issues.mjs — no new store.
  let reachIssueLogged = false;
  async function logUnreachable(code, detail) {
    if (reachIssueLogged || process.env.REPOQL_REACH_ISSUES === "0") return;
    reachIssueLogged = true;
    try {
      const { logAgentIssue } = await import("./agent-issues.mjs");
      logAgentIssue(join(process.cwd(), "runs"), {
        kind: "REPOQL_UNREACHABLE",
        severity: "error",
        agent: "coordinator",
        engine: "repoql",
        source: "repoql-client",
        summary: `RepoQL retrieval unavailable (${code}): ${String(detail ?? "").slice(0, 140)}`,
        detail: `Typed reachability failure from lib/repoql-client.mjs status(). Retrieval degrades per v34.repoqlPrimary fallback (QMD/direct). code=${code} at=${new Date().toISOString()}`,
      });
    } catch { /* fail-open */ }
  }

  return {
    mode: confidential ? "local-only" : "local",

    // Deterministic concept-hint channel (Sol 2026-10-24, step 2 prototype).
    //
    // `rql concept hints <target>` matches each capsule's relevance globs for a
    // path that is ABOUT TO BE WRITTEN and is bounded natively (--limit). It is
    // the cheap first stage of the approved two-stage design: measured 77-89 ms
    // against 3.9-4.4 s for `explore` on the same corpus.
    //
    // Contract (Sol, same ruling): this is NAVIGATION evidence only. The
    // status is DIGEST_HINT_ONLY, never SEMANTIC_VERIFIED, because a capsule's
    // `invariant` text cannot stand in for a semantic decision result. A caller
    // that needs decision-grade evidence must escalate to query(); an empty
    // hint set is ZERO_RESULTS, never a silent "no concepts apply".
    async conceptHints({ target, limit = 5, session = null, timeoutMs = null } = {}) {
      if (!target || typeof target !== "string") return { ok: false, code: "INVALID_TARGET" };
      const sess = String(session ?? process.env.REPOQL_SESSION_ID ?? process.env.ORCH_SESSION_ID ?? "orchestra-kit");
      const lim = Math.max(1, Math.min(20, Number(limit) || 5));
      const key = [RQL(), rqlCwd(), target, String(lim), sess].join("\u0000");
      const hit = (() => {
        const e = hintsCache.get(key);
        if (!e) return null;
        if (Date.now() - e.at > EXPLORE_CACHE_MS) { hintsCache.delete(key); return null; }
        return e.value;
      })();
      if (hit) return hit;
      const r = await runRql(
        ["concept", "hints", target, "--limit", String(lim), "--session", sess, "--json"],
        timeoutMs ? Math.min(timeoutMs, opT("hints")) : opT("hints"),
      );
      if (!r.ok) {
        const t = classifyRqlFailure({ code: r.code, rc: r.rc, err: r.err, out: r.out });
        return { ok: false, code: t.code, retryable: t.retryable, detail: t.detail };
      }
      let doc = null;
      try { doc = JSON.parse(String(r.out ?? "")); } catch { doc = null; }
      if (!doc || !Array.isArray(doc.concepts)) {
        return { ok: false, code: "MALFORMED_RESULT", retryable: true, detail: "concept hints returned no concepts array" };
      }
      // Scope isolation: the channel is concept-only. A hint pointing anywhere
      // else would be cross-scope evidence and is dropped, not silently kept.
      const results = doc.concepts
        .filter((c) => typeof c?.uri === "string" && c.uri.startsWith("concept://"))
        .slice(0, lim)
        .map((c) => ({
          uri: c.uri,
          headline: String(c.invariant ?? "").slice(0, 400),
          why: String(c.why ?? "").slice(0, 400),
        }));
      const value = {
        ok: true,
        status: results.length ? "DIGEST_HINT_ONLY" : "ZERO_RESULTS",
        navigationOnly: true,
        targetUri: doc.targetUri ?? null,
        results,
        mode: confidential ? "local-only" : "local",
        evidence: evidenceIdentity(),
      };
      hintsCache.set(key, { at: Date.now(), value });
      while (hintsCache.size > EXPLORE_CACHE_MAX) hintsCache.delete(hintsCache.keys().next().value);
      return value;
    },

    // Applicability through the documented `concepts` view (Sol 2026-10-24,
    // website docs /docs/tools/read/). `read <scope> => concepts` returns the
    // concepts that apply to the addressed files and, in the measured 1.7.15
    // footer, separates the narrow matches from the universally applicable
    // ones — the distinction `concept hints` cannot express.
    //
    // Contract: one call per edit batch, reused for the same scope. The caller
    // passes the files it is about to change (an address or `;`-joined list).
    // The result is navigation + identity, NOT proof: a caller that needs to act
    // on a capsule still reads it for evidence.
    async conceptApplicability({ scope, budget = null, timeoutMs = null } = {}) {
      const address = String(scope ?? "").trim();
      if (!address) return { ok: false, code: "INVALID_SCOPE" };
      if (confidential && !isWorkspacePath(address)) {
        return { ok: false, code: "CONFIDENTIALITY_BLOCKED", detail: "confidential runs resolve applicability in local workspace scopes only", retryable: false };
      }
      const cap = budget ? _posInt(budget, BUDGETS.read) : BUDGETS.read;
      const key = [RQL(), rqlCwd(), address, String(cap)].join("\u0000");
      const hit = applicabilityCache.get(key);
      if (hit) { metric({ op: "applicability", cacheHit: true, ms: 0, status: hit.status, shown: hit.results?.length ?? 0 }); return hit; }
      const _t0 = Date.now();
      // NOT --json here: measured 2026-10-24, `read … => concepts --json` returns
      // only the summary {totalConcepts, narrowShown, universalApplicable} with
      // no URIs, so the channel would have nothing to cite. The rendered form
      // carries the URIs and the same footer counts, and is what this parses.
      const r = await runRql(
        ["read", `${address} => concepts`, "--token-budget", String(cap)],
        timeoutMs ? Math.min(timeoutMs, opT("concepts")) : opT("concepts"),
      );
      if (!r.ok) {
        const t = classifyRqlFailure({ code: r.code, rc: r.rc, err: r.err, out: r.out });
        if (t.code === "UNKNOWN_FAILURE") t.code = "CONCEPTS_READ_FAILED";
        return { ok: false, code: t.code, retryable: t.retryable, detail: t.detail };
      }
      const out = String(r.out ?? "");
      // One URI per returned concept, at the start of its rendered block. The
      // trailing "(N files)" and the capsule body that follows are not identity.
      const uris = [];
      for (const line of out.split("\n")) {
        const m = line.match(/^\s*(concept:\/\/\/[^\s(]+)/);
        if (m) uris.push(m[1]);
      }
      const unique = [...new Set(uris)];
      // The footer is a diagnostic and rql writes diagnostics to stderr: the
      // rendered body on stdout ends at the capsule text. Parse both, so the
      // narrow/universal split is captured whichever stream carries it.
      const diag = `${out}\n${String(r.err ?? "")}`;
      const footer = (diag.match(/concepts:\s*\d+\s*total[^\n\]]*/i)?.[0] ?? "").trim() || null;
      const universalMatch = diag.match(/universal applicable\s+(\d+)/i);
      const narrowMatch = diag.match(/narrow shown\s+(\d+)/i);
      const totalMatch = diag.match(/concepts:\s*(\d+)\s*total/i);
      const value = {
        ok: true,
        status: unique.length ? "CONCEPTS_APPLICABLE" : "ZERO_RESULTS",
        results: unique.map((uri) => ({ uri })),
        total: totalMatch ? Number(totalMatch[1]) : unique.length,
        universalApplicable: universalMatch ? Number(universalMatch[1]) : null,
        narrowShown: narrowMatch ? Number(narrowMatch[1]) : null,
        footer,
        truncated: /all shown/i.test(out) ? false : null,
        mode: confidential ? "local-only" : "local",
        evidence: evidenceIdentity(),
      };
      applicabilityCache.set(key, value);
      metric({ op: "applicability", cacheHit: false, ms: Date.now() - _t0, status: value.status, shown: value.results.length, narrow: value.narrowShown, universal: value.universalApplicable });
      return value;
    },

    // Deterministic concept inventory (Sol 2026-10-24): `Files` + matches_glob,
    // ordered, over `--jsonl` so nothing is silently truncated by the token
    // budget. This is a catalogue, not applicability — it answers "what concepts
    // exist in this category", never "which apply here".
    async conceptInventory({ category = null, limit = 200, cacheSeconds = 60, timeoutMs = null } = {}) {
      const cat = category ? String(category).replace(/[^a-z]/gi, "") : null;
      if (category && !["rule", "wisdom", "knowledge", "principle", "shape"].includes(cat)) {
        return { ok: false, code: "INVALID_CATEGORY" };
      }
      // `concept:///**/<cat>/**` spans the local corpus and imported concept
      // trees (concept:///github/owner/repo/<cat>/...), which is why the local
      // 473 and the indexed 551 differ.
      const pattern = cat ? `concept:///**/${cat}/**` : "concept:///**";
      const sql = `SELECT uri FROM Files WHERE matches_glob(uri, '${pattern}') ORDER BY uri`;
      const _t0 = Date.now();
      const args = ["query", sql, "--jsonl"];
      if (cacheSeconds > 0) args.push("--cache-seconds", String(cacheSeconds));
      const r = await runRql(args, timeoutMs ? Math.min(timeoutMs, opT("query")) : opT("query"));
      if (!r.ok) {
        const t = classifyRqlFailure({ code: r.code, rc: r.rc, err: r.err, out: r.out });
        return { ok: false, code: t.code, retryable: t.retryable, detail: t.detail };
      }
      const uris = [];
      for (const line of String(r.out ?? "").split("\n")) {
        const t = line.trim();
        if (!t.startsWith("{")) continue;
        try { const j = JSON.parse(t); if (typeof j?.uri === "string") uris.push(j.uri); } catch { /* skip */ }
      }
      const rows = uris.slice(0, Math.max(1, Number(limit) || 200));
      metric({ op: "inventory", category: cat, ms: Date.now() - _t0, count: uris.length, cacheSeconds });
      return {
        ok: true,
        status: uris.length ? "INVENTORY" : "ZERO_RESULTS",
        category: cat,
        pattern,
        count: uris.length,
        results: rows.map((uri) => ({ uri })),
        truncated: uris.length > rows.length,
        evidence: evidenceIdentity(),
      };
    },

    // Host readiness (typed: TIMEOUT | HOST_UNAVAILABLE | AUTH_* | ...)
    //
    // Readiness is NOT a single word. The installed CLI has three observable
    // states: `ready · …` (fully built), `usable, indexing|embedding · …`
    // (queryable now, index still catching up) and a not-queryable state.
    // The old text-regex treated everything except `ready` as
    // REPOQL_UNREACHABLE, so a healthy host during a routine sweep was reported
    // as down while its queries in the same process succeeded (2026-10-24).
    // Prefer `--json`, which states queryable/searchable/ready separately; the
    // text form is kept as a fallback for CLIs without it.
    async status() {
      const r = await runRql(["host", "status", "--json"], opT("status"));
      if (!r.ok) {
        const t = classifyRqlFailure({ code: r.code, rc: r.rc, err: r.err, out: r.out });
        if (t.code === "UNKNOWN_FAILURE" && typeof r.rc === "number" && r.rc !== 0) t.detail = `host status rc=${r.rc} ${t.detail}`.slice(0, 200);
        if (t.code === "HOST_UNAVAILABLE" || t.code === "TIMEOUT") await logUnreachable(t.code, t.detail);
        return { ok: false, code: t.code, retryable: t.retryable, detail: t.detail };
      }
      const out = String(r.out ?? "");
      let doc = null;
      try { doc = JSON.parse(out); } catch { doc = null; }
      if (doc && typeof doc === "object") {
        const queryable = doc.queryable === true;
        const searchable = doc.searchable !== false;
        const ready = doc.ready === true;
        if (!queryable) {
          await logUnreachable("REPOQL_UNREACHABLE", "host reachable but queryable=false");
          return { ok: false, code: "REPOQL_UNREACHABLE", detail: "host reachable but queryable=false", retryable: true, ready: false, fidelity: doc.fidelity ?? null, raw: out.slice(0, 400) };
        }
        // Usable now, still indexing: success + explicit degraded fidelity so a
        // caller can prefer lexical/structural channels; semanticPercent and
        // pendingFiles are carried rather than guessed.
        return { ok: searchable, ready, queryable, degraded: !ready, fidelity: doc.fidelity ?? null,
          pendingFiles: doc.pendingFiles ?? null, semanticPercent: doc.semanticPercent ?? null,
          account: doc.account ?? null, raw: out.slice(0, 400) };
      }
      // Text fallback (older CLI).
      const ready = /queryable=true/i.test(out) || /^ready\b/im.test(out);
      const usable = /^usable\b/im.test(out);
      const account = (out.match(/Account:\s*([^\n]*)/)?.[1] ?? "").trim();
      if (/not logged in|login required|device code/i.test(out)) return { ok: false, code: "AUTH_REQUIRED", detail: "host reports no session", retryable: false };
      if (!ready && !usable) { await logUnreachable("REPOQL_UNREACHABLE", "host reachable but queryable=false"); return { ok: false, code: "REPOQL_UNREACHABLE", detail: "host reachable but queryable=false", retryable: true, raw: out.slice(0, 400) }; }
      return { ok: true, ready, usable, degraded: !ready, account: account.startsWith("not ") ? null : account, raw: out.slice(0, 400) };
    },

    // Semantic/lexical search over a scope (typed failures; ZERO_RESULTS vs
    // SCOPE_EMPTY are distinct per plan §5.2 — a healthy search returning
    // nothing is NOT the same event as a broken scope).
    async query({ q, scope = "mex-history", limit = 6, timeoutMs = null }) {
      if (!q || typeof q !== "string") return { ok: false, code: "INVALID_QUERY" };
      const _t0 = Date.now();
      // Effective deadline for this call: the caller's budget capped by the op
      // budget. Recorded on every metric row so a censored 30 s op cap and a
      // 12 s hook deadline are distinguishable in the ledger (Sol 2026-10-24).
      const _deadlineMs = timeoutMs ? Math.min(timeoutMs, opT("explore")) : opT("explore");
      let _cacheHits = 0;
      const glob = scopeMap[scope] ?? (typeof scope === "string" && scope.includes("**") ? scope : null);
      if (!glob) return { ok: false, code: "SCOPE_NOT_FOUND", detail: `no such scope in registry: ${String(scope).slice(0, 40)}` };
      if (confidential && !isWorkspacePath(glob)) {
        return { ok: false, code: "CONFIDENTIALITY_BLOCKED", detail: "confidential runs search local workspace scopes only", retryable: false };
      }
      // Brace-alternative globs ({a/**,b/**}) were expanded client-side because
      // an older CLI rejected them. RepoQL 1.7.15 parses them natively (measured
      // 2026-10-24: `concept:///{rule,shape,knowledge,wisdom}/**` returned rows in
      // one call, 4.3 s, versus paying a second explore per alternative). Native
      // is the default now; ORCH_REPOQL_NATIVE_BRACES=0 restores the expansion
      // fallback without a code change.
      const _g = String(glob).trim();
      const nativeBraces = process.env.ORCH_REPOQL_NATIVE_BRACES !== "0";
      const alternatives = !nativeBraces && _g.includes("{") && _g.endsWith("}")
        ? _g.slice(_g.indexOf("{") + 1, _g.lastIndexOf("}")).split(",").map((s) => _g.slice(0, _g.indexOf("{")) + s.trim())
        : [glob];
      const merged = [];
      for (const g of alternatives) {
        // Key carries host identity and the exact scope glob, so two scopes can
        // never share an entry (Sol: a TTL does not fix a bad cache key).
        // Sol 2026-10-24: the identity must cover EVERY variable retrieval
        // argument, not just glob/query/limit/budget. breadth and question are
        // pinned today, but they are part of the request, so they belong in the
        // key before any second configuration runs against this cache.
        // Sol 2026-10-24 (website docs): "Breadth ... isn't a result count.
        // Leave it on automatic unless you need to steer it." The pin to 1 was
        // ours, not the vendor's; automatic is adopted and measured by the
        // concept gate (case 9) plus the perf contract. ORCH_REPOQL_BREADTH
        // restores a fixed dial for a reproducible A/B.
        const REQUEST_BREADTH = String(_posInt(process.env.ORCH_REPOQL_BREADTH, 0));
        const REQUEST_QUESTION = ""; // O3: reranker dropped (see below)
        const key = [RQL(), rqlCwd(), g, q, String(limit), String(BUDGETS.explore), `b:${REQUEST_BREADTH}`, `q:${REQUEST_QUESTION}`].join("\u0000");
        const hit = (() => {
          const e = exploreCache.get(key);
          if (!e) return null;
          if (Date.now() - e.at > EXPLORE_CACHE_MS) { exploreCache.delete(key); return null; }
          return e.value;
        })();
        if (hit) { _cacheHits++; merged.push(...hit); if (merged.length >= limit) break; continue; }
        let results;
        const prior = exploreInflight.get(key);
        if (prior) {
          // Concurrent identical call shares one subprocess. A rejected shared
          // promise must return the SAME typed failure, not escape as a throw.
          try { results = await prior; } catch (e) { if (e?.rql) return e.rql; throw e; }
        } else {
          const work = (async () => {
            // A hook deadline is passed down as the child timeout so a timed-out
            // channel kills its `rql` process instead of leaving it running.
            // O3 (Sol 2026-10-24, validated A/B 2026-10-24): `--question` was
            // fed the SAME text as the keywords, so the reranker added ~1.3-2.5 s
            // for no new information. Two real queries returned IDENTICAL top-5
            // URIs with and without it (5.3 s -> 3.9 s; 6.9 s -> 4.4 s). Token
            // budget stays 900: 300 was not consistently faster and changed
            // nothing about the top results, so there is no evidence for it.
            const r = await runRql(["explore", q, "--uri-glob", g, "--breadth", REQUEST_BREADTH, "--jsonl", "--token-budget", String(BUDGETS.explore)], _deadlineMs);
            if (!r.ok) {
              const t = classifyRqlFailure({ code: r.code, rc: r.rc, err: r.err, out: r.out });
              // Sol 2026-10-24: without this, a timeout is invisible in the
              // ledger (the row was only written on success), so a censored p95
              // looked like a clean distribution. Failures are rows too.
              metric({ op: "explore", glob: g, qHash: queryHash(q), qLen: q.length, limit, ms: Date.now() - _t0, ok: false, code: t.code, deadlineMs: _deadlineMs, callerDeadlineMs: timeoutMs ?? null });
              const err = new Error(t.code);
              err.rql = { ok: false, code: t.code, retryable: t.retryable, detail: t.detail };
              throw err;
            }
            const out = [];
            for (const line of String(r.out ?? "").split("\n")) {
              const t = line.trim();
              if (!t.startsWith("{")) continue;
              let j = null; try { j = JSON.parse(t); } catch { continue; }
              if (!j?.uri) continue;
              // Complex scopes ({a,b}, `;` unions, `!` exclusions) are parsed by
              // the CLI but not by uriMatch, which would filter every row out of
              // a native brace scope (measured: 0 rows on a scope the CLI served).
              // For those, enforce scope isolation against the static prefix
              // before the first brace/join/exclusion instead.
              const complex = /[{};!]/.test(g);
              if (complex) {
                const base = g.split(/[{};!]/)[0].replace(/\*+$/, "");
                if (base && !j.uri.startsWith(base)) continue;
              } else if (g && !uriMatch(j.uri, g)) continue;
              out.push({ uri: j.uri, score: typeof j.score === "number" ? j.score : null, headline: String(j.headline ?? "").slice(0, 160) });
              if (out.length >= limit) break;
            }
            if (EXPLORE_CACHE_MS > 0) {
              exploreCache.set(key, { at: Date.now(), value: out });
              while (exploreCache.size > EXPLORE_CACHE_MAX) exploreCache.delete(exploreCache.keys().next().value);
            }
            return out;
          })();
          exploreInflight.set(key, work);
          try { results = await work; } catch (e) { if (e?.rql) return e.rql; throw e; } finally { exploreInflight.delete(key); }
        }
        merged.push(...results);
        if (merged.length >= limit) break;
      }
      // Evidence identity rides on every result set (plan §5.10).
      merged.sort((a, b) => (b.score ?? -Infinity) - (a.score ?? -Infinity));
      metric({ op: "explore", glob: glob, qHash: queryHash(q), qLen: q.length, limit, cacheHits: _cacheHits, results: merged.length, ms: Date.now() - _t0, ok: true, deadlineMs: _deadlineMs, callerDeadlineMs: timeoutMs ?? null });
      return { ok: true, results: merged.slice(0, limit), mode: confidential ? "local-only" : "local", evidence: evidenceIdentity() };
    },

    // Structured source read (typed failures + evidence identity)
    async get({ uri, maxBytes = 2500 }) {
      if (!uri) return { ok: false, code: "INVALID_URI" };
      if (confidential && !isWorkspacePath(uri)) {
        return { ok: false, code: "CONFIDENTIALITY_BLOCKED", detail: "confidential runs read local workspace URIs only", retryable: false };
      }
      // V3.5.7 P2: response capped via --token-budget (BUDGETS.read); the
      // maxBytes slice below stays as the second bound.
      const r = await runRql(["read", uri + " => content", "--token-budget", String(BUDGETS.read)], opT("read"));
      if (!r.ok) {
        const t = classifyRqlFailure({ code: r.code, rc: r.rc, err: r.err, out: r.out });
        if (t.code === "UNKNOWN_FAILURE") t.code = "READ_FAILED"; // read-op shape keeps a specific code (plan §5.1)
        return { ok: false, code: t.code, retryable: t.retryable, detail: t.detail };
      }
      return { ok: true, content: String(r.out ?? "").slice(0, maxBytes), evidence: evidenceIdentity() };
    },

  // Scope registry introspection
  getScopes() {
    return scopeMap;
  },

  // Typed scope health (ticket 094 Phase 1 §4.8): scope state is DISTINCT from
  // query result state. QUERY_OK_NO_RESULTS must never be conflated with a
  // broken/empty scope. Uses SQL counts over the live index + sentinel file
  // presence. Read-only. Never throws.
  async scopeHealth(scopeName) {
    const glob = scopeMap[scopeName];
    if (!glob) return { scope: scopeName, state: "SCOPE_NOT_FOUND" };
    // Brace-alternative globs: sum counts across alternatives (ticket 164 Ph4).
    const _g = String(glob).trim();
    const alts = _g.includes("{") && _g.endsWith("}")
      ? _g.slice(_g.indexOf("{") + 1, _g.lastIndexOf("}")).split(",").map((s) => _g.slice(0, _g.indexOf("{")) + s.trim())
      : [glob];
    let like = globToLike(alts[0]);
    let sql = "SELECT count(*) FROM files WHERE uri LIKE '" + like + "'"; // NOTE (P5, docs gotcha): this LIKE is SAFE only because globToLike() converts globs; hand-written SQL must use matches_glob(uri, 'glob/**') — LIKE with raw globs silently matches nothing
    for (let i = 1; i < alts.length; i++) sql += " OR uri LIKE '" + globToLike(alts[i]) + "'";
    const c = await runRql(["query", sql], opT("query"));
    if (!c.ok) {
      const t = classifyRqlFailure({ code: c.code, rc: c.rc, err: c.err, out: c.out });
      const state = t.code === "TIMEOUT" ? "TIMEOUT" : (t.code === "AUTH_REQUIRED" || t.code === "AUTH_FAILED" ? t.code : "INDEX_NOT_READY");
      return { scope: scopeName, state, detail: t.detail };
    }
    let n = -1;
    const m = String(c.out ?? "").match(/^(\d+)/m);
    if (m) n = parseInt(m[1], 10);
    if (n === 0) return { scope: scopeName, state: "SCOPE_EMPTY", count: 0, glob };
    const entry = (loadScopeRegistry().scopes ?? {})[scopeName] ?? {};
    const min = typeof entry.sentinelMinCount === "number" ? entry.sentinelMinCount : 1;
    const sents = Array.isArray(entry.sentinels) ? entry.sentinels : [];
    const missing = [];
    for (const s of sents) {
      const g = await runRql(["query", `SELECT count(*) FROM files WHERE uri = '${s}'`], timeoutMs);
      const mm = String(g.out ?? "").match(/^(\d+)/m);
      if (!g.ok || !mm || parseInt(mm[1], 10) < 1) missing.push(s);
    }
    if (n < min) missing.push(`index-count ${n} < sentinelMinCount ${min}`);
    if (missing.length) return { scope: scopeName, state: "SCOPE_INDEX_NOT_READY", count: n, missing, glob };
    return { scope: scopeName, state: "SCOPE_OK", count: n, glob };
  },

  // Preflight (plan §4.9): validate registry syntax + host readiness + scope
  // health for the given stage (or all scopes when stage omitted). Never gates
  // startup on corpus health — returns a report; callers decide degradation.
  async preflight(stage = null) {
    const report = { at: new Date().toISOString(), stage, registry: "ok", host: null, scopes: [], degradation: [] };
    try { loadScopeRegistry(); } catch (e) { report.registry = "INVALID: " + String(e?.message ?? e).slice(0, 80); }
    const st = await this.status();
    report.host = st.ok && st.ready ? "ready" : (st.ok ? "degraded" : "unavailable");
    if (report.host !== "ready") report.degradation.push({ scope: "*", level: "optional", reason: `repoql host ${report.host}: all repoql retrieval degrades to QMD/direct fallback (typed: ${st.code ?? "n/a"})` });
    const entry = loadScopeRegistry().scopes ?? {};
    const names = Object.keys(entry).filter((k) => !stage || !(entry[k].requiredFor ?? []).length || (entry[k].requiredFor ?? []).includes(stage));
    for (const k of names) {
      const h = await this.scopeHealth(k);
      report.scopes.push(h);
      // Plan §4.9: a missing OPTIONAL scope degrades that path only; a MISSING
      // MANDATORY scope is the caller's stage-failure signal (reported, not
      // thrown — preflight never gates startup on corpus health).
      const required = (entry[k].requiredFor ?? []).length > 0;
      if (h.state !== "SCOPE_OK") report.degradation.push({ scope: k, level: required ? "mandatory" : "optional", state: h.state });
    }
    return report;
  },

  // ---- Ticket 094 Phase 2 + Phase 5 additions --------------------------

  // List the live URIs a scope currently resolves to (plan §5.3 stage-aware
  // retrieval consumers, Phase 4 expected-source grounding). Bounded.
  async scopeFiles(scopeName, limit = 10) {
    const glob = scopeMap[scopeName];
    if (!glob) return { ok: false, code: "SCOPE_NOT_FOUND" };
    const like = globToLike(glob);
    const r = await runRql(["query", `SELECT uri FROM files WHERE uri LIKE '${like}' LIMIT ${Math.max(1, Math.min(50, limit | 0))}`], opT("query"));
    if (!r.ok) { const t = classifyRqlFailure({ code: r.code, rc: r.rc, err: r.err, out: r.out }); return { ok: false, code: t.code, detail: t.detail }; }
    const uris = String(r.out ?? "").split("\n").map((s) => s.trim()).filter((s) => s.includes("://"));
    return { ok: true, scope: scopeName, uris };
  },

  // Concept corpus health (plan Phase 5 pre-cutover requirements): queryable,
  // minimum present, TTL-expired knowledge VISIBLE (never silently presented
  // as verified current truth). Read-only, never throws.
  async conceptHealth({ minCount = 1 } = {}) {    const c = await runRql(["query", "SELECT count(*) FROM files WHERE uri LIKE 'concept://%'"] , opT("query"));
    if (!c.ok) { const t = classifyRqlFailure({ code: c.code, rc: c.rc, err: c.err, out: c.out }); return { ok: false, state: t.code === "TIMEOUT" ? "TIMEOUT" : "INDEX_NOT_READY", detail: t.detail }; }
    const n = parseInt((String(c.out ?? "").match(/^(\d+)/m) ?? [])[1] ?? "-1", 10);
    if (n < 0) return { ok: false, state: "MALFORMED_RESPONSE", detail: "concept count unparseable" };
    if (n === 0) return { ok: false, state: "SCOPE_EMPTY", count: 0 };    const q = await runRql(["explore", "consult lane occupancy", "--uri-glob", scopeMap["concepts"] ?? "concept:///", "--jsonl", ...cacheArgs()], opT("explore"));
    const queryable = q.ok;
    return { ok: true, state: n >= minCount ? "CONCEPTS_OK" : "SCOPE_INDEX_NOT_READY", count: n, queryable, minCount, note: "knowledge TTL revalidation is enforced at capture/acceptance, not at index level (rql exposes no TTL column)" };
  },

    // Validate a scope exists and return its metadata
    getScopeInfo(scopeName) {
      return registry.scopes[scopeName] ?? null;
    },

    // List scopes required for a given stage
    getScopesForStage(stage) {
      const result = {};
      for (const [key, val] of Object.entries(registry.scopes)) {
        if (val.requiredFor?.includes(stage)) {
          result[key] = val;
        }
      }
      return result;
    },
  };
}

// Minimal glob match for URIs
export function uriMatch(uri, glob) {
  const strip = (s) => String(s ?? "").replace(/^\w+:\/\//, "").replace(/^\/+/, "");
  const gp = strip(glob).split("/"), up = strip(uri).split("/");
  let gi = 0;
  for (let ui = 0; ui < up.length; ui++) {
    if (gp[gi] === "**") {
      if (gi === gp.length - 1) return true;
      for (let j = ui; j < up.length; j++) {
        if (segMatchFrom(gp, gi + 1, up, j)) return true;
      }
      return segMatchFrom(gp, gi + 1, up, ui);
    }
    if (gi >= gp.length || !segMatch(gp[gi], up[ui])) return false;
    gi++;
  }
  return gi === gp.length || (gp[gi] === "**");
}

function segMatchFrom(gp, gi, up, ui) {
  for (; gi < gp.length && ui < up.length; gi++, ui++) {
    if (gp[gi] === "**") return uriMatchTail(gp, gi, up, ui);
    if (!segMatch(gp[gi], up[ui])) return false;
  }
  return gi === gp.length && ui === up.length;
}
function uriMatchTail(gp, gi, up, ui) {
  if (gi === gp.length - 1) return true;
  return segMatchFrom(gp, gi + 1, up, ui);
}
function segMatch(g, s) {
  if (g === "*") return s.length > 0;
  if (!g.includes("*")) return g === s;
  const re = new RegExp("^" + g.split("*").map((x) => x.replace(/[.+?^${}()|[\]\\]/g, "\\$&")).join(".*") + "$");
  return re.test(s);
}

// Export the registry loader for tests
export { loadScopeRegistry };
