// workflow.test.mjs — durable state, stage transitions, recovery and the run
// lifecycle. No model calls: every case is deterministic and local.
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { evidenceEntry, evidenceFromFile, packHash, verifyPack } from "./evidence.mjs";
import { STAGES, advance, beginStage, isComplete, recover } from "./stage-machine.mjs";
import { StateCorruptError, acquireLock, openStore, readJson, writeJsonAtomic } from "./state.mjs";
import { accept, addEvidence, approve, begin, createRun, health, openRunStore, recoverRun, transition } from "./runs.mjs";

function tmp() {
  return fs.mkdtempSync(path.join(os.tmpdir(), "orch-test-"));
}

const PLAN = () => evidenceEntry({ kind: "plan", producer: "coordinator", content: "plan: do the thing" });
const DIFF = () => evidenceEntry({ kind: "diff", producer: "worker-1", content: "diff --git a/x b/x" });
const TEST = () => evidenceEntry({ kind: "test-output", producer: "worker-1", content: "ok 1 - everything" });
const VERDICT = (verdict = "approve") =>
  evidenceEntry({ kind: "review-verdict", producer: "reviewer-1", content: `verdict: ${verdict}`, meta: { verdict } });

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
  const leftovers = fs.readdirSync(dir).filter((n) => n.endsWith(".tmp"));
  assert.deepEqual(leftovers, [], "no temp file may survive a write");
});

test("the store lock excludes a second holder and releases", () => {
  const dir = tmp();
  const release = acquireLock(path.join(dir, "x.lock"), { timeoutMs: 2000 });
  assert.throws(() => acquireLock(path.join(dir, "x.lock"), { timeoutMs: 150 }), /not released within/);
  release();
  const again = acquireLock(path.join(dir, "x.lock"), { timeoutMs: 500 });
  again();
});

test("stage transitions require the evidence the stage must produce", () => {
  const run = { id: "r1", stage: "plan", status: "running", evidence: [], attempts: {}, history: [] };
  const refused = advance(run, { to: "implement", role: "coordinator", actor: "c1" });
  assert.equal(refused.ok, false);
  assert.match(refused.reason, /missing evidence.*plan/);

  const plan = PLAN();
  const ok = advance({ ...run, evidence: [plan] }, { to: "implement", role: "coordinator", actor: "c1" });
  assert.equal(ok.ok, true);
  assert.equal(ok.run.stage, "implement");
  assert.equal(ok.run.history.length, 1);
});

test("illegal transitions and wrong authority are refused", () => {
  const run = { id: "r1", stage: "plan", status: "running", evidence: [PLAN()], attempts: {}, history: [] };
  assert.equal(advance(run, { to: "accept", role: "reviewer" }).ok, false, "plan -> accept must not exist");

  const reviewable = { ...run, stage: "review", evidence: [PLAN(), DIFF(), TEST(), VERDICT()] };
  const asWorker = advance(reviewable, { to: "accept", role: "worker" });
  assert.equal(asWorker.ok, false);
  assert.match(asWorker.reason, /requires reviewer authority/);
});

test("accept requires an approving verdict, not just a verdict entry", () => {
  const base = { id: "r1", stage: "review", status: "running", evidence: [PLAN(), DIFF(), TEST()], attempts: {}, history: [] };
  const changes = VERDICT("changes_requested");
  const refused = advance({ ...base, evidence: base.evidence.concat([changes]) }, { to: "accept", role: "reviewer" });
  assert.equal(refused.ok, false);
  assert.match(refused.reason, /approving review verdict/);

  const approved = advance({ ...base, evidence: base.evidence.concat([VERDICT("approve")]) }, { to: "accept", role: "reviewer" });
  assert.equal(approved.ok, true);
});

test("a transition replayed with the same key is a no-op, not a second history entry", () => {
  const run = { id: "r1", stage: "plan", status: "running", evidence: [], attempts: {}, history: [] };
  const first = advance(run, { to: "implement", role: "coordinator", evidence: [PLAN()], idempotencyKey: "k1" });
  assert.equal(first.applied, true);

  const replay = advance(first.run, { to: "validate", role: "coordinator", evidence: [DIFF()], idempotencyKey: "k1" });
  assert.equal(replay.applied, false, "same key must not apply twice");
  assert.equal(replay.run.stage, "implement", "state must be unchanged on replay");
});

