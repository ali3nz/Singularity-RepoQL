// resource-lease.mjs — V3.5.3 (ticket 188, plan §108 P0, WP-A). Per-RESOURCE
// mutation leases (INVARIANT B). Deliberately SEPARATE from worker leases
// (INVARIANT A, lib/worker-lease.mjs — never merge; plan §17: worker ownership,
// resource mutation ownership and deployment freshness are three different
// things). One lease per collision domain (resourceId); the holder's case
// exclusively owns MUTATION of that resource while the lease lives.
//
// Collision domains (plan §108): openchamber/runtime, openchamber/source,
// orchestration/canonical-rules, orchestration/config, deploy/openchamber,
// deploy/bridge.
//
// Same takeover discipline as worker leases: expiry alone NEVER authorises a
// second writer — takeover requires proof the first actor is gone (dead pid)
// or operator force outside this module. Liveness check hardens the plain
// /proc read with the kit's 4-factor lesson: a readable-but-EMPTY cmdline is a
// ZOMBIE, and zombies do not hold resources.
//
// V3.5.4 (review NEEDS_FIX fixPlan step 1): every read-modify-write mutation
// below now runs inside a cross-process exclusive-create mutex
// (lib/state-lock.mjs) keyed on `<statePath>.lock`. Record shapes, reason
// codes, takeover semantics and the INVARIANT A/B/C separation are unchanged;
// only the transaction atomicity is new. Readers (confirm/audit) stay lock-free
// — renameSync makes each committed state fully visible to them.

import { readFileSync, writeFileSync, renameSync } from "node:fs";
import { join } from "node:path";
import { withStateLockSync } from "./state-lock.mjs";

const KNOWN_RESOURCE_IDS = Object.freeze([
  "openchamber/runtime",
  "openchamber/source",
  "orchestration/canonical-rules",
  "orchestration/config",
  "deploy/openchamber",
  "deploy/bridge",
  "secondbrain/vault-write", // ticket 315: Second Brain write-path collision domain (Sol Gate 1)
]);

const LEASE_FILE = join(import.meta.dirname ?? ".", "..", "runs", "resource-leases.json");

function storeUnavailable(statePath, cause) {
  const err = new Error(`STATE_STORE_UNAVAILABLE: ${statePath}: ${cause?.message ?? cause}`);
  err.code = "STATE_STORE_UNAVAILABLE";
  err.cause = cause;
  return err;
}
function load(statePath = LEASE_FILE) {
  let raw;
  try { raw = readFileSync(statePath, "utf8"); }
  catch (err) {
    if (err?.code === "ENOENT") return { leases: {} };
    throw storeUnavailable(statePath, err);
  }
  let state;
  try { state = JSON.parse(raw); }
  catch (err) { throw storeUnavailable(statePath, err); }
  if (!state || typeof state !== "object" || Array.isArray(state)
      || (state.leases !== undefined && (!state.leases || typeof state.leases !== "object" || Array.isArray(state.leases)))) {
    throw storeUnavailable(statePath, new Error("invalid resource-lease store shape"));
  }
  return { ...state, leases: state.leases ?? {} };
}
function save(state, statePath = LEASE_FILE) {
  const tmp = statePath + ".tmp-" + process.pid;
  writeFileSync(tmp, JSON.stringify(state, null, 2) + "\n");
  renameSync(tmp, statePath);
}

// Cross-process-safe read-modify-write (review NEEDS_FIX step 1): the whole
// transaction is serialized under an exclusive-create mutex next to the store
// file. fn MUST be synchronous and returns the (possibly mutated) state.
// Typed lock failure throws — no silent partial mutation.
const MUTEX_OPTS = { timeoutMs: 10_000, pollMs: 5, graceMs: 30_000 };
function update(statePath, fn) {
  const p = statePath ?? LEASE_FILE;
  const r = withStateLockSync(p + ".lock", () => {
    const next = fn(load(p));
    save(next, p); // commit before releasing the cross-process mutex
    return next;
  }, MUTEX_OPTS);
  if (!r.ok) {
    const err = new Error(`state-lock: ${r.reason ?? "failed"} (${p})`);
    err.code = r.reason ?? "STATE_LOCK_FAILED";
    throw err;
  }
  return r.value;
}

// /proc/<pid>/cmdline readable AND non-empty => alive. Unreadable (gone) or
// empty (zombie) => provably not a running owner.
function pidAlive(pid) {
  try { return readFileSync(`/proc/${pid}/cmdline`, "utf8").length > 0; } catch { return false; }
}

