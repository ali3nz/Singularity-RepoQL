// stage-machine.mjs — the explicit workflow of an orchestrated run.
//
// The contract this file enforces:
//   * A stage is COMPLETED only by a transition that cites evidence produced IN
//     that stage, during its current cycle.
//   * A stage that was in flight when its process died is INTERRUPTED, never
//     completed. Recovery requires an explicit reconciliation, not a guess.
//   * Acceptance is authorised by a stored approval artifact bound to the exact
//     evidence pack and source revision — never by an evidence entry that merely
//     claims to be one, and never by a verdict the caller asserts.
//   * Retries are bounded per stage; exceeding the bound blocks the run instead
//     of looping.
//   * A transition is idempotent: replaying the same stage change (same
//     idempotency key) does not append a second history entry.
import { validateApproval } from "./approvals.mjs";
import { reviewedPackHash, verifyPack } from "./evidence.mjs";

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
 * Allowed transitions.
 *
 * `needs` lists the evidence each transition requires, as
 * `{ kind, stages }`: the kind must have been captured in one of those stages,
 * in the run's current cycle. The stage check matters — a `test-output` entry
 * captured while the run was implementing must not serve as validation proof.
 *
 * `role` is the authority required for the transition.
 */
export const TRANSITIONS = Object.freeze([
  { from: "plan", to: "implement", needs: [{ kind: "plan", stages: ["plan"] }], role: "coordinator" },
  { from: "implement", to: "validate", needs: [{ kind: "diff", stages: ["implement", "correct"] }], role: "coordinator" },
  { from: "implement", to: "failed", needs: [], role: "coordinator" },
  { from: "validate", to: "review", needs: [{ kind: "test-output", stages: ["validate"] }], role: "coordinator" },
  { from: "validate", to: "correct", needs: [{ kind: "test-output", stages: ["validate"] }], role: "coordinator" },
  { from: "review", to: "accept", needs: [{ kind: "review-verdict", stages: ["review"] }], role: "reviewer" },
  { from: "review", to: "correct", needs: [{ kind: "review-verdict", stages: ["review"] }], role: "reviewer" },
  { from: "correct", to: "implement", needs: [{ kind: "diff", stages: ["correct"] }], role: "coordinator" },
  { from: "correct", to: "failed", needs: [], role: "coordinator" },
  {
    from: "accept",
    to: "done",
    needs: [
      { kind: "review-verdict", stages: ["review"] },
      { kind: "approval", stages: ["accept"] },
    ],
    role: "coordinator",
  },
]);

export const DEFAULT_LIMITS = Object.freeze({ maxAttemptsPerStage: 3, maxCorrections: 2 });

export function transitionFor(from, to) {
  return TRANSITIONS.find((t) => t.from === from && t.to === to) ?? null;
}

export function evidenceKinds(entries) {
  return [...new Set((entries ?? []).map((e) => e.kind))];
}

/**
 * Requirements still missing for `cycle`. An entry only counts when its kind
 * matches AND it was captured in one of the stages that may produce it: an
 * earlier cycle's proof, or a same-named artifact captured somewhere else, is
 * not evidence for this transition.
 */
export function missingKinds(needs, entries, cycle = 1) {
  const usable = (entries ?? []).filter((e) => (e.cycle ?? 1) === cycle);
  const missing = [];
  for (const need of needs) {
    const spec = typeof need === "string" ? { kind: need, stages: null } : need;
    const found = usable.some(
      (entry) => entry.kind === spec.kind && (!spec.stages || spec.stages.includes(entry.stage)),
    );
    if (!found) {
      missing.push(spec.stages ? `${spec.kind} (from ${spec.stages.join("|")})` : spec.kind);
    }
  }
  return missing;
}

/** The most recent review verdict recorded in a cycle, or null. */
export function latestVerdict(entries, cycle, stages = ["review"]) {
  const verdicts = (entries ?? []).filter(
    (e) => e.kind === "review-verdict" && (e.cycle ?? 1) === cycle && stages.includes(e.stage),
  );
  return verdicts.length ? verdicts[verdicts.length - 1] : null;
}

function appendHistory(run, entry) {
  const history = Array.isArray(run.history) ? run.history : [];
  return history.concat([{ at: new Date().toISOString(), ...entry }]);
}

/**
 * The authoritative acceptance gate. `run.approvals` is the only source of
 * acceptance authority: an evidence entry of kind `approval` is a record, not a
 * grant, so a caller cannot mint authority by appending one. The verdict is the
 * most recently recorded review decision — a caller cannot assert one.
 *
 * `enforceExpiry` is true while acceptance is happening and false when the
 * question is historical: approval expiry is a condition of accepting, not a
 * property that later un-accepts a completed run.
 */
