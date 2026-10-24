// workflow.test.mjs — durable state, stage transitions, recovery and the run
// lifecycle. No model calls: every case is deterministic and local.
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { evidenceEntry, evidenceFromFile, verifyPack } from "./evidence.mjs";
import { STAGES, acceptanceCheck, advance, beginStage, isComplete, recover, reconcile } from "./stage-machine.mjs";
import { StateCorruptError, acquireLock, openStore, readJson, writeJsonAtomic } from "./state.mjs";
import {
  accept,
  addEvidence,
  approve,
  begin,
  createRun,
  getRun,
  health,
  openRunStore,
  recoverRun,
  reconcileRun,
  resumeRun,
  transition,
} from "./runs.mjs";

function tmp() {
  return fs.mkdtempSync(path.join(os.tmpdir(), "orch-test-"));
}

const PLAN = () => evidenceEntry({ kind: "plan", producer: "coordinator", content: "plan: do the thing" });
const DIFF = () => evidenceEntry({ kind: "diff", producer: "worker-1", content: "diff --git a/x b/x" });
const TEST = () => evidenceEntry({ kind: "test-output", producer: "worker-1", content: "ok 1 - everything" });
const VERDICT = (verdict = "approve") =>
  evidenceEntry({ kind: "review-verdict", producer: "reviewer-1", content: `verdict: ${verdict}`, meta: { verdict } });

/** Evidence as the run would hold it after addEvidence: stamped with stage+cycle. */
const at = (entry, stage, cycle = 1) => ({ ...entry, stage, cycle });

const reviewerSeat = (run) => run.seats.find((s) => s.role === "reviewer").id;
const coordinatorSeat = (run) => run.seats.find((s) => s.role === "coordinator").id;

/** Walk a fresh store run from plan to review, adding each stage's evidence. */
function walkToReview(store, id, extra = []) {
  addEvidence(store, id, [PLAN()]);
  assert.equal(transition(store, id, { to: "implement", role: "coordinator" }).ok, true);
  addEvidence(store, id, [DIFF()]);
  assert.equal(transition(store, id, { to: "validate", role: "coordinator" }).ok, true);
  addEvidence(store, id, [TEST(), ...extra]);
  assert.equal(transition(store, id, { to: "review", role: "coordinator" }).ok, true);
  addEvidence(store, id, [VERDICT("approve")]);
}

test("a missing state file is a cold start; a corrupt one is fatal and preserved", () => {
  const dir = tmp();
  const file = path.join(dir, "state.json");
  assert.equal(readJson(file), null, "missing file must read as cold start");

  fs.writeFileSync(file, '{"nextId": 1, "agents": {');
  const before = fs.readFileSync(file);
  assert.throws(() => readJson(file), StateCorruptError);
  assert.deepEqual(fs.readFileSync(file), before, "corrupt bytes must never be rewritten");

  fs.writeFileSync(file, "[]");
  assert.throws(() => readJson(file), StateCorruptError, "a JSON array is not a state object");
});

test("writes are atomic and leave no temp files behind", () => {
  const dir = tmp();
  const file = path.join(dir, "run.json");
  writeJsonAtomic(file, { id: "r1", stage: "plan" });
  writeJsonAtomic(file, { id: "r1", stage: "implement" });
  assert.deepEqual(readJson(file), { id: "r1", stage: "implement" });
  assert.deepEqual(fs.readdirSync(dir).filter((n) => n.endsWith(".tmp")), [], "no temp file may survive a write");
});

test("the store lock excludes a second holder and releases", () => {
  const dir = tmp();
  const release = acquireLock(path.join(dir, "x.lock"), { timeoutMs: 2000 });
  assert.throws(() => acquireLock(path.join(dir, "x.lock"), { timeoutMs: 150 }), /not released within/);
  release();
  acquireLock(path.join(dir, "x.lock"), { timeoutMs: 500 })();
});

