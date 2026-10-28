// Adapter contract tests for the Rust state authority.
//
// Two layers:
//   1. real-socket tests against the compiled `orchestra-observer` binary
//      (adapter + protocol + fencing + projection repair);
//   2. injected-runner tests for the failure modes that are hard to provoke
//      against a healthy service (timeouts, malformed responses, lost acks).
//
// Run with:  bun test tests/rust-authority.test.mjs   (or node --test)
// The binary path is ORCHESTRA_BIN (defaults to ../target/release/orchestra-observer).
import { after, before, describe, test } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createAuthorityClient, assertLocalWriteAllowed, requestAuthorityRollback, AuthorityError } from "../lib/rust-authority.mjs";

const BIN = process.env.ORCHESTRA_BIN || join(import.meta.dirname, "..", "target", "release", "orchestra-observer");
const LIVE = existsSync(BIN);

function waitFor(predicate, timeoutMs = 5000, stepMs = 25) {
  return new Promise((resolve, reject) => {
    const deadline = Date.now() + timeoutMs;
    const tick = () => {
      if (predicate()) return resolve(true);
      if (Date.now() > deadline) return reject(new Error("timed out"));
      setTimeout(tick, stepMs);
    };
    tick();
  });
}

describe("authority adapter (real socket)", { skip: LIVE ? false : `binary not built: ${BIN}` }, () => {
  let root;
  let child;
  let client;
  const token = "a".repeat(64);
  const socket = () => join(root, ".rust-authority", "authority.sock");

  before(async () => {
    root = mkdtempSync(join(tmpdir(), "authority-adapter-"));
    child = spawn(BIN, ["authority-serve"], {
      env: {
        ...process.env,
        ORCHESTRA_RUNS_DIR: root,
        ORCHESTRA_RUST_AUTHORITY_TOKEN: token,
        ORCHESTRA_RUST_AUTHORITY: socket(),
      },
      stdio: ["ignore", "ignore", "pipe"],
    });
    await waitFor(() => existsSync(socket()));
    client = createAuthorityClient({ socketPath: socket(), token, ownerId: "adapter-test" });
  });

  after(() => {
    try { client?.releaseAll(); } catch { /* ignore */ }
    child?.kill("SIGTERM");
    rmSync(root, { recursive: true, force: true });
  });

  const base = (runId) => ({
    runId,
    task: "adapter test",
    runState: "PLANNED",
    phaseVerdicts: {},
    phases: [{ n: 1 }, { n: 2 }],
    workers: ["alpha", "beta"],
    completedThrough: 0,
    startedAt: 1_700_000_000_000,
  });

  test("health reports the Rust authority schema", () => {
    const health = client.health();
    assert.equal(health.stateAuthority, "rust");
    assert.equal(health.protocol, 1);
  });

  test("create, apply and revision CAS", () => {
    const runId = "2026-10-25T00-00-01";
    const created = client.create(runId, base(runId));
    assert.equal(created.rev, 1);
    const next = { ...created.state, runState: "RUNNING", currentPhase: 1 };
    const applied = client.write(runId, next);
    assert.equal(applied.rev, 2);
    assert.equal(applied.state.runState, "RUNNING");
    // The adapter reports the revision the authority committed, not a local guess.
    assert.equal(client.cached(runId).rev, 2);
  });

  test("unknown outcome stays pending until resolved", () => {
    const runId = "2026-10-25T00-00-02";
    client.create(runId, base(runId));
    client.intent(runId, { opId: "op-1", op: "dispatch", stage: "RUN" });
    client.result(runId, { opId: "op-1", outcome: "unknown" });
    const read = client.read(runId);
    assert.equal(read.pending.length, 1);
    assert.equal(read.pending[0].outcome, "unknown");
    client.resolve(runId, { opId: "op-1", outcome: "done" });
    assert.equal(client.read(runId).pending.length, 0);
  });

  test("a duplicate intent never becomes two effects", () => {
    const runId = "2026-10-25T00-00-03";
    client.create(runId, base(runId));
    const first = client.intent(runId, { opId: "op-dup", op: "post" });
    const before = first.rev;
    client.intent(runId, { opId: "op-dup", op: "post" });
    assert.equal(client.read(runId).rev, before);
  });

  test("terminal finality: a stale completion callback cannot resurrect a run", () => {
    const runId = "2026-10-25T00-00-04";
    client.create(runId, base(runId));
    client.write(runId, { ...client.read(runId).state, runState: "RUNNING" });
    client.write(runId, { ...client.read(runId).state, runState: "COMPLETED" });
    const terminal = client.read(runId).state;
    assert.throws(
      () => client.write(runId, { ...terminal, runState: "RUNNING" }),
      (error) => error.code === "TERMINAL_FINALITY",
    );
    assert.equal(client.read(runId).state.runState, "COMPLETED");
  });

  test("a direct state.json writer is overwritten from the journal", () => {
    const runId = "2026-10-25T00-00-05";
    client.create(runId, base(runId));
    client.write(runId, { ...client.read(runId).state, runState: "RUNNING" });
    const path = join(root, runId, "state.json");
    const rogue = JSON.parse(readFileSync(path, "utf8"));
    rogue.runState = "COMPLETED";
    writeFileSync(path, JSON.stringify(rogue, null, 2));
    // The next authoritative write repairs the projection by replaying the
    // journal first; the rogue value never becomes the state.
    const repaired = client.write(runId, { ...client.read(runId).state, completedThrough: 1 });
    assert.equal(repaired.state.runState, "RUNNING");
    assert.equal(JSON.parse(readFileSync(path, "utf8")).runState, "RUNNING");
  });

  test("a second coordinator is refused while the lease is live", () => {
    const runId = "2026-10-25T00-00-06";
    client.create(runId, base(runId));
    const other = createAuthorityClient({ socketPath: socket(), token, ownerId: "second-coordinator" });
    assert.throws(() => other.write(runId, { ...client.read(runId).state, completedThrough: 1 }), (error) => error.code === "OWNER_ALIVE");
  });

  test("a lease heartbeat keeps this coordinator authoritative", () => {
    const runId = "2026-10-25T00-00-07";
    client.create(runId, base(runId));
    assert.deepEqual(client.heartbeatAll(), []);
  });

  test("a settled opId is idempotent, never a second effect", () => {
    const runId = "2026-10-25T00-00-11";
    client.create(runId, base(runId));
    client.intent(runId, { opId: "op-s", op: "post", payloadDigest: "p1" });
    client.result(runId, { opId: "op-s", outcome: "done", remoteId: "t-9" });
    const rev = client.read(runId).rev;
    const replay = client.intent(runId, { opId: "op-s", op: "post", payloadDigest: "p1" });
    assert.equal(replay.duplicate, true);
    assert.equal(replay.settled, true);
    assert.equal(replay.outcome, "done");
    assert.equal(replay.remoteId, "t-9");
    assert.equal(client.read(runId).rev, rev);
    assert.throws(
      () => client.intent(runId, { opId: "op-s", op: "post", payloadDigest: "p2" }),
      (error) => error.code === "OP_ID_CONFLICT",
    );
    assert.equal(client.read(runId).rev, rev);
  });

  test("intent and result advance the cached revision (no STALE_REV after a commit)", () => {
    const runId = "2026-10-25T00-00-10";
    client.create(runId, base(runId));
    const state = { ...client.read(runId).state };
    const before = client.cached(runId).rev;
    client.intent(runId, { opId: "op-seq", op: "dispatch", payloadDigest: "d" });
    client.result(runId, { opId: "op-seq", outcome: "done" });
    assert.equal(client.cached(runId).rev, before + 2);
    // Uses the cached revision; without the post-commit update this is STALE_REV.
    const applied = client.write(runId, { ...state, completedThrough: 1 });
    assert.equal(applied.ok, true);
  });

  test("operator acceptance of a COMPLETED_UNREVIEWED run is allowed", () => {
    const runId = "2026-10-25T00-00-12";
    client.create(runId, base(runId));
    client.write(runId, { ...client.read(runId).state, runState: "RUNNING" });
    client.write(runId, { ...client.read(runId).state, runState: "COMPLETED_UNREVIEWED" });
    const accepted = client.write(runId, {
      ...client.read(runId).state,
      runState: "COMPLETED_OPERATOR_ACCEPTED",
    });
    assert.equal(accepted.state.runState, "COMPLETED_OPERATOR_ACCEPTED");
    assert.throws(
      () => client.write(runId, { ...client.read(runId).state, runState: "RUNNING" }),
      (error) => error.code === "TERMINAL_FINALITY",
    );
  });

  test("rollback is refused against the CURRENT lease, not the cached marker", () => {
    const runId = "2026-10-25T00-00-08";
    const owner = createAuthorityClient({ socketPath: socket(), token, ownerId: "rollback-owner" });
    owner.create(runId, base(runId));
    const env = { ...process.env, ORCHESTRA_RUST_AUTHORITY_TOKEN: token };
    assert.throws(
      () => requestAuthorityRollback({ runDir: join(root, runId), runId, env }),
      (error) => error.code === "OWNER_ALIVE",
    );
    // The legacy writer guard goes through the same authority decision.
    assert.throws(
      () =>
        assertLocalWriteAllowed(join(root, runId), runId, {
          env: {
            ...env,
            ORCHESTRA_RUST_AUTHORITY_ROLLBACK: "1",
            ORCHESTRA_RUST_ROLLBACK_CONFIRM: runId,
          },
        }),
      (error) => error.code === "OWNER_ALIVE",
    );
    owner.releaseAll();
    const ok = requestAuthorityRollback({ runDir: join(root, runId), runId, env });
    assert.equal(ok.rollback, true);
    assert.ok(ok.retired.includes("journal.jsonl"));
    assert.equal(existsSync(join(root, runId, "journal.jsonl")), false);
  });
});

