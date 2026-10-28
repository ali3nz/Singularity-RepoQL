// coordinator-status.mjs — V3.2 §5.4: truthful coordinator detection.
// The old status printed "Coordinator: ALIVE (pid <process.pid>)" — reporting
// ITSELF (the short-lived status invocation). Detection now uses the canonical
// coordinator lock (runs/COORDINATOR.lock): parse pid, check /proc/<pid>,
// verify the cmdline is actually a run-loop orchestrate.mjs process, and
// surface the current run id where possible. The Watchdog (§12+) MUST reuse
// this same function so its reports never lie about liveness either.
import { readFileSync, existsSync } from "node:fs";
import * as SLOTS from "./run-slots.mjs"; // ticket 189 K1/K2: slot locks + active-run registry
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));

export const COORDINATOR_STATES = Object.freeze({
  RUNNING: "RUNNING",       // lock + live proc + correct cmdline
  NOT_RUNNING: "NOT_RUNNING", // no lock file
  STALE_LOCK: "STALE_LOCK", // lock exists but pid dead/garbage/self
  MULTIPLE: "MULTIPLE",     // more than one live coordinator process
});

// Injectable for tests: default reads the real /proc filesystem.
function procCmdline(pid, { listDir = null } = {}) {
  try {
    if (listDir) {
      const fake = listDir[pid];
      return fake === undefined ? null : fake;
    }
    return readFileSync(`/proc/${pid}/cmdline`, "utf8");
  } catch {
    return null;
  }
}

// Scan live processes for run-loop orchestrate.mjs coordinators. Injectable.
function scanCoordinatorPids({ listDir = null } = {}) {
  if (listDir) {
    return Object.entries(listDir)
      .filter(([, cmd]) => typeof cmd === "string" && cmd.includes("orchestrate.mjs") && !cmd.includes("resume") && !cmd.includes("status") && !cmd.includes("engines") && !cmd.includes("watch"))
      .map(([pid]) => Number(pid));
  }
  const pids = [];
  try {
    for (const ent of existsSync("/proc") ? require("node:fs").readdirSync("/proc") : []) {
      if (!/^\d+$/.test(ent)) continue;
      const cmd = procCmdline(Number(ent));
      if (cmd && cmd.includes("orchestrate.mjs")) {
        // Coordinator processes are run-loop invocations: start/resume with --go.
        if (cmd.includes("start") || cmd.includes("resume") || cmd.includes("--go")) pids.push(Number(ent));
      }
    }
  } catch { /* /proc unavailable — treat as none */ }
  return pids;
}

// Ticket 189 K1/K2: with max-2 concurrent runs the single COORDINATOR.lock is
// replaced by slot locks (runs/COORDINATOR-<n>.lock) + the active-run registry
// (runs/ACTIVE/<runId>). A legacy-only runs dir (no slot files, no registry)
// keeps the exact pre-189 behaviour below. runId (optional) asks "is THIS run's
// coordinator alive" — the nanny must never treat run B's coordinator as run
// A's, and must never call a live slot-lock coordinator "not running".
function slotAware(runsDir) {
  try {
    return existsSync(join(runsDir, "ACTIVE")) || existsSync(join(runsDir, SLOTS.slotLockName(1))) || existsSync(join(runsDir, SLOTS.slotLockName(2)));
  } catch { return false; }
}

function slotCoordinatorStatus(runsDir, { runId = null, isAlive } = {}) {
  const aliveOpt = isAlive ? { isAlive } : {};
  const holders = SLOTS.liveHolders(runsDir, aliveOpt);
  const active = SLOTS.listActive(runsDir, { prune: false, ...aliveOpt });
  let cur = null;
  try { cur = readFileSync(join(runsDir, "CURRENT"), "utf8").trim() || null; } catch { /* optional */ }
  if (runId) {
    const mine = active.find((a) => a.runId === runId);
    if (mine) return { state: COORDINATOR_STATES.RUNNING, pid: mine.pid, runId, detail: "run registered in runs/ACTIVE with a live coordinator" };
    const legacy = holders.find((h) => h.legacy);
    if (legacy && cur === runId) return { state: COORDINATOR_STATES.RUNNING, pid: legacy.pid, runId, detail: "legacy COORDINATOR.lock holder owns the CURRENT run" };
    return { state: COORDINATOR_STATES.NOT_RUNNING, pid: null, runId: null, detail: holders.length ? "live coordinators belong to other runs" : "no live coordinator for this run" };
  }
  if (!holders.length && active.length) {
    // Registry-live runs count as live coordinators even if a slot lock file went missing.
    return { state: COORDINATOR_STATES.RUNNING, pid: active[0].pid, pids: active.map((a) => a.pid), runId: active[0].runId, detail: `${active.length} registered live run(s)` };
  }
  if (!holders.length) {
    const anyLock = SLOTS.listSlots(runsDir, aliveOpt).some((s) => s.present);
    return anyLock
      ? { state: COORDINATOR_STATES.STALE_LOCK, pid: null, runId: null, detail: "slot lock(s) present but no live coordinator" }
      : { state: COORDINATOR_STATES.NOT_RUNNING, pid: null, runId: null, detail: "no lock file" };
  }
  return { state: COORDINATOR_STATES.RUNNING, pid: holders[0].pid, pids: holders.map((h) => h.pid), runId: active[0]?.runId ?? cur, detail: `${holders.length} live coordinator(s)` };
}