test("stage transitions require the evidence the stage must produce", () => {
  const run = { id: "r1", stage: "plan", status: "running", cycle: 1, evidence: [], attempts: {}, history: [] };
  const refused = advance(run, { to: "implement", role: "coordinator", actor: "c1" });
  assert.equal(refused.ok, false);
  assert.match(refused.reason, /missing evidence.*plan/);

  const ok = advance(run, { to: "implement", role: "coordinator", actor: "c1", evidence: [PLAN()] });
  assert.equal(ok.ok, true);
  assert.equal(ok.run.stage, "implement");
  assert.equal(ok.run.history.length, 1);
  assert.equal(ok.run.evidence[0].stage, "plan", "evidence must be stamped with the stage it proves");
});

test("illegal transitions and wrong authority are refused", () => {
  const base = { id: "r1", status: "running", cycle: 1, attempts: {}, history: [] };
  const plan = { ...base, stage: "plan", evidence: [at(PLAN(), "plan")] };
  assert.equal(advance(plan, { to: "accept", role: "reviewer" }).ok, false, "plan -> accept must not exist");

  const reviewable = {
    ...base,
    stage: "review",
    evidence: [at(PLAN(), "plan"), at(DIFF(), "implement"), at(TEST(), "validate"), at(VERDICT(), "review")],
  };
  const asWorker = advance(reviewable, { to: "accept", role: "worker" });
  assert.equal(asWorker.ok, false);
  assert.match(asWorker.reason, /requires reviewer authority/);
});

test("accept requires an approving verdict, not just a verdict entry", () => {
  const base = {
    id: "r1",
    stage: "review",
    status: "running",
    cycle: 1,
    evidence: [at(PLAN(), "plan"), at(DIFF(), "implement"), at(TEST(), "validate")],
    attempts: {},
    history: [],
  };
  const refused = advance(
    { ...base, evidence: base.evidence.concat([at(VERDICT("changes_requested"), "review")]) },
    { to: "accept", role: "reviewer" },
  );
  assert.equal(refused.ok, false);
  assert.match(refused.reason, /approving review verdict/);

  const approved = advance(
    { ...base, evidence: base.evidence.concat([at(VERDICT("approve"), "review")]) },
    { to: "accept", role: "reviewer" },
  );
  assert.equal(approved.ok, true);
  assert.equal(approved.run.cycle, 1, "accepting does not start a new cycle");
});

test("a caller cannot assert a verdict the reviewer did not give", () => {
  // `verdict` was an option on advance() in rc9, which let the coordinator
  // override a recorded changes_requested. Authority is the recorded entry.
  const run = {
    id: "r1",
    stage: "review",
    status: "running",
    cycle: 1,
    seats: [{ id: "rev1", role: "reviewer", canImplement: false }],
    evidence: [at(PLAN(), "plan"), at(DIFF(), "implement"), at(TEST(), "validate"), at(VERDICT("changes_requested"), "review")],
    attempts: {},
    history: [],
  };
  const attempt = advance(run, { to: "accept", role: "reviewer", verdict: "approve" });
  assert.equal(attempt.ok, false);
  assert.match(attempt.reason, /changes_requested/);
});

test("done cannot be reached by an evidence entry that merely claims to be an approval", () => {
  const forged = evidenceEntry({
    kind: "approval",
    producer: "coordinator",
    content: JSON.stringify({ approver: "coordinator", stage: "accept" }),
    meta: { approver: "coordinator" },
  });
  const run = {
    id: "r1",
    stage: "accept",
    status: "running",
    cycle: 1,
    revision: "rev-a",
    seats: [
      { id: "c1", role: "coordinator", canImplement: false },
      { id: "w1", role: "worker", canImplement: true },
      { id: "rev1", role: "reviewer", canImplement: false },
    ],
    evidence: [at(VERDICT("approve"), "review"), at(forged, "accept")],
    approvals: [],
    attempts: {},
    history: [],
  };
  const refused = advance(run, { to: "done", role: "coordinator" });
  assert.equal(refused.ok, false);
  assert.match(refused.reason, /acceptance refused.*no approval recorded/);
});

