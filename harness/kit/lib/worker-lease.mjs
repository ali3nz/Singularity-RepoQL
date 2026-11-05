// worker-lease.mjs — V3.3.35 (ticket 085, plan D14 + acceptance #12). Exclusive
// worker leases across cases: a Freebuff thread (purchased capacity) is bound
// to ONE active case lease at a time; a case's assignment cannot be inherited
// by another case while the first may still be running. Lease expiry alone
// never authorises a second writer — takeover requires proof the first actor
// is gone (dead pid heartbeat) or operator force. Provider-side
// capacity-vs-conversation distinction is not assumed; where the provider
// cannot prove isolation, callers must set isolation:"unknown" honestly.

import { readFileSync, writeFileSync, existsSync, renameSync } from "node:fs";
import { join } from "node:path";

const LEASE_FILE = join(import.meta.dirname ?? ".", "..", "runs", "worker-leases.json");

function load() { try { return JSON.parse(readFileSync(LEASE_FILE, "utf8")); } catch { return { leases: {} }; } }
function save(l) {
  const tmp = LEASE_FILE + ".tmp-" + process.pid;
  writeFileSync(tmp, JSON.stringify(l, null, 2) + "\n");
  renameSync(tmp, LEASE_FILE);
}

// Acquire an exclusive lease of a worker thread for a case. Returns
// { ok:true, lease } or { ok:false, reason, holder } — never force-takes.
export function acquireLease({ workerId, caseId, threadId, heartbeatMs = 60_000 }) {
  const l = load();
  l.leases = l.leases ?? {};
  const cur = l.leases[workerId];
  const now = Date.now();
  if (cur && cur.caseId !== caseId) {
    // Held by another case: takeover ONLY on provable owner death (heartbeat
    // written by a now-dead pid). Expiry alone is NOT sufficient (plan D14:
    // "lease expiry alone must not authorise a second writer").
    const ownerAlive = (() => { try { readFileSync(`/proc/${cur.ownerPid}/cmdline`); return true; } catch { return false; } })();
    if (ownerAlive && now - (cur.heartbeatAt ?? 0) < (cur.heartbeatMs ?? heartbeatMs) * 2) {
      return { ok: false, reason: "held-by-other-case", holder: { caseId: cur.caseId, ownerPid: cur.ownerPid, since: cur.since } };
    }
    if (ownerAlive) return { ok: false, reason: "owner-alive-heartbeat-stale", holder: { caseId: cur.caseId, ownerPid: cur.ownerPid } };
    // Owner process provably dead -> safe takeover, recorded.
  }
  const lease = { workerId, caseId, threadId: threadId ?? null, ownerPid: process.pid, since: new Date().toISOString(), heartbeatAt: now, heartbeatMs };
  l.leases[workerId] = lease;
  save(l);
  return { ok: true, lease };
}

export function heartbeat(workerId) {
  const l = load();
  const cur = l.leases?.[workerId];
  if (!cur || cur.ownerPid !== process.pid) return false;
  cur.heartbeatAt = Date.now();
  save(l);
  return true;
}

export function releaseLease(workerId, { caseId } = {}) {
  const l = load();
  const cur = l.leases?.[workerId];
  if (!cur) return { ok: true, note: "absent" };
  if (caseId && cur.caseId !== caseId) return { ok: false, reason: "not-lease-owner" };
  if (cur.ownerPid !== process.pid) return { ok: false, reason: "not-owner-pid" };
  delete l.leases[workerId];
  save(l);
  return { ok: true };
}

// Contamination audit for tests + closeout: no workerId may hold leases
// referencing two different cases concurrently.
export function auditLeases() {
  const l = load();
  const problems = [];
  for (const [workerId, lease] of Object.entries(l.leases ?? {})) {
    if (!lease.caseId) problems.push({ workerId, problem: "lease-without-case" });
  }
  return { ok: problems.length === 0, problems, leases: l.leases ?? {} };
}

export function leaseStatePath() { return LEASE_FILE; }
export function _loadForTest() { return load(); }
