// lib/memory-orchestra/wire.mjs — MemOS gap-closure addendum (2026-10-23) §17.
// The single advisory-helper call sites use for hooks that are retrieval-only
// (§5 decision repair + §7 "advisory" packet). Contract for EVERY helper:
//   - flags checked INSIDE runHook, so flags-off costs one flags() read and
//     changes nothing;  - never throws (returns null on any failure);
//   - returns { ok, code?, text?, fingerprint?, bytesUsed? } — consumers may
//     only APPEND the text as a bounded, explicitly-labelled advisory block;
//     the packet never executes anything and never replaces live verification.
// Channels with no supported live engine (docs/temporal) degrade typed inside
// the planner — helpers are still safe to call.
import { runHook, boundStepsExecutors } from "./hooks.mjs";
import { createPlannerExecutors } from "./executors.mjs";
import { appendFileSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";

// S08 (Sol remediation 2026-10-23): every hook invocation emits ONE durable,
// bounded observation record (type, payload summary, correlation identity,
// outcome). It is an observation journal, not a second event framework: the
// advisory path itself remains fail-open and can never block the caller.
export const HOOK_EVENT_LOG = process.env.ORCH_HOOK_EVENT_LOG
  || "/opt/harness-unset/ai-orchestration/kit/runs/_morch/hook-events.jsonl";
function recordHookEvent(ev) {
  try {
    mkdirSync(dirname(HOOK_EVENT_LOG), { recursive: true });
    appendFileSync(HOOK_EVENT_LOG, JSON.stringify({ ts: new Date().toISOString(), ...ev }).slice(0, 1200) + "\n", "utf8");
  } catch { /* fail-open: observation only */ }
}

const cap = (s, n) => { s = String(s ?? ""); return s.length <= n ? s : s.slice(0, n - 1) + "…"; };

// P0 (2026-10-24): these helpers previously built executors with ONLY the step
// store bound, so every channel backed by RepoQL/MemoryCore/L2-L3 returned
// nothing and the hook typed INSUFFICIENT while all flags read ON. Bind the
// same real clients the TURN_START path uses; any client that cannot be
// constructed stays null and its channels degrade typed, exactly as before.
async function advisoryExecutors(runsDirs) {
  const steps = boundStepsExecutors(runsDirs ? { runsDirs } : {});
  let repoql = null, memorycore = null, l23 = null;
  try { repoql = (await import("../repoql-client.mjs")).createRepoqlClient({}); } catch { /* typed-pending channels */ }
  try { memorycore = (await import("../memorycore-client.mjs")).createMemorycoreClient({}); } catch { /* typed-pending channels */ }
  try { l23 = (await import("./client-l23.mjs")).createMemorycoreL23Client(); } catch { /* typed-pending channels */ }
  return createPlannerExecutors({ memorycore, repoql, l23, steps });
}

async function advisory(hook, { query, scope = {}, extraExecutorTags = [], runsDirs = null } = {}) {
  try {
    const executors = await advisoryExecutors(runsDirs);
    const res = await runHook({ hook, query: cap(query, 400), scope, executors, budgetBytes: 400 });
    const out = res.ok && res.verdict?.state !== "INSUFFICIENT" && res.packet?.text && Number(res.packet.bytesUsed ?? 0) > 0
      ? { ok: true, text: res.packet.text, fingerprint: res.packet.fingerprint, bytesUsed: res.packet.bytesUsed, state: res.verdict.state }
      : { ok: false, code: res.code ?? (res.ok ? "INSUFFICIENT" : "HOOK_REFUSED") };
    recordHookEvent({ hook, query: cap(query, 200), scope: { agent: scope?.agent ?? null, caseRun: scope?.caseRun ?? null, skillName: scope?.skillName ?? null }, ok: out.ok, code: out.code ?? null, bytes: out.bytesUsed ?? 0, fingerprint: out.fingerprint ?? null });
    return out;
  } catch (e) {
    const why = `${String(e?.name ?? e).slice(0, 24)}:${String(e?.message ?? "").replace(/\s+/g, " ").slice(0, 140)}`;
    recordHookEvent({ hook, query: cap(query, 200), ok: false, code: `WIRE_THROW:${why}` });
    return { ok: false, code: `WIRE_THROW:${why}` };
  }
}

// §17 SKILL_INVOCATION — call at skill-load/first-invoke sites; the payload is
// approved-only (skill-approved channel is approvalGated in fusion).
export function skillInvocationAdvisory({ skillName = null, query = "" } = {}, opts = {}) {
  return advisory("SKILL_INVOCATION", { query: `skill ${skillName ?? ""} ${query}`, scope: { skillName } , ...opts });
}

// §17 TOOL_FAILURE — fires from the actual terminal-failure closeout path (the
// run's recorded failure), separately from DECISION_REPAIR's repair retrieval.
export function toolFailureHook({ signature = null, runId = null, query = "" } = {}, opts = {}) {
  return advisory("TOOL_FAILURE", { query: `${signature ?? ""} ${query}`.trim(), scope: { caseRun: runId, agent: opts.agent ?? "general" }, ...opts });
}

// §5 INCIDENT_INVESTIGATION — fires when a terminal failure is recorded as an
// incident and the incident-investigation retrieval actually runs.
export function incidentInvestigationHook({ signature = null, runId = null, query = "" } = {}, opts = {}) {
  return advisory("INCIDENT_INVESTIGATION", { query: `${signature ?? ""} ${query}`.trim(), scope: { caseRun: runId, agent: opts.agent ?? "general" }, ...opts });
}

// §5/§21 REFLECTION — call from the reflection/dream path (ghostwake digest).
export function reflectionAdvisory({ subject = "", query = "" } = {}, opts = {}) {
  return advisory("REFLECTION", { query: `${subject} ${query}`.trim(), scope: { caseRun: opts.caseRun ?? null, agent: opts.agent ?? "ghost" }, ...opts });
}

// §17 SUBAGENT_SPAWN — call at seat/spawn sites (kernel/scheduler). Bounded FAST
// tier (planner table): concept + approved skill + fresh-store basename context.
export function subagentSpawnAdvisory({ query = "", agent = null, parentRun = null } = {}, opts = {}) {
  return advisory("SUBAGENT_SPAWN", { query, scope: { agent, caseRun: parentRun }, ...opts });
}

// §17 DOCUMENTATION_AUTHORING — call at doc-authoring/refresh sites so drafting
// can cite current docs/RepoQL leaves. Never auto-writes anything itself.
export function documentationAuthoringAdvisory({ subject = "", affectedPaths = [] } = {}, opts = {}) {
  return advisory("DOCUMENTATION_AUTHORING", { query: `${subject} ${affectedPaths.slice(0, 4).join(" ")}`.trim(), scope: { subject, affectedPaths: affectedPaths.slice(0, 6) }, ...opts });
}

// §16/§18 TOOL_FAILURE / DECISION_REPAIR — record once (§ ledger), then run the
// repair retrieval and return the bounded advisory payload. Caller-only append;
// retrieval never executes anything. flags.decisionRepair gates the RECORD
// (fresh writes), flags.planner/fusion gate the retrieval portion.
export async function toolFailureRepair({ signature = null, runId = null, caseRun = null, phase = null, query = "" } = {}, opts = {}) {
  try {
    const { flags } = await import("./flags.mjs");
    const { recordFailure, isRepeatedFailure } = await import("./decision-repair.mjs");
    const sig = cap(signature, 160);
    if (!sig) return { ok: false, code: "SIGNATURE_REQUIRED" };
    let rec = null;
    if (flags().decisionRepair) {
      try {
        const r = recordFailure({ signature: sig, runId, caseRun, phase, notes: cap(query, 200) }, opts.decisionRepairState ? { stateDir: opts.decisionRepairState } : undefined);
        if (r?.ok) {
          const share = opts.decisionRepairState ? { stateDir: opts.decisionRepairState } : {};
          const rep2 = isRepeatedFailure({ signature: sig, runId }, share);
          rec = { repeated: rep2.repeated, observed: rep2.observed, threshold: rep2.threshold };
        }
      } catch { /* ledger-only */ }
    }
    // Repair retrieval is independent of the record (retrieval flags gate it
    // inside advisory(); a repeated failure is not required — prior verified
    // failures and repair rows simply answer what exists).
    const rep = await advisory("DECISION_REPAIR", { query: `${sig} ${query}`, scope: { errorSignature: sig, caseRun, agent: opts.agent ?? "general" }, ...opts });
    return { ok: true, signature: sig, recorded: rec, repair: rep };
  } catch (e) {
    return { ok: false, code: `REPAIR_WIRE_THROW:${String(e?.name ?? e).slice(0, 24)}` };
  }
}