test("a transition replayed with the same key is a no-op, not a second history entry", () => {
  const run = { id: "r1", stage: "plan", status: "running", cycle: 1, evidence: [], attempts: {}, history: [] };
  const first = advance(run, { to: "implement", role: "coordinator", evidence: [PLAN()], idempotencyKey: "k1" });
  assert.equal(first.applied, true);

  const replay = advance(first.run, { to: "validate", role: "coordinator", evidence: [DIFF()], idempotencyKey: "k1" });
  assert.equal(replay.applied, false, "same key must not apply twice");
  assert.equal(replay.run.stage, "implement", "state must be unchanged on replay");
});

test("retries are bounded per stage and exceeding the bound blocks the run", () => {
  let run = { id: "r1", stage: "implement", status: "running", cycle: 1, evidence: [at(DIFF(), "implement")], attempts: {}, history: [] };
  for (let i = 0; i < 3; i += 1) {
    const r = advance(run, { to: "validate", role: "coordinator" });
    assert.equal(r.ok, true, `attempt ${i + 1} should be allowed`);
    run = { ...r.run, stage: "implement" };
  }
  const blocked = advance(run, { to: "validate", role: "coordinator" });
  assert.equal(blocked.ok, false);
  assert.equal(blocked.run.status, "blocked");
  assert.match(blocked.reason, /exceeded 3 attempts/);

  const afterBlock = advance({ ...blocked.run, stage: "implement" }, { to: "validate", role: "coordinator" });
  assert.equal(afterBlock.ok, false, "a blocked run must not keep transitioning");
  assert.match(afterBlock.reason, /blocked/);
});

test("an interrupted stage is never completed by recovery, and blocks until reconciled", () => {
  const run = { id: "r1", stage: "implement", status: "running", cycle: 1, evidence: [at(PLAN(), "plan")], attempts: {}, history: [] };
  const begun = beginStage(run, { actor: "worker-1", owner: "owner-1" });
  assert.equal(begun.ok, true);
  assert.equal(begun.run.inflight.stage, "implement");

  const { run: recovered, recovered: didRecover } = recover(begun.run);
  assert.equal(didRecover, true);
  assert.equal(recovered.status, "blocked");
  assert.equal(recovered.stage, "implement", "the stage must not advance");
  assert.equal(recovered.interrupted.stage, "implement");
  assert.equal(isComplete(recovered), false);
  assert.match(recovered.history.at(-1).reason, /NOT completed/);

  const blocked = advance(recovered, { to: "validate", role: "coordinator", evidence: [DIFF()] });
  assert.equal(blocked.ok, false);
  assert.match(blocked.reason, /interrupted/);

  const reconciled = reconcile(recovered, { actor: "operator", note: "worker died before writing the diff" });
  assert.equal(reconciled.ok, true);
  assert.equal(reconciled.run.status, "running");
  assert.equal(reconciled.run.stage, "implement", "reconciliation changes no stage");
  assert.match(reconciled.run.history.at(-1).reason, /still requires its evidence/);

  const stillNoEvidence = advance(reconciled.run, { to: "validate", role: "coordinator" });
  assert.equal(stillNoEvidence.ok, false, "reconciliation must not substitute for evidence");
  assert.match(stillNoEvidence.reason, /missing evidence/);

  assert.equal(
    advance(reconciled.run, { to: "validate", role: "coordinator", owner: "owner-1", evidence: [DIFF()] }).ok,
    true,
  );
});

test("an in-flight stage needs its owner token, and a second begin is refused", () => {
  // A pid would be wrong here: every CLI call is a new process, so the claim is
  // a token the caller presents again. rc9 used a pid, which broke the normal
  // begin/advance pair.
  const run = { id: "r1", stage: "implement", status: "running", cycle: 1, evidence: [at(DIFF(), "implement")], attempts: {}, history: [] };
  assert.equal(beginStage(run, { actor: "w" }).ok, false, "begin without an owner token is refused");
  const begun = beginStage(run, { actor: "worker-1", owner: "tok-abc" });
  assert.equal(begun.ok, true);
  assert.equal(beginStage(begun.run, { actor: "worker-2", owner: "tok-def" }).ok, false, "a live claim is not replaced");

  const without = advance(begun.run, { to: "validate", role: "coordinator" });
  assert.equal(without.ok, false);
  assert.match(without.reason, /in flight for owner tok-abc/);

  assert.equal(advance(begun.run, { to: "validate", role: "coordinator", owner: "tok-def" }).ok, false);
  assert.equal(advance(begun.run, { to: "validate", role: "coordinator", owner: "tok-abc" }).ok, true);
});

