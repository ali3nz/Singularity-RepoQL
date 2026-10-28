// agent-issues.mjs — V3.5.0 (ticket 141, operator order 2026-09-27): fleet-wide
// "run agent issues" self-logging fabric. Any agent that encounters an issue
// during a run logs it here with details (consultant crashed / stopped
// responding, self-corrections like codex's recurring primary@controller attempt,
// degraded paths, terminal run failures). Operator reviews every 5-10 runs;
// issues are NEVER auto-fixed by this module (operator mandate: "just leave
// the issues logged for now").
//
// DESIGN CONTRACT (do not weaken):
//   - FAIL-OPEN, ALWAYS. Issue logging must never break a run or a consult.
//     Every write and every mirror is wrapped; callers may also wrap.
//   - THREE layers, one truth: runs/agent-issues.jsonl is the append-only
//     MASTER stream (controller orch-discord-bridge tails it into the
//     #agent-run-issues Discord channel — separate offset key, starts at EOF,
//     no backfill); runs/agent-issues/run-NNN-agent-issues.jsonl is the
//     operator's per-run view ("log it under run 098 agent issues"; unnumbered
//     issues land in unnumbered-YYYY-MM-DD.jsonl); MEX gets ONE deduped
//     AGENT-ISSUE event per issue as the memory/query layer. RepoQL is an
//     index over these files, not a store.
//   - NO action buttons, NO auto-triage in V1 — the Discord channel is
//     operator visibility only (auto-investigate + duo consult is a later,
//     separately-ordered phase).
//   - Bounded: summary ≤ 300 chars, detail ≤ 2000 chars; MEX mirror deduped
//     per (runKey + normalized summary) for 24 h so a retry loop cannot spam
//     the hub memory.
//   - CAPTURE-TIME REDACTION IS A DOCUMENTED DECISION (Sol turn-2, issue
//     141): the authoritative JSONL is a REDACTED forensic record — raw
//     secret-bearing text is intentionally lost forever (irrecoverable),
//     because the alternative (raw secrets on disk feeding MEX/Discord
//     mirrors) is the worse failure mode. Need the raw text? It was never
//     logged; that is the point.
import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { join } from "node:path";
import { tmpdir } from "node:os";

export const AGENT_ISSUES_SCHEMA = 1;
export const ISSUE_SUMMARY_MAX = 300;
export const ISSUE_DETAIL_MAX = 2000;
const MEX_DEDUPE_WINDOW_MS = 24 * 3600 * 1000;

// Ticket 164 Phase 5 (§12.3): agent issues are authoritative in the JSONL
// layers + GitHub projection; the fleet journal (fleet-log) gets a one-line
// event, replacing the old MEX mirror. Env flag name kept for compat.
const MEX_LOG_CMD = "fleet-log --source agent --type NOTE --status current";

const pad3 = (n) => String(n).padStart(3, "0");
const cap = (s, n) => { s = String(s ?? ""); return s.length <= n ? s : s.slice(0, n - 1) + "…"; };
const oneLine = (s) => String(s ?? "").replace(/\s+/g, " ").trim();
const normSummary = (s) => oneLine(s).toLowerCase().replace(/[^a-z0-9]+/g, " ").trim().slice(0, 120);

export function agentIssuesPaths(runsDir) {
  return { stream: join(runsDir, "agent-issues.jsonl"), folder: join(runsDir, "agent-issues") };
}

// The per-run file name is the operator's mental model verbatim:
// "run 098 agent issues" -> run-098-agent-issues.jsonl. Unnumbered issues
// (no run number allocated, e.g. a consult crash before allocation or an
// out-of-kit agent filing without --run) go to a rolling daily file so they
// are still reviewable, never dropped.
export function perRunFileName({ runNumber = null, at = new Date() } = {}) {
  if (Number.isFinite(runNumber) && runNumber > 0) return `run-${pad3(runNumber)}-agent-issues.jsonl`;
  const d = at.toISOString().slice(0, 10);
  return `unnumbered-${d}.jsonl`;
}

function mexDedupeFile(runsDir) { return join(runsDir, "agent-issues", ".mex-dedupe.json"); }

function mexDedupeCheck(runsDir, key, now = Date.now()) {
  // Returns true when this (runKey, summary) was mirrored within the window
  // and must be suppressed. Best-effort: any error = "not a dupe" (fail-open).
  try {
    mkdirSync(join(runsDir, "agent-issues"), { recursive: true });
    let st = {};
    try { st = JSON.parse(readFileSync(mexDedupeFile(runsDir), "utf8")); } catch { /* first mirror */ }
    const last = st[key];
    if (typeof last === "number" && now - last < MEX_DEDUPE_WINDOW_MS) return true;
    // prune expired entries so the file stays tiny
    for (const k of Object.keys(st)) {
      if (typeof st[k] !== "number" || now - st[k] >= MEX_DEDUPE_WINDOW_MS) delete st[k];
    }
    st[key] = now;
    writeFileSync(mexDedupeFile(runsDir), JSON.stringify(st) + "\n");
    return false;
  } catch { return false; }
}

