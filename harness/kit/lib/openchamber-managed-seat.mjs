// openchamber-managed-seat.mjs — V3.5.2 + ticket 268 (ticket 187, operator 2026-09-30):
// quad gamma/delta are GPT-6 Luna (openai/gpt-6-luna#max) SUBSCRIPTION seats
// executed through the EXISTING OpenChamber managed OpenAI OAuth pathway.
//
// Sol consult 2026-09-30T01-23-31-445-62600 (CONFIRMED) constraints, all
// enforced here:
//   - EXPLICIT transport ("openchamber-managed") — never inferred from the
//     engine name; do NOT redefine isFreeSeat() as "not Freebuff".
//   - Gamma/Delta NEVER enter the Freebuff thread lifecycle, NEVER call
//     callFreeOpenCodeAsync()/the free opencode host CLI (the host CLI has no
//     openai provider — the OAuth credential row (integration_id=openai)
//     lives in the managed opencode DB mounted ONLY inside the openchamber
//     container; ticket 167 E2E-verified Luna max through this exact surface).
//   - NO internal fallback: this transport never re-routes a seat turn by
//     itself (no seatAlternates(), no Freebuff, no cross-provider
//     substitution). Routing callers MAY walk to the free tail on a failed or
//     out-of-credit seat (ticket 255 operator order 2026-10-03); criticality
//     still follows the WORK (isOptionalSeatAssignment).
//   - Telemetry: billingClass="subscription", paid=false (no metered dollar
//     charge observable via the Plus pathway — that is NOT "zero usage" as a
//     provider fact; note records the managed transport), freebucksUsed=0.
//
// Transport mechanics reuse the live-proven container invocation pattern from
// lib/openchamber-remediate.mjs (buildContainerNudgeScript/runNudge, issues
// 030/028): `ssh controller docker exec -i openchamber sh` with the script on
// STDIN (never as an sh -c argument — quotes are lost to ssh reassembly,
// live-learned 2026-09-20). Inside the container: `opencode run
// --model openai/gpt-6-luna#max` — v2.0.16 CLI takes provider/model#variant
// (verified live via `opencode run --help` 2026-09-30).

import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { dispatchDecision, nativeOpenCodeClient } from "./native-opencode-worker.mjs";

export const MANAGED_MODEL = "openai/gpt-6-luna#max";
export const MANAGED_CONTAINER = process.env.OPENCHAMBER_CONTAINER || "openchamber";
export const OPENCODE_BIN = "/home/openchamber/.npm-global/bin/opencode";

// Work dir inside the container for seat turns (workspaces bind mount, consult
// fact F). Set MANAGED_CWD per-turn via opts.cwd if a run needs another dir.
export const MANAGED_CWD = "/home/openchamber/workspaces";

// Failure classes shared with the seat-failover vocabulary. Managed seats do
// NOT act on these (no failover) — they only carry them for telemetry/status.
export const MANAGED_SEAT_CLASSES = {
  AUTH: "AUTH",                 // OAuth row missing/expired inside container
  PROVIDER_DOWN: "PROVIDER_DOWN", // container down / CLI error / model unknown
  TIMEOUT: "TIMEOUT",
  MODEL_FAILURE: "MODEL_FAILURE", // rc0 with no usable output
  QUOTA: "QUOTA",               // out of subscription credit / usage limit (ticket 255)
  UNKNOWN: "UNKNOWN",
};

// 2026-09-30 (claude): on rc=0 only CLI error LINES are classified. Scanning
// the whole reply turned finished reviews into failures whenever Luna's text
// mentioned "timeout" or "credential" (run 2026-09-30T05-02-56: delta's
// concurrency review -> false TIMEOUT). A non-zero rc still scans everything.
const CLI_ERROR_LINE = /^\s*(?:error|✗|ERROR|Error:|opencode:?\s*error)[:\s]/m;
function classifyManagedOutput(out, code) {
  const t = String(out ?? "");
  const scan = code === 0 ? t.split("\n").filter((l) => CLI_ERROR_LINE.test(l)).join("\n") : t;
  if (/provider not found|unknown (provider|model)|no auth|not authenticated|credential/i.test(scan)) return "AUTH";
  // Ticket 255 failure-injection finding: the container CLI reports a retired/
  // unavailable model as a plain "Error: Model unavailable: …" line (rc0 at
  // the process boundary) — it must classify as PROVIDER_DOWN so the free
  // tail engages instead of treating the error text as an answer.
  if (/model unavailable|model not found|model is not available/i.test(scan)) return "PROVIDER_DOWN";
  if (/usage limit|quota|out of credit|insufficient|payment required|billing/i.test(scan)) return "QUOTA";
  if (/timed? ?out/i.test(scan)) return "TIMEOUT";
  if (code !== 0) return "PROVIDER_DOWN";
  return null;
}

