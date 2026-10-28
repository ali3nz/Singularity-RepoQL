// rust-effects.mjs — durable external-effect registration for the coordinator.
//
// Sol gate finding 1 (2026-10-25): the Rust authority owned run state, but the
// JavaScript coordinator still dispatched OpenCode/Freebuff effects without a
// journalled intent. This module puts the intent on the REAL dispatch path:
//
//   durable intent (Rust) -> external call -> done | failed | unknown
//
// Contract:
//   * an intent is committed BEFORE the external call;
//   * an opId that already settled is never executed again — the recorded
//     outcome is returned instead (idempotent replay);
//   * an opId that is still pending/unresolved refuses redispatch; the caller
//     must reconcile (probe the remote system) before trying again;
//   * an ambiguous failure (timeout, lost acknowledgement) is recorded as
//     `unknown`, never as `failed`, so recovery cannot silently retry it;
//   * a cancelled or finished run refuses new effects.
//
// Outside a run scope (or with the authority disabled) every helper is inert,
// so the coordinator behaves exactly as before on an unmanaged run.

import { createHash } from "node:crypto";
import { AuthorityError } from "./rust-authority.mjs";

const FINISHED = new Set(["ABORTED", "COMPLETED", "COMPLETED_OPERATOR_ACCEPTED"]);

let scope = null;

/** Enters an effect scope for `runId`; returns the previous scope for nesting. */
export function beginEffects(runId, authority) {
  const previous = scope;
  scope = authority && runId ? { runId, authority } : null;
  return previous;
}

/** Restores the previous scope (or leaves it) — always call in a finally. */
export function endEffects(previous = null) {
  scope = previous;
}

export function effectsActive() {
  return Boolean(scope);
}

export function effectScope() {
  return scope;
}

export function digestOf(value) {
  return createHash("sha256").update(JSON.stringify(value ?? null)).digest("hex");
}

/** Stable op id for an effect: same logical action -> same opId. */
export function effectKey(op, payload) {
  return `${op}:${digestOf(payload).slice(0, 24)}`;
}

/**
 * Commits the durable intent. Returns null when effects are not being tracked
 * (unmanaged run), otherwise { opId, replayed, outcome, remoteId }.
 */
export function effectIntent({ op, key = null, payload = null, stage = null } = {}) {
  if (!scope) return null;
  const { runId, authority } = scope;
  const state = authority.read(runId).state;
  const runState = state?.runState;
  if (FINISHED.has(runState)) {
    throw new AuthorityError("RUN_FINISHED", `${op} refused: run ${runId} is ${runState}`);
  }
  const opId = key ?? effectKey(op, payload);
  const payloadDigest = digestOf(payload);
  const reply = authority.intent(runId, { opId, op, stage, payloadDigest });
  if (reply?.settled) {
    return {
      opId,
      replayed: true,
      outcome: reply.outcome ?? null,
      remoteId: reply.remoteId ?? null,
      errorClass: reply.errorClass ?? null,
    };
  }
  if (reply?.pending) {
    throw new AuthorityError(
      "EFFECT_PENDING",
      `${opId} is unresolved — probe the remote system and resolve() before redispatch`,
    );
  }
  return { opId, replayed: false };
}

/** Records the outcome. A missing scope or intent is a no-op. */
export function effectResult(intent, outcome, extra = {}) {
  if (!scope || !intent?.opId) return null;
  return scope.authority.result(scope.runId, { opId: intent.opId, outcome, ...extra });
}

/**
 * Timeout / lost acknowledgement / transport trouble is AMBIGUOUS: the remote
 * side may have executed. Anything the remote explicitly refused is `failed`.
 */
/**
 * A dispatch helper may RESOLVE with a structured failure ({ok:false,
 * failureClass}) instead of throwing — an exhausted provider quota is a real
 * failed effect, not a success. Map it honestly.
 */
/**
 * Commits a successful acknowledgement and converts any failure into
 * EFFECT_ACK_FAILED. Callers must rethrow that error and must NOT attempt a
 * second result commit: the remote effect succeeded, so a `failed` record would
 * be a lie (Sol gate round 2, 2026-10-25 finding 1).
 */
