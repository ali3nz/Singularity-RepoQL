// runs.mjs — the lifecycle facade. Everything a caller may do to a run goes
// through here, so the invariants live in one place:
//
//   create -> evidence -> transition -> (approve) -> accept
//                                     \-> pause / resume / stop / recover
//                                                \-> reconcile (after interrupt)
//
// Every mutation is persisted atomically under a store lock, and nothing is
// reported complete without the evidence the stage machine demands.
import path from "node:path";
import { createApproval } from "./approvals.mjs";
import { evidenceEntry, reviewedPackHash, verifyPack } from "./evidence.mjs";
import { seatPlan } from "./modes.mjs";
import {
  acceptanceCheck,
  advance,
  beginStage,
  isComplete,
  pause,
  reconcile,
  recover,
  resume,
  stop,
} from "./stage-machine.mjs";
import { hashValue, newId, openStore } from "./state.mjs";

export class RunError extends Error {
  constructor(message) {
    super(message);
    this.name = "RunError";
  }
}

function nowIso() {
  return new Date().toISOString();
}

export function caseIdFor({ task, repository = "local" }) {
  return `case-${hashValue(`${repository}\u0000${task}`).slice(0, 12)}`;
}

export function createRun(store, {
  task,
  mode = "solo",
  seats = null,
  freeOnly = false,
  revision = null,
  repository = "local",
  idFactory = () => newId("run"),
}) {
  if (!task || !String(task).trim()) throw new RunError("a run needs a task description");
  const plan = seatPlan(mode, { customSeats: seats, freeOnly });
  const caseId = caseIdFor({ task, repository });

  return store.lock("runs", () => {
    const registry = store.readRegistry();
    const run = {
      id: idFactory(),
      caseId,
      task: String(task),
      repository,
      revision,
      mode: plan.mode,
      providerPolicy: plan.providerPolicy,
      seats: plan.seats,
      stage: "plan",
      status: "running",
      cycle: 1,
      attempts: {},
      evidence: [],
      approvals: [],
      reviews: [],
      inflight: null,
      interrupted: null,
      createdAt: nowIso(),
      updatedAt: nowIso(),
      history: [
        {
          at: nowIso(),
          from: null,
          to: "plan",
          actor: "operator",
          role: "operator",
          reason: "run created",
          evidence: [],
          idempotencyKey: `${caseId}:create`,
        },
      ],
    };
    registry.cases[caseId] = registry.cases[caseId] ?? { id: caseId, task: run.task, repository, createdAt: run.createdAt };
    registry.runs = registry.runs.concat([
      { id: run.id, caseId, mode: run.mode, stage: run.stage, status: run.status, createdAt: run.createdAt, updatedAt: run.updatedAt },
    ]);
    store.writeRun(run);
    store.writeRegistry(registry);
    return run;
  });
}

function mutate(store, runId, fn) {
  return store.lock("runs", () => {
    const run = store.readRun(runId);
    if (!run) throw new RunError(`no such run: ${runId}`);
    const result = fn(run);
    if (!result?.run) throw new RunError("internal: mutation produced no run");
    // A refused mutation must leave persisted state untouched. This is also what
    // makes `accept()` atomic across its two transitions: a failure on the last
    // step writes neither step.
    if (result.ok === false) return result;
    const next = { ...result.run, updatedAt: nowIso() };
    store.writeRun(next);
    const registry = store.readRegistry();
    registry.runs = registry.runs.map((r) =>
      r.id === next.id ? { ...r, stage: next.stage, status: next.status, updatedAt: next.updatedAt } : r,
    );
    store.writeRegistry(registry);
    return { ...result, run: next };
  });
}

/**
 * Record evidence. Entries are stamped with the stage and cycle they belong to,
 * so a later correction cycle cannot reuse the previous cycle's proof.
 */
export function addEvidence(store, runId, entries) {
  if (!Array.isArray(entries) || entries.length === 0) throw new RunError("addEvidence needs at least one entry");
  return mutate(store, runId, (run) => {
    if (run.status === "accepted" || run.status === "failed") {
      throw new RunError(`run is ${run.status}; evidence can no longer be added`);
    }
    const cycle = run.cycle ?? 1;
    const stamped = entries.map((entry) => ({ ...entry, stage: run.stage, cycle }));
    return { ok: true, run: { ...run, evidence: (run.evidence ?? []).concat(stamped) } };
  }).run;
}