test("retries are bounded per stage and exceeding the bound blocks the run", () => {
  let run = { id: "r1", stage: "implement", status: "running", evidence: [PLAN(), DIFF()], attempts: {}, history: [] };
  for (let i = 0; i < 3; i += 1) {
    const r = advance(run, { to: "validate", role: "coordinator" });
    assert.equal(r.ok, true, `attempt ${i + 1} should be allowed`);
    run = { ...r.run, stage: "implement" };
  }
  const blocked = advance(run, { to: "validate", role: "coordinator" });
  assert.equal(blocked.ok, false);
  assert.equal(blocked.run.status, "blocked");
  assert.match(blocked.reason, /exceeded 3 attempts/);
});

test("an interrupted stage is never completed by recovery", () => {
  const run = { id: "r1", stage: "implement", status: "running", evidence: [PLAN()], attempts: {}, history: [] };
  const inflight = beginStage(run, { actor: "worker-1" });
  assert.equal(inflight.inflight.stage, "implement");

  const { run: recovered, recovered: didRecover } = recover(inflight);
  assert.equal(didRecover, true);
  assert.equal(recovered.status, "blocked");
  assert.equal(recovered.stage, "implement", "the stage must not advance");
  assert.equal(recovered.interrupted.stage, "implement");
  assert.equal(isComplete(recovered), false);
  assert.match(recovered.history.at(-1).reason, /NOT completed/);
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

test("full lifecycle: acceptance needs an independent approval bound to the evidence", () => {
  const store = openRunStore(tmp());
  const run = createRun(store, { task: "port the coordinator", mode: "solo", revision: "abc123" });
  assert.equal(run.stage, "plan");

  addEvidence(store, run.id, [PLAN()]);
  assert.equal(transition(store, run.id, { to: "implement", role: "coordinator" }).ok, true);
  addEvidence(store, run.id, [DIFF()]);
  assert.equal(transition(store, run.id, { to: "validate", role: "coordinator" }).ok, true);
  addEvidence(store, run.id, [TEST()]);
  assert.equal(transition(store, run.id, { to: "review", role: "coordinator" }).ok, true);

  const beforeVerdict = accept(store, run.id, { approver: "reviewer-1" });
  assert.equal(beforeVerdict.ok, false, "accept must fail before a review verdict exists");

  addEvidence(store, run.id, [VERDICT("approve")]);
  const noApproval = accept(store, run.id, { approver: "reviewer-1" });
  assert.equal(noApproval.ok, false, "accept must fail without a recorded approval");

  approve(store, run.id, { approver: "reviewer-1", role: "reviewer", revision: "abc123" });
  const accepted = accept(store, run.id, { approver: "reviewer-1", revision: "abc123" });
  assert.equal(accepted.ok, true, accepted.reason);
  assert.equal(accepted.run.stage, "done");
  assert.equal(isComplete(accepted.run), true);
});

test("an approval tied to a different revision cannot accept the run", () => {
  const store = openRunStore(tmp());
  const run = createRun(store, { task: "bind revisions", mode: "solo", revision: "rev-a" });
  addEvidence(store, run.id, [PLAN(), DIFF(), TEST(), VERDICT("approve")]);
  transition(store, run.id, { to: "implement", role: "coordinator" });
  transition(store, run.id, { to: "validate", role: "coordinator" });
  transition(store, run.id, { to: "review", role: "coordinator" });
  approve(store, run.id, { approver: "reviewer-1", revision: "rev-a" });

  const stale = accept(store, run.id, { approver: "reviewer-1", revision: "rev-b" });
  assert.equal(stale.ok, false);
  assert.match(stale.reason, /invalid: .*revision/);
});

test("recovery of a persisted interrupted run blocks instead of pretending success", () => {
  const store = openRunStore(tmp());
  const run = createRun(store, { task: "crash recovery", mode: "solo" });
  addEvidence(store, run.id, [PLAN()]);
  transition(store, run.id, { to: "implement", role: "coordinator" });
  begin(store, run.id);

  const recovered = recoverRun(store, run.id, {});
  assert.equal(recovered.run.status, "blocked");
  assert.equal(recovered.run.stage, "implement");
  assert.equal(health(recovered.run).state, "BLOCKED");
});

test("health distinguishes stuck from complete", () => {
  const run = { id: "r", stage: "implement", status: "running", updatedAt: new Date(Date.now() - 5_000).toISOString(), evidence: [], history: [] };
  assert.equal(health(run, { stuckAfterMs: 60_000 }).state, "RUNNING");
  assert.equal(health(run, { stuckAfterMs: 1_000 }).state, "STUCK");
  const done = { ...run, stage: "done", status: "accepted", evidence: [VERDICT("approve"), evidenceEntry({ kind: "approval", producer: "reviewer-1", content: "approved" })] };
  assert.equal(health(done).state, "COMPLETE");
});

test("stage list is exactly the documented workflow", () => {
  assert.deepEqual(STAGES, ["plan", "implement", "validate", "review", "correct", "accept"]);
});
