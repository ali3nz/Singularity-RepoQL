// rust-authority.mjs — the coordinator's client for the Rust state authority.
//
// The Rust service owns run state: it validates transitions, fences writers with
// a lease epoch, and commits to its journal before the projection is written.
// This adapter is the ONLY way the JavaScript coordinator may persist run state
// once `ORCHESTRA_RUST_AUTHORITY` is set.
//
// Contract (reviewed with Sol, 2026-10-24):
//   * fail closed — transport, protocol, fencing and revision failures throw;
//     the caller never falls back to a local write;
//   * unknown never becomes success or failure — the caller must reconcile;
//   * no automatic retry of a mutation whose acknowledgement was lost, because
//     the authority may already have committed it;
//   * the adapter reports the authoritative revision, not a local guess.

import { spawnSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { hostname } from "node:os";
import { dirname, join } from "node:path";

export const PROTOCOL_VERSION = 1;
export const AUTHORITY_SCHEMA = "orchestra-authority/1";
/** The FROZEN authority protocol env names. Do not rename: they are the contract. */
export const AUTHORITY_ENV = Object.freeze({
  AUTHORITY: "ORCHESTRA_RUST_AUTHORITY",
  ROLLBACK: "ORCHESTRA_RUST_AUTHORITY_ROLLBACK",
  TOKEN: "ORCHESTRA_RUST_AUTHORITY_TOKEN",
  TOKEN_FILE: "ORCHESTRA_RUST_AUTHORITY_TOKEN_FILE",
  LEASE_MS: "ORCHESTRA_RUST_AUTHORITY_LEASE_MS",
});

export const DEFAULT_LEASE_MS = Number(process.env.ORCHESTRA_RUST_AUTHORITY_LEASE_MS) || 60_000;
const CLIENT_TIMEOUT_MS = 8_000;
const MAX_RESPONSE_BYTES = 8 * 1024 * 1024;

export class AuthorityError extends Error {
  constructor(code, detail = "", extra = {}) {
    super(`${code}${detail ? `: ${detail}` : ""}`);
    this.name = "AuthorityError";
    this.code = code;
    this.detail = detail;
    Object.assign(this, extra);
  }
}

function defaultRunner(cliPath, socketPath, request, { timeoutMs }) {
  return spawnSync(process.execPath, [cliPath, socketPath], {
    input: JSON.stringify(request),
    encoding: "utf8",
    timeout: timeoutMs,
    maxBuffer: MAX_RESPONSE_BYTES,
    env: process.env,
  });
}

/**
 * @param {object} options
 * @param {string} options.socketPath     authority socket inside the run tree
 * @param {string} options.token          authority bearer token
 * @param {string} [options.ownerId]      stable id for this coordinator process
 * @param {number} [options.leaseMs]      lease TTL requested from the authority
 * @param {Function} [options.runner]     injectable spawnSync (tests)
 * @param {string} [options.cliPath]      injectable CLI path (tests)
 */
export function createAuthorityClient({
  socketPath,
  token,
  ownerId = `${hostname()}:${process.pid}`,
  leaseMs = DEFAULT_LEASE_MS,
  timeoutMs = CLIENT_TIMEOUT_MS,
  runner = defaultRunner,
  cliPath = new URL("./rust-authority-cli.mjs", import.meta.url).pathname,
} = {}) {
  if (!socketPath) throw new AuthorityError("MISSING_SOCKET");
  // The token lives next to the socket (0600, same uid). Callers may override
  // it explicitly; nothing is ever read from a public location.
  const resolvedToken =
    token ||
    resolveAuthorityToken() ||
    (() => {
      try {
        return readFileSync(join(dirname(socketPath), "authority.token"), "utf8").trim();
      } catch {
        return "";
      }
    })();
  if (!resolvedToken || String(resolvedToken).length < 32) {
    throw new AuthorityError("INVALID_TOKEN_SHAPE");
  }
  token = resolvedToken;

  const runs = new Map();
  let heartbeatTimer = null;

  function call(op) {
    const request = { v: PROTOCOL_VERSION, token, ownerId, ...op };
    let result;
    try {
      result = runner(cliPath, socketPath, request, { timeoutMs });
    } catch (error) {
      throw new AuthorityError("TRANSPORT", String(error?.message ?? error).slice(0, 200));
    }
    if (result?.error) {
      const timedOut = result.error?.code === "ETIMEDOUT" || result.signal === "SIGTERM";
      throw new AuthorityError(timedOut ? "TIMEOUT" : "TRANSPORT", String(result.error.message ?? ""));
    }
    const stdout = String(result?.stdout ?? "");
    if (!stdout.trim()) {
      throw new AuthorityError("TRANSPORT", `no response (rc=${result?.status ?? "?"})`);
    }
    let payload;
    try {
      payload = JSON.parse(stdout.split("\n")[0]);
    } catch {
      throw new AuthorityError("INVALID_RESPONSE");
    }
    if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
      throw new AuthorityError("INVALID_RESPONSE");
    }
    return payload;
  }

  function expectOk(payload, context) {
    if (payload.ok !== true) {
      const extra = {};
      for (const key of ["currentRev", "epoch", "expiresAtMs", "owner", "reason", "supported"]) {
        if (payload[key] !== undefined) extra[key] = payload[key];
      }
      throw new AuthorityError(
        String(payload.error ?? payload.reason ?? "AUTHORITY_REFUSED").toUpperCase(),
        payload.detail ? String(payload.detail) : context ?? "",
        extra,
      );
    }
    return payload;
  }

  function statePath(runId) {
    return join(dirname(socketPath), "..", runId, "state.json");
  }

  function remember(runId, payload) {
    const entry = {
      epoch: runs.get(runId)?.epoch ?? payload.epoch,
      rev: Number(payload.rev ?? 0),
      digest: payload.digest ?? null,
    };
    runs.set(runId, entry);
    return entry;
  }

  function acquire(runId) {
    const payload = expectOk(
      call({ op: "acquire", runId, ownerId, ttlMs: leaseMs }),
      `acquire ${runId}`,
    );
    const entry = { epoch: payload.epoch, rev: Number(payload.rev ?? 0), digest: null };
    runs.set(runId, entry);
    return entry;
  }

  function ensure(runId, { forWrite = false, allowNew = false } = {}) {
    if (!runId || typeof runId !== "string") throw new AuthorityError("INVALID_RUN_ID");
    const cached = runs.get(runId);
    if (cached) {
      if (!forWrite) return cached;
      if (!cached.epoch) acquire(runId);
      if (cached.rev === 0 && existsSync(statePath(runId))) {
        const adopted = expectOk(call({ op: "adopt", runId, epoch: runs.get(runId).epoch }));
        remember(runId, adopted);
      }
      startHeartbeat();
      return runs.get(runId);
    }
    const read = expectOk(call({ op: "read", runId }), `read ${runId}`);
    const entry = {
      epoch: null,
      rev: Number(read.rev ?? 0),
      digest: read.digest ?? null,
      state: read.state,
    };
    runs.set(runId, entry);
    if (!forWrite) return entry;
    // A legacy run has a state.json but no authority journal yet: adopt it
    // exactly once, under a fresh lease, before any mutation.
    acquire(runId);
    if (entry.rev === 0) {
      if (existsSync(statePath(runId))) {
        const adopted = expectOk(call({ op: "adopt", runId, epoch: runs.get(runId).epoch }));
        remember(runId, adopted);
      } else if (!allowNew) {
        throw new AuthorityError("NOT_INITIALIZED", runId);
      }
    }
    startHeartbeat();
    return runs.get(runId);
  }

  function read(runId) {
    const payload = expectOk(call({ op: "read", runId }), `read ${runId}`);
    const entry = runs.get(runId) ?? { epoch: null, rev: 0, digest: null };
    runs.set(runId, entry);
    entry.rev = Number(payload.rev ?? entry.rev);
    entry.digest = payload.digest ?? entry.digest;
    entry.state = payload.state;
    return payload;
  }

  /** Creates a run; a pre-existing journal is never overwritten. */
  function create(runId, state) {
    const entry = ensure(runId, { forWrite: true, allowNew: true });
    if (entry.rev > 0) {
      const current = read(runId);
      return { ...current, existing: true };
    }
    const payload = expectOk(
      call({ op: "create", runId, epoch: entry.epoch, state }),
      `create ${runId}`,
    );
    remember(runId, payload);
    return payload;
  }

  /** Applies a fully-formed run document with CAS on the authoritative revision. */
  function write(runId, state) {
    const entry = ensure(runId, { forWrite: true, allowNew: true });
    if (entry.rev === 0) return create(runId, state);
    const payload = expectOk(
      call({
        op: "apply",
        runId,
        epoch: entry.epoch,
        expectedRev: entry.rev,
        state,
      }),
      `apply ${runId}`,
    );
    remember(runId, payload);
    return payload;
  }

  /** Durable effect intent: must be committed before the external call. */
  function intent(runId, { opId, op, stage, payloadDigest } = {}) {
    const entry = ensure(runId, { forWrite: true });
    const payload = expectOk(
      call({ op: "intent", runId, epoch: entry.epoch, opId, effect: op, stage, payloadDigest }),
      `intent ${runId}`,
    );
    // A commit advances the authority revision even when the payload type does
    // not carry a state document; a later write() must not present a stale rev.
    remember(runId, payload);
    return payload;
  }

  /** Reports an outcome; `unknown` stays pending until `resolve`. */
  function result(runId, { opId, outcome, remoteId, errorClass, detail } = {}) {
    if (!["done", "failed", "unknown"].includes(outcome)) {
      throw new AuthorityError("INVALID_OUTCOME", String(outcome));
    }
    const entry = ensure(runId, { forWrite: true });
    const payload = expectOk(
      call({
        op: "result",
        runId,
        epoch: entry.epoch,
        opId,
        outcome,
        remoteId,
        errorClass,
        detail,
      }),
      `result ${runId}`,
    );
    remember(runId, payload);
    return payload;
  }

  /** Closes a previously-unknown intent after an external probe. */
  function resolve(runId, { opId, outcome, remoteId, errorClass, detail } = {}) {
    if (!["done", "failed"].includes(outcome)) {
      throw new AuthorityError("INVALID_OUTCOME", String(outcome));
    }
    const entry = ensure(runId, { forWrite: true });
    // errorClass must survive resolution too: a replay hands it back to the
    // caller (live probe 2026-10-25 caught the adapter dropping it here).
    const payload = expectOk(
      call({ op: "resolve", runId, epoch: entry.epoch, opId, outcome, remoteId, errorClass, detail }),
      `resolve ${runId}`,
    );
    remember(runId, payload);
    return payload;
  }

  function cancel(runId, reason) {
    const entry = ensure(runId, { forWrite: true });
    return expectOk(
      call({ op: "cancel", runId, epoch: entry.epoch, expectedRev: entry.rev, reason }),
      `cancel ${runId}`,
    );
  }

  function heartbeatAll() {
    const failures = [];
    for (const [runId, entry] of runs) {
      if (!entry.epoch) continue;
      try {
        call({ op: "heartbeat", runId, epoch: entry.epoch });
      } catch (error) {
        failures.push({ runId, error: error.code ?? "HEARTBEAT_FAILED" });
      }
    }
    return failures;
  }

  function startHeartbeat(intervalMs = Math.max(250, Math.floor(leaseMs / 3))) {
    if (heartbeatTimer) return;
    heartbeatTimer = setInterval(() => {
      const failures = heartbeatAll();
      if (failures.length) {
        // A lost lease is fatal for this coordinator: surface it loudly rather
        // than letting the next write silently fail mid-phase.
        console.error(
          `rust-authority: lease heartbeat failed (${failures
            .map((f) => `${f.runId}=${f.error}`)
            .join(", ")}); a newer coordinator has taken authority`,
        );
      }
    }, intervalMs);
    if (typeof heartbeatTimer.unref === "function") heartbeatTimer.unref();
  }

  function releaseAll() {
    if (heartbeatTimer) clearInterval(heartbeatTimer);
    heartbeatTimer = null;
    for (const [runId, entry] of runs) {
      if (!entry.epoch) continue;
      try {
        call({ op: "release", runId, epoch: entry.epoch });
      } catch {
        /* lease expiry is the backstop */
      }
    }
    runs.clear();
  }

  function health() {
    return expectOk(call({ op: "health" }), "health");
  }

  function snapshot(limit = 200) {
    return expectOk(call({ op: "snapshot", limit }), "snapshot");
  }

  return {
    ownerId,
    socketPath,
    health,
    snapshot,
    ensure,
    read,
    create,
    write,
    intent,
    result,
    resolve,
    cancel,
    heartbeatAll,
    releaseAll,
    close: releaseAll,
    cached: (runId) => runs.get(runId),
  };
}

