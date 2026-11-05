// evidence-pack.mjs — V3.3 follow-up (2026-09-19): richer evidence packing for
// final-acceptance (and quality) on NON-GIT targets. The V3.3 e2e probe
// (run 2026-09-18T18-50-55) held at REMEDIATION_REQUIRED purely on evidence
// strictness: the acceptance reviewer was asked to accept work it could not
// see. Sol has zero system access (operator rule) — every gate call must carry
// its evidence INLINE. This module builds that evidence:
//
//   1. RUN TRANSCRIPT        — coordinator run.log tail + per-worker status
//                              transcripts (phase, progress, questions).
//   2. TARGET STATE          — git diff for git targets; bounded manifest +
//                              newest/most-relevant source files otherwise
//                              (same discipline as plan-cache/quality lane).
//   3. REQUIRED ARTIFACTS    — concrete existence/size/exec-bit checks for
//                              specific artifacts the task/plan demand, so a
//                              reviewer can verify "the file exists and is
//                              executable" WITHOUT trusting prose.
//
// Output format is the established ===== HEADER ===== evidence-pack convention
// (quality lane + humanizer EVIDENCE_MODE), so the humanizer leaves every
// byte of it verbatim once "IMPLEMENTATION EVIDENCE" is in EVIDENCE_MODE.
//
// Bounded by design: PACK_CAP chars total, FILE_CAP per section — Sol prompts
// must stay within the gateway's practical input window.

import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { join, relative, extname } from "node:path";

// keep clipHeadTail hoisted for module-local use below
const clipHeadTail_ = null; // (real definition below, exported)

export const EVIDENCE_PACK_CAP = 24_000;   // total chars across all sections
export const EVIDENCE_FILE_CAP = 4_000;    // per-section / per-file cap
const MAX_WORKER_STATUSES = 6;
const MAX_RUNLOG_TAIL = 3_000;
const MAX_MANIFEST_ENTRIES = 120;
const MAX_SNAPSHOT_FILES = 8;
const SOURCE_EXT = new Set([".mjs", ".js", ".ts", ".py", ".sh", ".yaml", ".yml", ".json", ".md", ".txt", ".conf", ".toml", ".rb", ".go", ".rs", ".sql", ".html", ".css"]);

const clip = (s, n) => String(s ?? "").slice(0, Math.max(0, n));

/** Newest-first bounded recursive listing (skips bulky/irrelevant dirs). */
function walkNewest(dir, { skip = new Set(["node_modules", ".git", "runs", "backups", ".repoql", "__pycache__", ".venv"]), depth = 0, acc = [] } = {}) {
  if (depth > 4 || acc.length >= 400) return acc;
  let entries = [];
  try { entries = readdirSync(dir, { withFileTypes: true }); } catch { return acc; }
  for (const e of entries) {
    if (e.name.startsWith(".") && e.name !== ".github") continue;
    if (e.isDirectory() && skip.has(e.name)) continue;
    const abs = join(dir, e.name);
    let st;
    try { st = statSync(abs); } catch { continue; }
    if (st.isDirectory()) walkNewest(abs, { skip, depth: depth + 1, acc });
    else acc.push({ abs, rel: relative(dir, abs), mtime: st.mtimeMs, size: st.size });
  }
  return acc;
}

