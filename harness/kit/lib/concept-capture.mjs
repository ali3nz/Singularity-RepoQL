// lib/concept-capture.mjs — V3.4.3 ticket 094 (Sol FIX PLAN item 5 + plan §14/§15):
// the GATED Concept publisher. Workers may only emit candidates (existing
// lib/memory-learning.mjs candidate schema); this module is the ONLY path that
// runs `rql concept add`. Ordering per Sol verdict (inviolable):
//   candidate -> duplicate check -> ops.jsonl intent (fsync) ->
//   rql concept add -> reconcile unknown outcomes (never blind retry) ->
//   stable-bytes sha256 receipt -> digest returned for acceptance-subject
//   binding -> fact-check/TTL completes BEFORE final acceptance.
// A later content change to the Concept file invalidates the acceptance
// subject exactly like any other accepted artifact (existing verify flow).
import { spawn, execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { journalIntent, journalComplete, requestDigestOf, readJournal } from "./case-store.mjs";
import { loadTombstones, evaluateTombstones, claimIsRejected, TOMBSTONES_DIR_DEFAULT } from "./memory-tombstone.mjs"; // ticket 191: rejected-value enforcement
import { captureLineageGate, recordDerivation, resolveLineageDir } from "./memory-lineage.mjs"; // ticket 305: provenance capture (plan §6); ticket 339 phase 0: config-backed lineage dir default

const RQL = () => process.env.RQL_BIN ?? "rql"; // read per-call: tests redirect after import
const DEFAULT_TIMEOUT_MS = 15000;
// MIGRATED 2026-09-26: the freebuff-container RepoQL host is decommissioned;
// concepts now land in the ONE consolidated host's concepts dir on controller.
// This container has no local mount of that path, so the tree walk below is
// SSH-backed (see listConceptFilesRemote/readConceptFileRemote) whenever
// conceptsDir doesn't exist locally — tests that pass a local tmp dir are
// unaffected (existsSync short-circuits to the plain local-fs path).
const CONCEPTS_DIR_DEFAULT = "/opt/harness-unset/.repoql/concepts";
const CONCEPTS_SSH_HOST = "controller";

function isRemoteConceptsDir(dir) {
  return !existsSync(dir);
}

function listConceptFilesRemote(dir) {
  try {
    // Quote the -name pattern INSIDE the remote command: unquoted, ssh argv
    // delivers `*.md` to the remote shell, which glob-expands it against
    // controller's CWD (live 2026-10-01: `find: paths must precede
    // expression` + phantom capsule paths — hard-dedupe was silently blind
    // in this state; same-session fix as memory-tombstone.listRemote).
    const out = execFileSync("ssh", [CONCEPTS_SSH_HOST, `find '${dir.replace(/'/g, "'\\''")}' -maxdepth 4 -type f -name '*.md'`], { encoding: "utf8", timeout: 8000 });
    return out.split("\n").map((s) => s.trim()).filter(Boolean);
  } catch { return []; }
}

function readConceptFileRemote(path) {
  try {
    return execFileSync("ssh", [CONCEPTS_SSH_HOST, "cat", path], { encoding: "utf8", timeout: 8000 });
  } catch { return null; }
}

function runRql(args, timeoutMs = DEFAULT_TIMEOUT_MS) {
  return new Promise((resolve) => {
    let settled = false;
    const done = (r) => { if (!settled) { settled = true; resolve(r); } };
    let child;
    try {
      child = spawn(RQL(), args, { stdio: ["ignore", "pipe", "pipe"] });
    } catch (e) {
      return done({ ok: false, code: "SPAWN_FAILED", detail: String(e?.message ?? e).slice(0, 120) });
    }
    const timer = setTimeout(() => { try { child.kill("SIGKILL"); done({ ok: false, code: "TIMEOUT", detail: `rql ${args[0]} ${args[1] ?? ""} exceeded ${timeoutMs}ms` }); } catch {} }, timeoutMs);
    let out = "", err = "";
    child.stdout?.on?.("data", (d) => { out += d; });
    child.stderr?.on?.("data", (d) => { err += d; });
    child.on("error", (e) => { clearTimeout(timer); done({ ok: false, code: "SPAWN_FAILED", detail: String(e?.message ?? e).slice(0, 120) }); });
    child.on("close", (rc) => { clearTimeout(timer); done({ ok: rc === 0, code: rc === 0 ? "OK" : "RQL_FAILED", rc, out: out.slice(0, 4000), err: err.slice(0, 4000) }); });
  });
}

function sha256OfText(t) { return createHash("sha256").update(String(t ?? "")).digest("hex"); }

// Ticket 799 I3: accept the legacy boolean alias without silently widening scope.
// RepoQL's native field is `contextual`; `isUniversal` is the inverse alias.
export function normalizeUniversalAlias(cand) {
  if (!cand || typeof cand !== "object" || !Object.prototype.hasOwnProperty.call(cand, "isUniversal")) {
    return { ok: true, candidate: cand };
  }
  if (typeof cand.isUniversal !== "boolean") {
    return { ok: false, detail: "isUniversal must be a boolean" };
  }
  const contextual = cand.isUniversal === false;
  if (Object.prototype.hasOwnProperty.call(cand, "contextual") && cand.contextual !== contextual) {
    return { ok: false, detail: "isUniversal conflicts with contextual" };
  }
  const candidate = { ...cand, contextual };
  delete candidate.isUniversal;
  return { ok: true, candidate };
}

// Operator directive 2026-10-27 (scoped self-learning): an omitted `contextual`
// is NOT a universal opt-in. Ordinary captures default to contextual scope;
// universal must be explicit (`isUniversal: true` or `contextual: false`), and a
// principle is universal by its category. This matches the live rql contract:
// `--universal` defaults false and without it a concept records universal:false.
export function resolveContextual(cand) {
  const cat = String(cand?.category ?? "").trim().toLowerCase();
  if (cat === "principle") return false;
  const alias = normalizeUniversalAlias(cand);
  if (!alias.ok) return true; // conflicting aliases fail closed toward the narrower scope
  const c = alias.candidate;
  if (typeof c?.contextual === "boolean") return c.contextual;
  return true;
}

// Operator directive 2026-10-27: relevance may be schemeless (`**/...`) or
// source-qualified for an imported or mounted source (github://, git://,
// s3://, worktree://). Relative paths, bare globs and traversal stay refused.
const RELEVANCE_SCHEMES = ["github", "git", "s3", "worktree"];
export function isSupportedRelevanceGlob(glob) {
  const g = String(glob ?? "");
  if (/^\*\*\//.test(g)) return true;
  const m = g.match(/^([a-z][a-z0-9+.-]*):\/\/(.+)$/i);
  if (!m) return false;
  if (!RELEVANCE_SCHEMES.includes(m[1].toLowerCase())) return false;
  return m[2].trim().length > 0;
}

// Resolve each scope against the existing RepoQL index before dry-run or write.
// `glob_files` applies RepoQL's glob grammar to indexed URIs (not SQL LIKE).
export async function queryGlobMatchCount(glob, timeoutMs = DEFAULT_TIMEOUT_MS) {
  if (typeof glob !== "string" || !isSupportedRelevanceGlob(glob) || /[\x00-\x20'"\\;]/.test(glob) || glob.split("/").some((p) => p === "..")) {
    return { ok: false, code: "INVALID_GLOB", detail: "relevance glob is outside the safe schemeless **/ grammar" };
  }
  const literal = "'" + glob.replace(/'/g, "''") + "'";
  const sql = `SELECT COUNT(*) AS matches FROM glob_files(${literal})`;
  const r = await runRql(["query", sql, "--json", "--no-launch"], timeoutMs);
  if (!r.ok) return { ok: false, code: r.code ?? "RQL_FAILED", detail: "RepoQL relevance resolution failed" };
  try {
    const rows = JSON.parse(String(r.out ?? ""));
    const count = Number(Array.isArray(rows) ? rows[0]?.matches : rows?.matches);
    if (!Number.isSafeInteger(count) || count < 0) throw new Error("invalid count");
    return { ok: true, count };
  } catch {
    return { ok: false, code: "RQL_BAD_RESULT", detail: "RepoQL relevance resolution returned an invalid count" };
  }
}

export async function resolveRelevanceGlobs(relevance, { resolveGlob = queryGlobMatchCount } = {}) {
  const raw = String(relevance ?? "").trim();
  if (!raw) return { ok: false, code: "UNRESOLVED_RELEVANCE", detail: "relevance is empty" };
  if (raw.includes(",")) return { ok: false, code: "UNRESOLVED_RELEVANCE", detail: "relevance must be semicolon-delimited" };
  const globs = [...new Set(raw.split(";").map((g) => g.trim()).filter(Boolean))];
  if (!globs.length) return { ok: false, code: "UNRESOLVED_RELEVANCE", detail: "relevance is empty" };
  const resolved = [], dropped = [];
  for (const glob of globs) {
    let result;
    try { result = await resolveGlob(glob); } catch { result = null; }
    if (!result?.ok || !Number.isSafeInteger(Number(result.count)) || Number(result.count) < 0) {
      return { ok: false, code: "UNRESOLVED_RELEVANCE", detail: "RepoQL relevance resolution failed; nothing was written" };
    }
    if (Number(result.count) > 0) resolved.push(glob);
    else dropped.push(glob);
  }
  if (!resolved.length) return { ok: false, code: "UNRESOLVED_RELEVANCE", detail: "no relevance glob matched indexed files; nothing was written", dropped };
  return { ok: true, relevance: resolved.join(";"), resolved, dropped };
}

// Ticket 740 (K3): the concept-add call runs RepoQL's fact-check (an inference round
// trip). A 15 s cap killed 13 of 48 live captures (UNKNOWN_TIMEOUT). Only that call
// uses this budget; KC_CONCEPT_ADD_TIMEOUT_MS overrides it. The default stays under
// the plugin's 240 s ssh cap so the kit reconciles before that cap fires.
const CONCEPT_ADD_TIMEOUT_MS_DEFAULT = 150000;
export function conceptAddTimeoutMs() {
  const v = Number(process.env.KC_CONCEPT_ADD_TIMEOUT_MS);
  return Number.isFinite(v) && v > 0 ? v : CONCEPT_ADD_TIMEOUT_MS_DEFAULT;
}

// Ticket 740 (K4): the checker's reasons ("Verification: ... Craft: ...") were cut at
// 300 chars and success output was discarded. This bounded parse keeps them.
export function parseChecker(text) {
  const s = String(text ?? "");
  const ver = s.match(/Verification:\s*([^\n]*)/);
  const craft = s.match(/Craft:\s*([^\n]*)/);
  if (!ver && !craft) return null;
  return { verification: (ver?.[1] ?? "").trim().slice(0, 1200), craft: (craft?.[1] ?? "").trim().slice(0, 600) };
}
// RepoQL writes the refusal to one stream or the other; keep the one that carries it.
function refusalText(r) {
  const text = [r.err, r.out].find((s) => /Verification:|nothing was written|Craft:/.test(String(s ?? "")));
  return String(text ?? r.err ?? r.out ?? "");
}

// Ticket 740 (K2): ONE ssh call returns every capsule body, each framed by sentinels.
// It replaces one ssh cat per file (~269 serial round trips; ~76 s per dry-run). The
// script travels over stdin, so no quoting crosses the ssh argv.
const BULK_BEGIN = "@@KC-BEGIN ";
const BULK_END = "\n@@KC-END\n";
export function parseBulkConceptDump(text) {
  const s = String(text ?? "");
  const out = [];
  let i = s.indexOf(BULK_BEGIN);
  while (i !== -1) {
    const eol = s.indexOf("\n", i);
    if (eol === -1) break;
    const end = s.indexOf(BULK_END, eol);
    if (end === -1) break;
    out.push({ path: s.slice(i + BULK_BEGIN.length, eol), body: s.slice(eol + 1, end) });
    i = s.indexOf(BULK_BEGIN, end + BULK_END.length);
  }
  return out;
}
function bulkConceptDumpRemote(dir) {
  const quoted = "'" + String(dir).replace(/'/g, "'\\''") + "'";
  const script = [
    "dir=" + quoted,
    "find \"$dir\" -maxdepth 4 -type f -name '*.md' | while IFS= read -r f; do printf '" + BULK_BEGIN + "%s\\n' \"$f\"; cat -- \"$f\" || true; printf '\\n@@KC-END\\n'; done",
  ].join("\n") + "\n";
  try {
    return execFileSync("ssh", [CONCEPTS_SSH_HOST, "sh", "-s"], { input: script, encoding: "utf8", timeout: 45000, maxBuffer: 32 * 1024 * 1024 });
  } catch { return null; }
}

// Duplicate prevention (plan §14.8): same normalized invariant or name in the
// existing capsule tree => capture MUST merge/update instead of add.
// Ticket 164 Phase 3 (§10): semantic explore-first gate + universal cap.
// - SEMANTIC_NEAR_MATCH: callers should run `rql explore "<candidate meaning>"`
//   BEFORE creating a Concept; this helper reports existing capsules that
//   already answer the same question so evidence merges into the existing
//   capsule instead of spawning paraphrase capsules (audit finding O: four
//   paraphrase capsules for ONE evidence-pack bug). Enforced in the gate
//   command (concept-gate.mjs); captureConcept keeps the hard text dedupe.
// - UNIVERSAL cap: relevance "file:///**" / "**" (true fleet-wide) is capped at
//   UNIVERSAL_CONCEPT_CAP; the gate refuses capture beyond it.
export const UNIVERSAL_CONCEPT_CAP = 24;
export function isUniversalRelevance(relevance) {
  const r = String(relevance ?? "").trim();
  return r === "**" || r === "file:///**" || r === "file:////**" || r === "**/**";
}
export async function findSemanticNearMatches({ meaning, conceptsDir, timeoutMs = DEFAULT_TIMEOUT_MS, limit = 5 }) {
  if (!meaning || String(meaning).length < 8) return { ok: false, code: "INVALID_MEANING" };
  const globRoot = String(conceptsDir ?? ".repoql/concepts").replace(/\/+$/, "");
  // concept:/// URIs surface the capsule tree directly in explore results.
  const r = await runRql(["explore", String(meaning), "--uri-glob", "concept:///", "--jsonl"], timeoutMs);
  if (!r.ok) return { ok: false, code: "EXPLORE_FAILED", detail: String(r.err ?? r.out ?? "").slice(0, 160) };
  const hits = [];
  for (const line of String(r.out ?? "").split("\n")) {
    const t = line.trim();
    if (!t.startsWith("{")) continue;
    let j = null; try { j = JSON.parse(t); } catch { continue; }
    if (!j?.uri) continue;
    hits.push({ uri: j.uri, headline: String(j.headline ?? "").slice(0, 140) });
    if (hits.length >= limit) break;
  }
  return { ok: true, hits, note: "callers merge evidence into an existing capsule instead of capturing a new one when a hit answers the same question" };
}
export function findDuplicateConcept(conceptsDir, { name, invariant }) {
  const norm = (s) => String(s ?? "").toLowerCase().replace(/[^a-z0-9 ]/g, " ").replace(/\s+/g, " ").trim();
  const target = norm(invariant);
  const dir = conceptsDir;
  // Ticket 740 K7 (operator directive 2026-10-19): a same-Name capsule is an UPDATE, as
  // RepoQL's guide states ("to change a capsule, capture it again under the same Name").
  // It is not refused and needs no Sol verdict; its own text is not compared. Identical
  // invariant text in ANOTHER capsule is still refused.
  const out = { duplicate: false, reason: null, file: null, update: false, priorSha256: null };
  try {
    const remote = isRemoteConceptsDir(dir);
    let entries;
    if (remote) {
      const dump = bulkConceptDumpRemote(dir);
      if (dump == null) return out; // fail-open as before; no per-file fallback (K2: that blew the 240 s cap)
      entries = parseBulkConceptDump(dump);
    } else {
      const acc = [];
      const walk = (d) => { for (const ent of readdirSyncSafe(d)) { const p = `${d}/${ent}`; if (isDir(p)) walk(p); else if (p.endsWith(".md")) acc.push(p); } };
      walk(dir);
      entries = acc.map((p) => ({ path: p, body: String(readFileSync(p, "utf8")) }));
    }
    // Ticket 799 / NEMOTRON-FIX: exclude the generated root index README.md
    // (at conceptsDir/README.md) from duplicate comparison in BOTH local and
    // remote paths. It quotes invariants from real capsules and would falsely
    // block 365/519 legitimate same-name updates and new unique capsules.
    // Only the exact root index is excluded; nested genuine README.md capsules
    // (if allowed by format) are NOT excluded.
    const rootReadmePath = `${dir.replace(/\/+$/,"")}/README.md`;
    for (const { path: p, body } of entries) {
      // Skip the generated root README.md index — it is not a capsule.
      if (p === rootReadmePath) continue;
      // Ticket 740: real RepoQL capsules head with "## Capsule: <Name>"; the old ^#\s+ regex
      // missed them, so a same-name recapture never matched. Use basename + both headings.
      const base = String(p).split("/").pop() ?? "";
      const h2 = (body.match(/^##\s+Capsule:\s*(.+)$/m)?.[1] ?? "").trim();
      const h1 = (body.match(/^#\s+(.+)$/m)?.[1] ?? "").trim();
      const nameLc = String(name).toLowerCase();
      const isSameName = base.replace(/\.md$/i, "").toLowerCase() === nameLc || h2.toLowerCase() === nameLc || h1.toLowerCase() === nameLc;
      if (isSameName) {
        if (!out.update) { out.update = true; out.reason = "same-name capsule (update)"; out.file = p; out.priorSha256 = sha256OfText(body); }
        continue;
      }
      if (target && norm(body).includes(target)) { out.duplicate = true; out.update = false; out.reason = "identical invariant text exists"; out.file = p; return out; }
    }
  } catch { /* unreadable tree -> no duplicate found (capture proceeds; REVIEW saw the candidate) */ }
  return out;
}

function readdirSyncSafe(d) { try { return readdirSync(d); } catch { return []; } }
function isDir(p) { try { return statSync(p).isDirectory(); } catch { return false; } }

// Validate the candidate carries everything `rql concept add` requires.
export function validateConceptCandidate(c) {
  const alias = normalizeUniversalAlias(c);
  const problems = [];
  if (!alias.ok) return { ok: false, problems: [alias.detail] };
  c = alias.candidate;
  // Ticket 339 phase 2.2 (reviewer B4): parity with the live rql contract — ALL
  // FIVE categories are accepted. The brokered routing previously limited capture
  // to wisdom|rule|knowledge while the plugin advertised principle|shape too,
  // so those capsules were refused by the kit path the direct rql path accepted.
  // Per-category rules follow rql semantics: principle takes no relevance and is
  // never verified; shape's relevance is its location; knowledge requires
  // verification + ttlDays.
  if (!c?.name || !/^[A-Z][A-Za-z0-9]+$/.test(c.name)) problems.push("name: CamelCase identifier required");
  if (!c?.invariant || String(c.invariant).length < 10) problems.push("invariant: one-sentence invariant required");
  if (!c?.tags) problems.push("tags: required by rql concept add");
  const cat = c?.category;
  if (c?.contextual !== undefined && typeof c.contextual !== "boolean") problems.push("contextual: must be a boolean");
  if (cat === "principle" && c?.contextual === true) problems.push("contextual: principles are universal; omit contextual or set false");
  // Ticket 740 K1: a principle takes NO relevance and NO verification (RepoQL refuses
  // both); a wisdom takes no verification and no ttlDays. The old rule required
  // relevance for every category, so every principle was refused.
  if (cat !== "principle" && !c?.relevance) problems.push("relevance: required for " + cat + " (semicolon-separated schemeless globs such as **/services/<file>.md)");
  if (cat === "principle" && c?.relevance) problems.push("relevance: a principle takes NO relevance (remove the field; principles apply everywhere)");
  if (c?.relevance && !isSupportedRelevanceGlob(String(c.relevance))) problems.push("relevance: use a schemeless glob starting **/ or a source-qualified glob (github://, git://, s3://, worktree://); relative paths are refused");
  if (cat === "principle" && c?.verification) problems.push("verification: a principle is not fact-checked (remove the field)");
  if (cat === "wisdom" && (c?.verification || c?.ttlDays)) problems.push("verification/ttlDays: a wisdom is not fact-checked (remove both fields)");
  if (cat === "knowledge" && !c?.verification) problems.push("verification: REQUIRED for knowledge concepts (knowledge must be fact-checked)");
  if (c?.verification && !c?.ttlDays) problems.push("ttlDays: required when verification is set");
  if (c?.ttlDays && !c?.verification) problems.push("verification: required when ttlDays is set");
  return { ok: problems.length === 0, problems };
}

// Ticket 699: mechanical contract PREFLIGHT. Diagnostics only - it never writes,
// never journals, and gates nothing (RepoQL stays authoritative for invariant
// length and relevance RESOLUTION at write time). Kept beside the contract in
// documentation/tools/repoql-usage.md (2026-10-17 section) and
// help:///tools/capture-concept.md; the tool wrapper exposes it as --dry-run.
export function preflightConcept(cand) {
  const problems = [];
  const warnings = [];
  const alias = normalizeUniversalAlias(cand);
  if (!alias.ok) problems.push(alias.detail);
  else cand = alias.candidate;
  const str = (v) => (v === undefined || v === null ? "" : String(v));
  const CATS = ["principle", "wisdom", "rule", "shape", "knowledge"];
  const cat = str(cand?.category).trim().toLowerCase();
  const inv = str(cand?.invariant);
  const rel = str(cand?.relevance);
  const ver = str(cand?.verification);

  if (!str(cand?.name).trim()) problems.push("name is required (short CamelCase identifier)");
  if (!CATS.includes(cat)) problems.push("category must be one of " + CATS.join(", ") + " (got '" + str(cand?.category) + "')");
  if (!inv.trim()) problems.push("invariant is required");
  if (inv.length > 240) problems.push("invariant is " + inv.length + " characters - keep it UNDER 240 and to ONE idea; mechanism, stakes and context belong in why (RepoQL rejects this verbatim)");
  if (!str(cand?.tags).trim()) problems.push("tags are required (comma-separated search tags)");
  if (cand?.contextual !== undefined && typeof cand.contextual !== "boolean") problems.push("contextual must be a boolean");
  if (cat === "principle" && cand?.contextual === true) problems.push("principles are universal; contextual must be omitted or false");

  if (cat === "principle") {
    if (rel.trim()) problems.push("principle takes NO relevance (it applies everywhere)");
    if (ver.trim()) problems.push("principle takes NO verification");
  } else if (CATS.includes(cat) && !rel.trim()) {
    problems.push("relevance is required for " + cat + " (semicolon-delimited URI globs)");
  }
  if (cat === "knowledge" && !ver.trim()) problems.push("knowledge requires verification");
  if (rel.includes(",")) problems.push("relevance contains a COMMA - it is SEMICOLON-delimited (e.g. a/**;b/**); commas resolve to nothing and the capture is rejected");

  for (const [field, value] of Object.entries({ name: cand?.name, invariant: cand?.invariant, tags: cand?.tags, relevance: cand?.relevance, why: cand?.why, example: cand?.example, verification: cand?.verification })) {
    const s = str(value);
    const q = (s.match(/"/g) || []).length;
    if (q % 2) problems.push(field + " has an UNBALANCED double quote - quoting failures surface later as an RQL_RC_2 syntax error (heuristic: pair counting)");
    const open = (s.match(/\(/g) || []).length, close = (s.match(/\)/g) || []).length;
    if (open !== close) problems.push(field + " has unbalanced parentheses (" + open + " open, " + close + " close; heuristic: pair counting)");
  }
  if (rel.trim()) warnings.push("relevance globs are resolved against the RepoQL index during both dry-run and capture; zero-match globs are dropped and an empty result is refused");
  warnings.push("this preflight writes nothing; the capture itself is the authoritative validation");
  return { ok: problems.length === 0, problems, warnings };
}

// Ticket 740 (K5): the public entry point adds a self-contained `hint` after `code` and
// before checker/detail (the plugin truncates kit output at 4000 chars). Hints assume no
// shell: restricted modes have none.
export async function captureConcept(cand, opts = {}) {
  const alias = normalizeUniversalAlias(cand);
  if (!alias.ok) return { ok: false, code: "INVALID_CANDIDATE", detail: alias.detail, hint: refusalHint("INVALID_CANDIDATE", alias.detail) };
  const r = await captureConceptCore(alias.candidate, opts);
  if (r.ok) return r;
  const { ok, code, ...rest } = r;
  return { ok, code, hint: refusalHint(code, r.detail), ...rest };
}

const LINEAGE_HINT = "Lineage fields (supersedes, derivedFrom, sourceClaimIds) must name existing, non-tombstoned capsule Names, never this capsule itself. supersedes records lineage only and never retires the old capsule: to correct a wrong capsule, recapture its own Name. Drop the lineage fields if they are not needed. Nothing was written.";
export function refusalHint(code, _detail = "") {
  const c = String(code ?? "");
  if (c === "INVALID_CANDIDATE") return "Fix each field named in detail, then resubmit ONCE with the changed fields. Category rules: principle = no relevance, no verification; wisdom = no verification, no ttlDays; rule = relevance (verification and ttlDays together, optional); shape = relevance (its location); knowledge = relevance, verification and ttlDays. Relevance = semicolon-separated schemeless globs starting **/ (hub docs are indexed WITHOUT the documentation/ prefix, e.g. **/services/<file>.md). Nothing was written.";
  if (c === "DUPLICATE_CONCEPT") return "The same invariant text already exists in ANOTHER capsule (named in detail). Either recapture THAT capsule's Name with your improved text (same-Name recapture is an update; no Sol verdict is needed), or narrow this invariant to what that capsule does not already say. Do not resubmit identical JSON. Nothing was written.";
  if (c === "TOMBSTONED") return "This claim is blocked by a tombstone (see detail). Do not recapture it. Changing that decision needs operator authority: report the need to the operator. Nothing was written.";
  if (/WRITE_FAILED|UNPARSABLE|TRAVERSAL_FAILED|NO_MARK_FN/.test(c)) return "The lineage store refused or could not be read (see detail), so nothing was captured. Infrastructure issue: report it to the operator; do not retry in a loop.";
  if (c.startsWith("LINEAGE_") || c.startsWith("ACTIVE_DESCENDANT_") || c.startsWith("SYNTHESIS_") || ["INVALID_LINEAGE", "MISSING_PARENT", "SELF_REFERENCE", "CYCLE_DETECTED", "PARENT_LINEAGE_LEGACY"].includes(c)) return LINEAGE_HINT;
  if (c === "RQL_RC_1") return "RepoQL refused the capture: its fact-check could not establish the claim from the cited evidence, or a relevance glob matched no indexed files. Read checker and detail. Fix: cite an indexed symbol-level URI that shows the claim (github://<owner>/<repository>/<path>#symbol=Name or #line=M,N), or narrow the invariant, why or example to what the evidence shows; use indexed paths for relevance. Nothing was written; do not resubmit identical JSON.";
  if (c === "RQL_RC_2") return "RepoQL rejected the input at validation (syntax, a field this category forbids, or a relevance glob that matched no indexed files). Remove backticks, $(...) and unbalanced quotes; re-check the category rules in the INVALID_CANDIDATE hint. Nothing was written; fix it and resubmit once.";
  if (c === "UNRESOLVED_RELEVANCE") return "No relevance glob resolved to indexed files, or RepoQL could not verify the scope. Nothing was written; narrow the candidate to an indexed path and run the dry-run again. The writer will not broaden the glob.";
  if (c === "TIMEOUT" || c === "UNKNOWN_TIMEOUT") return "The outcome is UNPROVEN: the capsule may already exist. Do NOT resubmit. Check whether it landed with rql read \"concept:///<category>/<Name>.md\" (if your mode has a shell; otherwise report to the operator). Present and complete means captured; absent means report it. Do not loop.";
  if (c === "JOURNAL_INTENT_FAILED" || c === "SPAWN_FAILED" || c === "UNKNOWN_SPAWN_FAILED") return "The capture could not start (journal or RepoQL unavailable), so nothing was captured. Infrastructure issue: report it to the operator; do not retry in a loop.";
  if (/TOMBSTONE/.test(c)) return "The tombstone index could not be read, so capture is held fail-closed. Infrastructure issue: report it to the operator; do not retry in a loop.";
  return "See detail. Nothing was written. Do not resubmit identical JSON.";
}

async function captureConceptCore(cand, { journalDir, caseId = null, phase = null, conceptsDir = CONCEPTS_DIR_DEFAULT, dryRun = false, timeoutMs = conceptAddTimeoutMs(), tombstonesDir = TOMBSTONES_DIR_DEFAULT, lineageDir = resolveLineageDir(), resolveGlob = queryGlobMatchCount } = {}) {
  const v = validateConceptCandidate(cand);
  if (!v.ok) return { ok: false, code: "INVALID_CANDIDATE", detail: v.problems.join("; ") };

  let relevanceResolution = null;
  if (String(cand.category ?? "").trim().toLowerCase() !== "principle") {
    relevanceResolution = await resolveRelevanceGlobs(cand.relevance, { resolveGlob });
    if (!relevanceResolution.ok) return { ok: false, code: "UNRESOLVED_RELEVANCE", detail: relevanceResolution.detail, relevanceResolution };
    cand = { ...cand, relevance: relevanceResolution.relevance };
  }

  // Rejected-value tombstone enforcement (ticket 191; Sol Gate 1): FINAL
  // fail-closed check on the ONLY RepoQL concept write path — both the auto
  // (conversation review) and manual gated paths converge here. Two matching
  // planes: the full Sol match (subject+field+scope+digest) for v2 candidates,
  // then the NARROW value-plane fallback (exact canonical claim equality) —
  // needed because this chokepoint's only subject key is the capsule NAME
  // while tombstones carry free-text subjects. An existing-but-unreadable
  // tombstone index holds capture (absence of evidence is not evidence of
  // absence); an ABSENT tombstone dir is "no tombstones" = open. Override
  // path: governed tombstone retirement (memory-tombstone.retireTombstone).
  const tIdx = loadTombstones(tombstonesDir);
  if (!tIdx.ok) return { ok: false, code: tIdx.code, detail: `tombstone plane unavailable — capture held fail-closed (${tIdx.detail ?? tIdx.file ?? ""})`.trim(), reconcilable: false };
  let tomb = { blocked: false, reason: null };
  if (tIdx.tombstones.length) {
    tomb = evaluateTombstones({ subject: cand.name, field: null, claim: cand.invariant, scope: cand.relevance ?? null, tombstones: tIdx.tombstones });
    if (!tomb.blocked) tomb = claimIsRejected({ claim: cand.invariant, scope: cand.relevance ?? null, tombstones: tIdx.tombstones });
  }
  if (tomb.blocked) return { ok: false, code: "TOMBSTONED", detail: tomb.reason, reconcilable: false };

  // Ticket 305 (plan §6; Sol gate C flag matrix): capture-time lineage gate,
  // BEFORE the rql write. A derived record whose lineage fails validation is
  // REJECTED fail-closed (plan §27) — never created without provenance. Flag
  // off + no lineage inputs = byte-identical legacy path. Validation covers:
  // parents exist, no self-reference, duplicates normalized, tombstoned parents
  // refused, invalid parents refused, synthesis-as-parent refused, bounded DFS
  // cycle/depth protection (plan §7).
  const lineageGate = captureLineageGate({
    recordId: cand.name,
    sourceClaimIds: cand.sourceClaimIds, derivedFrom: cand.derivedFrom,
    supersedesClaimId: cand.supersedesClaimId, sourceEvidence: cand.sourceEvidence,
    lineageDir,
    parentExists: (id) => Boolean(locateConceptFile(conceptsDir, id)),
    parentIsTombstoned: (id) => tIdx.ok && tIdx.tombstones.some((t) =>
      String(t.status ?? "active") === "active"
      && String(t.subject ?? "").toLowerCase().replace(/[^a-z0-9]+/g, " ").trim()
        === String(id).toLowerCase().replace(/[^a-z0-9]+/g, " ").trim()),
  });
  if (!lineageGate.ok) return { ok: false, code: lineageGate.code, detail: lineageGate.detail, reconcilable: false };

  const dup = findDuplicateConcept(conceptsDir, cand);
  if (dup.duplicate) return { ok: false, code: "DUPLICATE_CONCEPT", detail: `${dup.reason}: ${dup.file}`, reconcilable: false };

  // Ticket 740 K7: a same-Name candidate is an update; its prior bytes are recorded by sha256.
  const action = dup.update ? "updated" : "created";
  const priorSha256 = dup.update ? dup.priorSha256 : null;
  const args = [
    "concept", "add", cand.name, cand.category, String(cand.invariant),
    "--tags", String(cand.tags),
  ];
  if (cand.relevance) args.push("--relevance", String(cand.relevance)); // Ticket 740 K1: a principle sends no relevance flag (the literal "undefined" reached rql before)
  if (cand.why) args.push("--why", String(cand.why));
  if (cand.example) args.push("--example", String(cand.example));
  if (cand.verification) args.push("--verification", String(cand.verification));
  if (cand.ttlDays) args.push("--ttl-days", String(cand.ttlDays));
  // GHOST-BRIDGE-OK (2026-10-17): rql 1.7.14 rejects --contextual (rc 2) and
  // flipped the universal default: the new CLI records contextual unless
  // --universal. Operator directive 2026-10-27: pass --universal only for an
  // explicit universal decision or a principle, never because the field was
  // omitted (an omission is ordinary contextual capture).
  if (!resolveContextual(cand)) args.push("--universal");
  if (cand.subcategory) args.push("--subcategory", String(cand.subcategory));
  if (cand.depth) args.push("--depth", String(cand.depth)); // ticket 339 phase 2.2: parity with the former plugin argv (depth field)

  if (dryRun) return { ok: true, dryRun: true, action, priorSha256, args, conceptName: cand.name, contextual: resolveContextual(cand), lineage: lineageGate, relevanceResolution };

  const requestDigest = requestDigestOf({ args, caseId });
  const opId = `concept-capture-${cand.name}-${Date.now()}`;
  let intent = null;
  try {
    intent = journalIntent(journalDir, { opId, op: "repoql.capture_concept", caseId, phase, requestDigest, meta: { name: cand.name, category: cand.category, action, priorSha256 } });
  } catch (e) {
    return { ok: false, code: "JOURNAL_INTENT_FAILED", detail: String(e?.message ?? e).slice(0, 120) };
  }

  const r = await runRql(args, timeoutMs);
  if (r.ok) {
    // Locate the written capsule and record its stable bytes. Bounded retry:
    // the SSH-backed tree listing can race the rql write (live 2026-09-27,
    // ticket 130 — three concepts landed with file:null receipts), so retry
    // the locate a few times before accepting a null digest.
    let file = null, sha256 = null, bytes = null;
    for (let attempt = 0; attempt < 4 && !file; attempt++) {
      if (attempt > 0) await new Promise((res) => setTimeout(res, 1200));
      file = locateConceptFile(conceptsDir, cand.name);
    }
    if (file) {
      // Ticket 339 phase 5 stage A (container-mode capture): the locate may
      // return a HOST path (the concepts tree is ssh-remote from the container)
      // — read it through the same remote channel as findDuplicateConcept,
      // otherwise the post-write receipt crashes with ENOENT after the rql
      // write already succeeded.
      bytes = isRemoteConceptsDir(conceptsDir) ? (readConceptFileRemote(file) ?? "") : String(readFileSync(file, "utf8"));
      sha256 = sha256OfText(bytes);
    }
    journalComplete(journalDir, opId, { state: "done", receipt: { file, sha256, action, priorSha256 } });
    // Ticket 305 (plan §6.8): persist the derivation sidecar AFTER the durable
    // record exists. Sidecar-only — capsule bytes and their acceptance sha256
    // binding are untouched. Sidecar write failure NEVER invalidates the
    // capture (plan §27: ordinary legacy write keeps existing behaviour);
    // it surfaces as lineage.code on the receipt for diagnosis.
    let lineage = null;
    if (lineageGate.ok && !lineageGate.skipped) {
      lineage = recordDerivation({
        recordId: cand.name, recordKind: "concept",
        sources: lineageGate.validated.sources, derived: lineageGate.validated.derived,
        supersedes: lineageGate.validated.supersedes, evidence: lineageGate.validated.evidence,
        valueDigest: sha256, currentStateDependent: Boolean(cand.currentStateDependent),
        lineageDir,
      });
    }
    return { ok: true, conceptName: cand.name, file, sha256, action, priorSha256, checker: parseChecker(r.out) ?? parseChecker(r.err), verification: cand.verification ? "pending-revalidation-loop" : "n/a (no verification supplied)", lineage };
  }
  if (r.code === "TIMEOUT" || r.code === "SPAWN_FAILED") {
    // Unknown outcome: the effect MAY have landed. Reconcile by observation,
    // never blind-retry (existing ops discipline; Sol FIX PLAN item 5).
    const file = locateConceptFile(conceptsDir, cand.name);
    // Ticket 740 K3 (reviewer): remote-aware read. A local read of a remote path threw ENOENT and skipped the journal receipt.
    const reconBytes = file ? (isRemoteConceptsDir(conceptsDir) ? (readConceptFileRemote(file) ?? "") : String(readFileSync(file, "utf8"))) : "";
    // A same-Name update can time out before writing: merely finding its OLD file
    // is not proof of success. Require changed bytes and the requested invariant.
    const isNewEffect = reconBytes && (!priorSha256 || sha256OfText(reconBytes) !== priorSha256)
      && reconBytes.includes(String(cand.invariant));
    if (file && isNewEffect) {
      const bytes = reconBytes;
      const sha256 = sha256OfText(bytes);
      journalComplete(journalDir, opId, { state: "done", remoteId: file, receipt: { reconciled: true, sha256 } });
      let lineage = null;
      if (lineageGate.ok && !lineageGate.skipped) {
        lineage = recordDerivation({
          recordId: cand.name, recordKind: "concept",
          sources: lineageGate.validated.sources, derived: lineageGate.validated.derived,
          supersedes: lineageGate.validated.supersedes, evidence: lineageGate.validated.evidence,
          valueDigest: sha256, currentStateDependent: Boolean(cand.currentStateDependent),
          lineageDir,
        });
      }
      return { ok: true, conceptName: cand.name, file, sha256, reconciled: true, action, priorSha256, lineage };
    }
    journalComplete(journalDir, opId, { state: "unknown", errorClass: r.code, receipt: { detail: r.detail ?? r.err } });
    return { ok: false, code: `UNKNOWN_${r.code}`, detail: "effect state unproven; reconcile (check .repoql/concepts) before any retry", reconcilable: true };
  }
  const refusal = refusalText(r).slice(0, 3000);
  journalComplete(journalDir, opId, { state: "failed", errorClass: `RC_${r.rc}`, receipt: { detail: refusal } });
  return { ok: false, code: `RQL_RC_${r.rc}`, checker: parseChecker(refusal), detail: refusal };
}

export function locateConceptFile(conceptsDir, name) { // ticket 339 phase 2.1: exported for conv-review buildsOn validation
  // Capsules file under concepts/<category|subcategory>/<name>.md — search.
  try {
    if (isRemoteConceptsDir(conceptsDir)) {
      return listConceptFilesRemote(conceptsDir).find((p) => p.endsWith(`/${name}.md`)) ?? null;
    }
    const walk = (d) => {
      for (const ent of readdirSyncSafe(d)) {
        const p = `${d}/${ent}`;
        if (isDir(p)) { const f = walk(p); if (f) return f; continue; }
        if (p.endsWith(`/${name}.md`)) return p;
      }
      return null;
    };
    return walk(conceptsDir);
  } catch { return null; }
}

function readConceptFileAny(conceptsDir, path) {
  return isRemoteConceptsDir(conceptsDir) ? readConceptFileRemote(path) : String(readFileSync(path, "utf8"));
}

// Second-brain delta 2 helper (hub ticket 180): read a capsule body from a
// concept:/// or plain path URI so the conflict gate can evaluate the actual
// invariant text. Returns null when unreadable (negative knowledge: unreadable
// is NOT evidence of absence). Handles concept://<category>/<Name>.md and paths.
export function readConceptBody(uri, { conceptsDir = CONCEPTS_DIR_DEFAULT } = {}) {
  const raw = String(uri ?? "");
  let p = null;
  if (raw.startsWith("concept://")) p = `${conceptsDir.replace(/\/+$/, "")}/${raw.slice("concept://".length).replace(/^\/+/, "")}`;
  else if (raw.includes("/")) p = raw;
  if (!p) return null;
  try {
    return isRemoteConceptsDir(conceptsDir) || !existsSync(p) ? readConceptFileRemote(p) : readFileSync(p, "utf8");
  } catch { return null; }
}

// Stable-bytes re-check for the acceptance window: the digest recorded at
// capture must still match at FINAL_ACCEPTANCE (subject drift otherwise).
export function conceptBytesStable(conceptsDir, conceptName, expectedSha256) {
  const f = locateConceptFile(conceptsDir, conceptName);
  if (!f) return { stable: false, reason: "concept file missing" };
  const body = readConceptFileAny(conceptsDir, f);
  if (body == null) return { stable: false, reason: "concept file unreadable", file: f };
  const sha256 = sha256OfText(body);
  return { stable: sha256 === expectedSha256, file: f, sha256 };
}

// Worker memory-candidate -> Concept candidate mapping (ticket 094 MEX
// integration migration). Honest split per the Sol contract: implementation
// invariants map to `rule` Concepts directly; EVERYTHING else needs fact-check
// anchors the candidate schema does not carry, so it is HELD (never silently
// demoted, never auto-published as unverified knowledge). Confidential
// candidates never map (D13 + existing memory-learning staging).
export function mapCandidatesToConcepts(candidates = []) {
  const ready = [], held = [];
  const slug = (s) => String(s ?? "").replace(/[^a-zA-Z0-9 ]/g, " ").trim().split(/\s+/).slice(0, 4).map((w) => w[0].toUpperCase() + w.slice(1)).join("");
  for (const c of candidates ?? []) {
    if (c?.confidentiality === "confidential") { held.push({ id: c.id, reason: "confidential candidate never leaves the case (D13)" }); continue; }
    if (c?.kind === "implementation_invariant" && c?.claim && String(c.claim).length >= 10) {
      // Operator directive 2026-10-27: never fabricate a scope. A candidate maps
      // only when it names a real, supported relevance of its own (for example a
      // source-qualified glob); **/work/** and other broad parents are refused,
      // and a candidate without an established scope is HELD, not published wide.
      const scope = typeof c?.relevance === "string" ? c.relevance.trim() : "";
      if (!scope || !isSupportedRelevanceGlob(scope) || scope.split(";").some((g) => !isSupportedRelevanceGlob(g.trim()) || /^\*\*\/(work|documentation)\//.test(g.trim()))) {
        held.push({ id: c.id, reason: "no established relevance scope on the candidate; hold rather than publish a broad scope" });
        continue;
      }
      const name = slug(c.claim) || `RunConcept${String(c.id ?? "X").replace(/\W/g, "")}`;
      ready.push({
        source: "memory-candidate", sourceId: c.id ?? null,
        name, category: "rule",
        invariant: String(c.claim).slice(0, 300),
        tags: "orchestra,auto-candidate",
        relevance: scope,
        why: c.why ?? "staged memory candidate accepted at REVIEW",
      });
      continue;
    }
    held.push({ id: c.id, reason: "needs verification anchors before Concept capture (knowledge must be fact-checked)" });
  }
  return { ready, held };
}

// Acceptance binding (Sol ordering constraint 3): the exact Concept files a run
// captured, from its ops.jsonl done-receipts — these paths belong in the
// acceptance-subject knowledge digest list so post-capture drift invalidates
// the verdict. Read-only; never throws (binding is best-effort, journal
// unreadable => empty list, same as "no concepts captured").
function conceptFileExistsAny(path) {
  // MIGRATED 2026-09-26: concept files land on the consolidated host, not
  // this container's filesystem — check remotely when the path isn't local
  // (e.g. under /opt/harness-unset/.repoql/concepts).
  if (existsSync(path)) return true;
  try { execFileSync("ssh", [CONCEPTS_SSH_HOST, "test", "-f", path], { timeout: 8000 }); return true; } catch { return false; }
}

export function conceptFilesFromJournal(journalDir, { existing = [] } = {}) {
  const out = [];
  try {
    for (const j of readJournal(journalDir)) {
      if (j?.op === "repoql.capture_concept" && j?.state === "done" && j?.receipt?.file
        && conceptFileExistsAny(j.receipt.file) && !out.includes(j.receipt.file) && !existing.includes(j.receipt.file)) {
        out.push(j.receipt.file);
      }
    }
  } catch { /* unreadable journal => no Concept binding */ }
  return out;
}
