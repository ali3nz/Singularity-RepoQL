// lib/memory-orchestra/steps.mjs — MemOS gap-closure addendum (2026-10-23)
// directive §11 (step-level experience capture), §12 (summary/action/outcome/
// error representations), plus the store executors the planner binds for the
// step-backed channels (error-signature-exact / exact-identifier /
// episode-historical).
//
// HOUSE CONFORMITIES:
//  - NOT a new always-on recorder: extraction happens at the EXISTING lifecycle
//    points (run completion / debrief / conversation-review), from artifacts
//    that already exist (runs/<id>/state.json, engine-usage.jsonl, run.log
//    marker counts, debrief payload). No live tool streaming, no log quoting.
//  - Sanitization first (rule 9g): NO secrets, NO raw tool output, NO full
//    command payloads. Bounded text, marker-name counts only (debrief.mjs
//    discipline). A step whose secrets-check cannot be satisfied is dropped.
//  - Storage = JSONL/JSON runs dirs (house pattern) — THE runs tree, no second
//    database. Durable cross-run recall later flows through the EXISTING
//    capture consumer / MemoryCore session mirroring when P4 wiring lands.
//  - Gated by flags.stepsCapture; flag-off = the export functions refuse with
//    FLAG_DISABLED and write NOTHING (byte-identical legacy behaviour). Read
//    executors stay available for a future validation phase but return
//    FLAG_DISABLED as well (§30: nothing ships enabled).
import { readFileSync, writeFileSync, existsSync, appendFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { flags, enabledWhen, PENDING_VALIDATION } from "./flags.mjs";

const cap = (s, n) => { s = String(s ?? ""); return s.length <= n ? s : s.slice(0, n - 1) + "…"; };
const readJson = (p) => { try { return JSON.parse(readFileSync(p, "utf8")); } catch { return null; } };

// Secret-shaped token patterns (9g shape check, advisory-level; a match makes
// the span UNSTORABLE — the whole step's fields are scrubbed rather than
// risk a leak). Deliberately narrow + cheap.
const SECRET_SHAPES = [
  /sk-[a-zA-Z0-9]{20,}/,
  /gh[pousr]_[A-Za-z0-9]{30,}/,
  /AKIA[0-9A-Z]{16}/,
  /xn?tp_[A-Za-z0-9-]{20,}/i,
  /Bearer [A-Za-z0-9._\-]{25,}/,
  /-----BEGIN [A-Z ]*PRIVATE KEY-----/,
  /([A-Za-z0-9+_/]{40,}={0,2})/, // long base64 blobs
];
function scrub(text) {
  let t = String(text ?? "");
  for (const re of SECRET_SHAPES) t = t.replace(re, "[scrubbed:secret-shape]");
  return t;
}
export function scrubAll(obj) {
  const out = {};
  for (const [k, v] of Object.entries(obj ?? {})) {
    if (v == null) { out[k] = null; continue; }
    if (typeof v === "string") { out[k] = scrub(cap(v, 220)); continue; }
    if (Array.isArray(v)) { out[k] = v.slice(0, 8).map((x) => (typeof x === "string" ? scrub(cap(x, 120)) : String(x).slice(0, 60))); continue; }
    out[k] = typeof v === "object" ? scrub(JSON.stringify(v)) : v;
  }
  return out;
}

// ---------------------------------------------------------------------------
// Extraction — from an existing run dir (runs/<runId>). Bounded: caps at
// MAX_STEPS rows total; overflow recorded as a truncated flag, never scanned past.
// ---------------------------------------------------------------------------
export const MAX_STEPS = 60;

// Map a terminal run into the §13 verified-outcome basis.
//
// P0 CORRECTION (directive §5, 2026-10-23): a COMPLETED run is NOT a verified
// success. Completion only says the pipeline reached a terminal state; it says
// nothing about whether the work was accepted, deployed or independently
// confirmed. The former implementation mapped COMPLETED* → "VALIDATED", which
// granted the whole run +1 credit and made induction/attribution treat any
// completed run as corroboration. Outcomes are now:
//   VERIFIED_SUCCESS     — attributable acceptance/deploy/operator evidence
//   VERIFIED_FAILURE     — terminal failure state
//   PARTIALLY_VERIFIED   — some phases accepted, others unproven
//   INCONCLUSIVE         — contradictory or unusable evidence
//   COMPLETED_UNVERIFIED — a finished run with no acceptance evidence (0 credit)
//   UNVERIFIED           — no terminal state / nothing to judge
// The only path to VERIFIED_SUCCESS is an explicit evidence record on the run
// state (see verificationOf); agent self-assessment is never evidence.
export const OUTCOMES = Object.freeze({
  VERIFIED_SUCCESS: "VERIFIED_SUCCESS",
  VERIFIED_FAILURE: "VERIFIED_FAILURE",
  PARTIALLY_VERIFIED: "PARTIALLY_VERIFIED",
  INCONCLUSIVE: "INCONCLUSIVE",
  COMPLETED_UNVERIFIED: "COMPLETED_UNVERIFIED",
  UNVERIFIED: "UNVERIFIED",
});

// Evidence sources that may confer positive credit (directive §5 list).
const ACCEPTING_DECISIONS = /^(OPERATOR_ACCEPTED|ACCEPTED|APPROVED|PASS|VERIFIED_SUCCESS)$/i;
const REJECTING_DECISIONS = /^(REJECTED|DENIED|FAILED|NEEDS_WORK|HOLD)$/i;

// Normalize any structured acceptance evidence on the run state. Returns
// { outcome, source, ref } or null. Never consults runState "COMPLETED".
export function verificationOf(state) {
  const cand = state?.outcomeVerification ?? state?.verification ?? null;
  if (cand && typeof cand === "object") {
    const status = String(cand.status ?? cand.outcome ?? "").toUpperCase();
    const source = String(cand.source ?? cand.kind ?? "").slice(0, 60) || null;
    const ref = String(cand.ref ?? cand.receipt ?? cand.record ?? "").slice(0, 300) || null;
    if (status === "VERIFIED_SUCCESS" && ref) return { outcome: OUTCOMES.VERIFIED_SUCCESS, source, ref };
    if (status === "VERIFIED_FAILURE") return { outcome: OUTCOMES.VERIFIED_FAILURE, source, ref };
    if (status === "PARTIALLY_VERIFIED") return { outcome: OUTCOMES.PARTIALLY_VERIFIED, source, ref };
    if (status === "INCONCLUSIVE") return { outcome: OUTCOMES.INCONCLUSIVE, source, ref };
  }
  // Approved acceptance record (the existing run discipline artifact).
  const fa = state?.finalAcceptance;
  if (fa && typeof fa === "object") {
    const decision = String(fa.decision ?? fa.verdict ?? fa.status ?? "").trim();
    const ref = String(fa.record ?? fa.path ?? fa.ref ?? fa.acceptedBy ?? "").slice(0, 300) || null;
    if (ACCEPTING_DECISIONS.test(decision) && ref) {
      return { outcome: OUTCOMES.VERIFIED_SUCCESS, source: "finalAcceptance", ref };
    }
    if (REJECTING_DECISIONS.test(decision)) {
      return { outcome: OUTCOMES.VERIFIED_FAILURE, source: "finalAcceptance", ref };
    }
  }
  return null;
}

export function runStateToOutcome(runState, state = null) {
  const s = String(runState ?? "").toUpperCase();
  const failed = s.includes("FAILED") || s === "NEEDS_WORK" || s === "FAIL" || s === "HOLD";
  const done = s.startsWith("COMPLETED") || s === "VALIDATED" || s === "PASS" || s === "DONE";
  const evidence = state ? verificationOf(state) : null;
  if (evidence) {
    // Contradiction guard: acceptance evidence on a failed run is unusable.
    if (failed && evidence.outcome === OUTCOMES.VERIFIED_SUCCESS) {
      return OUTCOMES.INCONCLUSIVE;
    }
    return evidence.outcome;
  }
  if (failed) return OUTCOMES.VERIFIED_FAILURE; // a terminal failure is itself observable
  if (done) return OUTCOMES.COMPLETED_UNVERIFIED; // completion alone earns nothing
  return OUTCOMES.UNVERIFIED;
}

export function extractSteps(runDir, { runId = null, objective = null } = {}) {
  const gate = enabledWhen(flags(), "stepsCapture");
  if (!gate.ok) return { ok: false, code: gate.code, status: gate.status };
  if (!runDir || typeof runDir !== "string") return { ok: false, code: "RUN_DIR_REQUIRED" };
  const state = readJson(join(runDir, "state.json")) ?? null;
  const usage = [];
  const runLog = join(runDir, "engine-usage.jsonl");
  if (existsSync(runLog)) {
    try {
      const lines = readFileSync(runLog, "utf8").split("\n");
      const thisRun = runId ?? state?.runId ?? null;
      for (const l of lines.slice(-4000)) {
        if (!l.trim()) continue;
        try { const r = JSON.parse(l); if (thisRun && r.runId === thisRun) usage.push(r); } catch { /* bounded skip */ }
      }
    } catch { /* telemetry absence is normal early-run */ }
  }
  const steps = [];
  for (const u of usage.slice(0, MAX_STEPS)) {
    const summary = `engine ${u.engine ?? "?"} attempt ${(u.attempts ?? "?")}-${u?.seat ?? "?"} success=${u.success ? "yes" : "no"}`;
    const errorSig = u?.errorClass ? String(u.errorClass).slice(0, 120) : (u.success === false ? "ENGINE_ATTEMPT_FAILED" : null);
    const outRow = scrubAll({
      runId: u.runId ?? runId ?? state?.runId ?? null,
      phase: u.phase ?? state?.currentPhase ?? null,
      objective: objective ?? state?.task ?? null,
      tool: "engine",
      actionType: u.success === false ? "ENGINE_ATTEMPT" : "ENGINE_DONE",
      summaryRep: cap(summary, 200), // §12 "what was encountered"
      actionRep: cap(`call ${u.engine ?? "?"}${u.model ? ` model ${u.model}` : ""}`, 200), // §12 "what was attempted"
      outcomeRep: u.success === false ? "failed attempt (recovered or not recorded)" : "produced expected output", // §12 "what happened"
      errorSignature: errorSig,
      errCode: u?.errorCode ?? u?.httpStatus ?? null,
      verified: outVerified(u),
      ordering: steps.length + 1,
      capturedAt: u.at ?? null,
    });
    steps.push(outRow);
  }
  const episodes = buildEpisodeSteps(runDir, state, steps.length);
  return {
    ok: true,
    runId: state?.runId ?? runId ?? null,
    outcome: runStateToOutcome(state?.runState, state),
    truncated: usage.length > MAX_STEPS,
    steps: steps.concat(episodes).slice(0, MAX_STEPS),
  };
}
function outVerified(u) {
  // Step-level VERIFIED determination is evidence-based: only rows carrying a
  // structured receipt (deploy receipt / sol verdict marker key names) are
  // credit-eligible; the rest default UNVERIFIED — attribution adds 0.
  return u?.verified === true ? "VERIFIED_SUCCESS" : u?.verified === false ? "VERIFIED_FAILED" : "UNVERIFIED";
}

// From state.json + run.log marker COUNTS (bounded; no log lines retained).
function buildEpisodeSteps(runDir, state, fromIndex) {
  const rows = [];
  const markers = {};
  try {
    const log = readFileSync(join(runDir, "run.log"), "utf8");
    for (const m of ["SPAWN-REFUSED", "NUDGE DELIVERY FAILED", "OPERATOR OVERRIDE"]) {
      markers[m] = (log.match(new RegExp(m.replace(/[- ]/g, "\\$&"), "g")) || []).length;
    }
  } catch {
    /* no run.log yet */
  }
  const pv = state?.phaseVerdicts ?? {};
  for (const [n, verdict] of Object.entries(pv)) {
    rows.push({
      runId: state?.runId ?? null,
      phase: n,
      objective: cap(state?.task ?? "", 200),
      tool: "phase",
      actionType: "PHASE_CLOSED",
      summaryRep: cap(`phase ${n}: ${verdict}`, 200),
      actionRep: cap(`phase ${n} execution recorded by coordinator`, 200),
      outcomeRep: String(verdict).includes("NEEDS_WORK") ? "phase needs work" : "phase accepted",
      errorSignature: String(verdict).includes("NEEDS_WORK") ? "PHASE_NEEDS_WORK" : null,
      errCode: null,
      verified: String(verdict).startsWith("OPERATOR_ACCEPTED") || String(verdict).includes("ACCEPTED") ? "VERIFIED_SUCCESS" : "UNVERIFIED",
      ordering: fromIndex + rows.length + 1,
      capturedAt: null,
    });
  }
  return rows;
}

// ---------------------------------------------------------------------------
// Episode rollup (§ "episodes (stitched turns)" — directive §11 reuse of run
// identity; one cheap record per run. A run's episode rollup is where the
// attribution model later reads R (§13), so the identity field
// (caseRun + outcome + verified) is authoritative here.
// ---------------------------------------------------------------------------
export function buildEpisode(runDir, { runId = null, caseRunId = null, title = null } = {}) {
  const gate = enabledWhen(flags(), "stepsCapture");
  if (!gate.ok) return { ok: false, code: gate.code, status: gate.status };
  const state = readJson(join(runDir, "state.json")) ?? null;
  if (!state) return { ok: false, code: "STATE_MISSING" };
  const ep = {
    schema: "episode.v1",
    caseRun: caseRunId ?? state.caseId ?? null,
    runId: runId ?? state.runId ?? null,
    title: scrub(cap(title ?? state.task ?? "", 220)),
    startedAt: state.startedAt ?? null,
    outcome: runStateToOutcome(state.runState, state),
    outcomeEvidence: verificationOf(state),
    runState: state.runState ?? null,
    phasesDone: state.completedThrough ?? 0,
    finalAcceptanceIsPresent: !!state.finalAcceptance,
    seats: Array.isArray(state.seats) ? state.seats.length : (typeof state.seats === "object" && state.seats ? Object.keys(state.seats).length : 0),
    capturedAt: new Date().toISOString(),
    // §27 traceability: pointer fields only, no duplicated content
    supportingEvidence: {
      runDir,
      stateSchema: "orchestra.run-state",
      debrief: existsSync(join(runDir, "debrief.md")) ? "runs/debrief.md" : null,
    },
  };
  return { ok: true, episode: ep };
}

// --- persistence (same runs tree; monotonic; no fsync readbacks) -------------
export function persistSteps(runDir, extraction, { confidence = "high" } = {}) {
  if (!extraction?.ok) return { ok: false, code: extraction?.code ?? "NO_EXTRACTION" };
  const f = join(runDir, "steps.jsonl");
  try {
    // Round-6 (Sol HOLD G1): the reader's caseRun push-down is STRICT, so the
    // WRITER must supply the case identity — read it from the run's own
    // state.json (state.caseId is the authoritative case key, runId ≠ caseId
    // is normal). Persisted rows now carry caseRun; a row keeps any
    // extraction-supplied caseRun. Without this the normal production path
    // produced caseRun-less rows that the strict reader could never return.
    const caseRun = readJson(join(runDir, "state.json"))?.caseId ?? null;
    const lines = extraction.steps.map((s) => JSON.stringify({ ...s, caseRun: s?.caseRun ?? caseRun, confidence }));
    appendFileSync(f, lines.join("\n") + "\n", "utf8");
    persistEpisodeQuiet(runDir, extraction);
    return { ok: true, wrote: lines.length, file: "runs/<runId>/steps.jsonl" };
  } catch (err) {
    return { ok: false, code: `PERSIST_THROW:${String(err?.name ?? err).slice(0, 20)}` };
  }
}
function persistEpisodeQuiet(runDir, extraction) {
  const r = buildEpisode(runDir, { runId: extraction.runId, title: extraction.steps?.[0]?.objective ?? null });
  if (!r.ok) return;
  try {
    appendFileSync(join(runDir, "episode-rollup.jsonl"), `${JSON.stringify(r.episode)}\n`, "utf8");
  } catch { /* non-fatal */ }
}

// ---------------------------------------------------------------------------
// Store executors — bound into the planner (steps.* channels). Bounded scan
// over the runs tree only, with caps; NEVER scans ~ or / (scan-guard law).
// Scoped to the same caseRun when the caller passes scope.caseRun (the push-
// down equivalent; a candidate pool filter, not a re-ranking).
// ---------------------------------------------------------------------------
export function createStepsExecutors({ runsDirs = ["/opt/harness-unset/ai-orchestration/kit/runs"] } = {}) {
  const fs = flags();

  function scanSteps({ errSig = null, ident = null, caseRun = null, topK = 5, limit = 300 }) {
    // Bounded: each dir, each steps.jsonl, tail-most rows only.
    const rows = [];
    outer: for (const base of runsDirs) {
      let merged = [];
      try {
        for (const d of readdirSync(base)) {
          const f = join(base, d, "steps.jsonl");
          if (!existsSync(f)) continue;
          let body;
          try { body = readFileSync(f, "utf8"); } catch { continue; }
          for (const l of body.split("\n").slice(-limit)) {
            if (!l.trim()) continue;
            const r = safeParse(l);
            if (!r) continue;
            // Round-5 (Sol HOLD G1): caseRun push-down is STRICT — when a
            // caseRun is requested, only records whose PERSISTED caseRun
            // equals it pass. A record without a persisted caseRun is not
            // proven to belong to the requested case and is skipped (this
            // made the filter permissive for record-less rows before).
            if (caseRun && r.caseRun !== caseRun) continue;
            merged.push({ dir: d, step: r });
            if (merged.length > limit) break outer;
          }
        }
      } catch { continue; }
      merged = merged.slice(-limit);
      for (const { dir, step } of merged) {
        const hit =
          errSig != null && step.errorSignature === errSig
            ? true
            : ident != null && JSON.stringify(step).toLowerCase().includes(String(ident).toLowerCase())
              ? true
              : false;
        if (!hit) continue;
        rows.push({
          id: `step:${dir}:${step.ordering}:${(step.phase ?? 0)}`,
          origin: "kit",
          layer: "step",
          // Round-6 (Sol HOLD G1): the PERSISTED caseRun is the row's case
          // identity — normally state.caseId written by persistSteps (runId ≠
          // caseId is normal). The directory is the runId namespace, never a
          // substitute for the case.
          caseRun: step.caseRun ?? null,
          // Scope PROOF (Sol round-3/4): the kit's OWN step ledger, filtered
          // on caseRun equality inside scanSteps — the push-down equivalent.
          // Fusion's scope gate accepts this proof for the caseRun dimension.
          scopeProof: "own-store-caseRun-pushdown",
          status: "APPROVED", // step records are observational, not approval-gated; the channel isn't approvalGated
          body: scrub(cap(`${step.actionRep} → ${step.outcomeRep}${step.verified !== "UNVERIFIED" ? ` (verified ${step.verified})` : ""}`, 300)),
          errorSignature: step.errorSignature,
          entityRefs: step.errCode ? [`err:${step.errCode}`] : [],
          created_at: step.capturedAt,
          locator: `${base}/${dir}/steps.jsonl#${step.ordering}`,
          revision: caseRun ?? dir,
          validity: "CURRENT",
          confidentiality: "normal",
          tags: ["step", step.verified ?? "UNVERIFIED", step.actionType ?? null].filter(Boolean),
          score: null, // exact channels: no comparative score
        });
        if (rows.length >= topK) break outer;
      }
    }
    return rows;
  }

  async function byErrorSignature({ scope = {}, topK = 5 } = {}) {
    const gate = enabledWhen(fs, "stepsCapture");
    if (!gate.ok) return { ok: false, code: gate.code, status: gate.status };
    if (!scope.errorSignature) return { ok: false, code: "SIGNATURE_REQUIRED" };
    const results = scanSteps({ errSig: String(scope.errorSignature).slice(0, 160), caseRun: scope.caseRun ?? null, topK });
    return { ok: true, results };
  }
  async function byIdentifier({ scope = {}, topK = 5 } = {}) {
    const gate = enabledWhen(fs, "stepsCapture");
    if (!gate.ok) return { ok: false, code: gate.code, status: gate.status };
    if (!scope.identifier) return { ok: false, code: "IDENTIFIER_REQUIRED" };
    const results = scanSteps({ ident: String(scope.identifier).slice(0, 120), caseRun: scope.caseRun ?? null, topK });
    return { ok: true, results };
  }
  async function episodes({ scope = {}, topK = 3, query = "" } = {}) {
    const gate = enabledWhen(fs, "stepsCapture");
    if (!gate.ok) return { ok: false, code: gate.code, status: gate.status };
    const rows = [];
    // Round-5 (Sol HOLD G1): episode results claim the caseRun push-down
    // proof, so they must actually be FILTERED on the requested caseRun —
    // a directory listing alone is not the push-down equivalent.
    const caseRunReq = scope.caseRun ?? null;
    outer: for (const base of runsDirs) {
      try {
        for (const d of readdirSync(base)) {
          // Round-6 (Sol HOLD G1): the DIRECTORY is the runId namespace and
          // may differ from the case. Compare each parsed episode's PERSISTED
          // caseRun against the requested case — never the directory name.
          const f = join(base, d, "episode-rollup.jsonl");
          if (!existsSync(f)) continue;
          let body;
          try { body = readFileSync(f, "utf8"); } catch { continue; }
          for (const l of body.split("\n").slice(-50)) {
            if (!l.trim()) continue;
            const ep = safeParse(l);
            if (!ep) continue;
            const text = `${ep.title ?? ""} ${ep.runState ?? ""}`.toLowerCase();
            if (query && typeof query === "string" && query.trim() && !textsOverlap(query, text)) continue;
            if (caseRunReq && ep.caseRun !== caseRunReq) continue;
            rows.push({
              id: `ep:${d}:${ep.runId ?? d}`,
              origin: "kit",
              layer: "episode",
              caseRun: ep.caseRun ?? null,
              // Same own-store proof: episode rollups are read from the kit's
              // own runs directory with the ep.caseRun equality filter — the
              // push-down equivalent.
              scopeProof: "own-store-caseRun-pushdown",
              body: scrub(cap(`${ep.outcome}: ${ep.title}`, 240)),
              status: "APPROVED",
              // P0 §5: only evidenced verification counts; completion is not
              // acceptance, so a COMPLETED_UNVERIFIED episode carries no
              // verification marker and can never corroborate a policy.
              verification: ep.outcome === "VERIFIED_SUCCESS"
                ? `episode-verified:${ep.outcomeEvidence?.ref ?? "acceptance-record"}`
                : null,
              entityRefs: [],
              locator: `${base}/${d}/episode-rollup.jsonl`,
              revision: d,
              validity: "CURRENT",
              created_at: ep.capturedAt,
              tags: ["episode", ep.outcome ?? "UNVERIFIED"],
              score: null,
            });
            if (rows.length >= topK) break outer;
          }
        }
      } catch { continue; }
    }
    return { ok: true, results: rows.slice(0, topK) };
  }
  async function policies() {
    const gate = enabledWhen(fs, "policyInduction");
    if (!gate.ok) return { ok: false, code: gate.code, status: gate.status };
    // P4 will add its own file; channel stays UX-complete (typed result).
    return { ok: true, results: [] };
  }
  return { byErrorSignature, byIdentifier, episodes, policies };
}

// Deterministic term overlap > 25% OR any exact phrase match.
function textsOverlap(query, text) {
  const a = String(query ?? "").toLowerCase();
  const b = String(text ?? "").toLowerCase();
  if (b.includes(a.trim()) || a.includes(b.trim())) return true;
  const ta = a.split(/\s+/).filter((x) => x.length > 2);
  if (!ta.length) return true;
  let hits = 0;
  for (const t of ta) if (b.includes(t)) hits++;
  return hits / ta.length > 0.25;
}
function safeParse(s) {
  try { return JSON.parse(s); } catch { return null; }
}
export { PENDING_VALIDATION };
