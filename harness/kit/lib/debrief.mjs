// V3.3.16 — run debrief: OpenClaw-style end-of-run memory (operator request
// 2026-09-20; design Sol-consulted in duo session 2026-09-20T10-00-10, verdict
// CONTRADICTED -> corrections applied).
//
// DESIGN CONTRACT (do not weaken):
//   - DETERMINISTIC aggregation of structured facts only. It never infers
//     "lessons" from arbitrary log prose — reusable procedural learning stays
//     with lib/skill-harvest.mjs (sanitized, successful runs).
//   - run.log is NEVER quoted. Only exact-marker COUNTS (SPAWN-REFUSED,
//     NUDGE DELIVERY FAILED, OPERATOR OVERRIDE) plus the structured
//     engine-usage.jsonl telemetry feed FAILURES/RECOVERIES.
//   - Hub digest lessons pass sanitizeSkillBody (fail-closed per lesson);
//     nothing unsanitized reaches the hub. The run-local debrief.md quotes
//     only coordinator/operator-authored text that already lives in the run dir.
//   - Bounded: DEBRIEF_MAX_BYTES total with per-section caps; hub digest
//     capped at DIGEST_MAX_LINES with drop-oldest (full history stays in
//     runs/<id>/debrief.md — the hub is a digest, not an archive).
//   - Idempotent per terminal state; fire-and-forget — a debrief failure can
//     never affect run finalization (same discipline as skill-harvest).
import { readFileSync, writeFileSync, appendFileSync, existsSync, readdirSync, statSync, renameSync,
  openSync, closeSync, unlinkSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { spawnSync } from "node:child_process";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

export const DEBRIEF_MAX_BYTES = 5 * 1024;
export const DIGEST_MAX_LINES = 200;
const HUB_DIGEST = "/opt/harness-unset/documentation/orchestra-lessons.md";
const MARKERS = ["SPAWN-REFUSED", "NUDGE DELIVERY FAILED", "OPERATOR OVERRIDE"];

// V3.3.16 rename: legacy state.json files carry mode:"duo"; the operator-facing
// word is "dual" ("duo" = the requester+Sol consult pairing). Mirrors orchestrate.mjs.
function canonicalMode(m) { return m === "duo" ? "dual" : (m ?? ""); }

const cap = (s, n) => { s = String(s ?? ""); return s.length <= n ? s : s.slice(0, n - 1) + "…"; };
const norm = (s) => String(s ?? "").toLowerCase().replace(/\s+/g, " ").trim();

function readJson(p) { try { return JSON.parse(readFileSync(p, "utf8")); } catch { return null; } }

// Structured telemetry: rows for this run only (bounded tail scan).
function usageForRun(runsDir, runId) {
  const rows = [];
  try {
    const lines = readFileSync(join(runsDir, "engine-usage.jsonl"), "utf8").split("\n");
    for (const l of lines.slice(-4000)) {
      if (!l.trim()) continue;
      try { const r = JSON.parse(l); if (r.runId === runId) rows.push(r); } catch { /* skip */ }
    }
  } catch { /* no telemetry yet */ }
  return rows;
}

// Exact-marker counts from run.log — occurrence counts ONLY, zero line content.
function markerCounts(rd) {
  const out = {};
  try {
    const log = readFileSync(join(rd, "run.log"), "utf8");
    for (const m of MARKERS) out[m] = (log.match(new RegExp(m.replace(/[- ]/g, "\\$&"), "g")) || []).length;
  } catch { for (const m of MARKERS) out[m] = 0; }
  return out;
}

function phaseLines(state, planText) {
  const total = (planText.match(/^## Phase /gm) || []).length || 0;
  const v = state.phaseVerdicts ?? {};
  const lines = [];
  for (let n = 1; n <= Math.max(total, Object.keys(v).length); n++) {
    if (n > 12) { lines.push(`… (remaining phases truncated)`); break; }
    lines.push(`Phase ${n}: ${v[n] ?? v[String(n)] ?? (n <= (state.completedThrough ?? 0) ? "done" : (state.currentPhase === n ? "in progress" : "pending"))}`);
  }
  if (!lines.length) lines.push("(no phases recorded)");
  return lines;
}

// Deterministic lessons from structured facts only, template-backed, max 3.
export function deriveLessons({ state, usage, markers, freebucks }) {
  const L = [];
  if ((markers["SPAWN-REFUSED"] ?? 0) > 0)
    L.push(`worker spawn was refused ${markers["SPAWN-REFUSED"]}x — a prepaid GLM seat may still be held; wait out the hour before forcing resumes (V3.3.8 gotcha)`);
  if (state.runState === "COMPLETED_OPERATOR_ACCEPTED")
    L.push("run closed by operator override — the acceptance blockers stand recorded in final-acceptance-*.md; re-reading them before similar tasks saves a repeat");
  const fails = usage.filter((r) => r.success === false);
  if (fails.length) {
    const byRc = {};
    for (const f of fails) { const k = `rc${f.rc ?? "?"}/${f.failureClass ?? "?"}`; byRc[k] = (byRc[k] ?? 0) + 1; }
    L.push(`provider failures ${fails.length}x (${Object.entries(byRc).slice(0, 3).map(([k, c]) => `${k}×${c}`).join(", ")}) — check \`engines\` retryAt/cooldowns before re-running long jobs`);
  }
  const reviews = Object.values(state.phaseVerdicts ?? {}).filter((x) => String(x).includes("NEEDS_WORK")).length;
  if (reviews > 0) L.push(`review loop needed ${reviews} re-review round(s) — complete, self-verifying worker evidence up front saves cycles`);
  if (freebucks > 0) L.push(`run cost ${freebucks} freebucks — pooled worker reuse is what keeps this down (sessions stay open 60 min)`);
  return L.slice(0, 3);
}

// Plan D16 taxonomy: none | event_only | learning_candidate | knowledge_proposal
// | skill_proposal | rule_proposal. Deterministic, facts-only, fail-safe:
export function memoryDisposition({ state = {}, usage = [], markers = {}, lessons = [] } = {}) {
  if ((markers["SPAWN-REFUSED"] ?? 0) > 0) return { disposition: "event_only", rationale: "provider-failure facts recorded by the debrief itself; no reusable lesson beyond it" };
  if (state.runState === "COMPLETED_OPERATOR_ACCEPTED") return { disposition: "event_only", rationale: "operator override closed the run with blockers standing — recorded as an event, not a promotable lesson" };
  const hasLesson = (lessons?.length ?? 0) > 0;
  if (hasLesson) return { disposition: "learning_candidate", rationale: "deterministic lesson(s) derived from structured facts; candidate for harvest skill note" };
  if ((state.runState ?? "").startsWith("COMPLETED")) return { disposition: "none", rationale: "routine success, no provider failures, no lesson-worthy facts — no content churn forced" };
  return { disposition: "event_only", rationale: "non-terminal run state — facts stay in the debrief/event stream" };
}

export function buildDebrief(runsDir, runId, { now = Date.now(), titleOverride = null } = {}) {
  const rd = join(runsDir, runId);
  const state = readJson(join(rd, "state.json")) ?? {};
  const planText = (() => { try { return readFileSync(join(rd, "plan.md"), "utf8"); } catch { return ""; } })();
  const usage = usageForRun(runsDir, runId);
  const markers = markerCounts(rd);
  const freebucks = usage.reduce((a, r) => a + (r.freebucksUsed ?? 0), 0);
  const mode = canonicalMode(state.mode) || "dual";
  const seats = (state.seats ?? state.workers ?? []).map((s) => (typeof s === "string" ? s : s.id)).join("+") || "?";
  const dur = state.startedAt ? Math.max(1, Math.round((now - state.startedAt) / 60000)) : null;

  const sec = {};
  sec["TASK / OUTCOME"] = [
    `Task: ${cap((state.task ?? "(unknown)").replace(/\s+/g, " "), 220)}`,
    `Outcome: ${state.runState ?? "unknown"} · started ${state.startedAt ? new Date(state.startedAt).toISOString() : "?"}${dur ? ` · ~${dur}min` : ""}`,
  ].join("\n");
  sec["EXECUTION SUMMARY"] = `Mode ${mode} (seats ${seats}) · phases done ${state.completedThrough ?? 0} · paid freebucks ${freebucks} · engine attempts ${usage.length} (failures ${usage.filter((r) => r.success === false).length})`;
  sec["PHASES / GATES"] = phaseLines(state, planText).join("\n");
  const fa = state.finalAcceptance ?? null;
  const findings = [];
  if (fa?.verdict) findings.push(`final acceptance: ${fa.verdict}${fa.overrideReason ? ` (override: ${cap(fa.overrideReason, 120)})` : ""}`);
  if (state.lastError) findings.push(`last error: ${cap(String(state.lastError).replace(/\s+/g, " "), 200)}`);
  if (!findings.length) findings.push("(no acceptance hold, no recorded error)");
  sec["FINDINGS"] = findings.join("\n");
  const failLines = [];
  for (const m of MARKERS) if (markers[m] > 0) failLines.push(`${m}: ${markers[m]}x`);
  const fails = usage.filter((r) => r.success === false);
  const byEng = {};
  for (const f of fails) { const k = `${f.engine ?? "?"} rc${f.rc ?? "?"}`; byEng[k] = (byEng[k] ?? 0) + 1; }
  for (const [k, c] of Object.entries(byEng).slice(0, 6)) failLines.push(`${k}: ${c} failed attempt(s)`);
  if (!failLines.length) failLines.push("(none recorded)");
  sec["FAILURES / RECOVERIES"] = failLines.join("\n");
  const arts = [];
  for (const f of ["plan.md", "review-phase1.md", "review-phase2.md", "final-acceptance-1.md", "final-acceptance-2.md"]) {
    try { arts.push(`${f} (${statSync(join(rd, f)).size}B)`); } catch { /* absent */ }
  }
  try { arts.push(`deployed/ (${readdirSync(join(rd, "deployed")).length} files)`); } catch { /* absent */ }
  sec["ARTIFACTS"] = cap(arts.join(", ") || "(none)", 480);
  const lessons = deriveLessons({ state, usage, markers, freebucks });
  sec["LESSONS"] = lessons.length ? lessons.map((l) => `- ${l}`).join("\n") : "(nothing beyond the recorded facts)";
  // Plan D16: REQUIRED memory disposition on every run (no forcing of content
  // churn — "none" with a rationale is a valid, expected outcome).
  const disp = memoryDisposition({ state, usage, markers, lessons });
  sec["MEMORY DISPOSITION"] = `${disp.disposition} — ${disp.rationale}`;

  const order = ["TASK / OUTCOME", "EXECUTION SUMMARY", "PHASES / GATES", "FINDINGS", "FAILURES / RECOVERIES", "ARTIFACTS", "LESSONS", "MEMORY DISPOSITION"];
  let body = `<!-- debrief v1 state=${state.runState ?? "unknown"} (V3.3.16; deterministic — structured facts only; run.log never quoted) -->\n# Run debrief — ${titleOverride ? `${titleOverride} (${runId})` : runId}\n\n`;
  for (const k of order) body += `## ${k}\n${sec[k]}\n\n`;
  body += `## Activity draft (paste-ready)\n- ${new Date(now).toISOString().slice(0, 10)} — run ${runId}: ${cap((state.task ?? "").replace(/\s+/g, " "), 90)} — ${state.runState ?? "?"} (${mode}, ${state.completedThrough ?? 0} phases, ${freebucks} fb). Debrief: work/ai-orchestration/runs/${runId}/debrief.md\n`;
  if (Buffer.byteLength(body, "utf8") > DEBRIEF_MAX_BYTES) body = body.slice(0, DEBRIEF_MAX_BYTES - 22) + "\n… (debrief truncated at cap)\n";
  return { body, lessons, state };
}

// ---- memory-orchestra RUN_COMPLETION hook (MemOS addendum 2026-10-23 §17) --
// Flag-gated post-write supplement: flags OFF ⇒ debrief byte-identical legacy;
// usable packet ⇒ ONE bounded advisory section appended to the debrief file.
// Retrieval-only — it never changes the disposition, the lessons, or any gate,
// and a hook failure just skips the append. ASYNC in ensureDebrief (which is
// async) — buildDebrief stays sync and its body untouched.
export async function runCompletionSupplement(runsDir, runId, file) {
  try {
    const { flags: morchFlags } = await import("./memory-orchestra/flags.mjs");
    const fs = morchFlags();
    if (!(fs.planner && fs.fusion && fs.ledger)) return { appended: false, reason: "flags off" };
    const { runHook, boundStepsExecutors } = await import("./memory-orchestra/hooks.mjs");
    const { createPlannerExecutors } = await import("./memory-orchestra/executors.mjs");
    let l23 = null;
    try { l23 = (await import("./memory-orchestra/client-l23.mjs")).createMemorycoreL23Client(); } catch { l23 = null; }
    const state = readJson(join(runsDir, runId, "state.json")) ?? {};
    const mRes = await runHook({
      hook: "RUN_COMPLETION",
      query: cap((state.task ?? "").replace(/\s+/g, " "), 260),
      scope: { agent: state.agent ?? "general", caseRun: state.caseId ?? runId },
      executors: createPlannerExecutors({ l23, steps: boundStepsExecutors({ runsDirs: [String(runsDir).replace(/\\/g, "/")] }) }),
      budgetBytes: 600,
    });
    if (!(mRes.ok && mRes.packet?.text && mRes.verdict?.state !== "INSUFFICIENT" && Number(mRes.packet?.bytesUsed ?? 0) > 0))
      return { appended: false, reason: mRes.code ?? "insufficient packet" };
    appendFileSync(file, `\n## MEMORY ORCHESTRA (RUN_COMPLETION supplement — advisory)\n${mRes.packet.text}\n`, "utf8");
    return { appended: true, bytes: mRes.packet.bytesUsed, fingerprint: mRes.packet.fingerprint };
  } catch (e) {
    return { appended: false, reason: `hook failure (${String(e?.name ?? e).slice(0, 30)})` };
  }
}

// ---- P0 §3/§4: autonomous documentation closeout (2026-10-23) --------------
// Ordinary run closeout now ASSESSES documentation automatically: the receipt
// is built from the run's own state, docctl persists it, and the decision is
// recorded per run (durable idempotency key = runs/<id>/doc-closeout.json).
// Failure is fail-open and never blocks finalisation. ORCH_DOC_AUTOWRITE=0
// disables the write step (assessment is still recorded).
export const DOC_CLOSEOUT_FILE = "doc-closeout.json";
// O6 (Sol 2026-10-24): optional advisory work must never delay closeout. The
// authoritative closeout record is written first with an explicit advisory
// status; the job goes to a durable queue that the NEXT closeout drains under a
// bounded budget. No detached child can vanish with its parent, and a timeout
// becomes DEGRADED — never a silent "documentation complete".
export const ADVISORY_QUEUE_FILE = "advisory-queue.jsonl";
// 2026-10-24 (operator closeout directive): concurrent enqueue/drain lost updates.
// A stable jobId per job and a lock shared by enqueue and the drain's finalise
// step are what keep a concurrent append from being overwritten.
export const ADVISORY_LOCK_FILE = ADVISORY_QUEUE_FILE + ".lock";
const ADVISORY_DRAIN_MS = (() => { const n = Number(process.env.ORCH_ADVISORY_DRAIN_MS ?? 1000); return Number.isFinite(n) && n >= 0 ? Math.floor(n) : 1000; })();

export const ADVISORY_CLAIM_FILE = "advisory-claimed.jsonl";
const ADVISORY_LOCK_STALE_MS = 5 * 60_000;
const ADVISORY_LOCK_RETRY_MS = 25;
const ADVISORY_LOCK_WAIT_MS = 1500;
const ADVISORY_CLAIM_STALE_MS = 10 * 60_000;

// Enqueue and drain both mutate the queue file, so both take this lock for the
// few milliseconds their critical section needs. The drain never holds it during
// retrieval: it CLAIMS its batch under the lock, processes outside it, then
// removes exactly those ids under the lock again. Serialising the append against
// that final read/rename is what closes the lost-update window an append could
// otherwise fall into.
function sleepSync(ms) {
  try { Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms); }
  catch { const until = Date.now() + ms; while (Date.now() < until) { /* last resort */ } }
}

function withAdvisoryLock(runsDir, fn) {
  const lp = join(runsDir, ADVISORY_LOCK_FILE);
  const giveUp = Date.now() + ADVISORY_LOCK_WAIT_MS;
  for (;;) {
    try {
      const fd = openSync(lp, "wx");
      try { writeFileSync(fd, `${process.pid} ${Date.now()}`); } finally { closeSync(fd); }
    } catch (e) {
      if (e?.code !== "EEXIST") return { ok: false, code: "LOCK_FAILED" };
      let age = Infinity;
      try { age = Date.now() - statSync(lp).mtimeMs; } catch { age = 0; }
      if (age > ADVISORY_LOCK_STALE_MS) { try { unlinkSync(lp); } catch { /* retry */ } continue; }
      if (Date.now() >= giveUp) return { ok: false, code: "LOCKED" };
      sleepSync(ADVISORY_LOCK_RETRY_MS);
      continue;
    }
    try { return { ok: true, value: fn() }; }
    catch (e) { return { ok: false, code: String(e?.code ?? "LOCKED_WRITE_FAILED") }; }
    finally { try { unlinkSync(lp); } catch { /* lock cleanup never breaks the caller */ } }
  }
}

export function enqueueAdvisory(runsDir, job) {
  const jobId = job && typeof job.jobId === "string" && job.jobId ? job.jobId : randomUUID();
  const record = { ...job, jobId };
  const res = withAdvisoryLock(runsDir, () => {
    appendFileSync(join(runsDir, ADVISORY_QUEUE_FILE), JSON.stringify(record) + "\n", "utf8");
  });
  return res.ok === true;
}

function setAdvisoryStatus(runsDir, runId, status, detail = null) {
  try {
    const p = join(runsDir, String(runId), DOC_CLOSEOUT_FILE);
    const rec = JSON.parse(readFileSync(p, "utf8"));
    rec.advisory = { ...(rec.advisory ?? {}), status, completedAt: new Date().toISOString(), detail };
    writeDocRecord(p, rec);
  } catch { /* advisory bookkeeping never breaks closeout */ }
}

function readAdvisoryClaims(runsDir) {
  const f = join(runsDir, ADVISORY_CLAIM_FILE);
  if (!existsSync(f)) return [];
  try {
    return readFileSync(f, "utf8").split("\n").filter(Boolean)
      .map((l) => { try { return JSON.parse(l); } catch { return null; } })
      .filter(Boolean);
  } catch { return []; }
}

function writeAdvisoryClaims(runsDir, claims) {
  const f = join(runsDir, ADVISORY_CLAIM_FILE);
  const tmp = `${f}.tmp-${process.pid}`;
  writeFileSync(tmp, claims.map((c) => JSON.stringify(c)).join("\n") + (claims.length ? "\n" : ""), "utf8");
  renameSync(tmp, f);
}

function countQueueLines(qf) {
  try { return readFileSync(qf, "utf8").split("\n").filter(Boolean).length; } catch { return 0; }
}

// Bounded drain: at most 3 jobs and ADVISORY_DRAIN_MS total per pass. Jobs left
// behind stay in the queue for the next pass; none are invented or silently dropped.
export async function drainAdvisoryQueue(runsDir, { budgetMs = ADVISORY_DRAIN_MS } = {}) {
  const qf = join(runsDir, ADVISORY_QUEUE_FILE);
  if (!existsSync(qf)) return { drained: 0, remaining: 0, results: [] };

  // 1. Claim (locked): pick up to three unclaimed jobs. Legacy lines without an
  //    id are normalised here, under the same lock, so they can be claimed too.
  const claim = withAdvisoryLock(runsDir, () => {
    const raw = readFileSync(qf, "utf8").split("\n").filter(Boolean);
    let normalised = false;
    const parsed = [];
    const preservedLines = raw.map((line) => {
      let job;
      try { job = JSON.parse(line); } catch { return line; }
      if (!job || typeof job !== "object" || Array.isArray(job)) return line;
      if (typeof job.jobId === "string" && job.jobId) { parsed.push(job); return line; }
      normalised = true;
      const withId = { ...job, jobId: randomUUID() };
      parsed.push(withId);
      return JSON.stringify(withId);
    });
    if (normalised) {
      // Preserve malformed legacy lines while upgrading valid jobs with ids.
      // A partial corrupt queue must never lose evidence during normalisation.
      const tmp = `${qf}.tmp-${process.pid}`;
      writeFileSync(tmp, preservedLines.join("\n") + "\n", "utf8");
      renameSync(tmp, qf);
    }
    const now = Date.now();
    const fresh = readAdvisoryClaims(runsDir)
      .filter((c) => now - Date.parse(String(c.at ?? "")) < ADVISORY_CLAIM_STALE_MS);
    const taken = new Set(fresh.map((c) => c.jobId));
    const batch = parsed.filter((j) => !taken.has(j.jobId)).slice(0, 3);
    if (batch.length) {
      writeAdvisoryClaims(runsDir, [...fresh, ...batch.map((j) => ({ jobId: j.jobId, runId: j.runId ?? null, at: new Date().toISOString() }))]);
    }
    return { batch, total: parsed.length };
  });
  if (!claim.ok) return { drained: 0, remaining: countQueueLines(qf), results: [], skipped: claim.code };
  const batch = claim.value.batch;
  if (!batch.length) return { drained: 0, remaining: claim.value.total, results: [] };

  // 2. Process outside the lock: retrieval is slow and an enqueue must not wait.
  let mod;
  try { mod = await import("./memory-orchestra/wire.mjs"); } catch { return { drained: 0, remaining: countQueueLines(qf), results: [] }; }
  let drained = 0;
  const started = Date.now();
  const results = [];
  for (const j of batch) {
    const left = budgetMs - (Date.now() - started);
    if (left <= 0) break;
    let status = "COMPLETED";
    let detail = null;
    const t0 = Date.now();
    let res = null;
    try {
      res = await Promise.race([
        mod.documentationAuthoringAdvisory({ subject: j.subject ?? "", affectedPaths: Array.isArray(j.affectedPaths) ? j.affectedPaths : [] }),
        new Promise((r) => setTimeout(() => r("TIMEOUT"), Math.max(1, left))).then((v) => { if (v === "TIMEOUT") throw new Error("ADVISORY_TIMEOUT"); }),
      ]);
      if (res?.ok === true) { drained++; }
      else if (res?.code === "FLAG_DISABLED") { status = "OMITTED"; detail = "flags off"; }
      else { status = "DEGRADED"; detail = String(res?.code ?? "NO_PACKET"); }
    } catch (e) {
      const why = String(e?.message ?? "");
      status = why === "ADVISORY_TIMEOUT" ? "DEGRADED_CHANNEL:TIMEOUT" : "DEGRADED";
      detail = why === "ADVISORY_TIMEOUT" ? `exceeded ${left}ms drain budget` : why.slice(0, 120);
    }
    setAdvisoryStatus(runsDir, j.runId, status, detail);
    results.push({
      jobId: j.jobId ?? null, runId: j.runId ?? null, subject: j.subject ?? null, status, detail,
      ok: res?.ok === true, code: res?.code ?? null, state: res?.state ?? null,
      bytes: Number(res?.bytesUsed ?? 0), fingerprint: res?.fingerprint ?? null,
      text: typeof res?.text === "string" ? res.text : null,
      ms: Date.now() - t0,
    });
  }

  // 3. Finalise (locked): remove exactly the processed ids from a fresh read and
  //    drop their claims. Enqueue appends cannot land inside this window.
  const processedIds = new Set(results.map((r) => r.jobId).filter(Boolean));
  const fin = withAdvisoryLock(runsDir, () => {
    const current = readFileSync(qf, "utf8").split("\n").filter(Boolean);
    const kept = current.filter((line) => {
      let rec = null;
      try { rec = JSON.parse(line); } catch { return true; }
      return !(rec && typeof rec.jobId === "string" && processedIds.has(rec.jobId));
    });
    const tmp = `${qf}.tmp-${process.pid}`;
    writeFileSync(tmp, kept.join("\n") + (kept.length ? "\n" : ""), "utf8");
    renameSync(tmp, qf);
    writeAdvisoryClaims(runsDir, readAdvisoryClaims(runsDir).filter((c) => !processedIds.has(c.jobId)));
    return { remaining: kept.length };
  });

  return { drained, remaining: fin.ok ? fin.value.remaining : countQueueLines(qf), results };
}

function docChangeTypeFor(state) {
  const explicit = String(state?.docChangeType ?? "").trim().toLowerCase();
  if (explicit) return explicit;
  const rs = String(state?.runState ?? "");
  if (["FAILED", "ABORTED", "REMEDIATION_EXHAUSTED"].includes(rs)) return "troubleshooting";
  if (rs.startsWith("COMPLETED")) return "implementation";
  return "";
}

export function docReceiptForRun(runsDir, runId, state) {
  const paths = Array.isArray(state?.changedFiles) ? state.changedFiles
    : Array.isArray(state?.paths) ? state.paths : [];
  const verified = [];
  for (const [phase, verdict] of Object.entries(state?.phaseVerdicts ?? {})) {
    const v = String(verdict);
    if (v.startsWith("OPERATOR_ACCEPTED") || v.includes("ACCEPTED")) {
      verified.push(`phase ${phase}: ${v}`);
    }
  }
  const fa = state?.finalAcceptance;
  if (fa && typeof fa === "object" && (fa.record || fa.path)) {
    verified.push(`final acceptance: ${fa.decision ?? fa.verdict ?? "accepted"} (${fa.record ?? fa.path})`);
  }
  return {
    summary: cap((state?.task ?? "").replace(/\s+/g, " "), 300),
    objective: cap((state?.task ?? "").replace(/\s+/g, " "), 600),
    changeType: docChangeTypeFor(state),
    subject: String(state?.docSubject ?? "").trim() || undefined,
    paths,
    revision: state?.sourceRevision ?? state?.commit ?? undefined,
    evidenceRefs: [`runs/${runId}/state.json`, `runs/${runId}/debrief.md`],
    verifiedResults: verified,
    // S03: operational evidence is passed through ONLY when the run recorded
    // it; doc_program marks absent sections as not-captured rather than
    // inventing procedures.
    commands: docOpsList(state?.commands),
    rollback: docOpsList(state?.rollback),
    troubleshooting: docOpsList(state?.troubleshooting),
    limitations: docOpsList(state?.limitations),
  };
}

function docOpsList(v) {
  if (!Array.isArray(v)) return undefined;
  const out = v.slice(0, 20).map((x) => {
    if (typeof x === "string") return cap(x, 300);
    if (x && typeof x === "object") {
      const cmd = cap(x.cmd ?? x.command ?? "", 300);
      return { cmd, verified: x.verified === true, note: x.note ? cap(x.note, 200) : undefined };
    }
    return null;
  }).filter(Boolean);
  return out.length ? out : undefined;
}

// P0 §3 (2026-10-23 remediation): the receipt is a RESEMPLABLE lifecycle, not
// a one-shot marker. File existence used to mean "done", so an interrupted or
// failed ingest/publish was silently treated as complete forever. The record
// now carries per-step state (assess -> write -> ingest -> publish), retry
// counters and a terminal verdict; a later closeout RESUMES only the missing
// steps and never re-writes a committed document.
export const DOC_CLOSEOUT_VERSION = 2;
export const DOC_CLOSEOUT_MAX_ATTEMPTS = 5;
export const DOC_TERMINAL_OK = new Set(["DOC_NOT_REQUIRED", "NO_CHANGE", "DOC_PUBLISHED", "DOC_INGEST_INDEXED"]);
export const DOC_RETRYABLE = new Set([
  "DOC_ASSESSED", "DOC_CREATED", "DOC_UPDATED", "DOC_INGEST_PENDING",
  "DOC_INGEST_FAILED", "DOC_PUBLISH_PENDING", "DOC_PUBLISH_FAILED",
  "DOC_CLOSEOUT_FAILED",
]);

function docWikiWanted(record, opts) {
  if (typeof opts?.wiki === "boolean") return opts.wiki;
  if (record && typeof record.wiki === "boolean") return record.wiki;
  // P0 §4 (2026-10-24): the WikiJS credential is restored and the destination
  // is readback-verified, so publication is ON by default. Automated pages land
  // ONLY under /hub-docs and are PRIVATE (wiki-gql defaults isPrivate=true; the
  // Guests/All groups carry an explicit hub-docs deny rule). ORCH_DOC_WIKI=0
  // remains the containment control (no WikiJS write, publish recorded SKIPPED).
  return String(process.env.ORCH_DOC_WIKI ?? "1") !== "0";
}

// A lifecycle is complete only when the FINAL required operation succeeded.
// With publishing enabled, index-only is not terminal (a queued publication is
// not a published document); without it, verified ingestion is the terminus.
export function docCloseoutComplete(record, wikiWanted = docWikiWanted(record, null)) {
  const st = String(record?.status ?? "");
  if (!record || !DOC_TERMINAL_OK.has(st)) return false;
  if (wikiWanted && st !== "DOC_PUBLISHED" && st !== "DOC_NOT_REQUIRED" && st !== "NO_CHANGE") return false;
  return true;
}

// Sol 2026-10-24 turn 2: ONE definition of effective completion. The early
// terminal-replay guard and the persisted record must agree, otherwise a
// retryable record (or one whose index probe appears later) is returned as
// "terminal" and never re-verified. When publishing is on AND an index probe is
// configured, the ingest step is a required fact and must be INDEXED.
export function docCloseoutEffectiveComplete(record, wikiWanted, probeConfigured) {
  if (!docCloseoutComplete(record, wikiWanted)) return false;
  if (!wikiWanted || !probeConfigured) return true;
  return record?.steps?.ingest?.status === "INDEXED";
}

// ---- RepoQL docs-index probe (2026-10-24) ---------------------------------
// Publication and indexing are independent facts, and the docs corpus is
// indexed by RepoQL FROM A CONFIGURED GITHUB MIRROR (uri
// github://<owner>/<docs-repository>/...), refreshed by the docs publish job.
// Until that cycle runs, a freshly written doc is genuinely absent from the
// index — which is
// why the lifecycle used to record indexUnconfirmed with no way to check.
// This probe asks the live index directly: a hit makes the ingest step
// INDEXED (verified closeout), a miss records an explicit awaiting-index fact.
// ORCH_DOC_SEARCH_CMD keeps precedence when set (external destination probe);
// ORCH_DOC_INDEX_PROBE=0 disables this one.
export function repoqlDocIndexProbeAvailable() {
  if (String(process.env.ORCH_DOC_INDEX_PROBE ?? "1") === "0") return false;
  try { return existsSync(process.env.ORCH_DOC_RQL_BIN || "/usr/local/bin/rql"); } catch { return false; }
}

export function repoqlDocIndexed(targetPath) {
  const p = String(targetPath ?? "").trim().replace(/\\/g, "/");
  if (!p) return { ok: false, code: "TARGET_PATH_REQUIRED" };
  const bin = process.env.ORCH_DOC_RQL_BIN || "/usr/local/bin/rql";
  // The consolidated RepoQL host is selected by cwd; a project-scoped host has
  // empty docs scopes (the 2026-10-23 finding), so prefer the fleet root.
  const cwd = process.env.ORCH_DOC_INDEX_CWD
    || (existsSync("/opt/harness-unset/.repoql") ? "/opt/harness-unset" : process.cwd());
  const needle = p.replace(/'/g, "''");
  const sql = `SELECT uri FROM files WHERE uri LIKE '%${needle}' LIMIT 5`;
  const r = spawnSync(bin, ["query", sql, "--json"], { cwd, encoding: "utf8", timeout: 60_000 });
  if (r.status !== 0) return { ok: false, code: "RQL_UNAVAILABLE", detail: cap(r.stderr ?? "", 200) };
  let rows;
  try { rows = JSON.parse(String(r.stdout || "[]")); } catch { return { ok: false, code: "RQL_PARSE_FAILED" }; }
  const uris = Array.isArray(rows) ? rows.map((x) => String(x?.uri ?? "")).filter(Boolean) : [];
  return { ok: true, indexed: uris.length > 0, uris: uris.slice(0, 5) };
}

function docStepsFor(prop, prev = {}) {
  const steps = {
    assess: { status: "DONE", at: new Date().toISOString() },
    write: { ...(prev.write ?? { status: "PENDING" }) },
    ingest: { ...(prev.ingest ?? { status: "PENDING" }) },
    publish: { ...(prev.publish ?? { status: "PENDING" }) },
  };
  const verb = prop?.verb ?? null;
  const st = String(prop?.status ?? "");
  if (verb && ["CREATE", "UPDATE", "CORRECT", "MERGE", "SUPERSEDE", "ARCHIVE"].includes(verb)) {
    steps.write = { status: "DONE", verb, targetPath: prop?.targetPath ?? steps.write.targetPath ?? null, at: new Date().toISOString() };
  }
  if (st === "DOC_INGEST_INDEXED") steps.ingest = { status: "INDEXED", at: new Date().toISOString() };
  else if (st === "DOC_INGEST_FAILED") steps.ingest = { status: "FAILED", at: new Date().toISOString() };
  else if (st === "DOC_INGEST_PENDING") steps.ingest = { status: "PENDING", at: new Date().toISOString() };
  if (st === "DOC_PUBLISHED") {
    steps.publish = { status: "DONE", receipt: prop?.publishReceipt ?? null, at: new Date().toISOString() };
    // The publish step REPLACES the prop status, so the ingest fact would
    // otherwise be lost: a doc that WAS index-confirmed before publishing would
    // be recorded as "pending" and reported unverified forever. The publisher
    // carries its own ingestState in the receipt — trust that fact, not order.
    if (prop?.publishReceipt?.ingestState === "DOC_INGEST_INDEXED") {
      steps.ingest = { status: "INDEXED", at: new Date().toISOString(), source: "publish-receipt" };
    }
  } else if (st === "DOC_PUBLISH_FAILED") steps.publish = { status: "FAILED", reason: cap(prop?.reason ?? "", 300), at: new Date().toISOString() };
  return steps;
}

function writeDocRecord(path, record) {
  // Atomic: an interrupted write must not leave a half-parsed record that a
  // later closeout would misread as terminal.
  const tmp = `${path}.tmp-${process.pid}`;
  writeFileSync(tmp, JSON.stringify(record, null, 1));
  renameSync(tmp, path);
}

function runDocctl(argv) {
  const r = spawnSync("python3", argv, { encoding: "utf8", timeout: 120_000 });
  let prop = null;
  try { prop = JSON.parse(r.stdout || "{}"); } catch { prop = null; }
  return {
    exitCode: r.status,
    error: r.error ? String(r.error.code ?? r.error.name ?? r.error).slice(0, 40) : null,
    prop,
    stderr: r.stderr ? cap(r.stderr, 300) : null,
  };
}

export async function documentationCloseout(runsDir, runId, state, opts = {}) {
  try {
    // O6 (Sol 2026-10-24): closeout does NOT drain the advisory queue. A drain
    // here would reintroduce the blocking it is meant to remove, and an idle
    // system would never run it. Pending work is executed by an explicit replay
    // (`tools/drain-advisories.mjs`); this process only records and returns.
    const rd = join(runsDir, runId);
    const recordPath = join(rd, DOC_CLOSEOUT_FILE);
    let prev = null;
    try { prev = JSON.parse(readFileSync(recordPath, "utf8")); } catch { prev = null; }
    const wikiWanted = docWikiWanted(prev, opts);
    const force = opts.force === true || String(process.env.ORCH_DOC_FORCE ?? "0") === "1";
    const maxAttempts = Number.isFinite(Number(opts.maxAttempts)) ? Number(opts.maxAttempts) : DOC_CLOSEOUT_MAX_ATTEMPTS;
    // Computed BEFORE the terminal guard: the guard must use the same effective
    // completion as the write path, otherwise a retryable record (or one whose
    // index probe appears later) is skipped as terminal and never verified.
    const searchCmd = String(process.env.ORCH_DOC_SEARCH_CMD ?? "").trim();
    // An injected probe (tests) replaces the RepoQL one; otherwise the RepoQL
    // docs probe is used when available and no external probe is configured.
    const indexProbe = searchCmd
      ? null
      : (typeof opts.indexProbe === "function"
        ? opts.indexProbe
        : (repoqlDocIndexProbeAvailable() ? repoqlDocIndexed : null));
    const ingestProbeConfigured = Boolean(searchCmd) || Boolean(indexProbe);

    // Terminal success: return the existing result, do not redo any work.
    // A published-but-unverified record is re-probed here: the index may have
    // caught up since the closeout ran (hub-docs publish/import cycle). An
    // awaiting-index record is probed EVEN THOUGH a configured probe makes it
    // "incomplete" — re-running docctl would re-publish a document that is
    // already published, which is churn, not verification.
    if (prev) {
      const prevTarget = prev.targetPath ?? prev.steps?.write?.targetPath;
      const awaitingIndex = Boolean(prev.indexUnconfirmed) && prev.steps?.ingest?.source === "repoql-docs";
      if (awaitingIndex && indexProbe && prevTarget) {
        const pr = indexProbe(prevTarget);
        prev.indexProbe = { at: new Date().toISOString(), indexed: Boolean(pr?.ok && pr.indexed), code: pr?.ok ? null : (pr?.code ?? null), uris: pr?.uris ?? [] };
        if (pr?.ok && pr.indexed) {
          prev.steps = { ...(prev.steps ?? {}), ingest: { status: "INDEXED", source: "repoql-docs", uris: pr.uris, at: prev.indexProbe.at } };
          prev.indexUnconfirmed = false;
          prev.verified = true;
          prev.complete = true;
          prev.nextAction = null;
          prev.updatedAt = prev.indexProbe.at;
          writeDocRecord(recordPath, prev);
        }
        return { ok: true, complete: Boolean(prev.complete), verified: Boolean(prev.verified && !prev.indexUnconfirmed), indexUnconfirmed: Boolean(prev.indexUnconfirmed), skipped: pr?.ok && pr.indexed ? "terminal" : "awaiting-index", status: prev.status, verb: prev.verb ?? prev.steps?.write?.verb ?? null, targetPath: prevTarget, steps: prev.steps, ingestProbe: prev.indexProbe, nextAction: prev.nextAction ?? null };
      }
    }
    if (prev && docCloseoutEffectiveComplete(prev, wikiWanted, ingestProbeConfigured)) {
      const terminal = { ok: true, complete: true, verified: prev.verified ?? !prev.indexUnconfirmed, indexUnconfirmed: Boolean(prev.indexUnconfirmed), skipped: "terminal", status: prev.status, verb: prev.verb ?? prev.steps?.write?.verb ?? null, targetPath: prev.targetPath ?? prev.steps?.write?.targetPath ?? null };
      if (prev.indexUnconfirmed && indexProbe && (prev.targetPath ?? prev.steps?.write?.targetPath)) {
        const target = prev.targetPath ?? prev.steps?.write?.targetPath;
        const pr = indexProbe(target);
        prev.indexProbe = { at: new Date().toISOString(), indexed: Boolean(pr?.ok && pr.indexed), code: pr?.ok ? null : (pr?.code ?? null), uris: pr?.uris ?? [] };
        if (pr?.ok && pr.indexed) {
          prev.steps = { ...(prev.steps ?? {}), ingest: { status: "INDEXED", source: "repoql-docs", uris: pr.uris, at: prev.indexProbe.at } };
          prev.indexUnconfirmed = false;
          prev.verified = true;
          prev.nextAction = null;
          prev.updatedAt = prev.indexProbe.at;
          writeDocRecord(recordPath, prev);
          return { ...terminal, verified: true, indexUnconfirmed: false, ingestProbe: prev.indexProbe };
        }
      }
      return terminal;
    }
    // Budget exhausted: a real operator-actionable block, distinct from a
    // retryable failure. force (or a clearing env flag) re-arms the lifecycle.
    if (prev && !force && Number(prev.attempts ?? 0) >= maxAttempts && String(prev.status) !== "DOC_BLOCKED") {
      prev.status = "DOC_BLOCKED";
      prev.blockedReason = `retry budget exhausted after ${prev.attempts} attempts; rerun with force`;
      prev.updatedAt = new Date().toISOString();
      writeDocRecord(recordPath, prev);
    }
    if (prev && String(prev.status) === "DOC_BLOCKED" && !force) {
      return { ok: false, complete: false, blocked: true, retryable: false, status: "DOC_BLOCKED", reason: prev.blockedReason ?? "blocked requiring operator action", steps: prev.steps ?? null };
    }

    const receipt = docReceiptForRun(runsDir, runId, state);
    if (!receipt.changeType && !(prev && prev.steps?.write?.status === "DONE")) {
      const record = {
        version: DOC_CLOSEOUT_VERSION, runId, wiki: wikiWanted, attempts: 1,
        assessedAt: prev?.assessedAt ?? new Date().toISOString(), updatedAt: new Date().toISOString(),
        receipt, status: "DOC_NOT_REQUIRED", reason: "no material change type on this run",
        steps: { assess: { status: "DONE" }, write: { status: "SKIPPED" }, ingest: { status: "SKIPPED" }, publish: { status: "SKIPPED" } },
      };
      writeDocRecord(recordPath, record);
      return { ok: true, complete: true, status: record.status, verb: null, steps: record.steps };
    }

    const record = {
      version: DOC_CLOSEOUT_VERSION,
      runId,
      wiki: wikiWanted,
      attempts: Number(prev?.attempts ?? 0) + 1,
      assessedAt: prev?.assessedAt ?? new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      receipt,
      steps: prev?.steps ?? { assess: { status: "DONE" }, write: { status: "PENDING" }, ingest: { status: "PENDING" }, publish: { status: "PENDING" } },
      status: prev?.status ?? "DOC_ASSESSED",
      verb: prev?.verb ?? null,
      targetPath: prev?.targetPath ?? prev?.steps?.write?.targetPath ?? null,
    };
    const receiptPath = join(rd, "doc-receipt.json");
    writeFileSync(receiptPath, JSON.stringify(receipt, null, 1));
    const docctl = process.env.ORCH_DOCCTL
      || fileURLToPath(new URL("../docs/docctl", import.meta.url));
    const apply = String(process.env.ORCH_DOC_AUTOWRITE ?? "1") !== "0";

    // Write already committed on a previous attempt: resume ingest/publish
    // only. Re-running the assess/write path could duplicate or churn docs.
    const resumingAfterWrite = record.steps?.write?.status === "DONE" && Boolean(record.targetPath);
    // Ingest verification: an external probe (ORCH_DOC_SEARCH_CMD) makes the
    // destination confirm searchability; otherwise the RepoQL docs probe below
    // checks the live index after the run.
    let argv;
    if (resumingAfterWrite) {
      argv = [docctl, "finish", "--apply", "--target-path", String(record.targetPath),
        "--subject", String(record.steps?.write?.subject ?? receipt.subject ?? record.targetPath)];
      if (searchCmd) argv.push("--search-cmd", searchCmd);
      if (wikiWanted) argv.push("--wiki");
    } else {
      argv = [docctl, "run", "--receipt", receiptPath];
      if (apply) argv.push("--apply");
      if (searchCmd) argv.push("--search-cmd", searchCmd);
      if (wikiWanted) argv.push("--wiki");
    }
    const r = runDocctl(argv);
    const prop = r.prop;
    const steps = docStepsFor(prop, record.steps);
    if (!resumingAfterWrite && steps.write.status === "DONE") steps.write.subject = String(receipt.subject ?? receipt.summary ?? "").slice(0, 120);
    if (wikiWanted && steps.publish.status === "PENDING" && steps.ingest.status === "INDEXED") steps.publish = { status: "FAILED", reason: "publish not confirmed by destination", at: new Date().toISOString() };
    if (!wikiWanted && steps.publish.status === "PENDING") steps.publish = { status: "SKIPPED", at: new Date().toISOString() };
    record.steps = steps;
    record.exitCode = r.exitCode;
    record.error = r.error;
    record.propStatus = prop?.status ?? null;
    record.status = prop?.status
      ?? (r.exitCode === 0 ? (resumingAfterWrite ? "DOC_INGEST_PENDING" : "DOC_ASSESSED") : "DOC_CLOSEOUT_FAILED");
    record.verb = prop?.verb ?? record.verb;
    record.targetPath = prop?.targetPath ?? record.targetPath;
    record.reason = prop?.reason ?? r.stderr ?? record.reason ?? null;
    record.publishReceipt = prop?.publishReceipt ?? record.publishReceipt ?? null;
    record.updatedAt = new Date().toISOString();
    // Terminal success must reflect the WHOLE lifecycle, never an exit code.
    //
    // S16/S17 follow-up (Sol 2026-10-24): "terminal" and "verified" are NOT
    // the same claim. Publication and indexing are independent facts, but a
    // publish whose index state is still unconfirmed must never be reported as
    // a verified closeout:
    //   * an index probe IS configured (ORCH_DOC_SEARCH_CMD): unverified ingest
    //     is a real open step, so the lifecycle is not terminal and retries;
    //   * no probe is configured: indexing is unverifiable in this deployment,
    //     the loop is terminal (retrying forever cannot change it), and the
    //     record/result carry verified=false + indexUnconfirmed=true so the
    //     caller can never mistake it for a fully verified closeout.
    const published = record.steps?.publish?.status === "DONE";
    let ingestVerified = record.steps?.ingest?.status === "INDEXED";
    // RepoQL docs probe: only meaningful once publication is confirmed (the
    // document exists at the destination) and only when no external probe ran.
    let probeRanUnindexed = false;
    if (!ingestVerified && indexProbe && wikiWanted && published && record.targetPath) {
      const pr = indexProbe(record.targetPath);
      record.indexProbe = { at: new Date().toISOString(), indexed: Boolean(pr?.ok && pr.indexed), code: pr?.ok ? null : (pr?.code ?? null), uris: pr?.uris ?? [] };
      if (record.indexProbe.indexed) {
        record.steps = { ...(record.steps ?? {}), ingest: { status: "INDEXED", source: "repoql-docs", uris: record.indexProbe.uris, at: record.indexProbe.at } };
        ingestVerified = true;
      } else {
        probeRanUnindexed = true;
        record.steps = { ...(record.steps ?? {}), ingest: { status: "PENDING", source: "repoql-docs", reason: record.indexProbe.code ?? "not in the docs index yet", at: record.indexProbe.at } };
      }
    }
    const indexUnconfirmed = Boolean(wikiWanted && published && !ingestVerified);
    // A probe that ran and found the document not yet indexed is an awaiting-
    // index fact, not a failed step: the hub-docs publish/import cycle owns that
    // lag, so retrying this closeout cannot change it. The record stays
    // terminal-but-unverified (verified=false) exactly as before, and a later
    // closeout re-probes and flips it to verified. A CONFIGURED probe that never
    // ran (external ORCH_DOC_SEARCH_CMD) keeps the strict not-terminal path.
    record.complete = docCloseoutEffectiveComplete(record, wikiWanted, ingestProbeConfigured && !probeRanUnindexed);
    record.verified = Boolean(record.complete && !indexUnconfirmed);
    record.indexUnconfirmed = indexUnconfirmed;
    if (!record.complete) {
      // A published-but-unverified doc with a probe configured is an OPEN,
      // retryable step even though DOC_PUBLISHED is otherwise a terminal
      // status: the probe exists precisely so this can be confirmed later.
      record.retryable = (ingestProbeConfigured && published && !ingestVerified)
        || (!(record.status === "DOC_BLOCKED") && (DOC_RETRYABLE.has(String(record.status)) || prop == null));
      record.nextAction = ingestProbeConfigured && published && !ingestVerified
        ? "index probe configured but ingest not confirmed; rerun finish to verify"
        : record.steps?.write?.status === "DONE"
          ? "resume ingest/publish only (write already committed)"
          : "rerun assessment/write";
    } else if (indexUnconfirmed) {
      record.nextAction = probeRanUnindexed
        ? "published and awaiting index: the docs corpus is indexed from the GitHub mirror after the hub-docs publish cycle (daily 03:20); a later closeout re-probes"
        : "published; index confirmation not available — rerun finish with a search probe to verify";
    }
    // O6: the record is authoritative and is written BEFORE any advisory work.
    // The advisory is queued (durable) and drained by a later closeout, so this
    // call never waits on retrieval and never reports an advisory as done when
    // it was not attempted.
    if (record.steps?.write?.status === "DONE") {
      const queuedAt = new Date().toISOString();
      const job = {
        runId,
        subject: String(record.steps.write.subject ?? receipt.subject ?? runId),
        affectedPaths: Array.isArray(receipt.paths) ? receipt.paths : [],
        queuedAt,
      };
      const queued = enqueueAdvisory(runsDir, job);
      record.advisory = queued
        ? { status: "PENDING", queuedAt }
        : { status: "OMITTED", queuedAt, detail: "advisory queue write failed" };
    }
    writeDocRecord(recordPath, record);
    return {
      ok: Boolean(record.complete), complete: Boolean(record.complete),
      verified: Boolean(record.verified), indexUnconfirmed: Boolean(record.indexUnconfirmed),
      retryable: Boolean(record.retryable), blocked: record.status === "DOC_BLOCKED",
      status: record.status, verb: record.verb, targetPath: record.targetPath,
      steps: record.steps, attempts: record.attempts,
      reason: record.reason ?? null, nextAction: record.nextAction ?? null,
    };
  } catch (e) {
    return { ok: false, complete: false, retryable: true, code: `DOC_CLOSEOUT_THROW:${String(e?.name ?? e).slice(0, 24)}` };
  }
}

// ---- P1 §9: durable Ghost wake signals at run closeout --------------------
// The wake digest lands in the dreaming agent's memfs memory dir, which the
// existing dream entrypoint quotes into its prompt on the next scheduled run.
export async function emitWakeSignals(state, runId) {
  try {
    const { publishWakeDigest } = await import("./memory-orchestra/ghostwake.mjs");
    const extras = [];
    const rs = String(state?.runState ?? "");
    if (["FAILED", "ABORTED", "REMEDIATION_EXHAUSTED"].includes(rs)) {
      extras.push({
        kind: "REPEATED_FAILURES",
        evidence: `run ${runId} ended ${rs}: ${cap(state?.lastError ?? state?.task ?? "", 180)}`,
        suggestedFocus: "whether this failure signature has a verified fix to record",
      });
    }
    return await publishWakeDigest({ extraReasons: extras });
  } catch (e) {
    return { ok: false, code: `WAKE_EMIT_THROW:${String(e?.name ?? e).slice(0, 24)}` };
  }
}

// ---- hub lessons digest (bounded, deduped, drop-oldest; fleet-SSH transport,
// injectable for tests). Fail-open everywhere. ----
// V3.3.20.1 live-bug fix (2026-09-21, operator-initiated doc pass): the hub
// write must TRUNCATE — appendLessonsToHub builds a FULL rebuilt block (header
// + all kept lessons), so `cat >>` appended a complete duplicate of the digest
// every time fresh lessons landed (doubled header found live 2026-09-21).
// Exported so the selftest can pin the truncation semantics.
export const HUB_DIGEST_WRITE_CMD = `cat > '${HUB_DIGEST}'`;
function sshDigest({ read = true, block = "" }) {
  const args = ["controller", read ? `cat '${HUB_DIGEST}' 2>/dev/null || true` : HUB_DIGEST_WRITE_CMD];
  const r = spawnSync("ssh", args, { input: read ? undefined : block, encoding: "utf8", timeout: 20_000 });
  return read ? (r.stdout ?? "") : r.status === 0;
}

export async function appendLessonsToHub(lessons, runId, { transport = sshDigest, sanitize = null, date = new Date().toISOString().slice(0, 10) } = {}) {
  const fresh = [];
  if (!lessons.length) return { appended: 0, skipped: 0 };
  let cur = "";
  try { cur = transport({ read: true }); } catch { return { appended: 0, skipped: lessons.length, error: "digest read failed" }; }
  // Dedupe key: normalized content WITHOUT the run-id/date suffix — identical
  // lessons from different runs must collapse (Sol C3). Both sides stripped.
  const strip = (s) => norm(s).replace(/\(run [^)]+\)/g, "").trim();
  const seen = new Set(cur.split("\n").map(strip).filter(Boolean));
  for (const l of lessons) {
    let line = `- ${l} (run ${runId}, ${date})`;
    if (sanitize) { const s = sanitize(line, { task: "" }); if (!s.ok) continue; line = s.body; }
    const key = strip(line);
    if (seen.has(key)) continue;
    seen.add(key);
    fresh.push(line);
  }
  if (!fresh.length) return { appended: 0, skipped: lessons.length };
  let kept = cur.split("\n").filter((x) => x.trim() && !x.startsWith("#") && !x.startsWith("<!--"));
  kept = kept.concat(fresh).slice(-DIGEST_MAX_LINES);
  const header = "# Orchestra lessons digest\n<!-- bounded digest (V3.3.16): newest-one-line lessons, drop-oldest; deduped by normalized content; full history in the kit runs/<id>/debrief.md. DO NOT hand-append raw run output here. -->\n\n";
  const block = header + kept.join("\n") + "\n";
  let okWrite = false;
  try { okWrite = transport({ read: false, block }); } catch { okWrite = false; }
  return { appended: okWrite ? fresh.length : 0, skipped: lessons.length - fresh.length, okWrite };
}

// ---- Journal write (ticket 164 Phase 5 §12.3, supersedes the MEX mirror):
// every durable REAL lesson that reaches the hub digest lands as ONE bounded
// journal event via fleet-log on controller (documentation/journal/events.jsonl).
// Deterministic: reuses the SAME deduped fresh[] lines, no extra model call.
// Best-effort, fail-open — it can never affect debrief or terminal state.
const FLEET_LOG_CMD = "fleet-log --source orchestra --type LESSON --status current";
function mexMirror(lessons, runId) {
  try {
    for (const l of lessons.slice(0, 5)) {
      const msg = `${l} (run ${runId})`.replace(/'/g, "");
      spawnSync("ssh", ["controller", `${FLEET_LOG_CMD} '${msg}'`], { encoding: "utf8", timeout: 20_000 });
    }
  } catch { /* fail-open */ }
}

// Entry point — fire-and-forget from terminal paths. Idempotent per state:
// an existing debrief for the SAME runState is left untouched (no duplicate
// digests, no duplicate notifications); a state CHANGE regenerates.
export async function ensureDebrief(runsDir, runId, { notify = null, transport = sshDigest, sanitize = null, now = Date.now(), titleOverride = null } = {}) {
  const rd = join(runsDir, runId);
  const state = readJson(join(rd, "state.json"));
  if (!state) return { created: false, reason: "no state.json" };
  // V3.3.35 D13 (ticket 085): a confidential run's debrief body AND its
  // lessons both derive from the confidential task text — the hub digest and
  // MEX are durable non-engine destinations, so a confidential run produces
  // NO debrief and delivers NOTHING (fail-closed; the operator decides
  // explicitly). The run dir keeps state/plan/transcripts (operator-local).
  let confidential = false;
  try {
    const { isConfidentialRun } = await import("./confidentiality.mjs");
    confidential = isConfidentialRun(state);
  } catch { /* module missing ⇒ pre-D13 behavior */ }
  if (confidential) {
    try { if (notify) notify(`debrief ready: work/ai-orchestration/runs/${runId}/debrief.md — HUB/MEX delivery SUPPRESSED (D13: confidential run)`); } catch { /* fail-open */ }
    return { created: false, reason: "confidential run — debrief kept local, no hub/MEX delivery (D13)" };
  }
  const file = join(rd, "debrief.md");
  const marker = `<!-- debrief v1 state=${state.runState}`;
  try { if (existsSync(file) && readFileSync(file, "utf8").startsWith(marker)) return { created: false, reason: `already debriefed at ${state.runState}` }; } catch { /* regenerate */ }
  const { body, lessons } = buildDebrief(runsDir, runId, { now, titleOverride });
  writeFileSync(file, body);
  const morch = await runCompletionSupplement(runsDir, runId, file); // §17 flag-gated advisory; failure is a typed skip
  // P0 §3/§4: automatic documentation assessment at ordinary closeout, and
  // P1 §9: durable wake signals for the existing dream scheduler. Both are
  // fail-open and bounded; neither can block or alter run finalisation.
  const docCloseout = await documentationCloseout(runsDir, runId, state);
  const wakes = await emitWakeSignals(state, runId);
  let digest = { appended: 0, skipped: lessons.length };
  try { digest = await appendLessonsToHub(lessons, runId, { transport, sanitize }); } catch { /* fail-open */ }
  if (digest.appended > 0) mexMirror(lessons.filter((l) => {
    // only mirror the lines that were actually appended (dedupe mirrored too)
    return true; // per-line dedupe happens server-side via identical-content collapse; bounded to 5
  }), runId);
  // V3.5.0 (ticket 141): terminal runs with failure-family states log a
  // structured agent-issue (runs/agent-issues.jsonl + per-run file + deduped
  // MEX mirror; the controller bridge relays to #agent-run-issues). Fail-open.
  // MemOS addendum 2026-10-23: flag-gated TOOL_FAILURE/decision-repair advisory
  // rides only the error line when a repair payload exists (append-only text,
  // never executes anything); flags-off ⇒ byte-identical legacy behaviour.
  let morchRepair = null;
  if (["FAILED", "ABORTED", "REMEDIATION_EXHAUSTED"].includes(String(state.runState ?? ""))) {
    try {
      const { toolFailureRepair } = await import("./memory-orchestra/wire.mjs");
      const sig = cap((state.lastError ?? state.runState).replace(/\s+/g, " "), 160);
      morchRepair = await toolFailureRepair({ signature: sig, runId, caseRun: state.caseId ?? null, query: cap((state.task ?? "").replace(/\s+/g, " "), 220) }, { runsDirs: [String(runsDir).replace(/\\/g, "/")] });
      // S08 TOOL_FAILURE: the run's own terminal failure is the lifecycle event
      // for this hook (distinct from DECISION_REPAIR's repair lookup).
      const { toolFailureHook } = await import("./memory-orchestra/wire.mjs");
      await toolFailureHook({ signature: sig, runId, query: cap((state.task ?? "").replace(/\s+/g, " "), 220) });
    } catch { /* advisory-only */ }
  }
  try {
    if (["FAILED", "ABORTED", "REMEDIATION_EXHAUSTED"].includes(String(state.runState ?? ""))) {
      const { logAgentIssue } = await import("./agent-issues.mjs");
      const issued = logAgentIssue(runsDir, {
        runNumber: state.runNumber ?? null, runId,
        kind: "run-terminal-failure", severity: "error", agent: "buffy",
        source: "debrief",
        summary: `run ${runId} terminal ${state.runState} — ${cap(String(state.task ?? ""), 160)}`,
        detail: `runState=${state.runState} mode=${canonicalMode(state.mode)} phases=${state.completedThrough ?? 0}; full debrief: work/ai-orchestration/runs/${runId}/debrief.md`,
      });
      // S08 INCIDENT_INVESTIGATION (2026-10-24): fires ONLY after the incident
      // record above actually exists — the investigation step follows the
      // event, never the other way round. An issue that was deduped/skipped
      // still means the incident is recorded, so `issued === false` is not an
      // error; a THROW skips the hook (handled by this catch).
      try {
        const { incidentInvestigationHook } = await import("./memory-orchestra/wire.mjs");
        await incidentInvestigationHook({ signature: cap((state.lastError ?? state.runState).replace(/\s+/g, " "), 160), runId, query: cap((state.task ?? "").replace(/\s+/g, " "), 220) });
      } catch { /* advisory only */ }
      void issued;
    }
  } catch { /* fail-open */ }
  try { if (notify) notify(`debrief ready: work/ai-orchestration/runs/${runId}/debrief.md — ${digest.appended} lesson(s) captured to the hub digest`); } catch { /* fail-open */ }
  // Flag-gated TOOL_FAILURE advisory append (§16: bounded, marked advisory).
  if (morchRepair?.ok && morchRepair.repair?.ok && morchRepair.repair.text) {
    try {
      appendFileSync(file, `\n## DECISION REPAIR ADVISORY (TOOL_FAILURE retrieval — advisory; verify before acting)\nsignature: ${morchRepair.signature}${morchRepair.recorded ? ` · observed ${morchRepair.recorded.observed} distinct turn(s)` : ""}\n${morchRepair.repair.text}\n`, "utf8");
    } catch { /* advisory-only */ }
  }
  return { created: true, digest, morchSupplement: morch, morchRepair, bytes: Buffer.byteLength(body, "utf8") };
}
