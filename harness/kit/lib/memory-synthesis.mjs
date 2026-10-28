// lib/memory-synthesis.mjs — structured synthesis (hub ticket 305, operator plan
// §14-16; Sol gate E: synthesis ships LAST — never ahead of invalidation or
// retrieval filtering). Synthesis COMPRESSES known current state; it never
// invents knowledge, never analyses personality, never predicts (plan §15).
//
// Trust boundary (plan §28 + Sol): synthesis is derived material with
// recordKind="synthesis" in its lineage sidecar. It can NEVER be a parent of a
// durable claim (memory-lineage.checkLineageParents rejects recordKind=synthesis
// as a derivedFrom parent), never verifies anything, never promotes itself to
// evidence. Output without valid sourceClaimIds is REFUSED — every synthesis
// item must be regenerable entirely from its source claims.
//
// Deterministic by construction: this module assembles structured records from
// verified durable inputs (concept capsules with anchored verification, valid
// lineage state). No LLM is required or consulted; a model may summarize the
// OUTPUT for humans elsewhere, but these records are mechanical compressions.
//
// Feature flag: memoryStructuredSynthesis.enabled (ORCH_MEMORY_SYNTHESIS=ENABLED).
// Default OFF. Generation is manual-first (plan §23 phases 11-12): run the tool,
// inspect outputs, verify every item carries sourceClaimIds, only then schedule.
// Scheduled generation reuses the existing host cron mechanism — this module
// introduces NO daemon and NO scheduler (plan §2/§17).
import { createHash } from "node:crypto";
import { existsSync, readFileSync, writeFileSync, readdirSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { recordDerivation, recordLineageState, getDescendants, flags as lineageFlags, LINEAGE_DIR_DEFAULT } from "./memory-lineage.mjs";
import { evaluateTombstones, claimIsRejected } from "./memory-tombstone.mjs";

export const SYNTHESIS_TYPES = new Set([
  "current_preferences", "active_projects", "open_decisions", "known_conflicts",
  "operator_constraints", "recent_supersessions", "unfinished_work",
]);
const SYNTHESIS_ID_PREFIX = "Syn";
const MAX_SOURCES_PER_ITEM = 32;
const sha16 = (s) => createHash("sha256").update(String(s ?? "")).digest("hex").slice(0, 16);
const nowIso = () => new Date().toISOString();

// One synthesized item's spec. `sources` MUST be non-empty for every record this
// generator emits (plan §14: sourceClaimIds.length > 0; non-factual commentary
// is excluded from durable retrieval and is therefore never persisted here).
export function validateSynthesisSpec(spec = {}) {
  const problems = [];
  const type = String(spec.type ?? "");
  if (!SYNTHESIS_TYPES.has(type)) problems.push(`type not in enum: ${type} (plan §15 initial categories only)`);
  const summary = String(spec.summary ?? "").trim();
  if (summary.length < 8) problems.push("summary: required (8+ chars)");
  const sources = Array.isArray(spec.sourceClaimIds) ? spec.sourceClaimIds.map(String) : [];
  if (!sources.length) problems.push("sourceClaimIds: synthesis requires at least one valid source claim (plan §14)");
  if (sources.length > MAX_SOURCES_PER_ITEM) problems.push(`sourceClaimIds: exceeds ${MAX_SOURCES_PER_ITEM}`);
  if (new Set(sources).size !== sources.length) problems.push("sourceClaimIds: duplicates not allowed");
  return { ok: problems.length === 0, problems, type, summary, sources };
}

// Persist one synthesis record: lineage sidecar (recordKind="synthesis",
// lineageState "known") + the synthesis document returned to the caller for
// inspection. The document lives OUTSIDE the concept tree (synthesis is never a
// capsule, never indexed as positive knowledge); the sidecar in the lineage dir
// is the invalidation/staleness control plane.
//   deps.parentExists(id) -> bool       (durable concept capsule exists)
//   deps.parentLineageState(id) -> state (defaults to the sidecar read)
export function createSynthesisRecord({ type, summary, sourceClaimIds, lineageDir = LINEAGE_DIR_DEFAULT, validUntil = null, dryRun = false, deps = {} } = {}) {
  const { synthesisEnabled } = lineageFlags();
  if (!synthesisEnabled) return { ok: false, code: "SYNTHESIS_DISABLED", detail: "memoryStructuredSynthesis.enabled=false (plan §24)" };
  const v = validateSynthesisSpec({ type, summary, sourceClaimIds });
  if (!v.ok) return { ok: false, code: "INVALID_SYNTHESIS", detail: v.problems.join("; ") };
  // Source validity at GENERATION time (plan §16): every source must exist and
  // be currently valid on the lineage plane (invalid/stale sources are refused —
  // stale synthesis is an OUTPUT state after the fact, never an input state).
  for (const s of v.sources) {
    if (deps.parentExists && !deps.parentExists(s)) return { ok: false, code: "SOURCE_MISSING", detail: s };
    const st = deps.parentLineageState ? deps.parentLineageState(s) : recordLineageState(lineageDir, s);
    if (st === "invalid") return { ok: false, code: "SOURCE_INVALID", detail: `${s} is lineageState=invalid (plan §16)` };
    if (st === "stale") return { ok: false, code: "SOURCE_STALE", detail: `${s} is lineageState=stale — recompute it first (plan §16)` };
  }
  // Deterministic idempotent identity (plan §26: recomputing an UNCHANGED
  // synthesis must produce the same record, not a duplicate): id derives from
  // (type, summary, sources). Changed inputs produce a new id; identical inputs
  // overwrite the same sidecar.
  const synthesisId = `${SYNTHESIS_ID_PREFIX}${v.type.split("_").map((w) => w.slice(0, 4)).map((w) => w[0].toUpperCase() + w.slice(1)).join("")}${sha16(JSON.stringify([v.type, v.summary, v.sources]))}`;
  const doc = {
    schema: 1, synthesisId, type: v.type, summary: v.summary,
    sourceClaimIds: v.sources, generatedAt: nowIso(), validUntil: validUntil ?? null,
    status: "current",
  };
  const rd = recordDerivation({
    recordId: synthesisId, recordKind: "synthesis",
    sources: v.sources, derived: [], supersedes: null,
    evidence: [], valueDigest: sha16(JSON.stringify([v.type, v.summary, v.sources])),
    currentStateDependent: true, lineageDir, dryRun,
  });
  if (!rd.ok) return rd;
  if (dryRun) return { ok: true, dryRun: true, synthesisId, doc };
  return { ok: true, synthesisId, doc };
}

// Deterministic batch generation (manual-first driver, plan §23 phase 12).
// `candidates` come from a deterministic COLLECTOR (tools layer); this module
// validates and persists. Machines compress; callers decide what belongs in a
// category (governance stays outside the memory layer — tombstone precedent).
export function generateSynthesisBatch({ candidates = [], lineageDir = LINEAGE_DIR_DEFAULT, deps = {}, dryRun = false } = {}) {
  const { synthesisEnabled } = lineageFlags();
  if (!synthesisEnabled) return { ok: false, code: "SYNTHESIS_DISABLED", results: [] };
  const results = [];
  for (const c of candidates.slice(0, 32)) results.push(createSynthesisRecord({ ...c, lineageDir, deps, dryRun }));
  return { ok: results.every((r) => r.ok), results };
}

// Staleness sweep (plan §16): a synthesis record goes stale when any source
// claim is tombstoned / invalid / stale, or superseded for current-state
// records. Report-first: returns what WOULD flip; applyStale=true performs the
// sidecar-only flip (flag-gated on invalidation — same boundary as invalidation
// propagation).
export function sweepSynthesisStaleness({ lineageDir = LINEAGE_DIR_DEFAULT, deps = {}, applyStale = false } = {}) {
  const { invalidationEnabled, synthesisEnabled } = lineageFlags();
  if (!synthesisEnabled) return { ok: true, note: "synthesis flag off — sweep is a no-op (nothing was generated)", stale: [], applied: false };
  const stale = [];
  for (const side of listSynthesisSidecars(lineageDir)) {
    if (side.lineageState === "invalid" || side.lineageState === "stale") continue; // sweep never un-stales / never resurrects
    const badSource = (side.sourceClaimIds ?? []).some((s) => {
      const st = deps.parentLineageState ? deps.parentLineageState(s) : recordLineageState(lineageDir, s);
      return st === "invalid" || st === "stale";
    });
    // Superseded source: the supersedesClaimId edge is child->source and NOT a
    // descent edge, so traversal misses it — scan sidecars directly (bounded by
    // the sidecar count, same cost class as childrenOf's directory scan).
    const supersededSource = (side.sourceClaimIds ?? []).some((s) => listAllSidecarIds(lineageDir).some((id) => (deps.sidecarOf ? deps.sidecarOf(id) : readSidecarAny(lineageDir, id))?.supersedesClaimId === s));
    if (badSource || supersededSource) {
      stale.push({ synthesisId: side.recordId, reason: badSource ? "source invalid/stale (plan §16)" : "source superseded (plan §16)" });
      if (applyStale && invalidationEnabled) {
        side.lineageState = "stale";
        side.supersession = { markedStaleAt: nowIso(), supersedingClaimId: null, by: "sweep" };
        writeSidecar(side.__path, side);
      }
    }
  }
  return { ok: true, stale, applied: Boolean(applyStale && stale.length) };
}

// Hard trust-boundary check usable by any caller before treating a record as a
// durable source: synthesis records can never be evidence (plan §28).
export function synthesisCanBeSource(sidecar) {
  return sidecar?.recordKind !== "synthesis";
}

// Tombstone-plane guard helper for the collector: a synthesis item must never
// summarize a tombstoned claim (the tombstone VALUE plane always wins).
export function sourceIsTombstonedValue({ claim, scope = null, tombstones = [] }) {
  return evaluateTombstones({ subject: null, claim, scope, tombstones }).blocked || claimIsRejected({ claim, scope, tombstones }).blocked;
}

// ---- internals ------------------------------------------------------------------
function writeSidecar(path, obj) {
  const bytes = JSON.stringify(obj, null, 2) + "\n";
  if (existsSync(path)) { writeFileSync(path, bytes); return; }
  try { execFileSync("ssh", ["controller", "tee", path], { input: bytes, encoding: "utf8", timeout: 8000 }); } catch { /* best-effort sweep */ }
}

function readSidecarAny(lineageDir, recordId) {
  const p = `${String(lineageDir).replace(/\/+$/, "")}/${recordId}.json`;
  try {
    const body = existsSync(p) ? readFileSync(p, "utf8") : execFileSync("ssh", ["controller", "cat", p], { encoding: "utf8", timeout: 8000 });
    return JSON.parse(body);
  } catch { return null; }
}

function listAllSidecarIds(lineageDir) {
  const dir = String(lineageDir ?? "").replace(/\/+$/, "");
  try {
    if (existsSync(dir)) return readdirSync(dir).filter((f) => f.endsWith(".json")).map((f) => f.replace(/\.json$/, ""));
    return execFileSync("ssh", ["controller", `find '${dir.replace(/'/g, "'\''")}' -maxdepth 1 -type f -name '*.json'`], { encoding: "utf8", timeout: 8000 }).split("\n").map((f) => (f.split("/").pop() ?? "").replace(/\.json$/, "")).filter(Boolean);
  } catch { return []; }
}

function listSynthesisSidecars(lineageDir) {
  const out = [];
  const dir = String(lineageDir ?? "").replace(/\/+$/, "");
  let files = [];
  try {
    if (existsSync(dir)) files = readdirSync(dir).filter((f) => f.endsWith(".json")).map((f) => `${dir}/${f}`);
    else files = execFileSync("ssh", ["controller", `find '${dir.replace(/'/g, "'\\''")}' -maxdepth 1 -type f -name '*.json'`], { encoding: "utf8", timeout: 8000 }).split("\n").map((s) => s.trim()).filter(Boolean);
  } catch { return out; }
  for (const f of files) {
    try {
      const body = existsSync(f) ? readFileSync(f, "utf8") : execFileSync("ssh", ["controller", "cat", f], { encoding: "utf8", timeout: 8000 });
      const side = JSON.parse(body);
      if (side?.recordKind === "synthesis") { side.__path = f; out.push(side); }
    } catch { /* skip unparsable sidecar */ }
  }
  return out;
}
