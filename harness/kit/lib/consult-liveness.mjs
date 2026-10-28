// consult-liveness.mjs — V3.4.0b (ticket 090): session liveness + orphan
// classification for the duo-consult lane, per Sol's FIX PLAN (consult
// 2026-09-26T00-17-10, turn 1 CONTRADICTED -> fix plan executed).
//
// Fleet invariant (Sol, fleet-wide): EXISTENCE IS NEVER LIVENESS — not for
// pids, lockfiles, session pointers, routes, or watchers. A zombie pid has a
// readable-but-EMPTY /proc/<pid>/cmdline; readFileSync returns a truthy empty
// Buffer, so any truthiness check passes on a corpse. Never use readable
// cmdline alone.
//
// Liveness = ALL four factors (Sol fix plan item 1):
//   (1) pid exists in /proc
//   (2) /proc/<pid>/stat state NOT in {Z, X, x} (zombie/dead)
//   (3) /proc/<pid>/cmdline identity-matches the expected coordinator
//   (4) /proc/<pid>/stat field 22 (starttime) matches the starttime recorded
//       when the session acquired ownership (PID-reuse protection)
//
// Heartbeat is STATE-AWARE (Sol fix plan item 2): a live matching coordinator
// keeps the session alive regardless of turn heartbeat age (legit
// WAITING_FOR_OPERATOR can sit for hours); a stale heartbeat only matters
// when process ownership cannot independently prove life.
import { readFileSync, existsSync, writeFileSync, renameSync } from "node:fs";

const DEAD_STATES = new Set(["Z", "X", "x"]);

// Parse /proc/<pid>/stat: comm may contain spaces/parens, so take the field
// after the LAST ')'. Returns { state, starttime } or null.
export function readProcStat(pid) {
  try {
    const raw = readFileSync(`/proc/${pid}/stat`, "utf8");
    const close = raw.lastIndexOf(")");
    if (close < 0) return null;
    const rest = raw.slice(close + 2).split(" ");
    // rest[0] = state (field 3); field f lives at rest[f-3], so starttime
    // (field 22) = rest[19].
    return { state: rest[0], starttime: Number(rest[19]) };
  } catch {
    return null;
  }
}

// 4-factor coordinator liveness (Sol fix plan item 1). Returns
// { alive, reason, detail } — alive=false with a precise reason either way.
export function coordinatorLiveness(pid, expect = {}) {
  if (!Number.isInteger(pid) || pid <= 0) return { alive: false, reason: "no-pid-recorded" };
  if (!existsSync(`/proc/${pid}`)) return { alive: false, reason: "pid-gone" };
  const st = readProcStat(pid);
  if (!st) return { alive: false, reason: "stat-unreadable" };
  if (DEAD_STATES.has(st.state)) return { alive: false, reason: `zombie-${st.state}` };
  let cmdline = "";
  try { cmdline = readFileSync(`/proc/${pid}/cmdline`, "utf8").replace(/\0/g, " ").trim(); } catch {}
  if (expect.cmdlineIncludes) {
    for (const frag of (Array.isArray(expect.cmdlineIncludes) ? expect.cmdlineIncludes : [expect.cmdlineIncludes])) {
      if (!cmdline.includes(frag)) return { alive: false, reason: "identity-mismatch", detail: cmdline.slice(0, 120) };
    }
  }
  if (Number.isInteger(expect.starttime) && expect.starttime > 0 && st.starttime !== expect.starttime) {
    return { alive: false, reason: "pid-reuse", detail: `recorded=${expect.starttime} now=${st.starttime}` };
  }
  return { alive: true, reason: "live", state: st.state, starttime: st.starttime, cmdline: cmdline.slice(0, 120) };
}

// V3.4.1 (ticket 094): stamp meta terminal on the NORMAL close path.
// closeOrphanedGuarded did this for orphans; the normal close never did, so a
// just-closed session stayed IDLE-OPEN (fresh heartbeat + dead coordinator)
// and rc64-blocked the next fresh consult for up to heartbeatStaleMs.
export function stampMetaClosed(metaPath, note) {
  try {
    const meta = JSON.parse(readFileSync(metaPath, "utf8"));
    if (meta.state === "done" || meta.state === "closed") return true;
    meta.state = "done";
    meta.completedAt = Date.now();
    meta.closeReason = (note ?? "closed_by_coordinator").slice(0, 160);
    writeFileSync(metaPath, JSON.stringify(meta, null, 2) + "\n");
    return true;
  } catch {
    return false;
  }
}

