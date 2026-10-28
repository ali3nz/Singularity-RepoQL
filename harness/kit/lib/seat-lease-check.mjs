// seat-lease-check.mjs — ticket 189 K4: thin READ-ONLY wrapper over the
// protected worker-lease file (lib/worker-lease.mjs is never edited). Tells a
// starting run, BEFORE the paid planning gate, whether the Freebuff seats it
// needs are held by another live run — so it can refuse with a clear message
// instead of failing deep inside thread acquisition. No silent substitution.
import { readFileSync } from "node:fs";
import { leaseStatePath } from "./worker-lease.mjs";

const defaultAlive = (pid) => { try { readFileSync(`/proc/${pid}/cmdline`); return true; } catch { return false; } };

// seatIds: Freebuff seat ids the run needs (e.g. ["alpha","beta"]).
// Returns { ok, busy:[{seat, caseId, ownerPid}] }. A lease whose owner pid is
// dead is takeover-safe (worker-lease semantics) and is NOT reported busy.
export function checkFreebuffSeatsFree(seatIds, { caseId = null, leaseFile = leaseStatePath(), isAlive = defaultAlive } = {}) {
  let leases = {};
  try { leases = JSON.parse(readFileSync(leaseFile, "utf8")).leases ?? {}; } catch { leases = {}; }
  const busy = [];
  for (const seat of seatIds ?? []) {
    const cur = leases[seat];
    if (!cur) continue;
    if (caseId && cur.caseId === caseId) continue;
    if (cur.ownerPid && isAlive(cur.ownerPid)) busy.push({ seat, caseId: cur.caseId, ownerPid: cur.ownerPid });
  }
  return { ok: busy.length === 0, busy };
}

export function seatBusyMessage(busy) {
  return `Freebuff seats busy in run ${[...new Set(busy.map((b) => b.caseId))].join(", ")} (${busy.map((b) => b.seat).join(", ")}) — use a free-model roster or wait`;
}
