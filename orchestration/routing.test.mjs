// routing.test.mjs — role routing, free-only enforcement and structured
// outcomes. The transport is injected, so nothing here makes a model call.
import assert from "node:assert/strict";
import test from "node:test";

import {
  FreeRouteUnavailable,
  RouteNotAllowed,
  assertFreeOnlySafe,
  classifyError,
  eligibleRoutes,
  freeVerificationProblems,
  invokeRole,
  normaliseRoute,
  selectRoute,
} from "./routing.mjs";

const freeRoute = {
  id: "or-free",
  provider: "openrouter",
  model: "some/model:free",
  cost: "free",
  verifiedFree: true,
  verifiedAt: "2026-10-24T00:00:00Z",
  evidence: "provider pricing table read 2026-10-24: input $0, output $0",
  pricing: { input: 0, output: 0 },
  order: 1,
};

const paidRoute = {
  id: "or-paid",
  provider: "openrouter",
  model: "some/model",
  cost: "paid",
  pricing: { input: 3, output: 15 },
  order: 0,
};

test("a free claim without zero pricing is not free", () => {
  const lying = normaliseRoute({ id: "x", provider: "p", model: "m", cost: "free", verifiedFree: true });
  assert.equal(lying.verifiedFree, false, "no pricing evidence means not verified free");

  const real = normaliseRoute(freeRoute);
  assert.equal(real.verifiedFree, true);
  assert.equal(real.usableFree, true);

  const paid = normaliseRoute(paidRoute);
  assert.equal(paid.verifiedFree, false);
  assert.equal(paid.cost, "paid");
});

test("a declared-free route without a verification record is unusable, not assumed", () => {
  // The rc8 defect: verifiedAt and evidence were optional, so a route could
  // declare itself free with no source and still be selected.
  const noStamp = normaliseRoute({ ...freeRoute, verifiedAt: null });
  assert.equal(noStamp.usableFree, false);
  assert.ok(noStamp.verificationProblems.some((p) => /verification timestamp/.test(p)));

  const noEvidence = normaliseRoute({ ...freeRoute, evidence: "  " });
  assert.equal(noEvidence.usableFree, false);
  assert.ok(noEvidence.verificationProblems.some((p) => /verification evidence/.test(p)));

  const future = normaliseRoute({ ...freeRoute, verifiedAt: "2099-01-01T00:00:00Z" });
  assert.equal(future.usableFree, false);
  assert.ok(future.verificationProblems.some((p) => /future/.test(p)));

  const nonsense = normaliseRoute({ ...freeRoute, verifiedAt: "last tuesday" });
  assert.equal(nonsense.usableFree, false);
  assert.deepEqual(freeVerificationProblems({ ...freeRoute, verifiedFree: false }), ["not declared verifiedFree"]);

  assert.deepEqual(
    eligibleRoutes({ role: "worker", policy: "free", registry: [noStamp, noEvidence] }),
    [],
    "an unverifiable free claim must not be eligible",
  );
});

test("free-only eligibility excludes paid routes entirely", () => {
  const forFree = eligibleRoutes({ role: "worker", policy: "free", registry: [paidRoute, freeRoute] });
  assert.deepEqual(forFree.map((r) => r.id), ["or-free"]);

  const anyPolicy = eligibleRoutes({ role: "worker", policy: "any", registry: [paidRoute, freeRoute] });
  assert.deepEqual(anyPolicy.map((r) => r.id), ["or-paid", "or-free"], "ordering is stable and explicit");
});

test("a pinned route that is not verified free is refused, not downgraded", () => {
  assert.throws(
    () => selectRoute({ role: "worker", policy: "free", registry: [freeRoute, paidRoute], pinnedId: "or-paid" }),
    RouteNotAllowed,
  );
});

test("no eligible route fails closed instead of falling back to paid", () => {
  assert.throws(() => selectRoute({ role: "worker", policy: "free", registry: [paidRoute] }), FreeRouteUnavailable);
  assert.throws(
    () => assertFreeOnlySafe({ registry: [paidRoute], roles: ["coordinator", "worker", "reviewer"] }),
    FreeRouteUnavailable,
  );
  assert.throws(
    () => assertFreeOnlySafe({ registry: [{ ...freeRoute, verifiedAt: null }], roles: ["worker"] }),
    FreeRouteUnavailable,
  );
});

test("error classification separates retryable from terminal", () => {
  assert.deepEqual(classifyError({ kind: "rate_limit" }), { retryable: true, kind: "rate_limit" });
  assert.deepEqual(classifyError({ kind: "timeout" }), { retryable: true, kind: "timeout" });
  assert.equal(classifyError({ status: 503 }).retryable, true);
  assert.equal(classifyError({ status: 429 }).retryable, true);
  assert.deepEqual(classifyError({ kind: "auth" }), { retryable: false, kind: "auth" });
  assert.equal(classifyError({ status: 400 }).retryable, false);
  assert.equal(classifyError({ status: 404 }).retryable, false);
  assert.equal(classifyError(new Error("boom")).retryable, false);
});

test("a transient failure is retried on the same free route and reports usage", async () => {
  let calls = 0;
  const telemetry = [];
  const outcome = await invokeRole({
    role: "worker",
    policy: "free",
    registry: [paidRoute, freeRoute],
    maxAttempts: 3,
    sleep: async () => {},
    telemetry,
    transport: async () => {
      calls += 1;
      if (calls === 1) {
        const err = new Error("slow down");
        err.kind = "rate_limit";
        throw err;
      }
      return { text: "done", usage: { promptTokens: 11, completionTokens: 7 } };
    },
  });
  assert.equal(outcome.ok, true, JSON.stringify(outcome.error));
  assert.equal(outcome.routeId, "or-free", "a free-only run must never pick the paid route");
  assert.equal(outcome.attemptsUsed, 2);
  assert.equal(outcome.telemetry.costUsd, 0, "a verified free route costs zero");
  assert.equal(outcome.telemetry.totalTokens, 18);
  assert.equal(telemetry.length, 1);
});

test("a terminal failure is not retried", async () => {
  let calls = 0;
  const outcome = await invokeRole({
    role: "reviewer",
    policy: "free",
    registry: [freeRoute],
    maxAttempts: 3,
    sleep: async () => {},
    transport: async () => {
      calls += 1;
      const err = new Error("bad key");
      err.kind = "auth";
      throw err;
    },
  });
  assert.equal(outcome.ok, false);
  assert.equal(calls, 1, "an auth failure must not be retried");
  assert.equal(outcome.classification.kind, "auth");
});

test("no route yields a structured, zero-cost failure rather than an exception", async () => {
  let called = false;
  const outcome = await invokeRole({
    role: "coordinator",
    policy: "free",
    registry: [paidRoute],
    transport: async () => {
      called = true;
      return { text: "should never run" };
    },
  });
  assert.equal(outcome.ok, false);
  assert.equal(outcome.error.kind, "no_route");
  assert.equal(outcome.telemetry.costUsd, 0);
  assert.equal(called, false, "no transport call may happen without an allowed route");
});

test("exhausted retries surface the last classification and stay on the free route", async () => {
  const outcome = await invokeRole({
    role: "worker",
    policy: "free",
    registry: [freeRoute],
    maxAttempts: 2,
    sleep: async () => {},
    transport: async () => {
      const err = new Error("overloaded");
      err.kind = "overloaded";
      throw err;
    },
  });
  assert.equal(outcome.ok, false);
  assert.equal(outcome.routeId, "or-free");
  assert.equal(outcome.attempts.length, 2);
  assert.equal(outcome.error.kind, "overloaded");
});