describe("authority adapter failure modes", () => {
  const token = "b".repeat(64);
  const make = (runner) =>
    createAuthorityClient({ socketPath: "/tmp/does-not-matter.sock", token, runner });

  test("transport failure throws and never invents a revision", () => {
    const client = make(() => ({ status: 1, stdout: "", stderr: "boom", error: new Error("spawn") }));
    assert.throws(() => client.health(), (error) => error.code === "TRANSPORT");
  });

  test("timeout is reported as TIMEOUT, not as a successful write", () => {
    const client = make(() => ({ status: null, signal: "SIGTERM", stdout: "", stderr: "", error: Object.assign(new Error("timed out"), { code: "ETIMEDOUT" }) }));
    assert.throws(() => client.health(), (error) => error.code === "TIMEOUT");
  });

  test("malformed response is refused", () => {
    const client = make(() => ({ status: 0, stdout: "not json\n", stderr: "" }));
    assert.throws(() => client.health(), (error) => error.code === "INVALID_RESPONSE");
  });

  test("protocol version refusal surfaces unchanged", () => {
    const client = make(() => ({ status: 0, stdout: JSON.stringify({ ok: false, error: "PROTOCOL_VERSION", supported: 1 }) + "\n" }));
    assert.throws(() => client.health(), (error) => error.code === "PROTOCOL_VERSION");
  });

  test("a lost acknowledgement surfaces STALE_REV so the caller reconciles", () => {
    const responses = [
      { ok: true, rev: 0, state: { runState: "UNINITIALIZED" }, pending: [] },
      { ok: true, epoch: 1, rev: 0, expiresAtMs: Date.now() + 60000 },
      { ok: true, rev: 1, state: { runId: "r", runState: "PLANNED" }, digest: "x" },
      { ok: true, rev: 2, state: { runId: "r", runState: "RUNNING" }, digest: "y" },
      { ok: false, error: "STALE_REV", currentRev: 3 },
    ];
    const calls = [];
    const client = createAuthorityClient({
      socketPath: "/tmp/x.sock",
      token,
      runner: (_cli, _socket, request) => {
        calls.push(request.op);
        return { status: 0, stdout: JSON.stringify(responses.shift()) + "\n" };
      },
    });
    client.create("r", { runId: "r", runState: "PLANNED" });
    client.write("r", { runId: "r", runState: "RUNNING" });
    assert.throws(() => client.write("r", { runId: "r", runState: "RUNNING", completedThrough: 1 }), (error) => error.code === "STALE_REV" && error.currentRev === 3);
    assert.deepEqual(calls, ["read", "acquire", "create", "apply", "apply"]);
  });

  test("resolve forwards the recorded error class", () => {
    // Live probe 2026-10-25: the adapter dropped errorClass on resolve, so a
    // replayed failure lost its classification. The request must carry it.
    const seen = [];
    const client = createAuthorityClient({
      socketPath: "/tmp/x.sock",
      token,
      runner: (_cli, _socket, request) => {
        seen.push(request);
        if (request.op === "read") {
          return { status: 0, stdout: JSON.stringify({ ok: true, rev: 1, state: { runState: "RUNNING", runId: "r" } }) + "\n" };
        }
        if (request.op === "acquire") {
          return { status: 0, stdout: JSON.stringify({ ok: true, epoch: 1, rev: 1, expiresAtMs: Date.now() + 60000 }) + "\n" };
        }
        return { status: 0, stdout: JSON.stringify({ ok: true, rev: 2 }) + "\n" };
      },
    });
    client.resolve("r", { opId: "op-1", outcome: "failed", errorClass: "QUOTA" });
    assert.equal(seen.find((r) => r.op === "resolve").errorClass, "QUOTA");
  });

  test("the adapter refuses a token that cannot be the authority token", () => {
    assert.throws(() => createAuthorityClient({ socketPath: "/tmp/x.sock", token: "short" }), (error) => error.code === "INVALID_TOKEN_SHAPE");
  });
});
