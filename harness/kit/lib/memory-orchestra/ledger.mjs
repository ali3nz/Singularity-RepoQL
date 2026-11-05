// lib/memory-orchestra/ledger.mjs — MemOS gap-closure addendum (2026-10-23)
// directive §23 (inspection) / design §2 instrumentation layer.
// retrieval.started | retrieval.done | retrieval.failed JSONL events carrying
// per-tier timings, per-channel hits/ms, gate outcomes (kept/dropped + WHY),
// verdict and injected bytes. Substrate behind:
//   - operator inspection ("why was this retrieved?") — scripts/mem-inspect.mjs
//   - weak-retrieval dream triggers (Ghost WAKE reasons; directive §21)
//   - the §32 pending-validation evidence surface
// House JSONL pattern: daily-rotated, append-first, best-effort fsync, NEVER
// throws into the retrieval path (ledger outage degrades observation, not
// retrieval). Entries contain NO credentials and no raw secrets (rule 9g):
// queries stored normalized + capped, candidate ids only.
import { appendFile, mkdir, readFile, readdir } from "node:fs/promises";
import { dirname } from "node:path";
import { flags, enabledWhen, PENDING_VALIDATION } from "./flags.mjs";

const DEFAULT_DIR = process.env.ORCH_MORCH_LEDGER_DIR ?? "/opt/harness-unset/ai-orchestration/kit/runs/retrieval";
const nowIso = () => new Date().toISOString();

function normQuery(q) {
  return String(q ?? "").toLowerCase().replace(/\s+/g, " ").trim().slice(0, 160);
}

// --- event emitting (async, fire-and-forget from retrieval paths) ------------

export function beginRetrieval({ hook, query, scope = {}, tier = null, intent = null } = {}) {
  const retriev = `rv-${Date.now()}-${(hashish(normQuery(query)) % 100000).toString().padStart(5, "0")}`;
  writeEvent({
    event: "retrieval.started",
    retrievalId: retriev,
    hook: hook ?? null,
    tier: tier ?? null,
    intent: intent ?? null,
    queryNorm: normQuery(query),
    scopeTeam: null, // scope TEAM names are internal ids, not secrets — but the scope is already visible via candidates; keep minimal
    scopeAgent: scope?.agent ?? null,
    caseRun: scope?.caseRun ?? null,
    status: "open",
  });
  return retriev;
}

// Terminal record for one retrieval call. why-retrieved content lives in KEPT
// candidate ids + channel/rank/gates fields — the §23 inspection fields.
export function endRetrieval(retriev, data = {}) {
  const { plan, perChannel, ok = true, code = null, kept = [], dropped = [], verdict = null, packet = null, msTotal = null } = data;
  writeEvent({
    event: ok ? "retrieval.done" : "retrieval.failed",
    retrievalId: retriev,
    hook: plan?.hook ?? null,
    tier: plan?.tier ?? null,
    intent: plan?.intent ?? null,
    queryNorm: normQuery(plan?.queryText ?? data.query ?? ""),
    msTotal: msTotal ?? plan?.msTotal ?? null,
    channels: (perChannel ?? plan?.perChannel ?? []).map((ch) => ({ id: ch.channelId, ok: ch.ok, code: ch.code ?? null, hits: (ch.results ?? []).length, ms: ch.ms ?? null })),
    kept: kept.map((c) => ({ id: c.id, rank: c.rank ?? null, channel: c.channel, corroboratedBy: c.corroboratedBy ?? [] })),
    dropped: dropped.map((d) => ({ id: d.id, channel: d.channel, reasons: d.reasons ?? d.reasonList ?? [] })),
    verdict: verdict ? { state: verdict.state, reason: String(verdict.reason ?? "").slice(0, 300), round: verdict.round ?? 1, refinedBy: verdict.refinedBy ?? "mech" } : null,
    injectedBytes: packet?.bytesUsed ?? null,
    packetFingerprint: packet?.fingerprint ?? null,
    status: ok ? "ok" : `failed:${code ?? "unknown"}`,
  });
}

