// lib/memory-lineage.mjs — Orchestra memory provenance hardening (hub ticket 305;
// operator plan §1-41 "Orchestra Memory Provenance Hardening"; duo Sol consult
// 2026-10-05T20-21-20-005-17600 verdict PASS WITH GATES). Provenance GRAPH =
// metadata about existing memory objects, NOT another memory system.
//
// Design contract (plan + Sol gates):
//   - Sidecar JSON per derived record at .repoql/lineage/<Name>.json, OUTSIDE the
//     RepoQL concept tree (never indexed as positive knowledge — same discipline
//     as memory-tombstone). `rql concept add` names "act as the identifier"
//     (live --help), so <Name>.json is globally unambiguous (Sol gate 2 checked).
//   - Capsules are sha256-bound at acceptance and are NEVER rewritten here.
//     Sidecar-only state: lineageState invalid/stale never touches capsule bytes.
//   - No backfill (plan §4.2): absence of a sidecar = legacy_unknown. Provenance
//     is never inferred, never LLM-fabricated. A NEW direct capture intentionally
//     has NO sidecar (non-derived by construction); absence when lineage IS
//     expected is detectable via the capture receipt (Sol C wording).
//   - Direct parents only (plan §4.1); ancestry is traversal, never copied.
//   - Trust direction (plan §28): evidence -> verification -> durable claim ->
//     derived material. This module never reverses it; synthesis records can
//     never serve as sources (recordKind check in parent validation).
//   - Invalidation (Sol gate B): ONE durable event with a STABLE eventId
//     (inv-<TombstoneName>) + per-descendant state inside each sidecar. The
//     tombstone frontmatter carries only a convenience AGGREGATE; correctness is
//     derived from the event + sidecar markers, never from a tombstone bit.
//   - Failure semantics (plan §27): the tombstone never depends on descendant
//     processing; invalidation is resumable and idempotent; explain/integrity
//     are read-only; flag-off = byte-identical legacy behaviour.
//   - This module is pure data + file IO + deterministic traversal. It never
//     executes retrieved text (memory is DATA, not instruction) and never
//     requires an LLM.
import { createHash } from "node:crypto";
import { existsSync, readFileSync, writeFileSync, readdirSync, mkdirSync, renameSync, statSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
// Intentionally NO import from concept-conflict-gate/concept-capture here:
// those modules import THIS one (capture-time lineage gate), and an ESM cycle
// around the gate plane is exactly the fragility the kit's leaf-module comments
// warn about. explainMemory parses capsule frontmatter with a local lite parser
// (same YAML-lite discipline as the gate's parseCapsule).
import { parseTombstone } from "./memory-tombstone.mjs";

const SSH_HOST = "controller";
export const LINEAGE_DIR_DEFAULT = process.env.ORCH_LINEAGE_DIR ?? "/opt/harness-unset/.repoql/lineage";

// ---- constants (plan §5, §11, §24, §29) -------------------------------------
export const LINEAGE_STATES = new Set(["known", "legacy_unknown", "invalid", "stale"]);
export const INVALIDATION_STATES = new Set(["pending", "processing", "complete", "failed"]);
export const MAX_DIRECT_PARENTS = 32;          // plan §29
export const MAX_TRAVERSAL_DEPTH = 32;         // plan §7/§29
export const MAX_INVALIDATION_BATCH = 25;      // small bounded batches (plan §29)

// Feature flags (plan §24; config-backed since ticket 339 phase 0) — read PER
// CALL (tests toggle without reimport). Precedence per the activation plan:
// env var (if set) > config.json `memoryProvenance` block > default disabled.
// Shipping disabled first stays the rollout rule, and flag-off must be
// byte-identical legacy behaviour (Sol C.1).
//
// Leaf-module discipline: the kit config is located relative to THIS file (the
// lib/github-sync.mjs pattern), never by importing orchestrate.mjs. The file is
// re-read on EVERY call (Sol consult 2026-10-07: an mtime+size cache does not
// satisfy the "next call sees the change" rollout-control contract; the config
// is small and call frequency is low). ORCH_MEMORY_CONFIG is a test/ops
// override for the config path only — it never changes precedence or defaults.
const CONFIG_FILE = () => process.env.ORCH_MEMORY_CONFIG ?? fileURLToPath(new URL("../config.json", import.meta.url));
function memoryProvenanceConfig() {
  try {
    const doc = JSON.parse(readFileSync(CONFIG_FILE(), "utf8"));
    return doc?.memoryProvenance ?? {};
  } catch { return {}; }
}
function flagFrom(envName, cfgKey) {
  const env = process.env[envName];
  if (env != null && String(env).trim() !== "") return String(env).toUpperCase() === "ENABLED";
  return String(memoryProvenanceConfig()[cfgKey] ?? "disabled").toUpperCase() === "ENABLED";
}
export function flags() {
  return {
    captureEnabled: flagFrom("ORCH_MEMORY_LINEAGE_CAPTURE", "lineageCapture"),
    invalidationEnabled: flagFrom("ORCH_MEMORY_LINEAGE_INVALIDATION", "lineageInvalidation"),
    synthesisEnabled: flagFrom("ORCH_MEMORY_SYNTHESIS", "structuredSynthesis"),
    retrievalFilterEnabled: flagFrom("ORCH_MEMORY_RETRIEVAL_FILTER", "retrievalFilter"),
  };
}
// Config-backed lineage dir (ticket 339 phase 0): env ORCH_LINEAGE_DIR >
// config.memoryProvenance.lineageDir > LINEAGE_DIR_DEFAULT. Callers that pass an
// explicit dir (tests, tools --lineage-dir) are unaffected.
//
// STRICT C.1 (Sol consult 2026-10-07): a merely-present DISABLED config block
// must not redirect legacy execution — the config-supplied lineageDir is
// behaviourally relevant ONLY while at least one provenance flag is effectively
// enabled. All-off => env/default only, byte-identical legacy resolution.
export function resolveLineageDir() {
  const env = process.env.ORCH_LINEAGE_DIR;
  if (env != null && String(env).trim() !== "") return String(env);
  const f = flags();
  const anyEnabled = f.captureEnabled || f.invalidationEnabled || f.synthesisEnabled || f.retrievalFilterEnabled;
  if (anyEnabled) {
    const cfg = memoryProvenanceConfig().lineageDir;
    if (cfg != null && String(cfg).trim() !== "") return String(cfg);
  }
  return LINEAGE_DIR_DEFAULT;
}

const sha16 = (s) => createHash("sha256").update(String(s ?? "")).digest("hex").slice(0, 16);
const nowIso = () => new Date().toISOString();

// ---- IO: local dir or controller-backed (same fallback pattern as tombstones) --
function isRemote(dir) { return !existsSync(dir); }
function remoteExec(args, opts = {}) { return execFileSync("ssh", [SSH_HOST, ...args], { encoding: "utf8", timeout: 8000, ...opts }); }
// Confirmed absence is the ONLY failure this converts to null (Sol 2026-10-24):
// a missing optional lineage event must not be able to masquerade as an
// unreadable store. Permission, transport and other remote errors are rethrown
// so a verdict cannot be reported over data that was never read. stderr is
// captured here rather than inherited so the text cannot leak into the stdout
// stream that verdict parsers consume.
function remoteReadOrAbsent(p) {
  try {
    return execFileSync("ssh", [SSH_HOST, "cat", p], { encoding: "utf8", timeout: 8000, stdio: ["ignore", "pipe", "pipe"] });
  } catch (e) {
    const errText = String(e?.stderr ?? e?.message ?? "");
    if (/No such file or directory/.test(errText)) return null;
    const last = errText.trim().split("\n").filter(Boolean).slice(-1)[0] ?? "remote read failed";
    throw new Error(`LINEAGE_REMOTE_READ_FAILED: ${p}: ${last.slice(0, 160)}`);
  }
}
// Local-vs-remote follows the SAME parent-exists rule as readJsonFile/ensureDir
// (ticket 339 phase 0, G8): a not-yet-existing SUBDIR of a local dir (e.g.
// <lineageDir>/.events before first use) is LOCAL and simply empty — judging it
// remote sent the listing to controller, i.e. the wrong filesystem under the
// container runtime. Exported for the v44 regression test.
export function listJsonFiles(dir) {
  try {
    const clean = dir.replace(/\/+$/, "");
    const parent = clean.replace(/\/[^/]+$/, "");
    const local = existsSync(clean) || (parent && parent !== clean && existsSync(parent));
    if (!local) {
      const out = execFileSync("ssh", [SSH_HOST, `find '${dir.replace(/'/g, "'\\''")}' -maxdepth 1 -type f -name '*.json'`], { encoding: "utf8", timeout: 8000 });
      return out.split("\n").map((s) => s.trim()).filter(Boolean);
    }
    if (!existsSync(clean)) return []; // local dir not yet created = empty
    return readdirSync(clean).filter((f) => f.endsWith(".json")).map((f) => `${clean}/${f}`);
  } catch { return []; }
}
// Remote-ness is a property of the CONTAINING DIR (the lineage dir may be local
// tmp or controller-backed), never of one file: a missing file inside a LOCAL
// dir is simply absent (no sidecar = legacy_unknown), not a remote read.
function readJsonFile(p, strict = false) {
  try {
    // Local when the parent directory exists locally (tmp tests, or a locally
    // mounted lineage dir); otherwise controller-backed.
    const parent = p.replace(/\/[^/]+$/, "");
    let body;
    if (existsSync(parent)) {
      if (strict) {
        // A missing sidecar is legacy_unknown; a sidecar that exists but
        // cannot be read or parsed is NOT absence. Current-truth callers pass
        // strict=true so a corrupt/unreadable provenance record cannot become
        // a clean legacy_unknown verdict.
        try { body = readFileSync(p, "utf8"); }
        catch (e) { if (e?.code === "ENOENT") body = null; else throw e; }
      } else {
        body = existsSync(p) ? readFileSync(p, "utf8") : null;
      }
    } else {
      body = remoteReadOrAbsent(p);
    }
    return body == null ? null : JSON.parse(body);
  } catch (e) {
    // A real remote read failure is not absence and must not become a clean
    // verdict; current-truth reads are strict for the same reason. Other
    // callers retain the historical parse-error degradation.
    if (strict || String(e?.message ?? "").startsWith("LINEAGE_REMOTE_READ_FAILED")) throw e;
    console.error(`LINEAGE_SIDECAR_UNPARSABLE: ${p}: ${String(e?.message ?? e).slice(0, 120)}`);
    return null;
  }
}
// Atomic writes: local = tmp+rename. Remote = tee to a SIBLING tmp file then
// `mv` (same-dir rename, atomic on the host). Ticket 339 / Sol consult
// 2026-10-07: the previous plain `tee` was NOT atomic and a concurrent reader
// could observe a partial file — the old "readers never parse partial JSON"
// claim was wrong. With tmp+mv a reader sees either the old or the new complete
// file, and a failed transfer leaves the old file intact.
function writeJsonFile(p, obj) {
  const bytes = JSON.stringify(obj, null, 2) + "\n";
  const parent = p.replace(/\/[^/]+$/, "");
  if (existsSync(parent)) {
    const tmp = `${p}.tmp-${process.pid}`;
    writeFileSync(tmp, bytes);
    renameSync(tmp, p);
    return;
  }
  const tmp = `${p}.tmp-${process.pid}`;
  remoteExec(["tee", tmp], { input: bytes });
  remoteExec(["mv", tmp, p]);
}
function ensureDir(dir) {
  // Ticket 336: a not-yet-created SUBDIR (e.g. <lineageDir>/.events) of a LOCAL
  // dir is local, not controller-backed. Judging by the dir alone sent the mkdir
  // over ssh while the following write went local (ENOENT under container bun).
  const parent = dir.replace(/\/+$/, "").replace(/\/[^/]+$/, "");
  if (isRemote(dir) && !(parent && existsSync(parent))) { try { remoteExec(["mkdir", "-p", dir]); } catch { /* caller sees the write failure */ } }
  else mkdirSync(dir, { recursive: true });
}
function eventsDir(lineageDir) { return `${lineageDir.replace(/\/+$/, "")}/.events`; }

// ---- sidecar schema ----------------------------------------------------------
// {
//   schema: 1, recordId, recordKind: "concept"|"synthesis",
//   sourceClaimIds: [], sourceEvidence: [{kind,uri}...] (bounded mirrors),
//   derivedFrom: [], supersedesClaimId: null,
//   currentStateDependent: bool,          // plan §13 classification
//   lineageState: "known"|"legacy_unknown"|"invalid"|"stale",
//   recordedAt, valueDigest,
//   invalidation: null|{eventId, invalidatedAt, invalidatedBy},
//   supersession: null|{markedStaleAt, supersedingClaimId},
// }
export function recordLineageState(dir, recordId, strict = false) {
  const side = readJsonFile(`${dir.replace(/\/+$/, "")}/${recordId}.json`, strict);
  if (!side) return "legacy_unknown"; // no sidecar = predates lineage (plan §4.2)
  return LINEAGE_STATES.has(side.lineageState) ? side.lineageState : "legacy_unknown";
}

function normalizeIdList(v, label, problems) {
  if (v == null) return [];
  if (!Array.isArray(v)) { problems.push(`${label}: must be an array of record ids`); return []; }
  const out = [];
  for (const raw of v.slice(0, MAX_DIRECT_PARENTS)) {
    const id = String(raw ?? "").trim();
    if (!/^[A-Z][A-Za-z0-9]+$/.test(id)) { problems.push(`${label}: id not CamelCase: "${id.slice(0, 40)}"`); continue; }
    if (out.includes(id)) continue; // duplicates normalized away (plan §6.4)
    out.push(id);
  }
  if (Array.isArray(v) && v.length > MAX_DIRECT_PARENTS) problems.push(`${label}: exceeds ${MAX_DIRECT_PARENTS} direct parents (plan §29)`);
  return out;
}

// Pure validation of capture-time lineage INPUTS (plan §6.1-6.7). Parent
// existence / tombstone / invalid / cycle checks need IO and live in
// checkLineageParents + assertNoCycle below; this one is the shape gate.
export function validateLineageInputs({ recordId, sourceClaimIds, derivedFrom, supersedesClaimId, sourceEvidence } = {}) {
  const problems = [];
  if (!/^[A-Z][A-Za-z0-9]+$/.test(String(recordId ?? ""))) problems.push("recordId: CamelCase identifier required");
  const sources = normalizeIdList(sourceClaimIds, "sourceClaimIds", problems);
  const derived = normalizeIdList(derivedFrom, "derivedFrom", problems);
  let supersedes = null;
  if (supersedesClaimId != null) {
    supersedes = String(supersedesClaimId).trim();
    if (!/^[A-Z][A-Za-z0-9]+$/.test(supersedes)) problems.push(`supersedesClaimId: not CamelCase: "${supersedes.slice(0, 40)}"`);
  }
  // Self-reference rejection (plan §6.3).
  if (recordId && (sources.includes(recordId) || derived.includes(recordId) || supersedes === recordId)) {
    problems.push("self-reference rejected (a record cannot be its own ancestor)");
  }
  const evidence = [];
  if (sourceEvidence != null) {
    if (!Array.isArray(sourceEvidence)) problems.push("sourceEvidence: must be an array of provenance-style anchors");
    else for (const e of sourceEvidence.slice(0, 10)) {
      const uri = String(e?.uri ?? (typeof e === "string" ? e : "")).slice(0, 300);
      if (!uri) { problems.push("sourceEvidence: anchor without uri"); continue; }
      evidence.push({ kind: String(e?.kind ?? "live-evidence").slice(0, 30), uri });
    }
  }
  return { ok: problems.length === 0, problems, sources, derived, supersedes, evidence };
}

// IO-bound parent checks (plan §6.2, §6.5-6.7): every referenced parent must
// EXIST, must not be tombstoned as a record, must not carry lineageState=invalid,
// and must not itself be a synthesis record (trust boundary §28: synthesis is
// never evidence for a durable claim).
//   parentExists(id) -> bool           (concept capsule or synthesis record exists)
//   parentIsTombstoned(id) -> bool     (active tombstone naming that record)
//   synthesisIds -> Set                (recordKind=synthesis sidecar ids)
export function checkLineageParents({ sources, derived, parentExists, parentIsTombstoned, lineageDir }) {
  const problems = [];
  const all = [...new Set([...sources, ...derived])];
  for (const id of all) {
    if (parentExists && !parentExists(id)) { problems.push(`parent does not exist: ${id}`); continue; }
    if (parentIsTombstoned && parentIsTombstoned(id)) { problems.push(`parent is tombstoned: ${id} (plan §6.5 — capture a superseding record instead)`); continue; }
    const st = recordLineageState(lineageDir, id);
    if (st === "invalid") problems.push(`parent lineageState=invalid: ${id} (plan §6.6)`);
  }
  for (const id of derived) {
    const side = readJsonFile(`${lineageDir.replace(/\/+$/, "")}/${id}.json`);
    if (side?.recordKind === "synthesis") problems.push(`derivedFrom references a synthesis record: ${id} (synthesis is never a durable parent — plan §28)`);
  }
  return { ok: problems.length === 0, problems };
}

// Bounded DFS reachability (plan §7): can `from` already reach `target` through
// derivedFrom edges? Exceeding MAX_TRAVERSAL_DEPTH is itself a rejection signal
// (pathological growth) — returns { cycle:bool, depthExceeded:bool }.
export function reachable(from, target, childrenOf, { maxDepth = MAX_TRAVERSAL_DEPTH } = {}) {
  const seen = new Set();
  const dfs = (node, depth) => {
    if (depth > maxDepth) return "depth";
    if (node === target) return "cycle";
    if (seen.has(node)) return null;
    seen.add(node);
    for (const child of childrenOf(node) ?? []) {
      const r = dfs(child, depth + 1);
      if (r) return r;
    }
    return null;
  };
  const r = dfs(from, 0);
  return { cycle: r === "cycle", depthExceeded: r === "depth" };
}

export function parentsOf(recordId, lineageDir = resolveLineageDir()) {
  const side = readJsonFile(`${lineageDir.replace(/\/+$/, "")}/${recordId}.json`);
  if (!side) return { ok: true, parents: [] };
  return { ok: true, parents: [...new Set([...(side.derivedFrom ?? []), ...(side.sourceClaimIds ?? [])])] };
}

export function childrenOf(recordId, lineageDir = resolveLineageDir()) {
  const kids = [];
  for (const p of listJsonFiles(lineageDir)) {
    const side = readJsonFile(p);
    if (!side || side.recordId == null) continue;
    if ((side.derivedFrom ?? []).includes(recordId) || (side.sourceClaimIds ?? []).includes(recordId)) kids.push(side.recordId);
  }
  return { ok: true, children: kids };
}

// Bounded BFS ancestor/descendant traversal (plan §9) over the two primitives.
export function getAncestors(recordId, lineageDir = resolveLineageDir(), { maxDepth = MAX_TRAVERSAL_DEPTH } = {}) {
  const out = new Set(); let depthExceeded = false; let frontier = [recordId];
  for (let d = 0; d < maxDepth && frontier.length; d++) {
    const next = [];
    for (const n of frontier) {
      for (const p of parentsOf(n, lineageDir).parents ?? []) {
        if (p === recordId) return { ok: false, code: "CYCLE_DETECTED", ancestors: [...out], depthExceeded };
        if (!out.has(p)) { out.add(p); next.push(p); }
      }
    }
    frontier = next;
  }
  if (frontier.length) depthExceeded = true;
  return { ok: true, ancestors: [...out], depthExceeded };
}

export function getDescendants(recordId, lineageDir = resolveLineageDir(), { maxDepth = MAX_TRAVERSAL_DEPTH } = {}) {
  const out = new Set(); let depthExceeded = false; let frontier = [recordId];
  for (let d = 0; d < maxDepth && frontier.length; d++) {
    const next = [];
    for (const n of frontier) {
      for (const c of childrenOf(n, lineageDir).children ?? []) {
        if (c === recordId) return { ok: false, code: "CYCLE_DETECTED", descendants: [...out], depthExceeded };
        if (!out.has(c)) { out.add(c); next.push(c); }
      }
    }
    frontier = next;
  }
  if (frontier.length) depthExceeded = true;
  return { ok: true, descendants: [...out], depthExceeded };
}

// ---- capture-time lineage recording (plan §6.8; flag matrix Sol C) -------------
// Called by captureConcept BEFORE the rql write with the candidate's optional
// lineage inputs. Flag matrix:
//   flag OFF + no inputs          -> {ok, skipped:"flag-off"}   (legacy path)
//   flag OFF + inputs supplied    -> REJECT (fail closed — never accept an
//                                    asserted derivation without validation)
//   flag ON  + no inputs          -> {ok, direct:true}          (non-derived capture)
//   flag ON  + inputs             -> full validation; failure REJECTS the capture
//                                    (plan §27: derived records fail closed)
export function captureLineageGate({ recordId, sourceClaimIds, derivedFrom, supersedesClaimId, sourceEvidence, lineageDir = resolveLineageDir(), parentExists = null, parentIsTombstoned = null } = {}) {
  const { captureEnabled } = flags();
  const hasInputs = (sourceClaimIds?.length ?? 0) + (derivedFrom?.length ?? 0) + (Array.isArray(sourceEvidence) ? sourceEvidence.length : 0) > 0 || supersedesClaimId != null;
  if (!captureEnabled) {
    if (hasInputs) return { ok: false, code: "LINEAGE_CAPTURE_DISABLED", detail: "lineage inputs supplied while memoryLineageCapture.enabled=false — derived material is rejected fail-closed (plan §27/§34)" };
    return { ok: true, skipped: "flag-off", direct: true };
  }
  const shape = validateLineageInputs({ recordId, sourceClaimIds, derivedFrom, supersedesClaimId, sourceEvidence });
  if (!shape.ok) { lineageRejectedEvent(recordId, shape.problems, lineageDir); return { ok: false, code: "INVALID_LINEAGE", detail: shape.problems.join("; ") }; }
  const parents = checkLineageParents({ sources: shape.sources, derived: shape.derived, parentExists, parentIsTombstoned, lineageDir });
  if (!parents.ok) { lineageRejectedEvent(recordId, parents.problems, lineageDir); return { ok: false, code: "LINEAGE_PARENTS_INVALID", detail: parents.problems.join("; ") }; }
  if (shape.derived.length) {
    for (const parent of shape.derived) {
      // Adding edge parent->child closes a cycle iff the CHILD already reaches
      // the PARENT through existing descent edges (parent would become both
      // ancestor and descendant of itself). reachable() walks childrenOf().
      const r = reachable(recordId, parent, (n) => childrenOf(n, lineageDir).children ?? []);
      if (r.cycle) { lineageRejectedEvent(recordId, [`cycle: ${parent} already reaches ${recordId}`], lineageDir); return { ok: false, code: "LINEAGE_CYCLE", detail: `adding derivedFrom ${parent} would create a cycle (plan §7)` }; }
      if (r.depthExceeded) { lineageRejectedEvent(recordId, ["traversal depth bound exceeded"], lineageDir); return { ok: false, code: "LINEAGE_DEPTH_BOUND", detail: `lineage graph exceeds ${MAX_TRAVERSAL_DEPTH} depth bound near ${parent} (plan §7)` }; }
    }
  }
  return { ok: true, direct: !hasInputs, validated: shape };
}

function lineageRejectedEvent(recordId, problems, lineageDir = null) {
  journalEvent(`memory_lineage_rejected: ${recordId} — ${String(problems?.[0] ?? "unknown").slice(0, 160)}`, lineageDir);
}

// Persist the sidecar AFTER the durable record exists (captureConcept success
// path). Idempotent: re-capture of the same identity rewrites the same sidecar.
export function recordDerivation({ recordId, recordKind = "concept", sources, derived, supersedes = null, evidence = [], valueDigest = null, currentStateDependent = false, lineageDir = resolveLineageDir(), dryRun = false } = {}) {
  const sidecar = {
    schema: 1, recordId, recordKind,
    sourceClaimIds: sources ?? [], sourceEvidence: evidence ?? [],
    derivedFrom: derived ?? [], supersedesClaimId: supersedes,
    currentStateDependent: Boolean(currentStateDependent),
    lineageState: "known", recordedAt: nowIso(), valueDigest: valueDigest ?? null,
    invalidation: null, supersession: null,
  };
  if (dryRun) return { ok: true, dryRun: true, sidecar };
  try {
    ensureDir(lineageDir);
    writeJsonFile(`${lineageDir.replace(/\/+$/, "")}/${recordId}.json`, sidecar);
  } catch (e) {
    return { ok: false, code: "LINEAGE_WRITE_FAILED", detail: String(e?.message ?? e).slice(0, 140) };
  }
  journalEvent(`memory_lineage_created: ${recordId} (${recordKind}; sources ${sidecar.sourceClaimIds.join(",") || "-"}; derivedFrom ${sidecar.derivedFrom.join(",") || "-"})`, lineageDir);
  return { ok: true, sidecar };
}

// ---- explain (plan §8): READ-ONLY, deterministic, no LLM, no mutation ----------
// Local YAML-lite frontmatter parser (line-based, same discipline as the gate's
// parseCapsule — duplicated here deliberately to keep this module a leaf with no
// gate-plane import cycle).
function parseCapsuleLite(body) {
  const out = { title: null, description: null, category: null, verification: null, ttl: null, verifiedDate: null };
  if (body == null) return out;
  const text = String(body);
  const titleM = text.match(/^#\s+(.+)$/m);
  if (titleM) out.title = titleM[1].trim();
  const fm = text.match(/^---\n([\s\S]*?)\n---/);
  if (!fm) return out;
  let inVerified = false;
  for (const line of fm[1].split("\n")) {
    const kv = line.match(/^(\w[\w-]*):\s*(.*)$/);
    if (!kv) continue;
    const k = kv[1]; const v = String(kv[2]).trim().replace(/^["']|["']$/g, "");
    if (k === "verified") { inVerified = true; continue; }
    if (inVerified && k === "date") { out.verifiedDate = v; inVerified = false; continue; }
    inVerified = false;
    if (k === "description") out.description = v;
    else if (k === "category") out.category = v;
    else if (k === "verification") out.verification = v;
    else if (k === "ttl") out.ttl = Number(v) || null;
  }
  return out;
}

export function explainMemory({ recordId, conceptsDir, lineageDir = resolveLineageDir(), tombstonesDir = null } = {}) {
  const out = { recordId, ok: true, found: false };
  // capsule frontmatter (if a concept)
  let capBody = null;
  if (conceptsDir) {
    const p = findCapsuleFile(conceptsDir, recordId);
    if (p) {
      capBody = isRemote(p) ? (() => { try { return remoteExec(["cat", p]); } catch { return null; } })() : (() => { try { return readFileSync(p, "utf8"); } catch { return null; } })();
      if (capBody != null) {
        const cap = parseCapsuleLite(capBody);
        out.found = true; out.kind = "concept"; out.file = p;
        out.valueSummary = cap.description ?? null;
        out.category = cap.category; out.verification = cap.verification;
        out.ttl = cap.ttl; out.verifiedDate = cap.verifiedDate;
        out.recordedAt = null; out.validFrom = null; out.validTo = null;
        const tfm = capBody.match(/^---\n([\s\S]*?)\n---/);
        if (tfm) {
          for (const line of tfm[1].split("\n")) {
            const kv = line.match(/^(validFrom|validTo|recordedAt):\s*(.*)$/);
            if (kv) out[kv[1]] = kv[2].trim() || null;
          }
        }
      }
    }
  }
  const side = readJsonFile(`${lineageDir.replace(/\/+$/, "")}/${recordId}.json`);
  if (side) {
    out.found = true; out.kind = side.recordKind ?? out.kind ?? "unknown";
    out.lineageState = LINEAGE_STATES.has(side.lineageState) ? side.lineageState : "legacy_unknown";
    out.sourceClaimIds = side.sourceClaimIds ?? [];
    out.sourceEvidence = side.sourceEvidence ?? [];
    out.derivedFrom = side.derivedFrom ?? [];
    out.supersedesClaimId = side.supersedesClaimId ?? null;
    out.currentStateDependent = Boolean(side.currentStateDependent);
    out.lineageRecordedAt = side.recordedAt ?? null;
    out.valueDigest = side.valueDigest ?? null;
    out.invalidation = side.invalidation ?? null;
    out.supersession = side.supersession ?? null;
  } else {
    out.lineageState = "legacy_unknown";
    out.sourceClaimIds = []; out.sourceEvidence = []; out.derivedFrom = [];
    out.supersedesClaimId = null;
  }
  // tombstone state (active tombstone naming this record)
  out.tombstoneState = "none";
  if (tombstonesDir) {
    const tdir = `${tombstonesDir.replace(/\/+$/, "")}`;
    const files = listMdFiles(tdir);
    for (const f of files) {
      const t = parseTombstone(isRemote(f) ? (() => { try { return remoteExec(["cat", f]); } catch { return null; } })() : readFileSync(f, "utf8"));
      if (t && String(t.status ?? "active") === "active" && canonicalish(t.subject) === canonicalish(recordId)) { out.tombstoneState = "tombstoned"; out.tombstoneFile = f; break; }
    }
  }
  // dependants + current superseding claim
  const kids = childrenOf(recordId, lineageDir).children ?? [];
  out.dependantCount = kids.length;
  out.dependants = kids.slice(0, 20);
  const kidsSide = kids.map((k) => readJsonFile(`${lineageDir.replace(/\/+$/, "")}/${k}.json`)).filter(Boolean);
  const sup = kidsSide.find((s) => s.supersedesClaimId === recordId)
    ?? listJsonFiles(lineageDir).map((p) => readJsonFile(p)).find((s) => s?.supersedesClaimId === recordId);
  out.currentSupersedingClaim = sup?.recordId ?? null;
  if (!out.found) out.note = "no capsule or lineage sidecar found for this id (legacy records without lineage explain as legacy_unknown with capsule metadata when the capsule exists)";
  return out;
}

const canonicalish = (s) => String(s ?? "").toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();

function execQuiet(args) {
  // stderr piped (never inherited): an absent dir (no tombstones yet) is a
  // normal empty result, not terminal noise.
  try { return execFileSync(args[0], args.slice(1), { encoding: "utf8", timeout: 8000, stdio: ["ignore", "pipe", "pipe"] }); }
  catch (e) { return e?.stdout ?? null; }
}
function listMdFiles(dir, { deep = false } = {}) {
  try {
    if (isRemote(dir)) {
      const depth = deep ? 4 : 1; // concepts tree nests one category level
      return execQuiet(["ssh", SSH_HOST, `find '${dir.replace(/'/g, "'\''")}' -maxdepth ${depth} -type f -name '*.md'`])?.split("\n").map((x) => x.trim()).filter(Boolean) ?? [];
    }
    if (!deep) return readdirSync(dir).filter((f) => f.endsWith(".md")).map((f) => `${dir.replace(/\/+$/, "")}/${f}`);
    const acc = [];
    const walk = (d, depth) => {
      if (depth > 4) return;
      let ents = []; try { ents = readdirSync(d, { withFileTypes: true }); } catch { return; }
      for (const e of ents) {
        const p = `${d}/${e.name}`;
        if (e.isDirectory()) walk(p, depth + 1);
        else if (e.name.endsWith(".md")) acc.push(p);
      }
    };
    walk(dir, 0);
    return acc;
  } catch { return []; }
}

function findCapsuleFile(conceptsDir, name) {
  try {
    for (const p of listMdFiles(conceptsDir, { deep: true })) if (p.endsWith(`/${name}.md`)) return p;
  } catch { /* unreadable tree -> not found */ }
  return null;
}

// ---- invalidation events (plan §10-12; Sol gate B) ------------------------------
// ONE durable event per tombstone with a STABLE eventId; per-descendant state
// lives in each sidecar; the tombstone frontmatter gets only an AGGREGATE line.
export function invalidationEventId(tombstoneName) { return `inv-${String(tombstoneName)}`; }

export function writeInvalidationEvent({ tombstoneName, sourceClaimId, tombstoneRecordedAt = null, lineageDir = resolveLineageDir(), status = "pending" } = {}) {
  const id = invalidationEventId(tombstoneName);
  const dir = eventsDir(lineageDir);
  ensureDir(dir);
  const p = `${dir}/${id}.json`;
  const existing = readJsonFile(p);
  // Stable eventId per tombstone (Sol gate B). A governed tombstone RETIREMENT
  // followed by a NEW active tombstone of the same name must not inherit the old
  // event's complete state: a changed tombstone recordedAt starts a fresh event
  // (fresh attemptCount/cursor; already-invalid sidecars re-mark as no-ops).
  const staleComplete = existing?.status === "complete"
    && tombstoneRecordedAt != null && existing.tombstoneRecordedAt != null
    && existing.tombstoneRecordedAt !== tombstoneRecordedAt;
  const ev = (!existing || staleComplete) ? {
    schema: 1, eventId: id, sourceClaimId, tombstoneName,
    status: "pending", attemptCount: 0, createdAt: nowIso(), cursor: 0, completedAt: null,
  } : { ...existing };
  ev.sourceClaimId = ev.sourceClaimId ?? sourceClaimId;
  ev.tombstoneName = ev.tombstoneName ?? tombstoneName;
  if (tombstoneRecordedAt != null) ev.tombstoneRecordedAt = tombstoneRecordedAt;
  if (status && ev.status !== "complete") ev.status = status;
  writeJsonFile(p, ev);
  return ev;
}

export function readInvalidationEvent(tombstoneName, lineageDir = resolveLineageDir()) {
  return readJsonFile(`${eventsDir(lineageDir)}/${invalidationEventId(tombstoneName)}.json`);
}

export function listPendingInvalidations(lineageDir = resolveLineageDir()) {
  const dir = eventsDir(lineageDir);
  const out = [];
  for (const p of listJsonFiles(dir)) {
    const ev = readJsonFile(p);
    if (ev && (ev.status === "pending" || ev.status === "processing" || ev.status === "failed")) out.push(ev);
  }
  return out.sort((a, b) => String(a.createdAt).localeCompare(String(b.createdAt)));
}

// Process ONE invalidation event. Idempotent + resumable (plan §11/§26/§33):
//   - tombstone commit already happened BEFORE this is ever called
//   - marking a descendant invalid happens BEFORE any expensive work (plan §12)
//   - an already-invalid sidecar is left untouched (no duplicate events/edges)
//   - re-running recomputes the descendant set and finishes the remainder
// deps: { markInvalid(recordId, evt) -> bool, sourceIsTombstoned() -> bool }
export function processInvalidationEvent({ tombstoneName, lineageDir = resolveLineageDir(), maxBatch = MAX_INVALIDATION_BATCH, markInvalid = null } = {}) {
  const { invalidationEnabled } = flags();
  const ev = readInvalidationEvent(tombstoneName, lineageDir);
  if (!ev) return { ok: false, code: "EVENT_NOT_FOUND", detail: tombstoneName };
  if (!markInvalid) return { ok: false, code: "NO_MARK_FN", detail: "markInvalid dependency required" };
  if (ev.status === "complete") return { ok: true, alreadyComplete: true, eventId: ev.eventId, processed: 0 };
  if (!invalidationEnabled) return { ok: false, code: "INVALIDATION_DISABLED", detail: "memoryLineageInvalidation.enabled=false (plan §24)" };
  ev.status = "processing"; ev.attemptCount = (ev.attemptCount ?? 0) + 1; ev.lastAttemptAt = nowIso();
  writeJsonFile(eventsDir(lineageDir) + "/" + ev.eventId + ".json", ev);
  journalEvent(`memory_invalidation_started: ${ev.eventId} (source ${ev.sourceClaimId}, attempt ${ev.attemptCount})`, lineageDir);
  // Fresh traversal every attempt (plan §26/§33): new descendants captured since
  // the last attempt are picked up; already-marked ones are no-ops (idempotent).
  const desc = getDescendants(ev.sourceClaimId, lineageDir);
  if (!desc.ok) {
    ev.status = "failed"; writeJsonFile(eventsDir(lineageDir) + "/" + ev.eventId + ".json", ev);
    journalEvent(`memory_invalidation_failed: ${ev.eventId} — ${desc.code ?? "traversal error"}`, lineageDir);
    return { ok: false, code: desc.code ?? "TRAVERSAL_FAILED", eventId: ev.eventId };
  }
  const errors = [];
  let processed = 0;
  // Plan §3 removal order: the SOURCE is marked invalid BEFORE dependants are
  // discovered/processed (correctness ahead of availability, plan §12). Source
  // without a sidecar = legacy record: the tombstone VALUE plane already bans
  // its claim at every capture path, so there is nothing to mark here.
  let sourceMarked = false;
  try { sourceMarked = markInvalid(ev.sourceClaimId, ev); }
  catch (e) { errors.push(`source ${ev.sourceClaimId}: ${String(e?.message ?? e).slice(0, 80)}`); }
  const stateOfDescendant = (d) => {
    const side = readJsonFile(`${lineageDir.replace(/\/+$/, "")}/${d}.json`);
    if (!side) return "legacy"; // legacy sidecar-less descendant: satisfied by definition
    return side.lineageState;
  };
  // Batch window = UNSATISFIED descendants first (§33 lesson: a satisfied head
  // must never occupy the batch slot — interrupted invalidation must advance).
  const unsatisfiedBefore = desc.descendants.filter((d) => stateOfDescendant(d) !== "invalid");
  for (const d of unsatisfiedBefore.slice(0, maxBatch)) {
    try { if (markInvalid(d, ev)) processed++; }
    catch (e) { errors.push(`${d}: ${String(e?.message ?? e).slice(0, 80)}`); }
  }
  // Completion = EVERY descendant satisfied (invalid, or legacy sidecar-less —
  // nothing on the lineage plane to invalidate for it). Never inferred from the
  // mark count: an already-marked descendant returns false from markInvalid and
  // must not be counted as remaining work (idempotent re-runs stay no-ops).
  const unsatisfied = desc.descendants.filter((d) => stateOfDescendant(d) !== "invalid");
  ev.cursor = desc.descendants.length - unsatisfied.length;
  if (unsatisfied.length > 0) {
    // Partial pass: stay processing (durable pending work), never complete
    // (plan §10: the tombstone itself never depends on this succeeding).
    writeJsonFile(eventsDir(lineageDir) + "/" + ev.eventId + ".json", ev);
    journalEvent(`memory_invalidation_pending: ${ev.eventId} — ${unsatisfied.length} descendant(s) still unsatisfied (${errors.length} error(s))`, lineageDir);
    return { ok: true, partial: true, processed, remaining: unsatisfied.length, eventId: ev.eventId, errors: errors.slice(0, 5) };
  }
  ev.status = "complete"; ev.completedAt = nowIso();
  writeJsonFile(eventsDir(lineageDir) + "/" + ev.eventId + ".json", ev);
  journalEvent(`memory_invalidation_completed: ${ev.eventId} — ${processed} marked this attempt, ${desc.descendants.length} total descendant(s)`, lineageDir);
  return { ok: true, complete: true, processed, sourceMarked, total: desc.descendants.length, eventId: ev.eventId, errors: errors.slice(0, 5) };
}

// The per-descendant marker used with processInvalidationEvent. Sets
// lineageState=invalid + records WHICH event did it (idempotent by event id).
export function markDescendantInvalid(recordId, ev, { lineageDir = resolveLineageDir() } = {}) {
  const p = `${lineageDir.replace(/\/+$/, "")}/${recordId}.json`;
  const side = readJsonFile(p);
  if (!side) {
    // A descendant without a sidecar is legacy_unknown — it has no recorded
    // derivation, so there is nothing to invalidate on the lineage plane. The
    // tombstone itself still bans the VALUE at capture (value plane). Not an error.
    return false;
  }
  if (side.invalidation?.eventId === ev.eventId && side.lineageState === "invalid") return false; // already marked by this event
  side.lineageState = "invalid";
  side.invalidation = { eventId: ev.eventId, invalidatedAt: nowIso(), invalidatedBy: ev.tombstoneName ?? ev.sourceClaimId ?? "tombstone" };
  writeJsonFile(p, side);
  return true;
}

// Supersession stale propagation (plan §13, §32; phase 10). Historical-safe
// records are left alone; current_state_dependent records go stale. Review
// recomputes (machinery never rewrites knowledge — Sol contract, ticket 180).
export function markSupersessionStale({ sourceClaimId, supersedingClaimId, lineageDir = resolveLineageDir() } = {}) {
  const { invalidationEnabled } = flags();
  if (!invalidationEnabled) return { ok: false, code: "INVALIDATION_DISABLED" };
  const desc = getDescendants(sourceClaimId, lineageDir);
  if (!desc.ok) return { ok: false, code: desc.code ?? "TRAVERSAL_FAILED" };
  const staled = [];
  for (const d of desc.descendants) {
    const p = `${lineageDir.replace(/\/+$/, "")}/${d}.json`;
    const side = readJsonFile(p);
    if (!side || !side.currentStateDependent) continue; // historical_safe (plan §13)
    if (d === supersedingClaimId || side.supersedesClaimId === sourceClaimId) continue; // the replacement becomes current, never stale (plan §32)
    if (side.lineageState === "invalid") continue;
    if (side.supersession?.supersedingClaimId === supersedingClaimId && side.lineageState === "stale") continue; // idempotent
    side.lineageState = "stale";
    side.supersession = { markedStaleAt: nowIso(), supersedingClaimId: supersedingClaimId ?? null };
    writeJsonFile(p, side);
    staled.push(d);
  }
  for (const s of staled) journalEvent(`memory_synthesis_stale: ${s} (superseded by ${supersedingClaimId ?? "?"})`, lineageDir);
  return { ok: true, staled, unchanged: desc.descendants.length - staled.length };
}

// ---- retrieval protection (plan §12/§19) ----------------------------------------
// Centralized filter for CURRENT-truth reads: invalid and stale records never
// surface as current knowledge; legacy_unknown and known pass unchanged
// (plan §19). Historical queries bypass this helper BY CALLING IT NOT AT ALL —
// exclusion is opt-in at the current-truth call sites, never a global rewrite.
export function excludeInvalidFromCurrentRetrieval(recordNames, lineageDir = resolveLineageDir()) {
  const excluded = [];
  const kept = [];
  for (const n of recordNames ?? []) {
    const st = recordLineageState(lineageDir, n, true);
    if (st === "invalid" || st === "stale") excluded.push({ name: n, state: st });
    else kept.push(n);
  }
  return { kept, excluded };
}

// ---- integrity checker (plan §22): read-only, PASS/WARN/FAIL ---------------------
export function lineageIntegrityCheck({ lineageDir = resolveLineageDir(), conceptsDir = null, tombstonesDir = null, maxRecords = 500 } = {}) {
  const findings = [];
  let scanned = 0; let legacy = 0;
  const sides = [];
  for (const p of listJsonFiles(lineageDir).slice(0, maxRecords)) {
    const side = readJsonFile(p);
    if (!side?.recordId) { findings.push({ severity: "FAIL", code: "SIDECAR_UNPARSABLE", detail: p }); continue; }
    sides.push(side); scanned++;
  }
  const byId = new Map(sides.map((s) => [s.recordId, s]));
  for (const side of sides) {
    const id = side.recordId;
    const allParents = [...new Set([...(side.sourceClaimIds ?? []), ...(side.derivedFrom ?? [])])];
    for (const p of allParents) {
      if (p === id) findings.push({ severity: "FAIL", code: "SELF_REFERENCE", detail: id });
      if (!byId.has(p)) {
        // parent without sidecar: exists only if a capsule exists (or is a
        // source-claim of a direct capture). Verify via conceptsDir when given.
        if (conceptsDir && !findCapsuleFile(conceptsDir, p)) findings.push({ severity: "FAIL", code: "MISSING_PARENT", detail: `${id} -> ${p}` });
        else if (!conceptsDir) findings.push({ severity: "WARN", code: "PARENT_LINEAGE_LEGACY", detail: `${id} -> ${p} (parent has no sidecar; legacy direct capture)` });
      }
      const ps = byId.get(p);
      if (ps?.lineageState === "invalid") {
        // an invalid parent must not have an ACTIVE (non-invalid) current dependant
        if (side.lineageState !== "invalid" && side.lineageState !== "stale") findings.push({ severity: "FAIL", code: "ACTIVE_DESCENDANT_OF_INVALID", detail: `${id} is ${side.lineageState} but parent ${p} is invalid` });
      }
      if (ps?.recordKind === "synthesis" && (side.derivedFrom ?? []).includes(p)) findings.push({ severity: "FAIL", code: "SYNTHESIS_AS_PARENT", detail: `${id} derives from synthesis ${p} (plan §28)` });
    }
    if (side.lineageState === "invalid" && !side.invalidation?.eventId) findings.push({ severity: "WARN", code: "INVALID_WITHOUT_EVENT", detail: `${id} invalid without invalidation event reference` });
    if (side.recordKind === "synthesis" && !(side.sourceClaimIds ?? []).length) findings.push({ severity: "FAIL", code: "SYNTHESIS_WITHOUT_SOURCES", detail: id });
  }
  // active descendants of tombstoned sources + completed events
  if (tombstonesDir) {
    for (const f of listMdFiles(tombstonesDir)) {
      const t = parseTombstone(isRemote(f) ? (() => { try { return remoteExec(["cat", f]); } catch { return null; } })() : readFileSync(f, "utf8"));
      if (!t || String(t.status ?? "active") !== "active") continue;
      const ev = readInvalidationEvent(t.name, lineageDir);
      if (!ev) continue; // tombstone predates invalidation wiring (legacy_unknown plane)
      const desc = getDescendants(ev.sourceClaimId, lineageDir);
      if (!desc.ok) { findings.push({ severity: "FAIL", code: "TRAVERSAL_FAILED", detail: `${t.name}: ${desc.code}` }); continue; }
      if (ev.status === "complete") {
        for (const d of desc.descendants) {
          const st = byId.get(d)?.lineageState ?? recordLineageState(lineageDir, d);
          if (st === "known") findings.push({ severity: "FAIL", code: "ACTIVE_DESCENDANT_OF_TOMBSTONE", detail: `${d} is current but source of ${t.name} is tombstoned` });
        }
      }
    }
  }
  // legacy_unknown is NEVER a failure (plan §22)
  for (const n of (conceptsDir ? listMdFiles(conceptsDir, { deep: true }) : [])) {
    const name = (n.split("/").pop() ?? "").replace(/\.md$/, "");
    if (!name || byId.has(name)) continue;
    legacy++;
  }
  const verdict = findings.some((f) => f.severity === "FAIL") ? "FAIL" : (findings.length ? "WARN" : "PASS");
  if (verdict === "FAIL") journalEvent(`memory_lineage_integrity_failed: ${findings.filter((f) => f.severity === "FAIL").length} FAIL finding(s)`, lineageDir);
  return { verdict, scanned, legacyUnknown: legacy, findings };
}

// ---- best-effort journal (same discipline as memory-tombstone.fleetLogEvent) ----
// Dir-aware: events are journaled ONLY for the REAL lineage dir — tmp/test dirs
// (unit tests, sandboxes) stay completely silent and never SSH (offline tests).
// ORCH_LINEAGE_JOURNAL=off force-disables for hermetic environments.
function journalEvent(text, dir = null) {
  if (String(process.env.ORCH_LINEAGE_JOURNAL ?? "").toUpperCase() === "OFF") return false;
  if (dir != null && String(dir).replace(/\/+$/, "") !== resolveLineageDir().replace(/\/+$/, "")) return false;
  try {
    // Ticket 719 (Sol F1): quote the note for the remote shell - ssh re-joins
    // argv and the remote shell re-parses it; free text with parentheses died
    // as a bash syntax error (live 2026-10-17).
    const note = String(text).slice(0, 1400).replace(/'/g, "'\\''");
    execFileSync("ssh", [SSH_HOST, `fleet-log --source agent --type note '${note}'`], { encoding: "utf8", timeout: 15000 });
    return true;
  } catch { return false; }
}
