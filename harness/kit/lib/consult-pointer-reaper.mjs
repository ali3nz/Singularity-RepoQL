// consult-pointer-reaper.mjs — ticket 370 (2026-10-08).
//
// A coordinator's Sol consult is tracked by a BRIDGE POINTER
// (runs/session-consult-<ts>.json) owned by a detached child
// (`orchestrate.mjs session-consult --child ... --pointer <file>`). If that
// child dies without finalising (SIGKILL on container recreate, OOM, a direct
// process.exit inside cmdConsult), the pointer stayed {state:"RUNNING"}
// FOREVER and callers polled it indefinitely (5 such pointers on 2026-10-08).
//
// This reaper finalises ONLY provably-orphaned pointers:
//   - state RUNNING or DISPATCHED, AND
//   - no live process in this pid namespace carries the pointer path in its
//     cmdline (identity by the --pointer argument: immune to pid reuse and
//     container recreation; works for legacy pointers that recorded no pid), AND
//   - last pointer write is older than REAP_AFTER_MIN (dispatch race guard).
// It writes {state:"RESULT", ok:false, error, reapedAt}. It never restarts,
// retries or re-dispatches anything (Sol's session-watch boundary: recovery is
// the caller's decision) and it is skipped entirely in FROZEN cycles.
import { readFileSync, writeFileSync, readdirSync, existsSync } from "node:fs";
import { join, basename } from "node:path";

export const REAPER_VERSION = "ticket 370-v1";
export const REAP_AFTER_MIN = Number(process.env.CONSULT_REAP_AFTER_MIN ?? 5);
const PTR_RE = /^session-consult-.*\.json$/;

// cmdlines of every live process in this namespace (NUL-joined args -> spaces).
export function liveCmdlines(procDir = "/proc") {
  const out = [];
  let ents = [];
  try { ents = readdirSync(procDir); } catch { return null; } // unknown liveness must fail closed
  for (const d of ents) {
    if (!/^\d+$/.test(d)) continue;
    try { out.push(readFileSync(join(procDir, d, "cmdline"), "utf8").replace(/\0/g, " ")); }
    catch { if (existsSync(join(procDir, d))) return null; /* raced exit; unreadable live proc => fail closed */ }
  }
  return out;
}

export function reapConsultPointers(runsDir, { now = Date.now(), apply = true, cmdlines = null, procDir = "/proc", reapAfterMin = REAP_AFTER_MIN } = {}) {
  const events = [];
  let files = [];
  try { files = readdirSync(runsDir).filter((f) => PTR_RE.test(f)); } catch { return { events, reaped: [] }; }
  const reaped = [];
  let procs = null; // lazily read /proc only when an unfinished pointer exists
  for (const f of files) {
    const p = join(runsDir, f);
    let ptr;
    try { ptr = JSON.parse(readFileSync(p, "utf8")); } catch { continue; }
    if (ptr?.state !== "RUNNING" && ptr?.state !== "DISPATCHED") continue;
    const lastAt = Date.parse(ptr.updatedAt ?? ptr.dispatchedAt ?? "") || 0;
    const ageMin = lastAt ? (now - lastAt) / 60000 : Infinity;
    if (ageMin < reapAfterMin) continue;
    procs ??= cmdlines ?? liveCmdlines(procDir);
    if (procs === null || procs.length === 0) continue; // /proc unavailable: do not claim a child is dead
    const name = basename(f);
    if (procs.some((c) => c.includes(name))) continue; // child alive -> legitimately running
    const error = `consult child is gone (no live process owns ${name}; pointer was ${ptr.state} for ${Number.isFinite(ageMin) ? Math.round(ageMin) : "?"} min) — consult did NOT complete; re-dispatch if still needed`;
    if (apply) {
      try {
        writeFileSync(p, JSON.stringify({ ...ptr, state: "RESULT", ok: false, error, reapedAt: new Date(now).toISOString(), updatedAt: new Date(now).toISOString() }, null, 2) + "\n");
      } catch (e) {
        events.push({ severity: "error", event: "consult-pointer-reap-failed", detail: `${name}: ${String(e.message ?? e).slice(0, 100)}` });
        continue;
      }
    }
    reaped.push(name);
    events.push({ severity: "warn", event: "consult-pointer-reaped", detail: `${name} finalised ok:false (orphaned ${ptr.state}, ${Number.isFinite(ageMin) ? Math.round(ageMin) : "?"} min)` });
  }
  return { events, reaped };
}