test("evidence from another stage of the same cycle is not stage proof", () => {
  // The rc9 gap: a test-output captured while implementing satisfied
  // validate -> review, so validation could be skipped.
  const run = {
    id: "r1",
    stage: "validate",
    status: "running",
    cycle: 1,
    evidence: [at(DIFF(), "implement"), at(TEST(), "implement")],
    attempts: {},
    history: [],
  };
  const refused = advance(run, { to: "review", role: "coordinator" });
  assert.equal(refused.ok, false);
  assert.match(refused.reason, /test-output \(from validate\)/);

  const stamped = { ...run, evidence: run.evidence.concat([at(TEST(), "validate")]) };
  assert.equal(advance(stamped, { to: "review", role: "coordinator" }).ok, true);
});

test("evidence from an earlier cycle does not satisfy a later one", () => {
  const run = {
    id: "r1",
    stage: "validate",
    status: "running",
    cycle: 1,
    evidence: [at(PLAN(), "plan"), at(DIFF(), "implement"), at(TEST(), "validate")],
    attempts: {},
    history: [],
  };
  const toCorrect = advance(run, { to: "correct", role: "coordinator" });
  assert.equal(toCorrect.ok, true);
  assert.equal(toCorrect.run.cycle, 2, "entering correction starts a new cycle");

  const staleImpl = advance(toCorrect.run, { to: "implement", role: "coordinator" });
  assert.equal(staleImpl.ok, false);
  assert.match(staleImpl.reason, /cycle 2: diff/);

  const corrected = advance(toCorrect.run, { to: "implement", role: "coordinator", evidence: [DIFF()] });
  assert.equal(corrected.ok, true);
  const backToValidate = advance(corrected.run, { to: "validate", role: "coordinator" });
  assert.equal(backToValidate.ok, true);

  const staleTests = advance(backToValidate.run, { to: "review", role: "coordinator" });
  assert.equal(staleTests.ok, false, "cycle 1 test output must not prove cycle 2");
  assert.match(staleTests.reason, /cycle 2: test-output/);
  assert.equal(advance(backToValidate.run, { to: "review", role: "coordinator", evidence: [TEST()] }).ok, true);
});

test("evidence verification detects content that changed after capture", () => {
  const dir = tmp();
  const file = path.join(dir, "out.txt");
  fs.writeFileSync(file, "ok\n");
  const entry = evidenceFromFile({ kind: "test-output", producer: "worker-1", file });
  assert.equal(verifyPack([entry]).ok, true);

  fs.writeFileSync(file, "ok\ntampered\n");
  const after = verifyPack([entry]);
  assert.equal(after.ok, false);
  assert.ok(after.problems.some((p) => /content changed/.test(p)));
});

test("full lifecycle: acceptance needs an independent seat approval bound to the evidence", () => {
  const store = openRunStore(tmp());
  const run = createRun(store, { task: "port the coordinator", mode: "solo", revision: "abc123" });
  assert.equal(run.stage, "plan");
  const reviewer = reviewerSeat(run);

  addEvidence(store, run.id, [PLAN()]);
  assert.equal(transition(store, run.id, { to: "implement", role: "coordinator" }).ok, true);
  addEvidence(store, run.id, [DIFF()]);
  assert.equal(transition(store, run.id, { to: "validate", role: "coordinator" }).ok, true);
  addEvidence(store, run.id, [TEST()]);
  assert.equal(transition(store, run.id, { to: "review", role: "coordinator" }).ok, true);

  const beforeVerdict = accept(store, run.id, { approver: reviewer });
  assert.equal(beforeVerdict.ok, false, "accept must fail before a review verdict exists");

  addEvidence(store, run.id, [VERDICT("approve")]);
  const noApproval = accept(store, run.id, { approver: reviewer });
  assert.equal(noApproval.ok, false, "accept must fail without a recorded approval");

  approve(store, run.id, { approver: reviewer });
  const accepted = accept(store, run.id, { approver: reviewer });
  assert.equal(accepted.ok, true, accepted.reason);
  assert.equal(accepted.run.stage, "done");
  assert.ok(accepted.run.acceptedAt, "acceptance records when it happened");
  assert.equal(isComplete(accepted.run), true);
  assert.equal(health(accepted.run).state, "COMPLETE");

  assert.throws(() => addEvidence(store, run.id, [TEST()]), /evidence can no longer be added/);
});

