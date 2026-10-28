// ---------------------------------------------------------------------------
// phase-driver.mjs — V3.3.27 (ticket 041, Sol FIX PLAN item 1): deterministic
// evidence-gated phase-timeout extension.
//
// PROBLEM (strongest evidenced source of terminal job stops — see consult
// session 2026-09-22T11-07-40 turn 2): the base phase timeout (default 40 min)
// fires while a healthy deterministic driver is still making progress; the
// review sees incomplete state, the 2-round remediation loop exhausts, and an
// otherwise-healthy job becomes terminal (REMEDIATION_EXHAUSTED). Live case:
// run 2026-09-21T18-00-28 — 28 sequential cross-device torrent moves need ~2h
// of physics, timed out twice at 40 min, reviews fired mid-flight on stale
// evidence.
//
// CONTRACT (Sol's safe rule — every gate is MANDATORY):
//   base phase deadline reached
//   AND run still nonterminal (caller checks)
//   AND expected deterministic driver process still exists (pgrep -f)
//   AND objective progress checkpoint ADVANCED since the previous check
//       (checkpoint = monotonic value read from a file the driver writes;
//        PID-alive alone is NOT progress — a runaway `find /` also has a
//        live PID; log mtime / CPU are explicitly rejected)
//   AND extension count below the configured cap (default 3 per phase)
//   AND absolute phase wall-clock ceiling not reached (default 4x base)
//   THEN grant ONE bounded extension of exactly one base timeout
//   ELSE fall through to the existing timeout behaviour (review with
//        current state)
//
// Fully deterministic: NO model calls, NO AI review is triggered to decide an
// extension. The worker DECLARES the contract in its assignment text with
// backticked commands (parsed below); if nothing is declared, behavior is
// byte-identical to pre-V3.3.27 (extension machinery never activates).
//
// The MANDATORY stalled-driver rule (incident-033 protections must not be
// defeated) is tested at decision level: an alive driver with an UNCHANGED
// checkpoint is refused, a dead driver is refused, cap/ceiling are refused.
// ---------------------------------------------------------------------------

import { statSync } from "node:fs";

// The worker's assignment must contain a backticked driver command, announced
// by a verb-ish keyword so ordinary inline commands never match:
//   ... driver `relocation-driver.sh --seed 7` ... progress `grep -c SUCCESS /var/log/relocation.log` ...
export const DRIVER_DECL = /(?:\bdriver\b|\brun\b|\bmonitor\b|\bwatch\b)\s+`([^`]+)`/;
// Explicit progress patterns (tried first, most specific wins):
const PROGRESS_WC = /`wc\s+-l\s*<\s*([^`]+)`/;                    // line count of a file
const PROGRESS_GREPC = /`grep\s+-c\s+([A-Za-z0-9_.-]+)\s+([^`]+)`/; // marker count in a file
const PROGRESS_STAT = /`stat\s+-c\s+%s\s+([^`]+)`/;               // file size in bytes
const PROGRESS_TAILC = /`tail\s+-c\s+([0-9]+)\s+([^`]+)`/;        // file size (bounded read)

export function driverProtocolBlock() {
  return [
    "",
    "=== DRIVER PROGRESS PROTOCOL (V3.3.27 — how the coordinator reads long work) ===",
    "If your phase work runs a LONG-LIVED deterministic command (a driver script) that will outlast",
    "the phase timeout, you MUST declare it in your status updates using backticks so the coordinator",
    "can verify it objectively:",
    "  - the driver itself:  ... driver `<pid-greppable command>` ...",
    "  - a progress checkpoint file that GROWS MONOTONICALLY, e.g.:",
    "      progress `grep -c SUCCESS /var/log/<driver>.log`   (count of success rows)",
    "      progress `wc -l < /tmp/<work>.done`                (completed-item rows)",
    "      progress `stat -c %s /tmp/<output>.bin`            (output size in bytes)",
    "The coordinator grants at most a few bounded timeout extensions while the driver is alive AND its",
    "checkpoint keeps advancing. If the driver stalls or you take over manually, no extension is granted",
    "and the phase proceeds to review as usual. Never fake a checkpoint file — the reviewer audits it.",
  ].join("\n");
}

// Parse the driver/progress declaration from the phase assignments (first
// non-WAIT assignment wins). Returns null when nothing is declared — callers
// then behave exactly as before V3.3.27.
export function declarePhaseDriver(assignments) {
  for (const a of Array.isArray(assignments) ? assignments : [assignments]) {
    if (typeof a !== "string" || /^WAIT$/i.test(a.trim())) continue;
    const dm = a.match(DRIVER_DECL);
    if (!dm) continue;
    const cmd = dm[1].trim();
    if (!cmd) continue;
    let progress = null, progressKind = null, progressOp = null, progressMarker = null;
    const wc = a.match(PROGRESS_WC);
    const gr = a.match(PROGRESS_GREPC);
    const st = a.match(PROGRESS_STAT);
    const tl = a.match(PROGRESS_TAILC);
    if (wc) { progress = wc[1].trim(); progressKind = "line-count"; progressOp = "wc-l"; }
    else if (gr) { progress = gr[2].trim(); progressKind = "marker-count"; progressOp = "grep-c"; progressMarker = gr[1]; }
    else if (st) { progress = st[1].trim(); progressKind = "file-size"; progressOp = "stat"; }
    else if (tl) { progress = tl[2].trim(); progressKind = "file-size"; progressOp = "tail-c"; progressMarker = tl[1]; }
    else {
      // Fallback: first backticked command AFTER the driver mention that is
      // not the driver itself. Only accepted if it names a file-ish target —
      // otherwise there is no readable checkpoint and we declare nothing
      // (fail-closed to the old behaviour).
      const rest = a.slice(dm.index + dm[0].length);
      const pm = rest.match(/`([^`]+)`/);
      if (pm && /\s+\/|\/[A-Za-z0-9._-]+|<\s*\//.test(pm[1])) {
        progress = pm[1].trim(); progressKind = "line-count"; progressOp = "wc-l";
      }
    }
    if (!progress) return { driver: cmd, progress: null, progressKind: null, progressOp: null, progressMarker: null };
    return { driver: cmd, progress, progressKind, progressOp, progressMarker };
  }
  return null;
}