export function begin(store, runId, { actor = "coordinator", note = "", owner = newId("owner") } = {}) {
  return mutate(store, runId, (run) => {
    const outcome = beginStage(run, { actor, note, owner });
    if (!outcome.ok) throw new RunError(outcome.reason);
    return { ok: true, run: outcome.run };
  }).run;
}

export function reconcileRun(store, runId, options) {
  return mutate(store, runId, (run) => {
    const outcome = reconcile(run, options);
    if (!outcome.ok) throw new RunError(outcome.reason);
    return { ok: true, run: outcome.run, reason: outcome.reason };
  });
}

export function transition(store, runId, options) {
  return mutate(store, runId, (run) => {
    const outcome = advance(run, options);
    return { ...outcome, run: outcome.run };
  });
}

/** Resolve the seat an approval claims to come from, or refuse the identity. */
function approvalSeat(run, approver, claimedRole) {
  if (approver === "operator") {
    if (claimedRole && claimedRole !== "operator") {
      throw new RunError(`'operator' approves as operator, not ${claimedRole}`);
    }
    return { id: "operator", role: "operator" };
  }
  const seat = (run.seats ?? []).find((s) => s.id === approver);
  if (!seat) {
    throw new RunError(
      `'${approver}' is not a seat in this run; an approval must name a declared reviewer or operator seat (${(run.seats ?? []).map((s) => `${s.id}:${s.role}`).join(", ")})`,
    );
  }
  if (seat.role !== "reviewer" && seat.role !== "operator") {
    throw new RunError(`'${approver}' holds the ${seat.role} seat and may not approve`);
  }
  if (claimedRole && claimedRole !== seat.role) {
    throw new RunError(`'${approver}' holds the ${seat.role} seat, not ${claimedRole}`);
  }
  return { id: seat.id, role: seat.role };
}

/**
 * Record an approval. The approver must be a declared reviewer or operator seat,
 * and the approval is bound to the run's own revision and evidence pack — a
 * caller cannot supply both sides of either comparison.
 */
export function approve(store, runId, { approver, role = null, ttlMs = 60 * 60 * 1000, note = "", now = () => Date.now() } = {}) {
  if (!approver) throw new RunError("approve needs --approver");
  return mutate(store, runId, (run) => {
    if (run.stage !== "accept" && run.stage !== "review") {
      throw new RunError(`approve is only meaningful at review or accept; run is at ${run.stage}`);
    }
    if (run.interrupted) throw new RunError("run is interrupted; reconcile before approving");
    const seat = approvalSeat(run, approver, role);
    const stage = "accept";
    const evidenceHash = reviewedPackHash(run.evidence);
    const revision = run.revision ?? "unrecorded";
    const coordinator = (run.seats ?? []).find((s) => s.role === "coordinator");
    const implementers = (run.seats ?? []).filter((s) => s.canImplement).map((s) => s.id);
    if (seat.id === coordinator?.id) throw new RunError("the coordinator cannot approve its own run");
    if (implementers.includes(seat.id)) throw new RunError(`'${seat.id}' implemented this work and cannot approve it`);

    const approval = createApproval({
      approver: seat.id,
      role: seat.role,
      runId: run.id,
      stage,
      evidenceHash,
      revision,
      ttlMs,
      now,
      note,
    });
    const approvalEvidence = evidenceEntry({
      kind: "approval",
      producer: seat.id,
      content: JSON.stringify({
        approver: approval.approver,
        role: approval.role,
        stage,
        evidenceHash,
        revision,
        issuedAt: approval.issuedAt,
        expiresAt: approval.expiresAt,
      }),
      revision,
      meta: { evidenceHash, approver: approval.approver, role: approval.role },
    });
    return {
      ok: true,
      run: {
        ...run,
        approvals: (run.approvals ?? []).concat([approval]),
        evidence: (run.evidence ?? []).concat([
          { ...approvalEvidence, stage, cycle: run.cycle ?? 1 },
        ]),
      },
    };
  }).run;
}

