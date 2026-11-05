// run-slots.mjs — ticket 189 K1-K2, K5-K6: max-N concurrent orchestra runs.
// Coordinator slot locks (runs/COORDINATOR-<n>.lock), a legacy COORDINATOR.lock
// that counts as an occupied slot, an active-run registry (runs/ACTIVE/<id>),
// verb targeting, scope overlap, and a host-wide free-seat semaphore.
// Liveness is injectable (default: 4-factor coordinatorLiveness).
import { readFileSync, writeFileSync, existsSync, mkdirSync, readdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { coordinatorLiveness } from "./consult-liveness.mjs";

export const DEFAULT_MAX_RUNS = 2;
// The legacy PID-file lease protocol is Linux-specific. The named-pipe Rust
// authority must own all Windows coordinator/seat mutations. In particular,
// /proc-unavailable must NEVER be interpreted as proof that a lock is stale.
export const NATIVE_OWNER_REQUIRED = "NATIVE_WINDOWS_AUTHORITY_REQUIRED";
function requireLegacyLinuxOwner(platform = process.platform) {
  if (process.platform !== "linux" || platform !== "linux") throw new Error(NATIVE_OWNER_REQUIRED);
}

export const LEGACY_LOCK = "COORDINATOR.lock";
export const slotLockName = (n) => `COORDINATOR-${n}.lock`;

const defaultAlive = (pid) => {
  if (process.platform !== "linux") return false;
  try { return coordinatorLiveness(pid, { cmdlineIncludes: "orchestrate.mjs" }).alive; } catch { return false; }
};

function readPid(file) {
  try {
    const n = Number(readFileSync(file, "utf8").trim());
    return Number.isInteger(n) && n > 0 ? n : null;
  } catch { return null; }
}

// Snapshot of every slot: [{slot, file, pid, alive, legacy}]. Missing = pid null.
export function listSlots(runsDir, { maxRuns = DEFAULT_MAX_RUNS, isAlive = defaultAlive, platform = process.platform } = {}) {
  requireLegacyLinuxOwner(platform);
  const out = [];
  for (let n = 1; n <= maxRuns; n++) {
    const file = join(runsDir, slotLockName(n));
    const pid = existsSync(file) ? readPid(file) : null;
    out.push({ slot: n, file, pid, alive: pid != null && isAlive(pid), legacy: false, present: existsSync(file) });
  }
  const lf = join(runsDir, LEGACY_LOCK);
  if (existsSync(lf)) {
    const pid = readPid(lf);
    out.push({ slot: 0, file: lf, pid, alive: pid != null && isAlive(pid), legacy: true, present: true });
  }
  return out;
}

// Live coordinators across all slots (legacy included).
export function liveHolders(runsDir, opts = {}) {
  return listSlots(runsDir, opts).filter((s) => s.alive);
}

// Acquire the first free slot. Returns { ok, slot, file, release } or
// { ok:false, reason:"max-runs", live:[...] }. A legacy lock held by a live
// pre-upgrade coordinator occupies one slot of the budget.
export function acquireSlot(runsDir, { maxRuns = DEFAULT_MAX_RUNS, pid = process.pid, isAlive = defaultAlive, platform = process.platform } = {}) {
  requireLegacyLinuxOwner(platform);
  mkdirSync(runsDir, { recursive: true });
  const snap = listSlots(runsDir, { maxRuns, isAlive });
  const live = snap.filter((s) => s.alive && s.pid !== pid);
  if (live.length >= maxRuns) return { ok: false, reason: "max-runs", live };
  for (let n = 1; n <= maxRuns; n++) {
    const file = join(runsDir, slotLockName(n));
    const tryWrite = () => { try { writeFileSync(file, String(pid), { flag: "wx" }); return true; } catch (e) { if (e?.code === "EEXIST") return false; throw e; } };
    if (tryWrite()) return mkResult(n, file, pid);
    const holder = readPid(file);
    const stale = holder == null || holder === pid || !isAlive(holder);
    if (stale) {
      try { rmSync(file); } catch { /* raced */ }
      if (tryWrite()) return mkResult(n, file, pid);
    }
  }
  return { ok: false, reason: "max-runs", live };
}

function mkResult(slot, file, pid) {
  const release = () => { try { if (readFileSync(file, "utf8").trim() === String(pid)) rmSync(file); } catch { /* gone */ } };
  return { ok: true, slot, file, release };
}

// ---------------- active-run registry: runs/ACTIVE/<runId> ----------------
export const activeDir = (runsDir) => join(runsDir, "ACTIVE");

export function registerActive(runsDir, runId, meta = {}) {
  requireLegacyLinuxOwner(meta.platform ?? process.platform);
  const dir = activeDir(runsDir);
  mkdirSync(dir, { recursive: true });
  const rec = { runId, pid: meta.pid ?? process.pid, slot: meta.slot ?? null, mode: meta.mode ?? null, roster: meta.roster ?? null, scope: meta.scope ?? null, startedAt: new Date().toISOString() };
  writeFileSync(join(dir, runId), JSON.stringify(rec, null, 1) + "\n");
  return rec;
}

export function unregisterActive(runsDir, runId, { platform = process.platform } = {}) {
  requireLegacyLinuxOwner(platform);
  try { rmSync(join(activeDir(runsDir), runId), { force: true }); } catch { /* best effort */ }
}

// Active runs whose recorded coordinator pid is alive; dead entries are pruned.
export function listActive(runsDir, { isAlive = defaultAlive, prune = true, platform = process.platform } = {}) {
  // No unverified Windows registry entry is safe to call live OR dead.
  requireLegacyLinuxOwner(platform);
  const dir = activeDir(runsDir);
  let names = [];
  try { names = readdirSync(dir); } catch { return []; }
  const out = [];
  for (const name of names) {
    let rec = null;
    try { rec = JSON.parse(readFileSync(join(dir, name), "utf8")); } catch { rec = null; }
    if (rec && rec.pid && isAlive(rec.pid)) out.push(rec);
    else if (prune) { try { rmSync(join(dir, name), { force: true }); } catch { /* ignore */ } }
  }
  return out.sort((a, b) => String(a.runId).localeCompare(String(b.runId)));
}

// Verb targeting. explicit = --run <id> (wins). mutating verbs refuse when two
// runs are active and no --run was given. Returns
//   { ok, runId, runIds, reason?, message? }
// read-only verbs with 2 runs return runIds (both) and runId=null.
export function resolveTargetRun(runsDir, { explicit = null, mutating = false, currentPointer = null, isAlive = defaultAlive, platform = process.platform } = {}) {
  if (process.platform !== "linux" || platform !== "linux") {
    return { ok: false, runId: null, runIds: [], reason: "ownership-unverified", message: NATIVE_OWNER_REQUIRED };
  }
  if (explicit) return { ok: true, runId: explicit, runIds: [explicit] };
  const active = listActive(runsDir, { isAlive }).map((r) => r.runId);
  if (active.length >= 2) {
    if (mutating) return { ok: false, runId: null, runIds: active, reason: "ambiguous", message: `${active.length} runs active — pass --run <id> (${active.join(", ")})` };
    return { ok: true, runId: null, runIds: active };
  }
  if (active.length === 1) return { ok: true, runId: active[0], runIds: active };
  return { ok: true, runId: currentPointer ?? null, runIds: currentPointer ? [currentPointer] : [] };
}

// ---------------- scope overlap (K6) ----------------
export function parseScope(s) {
  return String(s ?? "").split(",").map((x) => x.trim().replace(/\/+$/, "")).filter(Boolean);
}

export function scopesOverlap(a, b) {
  const A = Array.isArray(a) ? a : parseScope(a);
  const B = Array.isArray(b) ? b : parseScope(b);
  for (const x of A) for (const y of B) {
    if (x === y || x.startsWith(y + "/") || y.startsWith(x + "/")) return true;
  }
  return false;
}

// Decide start vs other active runs: { action: "ok" | "refuse" | "warn", with:[runIds], message }.
export function scopeDecision(myScope, others) {
  const mine = parseScope(myScope);
  const list = (others ?? []);
  if (!list.length) return { action: "ok", with: [], message: "" };
  const refuse = [], warn = [];
  for (const o of list) {
    const theirs = parseScope(o.scope);
    if (mine.length && theirs.length) { if (scopesOverlap(mine, theirs)) refuse.push(o.runId); }
    else warn.push(o.runId);
  }
  if (refuse.length) return { action: "refuse", with: refuse, message: `declared scope overlaps run ${refuse.join(", ")} — refusing the second start` };
  if (warn.length) return { action: "warn", with: warn, message: `WARNING: concurrent run ${warn.join(", ")} active (scope undeclared) — coordinate on shared files` };
  return { action: "ok", with: [], message: "" };
}

// ---------------- host-wide free-seat semaphore (K5) ----------------
// runs/SEATS/<n>.slot, n in 1..max. Content: "<pid> <runId> <seatId>".
// A seat turn waits for a slot (never fails for lack of one); slots whose
// owner pid is dead are reclaimed.
export const seatsDir = (runsDir) => join(runsDir, "SEATS");

function readSeatSlot(file) {
  try { const [pid, runId, seat] = readFileSync(file, "utf8").trim().split(/\s+/); return { pid: Number(pid) || null, runId, seat }; } catch { return null; }
}

export function seatSlotsInUse(runsDir, { isAlive = defaultAlive, platform = process.platform } = {}) {
  requireLegacyLinuxOwner(platform);
  const dir = seatsDir(runsDir);
  let names = [];
  try { names = readdirSync(dir); } catch { return []; }
  const out = [];
  for (const n of names) {
    const rec = readSeatSlot(join(dir, n));
    if (rec?.pid && isAlive(rec.pid)) out.push({ name: n, ...rec });
  }
  return out;
}

// Try once. Returns { ok, release } or { ok:false }.
export function tryAcquireSeatSlot(runsDir, { max = 8, pid = process.pid, runId = "?", seat = "?", isAlive = defaultAlive, platform = process.platform } = {}) {
  requireLegacyLinuxOwner(platform);
  const dir = seatsDir(runsDir);
  mkdirSync(dir, { recursive: true });
  for (let n = 1; n <= max; n++) {
    const file = join(dir, `${n}.slot`);
    const write = () => { try { writeFileSync(file, `${pid} ${runId} ${seat}\n`, { flag: "wx" }); return true; } catch (e) { if (e?.code === "EEXIST") return false; throw e; } };
    if (write()) return { ok: true, slot: n, release: mkSeatRelease(file, pid, runId, seat) };
    const rec = readSeatSlot(file);
    if (!rec?.pid || !isAlive(rec.pid)) {
      try { rmSync(file); } catch { /* raced */ }
      if (write()) return { ok: true, slot: n, release: mkSeatRelease(file, pid, runId, seat) };
    }
  }
  return { ok: false };
}

function mkSeatRelease(file, pid, runId, seat) {
  return () => { const rec = readSeatSlot(file); if (rec && rec.pid === pid && rec.runId === runId && rec.seat === seat) { try { rmSync(file); } catch { /* gone */ } } };
}

// Wait (bounded by timeoutMs, default 6 h) for a slot; resolves { ok, release, waitedMs }.
export async function acquireSeatSlot(runsDir, opts = {}) {
  const { pollMs = 2000, timeoutMs = 6 * 3600_000, sleep = (ms) => new Promise((r) => setTimeout(r, ms)), onWait = null } = opts;
  const t0 = Date.now();
  let first = true;
  for (;;) {
    const r = tryAcquireSeatSlot(runsDir, opts);
    if (r.ok) return { ...r, waitedMs: Date.now() - t0 };
    if (first && onWait) { try { onWait(); } catch { /* log only */ } first = false; }
    if (Date.now() - t0 >= timeoutMs) return { ok: false, release: () => {}, waitedMs: Date.now() - t0 };
    await sleep(pollMs);
  }
}
