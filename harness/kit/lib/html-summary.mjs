// html-summary.mjs — V3.3.21 visual run summary (operator request 2026-09-21,
// inspired by the r/claudeskills "summary" skill: a single-page visual HTML
// digest for HUMAN consumption after a run reaches a terminal state).
//
// DESIGN CONTRACT (mirrors lib/debrief.mjs discipline):
//   - DETERMINISTIC: rendered from the same structured facts the debrief uses
//     (state.json, plan.md, engine-usage.jsonl, exact-marker COUNTS). run.log
//     is NEVER quoted — counts only, same as debrief.
//   - SELF-CONTAINED: one .html file, inline SVG, zero frameworks, zero
//     external requests (works offline from the runs dir, openable via scp).
//   - BOUNDED: SUMMARY_MAX_BYTES cap; long fields clamped; phases capped at 12.
//   - IDEMPOTENT per terminal state (marker check, like debrief v1).
//   - FIRE-AND-FORGET: a summary failure can never affect terminal state.
//   - Modes: plain | accessible | artistic | animated (spec's four modes;
//     mode only varies CSS/animation, never the data).
import { readFileSync, writeFileSync, existsSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";

export const SUMMARY_MAX_BYTES = 60 * 1024;
export const SUMMARY_MODES = ["plain", "accessible", "animated", "artistic"];
const MAX_PHASES_SHOWN = 12;
const MARKERS = ["SPAWN-REFUSED", "NUDGE DELIVERY FAILED", "OPERATOR OVERRIDE"];

const cap = (s, n) => { s = String(s ?? ""); return s.length <= n ? s : s.slice(0, n - 1) + "…"; };
const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
function readJson(p) { try { return JSON.parse(readFileSync(p, "utf8")); } catch { return null; } }

export function canonicalSummaryMode(m) {
  const k = String(m ?? "plain").toLowerCase().trim();
  return SUMMARY_MODES.includes(k) ? k : "plain";
}

// ---- data gathering (same facts as debrief; no log prose ever) ----
export function gatherRunFacts(runsDir, runId, { now = Date.now() } = {}) {
  const rd = join(runsDir, runId);
  const state = readJson(join(rd, "state.json")) ?? {};
  let planPhases = [];
  try {
    const plan = readFileSync(join(rd, "plan.md"), "utf8");
    const titles = [...plan.matchAll(/^## Phase (\d+):([^\n]*)/gm)].map((m) => ({ n: Number(m[1]), title: m[2].trim() }));
    planPhases = titles;
  } catch { /* no plan */ }
  const usage = [];
  try {
    const lines = readFileSync(join(runsDir, "engine-usage.jsonl"), "utf8").split("\n");
    for (const l of lines.slice(-4000)) {
      if (!l.trim()) continue;
      try { const r = JSON.parse(l); if (r.runId === runId) usage.push(r); } catch { /* skip */ }
    }
  } catch { /* no telemetry */ }
  const markers = {};
  try {
    const log = readFileSync(join(rd, "run.log"), "utf8");
    for (const m of MARKERS) markers[m] = (log.match(new RegExp(m.replace(/[- ]/g, "\\$&"), "g")) || []).length;
  } catch { for (const m of MARKERS) markers[m] = 0; }
  const freebucks = usage.reduce((a, r) => a + (r.freebucksUsed ?? 0), 0);
  const fails = usage.filter((r) => r.success === false);
  const byEngine = {};
  for (const r of usage) { const k = r.engine ?? "?"; byEngine[k] = byEngine[k] ?? { total: 0, failed: 0 }; byEngine[k].total++; if (r.success === false) byEngine[k].failed++; }
  const verdicts = state.phaseVerdicts ?? {};
  const artifacts = [];
  for (const f of ["plan.md", "review-phase1.md", "review-phase2.md", "final-acceptance-1.md", "final-acceptance-2.md", "debrief.md"]) {
    try { artifacts.push({ file: f, bytes: statSync(join(rd, f)).size }); } catch { /* absent */ }
  }
  try { artifacts.push({ file: "deployed/", bytes: readdirSync(join(rd, "deployed")).length, unit: "files" }); } catch { /* absent */ }
  return {
    runId,
    task: cap((state.task ?? "(unknown)").replace(/\s+/g, " "), 400),
    runState: state.runState ?? "unknown",
    mode: state.mode === "duo" ? "dual" : (state.mode ?? "?"),
    seats: (state.seats ?? state.workers ?? []).map((s) => (typeof s === "string" ? s : s.id)).join("+") || "?",
    startedAt: state.startedAt ?? null,
    durationMin: state.startedAt ? Math.max(1, Math.round((now - state.startedAt) / 60000)) : null,
    completedThrough: state.completedThrough ?? 0,
    phases: planPhases.map((p) => ({ n: p.n, title: cap(p.title, 90), verdict: verdicts[p.n] ?? verdicts[String(p.n)] ?? (p.n <= (state.completedThrough ?? 0) ? "done" : (state.currentPhase === p.n ? "in progress" : "pending")) })),
    freebucks, usageCount: usage.length, failureCount: fails.length, byEngine, markers, artifacts,
    finalAcceptance: state.finalAcceptance ?? null,
    generatedAt: new Date(now).toISOString(),
  };
}
// ---- SVG chart builders (inline, no external assets) ----
function svgPhaseTimeline(phases, w = 640) {
  if (!phases.length) return "";
  const shown = phases.slice(0, MAX_PHASES_SHOWN);
  const bw = Math.min(120, Math.floor((w - 20) / shown.length) - 12), bh = 64, y0 = 46, x0 = 10;
  const color = (v) => /APPROVED|COMPLETED|done/i.test(v) ? "#22c55e" : /NEEDS_WORK/i.test(v) ? "#f59e0b" : /in progress/i.test(v) ? "#3b82f6" : /BLOCKER|FAIL/i.test(v) ? "#ef4444" : "#64748b";
  let s = `<svg viewBox="0 0 ${w} ${bh + 34}" xmlns="http://www.w3.org/2000/svg" role="img" aria-label="phase timeline">`;
  shown.forEach((p, i) => {
    const x = x0 + i * (bw + 12);
    s += `<rect x="${x}" y="${y0}" width="${bw}" height="${bh}" rx="8" fill="${color(p.verdict)}" opacity="0.85"/>`;
    s += `<text x="${x + bw / 2}" y="${y0 - 8}" text-anchor="middle" font-size="12" fill="currentColor">P${p.n}</text>`;
    const words = p.title.split(/\s+/); let line = "", lines = [];
    for (const wd of words) { if ((line + " " + wd).trim().length > 16) { lines.push(line.trim()); line = wd; } else line += " " + wd; }
    if (line.trim()) lines.push(line.trim()); lines = lines.slice(0, 2);
    lines.forEach((ln, li) => { s += `<text x="${x + bw / 2}" y="${y0 + 18 + li * 13}" text-anchor="middle" font-size="9.5" fill="#fff">${esc(ln)}</text>`; });
    s += `<text x="${x + bw / 2}" y="${y0 + bh - 6}" text-anchor="middle" font-size="8.5" fill="#e2e8f0">${esc(cap(p.verdict, 14))}</text>`;
  });
  return s + `</svg>`;
}

function svgDonut(used, total, label, color = "#38bdf8") {
  const pct = total > 0 ? Math.min(1, used / total) : 0;
  const r = 40, c = 2 * Math.PI * r, off = c * (1 - pct);
  return `<svg viewBox="0 0 120 120" width="120" height="120" xmlns="http://www.w3.org/2000/svg" role="img" aria-label="${esc(label)} ${Math.round(pct * 100)}%">`
    + `<circle cx="60" cy="60" r="${r}" fill="none" stroke="#334155" stroke-width="14"/>`
    + `<circle cx="60" cy="60" r="${r}" fill="none" stroke="${color}" stroke-width="14" stroke-dasharray="${c.toFixed(1)}" stroke-dashoffset="${off.toFixed(1)}" stroke-linecap="round" transform="rotate(-90 60 60)"/>`
    + `<text x="60" y="57" text-anchor="middle" font-size="20" font-weight="600" fill="currentColor">${esc(used)}</text>`
    + `<text x="60" y="76" text-anchor="middle" font-size="10" fill="#94a3b8">${esc(label)}</text></svg>`;
}

// ---- page assembly ----
export function buildHtmlSummary(runsDir, runId, { mode = "plain", now = Date.now() } = {}) {
  const m = canonicalSummaryMode(mode);
  const f = gatherRunFacts(runsDir, runId, { now });
  const fx = m === "animated" ? `<style>@keyframes rise{from{opacity:0;transform:translateY(10px)}to{opacity:1;transform:none}}.card{animation:rise .5s ease both}.card:nth-child(2){animation-delay:.08s}.card:nth-child(3){animation-delay:.16s}.card:nth-child(4){animation-delay:.24s}@keyframes pulse{0%,100%{opacity:.85}50%{opacity:1}}.donut svg{animation:pulse 3s ease-in-out infinite}</style>` : "";
  const bigType = m === "artistic" ? `<style>h1{font-size:2.6rem;letter-spacing:-.02em}h2{font-size:1.35rem;text-transform:uppercase;letter-spacing:.14em;color:#7dd3fc}</style>` : "";
  const a11y = m === "accessible" ? `<style>:root{font-size:19px}body{line-height:1.7;color:#f8fafc;background:#0b1020}.card{border-width:3px}svg text{font-size:110%}</style>` : "";
  const verdictColor = /COMPLETED/i.test(f.runState) ? "#22c55e" : /NEEDS_HUMAN|HELD|ABORTED|FAIL/i.test(f.runState) ? "#f59e0b" : "#38bdf8";
  const phaseRows = f.phases.slice(0, MAX_PHASES_SHOWN).map((p) => `<tr><td>Phase ${p.n}</td><td>${esc(p.title)}</td><td><span class="pill" style="background:${/APPROVED|done/i.test(p.verdict) ? "#14532d" : /NEEDS_WORK/i.test(p.verdict) ? "#713f12" : /in progress/i.test(p.verdict) ? "#1e3a8a" : "#334155"}">${esc(p.verdict)}</span></td></tr>`).join("") || `<tr><td colspan="3">(no phases recorded)</td></tr>`;
  const engineRows = Object.entries(f.byEngine).map(([e, v]) => `<tr><td>${esc(e)}</td><td>${v.total}</td><td>${v.failed}</td></tr>`).join("") || `<tr><td colspan="3">(no engine calls)</td></tr>`;
  const markerRows = Object.entries(f.markers).filter(([, c]) => c > 0).map(([k, c]) => `<li><code>${esc(k)}</code> ×${c}</li>`).join("") || `<li>(none)</li>`;
  const artRows = f.artifacts.map((a) => `<li><code>${esc(a.file)}</code> ${a.bytes}${a.unit ? ` ${esc(a.unit)}` : " B"}</li>`).join("") || `<li>(none)</li>`;
  const fa = f.finalAcceptance;
  const faLine = fa ? (fa.verdict ? `final acceptance: ${esc(fa.verdict)}` : fa.overridden ? `closed by operator override — ${esc(cap(fa.overrideReason ?? "", 260))}` : "") : "";

  return `<!-- run-summary v1 state=${esc(f.runState)} mode=${esc(m)} --><!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Run summary — ${esc(f.runId)}</title>
<style>:root{color-scheme:dark}body{margin:0;padding:2rem;font:15px/1.55 system-ui,-apple-system,"Segoe UI",sans-serif;background:#0b1020;color:#e2e8f0;max-width:960px;margin-inline:auto}
h1{font-size:1.7rem;margin:0 0 .2rem}h2{font-size:1.05rem;margin:0 0 .6rem;color:#93c5fd}
.card{background:#111a2e;border:1px solid #1e293b;border-radius:14px;padding:1rem 1.2rem;margin:1rem 0}
.grid{display:flex;gap:1rem;flex-wrap:wrap;align-items:center}
.pill{display:inline-block;padding:.15rem .6rem;border-radius:999px;font-size:.8rem;font-weight:600;color:#fff}
code{background:#1e293b;padding:.08rem .35rem;border-radius:6px;font-size:.85em}
table{border-collapse:collapse;width:100%}td,th{padding:.35rem .5rem;border-bottom:1px solid #1e293b;text-align:left;font-size:.92rem}
.muted{color:#94a3b8;font-size:.85rem}.donut{display:flex;gap:1rem;flex-wrap:wrap}
footer{margin-top:1.5rem}</style>${fx}${bigType}${a11y}</head><body>
<h1>Run <code>${esc(f.runId)}</code></h1>
<p><span class="pill" style="background:${verdictColor}">${esc(f.runState)}</span> <span class="muted">mode ${esc(f.mode)} · seats ${esc(f.seats)} · ${f.durationMin ? `~${f.durationMin} min` : "duration ?"} · generated ${esc(f.generatedAt)}</span></p>
<div class="card"><h2>Task</h2><p>${esc(f.task)}</p>${faLine ? `<p class="muted">${faLine}</p>` : ""}</div>
<div class="card"><h2>Phases</h2>${svgPhaseTimeline(f.phases)}<table><tr><th>#</th><th>Title</th><th>Verdict</th></tr>${phaseRows}</table></div>
<div class="card"><h2>Execution</h2><div class="donut">${svgDonut(f.completedThrough, Math.max(f.phases.length, f.completedThrough, 1), "phases done", "#22c55e")}${svgDonut(f.freebucks, Math.max(f.freebucks, 10), "freebucks", "#38bdf8")}${svgDonut(f.usageCount, Math.max(f.usageCount, 1), "engine calls", "#a78bfa")}</div>
<table><tr><th>Engine</th><th>Calls</th><th>Failed</th></tr>${engineRows}</table></div>
<div class="card"><h2>Failure markers</h2><ul>${markerRows}</ul></div>
<div class="card"><h2>Artifacts</h2><ul>${artRows}</ul></div>
<footer><p class="muted">Generated deterministically from structured run facts (lib/html-summary.mjs V3.3.21) — run.log is never quoted. Mode: ${esc(m)}.</p></footer>
</body></html>`;
}

// Entry point — fire-and-forget from terminal paths. Idempotent per terminal
// state (same discipline as debrief v1); a state CHANGE regenerates.
export function ensureHtmlSummary(runsDir, runId, { mode = "plain", now = Date.now() } = {}) {
  const m = canonicalSummaryMode(mode);
  const rd = join(runsDir, runId);
  const state = readJson(join(rd, "state.json"));
  if (!state) return { created: false, reason: "no state.json" };
  const file = join(rd, "summary.html");
  const marker = `<!-- run-summary v1 state=${state.runState} mode=${m}`;
  try { if (existsSync(file) && readFileSync(file, "utf8").startsWith(marker)) return { created: false, reason: `already summarized at ${state.runState}` }; } catch { /* regenerate */ }
  let html = buildHtmlSummary(runsDir, runId, { mode: m, now });
  if (Buffer.byteLength(html, "utf8") > SUMMARY_MAX_BYTES) html = html.slice(0, SUMMARY_MAX_BYTES - 40) + "\n<!-- truncated at cap -->\n</body></html>";
  writeFileSync(file, html);
  return { created: true, file, bytes: Buffer.byteLength(html, "utf8"), mode: m };
}