/** Reads the authority token the way the service resolves it. */
export function resolveAuthorityToken(env = process.env) {
  if (env.ORCHESTRA_RUST_AUTHORITY_TOKEN) return env.ORCHESTRA_RUST_AUTHORITY_TOKEN.trim();
  const file = env.ORCHESTRA_RUST_AUTHORITY_TOKEN_FILE;
  if (!file) return "";
  try {
    return readFileSync(file, "utf8").trim();
  } catch {
    return "";
  }
}

/**
 * Guard for the legacy writer. Returns {allowed:true} for an unmanaged run;
 * throws when the run is owned by the authority. A rollback is only allowed
 * with two explicit signals and no live lease — never silently.
 */
export function requestAuthorityRollback({
  runDir,
  runId,
  env = process.env,
  runner = defaultRunner,
  cliPath = new URL("./rust-authority-cli.mjs", import.meta.url).pathname,
  timeoutMs = CLIENT_TIMEOUT_MS,
} = {}) {
  const socketPath =
    env.ORCHESTRA_RUST_AUTHORITY ||
    join(dirname(runDir), ".rust-authority", "authority.sock");
  if (!existsSync(socketPath)) throw new AuthorityError("AUTHORITY_UNAVAILABLE", socketPath);
  const token =
    resolveAuthorityToken(env) || (() => {
      try {
        return readFileSync(join(dirname(socketPath), "authority.token"), "utf8").trim();
      } catch {
        return "";
      }
    })();
  if (!token || token.length < 32) throw new AuthorityError("INVALID_TOKEN_SHAPE");
  const result = (() => {
    try {
      return runner(
        cliPath,
        socketPath,
        { v: PROTOCOL_VERSION, token, runId, op: "rollback", confirm: runId },
        { timeoutMs },
      );
    } catch (error) {
      throw new AuthorityError("TRANSPORT", String(error?.message ?? error).slice(0, 200));
    }
  })();
  const stdout = String(result?.stdout ?? "");
  if (!stdout.trim()) throw new AuthorityError("TRANSPORT", "no rollback response");
  let payload;
  try {
    payload = JSON.parse(stdout.split("\n")[0]);
  } catch {
    throw new AuthorityError("INVALID_RESPONSE");
  }
  if (payload?.ok !== true) {
    throw new AuthorityError(
      String(payload?.reason ?? "ROLLBACK_REFUSED").toUpperCase(),
      payload?.detail ? String(payload.detail) : "",
      { owner: payload?.owner, expiresAtMs: payload?.expiresAtMs },
    );
  }
  return payload;
}