// Parse the raw stdout of the checkpoint command into a monotonic checkpoint.
// Returns null when unreadable (the decision layer then REFUSES — fail-closed).
export function parseProgressValue(raw) {
  if (raw == null) return null;
  const m = String(raw).match(/\d+/);
  if (!m) return null;
  const v = Number(m[0]);
  return Number.isFinite(v) ? { value: v } : null;
}

// Compare two checkpoints. Returns >0 advanced, 0 unchanged, <0 not-advanced
// (kind mismatch, regression). Callers treat <=0 as "no progress".
export function compareProgress(a, b) {
  if (!a || !b) return -1;
  if ((a.kind ?? "line-count") !== (b.kind ?? "line-count")) return -1;
  const av = a.value ?? a, bv = b.value ?? b;
  if (!Number.isFinite(av) || !Number.isFinite(bv)) return -1;
  return av > bv ? 1 : av < bv ? -1 : 0;
}

export function fmtCheckpoint(c) {
  if (!c) return "none";
  return `${c.kind ?? "line-count"} ${c.value ?? c}`;
}

// Strict charset allowlists — the declared strings are composed into remote
// ssh command lines, so any shell metacharacter makes the declaration INVALID
// (fail-closed to the old no-extension behaviour, never executed).
const SAFE_CMD = /^[A-Za-z0-9_./=,:%+-]+(?:[ ]+[A-Za-z0-9_./=,:%+-]+)*$/;
const SAFE_PATH = /^[A-Za-z0-9_./-]{1,200}$/;
const SAFE_MARKER = /^[A-Za-z0-9_.-]{1,64}$/;

function safeDriverCommand(cmd) {
  if (typeof cmd !== "string" || !cmd || cmd.length > 300) return null;
  if (!SAFE_CMD.test(cmd) || cmd.includes("..")) return null;
  return cmd;
}

