// free-role-router.mjs — V3.3 §2.5: ONE shared role caller (managed Muse
// primary + free-model failover, ticket 255).
//
// Problem it fixes: pickModel() selected ONE model per role, so a capacity or
// provider failure inside Supervisor / Watchdog / quality left that operation
// degraded even though other approved free models were healthy.
//
// Ticket 255 (operator order 2026-10-03): the Go-plan managed Muse
// (opencode-managed-muse, container transport) is attempted FIRST for every
// role; on failure or out-of-credit the walk continues through the free
// registry (space-bunny -> ling-3.1 -> longcat). Deterministic/local failures
// still stop the walk.
//
// callFreeRole(role, prompt, opts):
//   1. attempts the managed Go-plan primary (unless excluded)
//   2. reads the ordered free role registry (FREE_MODEL_REGISTRY)
//   3. skips models in cooldown
//   4. calls the first candidate
//   5. classifies rc + output (§5.2 lesson: rc=0 with rejection text is failure)
//   6. records health + invocation telemetry (with runId — §2.2)
//   7. on provider-failover-eligible failure: cooldown already applied by
//      recordModelOutcome; walks to the next approved FREE model
//   8. on deterministic/local failure: stops (no point retrying elsewhere)
//   9. returns the full attempts history
//
// Pinned single-model consults do NOT go through this router — pinning stays
// pinned unless the operator explicitly asks for auto fallback (§2.5).
import { spawnSync, spawn } from "node:child_process";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  FREE_MODEL_REGISTRY,
  modelAvailable,
  recordModelOutcome,
} from "./free-model-registry.mjs";
import { recordInvocation, initTelemetry } from "./invocation-telemetry.mjs";
import { variantFlag, resolveEffort, callWithEffortSync } from "./effort.mjs"; // ticket 189 item 11: top reasoning variant

// Provider/model availability classes where walking to the NEXT free model is
// correct (mirrors the router's typed failover classes, free-lane subset).
const FAILOVER_ELIGIBLE = new Set([
  "PROVIDER_DOWN", "RATE_LIMIT", "QUOTA", "AUTH", "MODEL_FAILURE", "TIMEOUT",
]);

// Ticket 255 (operator order 2026-10-03): the Go-plan managed Muse seat is the
// PRIMARY automatic model for every role; FREE_MODEL_REGISTRY is the failover
// tail. A managed failure OR an out-of-credit/quota response falls through to
// the free walk; a deterministic/local failure still stops the walk.
export const ROLE_PRIMARY_MODEL = process.env.ORCH_ROLE_PRIMARY_MODEL || "opencode-go/beam-free"; // ticket 343: Go allowance exhausted — automatic primary is Zen Muse free (env override preserves Go restoration; alias/engine/creds untouched); 2026-10-19 narrator-fix: muse-free and the zen free tier are dead upstream in-container (both probe-verified) — automatic primary repointed to the zero-cost Go free model (opencode-go/beam-free; managed-bridge probe PONG, cost 0)