test("approvals must name a declared seat, and the coordinator cannot use the reviewer's", () => {
  const store = openRunStore(tmp());
  const run = createRun(store, { task: "identity binding", mode: "duo", revision: "rev-a" });
  walkToReview(store, run.id);

  assert.throws(() => approve(store, run.id, { approver: "reviewer-1" }), /not a seat in this run/);
  assert.throws(
    () => approve(store, run.id, { approver: coordinatorSeat(run), role: "reviewer" }),
    /holds the coordinator seat and may not approve/,
  );
  assert.throws(() => approve(store, run.id, { approver: coordinatorSeat(run) }), /may not approve/);

  const approval = approve(store, run.id, { approver: reviewerSeat(run) });
  assert.equal(approval.approvals.length, 1);
  assert.equal(approval.approvals[0].revision, "rev-a", "the approval is bound to the run's revision");
});

test("an approval cannot cover a revision the run was not reviewed at", () => {
  const store = openRunStore(tmp());
  const run = createRun(store, { task: "bind revisions", mode: "solo", revision: "rev-a" });
  walkToReview(store, run.id);
  const approved = approve(store, run.id, { approver: reviewerSeat(run) });

  const gate = acceptanceCheck({ ...approved, revision: "rev-b" });
  assert.equal(gate.ok, false);
  assert.ok(gate.reasons.some((r) => /revision rev-a, not rev-b/.test(r)), gate.reasons.join("; "));
});

test("a refused mutation leaves the persisted run byte-identical", () => {
  const store = openRunStore(tmp());
  const run = createRun(store, { task: "refusals do not write", mode: "solo", revision: "rev-a" });
  const reviewer = reviewerSeat(run);
  walkToReview(store, run.id);
  approve(store, run.id, { approver: reviewer });

  // Change the pack after approval: acceptance must refuse, and must not have
  // persisted the intermediate stage it reached before failing.
  addEvidence(store, run.id, [evidenceEntry({ kind: "note", producer: reviewer, content: "post-approval note" })]);
  const before = JSON.stringify(getRun(store, run.id));
  const refused = accept(store, run.id, { approver: reviewer });
  assert.equal(refused.ok, false);
  assert.match(refused.reason, /acceptance refused/);

  const after = JSON.stringify(getRun(store, run.id));
  assert.equal(after, before, "a refused acceptance must not persist a partial transition");
  assert.equal(JSON.parse(after).stage, "review");

  const beforeIllegal = JSON.stringify(getRun(store, run.id));
  assert.equal(transition(store, run.id, { to: "done", role: "coordinator" }).ok, false);
  assert.equal(JSON.stringify(getRun(store, run.id)), beforeIllegal);
});

test("approval expiry gates acceptance but does not un-accept a completed run", () => {
  const T = 1_700_000_000_000;
  const store = openRunStore(tmp());
  const run = createRun(store, { task: "historical acceptance", mode: "solo", revision: "rev-a" });
  const reviewer = reviewerSeat(run);
  walkToReview(store, run.id);

  approve(store, run.id, { approver: reviewer, ttlMs: 60_000, now: () => T });
  const fresh = getRun(store, run.id);
  const lateAccept = advance(fresh, { to: "accept", role: "reviewer", now: () => T + 7_200_000 });
  assert.equal(lateAccept.ok, true, lateAccept.reason);
  const lateDone = advance(lateAccept.run, { to: "done", role: "coordinator", now: () => T + 7_200_000 });
  assert.equal(lateDone.ok, false, "an expired approval must not accept");
  assert.match(lateDone.reason, /expired/);

  const accepted = accept(store, run.id, { approver: reviewer, now: () => T });
  assert.equal(accepted.ok, true, accepted.reason);
  assert.equal(health(accepted.run, { now: T + 7_200_000 }).state, "COMPLETE", "expiry must not un-accept history");
  assert.equal(isComplete(accepted.run), true);
});

