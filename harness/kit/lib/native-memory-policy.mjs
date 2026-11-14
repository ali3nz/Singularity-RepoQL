// Explicit opt-in adapter to the native Rust memory-policy executable.
// This module never selects an orchestration stage, changes a task identity,
// or substitutes a failed native result with a JavaScript result. Until a
// native Windows differential acceptance succeeds the environment variable
// is intentionally UNSET and the existing JavaScript path remains active.
import { spawnSync } from "node:child_process";
import { isAbsolute, win32 } from "node:path";

const BIN_ENV = "SINGULARITY_RUST_MEMORY_POLICY_BIN";
const REQUEST_LIMIT = 256 * 1024;
const RESPONSE_LIMIT = 1024 * 1024;
const ALLOWED = new Set([
  "rank", "main-memory-state", "main-memory-plan", "main-memory-uninstall", "delegated-identity", "doc-reconcile-action", "repoql-doc-uri", "hook-redact", "hook-capture-id", "answerability-packet", "answerability-expanded", "answerability-conflicts", "temporal", "tombstone-check", "tombstone-claim",
  "payload-budget", "split-bytes", "task-links", "task-recovery-snapshot", "reconcile-missing", "synthesis-validate",
  "contradiction-signal", "numeric-divergence", "parse-capsule", "extract-invariant", "lineage-filter", "candidate-policy", "candidate-transition", "candidate-ttl", "memory-impact", "memory-impact-files",
]);

export class NativeMemoryPolicyError extends Error {
  constructor(code, detail = "") {
    super(`native memory policy: ${code}${detail ? ` (${detail})` : ""}`);
    this.name = "NativeMemoryPolicyError";
    this.code = code;
  }
}

export function nativeMemoryPolicyEnabled() {
  return Boolean(process.env[BIN_ENV]);
}

export function requestNativeMemoryPolicy(command, payload) {
  if (!ALLOWED.has(command)) throw new NativeMemoryPolicyError("UNSUPPORTED_COMMAND");
  const bin = process.env[BIN_ENV];
  if (!bin) throw new NativeMemoryPolicyError("NATIVE_POLICY_NOT_ENABLED");
  if (bin.includes("\0") || (!isAbsolute(bin) && !win32.isAbsolute(bin))) {
    throw new NativeMemoryPolicyError("INVALID_NATIVE_BINARY_PATH");
  }
  let input;
  try { input = JSON.stringify(payload); } catch { throw new NativeMemoryPolicyError("INVALID_PAYLOAD"); }
  if (typeof input !== "string" || Buffer.byteLength(input, "utf8") > REQUEST_LIMIT) {
    throw new NativeMemoryPolicyError("PAYLOAD_LIMIT_EXCEEDED");
  }
  const result = spawnSync(bin, [command], {
    input, encoding: "utf8", windowsHide: true, shell: false,
    timeout: 3500, maxBuffer: RESPONSE_LIMIT,
  });
  if (result.error) {
    throw new NativeMemoryPolicyError(result.error.code === "ETIMEDOUT" ? "NATIVE_POLICY_TIMEOUT" : "NATIVE_POLICY_UNAVAILABLE", String(result.error.code ?? "spawn error"));
  }
  let output;
  try { output = JSON.parse(result.stdout); } catch { throw new NativeMemoryPolicyError("INVALID_NATIVE_RESPONSE"); }
  if (!output || typeof output !== "object" || Array.isArray(output) || typeof output.ok !== "boolean") {
    throw new NativeMemoryPolicyError("INVALID_NATIVE_RESPONSE");
  }
  const budgetOmission = command === "payload-budget" && output.ok === false &&
    typeof output.totalBytes === "number" && Array.isArray(output.included) &&
    Array.isArray(output.omitted) && Array.isArray(output.reasons);
  if (result.status !== 0 || (output.ok !== true && !budgetOmission)) {
    throw new NativeMemoryPolicyError("NATIVE_POLICY_REJECTED", String(output.code ?? result.status ?? "failure").slice(0, 100));
  }
  return output;
}