/** Deterministic target snapshot: git diff (git targets) or manifest + files. */
export function targetSnapshot(targetDir, { files = null, budget = EVIDENCE_PACK_CAP } = {}) {
  const parts = [];
  let spent = 0;
  const push = (title, text) => {
    const t = clip(text, Math.min(budget - spent, EVIDENCE_FILE_CAP));
    if (!t) return;
    parts.push(`===== ${title} =====\n${t}\n`);
    spent += t.length + title.length + 10;
  };

  let isGit = false;
  try {
    isGit = spawnSync("git", ["-C", targetDir, "rev-parse", "--is-inside-work-tree"], { encoding: "utf8", timeout: 5000 }).stdout?.trim() === "true";
  } catch { /* not a repo */ }

  if (isGit) {
    const d = spawnSync("git", ["-C", targetDir, "diff", "HEAD"], { encoding: "utf8", timeout: 10_000, maxBuffer: 32 * 1024 * 1024 });
    const st = spawnSync("git", ["-C", targetDir, "status", "--porcelain"], { encoding: "utf8", timeout: 10_000 });
    push("GIT STATUS", st.stdout || "(clean)\n");
    if ((d.stdout ?? "").trim()) push("GIT DIFF", d.stdout);
    else parts.push("===== GIT DIFF ===== (empty working tree vs HEAD)\n");
    return { text: parts.join("\n"), kind: "git" };
  }

  // Non-git: bounded manifest + newest source files.
  const all = walkNewest(targetDir);
  const manifest = all
    .sort((a, b) => b.mtime - a.mtime)
    .slice(0, MAX_MANIFEST_ENTRIES)
    .map((f) => `${new Date(f.mtime).toISOString()}  ${String(f.size).padStart(8)}  ${f.rel}`)
    .join("\n");
  push("TARGET MANIFEST (newest first, bounded)", manifest ? `${manifest}\n` : "(empty target)\n");

  const chosen = files?.length
    ? files.map((rel) => ({ rel, abs: join(targetDir, rel) })).filter((f) => existsSync(f.abs))
    : all.filter((f) => SOURCE_EXT.has(extname(f.rel).toLowerCase()) && f.size < 60_000)
        .sort((a, b) => b.mtime - a.mtime).slice(0, MAX_SNAPSHOT_FILES);
  for (const f of chosen.slice(0, MAX_SNAPSHOT_FILES)) {
    try { push(`FILE: ${f.rel}`, readFileSync(f.abs, "utf8")); } catch { /* skip */ }
  }
  if (!parts.length) parts.push("===== TARGET SNAPSHOT ===== (no readable files)\n");
  return { text: parts.join("\n"), kind: "non-git" };
}

/** Per-worker status transcripts from runs/<runId>/status-<worker>.md. */
export function workerTranscripts(runsDir, runId, { budget = EVIDENCE_PACK_CAP } = {}) {
  const parts = [];
  let spent = 0;
  let dirEntries = [];
  try { dirEntries = readdirSync(join(runsDir, runId)); } catch { return "(run directory unavailable)\n"; }
  const statusFiles = dirEntries.filter((n) => /^status-[\w-]+\.md$/.test(n)).slice(0, MAX_WORKER_STATUSES);
  if (!statusFiles.length) return "(no worker status files recorded)\n";
  for (const name of statusFiles) {
    let body = "";
    try { body = readFileSync(join(runsDir, runId, name), "utf8"); } catch { continue; }
    // V3.3.10 (ticket 028): status files are append-style — the LATEST entries
    // (what the worker did last) are at the end. Keep both ends.
    const t = clipHeadTail(body, Math.min(budget - spent, EVIDENCE_FILE_CAP));
    parts.push(`===== WORKER STATUS: ${name} =====\n${t}\n`);
    spent += t.length + name.length + 30;
  }
  return parts.join("\n");
}

/** Coordinator run log tail — TAIL, not head (V3.3.10, ticket 028). A gate
 *  must see what happened LATEST: head-clipping served the final-acceptance
 *  reviewer of run 04-38-42 a phase-1-era log prefix from a 12-hour run, so
 *  late remediation activity was invisible. */
export function runLogTail(runsDir, runId, { cap = MAX_RUNLOG_TAIL } = {}) {
  try {
    const body = readFileSync(join(runsDir, runId, "run.log"), "utf8");
    if (body.length <= cap) return body;
    return `[run.log: showing the LAST ${cap} of ${body.length} chars — earliest lines omitted]
${body.slice(-cap)}`;
  }
  catch { return "(run.log unavailable)\n"; }
}

/** Keep BOTH ends when bounded content exceeds its cap (V3.3.10, ticket 028).
 *  Appended-log evidence (remediation addenda, final verify sections) lives
 *  at the END of a file; a head-clip hid exactly those sections from the
 *  acceptance reviewer of run 04-38-42, which re-demanded work that was
 *  already done. Exported for orchestrate.mjs selftest coverage. */
export function clipHeadTail(body, cap) {
  const s = String(body ?? "");
  if (s.length <= cap) return s;
  const headN = Math.max(0, Math.floor(cap * 0.25));
  const tailN = Math.max(0, cap - headN);
  return `${s.slice(0, headN)}\n…[${s.length - cap} middle chars omitted — head and tail shown]…\n${s.slice(-tailN)}`;
}