test("acceptance through advance() verifies the evidence files", () => {
  const dir = tmp();
  const file = path.join(dir, "proof.txt");
  fs.writeFileSync(file, "proof\n");
  const store = openRunStore(tmp());
  const run = createRun(store, { task: "tamper before acceptance", mode: "solo", revision: "rev-a" });
  const reviewer = reviewerSeat(run);
  walkToReview(store, run.id, [evidenceFromFile({ kind: "log", producer: "w", file })]);
  approve(store, run.id, { approver: reviewer });

  fs.writeFileSync(file, "proof changed\n");
  assert.equal(transition(store, run.id, { to: "accept", role: "reviewer" }).ok, true);
  const toDone = transition(store, run.id, { to: "done", role: "coordinator" });
  assert.equal(toDone.ok, false);
  assert.match(toDone.reason, /no longer verifies/);
});

test("recovery of a persisted interrupted run blocks until reconciled and re-proven", () => {
  const store = openRunStore(tmp());
  const run = createRun(store, { task: "crash recovery", mode: "solo" });
  addEvidence(store, run.id, [PLAN()]);
  transition(store, run.id, { to: "implement", role: "coordinator" });
  const inflight = begin(store, run.id);
  assert.ok(inflight.inflight.owner, "begin issues an owner token");
  assert.throws(() => begin(store, run.id), /already in flight/);

  const recovered = recoverRun(store, run.id, {});
  assert.equal(recovered.run.status, "blocked");
  assert.equal(health(recovered.run).state, "BLOCKED");

  assert.equal(resumeRun(store, run.id, {}).ok, false, "resume must not clear an interruption");
  assert.equal(transition(store, run.id, { to: "validate", role: "coordinator" }).ok, false);

  const reconciled = reconcileRun(store, run.id, { note: "diff was lost with the process" });
  assert.equal(reconciled.run.status, "running");
  assert.equal(transition(store, run.id, { to: "validate", role: "coordinator" }).ok, false, "still needs a diff");
  addEvidence(store, run.id, [DIFF()]);
  assert.equal(transition(store, run.id, { to: "validate", role: "coordinator" }).ok, true);
});

test("health distinguishes stuck from complete and flags accepted evidence that no longer verifies", () => {
  const run = { id: "r", stage: "implement", status: "running", updatedAt: new Date(Date.now() - 5_000).toISOString(), evidence: [], history: [] };
  assert.equal(health(run, { stuckAfterMs: 60_000 }).state, "RUNNING");
  assert.equal(health(run, { stuckAfterMs: 1_000 }).state, "STUCK");

  const dir = tmp();
  const file = path.join(dir, "proof.txt");
  fs.writeFileSync(file, "proof\n");
  const store = openRunStore(tmp());
  const created = createRun(store, { task: "tamper detection", mode: "solo" });
  const reviewer = reviewerSeat(created);
  walkToReview(store, created.id, [evidenceFromFile({ kind: "log", producer: "worker-1", file })]);
  approve(store, created.id, { approver: reviewer });
  const done = accept(store, created.id, { approver: reviewer });
  assert.equal(done.ok, true, done.reason);
  assert.equal(health(done.run).state, "COMPLETE");

  fs.writeFileSync(file, "proof changed\n");
  assert.equal(health(done.run).state, "INVALID_EVIDENCE", "a changed evidence file must not read as COMPLETE");
  assert.equal(isComplete(done.run), false);
});

test("stage list is exactly the documented workflow", () => {
  assert.deepEqual(STAGES, ["plan", "implement", "validate", "review", "correct", "accept"]);
});