// Rust returns JSON-cloned rows; keep the original objects and all their
// non-JSON properties. An input index is an unforgeable selection key supplied
// only to the local child process. Verify a complete permutation before use.
export function nativeLiveSourceOrder(rows, query = "") {
  const originals = Array.isArray(rows) ? rows : [];
  const result = requestNativeMemoryPolicy("rank", {
    query: typeof query === "string" ? query : (query?.q ?? ""),
    results: originals.map((row, index) => ({ ...row, __nativePolicyInputIndex: index })),
  });
  if (!Array.isArray(result.results) || result.results.length !== originals.length) {
    throw new NativeMemoryPolicyError("INVALID_NATIVE_RANK_PERMUTATION");
  }
  const seen = new Set();
  return result.results.map((row) => {
    const idx = row?.__nativePolicyInputIndex;
    if (!Number.isSafeInteger(idx) || idx < 0 || idx >= originals.length || seen.has(idx)) {
      throw new NativeMemoryPolicyError("INVALID_NATIVE_RANK_PERMUTATION");
    }
    seen.add(idx);
    if (row.uri !== originals[idx]?.uri) {
      throw new NativeMemoryPolicyError("INVALID_NATIVE_RANK_PERMUTATION");
    }
    return originals[idx];
  });
}

export function nativeTemporalVerdict(mode, { capsuleBody = null, temporal = null, asOf, now } = {}) {
  const result = requestNativeMemoryPolicy("temporal", { mode, capsuleBody, temporal, asOf, now });
  const expected = new Set([
    "MATCH", "NO_MATCH", "UNKNOWN_TEMPORAL_METADATA",
    "UNKNOWN_TEMPORAL_METADATA_REQUIRES_KNOWN_VALID_FROM",
    "UNKNOWN_TEMPORAL_METADATA_REQUIRES_KNOWN_RECORDED_AT",
  ]);
  if (!expected.has(result.verdict)) throw new NativeMemoryPolicyError("INVALID_NATIVE_VERDICT");
  return result.verdict;
}

export function nativeRejectedClaimIndex({ claim, scope = null, tombstones = [] }) {
  const result = requestNativeMemoryPolicy("tombstone-claim", { claim, scope, tombstones });
  return nativeMatchIndex(result, tombstones);
}

export function nativeExactTombstoneIndex({ subject, field = null, claim, scope = null, tombstones = [] }) {
  const result = requestNativeMemoryPolicy("tombstone-check", { subject, field, claim, scope, tombstones });
  return nativeMatchIndex(result, tombstones);
}

function nativeMatchIndex(result, tombstones) {
  if (typeof result.blocked !== "boolean") throw new NativeMemoryPolicyError("INVALID_NATIVE_MATCH");
  if (!result.blocked && result.matchedIndex === null) return null;
  const idx = result.matchedIndex;
  if (!result.blocked || !Number.isSafeInteger(idx) || idx < 0 || idx >= tombstones.length) {
    throw new NativeMemoryPolicyError("INVALID_NATIVE_MATCH");
  }
  return idx;
}

// Data omission (ok:false) is a SUCCESSFUL budget calculation, not a process
// failure. A caller must see the manifest and reject incomplete attachments.
export function nativeBudgetPayload(files, { totalCap, perFileCap } = {}) {
  if (!Array.isArray(files) || !files.every(f => f && typeof f.name === "string")) {
    throw new NativeMemoryPolicyError("INVALID_NATIVE_BUDGET_INPUT");
  }
  for (const cap of [totalCap, perFileCap]) {
    if (cap !== undefined && (!Number.isSafeInteger(cap) || cap < 0)) {
      throw new NativeMemoryPolicyError("INVALID_NATIVE_BUDGET_CAP");
    }
  }
  const payload = { files: files.map(f => ({ name: f.name, content: String(f.content ?? "") })) };
  if (totalCap !== undefined) payload.totalCap = totalCap;
  if (perFileCap !== undefined) payload.perFileCap = perFileCap;
  const result = requestNativeMemoryPolicy("payload-budget", payload);
  if (typeof result.totalBytes !== "number" || !Array.isArray(result.included) ||
      !Array.isArray(result.omitted) || !Array.isArray(result.reasons)) {
    throw new NativeMemoryPolicyError("INVALID_NATIVE_BUDGET_RESPONSE");
  }
  return result;
}