// why-retrieved lookup for ONE candidate id (§23): daily-rotated scan,
// newest-first, bounded by maxEvents parsed per run.
export async function whyRetrieved(candidateId, { maxEvents = 2000 } = {}) {
  if (!isLedgerEnabled()) return { found: false, reason: "FLAG_DISABLED", status: PENDING_VALIDATION };
  const d = dirFor();
  let files = [];
  try {
    files = (await readdir(d)).filter((f) => f.endsWith(".jsonl")).sort().reverse();
  } catch {
    return { found: false, reason: "NO_LEDGER" };
  }
  const hits = [];
  let parsed = 0;
  for (const f of files) {
    if (parsed > maxEvents || hits.length >= 25) break;
    let body;
    try {
      body = await readFile(`${d}/${f}`, "utf8");
    } catch {
      continue;
    }
    for (const line of body.split("\n")) {
      if (parsed > maxEvents) break;
      const s = line.trim();
      if (!s) continue;
      parsed++;
      const ev = safeParse(s);
      if (!ev) continue;
      const mentions = Array.isArray(ev.kept) && ev.kept.some((k) => k.id === candidateId);
      if (!mentions) continue;
      hits.push({
        file: f,
        ts: ev.ts,
        event: ev.event,
        hook: ev.hook,
        tier: ev.tier,
        intent: ev.intent,
        channels: ev.channels,
        channelRanks: ev.kept?.filter((k) => k.id === candidateId).map((k) => k.rank),
        verdict: ev.verdict,
        injectedBytes: ev.injectedBytes,
      });
    }
  }
  return hits.length ? { found: true, hits } : { found: false };
}

// Weak-retrieval detector feeding Ghost WAKE reasons (design §8): fraction of
// recent retrievals that ended INSUFFICIENT/partial Chen verdict.
export async function recentWeakRetrieval({ window = 50 } = {}) {
  const d = dirFor();
  let files = [];
  try {
    files = (await readdir(d)).filter((f) => f.endsWith(".jsonl")).sort().reverse();
  } catch {
    return { ok: false, reason: "NO_LEDGER" };
  }
  let analyzed = 0;
  let weak = 0;
  for (const f of files) {
    if (analyzed >= window) break;
    let body;
    try {
      body = await readFile(`${d}/${f}`, "utf8");
    } catch {
      continue;
    }
    const lines = body.split("\n").reverse();
    for (const line of lines) {
      if (analyzed >= window) break;
      const ev = safeParse(line.trim());
      if (!ev || ev.event !== "retrieval.done") continue;
      analyzed++;
      const st = ev?.verdict?.state;
      if (st === "INSUFFICIENT" || st === "PARTIAL") weak++;
    }
  }
  return { ok: true, analyzed, weak, ratio: analyzed ? weak / analyzed : null };
}

// --- plumbing -----------------------------------------------------------------

export function isLedgerEnabled() {
  return enabledWhen(flags(), "ledger").ok;
}
export { PENDING_VALIDATION };

function dirFor() {
  const fs = flags();
  const b = fs.budgets?.ledgerDir;
  return typeof b === "string" && b ? b : DEFAULT_DIR;
}

// All writes are async, batched into a single append, wrapped so NOTHING can
// throw up into retrieval (leader rule: observe, never block).
function writeEvent(ev) {
  const base = { ts: nowIso(), ...ev };
  const line = `${JSON.stringify(base)}\n`;
  const d = dirFor();
  const f = `${d}/${base.ts.slice(0, 10)}.jsonl`;
  (async () => {
    try {
      await mkdir(dirname(f), { recursive: true });
      await appendFile(f, line, "utf8");
    } catch {
      /* observation is best-effort by contract */
    }
  })();
}

function hashish(s) {
  let h = 0;
  for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) & 0x7fffffff;
  return h;
}
function safeParse(s) {
  try {
    return JSON.parse(s);
  } catch {
    return null;
  }
}