export function acceptanceCheck(run, { now = () => Date.now(), enforceExpiry = true } = {}) {
  const reasons = [];
  const cycle = run.cycle ?? 1;
  const pack = reviewedPackHash(run.evidence ?? []);
  const revision = run.revision ?? "unrecorded";
  const coordinator = (run.seats ?? []).find((s) => s.role === "coordinator");
  const implementers = (run.seats ?? []).filter((s) => s.canImplement).map((s) => s.id);

  const verdict = latestVerdict(run.evidence, cycle);
  if (!verdict) {
    reasons.push(`no review verdict recorded in cycle ${cycle}`);
  } else if (!["approve", "approved"].includes(verdict.meta?.verdict)) {
    reasons.push(`latest review verdict in cycle ${cycle} is '${verdict.meta?.verdict ?? "none"}', not approve`);
  }

  const verification = verifyPack(run.evidence ?? []);
  if (!verification.ok) reasons.push(`evidence no longer verifies: ${verification.problems.join("; ")}`);

  const approvals = run.approvals ?? [];
  if (!approvals.length) {
    reasons.push("no approval recorded for this run");
  } else {
    const checks = approvals.map((approval) => ({
      approval,
      result: validateApproval(approval, {
        runId: run.id,
        stage: "accept",
        evidenceHash: pack,
        revision,
        now,
        enforceExpiry,
        implementerIds: implementers,
        coordinatorId: coordinator?.id ?? null,
      }),
    }));
    if (!checks.some((c) => c.result.ok)) {
      const detail = checks.map((c) => `${c.approval.approver}: ${c.result.reasons.join(", ")}`).join(" | ");
      reasons.push(`no approval covers the current evidence pack and revision (${detail})`);
    }
  }
  return { ok: reasons.length === 0, reasons, pack, revision };
}

/**
 * Attempt a stage transition. Returns `{ ok, run, reason, applied }`.
 * A refused transition never mutates the input run.
 */
