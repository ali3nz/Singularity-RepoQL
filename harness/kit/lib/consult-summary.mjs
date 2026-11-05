// consult-summary.mjs — V3.3.31 (operator 2026-09-24): duo-consults get the
// same closing artifact runs have had since V3.3.21 — a self-contained HTML
// summary attached to their Discord thread at close.
//
// DESIGN CONTRACT (mirrors lib/html-summary.mjs / lib/debrief.mjs discipline):
//   - DETERMINISTIC: rendered from runs/consult/<id>/{transcript.md,NOTEPAD.md,
//     meta.json}. No LLM, no network, no freebucks.
//   - SELF-CONTAINED: one .html file, inline CSS, zero external requests.
//   - BOUNDED: SUMMARY_MAX_BYTES cap; transcript tail-clipped; NOTEPAD capped.
//   - FIRE-AND-FORGET: a summary failure can never affect the consult close.
//   - SIGNOFF RECORD: close-signoff.json is written only after the file
//     exists (the bridge dedupes on it; orchestrate.mjs consult --end gates
//     its success line on it).
import { readFileSync, writeFileSync, existsSync, statSync } from "node:fs";
import { join } from "node:path";

export const SUMMARY_MAX_BYTES = 60 * 1024;
const MAX_TRANSCRIPT_CHARS = 60_000;   // tail-clip huge transcripts
const MAX_NOTEPAD_CHARS = 8_000;
const MAX_TURNS_SHOWN = 40;

const cap = (s, n) => { s = String(s ?? ""); return s.length <= n ? s : s.slice(0, n - 1) + "…"; };
const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
function readText(p) { try { return readFileSync(p, "utf8"); } catch { return null; } }
function readJson(p) { try { return JSON.parse(readFileSync(p, "utf8")); } catch { return null; } }

