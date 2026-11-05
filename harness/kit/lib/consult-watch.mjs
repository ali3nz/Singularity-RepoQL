// consult-watch.mjs — V3.3.17 (operator report 2026-09-20: "I am not seeing
// orchestration run threads and updates for new orchestration runs from
// freebuff (usually just consult runs)"). The nanny narrated only kit runs
// (^2026- + state.json) + the openchamber-ha external job — duo-consult
// sessions (runs/consult/<id>/) were INVISIBLE in Discord: no thread, no
// updates, even while the operator was actively using them.
//
// Fix: deterministic (NO LLM, 0 freebucks) narration per consult session:
//   - one narrative on FIRST sighting (backfills today's history),
//   - re-narrate when the session changes (transcript/NOTEPAD/meta mtime or
//     last VERDICT moved),
//   - keepalive for the OPEN (CURRENT) session every CONSULT_KEEPALIVE_TICKS
//     cycles (~40 min at the 5-min nanny cadence) so a quiet open session
//     does not look dead,
//   - sessions quiet beyond CONSULT_WINDOW_MS stop narrating (thread stays
//     in Discord as history).
// Records ride the EXISTING pipeline: {kind:"narrative", runId:"consult-<id>",
// title, text} -> nanny-heartbeat.jsonl -> orch-discord-bridge.py creates one
// PUBLIC thread per runId under #orchestration and posts every update there.
// Fail-closed everywhere: any error skips the tick, never breaks the nanny.
import { readFileSync, writeFileSync, existsSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { appendHeartbeat } from "./nanny.mjs";
import { threadName, composeConsultNarrativeSync } from "./narrator.mjs";
import { displayRunNumber, buildThreadTitle, extractIssueNumber } from "./run-registry.mjs";
import { classifySession } from "./consult-liveness.mjs";

export const CONSULT_RUN_PREFIX = "consult-";
export const CONSULT_WINDOW_MS = 24 * 3600e3;   // narrate sessions active in the last 24h
export const CONSULT_KEEPALIVE_TICKS = 8;       // legacy keepalive spacing (superseded by the V3.3.31 pulse)
// V3.3.31 (operator 2026-09-24): the OPEN session pulses EVERY nanny tick
// (5 min) — the operator asked for "updates every 5 mins as you go", gated
// (deterministic), not LLM-judged. Changed sessions still emit their full
// narrative; an unchanged OPEN session emits a short PULSE line instead.
export const CONSULT_PULSE_ENABLED = true;
// Max free-narrator calls per nanny cycle (see consultWatchCycle).
export const CONSULT_NARRATION_PER_CYCLE = 2;
// V3.3.31 (Sol turn-2 on the E2E proof session): an OPEN session that has
// had NO state change for 2h gets ONE QUIET notice, then pulses stop until
// the next real change. Noise control only — NOT a timeout/failure/closure;
// the closing summary still lands whenever the session is ended.
export const CONSULT_QUIET_AFTER_MS = 2 * 3600e3;
const STATE_FILE = "consult-watch.json";

// NOTEPAD.md append-only tail lines look like:
//   "- 10:01 buffy: Review HA/OpenClaw boundary - see attached"
//   "- 10:01 consultant: VERDICT=CONFIRMED"
// Pure: first + latest issue and the latest consultant verdict.
export function parseNotepad(txt) {
  let firstIssue = null, lastIssue = null, lastVerdict = null;
  for (const raw of String(txt ?? "").split("\n")) {
    const l = raw.trim();
    let m = l.match(/^- \d{1,2}:\d{2}\s+(?:buffy|requester):\s+(.+)$/i);
    if (m) {
      if (!firstIssue) firstIssue = m[1].trim();
      lastIssue = m[1].trim();
      continue;
    }
    m = l.match(/^- \d{1,2}:\d{2}\s+consultant:\s*VERDICT=([A-Z_]+)/i);
    if (m) lastVerdict = m[1].toUpperCase();
  }
  return { firstIssue, lastIssue, lastVerdict };
}

// V3.4.1: run number for a consult = its run_allocated event in the shared
// ledger (D09: consults + orchestrations share ONE sequence), resolved by
// caseId. Fail-open: any read/parse problem -> null (title then just omits
// the prefix; never blocks narration).
export function consultRunNumber(runsDir, consultId) {
  try {
    const lines = readFileSync(join(runsDir, "state", "run-ledger.jsonl"), "utf8").split("\n");
    for (let i = lines.length - 1; i >= 0; i--) {
      const line = lines[i].trim();
      if (!line) continue;
      const e = JSON.parse(line);
      if (e.event === "run_allocated" && e.caseId === consultId) return e.runNumber ?? null;
    }
  } catch { /* fail-open */ }
  return null;
}

// 2026-09-27 (operator: thread titles kept changing shape mid-session). The
// title was recomputed from the raw first NOTEPAD issue line on EVERY tick, so
// the good title composed once at consult-open (free-model, whole-brief) was
// clobbered within five minutes and then re-clobbered in a slightly different
// shape each cycle. The title is now COMPOSED ONCE and stored; the watcher
// reads it back instead of re-deriving it. Fail-open: no stored topic -> the
// deterministic first-issue topic, exactly as before.
export function consultStoredTitle(runsDir, consultId) {
  try {
    const cj = JSON.parse(readFileSync(join(runsDir, "consult", consultId, "case.json"), "utf8"));
    // threadTopic is the raw composed topic (written at open since 2026-09-27).
    // runTitle is the ledger title, which carries a "Consult | " prefix —
    // strip it so older sessions still yield a usable topic.
    const topic = String(cj.threadTopic ?? "").trim()
      || String(cj.runTitle ?? "").replace(/^\s*Consult\s*\|\s*/i, "").trim();
    const issueNumber = cj.issueNumber != null ? Number(cj.issueNumber) : extractIssueNumber(cj.task ?? "");
    return { topic: topic || null, issueNumber: Number.isInteger(issueNumber) ? issueNumber : null };
  } catch { return { topic: null, issueNumber: null }; }
}

// Pure-ish scan of runs/consult/2026-*: newest-first snapshot of every session
// that is CURRENT or was modified within the window. Tolerates junk dirs.
export function consultSnapshot(runsDir, { now = Date.now(), windowMs = CONSULT_WINDOW_MS } = {}) {
  const cdir = join(runsDir, "consult");
  const out = [];
  let ids = [];
  try {
    ids = readdirSync(cdir).filter((d) => /^2026-/.test(d) && existsSync(join(cdir, d, "transcript.md")));
  } catch { return out; }
  // 2026-09-27 (claude) — THE consult-narration bug the operator reported as
  // "no 5-min updates in the run threads". This loop used to be
  // `ids.slice(0, 64)` over RAW readdir order, which is creation order, not
  // recency. Once runs/consult held more than 64 sessions (161 at the time of
  // the fix) the LIVE session sat past the cut — index 140 — so the watcher
  // never looked at it and every cycle reported "quiet". The thread still got
  // its tracking post and its closing summary, and nothing in between.
  // Freshness must be decided BEFORE the cap, so mtime is collected first and
  // the window is taken off the newest end.
  const dirMtime = (dir) => {
    let m = 0;
    for (const f of ["transcript.md", "NOTEPAD.md", "meta.json"]) {
      try { m = Math.max(m, statSync(join(dir, f)).mtimeMs); } catch { /* optional file */ }
    }
    return m;
  };
  const ranked = ids
    .map((id) => ({ id, mtimeMs: dirMtime(join(cdir, id)) }))
    .sort((a, b) => b.mtimeMs - a.mtimeMs)
    .slice(0, 64);
  for (const { id, mtimeMs } of ranked) {
    const dir = join(cdir, id);
    let meta = {};
    try { meta = JSON.parse(readFileSync(join(dir, "meta.json"), "utf8")); } catch { /* optional */ }
    // Ticket 115: more than one consult may be active (one per gateway).
    // CURRENT is only a compatibility pointer and cannot represent that.
    const isCurrent = classifySession(meta).status === "ALIVE";
    if (!isCurrent && now - mtimeMs > windowMs) continue;
    const turns = Number(meta.turns ?? 0) || 0;
    let np = {};
    try { np = parseNotepad(readFileSync(join(dir, "NOTEPAD.md"), "utf8")); } catch { /* optional */ }
    // V3.3.33 Phase 2: lastUpdateAt from the authoritative case.json (Sol:
    // the 300s cadence anchors on discord.lastUpdateAt, not watcher-internal
    // state). Falls back to null when absent — the caller decides the anchor.
    let lastUpdateAt = null;
    try { lastUpdateAt = (JSON.parse(readFileSync(join(dir, "case.json"), "utf8")).discord ?? {}).lastUpdateAt ?? null; } catch { /* optional */ }
    out.push({
      id,
      runId: CONSULT_RUN_PREFIX + id,
      isCurrent,
      mtimeMs,
      turns,
      firstIssue: np.firstIssue ?? null,
      lastVerdict: np.lastVerdict ?? null,
      ageMin: Math.max(0, Math.round((now - mtimeMs) / 60e3)),
      lastUpdateAt,
      runNumber: consultRunNumber(runsDir, id),
      ...consultStoredTitle(runsDir, id),
    });
  }
  out.sort((a, b) => b.mtimeMs - a.mtimeMs);
  return out.slice(0, 8);
}

// Discord thread title: the operator's own issue line when present.
// V3.3.22.1 (operator catch 2026-09-22): issue lines like "— see attached brief"
// made Discord narration CLAIM an attachment that never exists in Discord
// (evidence travels inline to the consultant only). Scrub attachment-reference
// phrases from topics/titles and, when they were present, state where the
// brief actually lives (transcript path).
const ATTACH_REF = /\bsee[ -]?attached\b(\s+(brief|file|files|evidence|pack|evidence pack|docs?|plan))?/gi;

// V3.3.31 (operator 2026-09-24, "they are just text conversations"): consult
// thread titles were the RAW consult prompt verbatim — multi-line walls like
// "ORCHESTRATION HARDENING - Phase 0 gate (ticket 076). You are the architecture
// consultant for..." which read as messages, not threads. A thread title must
// be a SHORT LABEL: strip CLI flags, cut at prompt grammar (the operator's
// issue ends where the instructions to the consultant begin), collapse space.
const PROMPT_GRAMMAR = /\b(you are|you must|act as|your (?:task|job|role)|i want you to|i need you to|give the exact|as the )\b/i;
export function cleanTitleTopic(s) {
  let t = String(s ?? "").replace(/\s+/g, " ").trim();
  t = t.replace(/--engine\s+\S+/gi, "").replace(/--codex|--claude|--attach|--open|--end\b/gi, "");
  t = cleanTopic(t);
  const m = t.match(PROMPT_GRAMMAR);
  if (m && m.index > 8) t = t.slice(0, m.index);
  return t.replace(/[\s,.;:—–-]+$/g, "").trim();
}
export function cleanTopic(s) {
  return String(s ?? "")
    .replace(ATTACH_REF, "")
    .replace(/\s+[—–-]+\s*$/, "")      // dangling separator left behind
    .replace(/\s{2,}/g, " ")
    .trim();
}
export function mentionsAttachment(s) {
  ATTACH_REF.lastIndex = 0;
  return ATTACH_REF.test(String(s ?? ""));
}

// V3.4.1 (2026-09-27, operator directive): the run number LEADS every consult
// thread title — "Run 080 | <topic>". runNumber travels in the consult
// snapshot (resolved from runs/state/run-ledger.jsonl by caseId, fail-open)
// and the bridge RENAMES the live thread when the narrative title changes, so
// fix-up applies to existing threads too. Canonical title contract (D11):
//   Run NNN | <topic> — duo consult <id-slug>
export function consultTitle(c) {
  // The stored topic (composed once at open from the whole brief) wins; the
  // cleaned first-issue line is the fail-open fallback for older sessions.
  const stored = String(c.topic ?? "").trim();
  const topic = (stored || cleanTitleTopic(c.firstIssue ?? ""))
    .replace(/\s*[\u2014\u2013-]\s*duo consult\b.*$/i, "")
    .replace(/^\s*Run\s+\d{1,4}\s*\|\s*/i, "")
    .replace(/^\s*Issue\s+\d{1,4}\s*\|\s*/i, "")
    .trim();
  const idShort = String(c.id ?? "").replace(/^2026-/, "");
  return buildThreadTitle({
    runNumber: c.runNumber ?? null,
    issueNumber: c.issueNumber ?? null,
    topic,
    suffix: `duo consult ${idShort}`,
  }) || `duo consult ${c.runId}`;
}

// Deterministic update text (no LLM): state, turns, verdict, freshness.
export function buildConsultText(c, { now = Date.now() } = {}) {
  const state = c.isCurrent ? "OPEN (follow-ups continue this session)" : "idle — no longer the current session";
  const verdict = c.lastVerdict ? `last consultant verdict: ${c.lastVerdict}` : "no verdict yet";
  const ago = c.ageMin <= 0 ? "just now" : c.ageMin < 60 ? `${c.ageMin} min ago` : `${Math.round(c.ageMin / 60)}h ago`;
  const rawIssue = String(c.firstIssue ?? "");
  const hadAttachRef = mentionsAttachment(rawIssue);
  const issue = cleanTopic(rawIssue).replace(/\s+/g, " ").trim().slice(0, 160);
  return `**NOW** duo consult \`${c.id}\` — ${state}. ` +
    `${c.turns} consultant turn(s), ${verdict} (last activity ${ago}).` +
    (issue ? `\nTopic: ${issue}` : "") +
    (hadAttachRef ? `\nNote: the brief/evidence referenced goes INLINE to the consultant — nothing is attached in Discord. Full brief + replies: runs/consult/${c.id}/transcript.md` : "");
}// Pure emission planner: first sighting or any change emits (full narrative);
// V3.3.31: the CURRENT session ALSO pulses every tick when unchanged (short
// PULSE line — the operator's gated every-5-min rule) — but once the session
// itself has had no state change (its own mtime) for 2h, it gets one QUIET
// notice and pulses suppress until the next change (Sol turn-2 refinement;
// noise control, not a timeout). Emitted items carry `_pulse`/`_quiet`.
// V3.3.33 Phase 2 (Sol): the pulse cadence ALSO honors case.json's
// discord.lastUpdateAt — if a real post landed within the last 300s, no
// pulse this tick (both paths still emit on real state change).
export function planConsultEmits(sessions, state, { now = Date.now(), tick = 1 } = {}) {
  const st = { ...(state ?? {}), sessions: { ...(state?.sessions ?? {}) } };
  const emit = [];
  for (const c of (sessions ?? []).slice(0, 8)) {
    const prev = st.sessions[c.id];
    const changed = !prev || prev.mtimeMs !== c.mtimeMs || (prev.lastVerdict ?? null) !== (c.lastVerdict ?? null)
      || (prev.runNumber ?? null) !== (c.runNumber ?? null)
      || (prev.issueNumber ?? null) !== (c.issueNumber ?? null);
    const keepalive = c.isCurrent && (tick % CONSULT_KEEPALIVE_TICKS === 0);
    const cadenceOK = !(c.lastUpdateAt && (now - Date.parse(c.lastUpdateAt)) < 300_000);
    const quietFor = now - c.mtimeMs; // anchored to the SESSION's last real change, not our observation
    const pulse = CONSULT_PULSE_ENABLED && c.isCurrent && !changed && cadenceOK && quietFor < CONSULT_QUIET_AFTER_MS;
    const quietNotice = CONSULT_PULSE_ENABLED && c.isCurrent && !changed && quietFor >= CONSULT_QUIET_AFTER_MS && !(prev?.quietNotified);
    if (changed || keepalive || pulse || quietNotice) {
      emit.push({ ...c, _pulse: pulse, _quiet: quietNotice });
      st.sessions[c.id] = {
        mtimeMs: c.mtimeMs, lastVerdict: c.lastVerdict ?? null, runNumber: c.runNumber ?? null,
        issueNumber: c.issueNumber ?? null, at: now,
        quietNotified: changed ? false : (quietNotice ? true : (prev?.quietNotified ?? false)),
      };
    }
  }
  const live = new Set((sessions ?? []).map((c) => c.id));
  for (const id of Object.keys(st.sessions)) if (!live.has(id)) delete st.sessions[id];
  return { emit, state: st };
}

// Short PULSE line for an unchanged OPEN session (the 5-min heartbeat).
export function buildPulseText(c, { now = Date.now() } = {}) {
  const ago = c.ageMin <= 0 ? "just now" : c.ageMin < 60 ? `${c.ageMin} min ago` : `${Math.round(c.ageMin / 60)}h ago`;
  const verdict = c.lastVerdict ? `last verdict: ${c.lastVerdict}` : "no verdict yet";
  return `⏱️ **PULSE** duo consult \`${c.id}\` — OPEN, waiting on consultant/next turn (${c.turns} turn(s), ${verdict}, last activity ${ago}).`;
}

// One-time QUIET notice when an OPEN session crosses the 2h-no-change line.
export function buildQuietText(c) {
  return `🔇 **QUIET** duo consult \`${c.id}\` — still OPEN but no activity for over 2h; 5-min pulses paused until the next update. (Noise control only — the session is not failed or closed; the closing summary still lands at \`consult --end\`.)`;
}

// V3.3.33 Phase 2b (Sol): the consult terminal state is a pure conjunction —
// engine terminal AND transcript persisted AND summary generated AND summary
// uploaded AND final checkpoint persisted. Only then signoff=pass / rc 0. A
// preserved consultant result with a failed/missing upload is
// result_ready_signoff_failed / rc 3 — a retry resumes signoff work only and
// NEVER re-runs the consultant.
export function consultCloseOutcome({ summaryOk, uploadConfirmed }) {
  if (!summaryOk) return { rc: 3, status: "result_ready_signoff_failed", signoff: "failed", kind: "summary_failed" };
  if (!uploadConfirmed) return { rc: 3, status: "result_ready_signoff_failed", signoff: "failed", kind: "upload_unconfirmed" };
  return { rc: 0, status: "complete", signoff: "pass", kind: "complete" };
}

// V3.3.31.2 (operator directive 2026-09-24, after a live hijack: a plain
// `consult` turn landed inside ANOTHER workstream's still-open session):
// attaching to an existing session must never be silent or implicit.
//   no open session            -> "new" (open a fresh one)
//   open session + --continue  -> "attach" (explicit continuation)
//   open session, no --continue-> "refuse" (the request did NOT touch the
//                                 open session; caller must choose)
// --end always closes the CURRENT session regardless.
// V3.4.0b (ticket 090, Sol fix plan): openClass carries the liveness
// classification of the open session ("ALIVE"|"IDLE-OPEN"|...). Only LIVE
// Ticket 115: a follow-up is addressed by exact session id. Global liveness
// remains useful for status display, but is never an attachment authority.
// Fresh consults therefore create isolated sessions even while another turn
// is alive; the two gateway occupancy slots provide the concurrency bound.
export function consultAttachDecision({ hasOpen, wantContinue, endArg, openClass, targetSessionId }) {
  if (endArg) return { action: "close", reason: "--end closes the current session" };
  // Ticket 115: session continuation is an address, not a global-state guess.
  // A plain consult always creates an isolated session. A continuation must
  // carry the exact id printed in its dispatch banner/transcript.
  if (wantContinue && !targetSessionId) {
    return { action: "refuse-target", reason: "continuation requires --continue-session <exact-id>" };
  }
  if (wantContinue) return { action: "attach", reason: `explicit session target ${targetSessionId}` };
  return { action: "new", reason: hasOpen ? `new isolated session; existing ${openClass ?? "unknown"} session is unrelated` : "new isolated session" };
}

// Narration evidence: the tail of what actually happened in the session. The
// deterministic template never read these, which is why every update said the
// same thing — the watcher knew a turn had landed but never what was IN it.
export function tailOf(path, maxChars) {
  try {
    const t = readFileSync(path, "utf8");
    return t.length > maxChars ? t.slice(t.length - maxChars) : t;
  } catch { return ""; }
}

// One nanny cycle's worth of consult narration. Display-only, never fatal.
export function consultWatchCycle(runsDir, { now = Date.now(), deterministic = false } = {}) {
  // `deterministic` is the load-standdown contract (incident 033): while the
  // host is saturating, narration must not spawn model calls. The update
  // still goes out — it just uses the deterministic text.
  const out = { emitted: 0, reason: "", narrated: 0, model: null };
  try {
    const statePath = join(runsDir, STATE_FILE);
    let st = { tick: 0, sessions: {} };
    try { st = { ...st, ...JSON.parse(readFileSync(statePath, "utf8")) }; } catch { /* fresh */ }
    st.tick = (st.tick ?? 0) + 1;
    const sessions = consultSnapshot(runsDir, { now });
    const plan = planConsultEmits(sessions, st, { now, tick: st.tick });
    // Narration budget per cycle. The narrator chain gets ~60s per call and the
    // nanny cadence is 5 min, so an unbounded loop over 8 changed sessions could
    // outrun its own tick. The busiest sessions (newest first — the snapshot is
    // recency-sorted) get real narration; the rest keep the deterministic line
    // this cycle and get narrated on the next one.
    let narrationBudget = deterministic ? 0 : CONSULT_NARRATION_PER_CYCLE;
    for (const c of plan.emit) {
      // Pulses and quiet notices stay deterministic and instant — they exist to
      // prove liveness, and paying a model 60s to say "still waiting" is exactly
      // the noise the operator complained about. A REAL change gets a real
      // narrative from the free narrator chain (MiMo -> Muse), with the old
      // deterministic text as the fail-open fallback.
      let text, by = "deterministic";
      if (c._quiet) {
        text = buildQuietText(c);
      } else if (c._pulse) {
        text = buildPulseText(c, { now });
      } else if (narrationBudget <= 0) {
        text = buildConsultText(c, { now });
      } else {
        narrationBudget -= 1;
        const deterministic = buildConsultText(c, { now });
        const dir = join(runsDir, "consult", c.id);
        const n = composeConsultNarrativeSync(
          { ...c,
            transcriptTail: tailOf(join(dir, "transcript.md"), 3500),
            notepadTail: tailOf(join(dir, "NOTEPAD.md"), 1200) },
          deterministic,
          { runsDir, runId: c.runId });
        text = n.text;
        by = n.ok ? (n.model ?? "free-narrator") : "deterministic";
        if (n.ok) { out.narrated += 1; out.model = n.model ?? "free-narrator"; }
      }
      appendHeartbeat(runsDir, JSON.stringify({
        kind: "narrative",
        runId: c.runId,
        title: consultTitle(c),
        by,
        text,
      }));
      out.emitted += 1;
    }
    try { writeFileSync(statePath, JSON.stringify(plan.state)); } catch { /* non-fatal */ }
    if (!out.emitted) out.reason = "quiet — no consult activity since last cycle";
  } catch (e) {
    out.reason = `failed (non-fatal): ${String(e?.message ?? e).slice(0, 100)}`;
  }
  return out;
}
