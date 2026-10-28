// narrator.mjs — V3.3.13 (ticket 028): composes the operator's Discord updates.
//
// Operator directive 2026-09-20: heartbeat lines like "state=RUNNING phase=1
// workers=alpha:working" are useless. Updates must be INTELLIGENT — what is
// happening, issues picked up, fixes applied, what is needed from the
// operator — in the same style Buffy reports to the operator.
//
// Security posture (Sol turn-1/2 constraint, kept): the narrator is
// DISPLAY-ONLY. It writes prose into nanny-heartbeat.jsonl; it never touches
// state.json, workers, gates, or any action path. A failed narration always
// falls back to a deterministic one-line summary so the stream never dies.
import { callFreeRole, narratorSessionId, NARRATOR_CWD } from "./free-role-router.mjs";

// Ticket 268: narrator isolation — dedicated /tmp cwd, [orchestrator] title, fresh ses_ ID per call.
// Worker seats never pass managed opts, so their behavior is unchanged.

export const NARRATOR_MAX_CHARS = 1500;

// Task first line -> human thread title. Strips "APPROVED SPEC —" banners,
// truncates on a word boundary, falls back to the run id when empty.
export function taskTitle(task, runId, max = 72) {
  let t = String(task ?? "").trim();
  t = t.replace(/^APPROVED SPEC[^\n]*\n+/i, "").replace(/^IMPLEMENTED[^\n]*\n+/i, "");
  t = t.split("\n").map((l) => l.trim()).find((l) => l.length > 0) ?? "";
  if (t.length > max) {
    const cut = t.slice(0, max);
    t = (cut.includes(" ") ? cut.slice(0, cut.lastIndexOf(" ")) : cut).trim() + "…";
  }
  return t || `orchestration run ${runId}`;
}