// Split the transcript into turn sections: "## REQUESTER (turn N)" / ("## BUFFY" = legacy)
// "## CONSULTANT (<engine>) (turn N)" / "## SESSION CLOSED".
export function parseTranscript(txt) {
  const out = [];
  const lines = String(txt ?? "").split("\n");
  let cur = null;
  for (const l of lines) {
    let m = l.match(/^## (REQUESTER|BUFFY|CONSULTANT \(([^)]+)\)) \(turn (\d+)\)/);
    if (m) {
      if (cur) out.push(cur);
      cur = { who: (m[1] === "REQUESTER" || m[1].startsWith("BUFFY")) ? "buffy" : "consultant", engine: m[2] ?? null, turn: Number(m[3]), body: [] };
      continue;
    }
    if (/^## SESSION CLOSED/.test(l)) {
      if (cur) out.push(cur);
      cur = { who: "system", engine: null, turn: null, body: [] };
      continue;
    }
    if (cur && cur.body.length < 4000) cur.body.push(l);
  }
  if (cur) out.push(cur);
  return out.map((t) => ({ ...t, body: t.body.join("\n").trim() })).filter((t) => t.body || t.who === "system");
}

// What the summary header says: topic from the NOTEPAD's first requester line,
// verdicts harvested from consultant lines.
export function gatherConsultFacts(consultDir, consultId, { now = Date.now() } = {}) {
  const transcript = readText(join(consultDir, "transcript.md")) ?? "";
  const notepad = readText(join(consultDir, "NOTEPAD.md")) ?? "";
  const meta = readJson(join(consultDir, "meta.json")) ?? {};
  const tail = transcript.length > MAX_TRANSCRIPT_CHARS
    ? "…(earlier turns clipped)…\n" + transcript.slice(-MAX_TRANSCRIPT_CHARS)
    : transcript;
  const turns = parseTranscript(tail).slice(-MAX_TURNS_SHOWN);
  let firstIssue = null, lastVerdict = null;
  for (const raw of notepad.split("\n")) {
    let m = raw.match(/^- \d{1,2}:\d{2}\s+(?:buffy|requester):\s+(.+)$/i);
    if (m && !firstIssue) firstIssue = m[1].trim();
    m = raw.match(/^- \d{1,2}:\d{2}\s+consultant:\s*VERDICT=([A-Z_]+)/i);
    if (m) lastVerdict = m[1].toUpperCase();
    m = raw.match(/^- \d{1,2}:\d{2}\s+coordinator:\s*session CLOSED\s*—\s*(.+)$/i);
    if (m) lastVerdict = lastVerdict ?? null;
  }
  const closeNote = (transcript.match(/## SESSION CLOSED\n\n([\s\S]*?)(\n\n|$)/)?.[1] ?? "").trim();
  const startedAt = meta.startedAt ? new Date(meta.startedAt).toISOString() : null;
  const durationMin = meta.startedAt ? Math.max(1, Math.round((now - meta.startedAt) / 60000)) : null;
  return {
    consultId, engine: meta.engine ?? "?", turnsCount: meta.turns ?? turns.filter((t) => t.who === "consultant").length,
    startedAt, durationMin, firstIssue: cap(firstIssue ?? "(not recorded)", 300),
    lastVerdict, closeNote: cap(closeNote, 600), turns, notepad: cap(notepad, MAX_NOTEPAD_CHARS),
    bytes: (() => { try { return statSync(join(consultDir, "transcript.md")).size; } catch { return 0; } })(),
    generatedAt: new Date(now).toISOString(),
  };
}

const CSS = `body{font-family:ui-sans-serif,system-ui,'Segoe UI',Roboto,sans-serif;margin:0;background:#0f1420;color:#dbe2ef;line-height:1.55}
.wrap{max-width:960px;margin:0 auto;padding:28px 20px 60px}
h1{font-size:1.45rem;margin:0 0 4px}h2{font-size:1.05rem;margin:28px 0 10px;color:#8ab4ff;border-bottom:1px solid #26304a;padding-bottom:6px}
.sub{color:#8b96ad;font-size:.85rem;margin-bottom:18px}
.badge{display:inline-block;background:#1c2740;border:1px solid #33436b;border-radius:6px;padding:2px 10px;margin-right:6px;font-size:.8rem;color:#cdd9f5}
.verdict{font-weight:700}
.v-CONFIRMED{color:#4ade80}.v-CONTRADICTED{color:#f87171}.v-UNCERTAIN{color:#fbbf24}
.turn{border:1px solid #26304a;border-radius:8px;margin:12px 0;overflow:hidden}
.turn .hd{padding:6px 12px;font-size:.78rem;letter-spacing:.4px;text-transform:uppercase;background:#161e30;color:#9db2d8}
.turn .hd .b{color:#7dd3fc}.turn .hd .c{color:#c4b5fd}
.turn pre{margin:0;padding:12px 14px;white-space:pre-wrap;word-break:break-word;font-family:ui-monospace,SFMono-Regular,Menlo,monospace;font-size:.82rem;color:#d5deee}
.note{background:#141b2c;border:1px dashed #33436b;border-radius:8px;padding:10px 14px;margin:10px 0;font-size:.82rem;color:#aeb9d0;white-space:pre-wrap}
footer{margin-top:34px;color:#5b6880;font-size:.75rem;border-top:1px solid #26304a;padding-top:12px}`;

function renderTurn(t) {
  const label = t.who === "buffy" ? `Requester — turn ${t.turn}`
    : t.who === "consultant" ? `Consultant (${t.engine ?? "?"}) — turn ${t.turn}`
    : "Session closed";
  const cls = t.who === "buffy" ? "b" : t.who === "consultant" ? "c" : "";
  return `<div class="turn"><div class="hd"><span class="${cls}">${esc(label)}</span></div><pre>${esc(t.body || "(empty)")}</pre></div>`;
}

export function renderConsultSummary(f) {
  const verdictBadge = f.lastVerdict
    ? `<span class="badge verdict v-${esc(f.lastVerdict)}">${esc(f.lastVerdict)}</span>`
    : `<span class="badge">no stated verdict</span>`;
  const turnsHtml = f.turns.length ? f.turns.map(renderTurn).join("\n") : "<div class='note'>No turns parsed from transcript.</div>";
  return `<!doctype html><html><head><meta charset="utf-8"><title>duo consult ${esc(f.consultId)}</title><style>${CSS}</style></head>
<body><div class="wrap">
<h1>duo consult ${esc(f.consultId)}</h1>
<div class="sub">Requester + ${esc(f.engine)} consultant · generated ${esc(f.generatedAt)}</div>
<div>${verdictBadge}<span class="badge">${f.turnsCount} consultant turn(s)</span>${f.durationMin ? `<span class="badge">~${f.durationMin} min</span>` : ""}<span class="badge">transcript ${(f.bytes / 1024).toFixed(1)} KB</span></div>
<h2>Topic</h2><div class="note">${esc(f.firstIssue)}</div>
${f.closeNote ? `<h2>Close note</h2><div class="note">${esc(f.closeNote)}</div>` : ""}
<h2>Conversation</h2>
${turnsHtml}
<h2>NOTEPAD (shared pad, verbatim tail)</h2><div class="note">${esc(f.notepad)}</div>
<footer>Self-contained summary — runs/consult/${esc(f.consultId)}/ · generated deterministically by the orchestration kit (V3.3.31), no LLM. Full transcript lives in the same directory.</footer>
</div></body></html>`;
}

// Write (if missing) and record the signoff. Idempotent: re-closing the same
// session regenerates only when the transcript grew (closeNote edits), then
// refreshes close-signoff.json.
export function writeConsultSummary(consultDir, consultId, { now = Date.now() } = {}) {
  const out = { ok: false, path: null, reason: "" };
  try {
    const facts = gatherConsultFacts(consultDir, consultId, { now });
    const html = renderConsultSummary(facts);
    const p = join(consultDir, "summary.html");
    writeFileSync(p, html.length > SUMMARY_MAX_BYTES ? html.slice(0, SUMMARY_MAX_BYTES) + "\n<!-- clipped -->" : html);
    const signoff = { consultId, signedOffAt: new Date(now).toISOString(), bytes: html.length, turns: facts.turnsCount, engine: facts.engine, lastVerdict: facts.lastVerdict };
    writeFileSync(join(consultDir, "close-signoff.json"), JSON.stringify(signoff, null, 1) + "\n");
    out.ok = true; out.path = p;
  } catch (e) {
    out.reason = String(e?.message ?? e).slice(0, 200);
  }
  return out;
}