/**
 * Concrete artifact checks for the specific outputs a task/plan demands.
 * `artifacts`: [{ label, path, expect?: { exists?, minBytes?, executable?, contains? } }]
 * Paths are absolute or relative to targetDir. Every check is deterministic —
 * existence, size, exec bit, substring — no interpretation, no prose trust.
 * Returns the ===== REQUIRED ARTIFACT CHECKS ===== section text (always
 * present; an empty list states that no explicit artifacts were declared).
 */
export function artifactChecks(targetDir, artifacts = [], { budget = EVIDENCE_FILE_CAP } = {}) {
  if (!artifacts.length) return "===== REQUIRED ARTIFACT CHECKS ===== (none explicitly declared)\n";
  const lines = [];
  for (const a of artifacts.slice(0, 12)) {
    const p = a?.path;
    const label = a?.label ?? p ?? "(unnamed)";
    if (!p) { lines.push(`- ${label}: PATH MISSING IN DECLARATION`); continue; }
    const abs = p.startsWith("/") ? p : join(targetDir, p);
    const item = [`- ${label} (${abs}):`];
    if (!existsSync(abs)) { item.push("  EXISTS: NO"); lines.push(item.join("\n")); continue; }
    let st;
    try { st = statSync(abs); } catch { item.push("  EXISTS: stat failed"); lines.push(item.join("\n")); continue; }
    item.push(`  EXISTS: YES (${st.isFile() ? "file" : st.isDirectory() ? "dir" : "other"})`);
    if (a.expect?.minBytes != null) item.push(`  SIZE: ${st.size} bytes — minBytes ${st.size >= a.expect.minBytes ? "MET" : "NOT MET"} (${a.expect.minBytes})`);
    else item.push(`  SIZE: ${st.size} bytes`);
    if (a.expect?.executable != null) {
      const exec = st.isFile() && !!(st.mode & 0o111);
      item.push(`  EXEC BIT: ${exec ? "set" : "not set"} — expected ${a.expect.executable ? "set" : "absent"}: ${exec === !!a.expect.executable ? "MET" : "NOT MET"}`);
    }
    if (a.expect?.contains != null) {
      try {
        const body = readFileSync(abs, "utf8");
        const found = body.includes(a.expect.contains);
        item.push(`  CONTAINS ${JSON.stringify(clip(a.expect.contains, 60))}: ${found ? "FOUND" : "NOT FOUND"}`);
      } catch (e) { item.push(`  CONTAINS check failed: ${String(e.message ?? e).slice(0, 80)}`); }
    }
    lines.push(item.join("\n"));
  }
  return `===== REQUIRED ARTIFACT CHECKS =====\n${lines.join("\n")}\n`;
}

/**
 * Gate-engine attribution from the run-scoped telemetry ledger
 * (runs/engine-usage.jsonl). Answers "which engine actually ran each gate"
 * deterministically — the e2e verify showed a reviewer can demand proof of
 * ROUTING (e.g. "gates route Sol-first"), and prose never proves routing.
 * Defensive parse: ledger lines are JSONL; unrelated shapes are skipped.
 */
export function gateEngineProof(runsDir, runId, { cap = 2_000, maxLines = 40 } = {}) {
  let raw = "";
  try { raw = readFileSync(join(runsDir, "engine-usage.jsonl"), "utf8"); } catch { return "(telemetry ledger unavailable)\n"; }
  const rows = [];
  for (const line of raw.split("\n")) {
    if (!line.trim() || line.trim().startsWith("#")) continue;
    try {
      const d = JSON.parse(line);
      if (d?.runId !== runId || !d?.engine) continue;
      rows.push(`${d.timestamp ?? "?"} | ${d.component ?? "?"} ${d.purpose ?? "?"} | ${d.engine} | rc=${d.rc ?? "?"} ok=${d.success}`);
    } catch { /* non-JSON line — skip */ }
  }
  if (!rows.length) return `("no telemetry records for run ${runId}")\n`;
  return clip(rows.slice(0, maxLines).join("\n") + "\n", cap);
}

