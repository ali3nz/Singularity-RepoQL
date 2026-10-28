// jobs-list.mjs — V3.3.14.5 (operator 2026-09-20): "@openclaw jobs" — one
// Discord reply listing ALL orchestration jobs with their current state.
// Pure module (same pattern as orch_digest.py / openchamber-remediate.mjs):
// no fs, no ssh, no network — cmdJobs() collects and calls renderJobs();
// selftest covers the renderer + summaries with fixtures.
//
// Kit runs come from runs/<id>/state.json; the external openchamber-ha job is
// summarized by openchamber-watch.mjs (deploymentSummary + bundle runState).
export const JOBS_REPLY_MAX_CHARS = 1700; // bridge reply caps at 1700 — never exceed
export const MAX_KIT_LINES = 10;          // bounded board; oldest dropped on overflow

// V3.3.16 display canonicalization: pre-rename runs carry mode "duo"; the
// canonical display name is now "dual" (kept here for any future mode display).
export function canonMode(m) {
  return m === "duo" ? "dual" : String(m ?? "");
}

// state.json has NO mode field — derive from the workers list (same rule as
// the daily digest): gamma/delta present => quad; <=1 => solo; else dual.
export function modeOfWorkers(workers, stateMode = null) {
  if (stateMode === "custom") return "custom"; // ticket 189: roster runs carry their own mode
  const ws = (workers ?? []).map(String);
  if (ws.some((w) => w === "gamma" || w === "delta")) return "quad";
  return ws.length <= 1 ? "solo" : "dual";
}

export function taskSnippet(task, max = 44) {
  const SPEC = /^(APPROVED SPEC|IMPLEMENTED)\b/i;
  for (const raw of String(task ?? "").split("\n")) {
    const l = raw.trim();
    if (l && !SPEC.test(l)) {
      return l.length > max ? l.slice(0, max - 1).trimEnd() + "…" : l;
    }
  }
  return "";
}

// state.json -> one compact board entry (pure; tolerates junk).
export function summarizeKitRun(runId, st) {
  const s = st ?? {};
  const fa = s.finalAcceptance?.verdict;
  return {
    runId: String(runId),
    runState: String(s.runState ?? "?"),
    mode: modeOfWorkers(s.workers, s.mode),
    fb: Number(s.newSessionsThisRun ?? 0) * 5,
    task: taskSnippet(s.task),
    final: fa ? String(fa) : null,
    blocked: s.blockedAtPhase ?? null,
    terminal: /^(COMPLETED|ABORTED)/.test(String(s.runState ?? "")),
  };
}

function kitLine(r) {
  const bits = [`• \`${r.runId}\` — **${r.runState}**`];
  if (r.blocked != null && !r.terminal) bits.push(`blocked@P${r.blocked}`);
  bits.push(`${r.mode} · ~${r.fb} fb`);
  if (r.final) bits.push(`final: ${r.final}`);
  const head = bits.join(" · ");
  return r.task ? `${head}\n  ${r.task}` : head;
}

function ocLine(o) {
  const bits = [`• \`openchamber-ha\` (external) — **${o.runState}**`];
  if (o.detail) bits.push(o.detail);
  const head = bits.join(" · ");
  return o.title ? `${head}\n  ${o.title}` : head;
}

// V3.3.17: duo-consult sessions + other openchamber orchestrator sessions on
// the board (they now have their own Discord threads — the board must agree).
function consultLine(c) {
  const bits = [`• \`${c.runId}\` (consult) — **${c.state}**`];
  if (c.turns != null) bits.push(`${c.turns} turn(s)`);
  if (c.lastVerdict) bits.push(`verdict: ${c.lastVerdict}`);
  const head = bits.join(" · ");
  return c.title ? `${head}\n  ${c.title}` : head;
}

function ocSessionLine(s) {
  const state = s.active ? "ACTIVE" : `${s.ageMin ?? "?"}m idle`;
  const head = `• \`openchamber-${s.short}\` (external) — **${state}**`;
  return s.title ? `${head}\n  ${s.title}` : head;
}

// Render the whole board as ONE reply. On overflow the OLDEST kit lines drop
// first, then the external job's detail/title — the header and footer (the
// "what do I do next" pointers) always survive.
export function renderJobs({ kitRuns = [], oc = null, consults = [], ocSessions = [], nowIso = "", maxChars = JOBS_REPLY_MAX_CHARS } = {}) {
  const header = `📋 **ORCHESTRATION JOB BOARD** (${nowIso || "now"})`;
  const footerBits = ["→ detail: `status` · `jobs`"];
  if (oc) footerBits.push("`resume openchamber-ha`");
  const footer = footerBits.join(" · ");
  const assemble = (ks, o, cs, ocs) => {
    const parts = [header, ...ks.map(kitLine), ...(o ? [ocLine(o)] : []),
      ...ocs.map(ocSessionLine), ...cs.map(consultLine), footer];
    return parts.filter(Boolean).join("\n");
  };
  const lines = [...kitRuns].slice(0, MAX_KIT_LINES);
  const consultsBounded = consults.slice(0, 3);
  const ocSessionsBounded = ocSessions.slice(0, 3);
  let text = assemble(lines, oc, consultsBounded, ocSessionsBounded);
  // Overflow order: extra openchamber sessions first, then consult lines,
  // then the oldest kit lines, then the external job's detail/title — header,
  // footer and pointers always survive; never truncates mid-line.
  while (text.length > maxChars && ocSessionsBounded.length) {
    ocSessionsBounded.pop();
    text = assemble(lines, oc, consultsBounded, ocSessionsBounded);
  }
  while (text.length > maxChars && consultsBounded.length) {
    consultsBounded.pop();
    text = assemble(lines, oc, consultsBounded, ocSessionsBounded);
  }
  while (text.length > maxChars && lines.length) {
    lines.pop(); // oldest first (list is newest-first)
    text = assemble(lines, oc, consultsBounded, ocSessionsBounded);
  }
  if (text.length > maxChars && oc) text = assemble(lines, { ...oc, detail: null, title: null }, consultsBounded, ocSessionsBounded);
  if (!kitRuns.length && !oc && !consults.length && !ocSessions.length) text = `${header}\n(no orchestration jobs found)\n${footer}`;
  return text;
}