/**
 * Advance review -> accept -> done. The authoritative checks live in
 * `advance()`: this only adds a clearer error and an evidence-integrity check
 * before the transition is attempted.
 */
export function accept(store, runId, { approver, actor = "coordinator", now = () => Date.now() } = {}) {
  if (!approver) throw new RunError("accept needs --approver");
  return mutate(store, runId, (run) => {
    const seat = approvalSeat(run, approver, null);
    const stored = (run.approvals ?? []).slice().reverse().find((a) => a.approver === seat.id);
    if (!stored) return { ok: false, run, reason: `no approval recorded by '${seat.id}'` };

    // The authoritative checks (verdict, approval scope, evidence integrity,
    // expiry) happen inside advance(). This pre-check only produces a clearer
    // error; it is not the gate.
    const gate = acceptanceCheck(run, { now });
    if (!gate.ok && run.stage === "review") {
      return { ok: false, run, reason: `acceptance refused: ${gate.reasons.join("; ")}` };
    }

    let step = { ok: true, run };
    if (run.stage === "review") {
      step = advance(run, { to: "accept", actor, role: "reviewer", evidence: [], now });
      if (!step.ok) return step;
    }
    step = advance(step.run, { to: "done", actor, role: "coordinator", evidence: [], now });
    return step;
  });
}

export function pauseRun(store, runId, options) {
  return mutate(store, runId, (run) => pause(run, options));
}

export function resumeRun(store, runId, options) {
  return mutate(store, runId, (run) => resume(run, options));
}

export function stopRun(store, runId, options) {
  return mutate(store, runId, (run) => stop(run, options));
}

export function recoverRun(store, runId, options) {
  return mutate(store, runId, (run) => recover(run, options));
}

export function getRun(store, runId) {
  const run = store.readRun(runId);
  if (!run) throw new RunError(`no such run: ${runId}`);
  return run;
}

export function latestRun(store) {
  const [entry] = store.listRuns();
  if (!entry) return null;
  return store.readRun(entry.id);
}

/**
 * Health classification for supervision. A run is STUCK when it is claimed
 * running with no progress inside the window; that is not the same as FAILED,
 * and it is never reported as complete. Accepted evidence that no longer
 * verifies is reported as INVALID_EVIDENCE, not COMPLETE.
 */
export function health(run, { now = Date.now(), stuckAfterMs = 30 * 60 * 1000 } = {}) {
  if (!run) return { state: "NONE", detail: "no runs recorded" };
  if (run.stage === "done" && run.status === "accepted") {
    const verification = verifyPack(run.evidence ?? []);
    if (!verification.ok) {
      return { state: "INVALID_EVIDENCE", detail: `accepted evidence does not verify: ${verification.problems.join("; ")}` };
    }
    const gate = acceptanceCheck(run, { now: () => now, enforceExpiry: false });
    if (!gate.ok) return { state: "INVALID_EVIDENCE", detail: `acceptance does not hold: ${gate.reasons.join("; ")}` };
    return { state: "COMPLETE", detail: "accepted with required evidence" };
  }
  if (run.status === "failed") return { state: "FAILED", detail: run.stopped?.reason ?? "stopped" };
  if (run.interrupted) {
    return { state: "BLOCKED", detail: `interrupted during ${run.interrupted.stage}; reconciliation required` };
  }
  if (run.status === "blocked") return { state: "BLOCKED", detail: "retry budget exhausted or awaiting reconciliation" };
  if (run.status === "paused") return { state: "PAUSED", detail: "paused by operator" };
  const last = Date.parse(run.updatedAt ?? run.createdAt ?? 0);
  if (now - last > stuckAfterMs) return { state: "STUCK", detail: `no progress for ${Math.round((now - last) / 1000)}s in stage ${run.stage}` };
  return { state: "RUNNING", detail: `stage ${run.stage}` };
}

export function openRunStore(dir) {
  return openStore(dir);
}

export function defaultStoreDir() {
  return process.env.ORCH_STATE_DIR ?? path.join(process.cwd(), ".orch");
}