/**
 * Assemble the full IMPLEMENTATION EVIDENCE section for a final-acceptance
 * (or quality) gate call. Sections that fail to read are stated honestly —
 * never silently omitted (the e2e lesson: missing evidence reads as missing
 * work). Total output bounded to `budget`.
 */
export function buildImplementationEvidence({ targetDir, runsDir, runId, artifacts = [], extraSections = {}, budget = EVIDENCE_PACK_CAP } = {}) {
  const parts = [];
  let spent = 0;
  const push = (title, text) => {
    const t = clip(text, Math.min(budget - spent, EVIDENCE_FILE_CAP));
    if (!t) return;
    parts.push(`===== ${title} =====\n${t}\n`);
    spent += t.length + title.length + 10;
  };

  push("RUN LOG TAIL", runLogTail(runsDir, runId));
  push("WORKER TRANSCRIPTS", workerTranscripts(runsDir, runId, { budget: budget - spent }));
  push("GATE ENGINE PROOF", gateEngineProof(runsDir, runId));
  // V3.3.10 (ticket 028): state the freshness of the staged deployed snapshot
  // against the run's own gate/worker signals — honest, deterministic, and
  // lets the reviewer discount evidence that predates the last fix cycle.
  try {
    const fr = stagedEvidenceFreshness(join(runsDir, runId, "deployed"), join(runsDir, runId));
    if (fr.note !== "(no staging dir — nothing to check)" && fr.note !== "(staging dir empty)") {
      push("STAGED EVIDENCE FRESHNESS", `${fr.note}\n`);
    }
  } catch { /* never fatal */ }
  const snap = targetSnapshot(targetDir, { budget: budget - spent });
  push(snap.kind === "git" ? "TARGET STATE (GIT)" : "TARGET STATE (NON-GIT)", snap.text);
  parts.push(artifactChecks(targetDir, artifacts, { budget: Math.min(EVIDENCE_FILE_CAP, budget - spent) }));
  for (const [title, text] of Object.entries(extraSections)) push(title, text);

  return parts.join("\n");
}

/** Staged-artifact freshness (V3.3.10, ticket 028): is the newest file under
 *  `stagedDir` at least as new as the newest gate/worker signal under
 *  `signalDir`? Run 04-38-42 acceptance #2 failed partly because the staged
 *  snapshot (11:09Z) predated the completed remediation (11:31Z) — the
 *  coordinator cannot re-stage itself (workers/discovery-executor own
 *  staging), but it must never re-drive a gate against a stale snapshot
 *  SILENTLY. Tolerance: signals newer by more than `staleAfterMs` (default
 *  60 s) make the snapshot stale. Never throws. */
export function stagedEvidenceFreshness(stagedDir, signalDir, { staleAfterMs = 60_000, signalPattern = /(^final-acceptance-\d+\.md$|^review-phase\d+\.md$|^status-[\w-]+\.md$)/ } = {}) {
  let newestStaged = 0;
  try {
    for (const f of readdirSync(stagedDir)) {
      if (f.startsWith(".")) continue;
      const m = statSync(join(stagedDir, f)).mtimeMs;
      if (m > newestStaged) newestStaged = m;
    }
  } catch { return { fresh: true, note: "(no staging dir — nothing to check)", newestStaged: 0, newestSignal: 0 }; }
  if (!newestStaged) return { fresh: true, note: "(staging dir empty)", newestStaged: 0, newestSignal: 0 };
  let newestSignal = 0;
  let signalName = "";
  try {
    for (const f of readdirSync(signalDir)) {
      if (!signalPattern.test(f)) continue;
      const m = statSync(join(signalDir, f)).mtimeMs;
      if (m > newestSignal) { newestSignal = m; signalName = f; }
    }
  } catch { /* signal dir gone — nothing newer known */ }
  if (!newestSignal) return { fresh: true, note: "no newer gate/worker signals than the staged snapshot", newestStaged, newestSignal: 0 };
  const fresh = newestSignal <= newestStaged + staleAfterMs;
  return {
    fresh,
    note: fresh
      ? "staged snapshot is current"
      : `STALE: newest staged file ${new Date(newestStaged).toISOString()} predates ${signalName} (${new Date(newestSignal).toISOString()}) — re-stage deployed evidence before/with the fix cycle, or acceptance will re-judge already-fixed work`,
    newestStaged, newestSignal, signalName,
  };
}
