// lib/memory-tombstone.mjs — Agent Memory Atlas hardening (hub ticket 191; Sol
// Gate 1 consult 2026-10-01T01-44-22-411-252347, verdict CONTRADICTED -> the
// three Gate-1 corrections are APPLIED here, not just noted):
//
//   1. Tombstones live OUTSIDE the RepoQL concept tree:
//        /opt/harness-unset/.repoql/tombstones/<Name>.md   (git-tracked dir)
//      `rql concept add` remains the SOLE writer of .repoql/concepts/. RepoQL
//      does not index tombstones; enforcement reads the tombstone dir from
//      disk. Rejection records can therefore never surface as positive
//      knowledge through semantic retrieval.
//   2. Matching is EXACT-VALUE via a dedicated rejectionDigest over the
//      canonical (subject, field, claim) triple — NOT the candidate
//      contentDigest construction (which mixes lifecycle state/class/
//      provenance into identity and would let the same rejected claim through
//      under different metadata). ONE canonicalizer feeds both the digest and
//      the defensive claim comparison. Numeric tokens are preserved: a
//      tombstone for "window is 30 days" must never match "window is 14 days".
//      NO subject-only, semantic, embedding, or fuzzy matching — a tombstone
//      bans one rejected assertion, never a subject.
//   3. recordedAt/validFrom/validTo are NEVER synthesized. Unknown stays
//      absent/UNKNOWN_TEMPORAL_METADATA (see lib/memory-temporal.mjs).
//
// Additional invariants (ticket 191 plan + existing fleet rules):
//   - Fail-closed: an EXISTING tombstone dir that cannot be read or contains
//     an unparsable tombstone blocks promotion (same triage philosophy as the
//     conflict gate's retrievalStatus handling: absence of evidence is not
//     evidence of absence). An ABSENT dir = no tombstones = open.
//   - Retirement requires an approval reference. This module validates
//     PRESENCE and SHAPE only; Orchestra governance decides which references
//     are valid (the memory layer never encodes orchestration policy).
//   - Audit: create/retire write ops.jsonl intents + receipts via case-store
//     journal helpers and emit one fleet-log journal event (best-effort,
//     skippable for hermetic tests). Tombstones are never deleted; retired
//     tombstones stay on disk with status: retired.
//   - This module is pure data + file IO. It never executes retrieved text
//     (embedded-instruction rule: memory is DATA, not instruction).
import { createHash } from "node:crypto";
import { existsSync, readFileSync, writeFileSync, readdirSync, mkdirSync, statSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { journalIntent, journalComplete } from "./case-store.mjs";

export const TOMBSTONES_DIR_DEFAULT = process.env.ORCH_TOMBSTONES_DIR ?? "/opt/harness-unset/.repoql/tombstones";
const SSH_HOST = "controller";
const sha16 = (s) => createHash("sha256").update(String(s ?? "")).digest("hex").slice(0, 16);
const nowIso = () => new Date().toISOString();

// THE canonicalizer (rule 2): used for the digest AND the defensive claim
// comparison. Lowercase; punctuation/whitespace collapse to single spaces;
// digits preserved; TRAILING punctuation stripped so sentence-final dots don't
// defeat matching ("...is 30 days." == "...is 30 days"). Interior dots stay
// ("1.5.2" is one value, never "1 5 2").
export function canonicalText(s) {
  return String(s ?? "").toLowerCase().replace(/[^a-z0-9.:/+\-]+/g, " ").replace(/\s+/g, " ").trim().replace(/[.:/+\-]+$/, "");
}

// Rejection identity (Sol Gate-1 correction): sha256 over canonical subject,
// canonical field, canonical claim, NUL-separated. Scope is NOT in the digest —
// the rejected value and where the rejection applies are checked separately.
export function rejectionDigestOf({ subject, field = null, claim }) {
  return sha16(`${canonicalText(subject)}\0${canonicalText(field)}\0${canonicalText(claim)}`);
}

// ---- tombstone file format ------------------------------------------------
// ---
// category: tombstone
// status: active            # active | retired
// subject: <normalized subject key, free text>
// field: <optional field/predicate>
// rejectedClaim: <exact rejected claim — mirrored in the body section>
// valueDigest: <rejectionDigestOf(...)>   # integrity anchor, verified on load
// scope: **/work/**         # URI-glob where the rejection applies; omit/`*` = everywhere
// reason: <why it was determined wrong>
// evidence: <uri/anchor of the determining evidence>
// rejectedAt: <ISO — when the value was determined wrong, if known>
// recordedAt: <ISO — when this tombstone was written (real recorded time)>
// approvedBy: <consult id / issue / operator directive reference>
// supersedes: <optional replacement value or superseding reference>
// retiredAt / retiredReason / retiredApprovedBy: <only when status: retired>
// ---
// # <Name>
//
// **Rejected claim**
// <exact rejected claim>
//
// **Invariant**
// The rejected claim above must not be promoted; see the tombstone frontmatter.

// YAML-lite parser (line-based on purpose — same discipline as
// concept-conflict-gate.parseCapsule; no YAML dependency).
export function parseTombstone(body) {
  const out = {
    name: null, status: null, subject: null, field: null, rejectedClaim: null,
    valueDigest: null, scope: null, reason: null, evidence: null, rejectedAt: null,
    recordedAt: null, approvedBy: null, supersedes: null, retiredAt: null,
    retiredReason: null, retiredApprovedBy: null,
  };
  if (body == null) return null;
  const text = String(body);
  const fm = text.match(/^---\n([\s\S]*?)\n---/);
  if (!fm) return null;
  for (const line of fm[1].split("\n")) {
    const kv = line.match(/^(\w[\w-]*):\s*(.*)$/);
    if (!kv) continue;
    const k = kv[1];
    const v = String(kv[2]).trim().replace(/^["']|["']$/g, "");
    if (k in out) out[k] = v === "" ? null : v;
  }
  const titleM = text.match(/^#\s+(.+)$/m);
  if (titleM) out.name = titleM[1].trim();
  const claimM = text.match(/\*\*Rejected claim\*\*\s*\n([\s\S]*?)(?=\n\*\*|$)/);
  if (claimM) out.rejectedClaim = claimM[1].trim();
  return out;
}

// Validate a create/retire spec. Presence+shape only — governance stays outside.
export function validateTombstoneSpec(spec) {
  const problems = [];
  if (!spec?.name || !/^[A-Z][A-Za-z0-9]+$/.test(String(spec.name))) problems.push("name: CamelCase identifier required");
  if (!spec?.subject || String(spec.subject).trim().length < 3) problems.push("subject: required (3+ chars)");
  if (!spec?.rejectedClaim || canonicalText(spec.rejectedClaim).length < 5) problems.push("rejectedClaim: required (5+ canonical chars)");
  if (!spec?.reason || String(spec.reason).trim().length < 8) problems.push("reason: required (8+ chars)");
  if (!spec?.evidence || String(spec.evidence).trim().length < 4) problems.push("evidence: required (uri/anchor of the determining evidence)");
  if (!spec?.approvedBy || String(spec.approvedBy).trim().length < 4) problems.push("approvedBy: required (consult/issue/operator reference — governance decides validity, this gate requires presence+shape)");
  for (const t of ["rejectedAt", "recordedAt"]) {
    if (spec?.[t] != null && Number.isNaN(Date.parse(spec[t]))) problems.push(`${t}: must be an ISO timestamp when present`);
  }
  return { ok: problems.length === 0, problems };
}

function rejectionDigestOfSpec(spec) {
  // Single canonical construction: spec uses rejectedClaim; evaluators use claim.
  return rejectionDigestOf({ subject: spec.subject, field: spec.field ?? null, claim: spec.rejectedClaim });
}

function renderTombstone(spec) {
  const rejectedAt = spec.rejectedAt ?? null; // "value determined wrong" time — real or absent, never inferred
  const fm = [
    "---",
    "category: tombstone",
    `status: ${spec.status ?? "active"}`,
    `subject: ${String(spec.subject).replace(/\n/g, " ").trim()}`,
    spec.field ? `field: ${String(spec.field).replace(/\n/g, " ").trim()}` : null,
    `rejectedClaim: ${String(spec.rejectedClaim).replace(/\n/g, " ").trim()}`,
    `valueDigest: ${rejectionDigestOfSpec(spec)}`,
    spec.scope ? `scope: ${spec.scope}` : null,
    `reason: ${String(spec.reason).replace(/\n/g, " ").trim()}`,
    `evidence: ${String(spec.evidence).replace(/\n/g, " ").trim()}`,
    rejectedAt ? `rejectedAt: ${rejectedAt}` : null,
    `recordedAt: ${nowIso()}`,
    `approvedBy: ${String(spec.approvedBy).replace(/\n/g, " ").trim()}`,
    spec.supersedes ? `supersedes: ${String(spec.supersedes).replace(/\n/g, " ").trim()}` : null,
    spec.retiredAt ? `retiredAt: ${spec.retiredAt}` : null,
    spec.retiredReason ? `retiredReason: ${String(spec.retiredReason).replace(/\n/g, " ").trim()}` : null,
    spec.retiredApprovedBy ? `retiredApprovedBy: ${String(spec.retiredApprovedBy).replace(/\n/g, " ").trim()}` : null,
    "---",
    "",
    `# ${spec.name}`,
    "",
    "**Rejected claim**",
    String(spec.rejectedClaim).trim(),
    "",
    "**Invariant**",
    "The rejected claim above must not be promoted; see the tombstone frontmatter.",
    "",
  ].filter((l) => l !== null);
  return fm.join("\n");
}

// ---- IO: local dir or controller-backed (same SSH fallback as concept-capture)
function isRemote(dir) { return !existsSync(dir); }
function listRemote(dir) {
  // Quote the -name pattern INSIDE the remote command: passed unquoted, ssh
  // argv delivers `*.md` to the remote shell, which glob-expands it against
  // controller's CWD (live 2026-10-01: `find: paths must precede
  // expression` + phantom capsule paths — the same latent bug exists in
  // concept-capture.mjs listConceptFilesRemote, fixed same-session).
  // Ticket 719 (Sol F3 amended): an absent dir (no tombstones yet) is an
  // ALLOWED empty result, not an error: branch remotely so find never runs
  // (and never prints ENOENT noise) when the dir is missing; exit 7 maps to
  // []. Any other failure still returns null so loadTombstones keeps its
  // fail-closed distinction (no blanket stderr suppression).
  const q = dir.replace(/'/g, "'\\''");
  try {
    return execFileSync("ssh", [SSH_HOST, `if [ -d '${q}' ]; then find '${q}' -maxdepth 2 -type f -name '*.md'; else exit 7; fi`], { encoding: "utf8", timeout: 8000 })
      .split("\n").map((s) => s.trim()).filter(Boolean);
  } catch (e) {
    if (e?.status === 7) return [];
    return null;
  }
}
function readRemote(path) {
  try { return execFileSync("ssh", [SSH_HOST, "cat", path], { encoding: "utf8", timeout: 8000 }); } catch { return null; }
}
function tombstoneFilePath(dir, name) {
  return isRemote(dir) ? `${dir.replace(/\/+$/, "")}/${name}.md` : `${dir.replace(/\/+$/, "")}/${name}.md`;
}

// Load the tombstone index. Contract:
//   absent dir          -> { ok: true, tombstones: [] } (remote: the exit-7 branch
//                          maps to []; local: absent: true. No consumer reads the flag.)
//   infra-unreachable   -> { ok: true, tombstones: [], absent: true } (documented
//                          deviation: an unreachable controller degrades to the
//                          pre-191 behaviour instead of adding a new availability
//                          dependency to capture; the rql effect itself fails in
//                          that state anyway. An EXISTING but unreadable index
//                          still fails closed.)
//   unreadable existing -> { ok: false, code: "TOMBSTONE_INDEX_UNREADABLE" }   (fail closed)
//   unparsable entry    -> { ok: false, code: "TOMBSTONE_PARSE_FAILED", file }  (fail closed)
//   digest mismatch     -> { ok: false, code: "TOMBSTONE_DIGEST_MISMATCH", file } (tampered/corrupt)
export function loadTombstones(dir = TOMBSTONES_DIR_DEFAULT) {
  if (isRemote(dir)) {
    const files = listRemote(dir);
    if (files === null) {
      // Cannot distinguish "absent remotely" from "unreachable" -> fail closed.
      try { execFileSync("ssh", [SSH_HOST, "test", "-d", dir], { timeout: 8000 }); }
      catch { return { ok: true, tombstones: [], absent: true }; }
      return { ok: false, code: "TOMBSTONE_INDEX_UNREADABLE", detail: `${dir} exists on ${SSH_HOST} but is unreadable` };
    }
    const tombstones = [];
    for (const p of files) {
      const body = readRemote(p);
      if (body == null) return { ok: false, code: "TOMBSTONE_INDEX_UNREADABLE", file: p };
      const t = parseTombstone(body);
      if (!t) return { ok: false, code: "TOMBSTONE_PARSE_FAILED", file: p };
      if (t.valueDigest && t.subject != null && t.rejectedClaim
        && t.valueDigest !== rejectionDigestOf({ subject: t.subject, field: t.field, claim: t.rejectedClaim })) {
        return { ok: false, code: "TOMBSTONE_DIGEST_MISMATCH", file: p };
      }
      tombstones.push({ ...t, file: p });
    }
    return { ok: true, tombstones };
  }
  let entries;
  try { entries = readdirSync(dir); } catch (e) {
    if (e?.code === "ENOENT") return { ok: true, tombstones: [], absent: true }; // genuinely absent = no tombstones
    return { ok: false, code: "TOMBSTONE_INDEX_UNREADABLE", detail: String(e?.message ?? e) }; // exists but unreadable = fail closed
  }
  const tombstones = [];
  for (const ent of entries) {
    if (!ent.endsWith(".md")) continue;
    const p = `${dir.replace(/\/+$/, "")}/${ent}`;
    let body;
    try { body = readFileSync(p, "utf8"); } catch {
      return { ok: false, code: "TOMBSTONE_INDEX_UNREADABLE", file: p };
    }
    const t = parseTombstone(body);
    if (!t) return { ok: false, code: "TOMBSTONE_PARSE_FAILED", file: p };
    if (t.valueDigest && t.subject != null && t.rejectedClaim
      && t.valueDigest !== rejectionDigestOf({ subject: t.subject, field: t.field, claim: t.rejectedClaim })) {
      return { ok: false, code: "TOMBSTONE_DIGEST_MISMATCH", file: p };
    }
    tombstones.push({ ...t, file: p });
  }
  return { ok: true, tombstones };
}

// ---- matching ---------------------------------------------------------------
// Simple URI-glob overlap: ** crosses segments, * matches within one segment.
export function scopeApplies(tombstoneScope, candidateScope) {
  const ts = String(tombstoneScope ?? "*").trim() || "*";
  if (ts === "*") return true;
  if (candidateScope == null || String(candidateScope).trim() === "") return true; // unknown scope -> conservative
  const toRe = (g) => new RegExp("^" + String(g).replace(/[.+^${}()|[\]\\]/g, "\\$&").replace(/\*\*/g, "\u0001").replace(/\*/g, "[^/]*").replace(/\u0001/g, ".*") + "$");
  return toRe(ts).test(String(candidateScope).trim());
}

// Evaluate pre-loaded tombstones (the gate stays pure, like the conflict gate).
// Matching (Sol): active AND subject equal AND field compatible AND scope
// applies AND rejectionDigest equal. Digest equality is decisive; the canonical
// claim comparison is retained as a defensive verification of the same
// canonicalizer (a digest match with a divergent canonical claim is a corruption
// signal -> surfaced, never silently treated as a match).
export function evaluateTombstones({ subject, field = null, claim, scope = null, tombstones = [] }) {
  const digest = rejectionDigestOf({ subject, field, claim });
  for (const t of tombstones) {
    if (String(t.status ?? "active") !== "active") continue;
    if (canonicalText(t.subject) !== canonicalText(subject)) continue;
    if (canonicalText(t.field ?? "") !== canonicalText(field ?? "")) continue;
    if (!scopeApplies(t.scope, scope)) continue;
    if (t.valueDigest && t.valueDigest !== digest) {
      // Same subject/field but different value -> different claim, NOT blocked
      // (this is exactly the 30-days-vs-14-days case).
      continue;
    }
    if (canonicalText(t.rejectedClaim) !== canonicalText(claim)) continue; // defensive canonical check
    return {
      blocked: true,
      tombstone: t,
      reason: `rejected-value tombstone ${t.name ?? t.file ?? "?"}: subject=${canonicalText(subject)} field=${canonicalText(field) ?? "-"} claim="${canonicalText(claim).slice(0, 120)}" (evidence: ${t.evidence ?? "?"}, approvedBy: ${t.approvedBy ?? "?"})`,
    };
  }
  return { blocked: false, tombstone: null, reason: null };
}

// Value-plane check for callers whose subject key is a RECORD identifier (the
// capsule name) while tombstones carry free-text subjects. Blocks on
// (active AND scope applies AND canonical rejectedClaim == canonical claim)
// regardless of subject. Deliberately NARROW: exact canonical value equality
// only — never fuzzy, never subject-wide (a tombstone bans one assertion, not
// a subject). Used as the SECOND check at record-identity planes (capture
// chokepoint, conversation review) after the full Sol match.
export function claimIsRejected({ claim, scope = null, tombstones = [] }) {
  const c = canonicalText(claim);
  if (!c) return { blocked: false, tombstone: null, reason: null };
  for (const t of tombstones) {
    if (String(t.status ?? "active") !== "active") continue;
    if (!scopeApplies(t.scope, scope)) continue;
    if (canonicalText(t.rejectedClaim) === c) {
      return { blocked: true, tombstone: t, reason: `rejected-value tombstone ${t.name ?? t.file ?? "?"}: exact rejected value "${c.slice(0, 120)}" (evidence: ${t.evidence ?? "?"}, approvedBy: ${t.approvedBy ?? "?"})` };
    }
  }
  return { blocked: false, tombstone: null, reason: null };
}

// Convenience: load + evaluate in one call. ok=false means fail closed.
export function checkTombstones({ subject, field = null, claim, scope = null, tombstonesDir = TOMBSTONES_DIR_DEFAULT } = {}) {
  const idx = loadTombstones(tombstonesDir);
  if (!idx.ok) return { ok: false, ...idx };
  const ev = evaluateTombstones({ subject, field, claim, scope, tombstones: idx.tombstones });
  return { ok: true, ...ev };
}

// ---- fleet-log audit (best-effort; never blocks the operation's outcome) ----
function fleetLogEvent(text) {
  try {
    // Ticket 719 (Sol F1): the note is free text - ssh re-joins argv and the
    // remote shell re-parses it, so single-quote it (embedded ' escaped) or
    // metacharacters like parentheses break the remote command (live
    // 2026-10-17: memory_lineage_created notes always carry parens and died
    // with a bash syntax error).
    const note = String(text).replace(/'/g, "'\\''");
    execFileSync("ssh", [SSH_HOST, `fleet-log --source agent --type note '${note}'`], { encoding: "utf8", timeout: 15_000 });
    return true;
  } catch { return false; }
}

// ---- create ------------------------------------------------------------------
export function createTombstone(spec, { tombstonesDir = TOMBSTONES_DIR_DEFAULT, journalDir = null, caseId = null, phase = null, fleetLog = true, dryRun = false } = {}) {
  const v = validateTombstoneSpec(spec);
  if (!v.ok) return { ok: false, code: "INVALID_TOMBSTONE", detail: v.problems.join("; ") };
  const idx = loadTombstones(tombstonesDir);
  if (!idx.ok) return { ok: false, code: idx.code, detail: idx.detail ?? idx.file ?? null };
  const digest = rejectionDigestOfSpec(spec);
  const dup = idx.tombstones.find((t) => t.valueDigest === digest && String(t.status ?? "active") === "active");
  if (dup) return { ok: false, code: "DUPLICATE_TOMBSTONE", detail: `${dup.name ?? dup.file} already bans this value` };
  const file = tombstoneFilePath(tombstonesDir, spec.name);
  const bytes = renderTombstone(spec);
  if (dryRun) return { ok: true, dryRun: true, name: spec.name, file, digest, bytes };
  const opId = `tombstone-create-${spec.name}-${Date.now()}`;
  let intent = null;
  if (journalDir) {
    try {
      intent = journalIntent(journalDir, { opId, op: "memory.tombstone_create", caseId, phase, requestDigest: digest, meta: { name: spec.name, valueDigest: digest } });
    } catch (e) {
      return { ok: false, code: "JOURNAL_INTENT_FAILED", detail: String(e?.message ?? e).slice(0, 140) };
    }
  }
  try {
    if (isRemote(tombstonesDir)) {
      execFileSync("ssh", [SSH_HOST, "mkdir", "-p", tombstonesDir], { timeout: 8000 });
      execFileSync("ssh", [SSH_HOST, "tee", file], { input: bytes, encoding: "utf8", timeout: 8000 });
    } else {
      mkdirSync(tombstonesDir, { recursive: true });
      writeFileSync(file, bytes);
    }
  } catch (e) {
    if (journalDir && intent) { try { journalComplete(journalDir, opId, { state: "failed", errorClass: "WRITE_FAILED", receipt: { detail: String(e?.message ?? e).slice(0, 140) } }); } catch { /* best-effort */ } }
    return { ok: false, code: "WRITE_FAILED", detail: String(e?.message ?? e).slice(0, 140) };
  }
  if (journalDir && intent) {
    try { journalComplete(journalDir, opId, { state: "done", receipt: { file, valueDigest: digest } }); } catch { /* best-effort */ }
  }
  if (fleetLog) {
    fleetLogEvent(`TOMBSTONE created: ${spec.name} bans "${canonicalText(spec.rejectedClaim).slice(0, 120)}" (subject: ${canonicalText(spec.subject).slice(0, 80)}; evidence: ${String(spec.evidence).slice(0, 120)}; approvedBy: ${String(spec.approvedBy).slice(0, 120)}) — enforcement active at all concept promotion paths`);
  }
  return { ok: true, name: spec.name, file, digest, sha256: createHash("sha256").update(bytes).digest("hex") };
}

// ---- retire ------------------------------------------------------------------
// Retirement is NOT deletion: the file stays with status: retired. The approval
// reference is validated for presence+shape here; its AUTHORITY is decided by
// Orchestra governance, never by this module.
export function retireTombstone({ name, reason, approvedBy, tombstonesDir = TOMBSTONES_DIR_DEFAULT, journalDir = null, caseId = null, phase = null, fleetLog = true } = {}) {
  if (!name) return { ok: false, code: "INVALID_RETIRE", detail: "name required" };
  if (!reason || String(reason).trim().length < 8) return { ok: false, code: "INVALID_RETIRE", detail: "reason required (8+ chars)" };
  if (!approvedBy || String(approvedBy).trim().length < 4) return { ok: false, code: "INVALID_RETIRE", detail: "approvedBy required (consult/issue/operator reference — a producing process cannot retire its own rejection)" };
  const idx = loadTombstones(tombstonesDir);
  if (!idx.ok) return { ok: false, code: idx.code, detail: idx.detail ?? idx.file ?? null };
  const t = idx.tombstones.find((x) => x.name === name || (x.file ?? "").endsWith(`/${name}.md`));
  if (!t) return { ok: false, code: "TOMBSTONE_NOT_FOUND", detail: name };
  if (String(t.status ?? "active") === "retired") return { ok: false, code: "ALREADY_RETIRED", detail: name };
  const file = isRemote(tombstonesDir) ? tombstoneFilePath(tombstonesDir, name) : `${tombstonesDir.replace(/\/+$/, "")}/${name}.md`;
  const opId = `tombstone-retire-${name}-${Date.now()}`;
  let intent = null;
  if (journalDir) {
    try { intent = journalIntent(journalDir, { opId, op: "memory.tombstone_retire", caseId, phase, requestDigest: rejectionDigestOf({ subject: t.subject, field: t.field, claim: t.rejectedClaim }), meta: { name, approvedBy: String(approvedBy).slice(0, 120) } }); }
    catch (e) { return { ok: false, code: "JOURNAL_INTENT_FAILED", detail: String(e?.message ?? e).slice(0, 140) }; }
  }
  const updated = renderTombstone({
    name, status: "retired",
    subject: t.subject, field: t.field, rejectedClaim: t.rejectedClaim,
    scope: t.scope, reason: t.reason, evidence: t.evidence, rejectedAt: t.rejectedAt,
    approvedBy: t.approvedBy, supersedes: t.supersedes,
    retiredAt: nowIso(), retiredReason: String(reason).replace(/\n/g, " ").trim(), retiredApprovedBy: String(approvedBy).replace(/\n/g, " ").trim(),
  });
  try {
    if (isRemote(tombstonesDir)) {
      execFileSync("ssh", [SSH_HOST, "tee", file], { input: updated, encoding: "utf8", timeout: 8000 });
    } else {
      writeFileSync(file, updated);
    }
  } catch (e) {
    if (journalDir && intent) { try { journalComplete(journalDir, opId, { state: "failed", errorClass: "WRITE_FAILED", receipt: { detail: String(e?.message ?? e).slice(0, 140) } }); } catch { /* best-effort */ } }
    return { ok: false, code: "WRITE_FAILED", detail: String(e?.message ?? e).slice(0, 140) };
  }
  if (journalDir && intent) { try { journalComplete(journalDir, opId, { state: "done", receipt: { file } }); } catch { /* best-effort */ } }
  if (fleetLog) {
    fleetLogEvent(`TOMBSTONE retired: ${name} (reason: ${String(reason).slice(0, 140)}; approvedBy: ${String(approvedBy).slice(0, 120)}) — the previously rejected value may be re-examined through normal review`);
  }
  return { ok: true, name, file };
}

// List (report-only) — for lifecycle reporters and evidence packs.
export function listTombstones(dir = TOMBSTONES_DIR_DEFAULT) {
  const idx = loadTombstones(dir);
  if (!idx.ok) return idx;
  return { ok: true, tombstones: idx.tombstones.map(({ file, ...rest }) => ({ file, ...rest })), active: idx.tombstones.filter((t) => String(t.status ?? "active") === "active").length };
}