// Ticket 268: narrator isolation helpers.
export const NARRATOR_CWD = "/tmp/orch-narrator";
export function narratorSessionId(purpose) {
  const pp2 = String(purpose || "narr").toLowerCase().replace(/[^a-z0-9]+/g, "_").slice(0, 20) || "narr";
  const rand = Math.random().toString(36).slice(2, 8);
  return ("ses_orch_narrator_" + pp2 + "_" + Date.now().toString(36) + "_" + rand).slice(0, 80);
}
// Best-effort archive of a known managed session (never throws). Uses ssh->docker exec python to set
// native time_archived (immediate hide) + sessions-archive.json entry (durable). Fail-open.
export function archiveManagedSession(sessionId, opts) {
  // STDIN script pattern (never argv — quotes lost to ssh reassembly, ticket 030).
  try {
    const sid = String((opts && opts.sessionId) || sessionId || "");
    const sshHost = (opts && opts.sshHost) || "controller";
    if (!/^ses[\w-]{1,80}$/.test(sid)) return;
    const q = (s) => "'" + String(s).replace(/'/g, "'\\''") + "'";
    const script = "SID=" + q(sid) + "\n" +
      "python3 - \"$SID\" <<\'PY268\'\n" +
      "import sys,json,os,sqlite3,time\n" +
      "sid=sys.argv[1]\n" +
      "now=int(time.time()*1000)\n" +
      "db=os.path.expanduser('~/.local/share/opencode/opencode.db')\n" +
      "con=sqlite3.connect(db,timeout=10)\n" +
      "cur=con.cursor()\n" +
      "cur.execute('UPDATE session_v2 SET time_archived=? WHERE id=?',(now,sid))\n" +
      "con.commit()\n" +
      "con.close()\n" +
      "p=os.path.expanduser('~/.config/openchamber/sessions-archive.json')\n" +
      "d=json.load(open(p)) if os.path.exists(p) else {}\n" +
      "d[sid]=now\n" +
      "open(p+'.tmp','w').write(json.dumps(d))\n" +
      "os.replace(p+'.tmp',p)\n" +
      "PY268\n";
    spawnSync("ssh", [sshHost, "docker", "exec", "-i", "openchamber", "sh"], { input: script, timeout: 10000, encoding: "utf8" });
  } catch {}
}

// Append the maximum reasoning variant the model exposes (provider/model#variant
// suffix, v2.0.16 CLI syntax); models without variants pass through unchanged.
export function withMaxVariant(model) {
  try {
    const base = String(model ?? "").split("#")[0];
    const eff = resolveEffort(base, {});
    return eff?.variant ? base + "#" + eff.variant : base;
  } catch { return String(model ?? ""); }
}

// One attempt against the Go-plan managed Muse via the container bridge
// (opencode-managed-bridge.sh -> lib/managed-bridge-cli.mjs; the Go credential
// lives only inside the openchamber container). Sync spawn keeps callFreeRole
// synchronous (same pattern as callFreeOpenRouter). readOnly callers pin the
// container's read-only fleet-reviewer agent.
export function callManagedPrimary(prompt, { sshHost = "controller", timeoutSec = 240, readOnly = true, cwd = null, sessionId = null, title = null } = {}) {
  const t0 = Date.now();
  const dir = mkdtempSync(join(tmpdir(), "or-mgd-"));
  const pf = join(dir, "prompt.txt");
  try {
    writeFileSync(pf, String(prompt ?? ""), "utf8");
    const kitDir = "/workspace/work/ai-orchestration";
    const r = spawnSync("bash", ["opencode-managed-bridge.sh", pf], {
      cwd: kitDir, encoding: "utf8", timeout: (timeoutSec + 20) * 1000,
      maxBuffer: 8 * 1024 * 1024,
      env: {
        ...process.env,
        // Ticket 343 (operator max-effort order): the primary attempt carries the
        // model's maximum variant via the provider/model#variant suffix (xhigh
        // verified live on zen muse-free 2026-10-07); attempts/telemetry keep the
        // base model id so registry keys and billing classes stay canonical.
        OPENCODE_MANAGED_MODEL: withMaxVariant(ROLE_PRIMARY_MODEL),
        OPENCODE_MANAGED_AGENT: readOnly ? "fleet-reviewer" : "",
        OPENCODE_MANAGED_SSH_HOST: sshHost,
        BRIDGE_TIMEOUT_SEC: String(timeoutSec),
        ...(cwd ? { OPENCODE_MANAGED_CWD: String(cwd) } : {}),
        ...(sessionId ? { OPENCODE_MANAGED_SESSION: String(sessionId) } : {}),
        ...(title ? { OPENCODE_MANAGED_TITLE: String(title) } : {}),
      },
    });
    const out = (r.stdout ?? "").trim();
    const durationMs = Date.now() - t0;
    const rc = r.status ?? -1;
    if (rc === 0 && out) {
      return { ok: true, output: out, durationMs, failureClass: null, rc };
    }
    if (rc === 0 && !out) {
      return { ok: false, output: "", durationMs, failureClass: "MODEL_FAILURE", rc: 0 };
    }
    // Ticket 255: the managed bridge exits with typed rcs (42/43/44/45/47) —
    // map them first, then fall back to text classification.
    const RC_CLASS = { 42: "QUOTA", 43: "AUTH", 44: "PROVIDER_DOWN", 45: "RATE_LIMIT", 47: "MODEL_FAILURE", 124: "TIMEOUT" };
    const cls = RC_CLASS[rc] ?? (rc === 124 || /timed? ?out/i.test(out) ? "TIMEOUT" : classifyOutputError(out) ?? "PROVIDER_DOWN");
    return { ok: false, output: out || String(r.stderr ?? "").slice(0, 300), durationMs, failureClass: cls, rc };
  } catch (e) {
    return { ok: false, output: String(e.message ?? e), durationMs: Date.now() - t0, failureClass: "UNKNOWN", rc: -1 };
  } finally {
    try { rmSync(dir, { recursive: true, force: true }); } catch { /* temp */ }
  }
}

// Output-text rejection classifier (§5.2): rc=0 does NOT mean success.
export function classifyOutputError(text) {
  const t = String(text ?? "");
  if (/free tier can only be used from within opencode/i.test(t)) return "PROVIDER_DOWN";
  if (/unexpected server error|upstream request failed|model is unavailable/i.test(t)) return "PROVIDER_DOWN"; // 2026-10-19 narrator-fix: rc=0 + upstream error body must not count as a reply
  if (/at capacity|capacity exhausted|overloaded|HTTP 503|service unavailable/i.test(t)) return "PROVIDER_DOWN";
  if (/HTTP 429|too many requests|rate limit/i.test(t)) return "RATE_LIMIT";
  if (/usage limit|quota|credit/i.test(t)) return "QUOTA";
  if (/unauthorized|invalid api key/i.test(t)) return "AUTH";
  if (/timed? ?out|killed/i.test(t)) return "TIMEOUT";
  return null;
}

// Shared classifier/cleaner for opencode free-model results (sync + async
// paths must stay byte-identical in contract).
function finishOpenCodeResult(rawOut, status, t0) {
  const out = String(rawOut ?? "")
    .replace(/\x1b\[[0-9;]*[A-Za-z]/g, "")           // ANSI CSI
    .replace(/^>\s*\S+\s*·.*$/gm, "")               // "> agent · model" banner
    .trim();
  const durationMs = Date.now() - t0;
  if (status !== 0) {
    const cls = status === 124 || /timed? ?out/i.test(out) ? "TIMEOUT" : classifyOutputError(out) ?? "PROVIDER_DOWN";
    return { ok: false, output: out, durationMs, failureClass: cls, rc: status };
  }
  const outErr = classifyOutputError(out);
  if (outErr) return { ok: false, output: out, durationMs, failureClass: outErr, rc: 0 };
  if (!out) return { ok: false, output: "", durationMs, failureClass: "MODEL_FAILURE", rc: 0 };
  return { ok: true, output: out, durationMs, failureClass: null, rc: 0 };
}

// One attempt against one opencode free model over SSH to controller.
// readOnly=true uses the read-only fleet-reviewer agent (no write tools, and
// bash auto-denies in non-interactive runs); readOnly=false is the plain agent
// (quality fixer / V3.3.14 quad implementation seats). Strips opencode TUI
// noise so verdict regexes see the answer.
export function callFreeOpenCode(model, prompt, { sshHost = "controller", timeoutSec = 240, readOnly = true, variant = null } = {}) {
  const t0 = Date.now();
  const agent = readOnly ? "--agent fleet-reviewer" : "";
  try {
    const r = spawnSync("ssh", [sshHost,
      `timeout ${timeoutSec} /root/.opencode/bin/opencode run --model '${model}' ${variantFlag(variant)} ${agent} "$(cat)" </dev/null 2>&1 | tail -c 8000`,
    ], { encoding: "utf8", timeout: (timeoutSec + 30) * 1000, input: prompt, maxBuffer: 8 * 1024 * 1024 });
    return finishOpenCodeResult(r.stdout, r.status, t0);
  } catch (e) {
    return { ok: false, output: String(e.message ?? e), durationMs: Date.now() - t0, failureClass: "UNKNOWN", rc: -1 };
  }
}

// V3.3.14: async variant for QUAD free implementation seats — parallelizable
// (the coordinator runs several seats concurrently via Promise.all) and takes
// full phase-length timeouts. Identical cleaning/classification contract as
// the sync version (finishOpenCodeResult).
export function callFreeOpenCodeAsync(model, prompt, { sshHost = "controller", timeoutSec = 240, readOnly = true, variant = null } = {}) {
  // S08 SUBAGENT_SPAWN is emitted at the actual SEAT-SPAWN sites in
  // orchestrate.mjs (acquireWorker / runFreeSeatTurn / runSuperFreeSeatTurn),
  // not here: this transport also serves reviews, narration and single calls,
  // and firing per call would report turns as spawns.
  const t0 = Date.now();
  const remote = `timeout ${timeoutSec} /root/.opencode/bin/opencode run --model '${model}' ${variantFlag(variant)} ${readOnly ? "--agent fleet-reviewer" : ""} "$(cat)" </dev/null 2>&1 | tail -c 8000`;
  return new Promise((resolve) => {
    let child;
    try {
      child = spawn("ssh", [sshHost, remote], { stdio: ["pipe", "pipe", "pipe"] });
    } catch (e) {
      resolve({ ok: false, output: String(e.message ?? e), durationMs: Date.now() - t0, failureClass: "UNKNOWN", rc: -1 });
      return;
    }
    let out = "";
    const BUDGET = 8 * 1024 * 1024;
    const timer = setTimeout(() => { try { child.kill("SIGKILL"); } catch { } }, (timeoutSec + 30) * 1000);
    child.stdout?.on("data", (d) => { out += d; if (out.length > BUDGET) { try { child.kill("SIGKILL"); } catch { } } });
    child.stderr?.on("data", (d) => { out += d; });
    child.on("error", (e) => { clearTimeout(timer); resolve({ ok: false, output: String(e.message ?? e), durationMs: Date.now() - t0, failureClass: "UNKNOWN", rc: -1 }); });
    child.on("close", (code) => { clearTimeout(timer); resolve(finishOpenCodeResult(out, code ?? 0, t0)); });
    try { child.stdin.write(String(prompt ?? "")); child.stdin.end(); } catch { /* close handler resolves */ }
  });
}

// V3.3.13 (ticket 028): second free executor — OpenRouter ":free" slugs via
// openrouter-bridge.sh (direct REST from controller, independent of OpenCode).
// Bridge rc contract: 42=QUOTA 43=AUTH 44=RATE 45=TIMEOUT 47=MODEL_FAILURE.
// Output text is the raw completion (no TUI noise). Note: reasoning models
// spend tokens on hidden reasoning — callers should pass a generous
// OPENROUTER_MAX_TOKENS so content is not eaten by reasoning.
export function callFreeOpenRouter(model, prompt, {
  sshHost = "controller", timeoutSec = 240, maxTokens = 3000,
} = {}) {
  const t0 = Date.now();
  const dir = mkdtempSync(join(tmpdir(), "or-free-"));
  const pf = join(dir, "prompt.txt");
  try {
    writeFileSync(pf, String(prompt ?? ""), "utf8");
    const kitDir = "/workspace/work/ai-orchestration";
    // bash, not bun — see the async twin above (bun cannot execute the bash
    // bridge; latent same-class bug fixed alongside ticket 157's delta seat).
    const r = spawnSync("bash", ["openrouter-bridge.sh", pf], {
      cwd: kitDir, encoding: "utf8", timeout: (timeoutSec + 30) * 1000,
      maxBuffer: 8 * 1024 * 1024,
      env: {
        ...process.env,
        OPENROUTER_SSH_HOST: sshHost,
        OPENROUTER_MODEL: String(model ?? "").replace(/^openrouter\//, ""), // 2026-10-24: roster seats carry "openrouter/<slug>"; the API expects the bare slug
        OPENROUTER_MAX_TOKENS: String(maxTokens),
        BRIDGE_TIMEOUT_SEC: String(timeoutSec),
      },
    });
    const out = (r.stdout ?? "").trim();
    const durationMs = Date.now() - t0;
    const rc = r.status ?? -1;
    if (rc === 0 && out) {
      return { ok: true, output: out, durationMs, failureClass: null, rc };
    }
    let cls = "MODEL_FAILURE";
    if (rc === 42) cls = "QUOTA";
    else if (rc === 43) cls = "AUTH";
    else if (rc === 44) cls = "RATE_LIMIT";
    else if (rc === 45 || rc === 124) cls = "TIMEOUT";
    else if (/timed? ?out/i.test(out) || (r.error && r.error.code === "ABORT_ERR")) cls = "TIMEOUT";
    const errText = (r.stderr ?? "").slice(0, 300) || out.slice(0, 300);
    return { ok: false, output: errText, durationMs, failureClass: cls, rc };
  } catch (e) {
    return { ok: false, output: String(e.message ?? e), durationMs: Date.now() - t0, failureClass: "UNKNOWN", rc: -1 };
  } finally {
    try { rmSync(dir, { recursive: true, force: true }); } catch { /* temp */ }
  }
}

// Walk the role's free chain. Returns
// { ok, output, model, attempts, failureClass, durationMs } — never throws.
// Ticket 157 (Super AI Mode): async twin of callFreeOpenRouter for the
// super-mode delta seat (runSuperFreeSeatTurn awaits turns inside the phase
// loop alongside the paid seats). Same bridge script, env contract, and rc
// mapping as callFreeOpenRouter — only the invocation is non-blocking.
export function callFreeOpenRouterAsync(model, prompt, opts = {}) {
  const { sshHost = "controller", timeoutSec = 240, maxTokens = 3000 } = opts;
  return new Promise((resolve) => {
    const dir = mkdtempSync(join(tmpdir(), "or-free-async-"));
    const pf = join(dir, "prompt.txt");
    try { writeFileSync(pf, String(prompt ?? ""), "utf8"); } catch (e) {
      return resolve({ ok: false, output: String(e.message ?? e), durationMs: 0, failureClass: "UNKNOWN", rc: -1 });
    }
    // bash, not bun — openrouter-bridge.sh is a bash script (the live-verified
    // invocation is EngineRouter's spawnSync("bash", [script, …]); spawning it
    // under bun fails with "Redirection with no file").
    const child = spawn("bash", ["openrouter-bridge.sh", pf], {
      cwd: "/workspace/work/ai-orchestration",
      env: {
        ...process.env,
        OPENROUTER_SSH_HOST: sshHost,
        OPENROUTER_MODEL: String(model ?? "").replace(/^openrouter\//, ""), // 2026-10-24: roster seats carry "openrouter/<slug>"; the API expects the bare slug
        OPENROUTER_MAX_TOKENS: String(maxTokens),
        BRIDGE_TIMEOUT_SEC: String(timeoutSec),
      },
    });
    let out = "", err = "";
    const timer = setTimeout(() => { try { child.kill("SIGKILL"); } catch { /* already gone */ } }, (timeoutSec + 30) * 1000);
    child.stdout.on("data", (d) => { out += d; });
    child.stderr.on("data", (d) => { err += d; });
    child.on("error", (e) => {
      clearTimeout(timer);
      try { rmSync(dir, { recursive: true, force: true }); } catch { /* temp */ }
      resolve({ ok: false, output: String(e.message ?? e), durationMs: 0, failureClass: "UNKNOWN", rc: -1 });
    });
    child.on("close", (rc) => {
      clearTimeout(timer);
      try { rmSync(dir, { recursive: true, force: true }); } catch { /* temp */ }
      const o = (out ?? "").trim();
      if (rc === 0 && o) return resolve({ ok: true, output: o, durationMs: 0, failureClass: null, rc });
      let cls = "MODEL_FAILURE";
      if (rc === 42) cls = "QUOTA";
      else if (rc === 43) cls = "AUTH";
      else if (rc === 44) cls = "RATE_LIMIT";
      else if (rc === 45 || rc === 124) cls = "TIMEOUT";
      else if (/timed? ?out/i.test(o) || /timed? ?out/i.test(err)) cls = "TIMEOUT";
      resolve({ ok: false, output: (err || o).slice(0, 300), durationMs: 0, failureClass: cls, rc: rc ?? -1 });
    });
  });
}

export function callFreeRole(role, prompt, {
  runsDir,
  runId = null,
  component,
  purpose,
  sshHost = "controller",
  timeoutSec = 240,
  totalTimeoutSec = 0,   // V3.3.13: ONE overall failover deadline (0 = legacy per-candidate budgets)
  readOnly = true,
  exclude = [],          // model ids to skip (e.g. §22 auditor ≠ reviewer)
  maxAttempts = 0,       // 0 = all candidates
  telemetry = true,
  managedCwd = null,     // ticket 268: narrator isolation (null = worker default)
  managedSessionId = null,
  managedTitle = null,
} = {}) {
  initTelemetry(runsDir); // V3.3 §2.1: bind ledger to the caller's runsDir
  const candidates = (FREE_MODEL_REGISTRY[role] ?? []).filter((m) => !exclude.includes(m));
  if (!candidates.length) {
    return { ok: false, output: null, model: null, attempts: [], failureClass: "CONFIG_ERROR", durationMs: 0,
      reason: `no approved free models for role ${role}${exclude.length ? " after exclusions" : ""}` };
  }
  const attempts = [];
  const t0 = Date.now();
  // V3.3.13 (Sol turn-4 correction 3): one overall deadline — each candidate
  // only gets the REMAINING budget, so a chain of timeouts can never block
  // for candidates × timeout. Narrator uses ~60s total then falls back.
  const deadline = totalTimeoutSec > 0 ? t0 + totalTimeoutSec * 1000 : null;
  // Ticket 255: managed Go-plan primary attempt first (unless excluded), then
  // the free fallback walk below. Out-of-credit/quota failures are
  // failover-eligible, so they fall through to the free models. Short-deadline
  // callers (narrator, <=120s total) cap the managed attempt at 35s so the
  // free tail still has budget to answer.
  if (!exclude.includes(ROLE_PRIMARY_MODEL) && process.env.ORCH_FREE_ONLY !== "1") {
    const remain = deadline ? Math.max(5, Math.ceil((deadline - Date.now()) / 1000)) : timeoutSec;
    const mgdTimeout = (totalTimeoutSec > 0 && totalTimeoutSec <= 120) ? Math.min(remain, 35) : remain;
    const rm = callManagedPrimary(prompt, { sshHost, timeoutSec: mgdTimeout, readOnly, cwd: managedCwd, sessionId: managedSessionId, title: managedTitle });
    if (telemetry) {
      try {
        recordInvocation({
          runId, component, role, purpose,
          engine: "opencode-managed-muse", model: ROLE_PRIMARY_MODEL, billingClass: "subscription_included",
          success: rm.ok, failureClass: rm.ok ? "NONE" : rm.failureClass, rc: rm.rc,
          paid: false, durationMs: rm.durationMs,
        });
      } catch { /* telemetry never breaks the call path */ }
    }
    attempts.push({ model: ROLE_PRIMARY_MODEL, ok: rm.ok, failureClass: rm.failureClass, durationMs: rm.durationMs, output: rm.output });
    if (managedSessionId) { try { archiveManagedSession(managedSessionId, { sshHost }); } catch {} }
    if (rm.ok) {
      return { ok: true, output: rm.output, model: ROLE_PRIMARY_MODEL, attempts, failureClass: null, durationMs: Date.now() - t0 };
    }
    if (!FAILOVER_ELIGIBLE.has(rm.failureClass)) {
      return {
        ok: false, output: null, model: null, attempts,
        failureClass: rm.failureClass, durationMs: Date.now() - t0,
        reason: `managed primary failed with non-failover class ${rm.failureClass}`,
      };
    }
    // failover-eligible (incl. QUOTA / out-of-credit): continue to the free walk
  }
  // walk-scoped provider gates (Sol: provider-wide AUTH/QUOTA must not have
  // every sibling attempted independently; repeated RATE skips the provider
  // for the REST OF THIS WALK only — no permanent health poisoning)
  let orBlocked = null, orRateStrikes = 0;
  for (const model of candidates) {
    if (maxAttempts && attempts.filter((a) => !a.skipped).length >= maxAttempts) break;
    if (deadline && Date.now() > deadline - 5_000) {
      attempts.push({ model, skipped: true, reason: "overall failover deadline exhausted" });
      continue;
    }
    const isOpenRouter = model.startsWith("openrouter/");
    if (isOpenRouter && orBlocked) {
      attempts.push({ model, skipped: true, reason: `openrouter provider gate: ${orBlocked}` });
      continue;
    }
    const avail = modelAvailable(model, runsDir);
    if (!avail.ok) {
      attempts.push({ model, skipped: true, reason: avail.reason });
      continue;
    }
    const remainSec = deadline ? Math.max(5, Math.ceil((deadline - Date.now()) / 1000)) : timeoutSec;
    const r = isOpenRouter
      ? callFreeOpenRouter(model, prompt, { sshHost, timeoutSec: remainSec })
      : callWithEffortSync(callFreeOpenCode, model, prompt, { sshHost, timeoutSec: remainSec, readOnly }, resolveEffort(model, {})); // ticket 189 item 11 + ticket 343 (Sol Q5): maximum variant everywhere the model exposes one — the short-deadline variant-null exception is REMOVED (operator max-effort order supersedes the narrator latency shortcut)
    if (isOpenRouter && !r.ok) {
      if (r.failureClass === "AUTH" || r.failureClass === "QUOTA") orBlocked = r.failureClass;
      if (r.failureClass === "RATE_LIMIT" && ++orRateStrikes >= 2) orBlocked = "RATE_LIMIT x2";
    }
    recordModelOutcome(model, runsDir, { success: r.ok, failureClass: r.failureClass, durationMs: r.durationMs });
    if (telemetry) {
      try {
        recordInvocation({
          runId, component, role, purpose,
          engine: isOpenRouter ? "openrouter" : "opencode", model, billingClass: "free",
          success: r.ok, failureClass: r.ok ? "NONE" : r.failureClass, rc: r.rc,
          paid: false, durationMs: r.durationMs,
        });
      } catch { /* telemetry never breaks the call path */ }
    }
    attempts.push({ model, ok: r.ok, failureClass: r.failureClass, durationMs: r.durationMs, output: r.output });
    if (r.ok) {
      return { ok: true, output: r.output, model, attempts, failureClass: null, durationMs: Date.now() - t0 };
    }
    if (!FAILOVER_ELIGIBLE.has(r.failureClass)) break; // deterministic/local failure: stop
    // provider-failover-eligible: cooldown already recorded; try next free model
  }
  const failed = attempts.filter((a) => !a.skipped);
  return {
    ok: false, output: null, model: null, attempts,
    failureClass: failed[failed.length - 1]?.failureClass ?? "UNAVAILABLE",
    durationMs: Date.now() - t0,
    reason: failed.length ? `all ${failed.length} approved free model(s) failed` : "all candidates in cooldown",
  };
}