// Returns { state, pid, runId, detail } — never throws.
export function coordinatorStatus(runsDir, { listDir = null, lockFileName = "COORDINATOR.lock", runId: forRunId = null, isAlive = null } = {}) {
  if (!listDir && slotAware(runsDir)) return slotCoordinatorStatus(runsDir, { runId: forRunId, isAlive });
  const lockFile = join(runsDir, lockFileName);
  let lockPid = null;
  try {
    const raw = readFileSync(lockFile, "utf8").trim();
    const n = Number(raw);
    lockPid = Number.isInteger(n) && n > 0 ? n : null;
  } catch {
    return { state: COORDINATOR_STATES.NOT_RUNNING, pid: null, runId: null, detail: "no lock file" };
  }

  // Self-lock leftover: the calling process holds its own lock file entry
  // (status invocations do not acquire the lock, so a lock pid equal to our
  // own pid is stale-by-definition here).
  const cmdline = lockPid !== null ? procCmdline(lockPid, { listDir }) : null;
  if (lockPid === null || lockPid === process.pid || !cmdline) {
    return { state: COORDINATOR_STATES.STALE_LOCK, pid: lockPid, runId: null, detail: "lock present but pid dead/garbage/self" };
  }

  // The lock pid must look like a coordinator (orchestrate.mjs run loop).
  const isCoordinator = cmdline.includes("orchestrate.mjs");
  if (!isCoordinator) {
    return { state: COORDINATOR_STATES.STALE_LOCK, pid: lockPid, runId: null, detail: "lock pid is not an orchestrate.mjs process" };
  }

  // Duplicate detection: any OTHER live coordinator process (excluding the
  // lock holder) is a violation of the single-coordinator invariant.
  const others = scanCoordinatorPids({ listDir }).filter((p) => p !== lockPid);
  if (others.length > 0) {
    return { state: COORDINATOR_STATES.MULTIPLE, pid: lockPid, runId: null, detail: `additional coordinator pids: ${others.join(", ")}` };
  }

  // Best-effort run id: the CURRENT pointer or the newest run dir mtime.
  let runId = null;
  try {
    runId = readFileSync(join(runsDir, "CURRENT"), "utf8").trim() || null;
  } catch { /* optional */ }

  return { state: COORDINATOR_STATES.RUNNING, pid: lockPid, runId, detail: "lock + live proc + orchestrate.mjs cmdline verified" };
}

// One-line rendering for status/watchdog output.
export function renderCoordinatorLine(runsDir, opts = {}) {
  const cs = coordinatorStatus(runsDir, opts);
  switch (cs.state) {
    case COORDINATOR_STATES.RUNNING:
      return `Coordinator: ALIVE pid=${cs.pids && cs.pids.length > 1 ? cs.pids.join(",") : cs.pid}${cs.runId ? ` run=${cs.runId}` : ""}${cs.pids && cs.pids.length > 1 ? ` (${cs.pids.length} concurrent runs)` : ""}`;
    case COORDINATOR_STATES.NOT_RUNNING:
      return "Coordinator: NOT RUNNING";
    case COORDINATOR_STATES.STALE_LOCK:
      return `Coordinator: STALE LOCK${cs.pid ? ` pid=${cs.pid}` : ""} (${cs.detail})`;
    case COORDINATOR_STATES.MULTIPLE:
      return `Coordinator: MULTIPLE PROCESSES DETECTED (${cs.detail})`;
    default:
      return `Coordinator: UNKNOWN (${cs.detail ?? "?"})`;
  }
}
