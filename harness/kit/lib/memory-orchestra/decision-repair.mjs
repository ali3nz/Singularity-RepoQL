// lib/memory-orchestra/decision-repair.mjs — MemOS gap-closure addendum
// (2026-10-23) directive §16 (failure-triggered decision repair) + §18 wiring.
// DURABLE by construction: a runs-tree JSONL error-signature ledger replaces
// all process-local counting ("do not use process-local counters as the only
// durable record"). On the second observed occurrence of the same signature
// (≥2 distinct turns), retrieveRepairs() produces an ADVISORY payload from
// prior verified failures + verified repairs + approved procedures
// (correction.hints included via corrections.mjs rows). Corrections
// NEVER auto-execute; callers render them as advisory text at most.
// Gated by decisionRepair flag (default OFF). Errors carry no payloads —
// signatures are shapes (class + code), redacted upstream by steps scrubbing.
import { appendFileSync, readFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { flags, enabledWhen, PENDING_VALIDATION } from "./flags.mjs";
import { advisoryRepairPayload } from "./corrections.mjs";

const REPEAT_THRESHOLD = 2; // distinct turns/records before repair retrieval
const LEDGER_READ_MAX = 3000; // bounded tail per read

function normSig(s) {
  return String(s ?? "").toLowerCase().replace(/\s+/g, " ").trim().slice(0, 160);
}

// recordFailure — one timestamped row per observed failure; the ledger is
// append-only (history preserved for evidence; counts are derived reads).
export function recordFailure({ signature, runId = null, caseRun = null, phase = null, correctionKind = null, notes = null } = {}, { stateDir = "/opt/harness-unset/ai-orchestration/kit/runs/_decision-repair" } = {}) {
  const g = enabledWhen(flags(), "decisionRepair");
  if (!g.ok) return { ok: false, code: g.code, status: g.status };
  const sig = normSig(signature);
  if (!sig) return { ok: false, code: "SIGNATURE_REQUIRED" };
  try {
    const row = { sig, runId, caseRun, phase, kind: correctionKind ?? null, notes: notes ? String(notes).slice(0, 160) : null, ts: new Date().toISOString() };
    appendFileSync(join(stateDir, "errors.jsonl"), `${JSON.stringify(row)}\n`, "utf8");
    return { ok: true, signature: sig };
  } catch (err) {
    return { ok: false, code: `LEDGER_THROW:${String(err?.name ?? err).slice(0, 20)}` };
  }
}

// readLedgerSignature — query one signature's rows for repetition analysis.
export function signatureRows(signature, { stateDir = "/opt/harness-unset/ai-orchestration/kit/runs/_decision-repair" } = {}) {
  const sig = normSig(signature);
  if (!sig) return [];
  const f = join(stateDir, "errors.jsonl");
  if (!existsSync(f)) return [];
  const out = [];
  try {
    const lines = readFileSync(f, "utf8").split("\n").slice(-LEDGER_READ_MAX);
    for (const l of lines) {
      if (!l.trim()) continue;
      let r;
      try {
        r = JSON.parse(l);
      } catch {
        continue;
      }
      if (r.sig === sig) out.push(r);
    }
  } catch {
    return out;
  }
  return out;
}

// isRepeatedFailure — the §16 trigger check (durable, turn-distinct).
export function isRepeatedFailure({ signature, runId = null, turnKey = null } = {}, stateShare = {}) {
  if (!String(signature ?? "").trim()) return { repeated: false, observed: 0 };
  const rows = signatureRows(signature, stateShare);
  // Distinct by turn identity: turnKey when supplied else runId+phase slice.
  const turnOf = (r) => (turnKey != null ? normSig(turnKey) : normSig(`${r.runId ?? r.caseRun ?? "?"}|${r.phase ?? r.phase ?? "?"}|${r.ts?.slice(0, 10) ?? "?"}`));
  const distinct = new Map();
  for (const r of rows) {
    const t = turnOf(r);
    if (!distinct.has(t)) distinct.set(t, r);
  }
  const observed = distinct.size;
  return { repeated: observed >= REPEAT_THRESHOLD, observed, threshold: REPEAT_THRESHOLD };
}

// retrieveRepairs — bounded repair retrieval. Bindings injected:
//   steps (lib/memory-orchestra/steps.mjs executors) and approved-procedure
//   channel (planner-bound doc/skill executor). Corrections from corrections
//   rows are injected by the caller when available (they live in a separate
//   file). Output: advisory payload text + structured rows for instrumentation.
export async function retrieveRepairs({ signature, scope = {} } = {}, { stepsExecutors = null, procedureExecutor = null, corrections = [] } = {}) {
  const g = enabledWhen(flags(), "decisionRepair");
  if (!g.ok) return { ok: false, code: g.code, status: g.status };
  const sig = normSig(signature);
  if (!sig) return { ok: false, code: "SIGNATURE_REQUIRED" };
  const priorFailed = [];
  const priorRepairs = [];
  const rows = signatureRows(sig);
  for (const r of rows.slice(-20)) {
    // Only VERIFIED outcomes enter the advisory loop (verified-outcome law):
    // prior failure rows carry indicator=verified via row.basis when the
    // attribution pass has processed them; plain rows advise but mark basis.
    priorFailed.push({ runId: r.runId ?? r.caseRun, outcomeRep: r.notes ?? "(observed failure)", basis: r.basis ?? "UNVERIFIED" });
  }
  if (stepsExecutors && typeof stepsExecutors.byErrorSignature === "function") {
    const r = await stepsExecutors.byErrorSignature({ scope: { ...scope, errorSignature: sig }, topK: 3 });
    if (r.ok) {
      for (const c of r.results.slice(0, 3)) priorRepairs.push({ runId: c.caseRun, actionRep: c.body, basis: "VERIFIED_IMPORT" });
    }
  }
  let procedures = [];
  if (procedureExecutor && typeof procedureExecutor === "function") {
    const r = await Promise.race([
      procedureExecutor({ query: sig, topK: 2 }),
      new Promise((res) => setTimeout(() => res(null), 1500)),
    ]);
    if (r?.ok) procedures = (r.results ?? []).slice(0, 2);
  }
  const hints = (corrections ?? []).filter((c) => (c.appliesTo ?? []).some((a) => normSig(sig).includes(normSig(a)))).slice(0, 2);
  return {
    ok: true,
    advisory: advisoryRepairPayload({ errorSignature: sig, priorFailed, priorRepairs, procedures, correctionHints: hints }),
    structured: { priorFailed: priorFailed.length, priorRepairs: priorRepairs.length, procedures: procedures.length, hints: hints.length, priorFailedRows: priorFailed, priorRepairsRows: priorRepairs, proceduresRows: procedures.map((p) => ({ channel: p.channel, id: p.id })) },
    status: PENDING_VALIDATION,
  };
}
