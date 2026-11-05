// openchamber-remediate.mjs — V3.3.14.4 (ticket 030, operator order 2026-09-20:
// "the HA orchestration job is paused ... check why the nanny didn't fix it and
// fix the nanny so it does next time").
//
// Root cause (diagnosed live 2026-09-20): the openchamber HA job is an EXTERNAL
// OpenCode session — nannyCycle() only scans kit runs (^2026- dirs with
// state.json) and the V3.3.13 openchamber watch is display-only, so nothing
// ever nudged the session when its free-model turn ended prematurely
// (finish=stop mid-task, no pending permission). This module gives the watch
// (which runs inside the nanny's 5-min cycle) a BOUNDED remediation action:
//
//   STAGED-NOT-DEPLOYED + idle >= 30 min -> send a deterministic "continue"
//   message into the SAME session (same agent + same free model the job
//   already runs), max 4/day, 2 h cooldown, alert+narrate every nudge.
//
// Pure pieces are exported for selftest; the spawn is injectable. Fail-closed
// like the rest of the watch: a failed nudge only logs, never breaks a cycle.
import { spawnSync } from "node:child_process";
import { RATE_LIMIT_BURST_MIN_FAILURES, RATE_LIMIT_BURST_WINDOW_MS, todoState, isRateLimitBurst } from "./openchamber-watch.mjs";

// Pure: when the finishing agent records completion (ticket 031: 12/17 scripts
// deliberately deployed; 5 stubs skipped — the staged-vs-live count can never
// reach 17/17 honestly), nudging is suppressed so the session is not sent to
// re-deploy artifacts the ops pass rejected.
export function nudgingSuppressed(st) {
  return Boolean(st && st.completed && st.completed.at);
}

export const REMEDIATION_LIMITS = Object.freeze({
  STALL_IDLE_MINUTES: 30,      // idle before a stall is declared
  NUDGE_COOLDOWN_MINUTES: 120, // min gap after a PRODUCTIVE nudge (session advanced)
  UNPRODUCTIVE_RETRY_MINUTES: 10, // a nudge that produced NO session progress retries fast
  MAX_NUDGES_PER_DAY: 6,       // hard cap; beyond -> escalate-only
});

export const OPENCHAMBER_CONTAINER = process.env.OPENCHAMBER_CONTAINER || "openchamber";
export const OPENCODE_BIN = "/home/openchamber/.npm-global/bin/opencode";
export const OPENCODE_CONFIG_DIR = "/home/openchamber/.config/opencode";
export const NUDGES_DIR = "/home/openchamber/.config/openchamber/nudges";
// the job's pinned model + agent (ticket 255, operator order 2026-10-03: the
// nudge now runs the Go-plan managed Muse — the container CLI reaches
// opencode-go directly, live-probed 2026-10-03)
// V3.3.25 HARD DENY: lightning stays off every pin (operator ban for
// hallucinations).
export const NUDGE_MODEL = "opencode-go/muse-spark-1.3-contributor#xhigh";
export const NUDGE_AGENT = "orchestrator";
// V3.3.18 (operator report: sessions "stop themselves multiple times" + "getting
// rate limited by free model"): when the pinned model is RATE-LIMITED —
// zero-token turn bursts in the DB — a normal nudge just fires more requests
// into the same limit. The nudge turn then runs on the FIRST HEALTHY free
// failover candidate instead (rotate per attempt). Ordered by general
// capability; all free, 0 freebucks.
// Ticket 230b (operator order 2026-10-02): free Muse removed from the automatic
// nudge-failover rotation — it is explicit-opt-in only.
// Ticket 255 (operator order 2026-10-03): MiMo retired — the failover rotation
// is the free tail (space-bunny -> ling-3.1 -> longcat).
export const FAILOVER_NUDGE_MODELS = Object.freeze([
  "opencode/space-bunny-free",
  "opencode/ling-3.1-flash-free",
  "opencode/longcat-2.5-preview-free",
]);
// How long a failover-model nudge remains in effect for a session (the pinned
// model is assumed unhealthy until this passes; nudges keep using the
// failover model).
export const FAILOVER_HOLD_MS = 30 * 60e3;
// host vs container path of the openchamber data mount (6 mounts verified in
// the 2026-09-18 consult: data/openchamber -> .config/openchamber)
const HOST_CHATS = "/opt/harness-unset/openchamber/data/openchamber";
const CONTAINER_CHATS = "/home/openchamber/.config/openchamber";