// Pure: the sh script executed INSIDE the openchamber container (STDIN to
// `docker exec -i sh`). Mirrors buildContainerNudgeScript's shape: env, cd,
// run, echo sentinel. The prompt travels as a single quoted argument —
// prompt content is kit-controlled (plan/assignment text), and the kit's own
// shQuote contract (escape ' and backslashes) makes it safe.
export function buildManagedSeatScript({ model = MANAGED_MODEL, prompt, timeoutSec = 2400, cwd = MANAGED_CWD, agent = null, sessionId = null, title = null } = {}) {
  const q = (s) => `'` + String(s).replace(/\\/g, "\\\\").replace(/'/g, "'\\''") + `'`;
  const agentFlag = agent ? ` --agent ${q(agent)}` : "";
  const sessionFlag = sessionId && /^ses[\w-]{1,80}$/.test(String(sessionId)) ? ` --session ${q(String(sessionId))}` : "";
  const titleFlag = title ? ` --title ${q(String(title).slice(0, 100))}` : "";
  return [
    `export HOME=/home/openchamber OPENCODE_CONFIG_DIR=/home/openchamber/.config/opencode`,
    `mkdir -p ${q(cwd)} 2>/dev/null || true`,
    `cd ${q(cwd)} || cd /home/openchamber`,
    `timeout ${timeoutSec} ${OPENCODE_BIN} run --model ${q(model)}${agentFlag}${sessionFlag}${titleFlag} ${q(String(prompt ?? ""))} 2>&1 | tail -c 8000`,
    `echo __MANAGED_SEAT_DONE__`,
  ].join("\n");
}

// One managed seat turn. Returns the same contract runFreeSeatTurn callers
// expect: { ok, output, durationMs, failureClass, rc }. Never throws.
// execInject is for tests (selftest never talks to the live container).
export async function callManagedSeat(model, prompt, {
  container = MANAGED_CONTAINER, sshHost = "controller", timeoutSec = 2400,
  cwd = MANAGED_CWD, execInject = null, agent = null, sessionId = null, title = null,
  platform = process.platform, nativeConfig = null,
} = {}) {
  // S08 SUBAGENT_SPAWN is emitted by the seat-spawn sites in orchestrate.mjs
  // (once per parent run + agent), never by this per-turn transport.
  const t0 = Date.now();
  // Native Windows MUST NOT shell out to SSH/Docker. The optional OpenChamber
  // HTTP transport is enabled only with explicit model/workspace/billing proof.
  if (platform === 'win32') return nativeManagedTurn(model, prompt, { nativeConfig, timeoutSec, t0, agent });
  const script = buildManagedSeatScript({ model, prompt, timeoutSec, cwd, agent, sessionId, title });
  const run = execInject || managedExec;
  try {
    const r = await run({ script, container, sshHost, timeoutSec });
    return finishManaged(r.output, r.code, t0);
  } catch (e) {
    return { ok: false, output: String(e?.message ?? e), durationMs: Date.now() - t0, failureClass: "UNKNOWN", rc: -1 };
  }
}

// Source-level native Windows execution adapter. The Rust authority must
// eventually own admission leases, durable queueing and completion proof.
async function nativeManagedTurn(model, prompt, { nativeConfig, timeoutSec, t0, agent }) {
  const fail = (code) => ({ok:false,output:`native OpenCode worker unavailable: ${code}`,
    failureClass:code==='NO_CAPACITY'?'QUOTA':'UNKNOWN',rc:-1,durationMs:Date.now()-t0});
  const n=nativeConfig;
  if (!n || typeof n !== 'object' || n.writeApproved !== true ||
      typeof n.expectedDirectory !== 'string' || !n.expectedDirectory ||
      typeof n.passwordEnv !== 'string' || !/^[A-Z][A-Z0-9_]{2,80}$/.test(n.passwordEnv)) return fail('CONFIG');
  const expected=`${n.providerID}/${n.modelID}`;
  if (typeof n.providerID !== 'string' || typeof n.modelID !== 'string' ||
      model.split('#')[0] !== expected) return fail('MODEL_MISMATCH');
  const decision=dispatchDecision({opencodeCapacity:n.capacity,activeOpenCode:n.active,
    approvedModel:{providerID:n.providerID,modelID:n.modelID},billingClass:n.billingClass,
    allowPaid:n.allowPaid === true});
  if (decision.status !== 'READY') return fail(decision.code);
  try {
    const c=nativeOpenCodeClient({server:n.server,password:process.env[n.passwordEnv],
      timeoutMs:Math.min(120_000, Math.max(100,Math.floor(timeoutSec*1000)))});
    const health=await c.health();
    if (!health.healthy) return fail('HEALTH_UNVERIFIED');
    const directory=await c.projectDirectory();
    // No write-capable worker may be dispatched into another GUI workspace.
    const normalize=(x)=>String(x).replace(/\\/g,'/').replace(/\/$/,'').toLowerCase();
    if (!directory || normalize(directory)!==normalize(n.expectedDirectory)) return fail('WORKSPACE_MISMATCH');
    const taskId=`seat_${randomUUID().replaceAll('-','')}`;
    const submission=await c.submit({taskId,prompt,decision,agent:agent||'build'});
    if (submission.status!=='ACCEPTED') return fail(submission.status==='DELIVERY_UNCERTAIN' ?
      `DELIVERY_UNCERTAIN_session_${submission.sessionId}` : submission.status);
    const observed=await c.observeCompletion(submission.sessionId,{timeoutMs:Math.min(timeoutSec*1000,24*3600_000)});
    if (observed.status!=='RESPONSE_OBSERVED') return fail(observed.status);
    return {...finishManaged(observed.output,0,t0),sessionId:submission.sessionId,
      completionVerified:false,transport:'native-opencode-http'};
  } catch (error) { return fail(error?.code||'HTTP_UNAVAILABLE'); }
}

// Default executor: spawn ssh -> docker exec -i (script via STDIN). Bounded
// output budget mirrors callFreeOpenCodeAsync (8 MB) with the same +30s kill
// grace after timeout.
function managedExec({ script, container, sshHost, timeoutSec }) {
  return new Promise((resolve) => {
    let child;
    try {
      child = spawn("ssh", [sshHost, "docker", "exec", "-i", container, "sh"], { stdio: ["pipe", "pipe", "pipe"] });
    } catch (e) {
      resolve({ output: String(e?.message ?? e), code: -1 });
      return;
    }
    let out = "";
    const BUDGET = 8 * 1024 * 1024;
    const timer = setTimeout(() => { try { child.kill("SIGKILL"); } catch { } }, (timeoutSec + 30) * 1000);
    child.stdout?.on("data", (d) => { out += d; if (out.length > BUDGET) { try { child.kill("SIGKILL"); } catch { } } });
    child.stderr?.on("data", (d) => { out += d; });
    child.on("error", (e) => { clearTimeout(timer); resolve({ output: String(e?.message ?? e), code: -1 }); });
    child.on("close", (code) => { clearTimeout(timer); resolve({ output: out, code: code ?? 0 }); });
    try { child.stdin.write(script + "\n"); child.stdin.end(); } catch { /* close handler resolves */ }
  });
}

// Shared finish/classify: strip ANSI + banner noise (same rules as
// finishOpenCodeResult), classify rc/text, treat rc0-empty as MODEL_FAILURE.
export function finishManaged(rawOut, code, t0) {
  const out = String(rawOut ?? "")
    .replace(/\x1b\[[0-9;]*[A-Za-z]/g, "")
    .replace(/^>\s*\S+\s*·.*$/gm, "")
    .replace(/__MANAGED_SEAT_DONE__\s*$/m, "")
    .trim();
  const durationMs = Date.now() - t0;
  if (code !== 0) {
    const cls = code === 124 || /timed? ?out/i.test(out) ? "TIMEOUT" : classifyManagedOutput(out, code) ?? "PROVIDER_DOWN";
    return { ok: false, output: out, durationMs, failureClass: cls, rc: code };
  }
  const outErr = classifyManagedOutput(out, code);
  if (outErr) return { ok: false, output: out, durationMs, failureClass: outErr, rc: 0 };
  if (!out) return { ok: false, output: "", durationMs, failureClass: "MODEL_FAILURE", rc: 0 };
  return { ok: true, output: out, durationMs, failureClass: null, rc: 0 };
}

// Ticket 255 (code-review finding 1): the process boundary must CARRY the
// failure class, not collapse it to rc1. Typed exit codes mirror the fleet RC
// contract (42 QUOTA / 43 AUTH / 44 PROVIDER / 45 TRANSIENT / 47 INVALID) so
// EngineRouter's classify() lands on a failover-eligible class and the free
// tail engages on real managed failures (incl. out-of-credit).
export const MANAGED_SEAT_RCS = Object.freeze({
  QUOTA: 42, AUTH: 43, PROVIDER_DOWN: 44, TIMEOUT: 45, MODEL_FAILURE: 47,
});
export function managedSeatExitCode(r) {
  if (r?.ok) return 0;
  const mapped = r?.failureClass ? MANAGED_SEAT_RCS[r.failureClass] : undefined;
  if (mapped !== undefined) return mapped;
  return (r?.rc && r.rc !== 0) ? r.rc : 1;
}

// Pure config validation (consult step: reject malformed config rather than
// trim unpredictably). A quad subscription seat must declare its transport
// explicitly; freeSeatEntriesInConfig() never classifies here.
export function validateManagedSeat(seat, { platform = process.platform, nativeConfig = null } = {}) {
  if (!seat || typeof seat !== "object") return { ok: false, why: "seat missing" };
  if (String(seat.transport ?? "") !== "openchamber-managed") return { ok: false, why: "transport must be openchamber-managed" };
  if (!/^[a-z0-9-]+\/[a-z0-9.#-]+$/i.test(String(seat.model ?? ""))) return { ok: false, why: "model missing/invalid" };
  const native = platform === 'win32' && nativeConfig && String(nativeConfig.billingClass ?? '') === String(seat.billingClass ?? '') &&
    (seat.billingClass === 'free' || seat.billingClass === 'subscription');
  if (!native && String(seat.billingClass ?? '') !== "subscription") return { ok: false, why: "billingClass must be subscription except explicitly configured Windows OpenCode transport" };
  return { ok: true, why: null };
}
