// Contract tests for the durable effect tracker (Sol gate 2026-10-25).
// A stub authority stands in for the Rust service so ordering, idempotency and
// acknowledgement semantics are observable without a socket.
import { describe, test } from "node:test";
import assert from "node:assert/strict";
import {
  acknowledgeEffect,
  assertReplayDelivered,
  beginEffects,
  endEffects,
  effectIntent,
  withEffect,
  classifyEffectValue,
  digestOf,
} from "../lib/rust-effects.mjs";

function stubAuthority({ runState = "RUNNING" } = {}) {
  const calls = [];
  const ops = new Map();
  return {
    calls,
    ops,
    read: () => ({ state: { runState } }),
    intent: (_runId, { opId, op, payloadDigest }) => {
      calls.push({ kind: "intent", opId });
      const existing = ops.get(opId);
      if (existing) {
        return {
          ok: true,
          duplicate: true,
          settled: existing.outcome === "done" || existing.outcome === "failed",
          pending: existing.outcome === "unknown",
          outcome: existing.outcome ?? null,
          remoteId: existing.remoteId ?? null,
        };
      }
      ops.set(opId, { op, payloadDigest, outcome: null });
      return { ok: true, duplicate: false, rev: ops.size };
    },
    result: (_runId, { opId, outcome, remoteId }) => {
      calls.push({ kind: "result", opId, outcome });
      const entry = ops.get(opId) ?? {};
      ops.set(opId, { ...entry, outcome, remoteId });
      return { ok: true, rev: ops.size };
    },
  };
}