// Acquire the exclusive mutation lease for a resource. Returns
// { ok:true, lease } or { ok:false, reason, holder? } — never force-takes.
// Same-case reacquire is idempotent (resume-after-restart path).
export function acquireResourceLease({ resourceId, caseId, threadId, heartbeatMs = 60_000, statePath, extraResourceIds = [] }) {
  if (!KNOWN_RESOURCE_IDS.includes(resourceId) && !extraResourceIds.includes(resourceId)) {
    return { ok: false, reason: "unknown-resource-id", resourceId };
  }
  if (!caseId) return { ok: false, reason: "missing-case-id", resourceId };
  let decision = null;
  update(statePath, (s) => {
    s.leases = s.leases ?? {};
    const cur = s.leases[resourceId];
    const now = Date.now();
    if (cur) {
      if (cur.caseId === caseId) {
        // Same-case reacquisition is idempotent only within the same live
        // process. A second process for the same case cannot steal a lease
        // from a live owner; a dead owner may be resumed safely.
        if (cur.ownerPid !== process.pid && pidAlive(cur.ownerPid)) {
          decision = { ok: false, reason: "held-by-same-case", holder: { caseId: cur.caseId, ownerPid: cur.ownerPid, since: cur.since } };
          return s;
        }
      } else {
        // Held by another case: takeover ONLY on provable owner death. Expiry
        // alone is NOT sufficient (plan §17/D14 discipline carried over).
        const ownerAlive = pidAlive(cur.ownerPid);
        if (ownerAlive && now - (cur.heartbeatAt ?? 0) < (cur.heartbeatMs ?? heartbeatMs) * 2) {
          decision = { ok: false, reason: "held-by-other-case", holder: { caseId: cur.caseId, ownerPid: cur.ownerPid, since: cur.since } };
          return s; // no mutation under a live foreign holder
        }
        if (ownerAlive) {
          decision = { ok: false, reason: "owner-alive-heartbeat-stale", holder: { caseId: cur.caseId, ownerPid: cur.ownerPid } };
          return s;
        }
        // Owner process provably dead (gone or zombie) -> safe takeover, recorded.
      }
    }
    const lease = {
      resourceId, caseId, threadId: threadId ?? null, ownerPid: process.pid,
      since: cur?.caseId === caseId ? cur.since : new Date().toISOString(),
      heartbeatAt: now, heartbeatMs,
      takeoverOf: cur && (cur.caseId !== caseId || cur.ownerPid !== process.pid)
        ? { prevCaseId: cur.caseId, prevOwnerPid: cur.ownerPid, at: new Date().toISOString() }
        : cur?.takeoverOf,
    };
    s.leases[resourceId] = lease;
    decision = { ok: true, lease };
    return s;
  });
  return decision;
}

export function heartbeatResourceLease(resourceId, { caseId, statePath } = {}) {
  let out = false;
  update(statePath, (s) => {
    const cur = s.leases?.[resourceId];
    if (cur && cur.caseId === caseId && cur.ownerPid === process.pid) {
      cur.heartbeatAt = Date.now();
      out = true;
    }
    return s;
  });
  return out;
}

// Read-only confirmation used by the deploy gate between its steps: the lease
// must exist AND belong to the expected case.
export function confirmResourceLease(resourceId, { caseId, statePath } = {}) {
  const s = load(statePath);
  const cur = s.leases?.[resourceId];
  if (!cur) return { ok: false, reason: "absent", resourceId };
  if (caseId && cur.caseId !== caseId) return { ok: false, reason: "not-lease-owner", resourceId, holder: { caseId: cur.caseId } };
  return { ok: true, lease: cur };
}

export function releaseResourceLease(resourceId, { caseId, statePath } = {}) {
  let out = { ok: true, note: "absent" };
  update(statePath, (s) => {
    const cur = s.leases?.[resourceId];
    if (!cur) { out = { ok: true, note: "absent" }; return s; }
    if (caseId && cur.caseId !== caseId) { out = { ok: false, reason: "not-lease-owner" }; return s; }
    if (cur.ownerPid !== process.pid) { out = { ok: false, reason: "not-owner-pid" }; return s; }
    delete s.leases[resourceId];
    out = { ok: true };
    return s;
  });
  return out;
}

// Contamination audit: every lease must name a known collision domain (unless
// the caller extended it) and carry a caseId.
export function auditResourceLeases({ statePath, extraResourceIds = [] } = {}) {
  const s = load(statePath);
  const problems = [];
  for (const [resourceId, lease] of Object.entries(s.leases ?? {})) {
    if (!KNOWN_RESOURCE_IDS.includes(resourceId) && !extraResourceIds.includes(resourceId)) {
      problems.push({ resourceId, problem: "unknown-resource-id" });
    }
    if (!lease.caseId) problems.push({ resourceId, problem: "lease-without-case" });
  }
  return { ok: problems.length === 0, problems, leases: s.leases ?? {} };
}

export const RESOURCE_IDS = KNOWN_RESOURCE_IDS;
export function resourceLeaseStatePath() { return LEASE_FILE; }
export function _loadForTest(statePath) { return load(statePath); }
