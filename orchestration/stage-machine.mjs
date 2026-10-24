// stage-machine.mjs — the explicit workflow of an orchestrated run.
//
// The contract this file enforces:
//   * A stage is COMPLETED only by a transition that cites verifiable evidence
//     of the kind that stage must produce.
//   * A stage that was in flight when the process died is INTERRUPTED, never
//     completed. Recovery requires reconciliation, not a guess.
//   * Retries are bounded per stage; exceeding the bound blocks the run instead
//     of looping.
//   * A transition is idempotent: replaying the same stage change (same
//     idempotency key) does not append a second history entry.

export const STAGES = Object.freeze(["plan", "implement", "validate", "review", "correct", "accept"]);
export const RUN_STATUSES = Object.freeze(["running", "paused", "blocked", "failed", "accepted"]);

/** Evidence kinds a stage must produce before the workflow may leave it. */
export const STAGE_EVIDENCE = Object.freeze({
  plan: ["plan"],
  implement: ["diff"],
  validate: ["test-output"],
  review: ["review-verdict"],
  correct: ["diff"],
  accept: ["review-verdict", "approval"],
});

/**
 * Allowed transitions. `needs` lists evidence kinds that must already exist in
 * the run. `role` is the authority required for the transition.
 */
export const TRANSITIONS = Object.freeze([
  { from: "plan", to: "implement", needs: ["plan"], role: "coordinator" },
  { from: "implement", to: "validate", needs: ["diff"], role: "coordinator" },
  { from: "implement", to: "failed", needs: [], role: "coordinator" },
  { from: "validate", to: "review", needs: ["test-output"], role: "coordinator" },
  { from: "validate", to: "correct", needs: ["test-output"], role: "coordinator" },
  { from: "review", to: "accept", needs: ["review-verdict"], role: "reviewer" },
  { from: "review", to: "correct", needs: ["review-verdict"], role: "reviewer" },
  { from: "correct", to: "implement", needs: ["diff"], role: "coordinator" },
  { from: "correct", to: "failed", needs: [], role: "coordinator" },
  { from: "accept", to: "done", needs: ["review-verdict", "approval"], role: "coordinator" },
]);

export const DEFAULT_LIMITS = Object.freeze({ maxAttemptsPerStage: 3, maxCorrections: 2 });

export function transitionFor(from, to) {
  return TRANSITIONS.find((t) => t.from === from && t.to === to) ?? null;
}

export function evidenceKinds(entries) {
  return [...new Set((entries ?? []).map((e) => e.kind))];
}

function missingKinds(needs, entries) {
  const have = new Set(evidenceKinds(entries));
  return needs.filter((k) => !have.has(k));
}

function appendHistory(run, entry) {
  const history = Array.isArray(run.history) ? run.history : [];
  return history.concat([{ at: new Date().toISOString(), ...entry }]);
}

/**
 * Attempt a stage transition. Returns `{ ok, run, reason, applied }`.
 * A refused transition never mutates the input run.
 */
export function advance(run, { to, actor, role, evidence = [], verdict = null, reason = "", idempotencyKey = null, limits = DEFAULT_LIMITS } = {}) {
  if (!to) return { ok: false, run, reason: "transition target is required" };
  if (run.status === "accepted" || run.stage === "done") {
    return { ok: false, run, reason: "run is already accepted" };
  }
  if (run.status === "failed") return { ok: false, run, reason: "run is failed; a new run is required" };

  const rule = transitionFor(run.stage, to);
  if (!rule) return { ok: false, run, reason: `illegal transition ${run.stage} -> ${to}` };
  if (rule.role === "reviewer" && role !== "reviewer" && role !== "operator") {
    return { ok: false, run, reason: `transition ${run.stage} -> ${to} requires reviewer authority, not ${role ?? "none"}` };
  }
  if (rule.role === "coordinator" && !["coordinator", "operator"].includes(role)) {
    return { ok: false, run, reason: `transition ${run.stage} -> ${to} requires coordinator authority, not ${role ?? "none"}` };
  }

  // A stage that is allowed to repeat gets one key per attempt, so a genuine
  // retry is a new transition while a duplicate of the SAME attempt stays a
  // no-op.
  const attemptNo = (run.attempts?.[to] ?? 0) + 1;
  const key = idempotencyKey ?? `${run.id}:${run.stage}->${to}:${attemptNo}`;
  const already = (run.history ?? []).some((h) => h.idempotencyKey === key);
  if (already) return { ok: true, run, applied: false, reason: "transition already applied" };

  const combined = (run.evidence ?? []).concat(evidence);
  const missing = missingKinds(rule.needs, combined);
  if (missing.length) {
    return { ok: false, run, reason: `missing evidence for ${run.stage} -> ${to}: ${missing.join(", ")}` };
  }

  if (to === "accept") {
    const verdictEntry = combined.filter((e) => e.kind === "review-verdict").pop();
    const stated = verdict ?? verdictEntry?.meta?.verdict ?? null;
    if (stated !== "approve" && stated !== "approved") {
      return { ok: false, run, reason: `accept requires an approving review verdict, saw ${stated ?? "none"}` };
    }
  }

  const attempts = { ...(run.attempts ?? {}) };
  if (to === "implement" || to === "validate" || to === "correct") {
    attempts[to] = (attempts[to] ?? 0) + 1;
    if (attempts[to] > limits.maxAttemptsPerStage) {
      return {
        ok: false,
        run: { ...run, status: "blocked" },
        reason: `${to} exceeded ${limits.maxAttemptsPerStage} attempts; run blocked for operator review`,
      };
    }
  }

  const next = {
    ...run,
    stage: to,
    status: to === "done" ? "accepted" : run.status === "paused" ? "paused" : "running",
    attempts,
    evidence: combined,
    updatedAt: new Date().toISOString(),
    inflight: null,
  };
  next.history = appendHistory(run, {
    from: run.stage,
    to,
    actor: actor ?? "unknown",
    role: role ?? "unknown",
    reason,
    evidence: evidence.map((e) => e.sha256),
    idempotencyKey: key,
  });
  return { ok: true, run: next, applied: true, reason: "" };
}

