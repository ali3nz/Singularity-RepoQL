// deployment-intent.mjs — V3.5.3 (ticket 188, plan §108 P0, WP-A). INVARIANT C:
// deployment FRESHNESS — what is approved to land, and whether it is still
// current at execution time. Separate from worker ownership (INVARIANT A) and
// resource mutation ownership (INVARIANT B); plan §17.
//
// Per-resource intent record (case brief verbatim shape):
//   { resourceId, generation (monotonic), caseId, operation, approvedAt,
//     sourceSha256, configSha256, policySha256, artifactIdentity, status }
//
// Rules (Sol verdict consult 2026-09-30T02-27-18-965-68297):
//  - Monotonic per-resource generation. A queued intent whose generation is
//    below the current generation refuses execution (DEPLOY_STALE_GENERATION).
//    NEVER infer ordering from mtimes or timestamps.
//  - Identity uncomputable at validation time => DEPLOY_IDENTITY_UNAVAILABLE,
//    fail closed. Never deploy on "unknown" identity.
//  - Reason codes are plan §23 verbatim:
//      DEPLOY_STALE_GENERATION, DEPLOY_OWNER_MISMATCH, DEPLOY_POLICY_CHANGED,
//      DEPLOY_CONFIG_CHANGED, DEPLOY_ARTIFACT_CHANGED, DEPLOY_IDENTITY_UNAVAILABLE
//    plus case-brief addition DEPLOY_SOURCE_CHANGED for source-sha drift.
//
// V3.5.4 (review NEEDS_FIX fixPlan step 1): queueDeploymentIntent and
// markIntentStatus run their store read-modify-write transactions inside the
// cross-process exclusive-create mutex (lib/state-lock.mjs) keyed on
// `<statePath>.lock`, so two processes can no longer both commit an
// incompatible successor state (lost updates, duplicated generations). Pure
// validations (resource id, case id, status names, identity computation) stay
// OUTSIDE the lock; the generation allocation, supersession sweep, status
// transition and terminal-intent guards are decided UNDER the lock. Record
// shapes and reason codes are unchanged.