// sh single-quote safety (the nudge message is deterministic, but never trust
// string assembly near a shell boundary)
export function shQuote(s) {
  return "'" + String(s).replace(/'/g, "'\\''") + "'";
}

// host chats path -> container chats path (identity when already container-side)
export function containerSessionDir(hostDir) {
  const d = String(hostDir || "");
  if (d.startsWith(CONTAINER_CHATS)) return d;
  if (d.startsWith(HOST_CHATS)) return CONTAINER_CHATS + d.slice(HOST_CHATS.length);
  return d; // unknown shape: use as-is; opencode resolves the session by id
}

// Pure policy. `nudges` = { day: "YYYY-MM-DD", count, lastAt(ms) }.
// `progressSinceNudge`: the session advanced (turn/file activity) after the
// last nudge — a PRODUCTIVE nudge earns the full 2 h cooldown; an
// UNPRODUCTIVE one (chronic finish=stop with zero work) retries after 10 min
// so a stalled deployment still gets bounded attempts instead of waiting out
// a cooldown it did not earn.
export function shouldAutoNudge({ runState, deployed, idleMinutes, nudges, now = Date.now(), progressSinceNudge = false, cooldownMinutes = null } = {}) {
  if (deployed) return { ok: false, reason: "suite fully deployed — nothing to nudge" };
  if (runState !== "STAGED-NOT-DEPLOYED") return { ok: false, reason: `state ${runState} is not a deployment stall` };
  if (idleMinutes == null || idleMinutes < REMEDIATION_LIMITS.STALL_IDLE_MINUTES)
    return { ok: false, reason: `idle ${idleMinutes ?? "?"}min < ${REMEDIATION_LIMITS.STALL_IDLE_MINUTES}min` };
  const day = new Date(now).toISOString().slice(0, 10);
  const count = nudges && nudges.day === day ? nudges.count : 0;
  if (count >= REMEDIATION_LIMITS.MAX_NUDGES_PER_DAY)
    return { ok: false, reason: `daily nudge cap (${REMEDIATION_LIMITS.MAX_NUDGES_PER_DAY}) reached — escalating only` };
  const cool = cooldownMinutes ?? (progressSinceNudge
    ? REMEDIATION_LIMITS.NUDGE_COOLDOWN_MINUTES
    : REMEDIATION_LIMITS.UNPRODUCTIVE_RETRY_MINUTES);
  const sinceMin = nudges?.lastAt ? Math.round((now - nudges.lastAt) / 60e3) : null;
  if (sinceMin != null && sinceMin < cool)
    return { ok: false, reason: `cooldown (${progressSinceNudge ? "productive" : "unproductive"}): last nudge ${sinceMin}min ago (< ${cool}min)` };
  return { ok: true, reason: `stalled ${idleMinutes}min, nudges today ${count}/${REMEDIATION_LIMITS.MAX_NUDGES_PER_DAY}` };
}

// Deterministic ACTION-FIRST continue message naming the exact shortfall.
// Tuned against the chronic finish=stop behavior (live 2026-09-20: a plain
// "continue" produced 87s of narration and ZERO tool calls) — so the message
// opens with an imperative and forbids prose-only replies.
export function buildNudgeMessage(ds) {
  const d = ds || {};
  return (
    `ACTION REQUIRED — do not narrate, do not restate the plan; your next output must be tool calls. ` +
    `Your last turn ended mid-task (finish=stop) before deployment completed: ` +
    `${d.scriptsDeployed ?? "?"}/${d.scriptsTotal ?? "?"} python scripts and ` +
    `${d.automationsMerged ?? "?"}/${d.automationsTotal ?? "?"} automations are live, ` +
    `configuration phase ${d.maxConfigPhase ?? "?"} is ${d.configMerged ? "merged" : "NOT merged"}. ` +
    `Immediately perform the next deployment step with tools — create/merge the remaining ` +
    `staged items into the live Home Assistant configuration exactly per the existing plan, ` +
    `then verify. Continue; do not re-plan.`
  );
}

// The sh -c payload executed INSIDE the openchamber container: cd to the
// session's project dir, launch the nudge turn DETACHED (opencode run blocks
// for the whole turn — never inside a 5-min cycle), log to a stamped file.
// V3.3.18: `model` overrides NUDGE_MODEL (failover-model nudging).
export function buildContainerNudgeScript({ sessionId, sessionDir, message, model = null }) {
  const dir = containerSessionDir(sessionDir);
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  const useModel = String(model || NUDGE_MODEL);
  // newline-separated (NOT "; "): the statement before the echo ends in `&`,
  // and `&;` is a syntax error (live 2026-09-20, dash AND bash).
  return [
    `export HOME=/home/openchamber OPENCODE_CONFIG_DIR=${OPENCODE_CONFIG_DIR}`,
    `mkdir -p ${NUDGES_DIR}`,
    `cd ${shQuote(dir)}`,
    `nohup ${OPENCODE_BIN} run -s ${shQuote(sessionId)} --agent ${NUDGE_AGENT} -m ${shQuote(useModel)} ${shQuote(message)}` +
      ` > ${NUDGES_DIR}/nudge-${stamp}.log 2>&1 &`,
    `echo nudge-pid $!`,
  ].join("\n");
}

// One nudge attempt. `exec` injectable for tests; default: ssh -> docker exec.
// The container script travels via STDIN (`docker exec -i sh`) — passing it as
// an `sh -c` ARGUMENT loses its quotes to the ssh remote-shell reassembly
// (live 2026-09-20: 'syntax error near unexpected token `;'' ). Returns
// { ok, detail } and never throws.
export function runNudge({ sessionId, sessionDir, message, model = null, sshHost = "controller", exec = null } = {}) {
  const script = buildContainerNudgeScript({ sessionId, sessionDir, message, model });
  const doExec = exec || (() => {
    const r = spawnSync("ssh", [sshHost, "docker", "exec", "-i", OPENCHAMBER_CONTAINER, "sh"], {
      input: script + "\n", encoding: "utf8", timeout: 30_000,
    });
    return { ok: r.status === 0, detail: ((r.stdout || "") + (r.stderr || "")).trim().slice(0, 300) };
  });
  try {
    return doExec([OPENCHAMBER_CONTAINER, "sh", "-c", script]);
  } catch (e) {
    return { ok: false, detail: String(e?.message ?? e).slice(0, 300) };
  }
}

// Policy + state advance in one step for the watch cycle. Mutates the given
// nudges state object only when a nudge is actually sent. Returns the outcome.
export function maybeAutoNudge({ snap, ds, nudges, now = Date.now(), runState, exec = null, sshHost = "controller" }) {
  const idleMinutes = snap?.lastTurn > 0 ? Math.round((now - snap.lastTurn) / 60e3) : null;
  const progressSinceNudge = Boolean(nudges?.lastAt && snap?.lastTurn > nudges.lastAt);
  const verdict = shouldAutoNudge({ runState, deployed: ds?.deployed, idleMinutes, nudges, now, progressSinceNudge });
  if (!verdict.ok) return { nudged: false, reason: verdict.reason };
  const day = new Date(now).toISOString().slice(0, 10);
  const count = (nudges && nudges.day === day ? nudges.count : 0) + 1;
  const message = buildNudgeMessage(ds);
  const res = runNudge({ sessionId: snap.sessionId, sessionDir: snap.sessionDir, message, sshHost, exec });
  if (res.ok) {
    nudges.day = day;
    nudges.count = count;
    nudges.lastAt = now;
  }
  return { nudged: res.ok, reason: res.ok ? `auto-nudge #${count} sent` : `nudge failed: ${res.detail}`, count, message };
}

// ================= V3.3.18: ALL-session remediation (operator report:
// "They seemed to stop themselves multiple times for unknown reasons and also
// are getting rate limited by free model") =================
//
// The V3.3.14.4 policy covered ONLY the primary HA job (its state machine is
// deployment-specific). Every OTHER orchestrator session (Hermes sidecar,
// budget report, …) stalls unattended: the free model drifts to finish=stop
// mid-task or the provider rate-limits it (zero-token turn bursts), and
// nothing notices. This module-side policy is per-session, todo-aware, and
// shares the same limits as the primary-job policy.

// Pure: should session X get a continuation nudge?
//   session: {id, title, updated, health{stops,unknown,aborted,lastFinish,
//             failedStamps,lastProductive}, todos[]}
//   state:   {day, count, lastAt, failover:{model,at}|null}
// Decision (first match wins):
//   - no health or never productive            -> skip (nothing to resume)
//   - todos all done                           -> skip (task finished)
//   - idle < 20 min since last PRODUCTIVE turn -> skip (still working)
//   - rate-limit burst (>=3 zero-token turns in 20 min) + idle >= 15 min
//                                              -> NUDGE with FAILOVER model
//   - premature stop (stops >= 1) + idle >= 25 min -> NUDGE pinned model
export function shouldNudgeSession(session, state, { now = Date.now(), limits = REMEDIATION_LIMITS, minFailures = RATE_LIMIT_BURST_MIN_FAILURES, windowMs = RATE_LIMIT_BURST_WINDOW_MS } = {}) {
  const h = session?.health;
  if (!h || !h.total) return { ok: false, reason: "no turn data" };
  const { done } = todoState(session?.todos);
  if (done) return { ok: false, reason: "todos complete — task finished" };
  const lastProd = Number(h.lastProductive ?? 0);
  if (!lastProd) return { ok: false, reason: "never productively ran" };
  const idleMin = Math.round((now - lastProd) / 60e3);
  if (idleMin < 20) return { ok: false, reason: `productive turn ${idleMin}min ago — still working` };

  const day = new Date(now).toISOString().slice(0, 10);
  const count = state && state.day === day ? state.count : 0;
  if (count >= limits.MAX_NUDGES_PER_DAY)
    return { ok: false, reason: `daily nudge cap (${limits.MAX_NUDGES_PER_DAY}) reached — escalating only` };

  // rate-limit burst: the pinned model is failing NOW -> failover model,
  // fast retry (10 min, same as unproductive) because capacity recovers fast
  const burst = isRateLimitBurst({ health: h, failedStamps: h.failedStamps ?? [], now, minFailures, windowMs });
  if (burst) {
    const cool = state?.lastAt ? Math.round((now - state.lastAt) / 60e3) : null;
    if (cool != null && cool < limits.UNPRODUCTIVE_RETRY_MINUTES)
      return { ok: false, reason: `rate-limit retry cooldown: last nudge ${cool}min ago` };
    const lastFail = Math.max(...(h.failedStamps ?? [0]));
    if (now - lastFail > windowMs)
      return { ok: false, reason: "failures outside burst window" };
    return {
      ok: true,
      failover: true,
      idleMinutes: idleMin,
      reason: `rate-limited (>= ${minFailures} zero-token turns in ${Math.round(windowMs / 60e3)} min), idle ${idleMin}min -> failover-model nudge`,
    };
  }

  // premature stop: chronic drift; cadence is PROGRESS-AWARE (V3.3.18 live
  // lesson: the nudged turn itself can fail rate-limited — an unproductive
  // stop-nudge retries after 10 min like the primary-job policy, a productive
  // one earns the full 2 h cooldown). Model choice: ANY recent zero-token
  // failure on this session -> run the nudge on a FAILOVER model (burst
  // threshold stays the gate for the fast-retry cadence only).
  const stops = Number(h.stops ?? 0);
  if (stops >= 1) {
    if (idleMin < 25) return { ok: false, reason: `stop-idle ${idleMin}min < 25min` };
    const progress = Boolean(state?.lastAt && lastProd > state.lastAt);
    const cool = progress ? limits.NUDGE_COOLDOWN_MINUTES : limits.UNPRODUCTIVE_RETRY_MINUTES;
    const sinceMin = state?.lastAt ? Math.round((now - state.lastAt) / 60e3) : null;
    if (sinceMin != null && sinceMin < cool)
      return { ok: false, reason: `stop-nudge cooldown (${progress ? "productive" : "unproductive"}): last nudge ${sinceMin}min ago (< ${cool}min)` };
    const recentFailure = (h.failedStamps ?? []).some((t) => now - Number(t || 0) <= windowMs);
    // V3.3.18 live lesson (Hermes session): lightning can also answer a nudge
    // with PROSE and stop again (out=119, zero tool calls) — a competence
    // failure, not a capacity failure. After 2 unproductive nudges today the
    // pinned model had its chance; the next turn goes to a failover model.
    const escalate = recentFailure || (count >= 2 && !progress);
    return {
      ok: true,
      failover: escalate,
      idleMinutes: idleMin,
      reason: `premature stop (finish=stop with pending todos), idle ${idleMin}min` +
        (recentFailure ? " + recent zero-token failures"
          : escalate ? ` + ${count} unproductive nudges today`
          : "") + " -> " + (escalate ? "failover" : "pinned") + "-model nudge",
    };
  }
  return { ok: false, reason: `healthy last turn (${h.lastFinish}) — no stall signal` };
}

// Pure: which model should the nudge use for this session?
export function nudgeModelFor(state, { now = Date.now() } = {}) {
  const fo = state?.failover;
  if (fo?.model && fo?.at && now - fo.at < FAILOVER_HOLD_MS) return fo.model;
  return NUDGE_MODEL;
}

// Pure: pick the failover model (rotate per attempt so a dead candidate is
// not hammered).
export function failoverModelFor(attempt = 0) {
  return FAILOVER_NUDGE_MODELS[Math.abs(Number(attempt) || 0) % FAILOVER_NUDGE_MODELS.length];
}

// Deterministic continuation message for a NON-primary session (no deployment
// summary exists — name the todo shortfall instead).
export function buildSessionNudgeMessage(session) {
  const { pending } = todoState(session?.todos);
  const title = String(session?.title ?? "this job").slice(0, 80);
  return (
    `ACTION REQUIRED — do not narrate, do not restate the plan; your next output must be tool calls. ` +
    `Session "${title}" ended its last turn mid-task (${pending} todo item(s) still pending). ` +
    `Immediately continue the current task with tools — next step, then verify. Continue; do not re-plan.`
  );
}

// Policy + state advance for ONE non-primary orchestrator session. Mutates
// `state` only when a nudge is actually sent. Never throws.
export function maybeNudgeSession(session, state, { now = Date.now(), sshHost = "controller", exec = null, foAttempt = 0 } = {}) {
  const st = state ?? {};
  const verdict = shouldNudgeSession(session, st, { now });
  if (!verdict.ok) return { nudged: false, reason: verdict.reason };
  const day = new Date(now).toISOString().slice(0, 10);
  const count = (st.day === day ? st.count : 0) + 1;
  const model = verdict.failover ? failoverModelFor(foAttempt) : nudgeModelFor(st, { now });
  const message = buildSessionNudgeMessage(session);
  const res = runNudge({ sessionId: session.id, sessionDir: session.directory ?? null, message, model, sshHost, exec });
  if (res.ok) {
    st.day = day;
    st.count = count;
    st.lastAt = now;
    st.lastModel = model;
    st.failover = verdict.failover ? { model, at: now } : (st.failover ?? null);
    st.lastReason = verdict.reason;
  }
  return { nudged: res.ok, reason: res.ok ? `nudge #${count} via ${model}: ${verdict.reason}` : `nudge failed: ${res.detail}`, count, model, message };
}