/**
 * Mark a stage as in flight. Recovery uses this to know that a death mid-stage
 * must not be read as success.
 */
export function beginStage(run, { actor = "coordinator", note = "" } = {}) {
  return {
    ...run,
    inflight: { stage: run.stage, startedAt: new Date().toISOString(), actor, note },
    updatedAt: new Date().toISOString(),
  };
}

/**
 * Recover a run whose process died. An in-flight stage becomes interrupted and
 * the run blocks for reconciliation: completed work is never assumed.
 */
export function recover(run, { now = new Date().toISOString() } = {}) {
  if (!run.inflight) {
    return { run, recovered: false, reason: "nothing was in flight" };
  }
  const stage = run.inflight.stage;
  const next = {
    ...run,
    status: "blocked",
    inflight: null,
    interrupted: { stage, at: now, startedAt: run.inflight.startedAt },
    updatedAt: now,
  };
  next.history = appendHistory(run, {
    from: stage,
    to: stage,
    actor: "recovery",
    role: "system",
    reason: `interrupted during ${stage}; reconciliation required, stage NOT completed`,
    idempotencyKey: `${run.id}:recover:${stage}:${run.inflight.startedAt}`,
  });
  return { run: next, recovered: true, reason: `interrupted during ${stage}` };
}

export function pause(run, { actor = "operator", reason = "" } = {}) {
  if (run.status === "accepted" || run.status === "failed") return { ok: false, run, reason: "run is terminal" };
  return { ok: true, run: { ...run, status: "paused", updatedAt: new Date().toISOString(), history: appendHistory(run, { from: run.stage, to: run.stage, actor, role: "operator", reason: `paused: ${reason}`, idempotencyKey: `${run.id}:pause:${run.updatedAt}` }) } };
}

export function resume(run, { actor = "operator", reason = "" } = {}) {
  if (run.status !== "paused" && run.status !== "blocked") {
    return { ok: false, run, reason: `cannot resume from ${run.status}` };
  }
  return {
    ok: true,
    run: { ...run, status: "running", reconciled: undefined, updatedAt: new Date().toISOString(), history: appendHistory(run, { from: run.stage, to: run.stage, actor, role: "operator", reason: `resumed: ${reason}`, idempotencyKey: `${run.id}:resume:${Date.now()}` }) },
  };
}

export function stop(run, { actor = "operator", reason = "" } = {}) {
  if (run.status === "accepted") return { ok: false, run, reason: "run is already accepted" };
  return {
    ok: true,
    run: { ...run, status: "failed", stopped: { at: new Date().toISOString(), reason }, updatedAt: new Date().toISOString(), history: appendHistory(run, { from: run.stage, to: "stopped", actor, role: "operator", reason: `stopped: ${reason}`, idempotencyKey: `${run.id}:stop:${Date.now()}` }) },
  };
}

/** A run is only complete when the machine reached "done" with accept evidence. */
export function isComplete(run) {
  if (run.stage !== "done" || run.status !== "accepted") return false;
  const have = new Set(evidenceKinds(run.evidence));
  return STAGE_EVIDENCE.accept.every((k) => have.has(k));
}
