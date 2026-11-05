// session-bridge.mjs — V3.4.1 (ticket 126): pure logic for the OpenChamber↔
// ai-orchestra session bridge. Sol consult 2026-09-27T03-25-50-619-62107
// (CONFIRMED; FIX PLAN items 1–8) is the design authority:
//   • TWO DIFFERENT TIMERS: the kit reuse window (spawnedAt + sessionReuseMinutes,
//     from recorded pool metadata) vs the provider hard expiry (~1 h, NOT exposed).
//     Anything surfaced must say "not exposed" for the provider clock — never
//     invent a countdown we do not have.
//   • Reuse NEVER silently falls back to a new session: outcomes are explicit
//     (REUSED_SAME_SESSION / SESSION_EXPIRED / SESSION_NOT_FOUND / SESSION_BUSY /
//     REUSE_FAILED); a new worker is a separate intentional action.
//   • One owner per pooled session: a bounded lease on each pool entry; a second
//     concurrent request gets SESSION_BUSY.
// Pure functions only (I/O injected) so selftest can pin the state machine
// without touching the Freebuff API.
import { readFileSync, writeFileSync, renameSync, openSync, closeSync, rmSync, mkdirSync } from "node:fs";

export const REUSE_OUTCOMES = {
  REUSED_SAME_SESSION: { rc: 0 },
  SESSION_NOT_FOUND: { rc: 3 },
  SESSION_EXPIRED: { rc: 4 },
  SESSION_BUSY: { rc: 5 },
  REUSE_FAILED: { rc: 6 },
};

export const LEASE_TTL_MS = 10 * 60_000; // dispatch lock; isBusy() is the real in-task guard

// --------------------------- state machine (Sol FIX PLAN) ---------------------------
// IDLE = no reusable worker in the pool view; ACTIVE = worker executing;
// COMPLETE_REUSABLE = alive, idle, unleased (THE state OpenChamber exposes);
// EXPIRED = outside the kit window or probe-dead inside it; FAILED = a bridge
// operation recorded a failure. STARTING/CONSULTING_SOL/REUSING are
// coordinator-side transients — the bridge reports observed truth only.
export function classifySessionState({ alive, busy, remainingSeconds, lease, now = Date.now() }) {
  if (remainingSeconds <= 0) return "EXPIRED";
  if (!alive) return "EXPIRED"; // provider died inside the kit window (Sol TEST 7)
  if (lease && !leaseExpired(lease, now)) return "ACTIVE"; // a bridge owner is dispatching/driving
  if (busy) return "ACTIVE";
  return "COMPLETE_REUSABLE";
}

// --------------------------- view builder (FIX PLAN item 3) ---------------------------
// pool: raw pool.json map; now: epoch ms; probes: { sessionId → { alive, busy } }
// injected by the caller (real = sessionAlive/isBusy; tests = fixtures).
export function buildSessionView({ pool, now, reuseMinutes, probes = {}, leases = {} }) {
  const sessions = [];
  for (const [sessionId, e] of Object.entries(pool ?? {})) {
    if (!e?.threadId) continue;
    const spawnedAt = Number(e.spawnedAt) || 0;
    const reuseDeadline = spawnedAt + reuseMinutes * 60_000;
    const reuseRemainingSeconds = Math.max(0, Math.ceil((reuseDeadline - now) / 1000));
    if (reuseRemainingSeconds <= 0) continue; // retired from the view; pool pruning owns the file
    const probe = probes[sessionId] ?? { alive: false, busy: true };
    const lease = leases[sessionId] ?? null;
    sessions.push({
      sessionId,
      threadId: e.threadId,
      provider: "freebuff",
      state: classifySessionState({ alive: probe.alive, busy: probe.busy, remainingSeconds: reuseRemainingSeconds, lease, now }),
      spawnedAt,
      spawnedAtIso: new Date(spawnedAt).toISOString(),
      reuseDeadline,
      reuseDeadlineIso: new Date(reuseDeadline).toISOString(),
      reuseRemainingSeconds,
      alive: probe.alive,
      busy: probe.busy,
      runId: e.lastRunId ?? null,
      lease: lease && !leaseExpired(lease, now)
        ? { owner: lease.owner, leaseAcquiredAt: lease.leaseAcquiredAt, expiresAt: lease.leaseAcquiredAt + (lease.ttlMs ?? LEASE_TTL_MS) }
        : null,
    });
  }
  sessions.sort((a, b) => b.reuseRemainingSeconds - a.reuseRemainingSeconds);
  return {
    ok: true,
    serverNow: now,
    serverNowIso: new Date(now).toISOString(),
    kitReuseWindowMinutes: reuseMinutes,
    providerExpiry: null, // FIX PLAN: provider hard expiry is NOT exposed — do not fake it
    providerExpiryNote: "not exposed by provider; kit reuse window is the only bounded timer",
    sessions,
  };
}