function mexMirror(issue, runsDir) {
  // Fire-and-forget AGENT-ISSUE event. Runs over SSH so it works from the
  // freebuff container AND from controller itself (loopback ssh is fine).
  // ORCH_MEX_MIRROR=off (sandbox opt-out) skips the network entirely.
  // STRUCTURAL GUARD (Sol turn-2 FIX, ticket 141): a runs dir under the OS
  // tmpdir is by definition a sandbox/selftest — it can NEVER mirror, with
  // no env var for a human to forget. ORCH_MEX_MIRROR=on is the explicit
  // override for a deliberate sandbox E2E test.
  if (process.env.ORCH_MEX_MIRROR === "off") return false;
  try {
    if (!String(runsDir ?? "").startsWith(tmpdir()) || process.env.ORCH_MEX_MIRROR === "on") {
      const msg = `AGENT-ISSUE ${issue.runKey} [${issue.kind}/${issue.severity}]${issue.agent ? ` (${issue.agent})` : ""}: ${issue.summary}`
        .replace(/'/g, "").slice(0, 400);
      spawnSync("ssh", ["controller", `${MEX_LOG_CMD} '${msg}' --ref 'agent-issues/${issue.runKey}'`], { encoding: "utf8", timeout: 20_000 });
      return true;
    }
  } catch { /* fail-open */ }
  return false;
}

// V3.5.0 (Sol consult 2026-09-27T21-07-34, VERDICT CONFIRMED, WATCH OUT #1):
// raw issue text is a potential secret-exfiltration path into MEX/Discord —
// scrub secret-shaped values AT CAPTURE so every downstream layer (per-run
// JSONL, master stream, MEX mirror, Discord relay) inherits redacted text.
// Scrub failure falls back to summary-only (detail dropped), never a throw.
const PRIVATE_KEY_RE = /-----BEGIN [A-Z0-9 ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z0-9 ]*PRIVATE KEY-----/g;
const SECRETISH_KV_RE = /\b([\w.-]*(?:api[_-]?key|apikey|token|secret|password|passwd|pwd|passphrase|credential)[\w.-]*)\s*[:=]\s*["']?[^\s"']{6,}/gi;

export function scrubSecrets(text) {
  let s = String(text ?? "");
  let hits = 0;
  try {
    s = s.replace(PRIVATE_KEY_RE, () => { hits++; return "***redacted private key***"; });
    s = s.replace(/\bAKIA[0-9A-Z]{16}\b/g, () => { hits++; return "***redacted aws key***"; });
    s = s.replace(/\b(?:ghp|gho|github_pat)_[\w]{20,}\b/gi, () => { hits++; return "***redacted github token***"; });
    s = s.replace(/Bearer\s+[\w._\-+=/]{8,}/gi, () => { hits++; return "Bearer ***redacted***"; });
    s = s.replace(/([\w.+\-]+):\/\/([^\s:@/]+):([^\s@/]+)@/g, (_m, sch) => { hits++; return `${sch}://***@`; });
    s = s.replace(SECRETISH_KV_RE, (_m, key) => { hits++; return `${key}=***redacted***`; });
    return { text: s, hits };
  } catch (e) {
    return { text: null, hits: -1, error: String(e?.message ?? e) };
  }
}

// Entry point. Never throws. Returns the record + where it landed (for CLI
// echo and selftest pins).
export function logAgentIssue(runsDir, issue = {}) {
  const now = new Date();
  const runNumber = Number.isFinite(Number(issue.runNumber)) && Number(issue.runNumber) > 0 ? Number(issue.runNumber) : null;
  const severity = ["error", "warn", "info"].includes(String(issue.severity ?? "").toLowerCase())
    ? String(issue.severity).toLowerCase() : "warn";
  const record = {
    schema: AGENT_ISSUES_SCHEMA,
    at: now.toISOString(),
    runNumber,
    runId: issue.runId ?? null,
    runKey: runNumber != null ? `run-${pad3(runNumber)}` : (issue.runId ? `run-${issue.runId}` : "unnumbered"),
    kind: oneLine(issue.kind) || "unclassified",
    severity,
    agent: oneLine(issue.agent) || "unknown",
    engine: oneLine(issue.engine) || null,
    source: oneLine(issue.source) || "manual",
    summary: cap(oneLine(issue.summary), ISSUE_SUMMARY_MAX),
    detail: cap(String(issue.detail ?? ""), ISSUE_DETAIL_MAX),
  };
  const { stream, folder } = agentIssuesPaths(runsDir);
  // Scrub-at-capture (Sol WATCH OUT): redact secret-shaped values before the
  // record exists anywhere. Scrub failure on detail -> summary-only (drop
  // detail); scrub failure on summary -> keep the capped one-line original.
  let redactions = 0;
  try {
    const rs = scrubSecrets(record.summary);
    if (rs.text !== null) { record.summary = rs.text; redactions += Math.max(rs.hits, 0); }
  } catch { /* keep original summary — capped one-liner */ }
  let safeDetail = "";
  try {
    const rd = scrubSecrets(record.detail);
    if (rd.text === null) safeDetail = ""; // summary-only fallback
    else { safeDetail = rd.text; redactions += Math.max(rd.hits, 0); }
  } catch { safeDetail = ""; /* summary-only fallback */ }
  record.detail = safeDetail;
  record.redactions = redactions;
  try {
    mkdirSync(folder, { recursive: true });
    const line = JSON.stringify(record) + "\n";
    appendFileSync(stream, line);
    appendFileSync(join(folder, perRunFileName({ runNumber, at: now })), line);
  } catch { /* fail-open — never break the caller */ }
  // MEX mirror, deduped per (runKey + normalized summary) inside the window;
  // repeated identical issues are NOT silently deduped forever — the dedupe
  // window is 24 h, so a persistent condition re-mirrors daily, and every
  // occurrence is ALWAYS in the JSONL layers regardless.
  let mirrored = false;
  try {
    const key = `${record.runKey}:${normSummary(record.summary)}`;
    if (!mexDedupeCheck(runsDir, key, now.getTime())) mirrored = mexMirror(record, runsDir);
  } catch { /* fail-open */ }
  return { record, stream, perRun: join(folder, perRunFileName({ runNumber, at: now })), mexMirrored: mirrored };
}