export function nativeSplitIntoByteParts(text, cap) {
  if (!Number.isSafeInteger(cap) || cap <= 0) throw new NativeMemoryPolicyError("INVALID_NATIVE_SPLIT_CAP");
  const s = String(text ?? "");
  const result = requestNativeMemoryPolicy("split-bytes", { text: s, cap });
  if (!Array.isArray(result.parts) || !result.parts.every(p => typeof p === "string" &&
      Buffer.byteLength(p,"utf8") <= cap) || result.parts.join("") !== s) {
    throw new NativeMemoryPolicyError("INVALID_NATIVE_SPLIT_RESPONSE");
  }
  return result.parts;
}

// This is a read-only ledger selector, never task authorization or retrieval.
export function nativeLinkedCaptureUnits(ledger, taskId, agent) {
  const result = requestNativeMemoryPolicy("task-links", { ledger, taskId, agent });
  if (!Array.isArray(result.units) || !result.units.every(u => u && typeof u.unitId === "string" &&
      typeof u.sessionId === "string" && Number.isSafeInteger(u.firstSeq) && Number.isSafeInteger(u.lastSeq))) {
    throw new NativeMemoryPolicyError("INVALID_NATIVE_TASK_UNITS");
  }
  return result.units;
}

// The JavaScript storage reader remains responsible for strict sidecar loading.
// Rust receives only verified states and may not add, omit, or rename identities.
export function nativeLineageFilter(recordNames, states) {
  const result = requestNativeMemoryPolicy("lineage-filter", { recordNames, states });
  if (!Array.isArray(result.kept) || !Array.isArray(result.excluded)) {
    throw new NativeMemoryPolicyError("INVALID_NATIVE_LINEAGE_RESPONSE");
  }
  const wanted = new Map();
  for (const name of recordNames) wanted.set(name, (wanted.get(name) ?? 0) + 1);
  const decrease = (name) => {
    const n = wanted.get(name) ?? 0;
    if (!n) throw new NativeMemoryPolicyError("INVALID_NATIVE_LINEAGE_RESPONSE");
    wanted.set(name, n - 1);
  };
  for (const name of result.kept) {
    if (typeof name !== "string" || states[name] === "invalid" || states[name] === "stale") {
      throw new NativeMemoryPolicyError("INVALID_NATIVE_LINEAGE_RESPONSE");
    }
    decrease(name);
  }
  for (const ex of result.excluded) {
    if (!ex || typeof ex.name !== "string" || ex.state !== states[ex.name] ||
        (ex.state !== "invalid" && ex.state !== "stale")) {
      throw new NativeMemoryPolicyError("INVALID_NATIVE_LINEAGE_RESPONSE");
    }
    decrease(ex.name);
  }
  if ([...wanted.values()].some(n => n !== 0)) {
    throw new NativeMemoryPolicyError("INVALID_NATIVE_LINEAGE_RESPONSE");
  }
  return { kept: result.kept, excluded: result.excluded };
}

export function nativeCandidatePolicy(candidate, excludeUri = null) {
  const result = requestNativeMemoryPolicy("candidate-policy", { candidate, excludeUri });
  for (const key of ["hasAnchoredProvenance", "isDerivedProvenance", "hasIndependentProvenance"]) {
    if (typeof result[key] !== "boolean") throw new NativeMemoryPolicyError("INVALID_NATIVE_CANDIDATE_POLICY");
  }
  if (result.precedenceRank != null && !Number.isSafeInteger(result.precedenceRank)) {
    throw new NativeMemoryPolicyError("INVALID_NATIVE_CANDIDATE_POLICY");
  }
  return result;
}

export function nativeMemoryImpact({ changedFiles, subsystemHint = null, minScore = 1, knowledgeFiles }) {
  const result = requestNativeMemoryPolicy("memory-impact", { changedFiles, subsystemHint, minScore, knowledgeFiles });
  if (!Array.isArray(result.tokens) || !Array.isArray(result.impacted)) {
    throw new NativeMemoryPolicyError("INVALID_NATIVE_MEMORY_IMPACT");
  }
  return { tokens: result.tokens, impacted: result.impacted };
}

export function nativeMemoryImpactFiles({ changedFiles, subsystemHint = null, minScore = 1, files }) {
  if (!Array.isArray(files) || !files.every(f => typeof f === "string")) {
    throw new NativeMemoryPolicyError("INVALID_NATIVE_MEMORY_FILES");
  }
  const result = requestNativeMemoryPolicy("memory-impact-files", { changedFiles, subsystemHint, minScore, files });
  if (!Array.isArray(result.tokens) || !Array.isArray(result.impacted)) {
    throw new NativeMemoryPolicyError("INVALID_NATIVE_MEMORY_IMPACT");
  }
  return { tokens: result.tokens, impacted: result.impacted };
}