export function advance(run, {
  to,
  actor,
  role,
  evidence = [],
  reason = "",
  idempotencyKey = null,
  limits = DEFAULT_LIMITS,
  now = () => Date.now(),
  owner = null,
} = {}) {
  if (!to) return { ok: false, run, reason: "transition target is required" };
  if (run.status === "accepted" || run.stage === "done") {
    return { ok: false, run, reason: "run is already accepted" };
  }
  if (run.status === "failed") return { ok: false, run, reason: "run is failed; a new run is required" };
  if (run.interrupted) {
    return {
      ok: false,
      run,
      reason: `run was interrupted during ${run.interrupted.stage} and is not reconciled; reconcile before advancing`,
    };
  }
  if (run.status === "paused") return { ok: false, run, reason: "run is paused; resume before advancing" };
  if (run.status === "blocked") return { ok: false, run, reason: "run is blocked; reconcile or resume before advancing" };
  if (run.inflight && run.inflight.owner !== owner) {
    return {
      ok: false,
      run,
      reason: `stage ${run.inflight.stage} is in flight for owner ${run.inflight.owner ?? "unknown"}; pass --owner with that token (or recover the run)`,
    };
  }

  const rule = transitionFor(run.stage, to);
  if (!rule) return { ok: false, run, reason: `illegal transition ${run.stage} -> ${to}` };
  if (rule.role === "reviewer" && role !== "reviewer" && role !== "operator") {
    return { ok: false, run, reason: `transition ${run.stage} -> ${to} requires reviewer authority, not ${role ?? "none"}` };
  }
  if (rule.role === "coordinator" && !["coordinator", "operator"].includes(role)) {
    return { ok: false, run, reason: `transition ${run.stage} -> ${to} requires coordinator authority, not ${role ?? "none"}` };
  }

  // A stage that may repeat gets one key per attempt, so a genuine retry is a
  // new transition while a duplicate of the SAME attempt stays a no-op.
  const attemptNo = (run.attempts?.[to] ?? 0) + 1;
  const key = idempotencyKey ?? `${run.id}:${run.stage}->${to}:${attemptNo}`;
  const already = (run.history ?? []).some((h) => h.idempotencyKey === key);
  if (already) return { ok: true, run, applied: false, reason: "transition already applied" };

  const cycle = run.cycle ?? 1;
  const stamped = evidence.map((entry) => ({ ...entry, stage: run.stage, cycle }));
  const combined = (run.evidence ?? []).concat(stamped);
  const missing = missingKinds(rule.needs, combined, cycle);
  if (missing.length) {
    return { ok: false, run, reason: `missing evidence for ${run.stage} -> ${to} in cycle ${cycle}: ${missing.join(", ")}` };
  }

  if (to === "accept") {
    const verdict = latestVerdict(combined, cycle);
    if (!verdict || !["approve", "approved"].includes(verdict.meta?.verdict)) {
      return {
        ok: false,
        run,
        reason: `accept requires a recorded approving review verdict, saw ${verdict?.meta?.verdict ?? "none"}`,
      };
    }
  }

  if (to === "done") {
    const gate = acceptanceCheck({ ...run, evidence: combined }, { now, enforceExpiry: true });
    if (!gate.ok) {
      return { ok: false, run, reason: `acceptance refused: ${gate.reasons.join("; ")}` };
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
    status: to === "done" ? "accepted" : "running",
    cycle: to === "correct" ? cycle + 1 : cycle,
    attempts,
    evidence: combined,
    updatedAt: new Date().toISOString(),
    inflight: null,
  };
  if (to === "done") next.acceptedAt = new Date().toISOString();
  next.history = appendHistory(run, {
    from: run.stage,
    to,
    actor: actor ?? "unknown",
    role: role ?? "unknown",
    reason,
    evidence: stamped.map((e) => e.sha256),
    idempotencyKey: key,
  });
  return { ok: true, run: next, applied: true, reason: "" };
}

/**
 * Mark a stage as in flight, recording the owner token that may complete it.
 *
 * The owner is a token, not a pid, because each CLI invocation is a new process:
 * `begin` prints the token and `advance --owner <token>` presents it. A second
 * `begin` on the same run is refused rather than replacing the current owner.
 */
export function beginStage(run, { actor = "coordinator", note = "", owner = null, now = new Date().toISOString() } = {}) {
  if (run.status !== "running") return { ok: false, run, reason: `cannot begin a stage while the run is ${run.status}` };
  if (run.interrupted) return { ok: false, run, reason: "run has an unresolved interruption; reconcile before beginning work" };
  if (run.inflight) {
    return { ok: false, run, reason: `stage ${run.inflight.stage} is already in flight for owner ${run.inflight.owner ?? "unknown"}` };
  }
  if (!owner) return { ok: false, run, reason: "begin needs an owner token" };
  return {
    ok: true,
    run: {
      ...run,
      inflight: { stage: run.stage, startedAt: now, actor, note, owner },
      updatedAt: now,
    },
    reason: "",
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
    interrupted: { stage, at: now, startedAt: run.inflight.startedAt, owner: run.inflight.owner ?? null },
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

/**
 * Clear an interruption after a human decided what actually happened. This
 * changes no stage: the next transition still needs that stage's evidence, so
 * reconciliation cannot launder an unknown result into a completion.
 */
export function reconcile(run, { actor = "operator", note = "", now = new Date().toISOString() } = {}) {
  if (!run.interrupted) return { ok: false, run, reason: "run is not interrupted" };
  if (run.status === "accepted" || run.status === "failed") return { ok: false, run, reason: "run is terminal" };
  const stage = run.interrupted.stage;
  const next = {
    ...run,
    status: "running",
    interrupted: null,
    reconciled: { stage, at: now, actor, note },
    updatedAt: now,
  };
  next.history = appendHistory(run, {
    from: stage,
    to: stage,
    actor,
    role: "operator",
    reason: `reconciled interruption during ${stage}: ${note || "no note"}; stage still requires its evidence`,
    idempotencyKey: `${run.id}:reconcile:${run.interrupted.at}`,
  });
  return { ok: true, run: next, reason: "" };
}

export function pause(run, { actor = "operator", reason = "" } = {}) {
  if (run.status === "accepted" || run.status === "failed") return { ok: false, run, reason: "run is terminal" };
  return { ok: true, run: { ...run, status: "paused", updatedAt: new Date().toISOString(), history: appendHistory(run, { from: run.stage, to: run.stage, actor, role: "operator", reason: `paused: ${reason}`, idempotencyKey: `${run.id}:pause:${run.updatedAt}` }) } };
}

export function resume(run, { actor = "operator", reason = "" } = {}) {
  if (run.interrupted) {
    return { ok: false, run, reason: `run was interrupted during ${run.interrupted.stage}; reconcile before resuming` };
  }
  if (run.status !== "paused" && run.status !== "blocked") {
    return { ok: false, run, reason: `cannot resume from ${run.status}` };
  }
  return {
    ok: true,
    run: { ...run, status: "running", updatedAt: new Date().toISOString(), history: appendHistory(run, { from: run.stage, to: run.stage, actor, role: "operator", reason: `resumed: ${reason}`, idempotencyKey: `${run.id}:resume:${Date.now()}` }) },
  };
}

export function stop(run, { actor = "operator", reason = "" } = {}) {
  if (run.status === "accepted") return { ok: false, run, reason: "run is already accepted" };
  return {
    ok: true,
    run: { ...run, status: "failed", stopped: { at: new Date().toISOString(), reason }, updatedAt: new Date().toISOString(), history: appendHistory(run, { from: run.stage, to: "stopped", actor, role: "operator", reason: `stopped: ${reason}`, idempotencyKey: `${run.id}:stop:${Date.now()}` }) },
  };
}

/**
 * A run is complete when it reached "done" and the acceptance that happened
 * then still holds: required kinds present, evidence still verifies, approval
 * bound to the pack and revision. Expiry is deliberately NOT re-applied — an
 * hour-old valid acceptance is still an acceptance.
 */
export function isComplete(run) {
  if (run.stage !== "done" || run.status !== "accepted") return false;
  const have = new Set(evidenceKinds(run.evidence));
  if (!STAGE_EVIDENCE.accept.every((k) => have.has(k))) return false;
  if (!verifyPack(run.evidence ?? []).ok) return false;
  return acceptanceCheck(run, { enforceExpiry: false }).ok;
}