// --------------------------- lease (FIX PLAN item 7) ---------------------------
export function leaseExpired(lease, now = Date.now()) {
  return !lease || !lease.leaseAcquiredAt || (lease.leaseAcquiredAt + (lease.ttlMs ?? LEASE_TTL_MS)) <= now;
}

export function readLeases(file) {
  try { return JSON.parse(readFileSync(file, "utf8")); } catch { return {}; }
}

// CAS-style write: caller re-reads under its own check-then-write; single-host
// atomicity comes from tmp-rename (same discipline as the pool file).
export function writeLeases(file, leases) {
  const tmp = `${file}.tmp-${process.pid}`;
  writeFileSync(tmp, JSON.stringify(leases, null, 2) + "\n");
  renameSync(tmp, file);
}

export function acquireLease(leases, sessionId, owner, now = Date.now(), ttlMs = LEASE_TTL_MS) {
  const existing = leases[sessionId];
  if (existing && !leaseExpired(existing, now)) return { ok: false, holder: existing.owner };
  leases[sessionId] = { owner, leaseAcquiredAt: now, ttlMs };
  return { ok: true };
}

export function releaseLease(leases, sessionId, owner) {
  const existing = leases[sessionId];
  if (existing?.owner === owner) delete leases[sessionId];
  return leases;
}

// --------------------------- reuse pre-checks (FIX PLAN item 5) ---------------------------
// Returns null when every identity/lease/window check passes, else the explicit
// failure outcome. Order matters: identity → window → liveness → busy → lease.
export function checkReusePreconditions({ poolEntry, sessionId, now, reuseMinutes, probe, leases }) {
  if (!poolEntry?.threadId) return "SESSION_NOT_FOUND";
  const reuseDeadline = (Number(poolEntry.spawnedAt) || 0) + reuseMinutes * 60_000;
  if (now >= reuseDeadline) return "SESSION_EXPIRED";
  if (!probe?.alive) return "SESSION_EXPIRED";
  if (probe.busy) return "SESSION_BUSY";
  const lease = leases?.[sessionId];
  if (lease && !leaseExpired(lease, now)) return "SESSION_BUSY";
  return null;
}

// --------------------------- atomic reuse RMW lock (ticket 126 T5b finding) ---------------------------
// Live finding (run 2026-09-27T20-13-52, T5b): acquireLease+writeBridgeLeases is
// check-then-write with tmp-rename — crash-safe but NOT a cross-process mutex,
// so two concurrent `session-reuse` invocations against an IDLE worker both
// passed preconditions, both acquired, and BOTH posts were delivered. Fix: an
// atomic O_EXCL per-session lockfile serializes the check→acquire→write→deliver
// critical section; SESSION_BUSY-on-concurrent-reuse now also holds for the
// idle-worker case. Bounded TTL frees a crashed holder.
export const REUSE_RMW_LOCK_MS = 10_000;

export function acquireReuseRmwLock(runsDir, sessionId, owner, now = Date.now(), ttlMs = REUSE_RMW_LOCK_MS) {
  const dir = `${runsDir}/reuse-locks`;
  try { mkdirSync(dir, { recursive: true }); } catch { /* exists */ }
  const file = `${dir}/${sessionId}.lock`;
  try {
    const fd = openSync(file, "wx"); // atomic create-exclusive; EEXIST => held
    writeFileSync(fd, JSON.stringify({ owner, acquiredAt: now, ttlMs }));
    closeSync(fd);
    return { ok: true };
  } catch (e) {
    if (e?.code !== "EEXIST") return { ok: false, error: String(e?.message ?? e) };
    let cur = null;
    try { cur = JSON.parse(readFileSync(file, "utf8")); } catch { /* unreadable */ }
    if (cur && now - (Number(cur.acquiredAt) || 0) < (Number(cur.ttlMs) || REUSE_RMW_LOCK_MS)) {
      return { ok: false, holder: cur.owner };
    }
    // stale (crashed holder): single-stealer race is benign — either winner removes the dead lock
    try { rmSync(file); } catch { /* lost steal race */ }
    try {
      const fd = openSync(file, "wx");
      writeFileSync(fd, JSON.stringify({ owner, acquiredAt: now, ttlMs }));
      closeSync(fd);
      return { ok: true };
    } catch (e2) {
      return { ok: false, holder: cur?.owner, error: String(e2?.message ?? e2) };
    }
  }
}

export function releaseReuseRmwLock(runsDir, sessionId, owner) {
  try {
    const file = `${runsDir}/reuse-locks/${sessionId}.lock`;
    if (JSON.parse(readFileSync(file, "utf8")).owner === owner) rmSync(file);
  } catch { /* already gone */ }
}
