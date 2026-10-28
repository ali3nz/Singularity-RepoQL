// lib/observer-sink.mjs — V3.4.0 (plan §16.3/16.9, D33). Best-effort append-only
// lifecycle event sink for the AgentHome visual stack. METADATA ONLY: never
// prompt text, evidence, tool args, URLs, secrets, or arbitrary paths (D33).
// Never throws into the coordinator path: every failure is swallowed into a
// returned warning (plan 16.9 pseudo-behavior). Deduplication is by eventId
// only and has NO effect on case authority (plan 16.4).
import { createHash } from "node:crypto";
import { appendFileSync, mkdirSync } from "node:fs";
import { join, dirname } from "node:path";

const ALLOWED_STATES = new Set([
  "STARTING", "COORDINATING", "PLANNING", "THINKING", "IMPLEMENTING", "READING",
  "CONSULTING_SOL", "WAITING_FOR_SOL", "REVIEWING", "VALIDATING",
  "WAITING_FOR_OPERATOR", "PAUSED", "RETRYING", "FAILED", "COMPLETE", "IDLE",
]);
const ALLOWED_TRANSITIONS = new Set([
  "run_allocated", "case_started", "agent_allocated", "phase_started", "agent_thinking",
  "sol_consult_started", "sol_consult_finished", "operator_wait_started", "operator_wait_finished",
  "retry_started", "phase_completed", "agent_released", "run_paused", "run_resumed",
  "run_failed", "run_completed",
]);

// Deterministic event id from stable lifecycle identity (plan 16.4).
export function observerEventId({ runNumber, caseId, caseRev, agentSessionId, transition }) {
  return createHash("sha256").update(`${runNumber}|${caseId}|${caseRev}|${agentSessionId}|${transition}`).digest("hex").slice(0, 24);
}

// Sanitizer: keeps ONLY the allowlist. Unknown fields are dropped silently —
// the sanitizer is the security boundary (D33: observer events contain
// metadata only). Confidential runs keep the same allowlist (safe engine
// labels are fine; task content never enters).
export function sanitizeObserverEvent(ev) {
  return {
    schema: 2,
    eventId: ev.eventId,
    ts: ev.ts,
    runNumber: ev.runNumber ?? null,
    caseId: ev.caseId ?? null,
    caseRev: ev.caseRev ?? null,
    agentSessionId: ev.agentSessionId ?? null,
    displayName: ev.displayName ?? null,
    visualRole: ev.visualRole ?? null,
    phase: ev.phase ?? null,
    state: ALLOWED_STATES.has(ev.state) ? ev.state : null,
    engine: ev.engine ?? null,
    status: ev.status ?? null,
    transition: ev.transition ?? null,
  };
}

// Emit one event. Best-effort: returns { ok, warning? } — NEVER throws.
export function emitObserverEvent(eventsPath, ev, { enabled = true } = {}) {
  if (!enabled) return { ok: false, warning: "observer disabled" };
  try {
    if (!ALLOWED_TRANSITIONS.has(ev.transition)) return { ok: false, warning: `transition not allowlisted: ${ev.transition}` };
    const e = {
      ...ev,
      eventId: ev.eventId ?? observerEventId(ev),
      ts: ev.ts ?? new Date().toISOString(),
    };
    const safe = sanitizeObserverEvent(e);
    mkdirSync(dirname(eventsPath), { recursive: true });
    appendFileSync(eventsPath, JSON.stringify(safe) + "\n");
    return { ok: true, eventId: safe.eventId };
  } catch (e2) {
    return { ok: false, warning: `observer append failed: ${String(e2?.message ?? e2).slice(0, 80)}` };
  }
}