// Candidate governance is a pure policy decision. Rust does not write a
// candidate, approve a promotion, or generate its own lifecycle timestamp.
export function nativeCandidateTransition(candidate, toState, { verification = null, closedAt = null } = {}) {
  const result = requestNativeMemoryPolicy("candidate-transition", { candidate, toState, verification, closedAt });
  if (typeof result.accepted !== "boolean") throw new NativeMemoryPolicyError("INVALID_NATIVE_TRANSITION");
  if (!result.accepted) {
    if (typeof result.reason !== "string" || !result.reason.startsWith("lifecycle:")) {
      throw new NativeMemoryPolicyError("INVALID_NATIVE_TRANSITION");
    }
    throw new Error(result.reason);
  }
  const next = result.candidate;
  const status = ({ CANDIDATE: "candidate", VERIFIED: "verified", EXPIRED: "expired",
    SUPERSEDED: "superseded", INVALIDATED: "invalidated" })[toState];
  if (!next || Array.isArray(next) || typeof next !== "object" || next.maturityState !== toState || next.status !== status) {
    throw new NativeMemoryPolicyError("INVALID_NATIVE_TRANSITION");
  }
  if (closedAt !== null && next.lifecycleClosedAt !== closedAt) {
    throw new NativeMemoryPolicyError("INVALID_NATIVE_TRANSITION");
  }
  for (const key of ["id", "contentDigest", "caseId", "runNumber", "createdBy", "provenance", "claim"]) {
    if (JSON.stringify(next[key]) !== JSON.stringify(candidate?.[key])) {
      throw new NativeMemoryPolicyError("INVALID_NATIVE_TRANSITION_IDENTITY");
    }
  }
  return next;
}

export function nativeCandidateTtl(candidate, now) {
  if (!(now instanceof Date) || !Number.isFinite(now.getTime())) {
    throw new NativeMemoryPolicyError("INVALID_NATIVE_TTL_TIME");
  }
  const result = requestNativeMemoryPolicy("candidate-ttl", { candidate, now: now.toISOString() });
  if (typeof result.due !== "boolean" || typeof result.reason !== "string" || result.reason.length > 200) {
    throw new NativeMemoryPolicyError("INVALID_NATIVE_TTL_VERDICT");
  }
  return { due: result.due, reason: result.reason };
}

// Conflict signals and capsule parsing are pure, local transformations.
// The existing conflict gate remains solely responsible for review and
// promotion decisions. An explicitly selected Rust failure never falls back.
export function nativeConflictSignal(command, claimA, claimB) {
  if (command !== "contradiction-signal" && command !== "numeric-divergence") {
    throw new NativeMemoryPolicyError("UNSUPPORTED_CONFLICT_SIGNAL");
  }
  const result = requestNativeMemoryPolicy(command, { claimA, claimB });
  if (result.signal !== null && typeof result.signal !== "string") {
    throw new NativeMemoryPolicyError("INVALID_NATIVE_CONFLICT_SIGNAL");
  }
  return result.signal;
}

export function nativeExtractInvariant(body) {
  const result = requestNativeMemoryPolicy("extract-invariant", { body });
  if (typeof result.value !== "string") {
    throw new NativeMemoryPolicyError("INVALID_NATIVE_INVARIANT");
  }
  return result.value;
}

export function nativeParseCapsule(body) {
  const result = requestNativeMemoryPolicy("parse-capsule", { body });
  const value = result.value;
  const fields = ["title", "description", "category", "relevance", "verification", "ttl", "verifiedDate"];
  if (!value || typeof value !== "object" || Array.isArray(value) ||
      Object.keys(value).length !== fields.length || fields.some(k => !(k in value)) ||
      fields.some(k => value[k] !== null &&
        (k === "ttl" ? !Number.isFinite(value[k]) || typeof value[k] !== "number" : typeof value[k] !== "string"))) {
    throw new NativeMemoryPolicyError("INVALID_NATIVE_CAPSULE");
  }
  return value;
}