// Build the driver-aliveness probe for a declaration. Drivers run on the
// controller host (not in this container), so the probe runs `pgrep -f` over
// ssh. pgrep exit 1 (no match) is a clean "not alive". The pattern escapes
// every "." as "[.]" — the AGENTS.md bracket trick — so the ssh-side shell
// carrying the pattern in its own cmdline can never self-match.
export function buildDriverProbe(decl, sshHost = "controller") {
  const safe = safeDriverCommand(decl && decl.driver);
  if (!safe) return async () => ({ alive: false, why: "driver command failed safety validation" });
  const pattern = safe.replace(/\./g, "[.]");
  return async function probe() {
    try {
      const { execFile } = await import("node:child_process");
      const { promisify } = await import("node:util");
      const execFileAsync = promisify(execFile);
      const { stdout } = await execFileAsync("ssh", [sshHost, "pgrep", "-f", `'${pattern}'`], { timeout: 10000 });
      const pids = String(stdout).split("\n").map((s) => s.trim()).filter((s) => /^\d+$/.test(s));
      if (pids.length) return { alive: true, pid: Number(pids[0]) };
      return { alive: false, why: "no matching process" };
    } catch (e) {
      if (e && e.code === 1) return { alive: false, why: "no matching process" };
      return { alive: false, why: `pgrep failed: ${e && e.message ? e.message : e}` };
    }
  };
}

// Compose the sanitized argv for reading the progress checkpoint on the
// controller host. Returns null for ANY unsafe component (never executes a
// worker-supplied string verbatim — the command is REBUILT from validated
// parts). grep -c exiting 1 with "0" output is a valid zero count.
export function buildProgressReadArgv(decl, sshHost = "controller") {
  if (!decl || !decl.progress) return null;
  const p = String(decl.progress);
  if (!SAFE_PATH.test(p) || p.includes("..")) return null;
  // NOTE: no "--" after the destination — ssh passes everything after the
  // host verbatim to the remote shell, which would try to EXECUTE "--".
  // Injection safety comes from the strict allowlists + command REBUILD, not
  // from a separator (no validated piece can start with "-").
  const base = ["ssh", sshHost];
  switch (decl.progressOp) {
    case "grep-c": {
      const m = String(decl.progressMarker ?? "");
      if (!SAFE_MARKER.test(m)) return null;
      return [...base, "grep", "-c", m, p];
    }
    case "wc-l":
      return [...base, "wc", "-l", "<", p];
    case "stat":
      return [...base, "stat", "-c", "%s", p];
    case "tail-c": {
      const n = Number(decl.progressMarker);
      if (!Number.isInteger(n) || n < 1 || n > 4096) return null;
      return [...base, "tail", "-c", String(n), p];
    }
    default:
      return null;
  }
}

// THE decision function. Pure with respect to its inputs — probe and
// readProgressRaw are injected so the decision table is testable offline
// (including the MANDATORY stalled-driver refusal).
export async function evaluatePhaseExtension({
  decl, prev, probe, readProgressRaw,
  now = Date.now(), extensionCount = 0,
  baseMs, startedAt,
  maxExtensions = 3, wallCeilingFactor = 4,
}) {
  if (!decl || !decl.driver) return { granted: false, reason: "no declared driver" };
  if (!decl.progress) return { granted: false, reason: "no progress checkpoint declared" };
  if (Number.isFinite(maxExtensions) && extensionCount >= maxExtensions) {
    return { granted: false, reason: `extension cap ${maxExtensions} reached` };
  }
  if (Number.isFinite(baseMs) && Number.isFinite(startedAt) &&
      now >= startedAt + baseMs * wallCeilingFactor) {
    return { granted: false, reason: `wall-clock ceiling ${wallCeilingFactor}x base timeout reached` };
  }
  let p;
  try { p = await probe(); } catch (e) {
    return { granted: false, reason: `driver probe failed: ${e && e.message ? e.message : e}` };
  }
  if (!p || p.alive !== true) {
    return { granted: false, reason: `driver not alive (${p && p.why ? p.why : "probe returned no aliveness"})` };
  }
  let raw = "";
  try { raw = String(readProgressRaw ? readProgressRaw() : ""); } catch { raw = ""; }
  const v = parseProgressValue(raw);
  if (v === null) return { granted: false, reason: "progress checkpoint unreadable" };
  const value = { kind: decl.progressKind ?? "line-count", value: v.value };
  if (prev !== null && prev !== undefined) {
    const c = compareProgress(value, prev);
    if (c === 0) return { granted: false, reason: `progress unchanged (${fmtCheckpoint(value)}) — stalled driver` };
    if (c < 0) return { granted: false, reason: `progress went backwards (${fmtCheckpoint(prev)} -> ${fmtCheckpoint(value)})` };
    return { granted: true, reason: `progress ${fmtCheckpoint(prev)} -> ${fmtCheckpoint(value)}`, value };
  }
  return { granted: true, reason: `first checkpoint ${fmtCheckpoint(value)}`, value };
}