// V3.4.2 (ticket 094): ownership guard for `consult --end`. A bare --end may
// close only NON-LIVE opens (IDLE-OPEN/ORPHANED — stale-lane cleanup); a LIVE
// open session (someone actively dispatching) requires explicit --end-session.
export function endOwnershipGuard({ openClass, explicitId }) {
  if (explicitId) return { action: "close", reason: "explicit --end-session targets its session (owner/operator override)" };
  if (openClass === "ALIVE") return { action: "refuse", reason: "LIVE open session — never close another workstream's live consult (V3.4.2 ticket 094)" };
  return { action: "close", reason: `non-live open session (${openClass ?? "unknown"}) — sanctioned stale-lane cleanup` };
}

// Classify one consult session. info = { state, lastAt, coordinatorPid,
// coordinatorStarttime, ownerCaller }; now in ms; HEARTBEAT_STALE_MS bounds
// the no-coordinator case only.
export function classifySession(info, { now = Date.now(), heartbeatStaleMs = 15 * 60_000 } = {}) {
  const lv = coordinatorLiveness(info.coordinatorPid, {
    cmdlineIncludes: "orchestrate.mjs",
    starttime: info.coordinatorStarttime,
  });
  const hbAge = now - (info.lastAt ?? 0);
  if (lv.alive) return { status: "ALIVE", reason: lv.reason, hbAge, lv };
  // No live coordinator: a completed/done session is simply CLOSED, not orphaned.
  if (info.state === "done" || info.state === "closed") return { status: "CLOSED", reason: `state=${info.state}`, hbAge, lv };
  // Coordinator gone right after a terminal turn -> completed normally, the
  // per-turn pattern exits between turns; only stale heartbeat marks orphan.
  if (hbAge <= heartbeatStaleMs) return { status: "IDLE-OPEN", reason: lv.reason, hbAge, lv };
  return { status: "ORPHANED", reason: `no-live-coordinator (${lv.reason}) + heartbeat stale ${Math.round(hbAge / 1000)}s`, hbAge, lv };
}

// Stamp coordinator identity into a session's meta at ownership acquisition
// (call right after acquirePidLock writes CONSULT.lock).
export function stampCoordinator(metaPath, pid) {
  try {
    const meta = JSON.parse(readFileSync(metaPath, "utf8"));
    const st = readProcStat(pid);
    meta.coordinatorPid = pid;
    if (st?.starttime) meta.coordinatorStarttime = st.starttime;
    meta.heartbeatAt = Date.now();
    writeFileSync(metaPath, JSON.stringify(meta, null, 2) + "\n");
  } catch { /* meta may not exist yet on a brand-new dir; non-fatal */ }
}

// Refresh the heartbeat (call on turn dispatch and turn terminal).
export function beat(metaPath) {
  try {
    const meta = JSON.parse(readFileSync(metaPath, "utf8"));
    meta.heartbeatAt = Date.now();
    writeFileSync(metaPath, JSON.stringify(meta, null, 2) + "\n");
  } catch { /* non-fatal */ }
}

// Sol fix plan item 3: auto-close a PROVEN orphan, CAS-guarded. verifyStill =
// () => classifySession(latest-on-disk meta) re-derived fresh; close via
// tmp+rename so a racing writer's win is atomic and detectable. Returns
// { closed, reason } — never closes when any recheck disagrees.
export function closeOrphanedGuarded(metaPath, sessionDir, classify, note) {
  // Re-read from disk INSIDE the guard (no stale closure over meta).
  let fresh;
  try { fresh = JSON.parse(readFileSync(metaPath, "utf8")); } catch { return { closed: false, reason: "meta-unreadable" }; }
  const cls = classify(fresh);
  if (cls.status !== "ORPHANED") return { closed: false, reason: `no-longer-orphaned (${cls.status})` };
  const revBefore = fresh.lastAt ?? 0;
  const stamp = JSON.stringify({
    ...fresh,
    state: "done",
    completedAt: Date.now(),
    closeReason: note ?? "orphaned_by_gate",
  }, null, 2) + "\n";
  const tmp = metaPath + ".tmp-orphan-" + process.pid;
  try {
    writeFileSync(tmp, stamp);
    // CAS: if the file changed since our re-read, the rename still succeeds
    // but we detect the revision change and roll back.
    const onDisk = JSON.parse(readFileSync(metaPath, "utf8"));
    if ((onDisk.lastAt ?? 0) !== revBefore) {
      renameSync(tmp, metaPath + ".lost-race"); // keep evidence, do not clobber
      try { renameSync(metaPath + ".lost-race", metaPath); } catch { /* disk won */ }
      return { closed: false, reason: "concurrent-write-race - abort" };
    }
    renameSync(tmp, metaPath);
  } catch (e) {
    try { (void 0); } catch {}
    return { closed: false, reason: `write-failed: ${String(e?.message ?? e).slice(0, 80)}` };
  }
  return { closed: true, reason: "orphaned_by_gate" };
}

export const CONSULT_LIVENESS_INVARIANT =
  "EXISTENCE IS NEVER LIVENESS — not for pids, lockfiles, session pointers, routes, or watchers.";