export function assertLocalWriteAllowed(
  runDir,
  runId,
  { env = process.env, now = Date.now(), rollback = requestAuthorityRollback } = {},
) {
  const marker = rustAuthorityMarker(runDir);
  if (!marker) return { allowed: true, rollback: false };
  const leaseLive = Number(marker.leaseExpiresAtMs ?? 0) > now;
  const rollbackWanted =
    env.ORCHESTRA_RUST_AUTHORITY_ROLLBACK === "1" &&
    env.ORCHESTRA_RUST_ROLLBACK_CONFIRM === runId;
  if (!rollbackWanted) {
    throw new AuthorityError(
      "RUST_AUTHORITY_ACTIVE",
      `run ${runId} is owned by the Rust state authority (rev ${marker.rev}, epoch ${marker.epoch}${leaseLive ? ", live lease" : ""}); refusing a direct state.json write. Set ORCHESTRA_RUST_AUTHORITY=<socket>, or roll back deliberately with ORCHESTRA_RUST_AUTHORITY_ROLLBACK=1 and ORCHESTRA_RUST_ROLLBACK_CONFIRM=${runId} while no coordinator is alive.`,
    );
  }
  // Retirement is decided by the authority itself, under the same run lock it
  // uses for mutations, against the CURRENT lease. The cached marker can be
  // stale (owner released, a new owner acquired), so it is never sufficient.
  const retiredBy = rollback({ runDir, runId, env });
  return { allowed: true, rollback: true, marker, retired: retiredBy.retired ?? [], epoch: retiredBy.quiescedAtMs };
}

/** True when the run document records Rust ownership. */
export function rustAuthorityMarker(runDir) {
  try {
    const marker = JSON.parse(readFileSync(join(runDir, "authority.json"), "utf8"));
    return marker?.stateAuthority === "rust" ? marker : null;
  } catch {
    return null;
  }
}
