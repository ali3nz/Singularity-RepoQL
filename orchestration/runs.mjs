// runs.mjs — the lifecycle facade. Everything a caller may do to a run goes
// through here, so the invariants live in one place:
//
//   create -> evidence -> transition -> (approve) -> accept
//                                     \-> pause / resume / stop / recover
//
// Every mutation is persisted atomically under a store lock, and nothing is
// reported complete without the evidence the stage machine demands.
import path from "node:path";
import { createApproval, validateApproval } from "./approvals.mjs";
import { evidenceEntry, packHash, verifyPack } from "./evidence.mjs";
import { seatPlan } from "./modes.mjs";
import { advance, beginStage, isComplete, pause, recover, resume, stop } from "./stage-machine.mjs";
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

/**
 * The reviewed pack excludes approval entries themselves. Otherwise recording an
 * approval would change the hash it was bound to, and no approval could ever
 * validate against its own evidence.
 */
function reviewedPackHash(entries) {
  return packHash((entries ?? []).filter((e) => e.kind !== "approval"));
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
      attempts: {},
      evidence: [],
      approvals: [],
      reviews: [],
      inflight: null,
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

export function addEvidence(store, runId, entries) {
  if (!Array.isArray(entries) || entries.length === 0) throw new RunError("addEvidence needs at least one entry");
  return mutate(store, runId, (run) => ({
    ok: true,
    run: { ...run, evidence: (run.evidence ?? []).concat(entries) },
  })).run;
}

export function begin(store, runId, { actor = "coordinator", note = "" } = {}) {
  return mutate(store, runId, (run) => ({ ok: true, run: beginStage(run, { actor, note }) })).run;
}

export function transition(store, runId, options) {
  return mutate(store, runId, (run) => {
    const outcome = advance(run, options);
    return { ...outcome, run: outcome.run };
  });
}

/**
 * Record an approval. The approver must name the evidence pack hash it reviewed,
 * so approval of one pack cannot authorise a different one.
 */
export function approve(store, runId, { approver, role = "reviewer", revision = null, ttlMs = 60 * 60 * 1000, note = "", now = () => Date.now() } = {}) {
  return mutate(store, runId, (run) => {
    const stage = "accept";
    const evidenceHash = reviewedPackHash(run.evidence);
    const coord = (run.seats ?? []).find((s) => s.role === "coordinator");
    const implementers = (run.seats ?? []).filter((s) => s.canImplement).map((s) => s.id);
    const approval = createApproval({
      approver,
      role,
      runId: run.id,
      stage,
      evidenceHash,
      revision: revision ?? run.revision ?? "unrecorded",
      ttlMs,
      now,
      note,
    });
    const check = validateApproval(approval, {
      runId: run.id,
      stage,
      evidenceHash,
      revision: revision ?? run.revision ?? "unrecorded",
      now,
      implementerIds: implementers,
      coordinatorId: coord?.id ?? null,
    });
    if (!check.ok) throw new RunError(`approval refused: ${check.reasons.join("; ")}`);
    const approvalEvidence = evidenceEntry({
      kind: "approval",
      producer: approver,
      content: JSON.stringify({ approver: approval.approver, role: approval.role, stage, evidenceHash, revision: approval.revision, issuedAt: approval.issuedAt }),
      revision: approval.revision,
      meta: { evidenceHash, approver: approval.approver, role: approval.role },
    });
    return {
      ok: true,
      run: {
        ...run,
        approvals: (run.approvals ?? []).concat([approval]),
        evidence: (run.evidence ?? []).concat([approvalEvidence]),
      },
    };
  }).run;
}

/** Advance review -> accept -> done, requiring a valid approval and verdict. */
export function accept(store, runId, { approver, actor = "coordinator", revision = null, now = () => Date.now() } = {}) {
  return mutate(store, runId, (run) => {
    const evidenceHash = reviewedPackHash(run.evidence);
    const revisionUsed = revision ?? run.revision ?? "unrecorded";
    const coord = (run.seats ?? []).find((s) => s.role === "coordinator");
    const implementers = (run.seats ?? []).filter((s) => s.canImplement).map((s) => s.id);

    const stored = (run.approvals ?? []).slice().reverse().find((a) => a.approver === approver);
    if (!stored) return { ok: false, run, reason: `no approval recorded by '${approver}'` };
    const check = validateApproval(stored, {
      runId: run.id,
      stage: "accept",
      evidenceHash,
      revision: revisionUsed,
      now,
      implementerIds: implementers,
      coordinatorId: coord?.id ?? null,
    });
    if (!check.ok) return { ok: false, run, reason: `approval invalid: ${check.reasons.join("; ")}` };

    const verification = verifyPack(run.evidence ?? []);
    if (!verification.ok) {
      return { ok: false, run, reason: `evidence no longer verifies: ${verification.problems.join("; ")}` };
    }

    let step = advance(run, { to: "accept", actor, role: "reviewer", evidence: [], verdict: "approve" });
    if (!step.ok) return step;
    step = advance(step.run, { to: "done", actor, role: "coordinator", evidence: [] });
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
 * and it is never reported as complete.
 */
export function health(run, { now = Date.now(), stuckAfterMs = 30 * 60 * 1000 } = {}) {
  if (!run) return { state: "NONE", detail: "no runs recorded" };
  if (isComplete(run)) return { state: "COMPLETE", detail: "accepted with required evidence" };
  if (run.status === "failed") return { state: "FAILED", detail: run.stopped?.reason ?? "stopped" };
  if (run.status === "blocked") return { state: "BLOCKED", detail: run.interrupted ? `interrupted during ${run.interrupted.stage}` : "awaiting reconciliation" };
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