// Same sanitization for the LIVE thread name (Discord: 2..100 chars, no issues
// with most punctuation; we keep it conservative anyway).
export function threadName(task, runId) {
  const base = taskTitle(task, runId, 90).replace(/[`*_~|]/g, "").trim();
  return base.slice(0, 100) || `orch-${runId}`;
}

function firstLine(s, n) {
  const t = String(s ?? "").replace(/\s+/g, " ").trim();
  return t.length > n ? t.slice(0, n - 1) + "…" : t;
}

// Deterministic fallback: still far better than the old key=value dump.
export function fallbackNarrative(bundle) {
  const parts = [];
  for (const r of bundle.runs) {
    parts.push(
      `**${r.title}** — ${r.runState}${r.currentPhase ? `, phase ${r.currentPhase}` : ""}` +
      `${r.completedThrough ? `, ${r.completedThrough} phase(s) done` : ""}. ` +
      `Workers: ${r.workers.length ? r.workers.join(", ") : "none"}.` +
      (r.findings.length ? `\n⚠️ ${r.findings.map(firstLine).join("; ")}` : "")
    );
  }
  if (bundle.issues.length) parts.push(`**Issues:** ${bundle.issues.map(firstLine).join(" | ")}`);
  if (bundle.engineNote) parts.push(`**Engines:** ${firstLine(bundle.engineNote, 220)}`);
  return (parts.join("\n") || "No active runs; all quiet.").slice(0, NARRATOR_MAX_CHARS);
}

const SYSTEM_RULES =
`You are the orchestration narrator for a homelab AI fleet. Compose a concise Discord markdown update for the operator from the raw snapshot given. Rules:
- Style: direct, technical, like a senior engineer briefing a colleague. No filler, no praise, no restating the snapshot keys.
- Structure with short bold labels: **NOW** (what is happening per run), **ISSUES** (orchestration problems observed: dead coordinators, degraded models, blocked reviews, stalled workers), **FIXES** (what was already fixed/applied), **NEEDED** (only if an operator decision is required; omit otherwise), **NEXT** (what happens next).
- Use the run titles given. Never invent facts not present in the snapshot. Never include tokens, IPs, or secrets.
- At most ${NARRATOR_MAX_CHARS} characters total. Output ONLY the update text.`;

// Compose the narrative via the free narrator chain. Never throws; on total
// failure returns { ok:false, text: fallbackNarrative(bundle) }.
export function composeNarrativeSync(bundle, { runsDir, runId = null, sshHost = "controller", timeoutSec = 120 } = {}) {
  const fb = fallbackNarrative(bundle);
  try {
    const prompt = `${SYSTEM_RULES}\n\nSNAPSHOT (JSON):\n${JSON.stringify(bundle, null, 1).slice(0, 6000)}`;
    const sid = narratorSessionId("heartbeat");
    const r = callFreeRole("narrator", prompt, {
      runsDir, runId, component: "narrator", purpose: "heartbeat",
      managedCwd: NARRATOR_CWD, managedSessionId: sid, managedTitle: "[orchestrator] heartbeat",
      // Sol turn-4 correction 3: narration gets ONE ~60s budget for the whole
      // chain; on expiry the deterministic fallback posts immediately so a
      // degraded inference service can never undermine the 5-min cadence.
      sshHost, timeoutSec: 45, totalTimeoutSec: 60, readOnly: true,
    });
    if (r.ok && r.output && r.output.trim().length > 20) {
      return { ok: true, model: r.model, text: r.output.trim().slice(0, NARRATOR_MAX_CHARS) };
    }
    return { ok: false, model: r.model ?? null, text: fb, reason: r.reason ?? "narrator chain failed" };
  } catch (e) {
    return { ok: false, model: null, text: fb, reason: String(e.message ?? e).slice(0, 200) };
  }
}

export async function composeNarrative(bundle, opts = {}) {
  return composeNarrativeSync(bundle, opts);
}

// ---------------------------------------------------------------------------
// Consult narration (2026-09-27, operator: "I am not getting proper narrative
// updates in discord ... read run 080 and you will see the updates have been
// bugged and abysmal").
//
// Run 080's thread is the evidence: every update was the same canned line —
// "**NOW** duo consult <id> - OPEN. N consultant turn(s), no verdict yet" -
// repeated verbatim for 40 minutes. That was not a degraded model, it was NO
// model: consult updates were built by a fixed template in consult-watch.mjs
// and never went near the narrator chain that orchestration runs have used
// since V3.3.13.
//
// They go through the narrator now, on the role chain the operator mandated:
// the Go-plan managed Muse first (ticket 255, 2026-10-03), then the free tail
// space-bunny -> ling-3.1 -> longcat (lib/free-model-registry.mjs, role
// "narrator"). No metered spend, and
// the consultant's own session is never interrupted to write a status line.
//
// Cost/liveness discipline, unchanged from the run narrator: ONE ~60s budget
// for the whole chain, read-only, and any failure falls straight back to the
// deterministic text so a slow free model costs prose and never the cadence.
export const CONSULT_NARRATOR_MAX_CHARS = 1200;

const CONSULT_RULES =
`You are the orchestration narrator for a homelab AI fleet, writing a Discord update about ONE live duo-consult session (the requesting agent consulting a senior technical consultant).
Write what an engineer would actually want to know about this consult right now. Rules:
- Structure with short bold labels: **NOW** (what this consult is actually working through), **SAID** (the substance of the latest consultant turn or question - the real content, not that a turn happened), **VERDICT** (only when one exists), **NEXT** (what the session is waiting on).
- Read the transcript and notepad excerpts and report their SUBSTANCE. Never pad with the session id, turn counts, or timestamps - the reader can see those.
- If nothing has actually moved since the last update, say so in one short line instead of restating the topic.
- Direct and technical, like a senior engineer briefing a colleague. No filler, no praise, no meta-commentary about being an update.
- Never invent facts not present in the excerpts. Never include tokens, IPs, or secrets.
- At most ${CONSULT_NARRATOR_MAX_CHARS} characters. Output ONLY the update text.`;

// Compose a consult update via the free narrator chain. `fallback` is the
// deterministic text the caller would otherwise have posted; it is returned
// unchanged on any failure. Never throws.
export function composeConsultNarrativeSync(snap, fallback, { runsDir = null, runId = null, sshHost = "controller" } = {}) {
  const fb = String(fallback ?? "").trim();
  try {
    const ctx = {
      topic: snap?.topic ?? snap?.firstIssue ?? null,
      state: snap?.isCurrent ? "OPEN" : "idle (no longer the current session)",
      consultantTurns: snap?.turns ?? 0,
      lastVerdict: snap?.lastVerdict ?? null,
      minutesSinceLastActivity: snap?.ageMin ?? null,
      runNumber: snap?.runNumber ?? null,
      issueNumber: snap?.issueNumber ?? null,
      transcriptTail: String(snap?.transcriptTail ?? "").slice(0, 3500),
      notepadTail: String(snap?.notepadTail ?? "").slice(0, 1200),
    };
    const prompt = `${CONSULT_RULES}\n\nCONSULT SNAPSHOT (JSON):\n${JSON.stringify(ctx, null, 1).slice(0, 6000)}`;
    const sid = narratorSessionId("consult-update");
    const r = callFreeRole("narrator", prompt, {
      runsDir, runId, component: "narrator", purpose: "consult-update",
      managedCwd: NARRATOR_CWD, managedSessionId: sid, managedTitle: "[orchestrator] consult-update",
      sshHost, timeoutSec: 45, totalTimeoutSec: 60, readOnly: true,
    });
    if (r.ok && r.output && r.output.trim().length > 40) {
      return { ok: true, model: r.model, text: r.output.trim().slice(0, CONSULT_NARRATOR_MAX_CHARS) };
    }
    return { ok: false, model: r.model ?? null, text: fb, reason: r.reason ?? "consult narrator chain failed" };
  } catch (e) {
    return { ok: false, model: null, text: fb, reason: String(e?.message ?? e).slice(0, 200) };
  }
}

// ---------------------------------------------------------------------------
// Smart thread titles (2026-09-27, operator ask: "I want the actual
// conversation content to generate the title smarter").
//
// taskTitle()/consultTitle() just truncate the request's first line, so threads
// ended up named after whatever boilerplate the brief happened to open with.
// This composes a real title from the WHOLE brief using the same FREE opencode
// chain the narrator already uses — no paid seat, and it never touches the
// consultant/worker model (the operator's freebuff/GLM seat is never
// interrupted to name a thread).
//
// Display-only and fail-open: any failure, timeout, or implausible answer falls
// straight back to the deterministic title. Budget is deliberately small (~25s
// single attempt) because this runs inline before engine dispatch.
export const TITLE_MAX_CHARS = 70;

// Strip the model's habitual wrappers: quotes, "Title:" prefixes, markdown,
// trailing periods, multi-line rambling. Returns "" if nothing usable is left.
export function sanitizeTitle(raw, max = TITLE_MAX_CHARS) {
  let t = String(raw ?? "")
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter((l) => l.length > 0)
    .pop() ?? "";
  t = t.replace(/^(?:title|thread(?: name| title)?|answer)\s*[:\-—]\s*/i, "");
  t = t.replace(/^["'“‘]+|["'”’]+$/g, "");
  t = t.replace(/[`*_~|#]/g, "").replace(/\s+/g, " ").trim();
  t = t.replace(/[.\s]+$/, "");
  if (t.length > max) {
    const cut = t.slice(0, max);
    t = (cut.includes(" ") ? cut.slice(0, cut.lastIndexOf(" ")) : cut).trim() + "…";
  }
  // Plausibility gate: a title is a short phrase, not a sentence of prose and
  // not a one-word shrug. Anything else is treated as a failed generation.
  if (t.length < 12 || t.split(" ").length < 2) return "";
  return t;
}

const TITLE_RULES =
`Write a Discord thread title for the engineering request below.
Rules:
- At most  characters. A noun phrase, not a sentence.
- Name the SYSTEM or component AND the actual PROBLEM or goal, so a reader who
  never saw the request knows what the thread is about.
- Use the concrete names that appear in the request (service, container, file).
- No quotes, no markdown, no trailing period, no "Run NNN" prefix, no filler
  like "investigation into" or "discussion about".
- Output ONLY the title, on one line.`;

// Compose a topic title from the full brief. Always returns a usable string:
// `fallback` on any failure. Never throws.
export function composeThreadTitleSync(brief, fallback, { runsDir = null, runId = null, sshHost = "controller", timeoutSec = 25 } = {}) {
  const fb = String(fallback ?? "").trim();
  const text = String(brief ?? "").trim();
  if (text.length < 40) return { ok: false, title: fb, reason: "brief too short to improve on" };
  try {
    const prompt = `${TITLE_RULES}\n\nREQUEST:\n${text.slice(0, 4000)}`;
    const sid = narratorSessionId("thread-title");
    const r = callFreeRole("narrator", prompt, {
      runsDir, runId, component: "narrator", purpose: "thread-title",
      managedCwd: NARRATOR_CWD, managedSessionId: sid, managedTitle: "[orchestrator] thread-title",
      sshHost, timeoutSec, totalTimeoutSec: timeoutSec + 10, readOnly: true,
    });
    if (!r.ok || !r.output) return { ok: false, title: fb, model: r.model ?? null, reason: r.reason ?? "title chain failed" };
    const t = sanitizeTitle(r.output);
    if (!t) return { ok: false, title: fb, model: r.model ?? null, reason: "model output was not a usable title" };
    return { ok: true, title: t, model: r.model ?? null };
  } catch (e) {
    return { ok: false, title: fb, reason: String(e?.message ?? e).slice(0, 160) };
  }
}