export function acknowledgeEffect(intent, value = {}, extra = {}) {
  try {
    return effectResult(intent, "done", {
      remoteId: value?.remoteId ?? value?.id ?? undefined,
      ...extra,
    });
  } catch (error) {
    throw new AuthorityError("EFFECT_ACK_FAILED", String(error?.message ?? error), {
      opId: intent?.opId ?? null,
    });
  }
}

/**
 * A replayed effect may only be treated as delivered when the recorded outcome
 * is `done`. A replayed failure must surface as a failure, with the recorded
 * classification preserved (Sol gate round 2, 2026-10-25 finding 2).
 */
export function assertReplayDelivered(intent, op = "effect") {
  if (!intent?.replayed) return;
  if (intent.outcome === "done") return;
  throw new AuthorityError(
    "EFFECT_REPLAY_FAILED",
    `${op} ${intent.opId} is recorded ${intent.outcome ?? "unresolved"} — not a successful delivery`,
    {
      opId: intent.opId,
      // effectIntent() records the class as `errorClass`; a replay descriptor
      // built elsewhere may already say `failureClass`. Read both (Sol round 3).
      failureClass:
        intent.errorClass ?? intent.failureClass ?? String(intent.outcome ?? "UNKNOWN").toUpperCase(),
      outcome: intent.outcome ?? null,
    },
  );
}

export function classifyEffectValue(value) {
  if (!value || typeof value !== "object" || value.ok !== false) return "done";
  const cls = String(value.failureClass ?? "").toUpperCase();
  if (["UNKNOWN", "TIMEOUT", "NETWORK", "TRANSPORT", "AMBIGUOUS"].includes(cls)) return "unknown";
  return "failed";
}

export function classifyEffectError(error) {
  const code = String(error?.code ?? error?.name ?? "").toUpperCase();
  const message = String(error?.message ?? "");
  if (/ETIMEDOUT|ESOCKETTIMEDOUT|TIMEOUT|SIGTERM|ECONNRESET|EPIPE/.test(code)) return "unknown";
  if (/timed? ?out|socket hang up|no response|network|ECONNRESET/i.test(message)) return "unknown";
  return "failed";
}

/**
 * Runs `fn` as a journalled effect. When effects are not tracked it simply
 * calls `fn`. A replayed (already settled) effect is NOT executed again.
 */
export async function withEffect({ op, key = null, payload = null, stage = null }, fn) {
  const intent = effectIntent({ op, key, payload, stage });
  if (!intent) return fn(null);
  if (intent.replayed) {
    // Preserve the CALLER's expected shape: a replayed successful effect must
    // look successful on resume, and a replayed failure must look failed — a
    // bare replay descriptor would be read as `ok:false` by dispatch callers
    // (Sol gate, 2026-10-25 recovery concern).
    const ok = intent.outcome === "done";
    return {
      ok,
      replayed: true,
      outcome: intent.outcome ?? null,
      remoteId: intent.remoteId ?? null,
      opId: intent.opId,
      // Preserve the ORIGINAL classification (e.g. QUOTA), not a generic label.
      failureClass: ok ? undefined : intent.errorClass ?? String(intent.outcome ?? "UNKNOWN").toUpperCase(),
    };
  }
  try {
    const value = await fn(intent);
    try {
      effectResult(intent, classifyEffectValue(value), {
        remoteId: value?.remoteId ?? value?.id ?? undefined,
        errorClass: value?.ok === false ? String(value.failureClass ?? "FAILED") : undefined,
      });
    } catch (error) {
      // The effect succeeded but the acknowledgement could not be committed.
      // That is not a licence to retry: surface the reconciliation need.
      throw new AuthorityError("EFFECT_ACK_FAILED", String(error?.message ?? error), {
        opId: intent.opId,
      });
    }
    return value;
  } catch (error) {
    if (error?.code === "EFFECT_ACK_FAILED") throw error;
    const outcome = classifyEffectError(error);
    try {
      effectResult(intent, outcome, { errorClass: String(error?.code ?? error?.name ?? "ERROR") });
    } catch {
      /* the remote failure still propagates; reconciliation covers the record */
    }
    throw error;
  }
}
