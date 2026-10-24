// governance.test.mjs — modes, approvals and leases: the controls that stop a
// run from approving itself or two workers from mutating one resource.
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { ApprovalError, createApproval, validateApproval } from "./approvals.mjs";
import { LeaseConflict, openLeases } from "./leases.mjs";
import { ModeError, MODE_NAMES, approver, describeMode, implementers, seatPlan } from "./modes.mjs";
import { openStore } from "./state.mjs";

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), "orch-gov-"));
let counter = 0;
const ids = () => () => `x${(counter += 1)}`;

test("each mode produces the documented team shape", () => {
  const solo = seatPlan("solo", { idFactory: ids() });
  assert.equal(solo.seats.filter((s) => s.role === "worker").length, 1);
  assert.equal(solo.providerPolicy, "any");

  const duo = seatPlan("duo", { idFactory: ids() });
  assert.equal(duo.seats.filter((s) => s.role === "worker").length, 2);

  const quad = seatPlan("quad", { idFactory: ids() });
  assert.equal(quad.seats.filter((s) => s.role === "worker").length, 4);

  const free = seatPlan("free_only", { idFactory: ids() });
  assert.equal(free.providerPolicy, "free", "free_only must constrain routing");

  const soloFree = seatPlan("solo", { freeOnly: true, idFactory: ids() });
  assert.equal(soloFree.providerPolicy, "free", "--free-only must compose with any mode");
});

test("super may implement from the coordinator seat; solo may not", () => {
  const superPlan = seatPlan("super", { idFactory: ids() });
  assert.equal(superPlan.allowsCoordinatorImplementation, true);
  assert.ok(implementers(superPlan).length >= 1);

  const solo = seatPlan("solo", { idFactory: ids() });
  assert.equal(solo.allowsCoordinatorImplementation, false);
  assert.ok(implementers(solo).every((s) => s.role === "worker"));
});

test("mode validation refuses self-review and missing seats", () => {
  assert.throws(() => seatPlan("nope"), ModeError);
  assert.throws(() => seatPlan("custom", { idFactory: ids() }), /explicit seat list/);
  assert.throws(() => seatPlan("solo", { customSeats: [{ role: "worker" }], idFactory: ids() }), /does not accept/);

  const noReviewer = [{ role: "coordinator", id: "c1" }, { role: "worker", id: "w1" }];
  assert.throws(
    () => seatPlan("custom", { customSeats: noReviewer, idFactory: ids() }),
    /independent reviewer seat/,
    "a custom plan must still contain a reviewer",
  );

  const selfReview = [
    { role: "coordinator", id: "c1" },
    { role: "worker", id: "w1" },
    { role: "reviewer", id: "c1" },
  ];
  assert.throws(() => seatPlan("custom", { customSeats: selfReview, idFactory: ids() }), /independence/);
});

test("the approver is a reviewer seat, never the coordinator", () => {
  const plan = seatPlan("duo", { idFactory: ids() });
  const seat = approver(plan);
  assert.equal(seat.role, "reviewer");
  assert.notEqual(seat.id, plan.seats.find((s) => s.role === "coordinator").id);
});

test("mode descriptions are honest about policy and implementation", () => {
  const d = describeMode("free_only");
  assert.equal(d.providerPolicy, "free");
  assert.equal(d.reviewer, true);
  assert.deepEqual(MODE_NAMES, ["solo", "duo", "quad", "super", "custom", "free_only"]);
});

test("only reviewer or operator roles may mint an approval", () => {
  const base = { approver: "w1", runId: "r1", stage: "accept", evidenceHash: "h", revision: "rev" };
  assert.throws(() => createApproval({ ...base, role: "worker" }), ApprovalError);
  assert.throws(() => createApproval({ ...base, role: "coordinator" }), /may not approve/);
  const ok = createApproval({ ...base, role: "reviewer" });
  assert.equal(ok.role, "reviewer");
});