import { createHash } from "node:crypto";
import { readFileSync, writeFileSync, renameSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { withStateLockSync } from "./state-lock.mjs";

export const DEPLOY_REASON_CODES = Object.freeze({
  STALE_GENERATION: "DEPLOY_STALE_GENERATION",
  OWNER_MISMATCH: "DEPLOY_OWNER_MISMATCH",
  POLICY_CHANGED: "DEPLOY_POLICY_CHANGED",
  CONFIG_CHANGED: "DEPLOY_CONFIG_CHANGED",
  SOURCE_CHANGED: "DEPLOY_SOURCE_CHANGED",
  ARTIFACT_CHANGED: "DEPLOY_ARTIFACT_CHANGED",
  IDENTITY_UNAVAILABLE: "DEPLOY_IDENTITY_UNAVAILABLE",
});

export const INTENT_STATUS = Object.freeze({
  QUEUED: "queued",      // recorded, not yet executing
  APPROVED: "approved",  // plan gate approved, eligible for gate execution
  EXECUTING: "executing",// gate holds the resource lease and is in the flow
  DEPLOYED: "deployed",  // safe-restart invocation completed, evidence captured
  REFUSED: "refused",    // gate refused with typed reason code(s)
  SUPERSEDED: "superseded", // a higher generation was queued for the resource
});

const RESOURCE_IDS = [
  "openchamber/runtime",
  "openchamber/source",
  "orchestration/canonical-rules",
  "orchestration/config",
  "deploy/openchamber",
  "deploy/bridge",
];

function sha256File(p) {
  return createHash("sha256").update(readFileSync(p)).digest("hex");
}

const SHA256_HEX = /^[0-9a-f]{64}$/i;
function isSha256(value) {
  return typeof value === "string" && SHA256_HEX.test(value);
}

// Aggregate identity alone is not a deployment pin: at least one attributable
// input must be pinned, either a content digest or a non-empty artifact id.
export function hasDeploymentIdentityPins(identity) {
  return isSha256(identity?.sourceSha256)
    || isSha256(identity?.configSha256)
    || isSha256(identity?.policySha256)
    || (typeof identity?.artifactIdentity === "string" && identity.artifactIdentity.trim().length > 0);
}

// Deterministic content identity for one intent: sha256 over the pinned
// inputs in FIXED order (source, config, policy). At least one content digest
// or non-empty artifactIdentity is required; an aggregate hash alone is not a
// deploy pin. Unreadable input is a typed identity failure, never a wildcard.
// Returns the combined digest AND per-input digests so the gate can attribute
// a change to policy/config/source with the verbatim DEPLOY_* reason codes.
export function computeDeploymentIdentity({ sourcePath, configPath, policyPath, artifactIdentity }) {
  const missing = [];
  const parts = [];
  const perFile = { sourceSha256: null, configSha256: null, policySha256: null };
  for (const [name, p, key] of [["source", sourcePath, "sourceSha256"], ["config", configPath, "configSha256"], ["policy", policyPath, "policySha256"]]) {
    if (p == null) continue; // optional input: omitted means "not pinned", not "unknown"
    try {
      const d = sha256File(p);
      parts.push(`${name}:${d}`);
      perFile[key] = d;
    } catch { missing.push(name); }
  }
  if (missing.length > 0) {
    return { ok: false, reason: DEPLOY_REASON_CODES.IDENTITY_UNAVAILABLE, missing };
  }
  if (!hasDeploymentIdentityPins({ ...perFile, artifactIdentity })) {
    return {
      ok: false,
      reason: DEPLOY_REASON_CODES.IDENTITY_UNAVAILABLE,
      missing: ["source", "config", "policy", "artifactIdentity"],
    };
  }
  const h = createHash("sha256");
  for (const part of parts) h.update(`${part}\n`);
  h.update(`artifact:${artifactIdentity ?? "unspecified"}\n`);
  return { ok: true, identity: h.digest("hex"), artifactIdentity: artifactIdentity ?? null, ...perFile };
}

// Create a queued intent for a resource. Generation is allocated monotonically
// per resource from the store — never derived from timestamps.
export function queueDeploymentIntent({ resourceId, caseId, operation, approvedAt, sourcePath, configPath, policyPath, artifactIdentity, identity, statePath }) {
  if (!RESOURCE_IDS.includes(resourceId)) {
    return { ok: false, reason: "unknown-resource-id", resourceId };
  }
  if (!caseId) return { ok: false, reason: "missing-case-id" };
  // Identity must be computed BEFORE queueing: fail closed when uncomputable.
  // (Pure computation — kept outside the mutex on purpose.)
  const id = identity ?? computeDeploymentIdentity({ sourcePath, configPath, policyPath, artifactIdentity });
  if (!id.ok) return { ok: false, reason: id.reason, missing: id.missing };
  const missingPins = [];
  for (const [path, field] of [[sourcePath, "sourceSha256"], [configPath, "configSha256"], [policyPath, "policySha256"]]) {
    if (path != null && !isSha256(id[field])) missingPins.push(field);
  }
  if (missingPins.length) return { ok: false, reason: DEPLOY_REASON_CODES.IDENTITY_UNAVAILABLE, missing: missingPins };
  const queuedIdentity = {
    sourceSha256: sourcePath ? id.sourceSha256 : null,
    configSha256: configPath ? id.configSha256 : null,
    policySha256: policyPath ? id.policySha256 : null,
    artifactIdentity: artifactIdentity ?? null,
  };
  if (!hasDeploymentIdentityPins(queuedIdentity)) {
    return {
      ok: false,
      reason: DEPLOY_REASON_CODES.IDENTITY_UNAVAILABLE,
      missing: ["sourceSha256", "configSha256", "policySha256", "artifactIdentity"],
    };
  }
  let out = null;
  updateStore(statePath, (s) => {
    s.intents = s.intents ?? {};
    s.generations = s.generations ?? {};
    // Generation allocation happens UNDER the lock: monotonic per resource,
    // never derived from timestamps; two racing processes now serialize and
    // each gets a distinct generation.
    const current = s.generations[resourceId] ?? 0;
    const generation = current + 1;
    s.generations[resourceId] = generation;
    // Any still-queued lower-generation intents for this resource are superseded
    // NOW (deterministic, at queue time — not discovered at execution time).
    for (const [, rec] of Object.entries(s.intents)) {
      if (rec.resourceId === resourceId && rec.status === INTENT_STATUS.QUEUED && rec.generation < generation) {
        rec.status = INTENT_STATUS.SUPERSEDED;
        rec.supersededBy = generation;
      }
    }
    const intent = {
      intentId: `${resourceId}#${generation}`,
      resourceId, generation, caseId,
      operation: operation ?? "restart",
      approvedAt: approvedAt ?? new Date().toISOString(),
      // Use the exact per-input digests that formed `id.identity`; do not
      // re-read files and create a mixed-time identity snapshot.
      sourceSha256: sourcePath ? id.sourceSha256 : null,
      configSha256: configPath ? id.configSha256 : null,
      policySha256: policyPath ? id.policySha256 : null,
      artifactIdentity: artifactIdentity ?? null,
      identity: id.identity,
      status: INTENT_STATUS.QUEUED,
      queuedAt: new Date().toISOString(),
    };
    s.intents[intent.intentId] = intent;
    out = { ok: true, intent };
    return s;
  });
  return out;
}

export function loadIntent(intentId, { statePath } = {}) {
  return loadStore(statePath).intents?.[intentId] ?? null;
}

export function currentGeneration(resourceId, { statePath } = {}) {
  return loadStore(statePath).generations?.[resourceId] ?? 0;
}

// Set status with fail-closed transitions: DEPLOYED/REFUSED are terminal for
// an intent; a QUEUED intent may not jump to DEPLOYED without EXECUTING.
export function markIntentStatus(intentId, status, { note, statePath } = {}) {
  if (!Object.values(INTENT_STATUS).includes(status)) return { ok: false, reason: "unknown-status", status };
  let out = null;
  updateStore(statePath, (s) => {
    const rec = s.intents?.[intentId];
    if (!rec) { out = { ok: false, reason: "absent-intent", intentId }; return s; }
    const TERMINAL = [INTENT_STATUS.DEPLOYED, INTENT_STATUS.REFUSED, INTENT_STATUS.SUPERSEDED];
    if (TERMINAL.includes(rec.status) && rec.status !== status) {
      out = { ok: false, reason: "terminal-intent", from: rec.status, to: status };
      return s;
    }
    if (status === INTENT_STATUS.DEPLOYED && rec.status !== INTENT_STATUS.EXECUTING) {
      out = { ok: false, reason: "deployed-requires-executing", from: rec.status };
      return s;
    }
    rec.status = status;
    if (note) rec.statusNote = String(note);
    rec.statusAt = new Date().toISOString();
    out = { ok: true, intent: rec };
    return s;
  });
  return out;
}

// Claim the intent for its pre-wait execution phase atomically with the
// generation check. A concurrent queue either wins first (this refuses stale)
// or follows this transition; it cannot race between the check and status write.
export function claimIntentForExecution(intentId, { caseId, statePath } = {}) {
  let out = null;
  updateStore(statePath, (s) => {
    const rec = s.intents?.[intentId];
    if (!rec) { out = { ok: false, reason: "absent-intent" }; return s; }
    if (!caseId || rec.caseId !== caseId) { out = { ok: false, reason: DEPLOY_REASON_CODES.OWNER_MISMATCH }; return s; }
    if (rec.status !== INTENT_STATUS.QUEUED && rec.status !== INTENT_STATUS.APPROVED) {
      out = { ok: false, reason: rec.status === INTENT_STATUS.SUPERSEDED ? DEPLOY_REASON_CODES.STALE_GENERATION : "intent-status-invalid" };
      return s;
    }
    const current = s.generations?.[rec.resourceId] ?? 0;
    if (rec.generation < current) { out = { ok: false, reason: DEPLOY_REASON_CODES.STALE_GENERATION }; return s; }
    rec.status = INTENT_STATUS.EXECUTING;
    rec.statusAt = new Date().toISOString();
    out = { ok: true, intent: rec };
    return s;
  });
  return out;
}

// Final linearization point before the primitive is invoked. This re-checks
// generation and owner under the store mutex and records the reservation. A
// queue that commits first makes the intent stale; a queue after this point is
// ordered after an already-authorized invocation.
export function claimIntentForInvocation(intentId, { caseId, statePath } = {}) {
  let out = null;
  updateStore(statePath, (s) => {
    const rec = s.intents?.[intentId];
    if (!rec) { out = { ok: false, reason: "absent-intent" }; return s; }
    if (!caseId || rec.caseId !== caseId) { out = { ok: false, reason: DEPLOY_REASON_CODES.OWNER_MISMATCH }; return s; }
    if (rec.status !== INTENT_STATUS.EXECUTING) { out = { ok: false, reason: "intent-not-executing" }; return s; }
    if (rec.executionClaimedAt) { out = { ok: false, reason: "intent-already-claimed" }; return s; }
    const current = s.generations?.[rec.resourceId] ?? 0;
    if (rec.generation < current) { out = { ok: false, reason: DEPLOY_REASON_CODES.STALE_GENERATION }; return s; }
    rec.executionClaimedAt = new Date().toISOString();
    out = { ok: true, intent: rec };
    return s;
  });
  return out;
}

// Static freshness checks against a store snapshot — no live identity here.
// The deploy gate calls this BEFORE the idle wait and again AFTER it.
export function checkIntentFreshness(intent, { currentGen, expectedOwnerCaseId }) {
  const reasons = [];
  if (currentGen != null && intent.generation < currentGen) reasons.push(DEPLOY_REASON_CODES.STALE_GENERATION);
  if (expectedOwnerCaseId != null && intent.caseId !== expectedOwnerCaseId) reasons.push(DEPLOY_REASON_CODES.OWNER_MISMATCH);
  if (intent.status === INTENT_STATUS.SUPERSEDED && !reasons.includes(DEPLOY_REASON_CODES.STALE_GENERATION)) {
    reasons.push(DEPLOY_REASON_CODES.STALE_GENERATION);
  }
  return { ok: reasons.length === 0, reasons };
}

// Compare pinned identities captured at queue time against recomputed
// current identities (used by the gate AFTER the idle wait).
export function compareIntentIdentities(intent, current) {
  const reasons = [];
  const missing = [];
  if (current?.ok === false) {
    reasons.push(DEPLOY_REASON_CODES.IDENTITY_UNAVAILABLE);
    return { ok: false, reasons, missing: current.missing ?? [] };
  }
  for (const [field, reason] of [
    ["policySha256", DEPLOY_REASON_CODES.POLICY_CHANGED],
    ["configSha256", DEPLOY_REASON_CODES.CONFIG_CHANGED],
    ["sourceSha256", DEPLOY_REASON_CODES.SOURCE_CHANGED],
    ["artifactIdentity", DEPLOY_REASON_CODES.ARTIFACT_CHANGED],
  ]) {
    const pinned = intent?.[field];
    if (pinned == null) continue; // not pinned at queue time
    if (current?.[field] == null) {
      missing.push(field);
      continue;
    }
    if (pinned !== current[field]) reasons.push(reason);
  }
  if (missing.length) reasons.push(DEPLOY_REASON_CODES.IDENTITY_UNAVAILABLE);
  return { ok: reasons.length === 0, reasons: [...new Set(reasons)], missing };
}

// ---- store helpers (same sandbox-friendly shape as the other WP-A modules) --
const DEFAULT_STORE = () => ({ intents: {}, generations: {} });
const DEFAULT_STORE_PATH = join(dirname(fileURLToPath(import.meta.url)), "..", "runs", "deployment-intents.json");
function storeUnavailable(statePath, cause) {
  const err = new Error(`STATE_STORE_UNAVAILABLE: ${statePath}: ${cause?.message ?? cause}`);
  err.code = "STATE_STORE_UNAVAILABLE";
  err.cause = cause;
  return err;
}
function loadStore(statePath) {
  const p = statePath ?? DEFAULT_STORE_PATH;
  let raw;
  try { raw = readFileSync(p, "utf8"); }
  catch (err) {
    if (err?.code === "ENOENT") return DEFAULT_STORE();
    throw storeUnavailable(p, err);
  }
  let parsed;
  try { parsed = JSON.parse(raw); }
  catch (err) { throw storeUnavailable(p, err); }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)
      || (parsed.intents !== undefined && (!parsed.intents || typeof parsed.intents !== "object" || Array.isArray(parsed.intents)))
      || (parsed.generations !== undefined && (!parsed.generations || typeof parsed.generations !== "object" || Array.isArray(parsed.generations)))) {
    throw storeUnavailable(p, new Error("invalid deployment-intent store shape"));
  }
  return { ...DEFAULT_STORE(), ...parsed };
}
function saveStore(s, statePath) {
  const p = statePath ?? DEFAULT_STORE_PATH;
  const tmp = p + ".tmp-" + process.pid;
  writeFileSync(tmp, JSON.stringify(s, null, 2) + "\n");
  renameSync(tmp, p);
}
// Cross-process-safe store RMW (review NEEDS_FIX step 1): the whole
// transaction is serialized under an exclusive-create mutex next to the
// store file. fn MUST be synchronous. Typed lock failure throws — no silent
// partial mutation.
const MUTEX_OPTS = { timeoutMs: 10_000, pollMs: 5, graceMs: 30_000 };
function updateStore(statePath, fn) {
  const p = statePath ?? DEFAULT_STORE_PATH;
  const r = withStateLockSync(p + ".lock", () => {
    const next = fn(loadStore(p));
    saveStore(next, p); // commit before releasing the cross-process mutex
    return next;
  }, MUTEX_OPTS);
  if (!r.ok) {
    const err = new Error(`state-lock: ${r.reason ?? "failed"} (${p})`);
    err.code = r.reason ?? "STATE_LOCK_FAILED";
    throw err;
  }
  return r.value;
}
export function intentStorePath() { return DEFAULT_STORE_PATH; }
export function _loadStoreForTest(statePath) { return loadStore(statePath); }