// MemoryCore transport and write verification still belong to the existing
// reconciliation owner. Rust can only select input indexes, never supply rows
// for persistence or declare an unverified write successful.
export function nativeMissingReconciliationIndexes(rows, messages) {
  if (!Array.isArray(rows) || !Array.isArray(messages)) {
    throw new NativeMemoryPolicyError("INVALID_NATIVE_RECONCILIATION_INPUT");
  }
  const out = requestNativeMemoryPolicy("reconcile-missing", { rows, messages });
  if (!Number.isSafeInteger(out.totalMessages) || out.totalMessages !== messages.length ||
      !Array.isArray(out.missingIndexes)) {
    throw new NativeMemoryPolicyError("INVALID_NATIVE_RECONCILIATION_RESPONSE");
  }
  let last = -1;
  for (const index of out.missingIndexes) {
    if (!Number.isSafeInteger(index) || index <= last || index >= messages.length) {
      throw new NativeMemoryPolicyError("INVALID_NATIVE_RECONCILIATION_RESPONSE");
    }
    last = index;
  }
  return out.missingIndexes;
}

export function nativeSynthesisValidation(spec) {
  const out = requestNativeMemoryPolicy("synthesis-validate", { spec });
  const v = out.value;
  if (!v || typeof v !== "object" || Array.isArray(v) || typeof v.ok !== "boolean" ||
      typeof v.type !== "string" || typeof v.summary !== "string" ||
      !Array.isArray(v.sources) || !v.sources.every(x => typeof x === "string") ||
      !Array.isArray(v.problems) || !v.problems.every(x => typeof x === "string") ||
      v.ok !== (v.problems.length === 0)) {
    throw new NativeMemoryPolicyError("INVALID_NATIVE_SYNTHESIS_RESPONSE");
  }
  return v;
}

// This is not an authorization API. The trusted caller must already have
// verified Kanzo ownership, read its ledger, queried both task-scoped MemoryCore
// layers and checked each result. A compromised/mismatched native formatter
// cannot replace the independently computed JavaScript expected result.
export function nativeTaskRecoverySnapshot({ ledger, taskId, agent, identity, query,
    l1Response, l0Response, maxUnits, l1Limit, l0Limit }) {
  const result = requestNativeMemoryPolicy("task-recovery-snapshot", {
    ledger, taskId, agent, identity, query, authorizationVerified: true,
    l1Response, l0Response, maxUnits, l1Limit, l0Limit,
  });
  const v = result.value;
  if (!v || typeof v !== "object" || Array.isArray(v) ||
      typeof v.ok !== "boolean" || typeof v.code !== "string" ||
      v.taskId !== taskId || v.advisory !== true ||
      !Array.isArray(v.units) || !Array.isArray(v.refs) || !Array.isArray(v.omitted) ||
      !v.refs.every(ref => ref && typeof ref.id === "string" &&
        (ref.layer === "L1" || ref.layer === "L0") && ref.taskId === taskId)) {
    throw new NativeMemoryPolicyError("INVALID_NATIVE_TASK_SNAPSHOT");
  }
  return v;
}

// Pure MemOS evidence-sufficiency policy. A Rust result is never trusted as
// authority by itself: the call site verifies exact parity against the
// independent JavaScript calculation before returning the native result.
export function nativeAnswerability(command, payload) {
  if (!["answerability-packet", "answerability-expanded", "answerability-conflicts"].includes(command)) {
    throw new NativeMemoryPolicyError("UNSUPPORTED_ANSWERABILITY_COMMAND");
  }
  const result = requestNativeMemoryPolicy(command, payload);
  const value = result.value;
  if (command === "answerability-conflicts") {
    if (!Array.isArray(value) || !value.every(c => c && typeof c.subject === "string" &&
        Array.isArray(c.candidates))) throw new NativeMemoryPolicyError("INVALID_NATIVE_ANSWERABILITY");
  } else if (!value || Array.isArray(value) || typeof value !== "object" ||
      !["SUFFICIENT", "PARTIAL", "CONFLICTED", "INSUFFICIENT"].includes(value.state) ||
      typeof value.reason !== "string" || !Array.isArray(value.missing) ||
      (value.targetedExpansion !== null && typeof value.targetedExpansion !== "string")) {
    throw new NativeMemoryPolicyError("INVALID_NATIVE_ANSWERABILITY");
  }
  return value;
}