test("approvals are rejected when scope, evidence or revision drift", () => {
  const now = () => 1_000_000;
  const approval = createApproval({
    approver: "reviewer-1",
    role: "reviewer",
    runId: "r1",
    stage: "accept",
    evidenceHash: "pack-a",
    revision: "rev-a",
    ttlMs: 60_000,
    now,
  });
  const good = validateApproval(approval, { runId: "r1", stage: "accept", evidenceHash: "pack-a", revision: "rev-a", now });
  assert.equal(good.ok, true, good.reasons.join("; "));

  const wrongStage = validateApproval(approval, { stage: "review", now });
  assert.equal(wrongStage.ok, false);
  assert.ok(wrongStage.reasons.some((r) => /covers stage/.test(r)));

  const wrongPack = validateApproval(approval, { evidenceHash: "pack-b", now });
  assert.ok(wrongPack.reasons.some((r) => /evidence pack/.test(r)));

  const wrongRev = validateApproval(approval, { revision: "rev-b", now });
  assert.ok(wrongRev.reasons.some((r) => /revision/.test(r)));

  const stale = validateApproval(approval, { now: () => 1_000_000 + 120_000 });
  assert.equal(stale.ok, false);
  assert.ok(stale.reasons.some((r) => /expired/.test(r)), stale.reasons.join("; "));
});

test("an implementer or the coordinator cannot approve the same run", () => {
  const now = () => 1_000_000;
  const approval = createApproval({ approver: "w1", role: "reviewer", runId: "r1", stage: "accept", evidenceHash: "h", revision: "r", now });
  const check = validateApproval(approval, { now, implementerIds: ["w1"], coordinatorId: "c1" });
  assert.equal(check.ok, false);
  assert.ok(check.reasons.some((r) => /implemented this work/.test(r)));

  const selfApprove = createApproval({ approver: "c1", role: "reviewer", runId: "r1", stage: "accept", evidenceHash: "h", revision: "r", now });
  const check2 = validateApproval(selfApprove, { now, coordinatorId: "c1" });
  assert.ok(check2.reasons.some((r) => /coordinator cannot approve/.test(r)));
});

test("a lease excludes a second owner and can be renewed, released and reclaimed", () => {
  let clock = 10_000;
  const store = openStore(tmp());
  const leases = openLeases(store, { now: () => clock });

  leases.acquire({ resource: "repo:build-lock", owner: "worker-1", ttlMs: 1_000 });
  assert.throws(() => leases.acquire({ resource: "repo:build-lock", owner: "worker-2", ttlMs: 1_000 }), LeaseConflict);

  const renewed = leases.renew({ resource: "repo:build-lock", owner: "worker-1", ttlMs: 5_000 });
  assert.equal(renewed.expiresAt, clock + 5_000);

  clock += 6_000;
  const afterExpiry = leases.acquire({ resource: "repo:build-lock", owner: "worker-2", ttlMs: 1_000 });
  assert.equal(afterExpiry.owner, "worker-2", "an expired lease must not block a new owner");

  assert.throws(() => leases.release({ resource: "repo:build-lock", owner: "worker-1" }), LeaseConflict);
  assert.deepEqual(leases.release({ resource: "repo:build-lock", owner: "worker-2" }), { released: true });

  const reclaimed = leases.reclaimExpired();
  assert.deepEqual(reclaimed.dropped, []);
});

test("a corrupt lease file is fatal and preserved, never silently reset", () => {
  const dir = tmp();
  const store = openStore(dir);
  const file = path.join(dir, "leases.json");
  fs.writeFileSync(file, "[]");
  const before = fs.readFileSync(file);
  const leases = openLeases(store, { now: () => 1_000 });
  assert.throws(() => leases.acquire({ resource: "repo:lock", owner: "w1", ttlMs: 500 }), /not usable/);
  assert.deepEqual(fs.readFileSync(file), before, "refusing must not overwrite the evidence of corruption");
});
