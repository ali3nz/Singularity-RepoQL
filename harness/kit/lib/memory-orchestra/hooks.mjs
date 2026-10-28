// lib/memory-orchestra/hooks.mjs — MemOS gap-closure addendum (2026-10-23)
// directive §17 (retrieval at multiple execution points). ONE entry function
// call sites use: runHook(hook, ctx) → plan → bounded fetch → fuse →
// answerability (one targeted expansion where budget allows) → packet →
// ledger. Flags gate EVERY stage (default OFF ⇒ runHook returns typed
// FLAG_DISABLED with zero side effects, keeping all kit call sites
// byte-identical legacy behaviour until the validation directive).
//
// Call-site wiring contract: import { bindHook } and call runHook ONLY after
// checking shouldRun() — the wrapper itself never throws (a hook failure can
// never break the host flow; worst case it yields an empty packet and a
// failed ledger event).
//
// Duplicated-injection guard (§17 "no repeated injection of the same
// information during one execution stage"): callers MAY pass
// ctx.stageFingerprints (a Set/array of docker fingerprints already injected
// this stage); if the built packet's fingerprint is present, runHook skips
// re-emission and returns code ALREADY_INJECTED with the packet attached.
import { flags, enabledWhen } from "./flags.mjs";
import { plan, planAndFetch, TIERS } from "./planner.mjs";
import { fuse } from "./fusion.mjs";
import { buildVerdict, fingerprintPacket } from "./context.mjs";
import { beginRetrieval, endRetrieval } from "./ledger.mjs";
import { createStepsExecutors } from "./steps.mjs";
import { createPlannerExecutors, createDefaultTombstoneEval } from "./executors.mjs";

export function shouldRun() {
  // Test isolation (Sol performance ruling 2026-10-24): suites that do not test
  // retrieval must be able to run with advisories off, without touching flags.
  if (String(process.env.ORCH_MORCH_DISABLE ?? "0") === "1") return false;
  const fs = flags();
  return fs.planner && fs.fusion; // pipeline readability: both on or nothing
}

export function boundStepsExecutors(opts = {}) {
  return createStepsExecutors(opts);
}

// Full production executor set: the native client adapters (memorycore/repoql),
// the step-store executors, and typed-pending holders for channels with no
// supported live engine yet (docs/temporal). Call sites may override any
// holder (tests bind fakes; future call sites bind real readers).
export function boundFullExecutors(opts = {}) {
  return createPlannerExecutors({
    steps: createStepsExecutors(opts),
    tombstoneEval: opts.tombstoneEval ?? createDefaultTombstoneEval(),
    ...opts,
  });
}

function stubPlan(c) {
  // local echo of planner channel shape so hooks.mjs never mutates planner
  return { ...c };
}

export async function runHook({ hook, query, scope = {}, explicitChannels = null, tier = null, expandFn = null, judge = null, budgetBytes = null, stageFingerprints = null, executors = null, channelWeights = null, tombstoneEval = null, authorizedGlobals = null, allowUnevaluatedTombstones = false } = {}) {
  if (!shouldRun()) {
    return { ok: false, code: "FLAG_DISABLED", hook, note: "memoryOrchestra planner+fusion flags are off; legacy behaviour untouched" };
  }
  const ex = executors ?? {};
  const stepsExec = createStepsExecutors();
  // 2026-10-24: `l23` was missing here, so the L2/L3 channels planned by the
  // hook table could only ever answer EXECUTOR_NOT_BOUND — the artifact backend
  // was live but unreachable from a hook. Bind it like the other holders.
  const exAll = { memorycore: ex.memorycore ?? stubPlan({}), repoql: ex.repoql ?? stubPlan({}), docs: ex.docs ?? stubPlan({}), temporal: ex.temporal ?? stubPlan({}), l23: ex.l23 ?? stubPlan({}), steps: stepsExec, tombstoneEval: ex.tombstoneEval ?? tombstoneEval ?? createDefaultTombstoneEval() };
  let retriev = null;
  try {
    retriev = beginRetrieval({ hook, query, scope, tier });
    const planRow = await planAndFetch({ executors: exAll, hook, query, scope, explicitChannels, tier });
    if (!planRow.ok) {
      endRetrieval(retriev, { ok: false, code: planRow.code });
      return { ok: false, code: planRow.code, hook };
    }
    const fused = fuse({ plan: planRow, scope, tombstoneEval: exAll.tombstoneEval, authorizedGlobals, allowUnevaluatedTombstones, lambda: 0.7, keptN: TIERS[planRow.tier].perChannelTop, weightsById: channelWeights ?? undefined });
    const verdict = await buildVerdict({ hook, query, scope, fused, judge, expandFn, budgetBytes: budgetBytes ?? planRow.tokenBudget * 4 });
    const packet = verdict.packet;
    if (Array.isArray(stageFingerprints) && packet.fingerprint && stageFingerprints.includes(packet.fingerprint)) {
      endRetrieval(retriev, { plan: planRow, perChannel: planRow.perChannel, ok: true, verdict, packet, msTotal: planRow.msTotal });
      return { ok: true, code: "ALREADY_INJECTED", hook, plan: planRow, verdict, packet };
    }
    endRetrieval(retriev, {
      plan: planRow,
      perChannel: planRow.perChannel,
      ok: true,
      kept: fused.candidates ?? [],
      dropped: fused.dropped ?? [],
      verdict,
      packet,
      msTotal: planRow.msTotal,
    });
    return { ok: true, hook, plan: planRow, fused, verdict, packet };
  } catch (err) {
    try {
      endRetrieval(retriev ?? "rv-orph", { ok: false, code: `HOOK_THROW:${String(err?.name ?? err).slice(0, 24)}` });
    } catch {
      /* ledger is best-effort */
    }
    const _why = `${String(err?.name ?? err).slice(0, 40)}:${String(err?.message ?? "").replace(/\s+/g, " ").slice(0, 160)}`;
    return { ok: false, code: "HOOK_THROW", detail: _why.slice(0, 200), hook };
  }
}

export { fingerprintPacket };