describe("durable effect tracker", () => {
  test("commits the intent before the external call and the result after", async () => {
    const authority = stubAuthority();
    const previous = beginEffects("run-1", authority);
    const seen = [];
    await withEffect({ op: "seat.turn", payload: { x: 1 } }, async () => {
      seen.push(...authority.calls.map((c) => c.kind));
      return { ok: true, id: "remote-1" };
    });
    endEffects(previous);
    assert.deepEqual(seen, ["intent"]);
    assert.deepEqual(authority.calls.map((c) => c.kind), ["intent", "result"]);
    assert.equal([...authority.ops.values()][0].outcome, "done");
  });

  test("a settled effect replays with the caller's success shape", async () => {
    const authority = stubAuthority();
    const previous = beginEffects("run-2", authority);
    let calls = 0;
    const first = await withEffect({ op: "seat.turn", payload: { x: 2 } }, async () => {
      calls++;
      return { ok: true, id: "remote-2" };
    });
    const replay = await withEffect({ op: "seat.turn", payload: { x: 2 } }, async () => {
      calls++;
      return { ok: true, id: "remote-2" };
    });
    endEffects(previous);
    assert.equal(calls, 1);
    assert.equal(first.ok, true);
    assert.equal(replay.ok, true, "a replayed success must not read as failure");
    assert.equal(replay.replayed, true);
    assert.equal(replay.remoteId, "remote-2");
  });

  test("a replayed failure keeps the failure shape", async () => {
    const authority = stubAuthority();
    const previous = beginEffects("run-3", authority);
    await withEffect({ op: "seat.turn", payload: { x: 3 } }, async () => ({ ok: false, failureClass: "QUOTA" }));
    const replay = await withEffect({ op: "seat.turn", payload: { x: 3 } }, async () => {
      throw new Error("must not run");
    });
    endEffects(previous);
    assert.equal(replay.ok, false);
    assert.equal(replay.replayed, true);
    assert.equal(replay.failureClass, "FAILED");
  });

  test("an unresolved effect refuses redispatch", async () => {
    const authority = stubAuthority();
    const previous = beginEffects("run-4", authority);
    await assert.rejects(
      withEffect({ op: "seat.turn", payload: { x: 4 } }, async () => {
        throw Object.assign(new Error("timed out"), { code: "ETIMEDOUT" });
      }),
      (error) => error.code === "ETIMEDOUT",
    );
    let redispatched = 0;
    await assert.rejects(
      withEffect({ op: "seat.turn", payload: { x: 4 } }, async () => {
        redispatched++;
      }),
      (error) => error.code === "EFFECT_PENDING",
    );
    endEffects(previous);
    assert.equal(redispatched, 0);
  });

  test("an acknowledgement failure is fatal, not silently successful", async () => {
    const authority = stubAuthority();
    authority.result = () => {
      throw Object.assign(new Error("lease lost"), { code: "STALE_EPOCH" });
    };
    const previous = beginEffects("run-5", authority);
    await assert.rejects(
      withEffect({ op: "thread.create", payload: { x: 5 } }, async () => ({ id: "thread-5" })),
      (error) => error.code === "EFFECT_ACK_FAILED",
    );
    endEffects(previous);
  });

  test("a finished run refuses new effects before any intent is committed", async () => {
    const authority = stubAuthority({ runState: "ABORTED" });
    const previous = beginEffects("run-6", authority);
    await assert.rejects(
      withEffect({ op: "seat.turn", payload: { x: 6 } }, async () => ({ ok: true })),
      (error) => error.code === "RUN_FINISHED",
    );
    endEffects(previous);
    assert.equal(authority.calls.length, 0);
  });

  test("outside a scope every helper is inert", async () => {
    const value = await withEffect({ op: "seat.turn", payload: { x: 7 } }, async () => ({ ok: true, id: "none" }));
    assert.equal(value.ok, true);
  });

  test("an acknowledgement failure is not followed by a false failed record", () => {
    // Sol gate round 2 (2026-10-25 finding 1): the remote thread EXISTS, so a
    // second `failed` commit would be a lie. Exactly one result may be written.
    const authority = stubAuthority();
    authority.result = () => {
      throw Object.assign(new Error("lease lost"), { code: "STALE_EPOCH" });
    };
    const previous = beginEffects("run-8", authority);
    const intent = effectIntent({ op: "thread.create", payload: { x: 8 } });
    assert.throws(
      () => acknowledgeEffect(intent, { id: "thread-8" }),
      (error) => error.code === "EFFECT_ACK_FAILED",
    );
    endEffects(previous);
    assert.equal(authority.calls.filter((c) => c.kind === "result").length, 0);
  });

  test("a replayed failure is still a failure for the caller", () => {
    // Sol gate round 2 (2026-10-25 finding 2): delivery must not be reported ok.
    assert.throws(
      () => assertReplayDelivered({ replayed: true, opId: "op-9", outcome: "failed", failureClass: "QUOTA" }, "postMessage"),
      (error) => error.code === "EFFECT_REPLAY_FAILED" && error.failureClass === "QUOTA",
    );
    assert.throws(
      () => assertReplayDelivered({ replayed: true, opId: "op-10", outcome: "unknown" }, "postMessage"),
      (error) => error.code === "EFFECT_REPLAY_FAILED",
    );
    assert.doesNotThrow(() => assertReplayDelivered({ replayed: true, opId: "op-11", outcome: "done" }, "postMessage"));
    assert.doesNotThrow(() => assertReplayDelivered(null, "postMessage"));
  });

  test("a replayed failure reaches the caller with its ORIGINAL class", () => {
    // Sol round 3: effectIntent() reports `errorClass`; assertReplayDelivered()
    // used to read only `failureClass`, so QUOTA became FAILED on the caller
    // path used by createThread() and postMessage(). Go through the real replay.
    for (const op of ["thread.create", "thread.message"]) {
      const authority = stubAuthority();
      authority.intent = () => ({
        ok: true,
        duplicate: true,
        settled: true,
        pending: false,
        outcome: "failed",
        remoteId: null,
        errorClass: "QUOTA",
      });
      const previous = beginEffects(`run-replay-${op}`, authority);
      const replay = effectIntent({ op, payload: { probe: op } });
      endEffects(previous);
      assert.equal(replay.replayed, true, `${op}: must replay`);
      assert.equal(replay.errorClass, "QUOTA", `${op}: descriptor keeps the class`);
      assert.throws(
        () => assertReplayDelivered(replay, op),
        (error) => error.code === "EFFECT_REPLAY_FAILED" && error.failureClass === "QUOTA",
        `${op}: caller sees QUOTA, not FAILED`,
      );
      // A no-redispatch guarantee: the stub was never asked to commit a result.
      assert.equal(authority.calls.filter((c) => c.kind === "result").length, 0);
    }
  });

  test("a replayed intent carries the recorded error class", () => {
    const authority = stubAuthority();
    authority.intent = () => ({
      ok: true,
      duplicate: true,
      settled: true,
      pending: false,
      outcome: "failed",
      remoteId: null,
      errorClass: "QUOTA",
    });
    const previous = beginEffects("run-9", authority);
    const replay = effectIntent({ op: "thread.message", payload: { x: 9 } });
    endEffects(previous);
    assert.equal(replay.replayed, true);
    assert.equal(replay.outcome, "failed");
    assert.equal(replay.errorClass, "QUOTA");
  });

  test("structured failures classify honestly", () => {
    assert.equal(classifyEffectValue({ ok: true }), "done");
    assert.equal(classifyEffectValue({ ok: false, failureClass: "QUOTA" }), "failed");
    assert.equal(classifyEffectValue({ ok: false, failureClass: "TIMEOUT" }), "unknown");
    assert.equal(classifyEffectValue({ ok: false, failureClass: "UNKNOWN" }), "unknown");
    assert.equal(digestOf({ a: 1 }).length, 64);
  });
});
