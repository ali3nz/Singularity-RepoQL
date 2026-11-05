// invocation-telemetry.mjs — V3.2 §6: ONE universal append-only event writer
// used by EVERY model invocation path (router attempts, consult, ask, vision,
// supervisor, watchdog, quality). Records EVERY ATTEMPT including failures.
// Backend: runs/engine-usage.jsonl (one JSON object per line).
//
// Hard rules:
//  - Telemetry failure must NEVER break routing (all writers swallow errors).
//  - No secrets: error text is truncated; callers must not pass credentials.
//  - Append-only: no rewrite, no pruning here (external rotation may compact).
import { appendFileSync, mkdirSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

let _file = null;

export function initTelemetry(runsDir) {
  try {
    mkdirSync(runsDir, { recursive: true });
    _file = join(runsDir, "engine-usage.jsonl");
  } catch { _file = null; }
  return _file;
}

// Canonical ledger path, resolved lazily on first use (explicit initTelemetry
// call still wins). Every entry point — record, summary, incremental reader —
// shares this so no process sees an empty ledger just because it never called
// initTelemetry.
function resolveFile() {
  if (_file) return _file;
  try {
    const here = dirname(fileURLToPath(import.meta.url)); // <kit>/lib
    return join(here, "..", "runs", "engine-usage.jsonl");
  } catch { return null; }
}

export function telemetryFile() {
  return _file;
}

// Record one invocation attempt. Returns true if written. Never throws.
// Required: engine. Everything else optional and defaulted here so callers
// cannot accidentally omit the fields status aggregation depends on.
export function recordInvocation({
  runId = null, sessionId = null, component = "orchestrator",
  role = "NORMAL", purpose = null, engine, model = null,
  billingClass = null, attempt = 1, success = false, failureClass = "UNKNOWN",
  rc = null, paid = false, visionUsed = false, freebucksUsed = 0,
  durationMs = null, fallbackFrom = null, note = null,
  // V3.3 §25: OpenAI Sol token accounting (never contaminates gate text).
  inputTokens = null, cachedInputTokens = null, outputTokens = null,
  reasoningTokens = null, totalTokens = null,
  // Legacy additive identity fields (provider/thinking/trust) from the retired
  // fable engine (ticket 155) — kept as generic pass-through fields, always null
  // now that no engine supplies them.
  provider = null, thinking = null, trust = null,
  // Ticket 189 item 11: reasoning variant actually sent (null = none/default).
  variant = null,
} = {}) {
  if (!engine) return false;
  _file = resolveFile();
  const rec = {
    timestamp: new Date().toISOString(),
    runId, sessionId, component, role, purpose,
    engine, model, billingClass, attempt, success,
    failureClass, rc, paid, visionUsed, freebucksUsed,
    durationMs, fallbackFrom, note: note ? String(note).slice(0, 200) : null,
  };
  // Only include token fields when present — keeps free-engine records unchanged.
  // V3.4.5 (ticket 155): identity fields land only when supplied (none currently).
  if (variant != null) rec.variant = String(variant);
  if (provider != null) rec.provider = provider;
  if (thinking != null) rec.thinking = thinking;
  if (trust != null) rec.trust = trust;
  if (inputTokens != null) rec.inputTokens = Number(inputTokens) || 0;
  if (cachedInputTokens != null) rec.cachedInputTokens = Number(cachedInputTokens) || 0;
  if (outputTokens != null) rec.outputTokens = Number(outputTokens) || 0;
  if (reasoningTokens != null) rec.reasoningTokens = Number(reasoningTokens) || 0;
  if (totalTokens != null) rec.totalTokens = Number(totalTokens) || 0;
  if (!_file) _file = resolveFile();
  if (!_file) return false;
  try {
    appendFileSync(_file, JSON.stringify(rec) + "\n");
    return true;
  } catch {
    // Telemetry must never break routing — drop the record silently.
    return false;
  }
}

// Aggregate the ledger for status output (§8). Returns per-dimension counts.
// Reads the whole file each call — status is human-frequency, the file is
// line-oriented and small; watch processes use readInvocationEvents(offset)
// for incremental access instead.
export function usageSummary({ sinceIso = null, runId = null } = {}) {
  const out = {
    totals: { attempts: 0, successes: 0, failures: 0, paid: 0, visionCalls: 0, freebucks: 0, tokensIn: 0, tokensOut: 0 },
    byEngine: {},     // engine -> { attempts, successes, failures, paid, failureClasses: {}, tokensIn, tokensOut }
    byComponent: {},  // component -> attempts
    byRole: {},       // role -> attempts
    latest: null,     // most recent record
  };
  if (!_file) _file = resolveFile();
  if (!_file) return out;
  let lines = [];
  try {
    lines = readLines(_file);
  } catch {
    return out;
  }
  for (const line of lines) {
    let r;
    try { r = JSON.parse(line); } catch { continue; }
    if (sinceIso && r.timestamp && r.timestamp < sinceIso) continue;
    if (runId && r.runId !== runId) continue;
    out.totals.attempts++;
    if (r.success) out.totals.successes++; else out.totals.failures++;
    if (r.paid) out.totals.paid++;
    if (r.visionUsed) out.totals.visionCalls++;
    out.totals.freebucks += Number(r.freebucksUsed ?? 0) || 0;
    const e = (out.byEngine[r.engine] ??= { attempts: 0, successes: 0, failures: 0, paid: 0, failureClasses: {}, tokensIn: 0, tokensOut: 0 });
    e.attempts++;
    if (r.success) e.successes++; else {
      e.failures++;
      e.failureClasses[r.failureClass ?? "UNKNOWN"] = (e.failureClasses[r.failureClass ?? "UNKNOWN"] ?? 0) + 1;
    }
    if (r.paid) e.paid++;
    // V3.3 §25: OpenAI Sol token usage rolls up into totals + per-engine.
    const tIn = Number(r.inputTokens ?? 0) || 0, tOut = Number(r.outputTokens ?? 0) || 0;
    if (tIn || tOut) { out.totals.tokensIn += tIn; out.totals.tokensOut += tOut; e.tokensIn += tIn; e.tokensOut += tOut; }
    out.byComponent[r.component] = (out.byComponent[r.component] ?? 0) + 1;
    out.byRole[r.role] = (out.byRole[r.role] ?? 0) + 1;
    out.latest = r;
  }
  return out;
}

function readLines(f) {
  try {
    return readFileSyncSafe(f).split("\n").filter(Boolean);
  } catch {
    return [];
  }
}

// Incremental reader for the Watchdog (§13): returns { events, offset }.
// Offset = byte position; pass it back next cycle to read only new events.
export function readInvocationEvents(offset = 0) {
  if (!_file) _file = resolveFile();
  if (!_file) return { events: [], offset: 0 };
  try {
    const buf = readFileSyncSafe(_file, true);
    const text = buf.slice(offset).toString("utf8");
    const events = text.split("\n").filter(Boolean)
      .map((l) => { try { return JSON.parse(l); } catch { return null; } })
      .filter(Boolean);
    return { events, offset: offset + Buffer.byteLength(text, "utf8") };
  } catch {
    return { events: [], offset };
  }
}

import { readFileSync as _rfs } from "node:fs";
function readFileSyncSafe(f, asBuffer = false) {
  return _rfs(f, asBuffer ? null : "utf8");
}
