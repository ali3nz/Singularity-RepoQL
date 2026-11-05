// lib/observer-bridge.mjs — V3.4.0 Phase 13 (ticket 088). Translates Orchestra
// lifecycle transitions (lib/observer-sink.mjs events) into Agent Office's
// native hook-event vocabulary (session_start / tool_start / tool_end /
// session_end, progress.ingest contract) so the unmodified upstream renders
// Orchestra agents. Adapter only: no upstream fork, no second event store —
// it APPENDS the translated line to the same events.jsonl the sink uses.
//
// Ticket 097 (2026-09-26, operator directive): every character carries an
// operator-facing NAME and its RUN NUMBER — "Buffy R014", "Sol R014" — where
// the run number matches the Discord thread ("Run 014 | ..."). Freebuff-side
// agents (workers, coordinator, solo runs) are "Buffy"; duo-consult engines
// are "Sol". The office fold (visual/Dockerfile patch) honors the `label`
// field these events carry.
import { appendFileSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";

// Map Orchestra state -> Agent Office "status" (its native animation states:
// idle / working / thinking / waiting / done / gone).
const STATUS_MAP = {
  STARTING: "idle", COORDINATING: "thinking", PLANNING: "thinking",
  THINKING: "thinking", IMPLEMENTING: "working", READING: "working",
  CONSULTING_SOL: "working", WAITING_FOR_SOL: "waiting",
  REVIEWING: "thinking", VALIDATING: "thinking",
  WAITING_FOR_OPERATOR: "waiting", PAUSED: "idle", RETRYING: "working",
  FAILED: "idle", COMPLETE: "done", IDLE: "idle",
};

// Map Orchestra visualRole -> a stable platform label (drives the agent's
// desk/label rendering; Agent Office is runtime-agnostic on this field).
// Ticket 097: the coordinator IS the requester (never a separate CEO persona) and
// CONSULTANT/SENIOR_TECH map to the Sol consultant character.
const PLATFORM_MAP = {
  CEO: "orchestra-buffy", SENIOR_TECH: "orchestra-sol",
  WORKER: "orchestra-buffy", PLANNER: "orchestra-planner",
  QUALITY: "orchestra-quality", VISION: "orchestra-vision",
  CONSULTANT: "orchestra-sol",
};

// Ticket 097: operator-facing character names. Worker seat ids (alpha/beta/
// gamma/delta) and the coordinator alias "CEO" all render as the requester; consult
// engines render as Sol. An engine value wins over displayName so a consult
// stays Sol even when displayName was recorded before the engine was picked.
const SEAT_RE = /^(CEO|coordinator|alpha|beta|gamma|delta|epsilon|zeta|eta|theta)$/i; // ticket 189: custom rosters add epsilon..theta
const ENGINE_SOL_RE = /sol|codex|cursor|luna|openrouter/i;

// Pure name derivation, exported for tests + call sites.
export function officeLabel(ev) {
  const raw = String(ev.displayName ?? ev.visualRole ?? "agent");
  const engine = String(ev.engine ?? "");
  let name;
  if (ENGINE_SOL_RE.test(engine) || ev.visualRole === "CONSULTANT") name = "Sol";
  else if (SEAT_RE.test(raw)) name = "Requester";
  else name = raw;
  const n = Number(ev.runNumber);
  const runNo = Number.isFinite(n) ? ` R${String(Math.trunc(n)).padStart(3, "0")}` : "";
  return { name, runNo, label: `${name}${runNo}` };
}

// Pure translator: observer event -> zero or more Agent Office events.
// Metadata only in, metadata only out (D33 holds downstream too: the Agent
// Office fields we emit are labels/status/tool names, never content).
export function translateToOfficeEvents(ev) {
  const out = [];
  const sid = `orch-${ev.runNumber ?? "x"}-${ev.agentSessionId ?? "x"}`;
  const plat = ev.officePlatform ?? PLATFORM_MAP[ev.visualRole] ?? "orchestra-agent";
  const { label } = officeLabel(ev);
  const runNo = ev.runNumber != null ? String(ev.runNumber).padStart(3, "0") : "";
  const base = { session_id: sid, platform: plat, ts: toTs(ev.ts) };
  // Ticket 118: pass the engine through so the visual fold can exempt codex
  // consult seats from the transient-Sol ban (operator exception).
  const engine = String(ev.engine ?? "");
  if (engine) base.engine = engine;
  const detail = runNo ? `Run ${runNo}` : "";
  if (ev.transition === "run_allocated" || ev.transition === "case_started" || ev.transition === "agent_allocated") {
    out.push({ ...base, event: "session_start", label });
  }
  if (ev.transition === "run_failed" || ev.transition === "run_completed" || ev.transition === "agent_released") {
    out.push({ ...base, event: "session_end" });
    return out;
  }
  if (ev.transition === "phase_started" || ev.transition === "retry_started" || ev.transition === "agent_thinking" || ev.transition === "sol_consult_started" || ev.transition === "operator_wait_started" || ev.transition === "run_paused" || ev.transition === "run_resumed" || ev.transition === "phase_completed" || ev.transition === "sol_consult_finished" || ev.transition === "operator_wait_finished") {
    const status = STATUS_MAP[ev.state] ?? "working";
    // tool_start => status working; tool_end => thinking; approval_request => waiting.
    if (status === "waiting") {
      out.push({ ...base, event: "approval_request", label, command: `${detail} waiting: ${ev.state}` });
    } else if (status === "thinking" || status === "done" || status === "idle") {
      out.push({ ...base, event: "tool_end", status: "ok", label });
    } else {
      out.push({ ...base, event: "tool_start", tool_name: "orchestra", activity: "working", label, preview: detail ? `${detail} — ${ev.phase ?? ""}`.trim() : (ev.phase ?? "") });
    }
  }
  return out;
}

function toTs(iso) {
  const t = Date.parse(iso ?? "");
  return Number.isFinite(t) ? t / 1000 : Date.now() / 1000;
}

// Append translated events to the SAME office feed. Best-effort, never throws.
export function emitOfficeEvents(eventsPath, observerEvent) {
  try {
    mkdirSync(dirname(eventsPath), { recursive: true });
    for (const e of translateToOfficeEvents(observerEvent)) {
      appendFileSync(eventsPath, JSON.stringify(e) + "\n");
    }
    return { ok: true };
  } catch (e) {
    return { ok: false, warning: String(e?.message ?? e).slice(0, 80) };
  }
}
