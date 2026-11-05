// lib/conversation-review.mjs — V3.4.4 (hub ticket 130, operator request
// 2026-09-27): the conversation-review self-learning loop. At every terminal
// conversation boundary (run terminal state via fireDebrief's hook, consult
// close via cmdConsultEnd) the ENTIRE conversation transcript is ATTACHED as
// a real .md FILE to the duo consultant (Sol via catgpt) with the operator's
// verbatim question:
//   "what else should I add to documentation for my self learning and memory
//    systems?"
// TRANSPORT (operator-corrected 2026-09-27 — do not regress):
//   - The transcript travels as a REAL FILE ATTACHMENT via the bridge's
//     SOL_ATTACH mechanism (V3.3.35b, ticket 085): staged as $STAGE.part.<name>
//     and sent as OpenAI content parts {type:file,file:{filename,data,
//     mime_type}}; the catgpt gateway decodes them container-side and uploads
//     through the real ChatGPT file input (client.py _upload_files →
//     set_input_files; attachment pill verified before submit). NO inline
//     pasting of the transcript, NO chunking, NO elision.
//   - SOL_RAW=1 on every review dispatch: the review prompt is kit-authored
//     operational text and the transcript file is byte-exact — the humanizer
//     NEVER rewrites either (operator mandate).
//   - The ONLY size cap is a sabotage guard (64 MB, far above any real
//     transcript) against runaway assembly bugs; the ENTIRE transcript is
//     otherwise always attached, per the operator mandate. Gateway-side
//     upload limits surface as honest failures.
//
// Sol-consulted design contract (consult 2026-09-27T06-50-38, VERDICT:
// CONTRADICTED -> FIX PLAN applied where it survives the transport fix):
//   F2 VERIFICATION GATE: Sol output is advisory evidence, not truth. Only
//      recommendations with confidence=high AND durability=durable AND a
//      non-empty evidence_reference are applied to MEX; everything else is
//      HELD as a labeled proposal in the findings file. Hub-doc items are
//      ALWAYS proposal-only (paste-ready block; the closing agent verifies
//      at apply time). AGENTS.md is never auto-mutated by this module.
//   F3 RECURSION SUPPRESSION: a transcript that IS a review request (its
//      body carries this module's prompt header marker) is never reviewed —
//      review-generated conversations are ineligible for automatic review.
//   F4 IDEMPOTENCY: a receipt keyed by kind+id+sha256(transcript) prevents
//      duplicate reviews of the same conversation; changed transcript =>
//      new review is legitimate.
//   F5 PROVENANCE: every recommendation carries evidence_reference,
//      confidence, durability — the gate keys on them.
//   Plus: findings land ONLY through existing gated paths (captureConcept is
//   the ONE RepoQL write path, ad-hoc included); verbatim operator question;
//   D13-confidential suppressed; deterministic SOL_SESSION_ID
//   convreview-<id>; dual-host gateway probe before dispatch; daily budget;
//   fire-and-forget with its own failure domain.
// ISSUE 151 (2026-09-28, Sol-CONFIRMED consult 120): repoql-import target
//   added — ALWAYS proposal-only (never auto-executed: no rql, no host reset,
//   no reindex from this path); context block now states the RepoQL
//   Enterprise plan ($200/month, operator-directed), MEX-in-use, and the
//   hub .md -> WikiJS redacted-sync fact. REVIEW_QUESTION stays verbatim.
import { readFileSync, writeFileSync, existsSync, mkdirSync, appendFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { join, basename } from "node:path";
import { createHash } from "node:crypto";
import { TOMBSTONES_DIR_DEFAULT } from "./memory-tombstone.mjs"; // ticket 191: tombstone plane location (enforcement itself is lazily imported per-candidate)

// Sabotage guard ONLY (Sol turn 3, ticket 130): the operator mandate is that
// the ENTIRE transcript is attached for every conversation, so the cap sits
// far above any real transcript (64 MB) and exists to catch runaway assembly
// bugs, not to bound real conversations. Real transport limits surface as the
// gateway's own upload error, which fails the review honestly.
export const MAX_TRANSCRIPT_BYTES = Number(process.env.ORCH_CONV_REVIEW_MAX_BYTES ?? 64_000_000);
export const REVIEW_QUESTION =
  "what else should I add to documentation for my self learning and memory systems?";
// F3 recursion marker: emitted into every review prompt; its presence in a
// transcript marks that transcript as review-origin (never re-reviewed).
export const RECURSION_MARKER = "conversation-review request (self-learning loop, origin=conversation-review)";
const MEX_MAX_ITEMS = 3;
const CONCEPT_MAX_ITEMS = 3;
const HERE = join(import.meta.dir ?? ".", ".."); // kit root (lib/..)
const RUNS_DEFAULT = join(HERE, "runs");

const cap = (s, n) => { s = String(s ?? ""); return s.length <= n ? s : s.slice(0, n - 1) + "…"; };
const norm = (s) => String(s ?? "").toLowerCase().replace(/\s+/g, " ").trim();
const nowIso = () => new Date().toISOString();
const sha256 = (t) => createHash("sha256").update(String(t ?? "")).digest("hex");

function readJson(p) { try { return JSON.parse(readFileSync(p, "utf8")); } catch { return null; } }

// ---- daily dispatch budget (catgpt 429 protocol: bounded, operator-visible) ----
function usagePath(runsDir) { return join(runsDir, "conv-review-usage.json"); }
export function dispatchBudget(runsDir = RUNS_DEFAULT, { maxDay = Number(process.env.ORCH_CONV_REVIEW_MAX_DAY ?? 8), today = new Date().toISOString().slice(0, 10) } = {}) {
  const u = readJson(usagePath(runsDir)) ?? {};
  const used = u.date === today ? (u.count ?? 0) : 0;
  return { used, maxDay, allowed: used < maxDay, today };
}
function recordDispatch(runsDir = RUNS_DEFAULT, today = new Date().toISOString().slice(0, 10)) {
  const b = dispatchBudget(runsDir, { today });
  try { writeFileSync(usagePath(runsDir), JSON.stringify({ date: today, count: b.used + 1 }, null, 2)); } catch { /* fail-open */ }
}

// ---- F4 idempotency receipts (keyed by kind+id+transcript hash) ----
function receiptsPath(runsDir) { return join(runsDir, "conv-review-receipts.json"); }
export function reviewReceipt(runsDir = RUNS_DEFAULT, { kind, id, transcriptMd }) {
  const key = `${kind}:${id}:${sha256(transcriptMd)}`;
  const all = readJson(receiptsPath(runsDir)) ?? {};
  return { key, existing: all[key] ?? null, all };
}
function recordReceipt(runsDir, key, meta) {
  try {
    const all = readJson(receiptsPath(runsDir)) ?? {};
    all[key] = { at: nowIso(), ...meta };
    writeFileSync(receiptsPath(runsDir), JSON.stringify(all, null, 2));
  } catch { /* fail-open */ }
}

// ---- confidentiality (D13) — same rule as debrief: confidential never leaves ----
async function isConfidential(state) {
  try { const { isConfidentialRun } = await import("./confidentiality.mjs"); return isConfidentialRun(state); }
  catch { return false; }
}

// ---- transcript assembly (deterministic; NO truncation on this path) ----
export function buildRunTranscript(runsDir, runId) {
  const rd = join(runsDir, runId);
  const parts = [];
  const tryPush = (label, file, transform = null) => {
    try {
      const p = join(rd, file);
      if (!existsSync(p)) return;
      const raw = readFileSync(p, "utf8");
      parts.push(`## ${label}\n\n${transform ? transform(raw) : raw}\n`);
    } catch { /* absent/unreadable */ }
  };
  const state = readJson(join(rd, "state.json"));
  tryPush("state.json", "state.json");
  tryPush("plan.md", "plan.md");
  tryPush("NOTEPAD.md (operator/worker communication pad — tail 400 lines)", "NOTEPAD.md", (raw) => raw.split("\n").slice(-400).join("\n"));
  tryPush("debrief.md", "debrief.md");
  for (const f of ["review-phase1.md", "review-phase2.md", "final-acceptance-1.md", "final-acceptance-2.md"]) tryPush(f, f);
  try {
    const lines = readFileSync(join(runsDir, "engine-usage.jsonl"), "utf8").split("\n");
    const rows = [];
    for (const l of lines.slice(-4000)) {
      if (!l.trim()) continue;
      try { const r = JSON.parse(l); if (r.runId === runId) rows.push(r); } catch { /* skip */ }
    }
    if (rows.length) parts.push(`## engine-usage rows (${rows.length})\n\n\`\`\`json\n${rows.map((r) => JSON.stringify(r)).join("\n")}\n\`\`\`\n`);
  } catch { /* no telemetry */ }
  const header = `# Conversation transcript — RUN ${runId}\n\nAssembled deterministically from the run dir (FULL content, no elision; run.log intentionally never quoted; assembly wall-clock kept OUT of the body so the idempotency hash is stable).\nSource dir: work/ai-orchestration/runs/${runId}\n`;
  return { body: header + parts.join("\n"), state, runDir: rd };
}

export function buildConsultTranscript(consultDir, consultId) {
  let transcript = "";
  try { transcript = readFileSync(join(consultDir, "transcript.md"), "utf8"); } catch { /* absent */ }
  let meta = null;
  try { meta = readJson(join(consultDir, "meta.json")); } catch { /* absent */ }
  const header = `# Conversation transcript — CONSULT ${consultId}\n\nAssembled deterministically from the consult session dir (FULL content, no elision; wall-clock kept out of the body for stable hashing).\nSource dir: work/ai-orchestration/runs/consult/${consultId}\n`;
  return { body: header + transcript, meta, consultDir };
}

// ---- prompt: short, kit-authored; the transcript travels as a FILE via
// SOL_ATTACH (real ChatGPT upload), never pasted inline, never chunked. ----
export function buildChunkPrompt({ id, kind, chunk = "", index = 0, total = 1, isFinal = true, transcriptFile = null }) {
  const name = transcriptFile ? ` (filename: ${transcriptFile})` : "";
  const header = `# ${RECURSION_MARKER}\n\nReview target: ${kind} ${id}. The COMPLETE conversation transcript is ATTACHED to this message as a real .md file${name} — read it in full before answering; it is deliberately NOT pasted inline.`;
  if (!isFinal) return header;
  return `${header}

OPERATOR'S QUESTION (verbatim): "${REVIEW_QUESTION}"

Context on the fleet memory systems so your recommendations are actionable:
- Hub docs: current-state documentation (controller /opt/harness-unset/documentation/)
  written as plain .md files; redacted copies are later synced to the WikiJS wiki —
  keep hub-doc recommendations free of secrets.
- MEX memory is in use: git-versioned event/wiki memory (\`mex log\` LESSON/NOTE
  events, wiki entities).
- RepoQL concepts: machine-surfaceable capsules (\`rql concept add\` via the gated
  capture only; categories wisdom|rule|knowledge; knowledge REQUIRES
  verification+ttlDays; relevance is a schemeless glob starting **/).
- RepoQL Enterprise plan is in use ($200/month): premium capabilities (concepts,
  explain, larger corpus imports) are AVAILABLE — recommend applicable RepoQL
  capabilities and corpus imports only when supported by transcript evidence and
  RepoQL semantics (repoql.com docs); enterprise availability never lowers the
  evidence bar.
- AGENTS.md: standing rules (NEVER auto-mutated from your recommendations —
  they are proposals requiring explicit operator approval).

## ANSWER CONTRACT (machine-parsed — use these exact section headers; one "- " line per item)

## RECOMMENDATIONS
- target=repoql-concept|repoql-import|mex|hub-doc|agentchat|none | <what, short> | <invariant/one-liner> | <evidence_reference: quote or locate the transcript passage that motivated this> | <confidence=high|medium|low> | <durability=durable|episodic> | <category=rule|wisdom|knowledge (repoql-concept only)> | relevance=<narrow semicolon-separated schemeless **/ globs that cite the indexed source files; required for repoql-concept; never use a broad parent such as **/work/**> | [buildsOn=<Comma,Separated,EXISTING,CapsuleNames>]

target=repoql-import means: a repository, tree, corpus, or refresh source that
should be considered for RepoQL indexing (repoql.com semantics). It is
ALWAYS proposal-only — this review loop never executes imports.

buildsOn is OPTIONAL and only meaningful for target=repoql-concept: list EXACT
existing RepoQL capsule names (CamelCase) whose claims this new one is derived
from. Names that do not exist are dropped and the candidate is HELD
(fail-closed lineage, ticket 339) — never invent or guess names.

## CODE FIXES
- <recurring mistake observed> + exact corrective action + evidence_reference=<quote/locate>

## SKIP
- <what looks like a lesson but is NOT durable enough to store>

Rules: max 5 RECOMMENDATIONS, max 5 CODE FIXES. Only durable, reusable,
evidenced items — no routine successes, no one-off trivia. confidence=high
means you can point at the exact transcript evidence. If nothing qualifies,
say exactly "(none)" under the header. Remember: your output is ADVISORY
EVIDENCE — a verification gate decides what becomes durable memory.`;
}

// ---- structured findings parser (provenance-aware, readback-tolerant).
// The gateway's answer readback may strip '##' prefixes, wrap entries across
// lines, and interleave UI artifacts. Strategy: find section headers with or
// without hashes, then parse each section as BLANK-LINE-SEPARATED PARAGRAPHS
// (wrapped lines join into one entry). ----
export function parseFindings(text) {
  const out = { recommendations: [], codeFixes: [], skip: [], unparsed: false };
  const t = String(text ?? "");
  const ARTIFACT = /^(\u2026+|Show more$|ChatGPT said:?|\[?Show more\]?)$/i;
  const section = (header) => {
    const lines = t.split("\n");
    const re = new RegExp(`^\\s*#{0,4}\\s*${header}\\s*:?$`, "i");
    const start = lines.findIndex((l) => re.test(l.trim()));
    if (start < 0) return null;
    const acc = [];
    for (let i = start + 1; i < lines.length; i++) {
      const trimmed = lines[i].trim();
      if (re.test(trimmed)) continue;
      if (/^#{1,6}\s/.test(lines[i]) || /^\s*#{0,4}\s*(RECOMMENDATIONS|CODE\s+FIXES|SKIP)\s*:?\s*$/i.test(trimmed)) break;
      acc.push(lines[i]);
    }
    return acc.join("\n");
  };
  const paragraphs = (b) => {
    const paras = [];
    let cur = [];
    for (const raw of (b ?? "").split("\n")) {
      const l = raw.trim();
      if (ARTIFACT.test(l)) continue;
      if (!l) { if (cur.length) { paras.push(cur.join(" ")); cur = []; } continue; }
      const wasBullet = /^-\s+/.test(l);
      const unbulleted = l.replace(/^-\s+/, "");
      // A new keyed entry always breaks the paragraph (consultants often
      // separate entries with newlines instead of blank lines); a fresh
      // bullet breaks it too (unkeyed sections list one item per bullet).
      if ((/^target=\s*[a-z-]+/i.test(unbulleted) || wasBullet) && cur.length) { paras.push(cur.join(" ")); cur = []; }
      cur.push(unbulleted);
    }
    if (cur.length) paras.push(cur.join(" "));
    return paras.filter((pp) => pp && !/^\(none\)$/i.test(pp) && !/^- </.test(pp));
  };
  const recBlock = section("RECOMMENDATIONS");
  const fixBlock = section("CODE FIXES");
  const skipBlock = section("SKIP");
  out.unparsed = recBlock === null && fixBlock === null && skipBlock === null;
  for (const p of paragraphs(recBlock)) {
    if (!/target=/i.test(p)) continue; // a rec must carry a target
    const seg = p.split("|").map((s2) => s2.trim());
    const target = (seg[0]?.match(/target=([a-z-]+)/i)?.[1] ?? seg[0] ?? "").toLowerCase();
    const evidence = seg[3] ?? "";
    const confidence = (seg[4]?.match(/confidence=([a-z]+)/i)?.[1] ?? (seg[4] && /^(high|medium|low)$/i.test(seg[4]) ? seg[4].toLowerCase() : "")).toLowerCase();
    const durability = (seg[5]?.match(/durability=([a-z]+)/i)?.[1] ?? (seg[5] && /^(durable|episodic)$/i.test(seg[5]) ? seg[5].toLowerCase() : "")).toLowerCase();
    const category = (seg[6]?.match(/category=([a-z]+)/i)?.[1] ?? (seg[4]?.match(/category=([a-z]+)/i)?.[1] ?? "rule")).toLowerCase();
    const relevance = seg.slice(6).find((part) => /^relevance=/i.test(part))?.replace(/^relevance=/i, "").trim() ?? "";
    // Ticket 339 phase 2.1: optional buildsOn=<Comma,Separated,Names> (any segment
    // after the category position; tolerant of gateway re-wrapping). Shape-only
    // filtering here — existence is validated at apply time (fail-closed HOLD).
    const buildsOnRaw = seg.slice(6).join("|").match(/buildsOn=([^|]*)/i)?.[1] ?? "";
    const buildsOn = buildsOnRaw.split(",").map((s2) => s2.trim()).filter((s2) => /^[A-Z][A-Za-z0-9]+$/.test(s2)).slice(0, 32);
    out.recommendations.push({ target, what: seg[1] ?? "", invariant: seg[2] ?? "", evidence, confidence, durability, category, relevance, buildsOn });
  }
  for (const p of paragraphs(fixBlock)) out.codeFixes.push(cap(p, 400));
  for (const p of paragraphs(skipBlock)) out.skip.push(cap(p, 400));
  return out;
}

// F2 verification gate: what may LEAVE the findings file into durable stores.
export function verifyRecommendation(r) {
  const problems = [];
  if (!r?.evidence || r.evidence.length < 8) problems.push("no evidence_reference");
  if (r?.confidence !== "high") problems.push(`confidence=${r?.confidence || "missing"} (need high)`);
  if (r?.durability !== "durable") problems.push(`durability=${r?.durability || "missing"} (need durable)`);
  return { verified: problems.length === 0, problems };
}

// ---- gateway probe (dual-host verification before any Sol dispatch).
// Dispatch needs AT LEAST ONE healthy gateway (service-routing contract: each
// host is a candidate; one-shot failover covers the other). BOTH down = no
// dispatch (fail-closed). ----
export function gatewaysHealthy(probe = process.env.ORCH_CONV_REVIEW_PROBE !== "0") {
  if (!probe) return { ok: true, detail: "probe disabled", healthy: ["controller"] };
  const check = (host) => {
    const r = spawnSync("ssh", [host, `curl -m 6 -o /dev/null -w '%{http_code}' http://127.0.0.1:8300/v1/models -H 'Authorization: Bearer dummy123'`], { encoding: "utf8", timeout: 15_000 });
    return String(r.stdout ?? "").trim();
  };
  const a = check("controller"), b = check("webserver");
  const healthy = [a === "200" ? "controller" : null, b === "200" ? "webserver" : null].filter(Boolean);
  return { ok: healthy.length > 0, healthy, detail: `controller=${a} webserver=${b}` };
}

// ---- dispatch: one bridge call with the transcript ATTACHED as a real file
// (SOL_ATTACH — the V3.3.35b browser-native upload path) and SOL_RAW=1 (the
// kit-authored prompt + byte-exact transcript are NEVER humanized). ----
export function dispatchReview({ promptFile, outFile, id, attachFile = null, bridge = join(HERE, "openai-sol-bridge.sh"), env = process.env, sshHost = null }) {
  const session = `convreview-${id}`;
  const extraEnv = sshHost ? { SOL_ROUTE: "0", SOL_SSH_HOST: sshHost } : {};
  const attachEnv = attachFile ? { SOL_ATTACH: attachFile } : {};
  const r = spawnSync("bash", [bridge, promptFile, outFile], {
    encoding: "utf8", timeout: 15 * 60_000, maxBuffer: 16 * 1024 * 1024,
    env: { ...env, ...extraEnv, ...attachEnv, SOL_RAW: "1", SOL_SESSION_ID: session, SOL_TIMEOUT_SEC: env.SOL_TIMEOUT_SEC ?? "600" },
  });
  let body = "";
  try { body = readFileSync(outFile, "utf8"); } catch { /* no outfile */ }
  return { ok: r.status === 0 && body.trim().length > 0, rc: r.status, body, session, err: cap(String(r.stderr ?? ""), 300) };
}

// ---- ticket 339 phase 2.3: durable HELD records for the memory-approve path ----
// Every concept-rec HOLD is persisted to runs/conv-review/holds/<heldId>.json
// with (where available) the full candidate snapshot, so `memory-approve` can
// resolve it later. Holds are never deleted; resolving sets status.
function persistHold({ runsDir = RUNS_DEFAULT, kind, id, held }) {
  try {
    const dir = join(runsDir, "conv-review", "holds");
    mkdirSync(dir, { recursive: true });
    const heldId = `${kind}-${String(id ?? "x").replace(/[^A-Za-z0-9._-]/g, "")}-${held.name}-${Date.now()}`;
    const rec = { schema: 1, heldId, kind, id, name: held.name, reason: held.reason ?? null, code: held.code ?? null, candidate: held.candidate ?? null, nearestExisting: held.nearestExisting ?? null, supersedesTargets: held.supersedesTargets ?? [], createdAt: new Date().toISOString(), status: "open" };
    writeFileSync(join(dir, `${heldId}.json`), JSON.stringify(rec, null, 2) + "\n");
    held.heldId = heldId;
    return heldId;
  } catch { return null; } // persistence is best-effort; the hold still surfaces
}

// Mechanical check only: a successful existing-concept search, shape preflight
// and broker dry-run label a proposal preflight-passed. They do NOT prove the
// claim matches local source; admission still requires trusted local evidence.
// Dependencies are injectable so fixture tests never contact a reviewer/gateway.
export async function verifyConceptProposalLocally(candidate, { searchExisting, preflightCandidate, dryRunCapture } = {}) {
  const fail = (reason, searchResult = null, dryRunResult = null) => {
    const hit = searchResult?.hits?.[0];
    const nearestExisting = hit ? { uri: cap(hit.uri, 500), headline: cap(hit.headline, 160) } : null;
    return { preflightPassed: false, status: "needs-source-verification", reason: cap(reason, 180), nearestExisting, searchResult, dryRunResult };
  };
  if (typeof searchExisting !== "function" || typeof preflightCandidate !== "function" || typeof dryRunCapture !== "function") {
    return fail("local verification dependencies unavailable");
  }
  let searchResult;
  try { searchResult = await searchExisting(candidate); }
  catch (e) { return fail(`existing-concept search failed: ${cap(String(e?.message ?? e), 120)}`); }
  if (!searchResult?.ok) return fail(`existing-concept search unavailable (${searchResult?.code ?? "unknown"})`, searchResult);
  let preflight;
  try { preflight = await preflightCandidate(candidate); }
  catch (e) { return fail(`concept-capture dry-run preflight failed: ${cap(String(e?.message ?? e), 120)}`, searchResult); }
  if (!preflight?.ok) return fail(`concept-capture preflight refused (${(preflight?.problems ?? []).join("; ") || "unknown"})`, searchResult);
  let dryRunResult;
  try { dryRunResult = await dryRunCapture(candidate); }
  catch (e) { return fail(`concept-capture dry-run failed: ${cap(String(e?.message ?? e), 120)}`, searchResult); }
  if (!dryRunResult?.ok) return fail(`concept-capture dry-run refused (${dryRunResult?.code ?? "unknown"}: ${dryRunResult?.detail ?? "no detail"})`, searchResult, dryRunResult);
  const hit = searchResult?.hits?.[0];
  const nearestExisting = hit ? { uri: cap(hit.uri, 500), headline: cap(hit.headline, 160) } : null;
  return { preflightPassed: true, status: "preflight-passed", reason: null, nearestExisting, searchResult,
    dryRunResult: { action: dryRunResult.action ?? null, conceptName: dryRunResult.conceptName ?? candidate.name } };
}

// ---- findings application (gated paths ONLY; F2 gate on durable stores) ----
export async function applyFindings({ findings, journalDir, runsDir = RUNS_DEFAULT, id, kind, dryRun = false, conceptsDir = "/opt/harness-unset/.repoql/concepts", tombstonesDir = TOMBSTONES_DIR_DEFAULT, localVerifier = verifyConceptProposalLocally, captureImpl = null } = {}) {
  const applied = { concepts: [], conceptHeld: [], mex: [], mexHeld: [], codeFixes: (findings.codeFixes ?? []).slice(0, 5).map((s) => cap(s, 300)), hubDocItems: [], repoqlImportItems: [], skipped: (findings.skip ?? []).length };
  const recs = (findings.recommendations ?? []).filter((r) => r && r.target && r.target !== "none");

  // repoql-concept -> external review is ADVISORY. Mechanical search/preflight/
  // dry-run can label a proposal preflight-passed, but it never proves the claim
  // against local source. With no trusted accepted-local-evidence contract on
  // this path, every external proposal is HELD for local/source verification.
  // Locally authored knowledge_capture / manual capture is untouched.
  const conceptProposals = recs.filter((r) => r.target === "repoql-concept");
  const conceptRecs = conceptProposals.filter((r) => r.invariant && r.invariant.length >= 10).slice(0, CONCEPT_MAX_ITEMS);
  applied.conceptVerification = { proposed: conceptProposals.length, preflightPassed: 0, needsSourceVerification: 0, results: [] };
  if (conceptProposals.length) {
    const { captureConcept, preflightConcept, findSemanticNearMatches } = await import("./concept-capture.mjs");
    const capture = captureImpl ?? captureConcept;
    const holdCandidate = (held) => { persistHold({ runsDir, kind, id, held }); applied.conceptHeld.push(held); };
    const holdForSource = (r, name, reason, { candidate = null, nearestExisting = null, status = "needs-source-verification", preflightPassed = false } = {}) => {
      const result = { name, status, nearestExisting, reason: cap(reason, 180) };
      r.localVerification = result;
      if (preflightPassed) applied.conceptVerification.preflightPassed++;
      applied.conceptVerification.needsSourceVerification++;
      applied.conceptVerification.results.push(result);
      holdCandidate({ name, reason: `needs-source-verification: ${result.reason}`, candidate, nearestExisting });
    };
    const slug = (s) => cap(String(s ?? "ConvReviewItem").replace(/[^a-zA-Z0-9 ]/g, " ").trim().split(/\s+/).slice(0, 4).map((w) => w[0].toUpperCase() + w.slice(1)).join("") || "ConvReviewItem", 60).replace(/[^A-Za-z0-9]/g, "");
    for (const r of conceptProposals) {
      if (conceptRecs.includes(r)) continue;
      holdForSource(r, slug(r.what || r.invariant || "ConceptProposal"), "proposal was not mechanically checked (invalid invariant or per-review proposal cap)");
    }
    for (const r of conceptRecs) {
      const name = slug(r.what || r.invariant);
      const gate = verifyRecommendation(r);
      if (!gate.verified) { holdForSource(r, name, `mechanical gate: ${gate.problems.join("; ")}`); continue; }
      const cand = {
        name,
        category: ["rule", "wisdom", "knowledge"].includes(r.category) ? r.category : "rule",
        invariant: cap(r.invariant, 300),
        tags: `conv-review,${kind}-${id}`.slice(0, 120),
        relevance: r.relevance,
        contextual: true,
        why: cap(`conversation review ${kind} ${id}: ${r.evidence || r.what}`, 400),
      };
      const local = await localVerifier(cand, {
        searchExisting: async (candidate) => findSemanticNearMatches({ meaning: `${candidate.name} ${candidate.invariant}`, conceptsDir, limit: 4 }),
        preflightCandidate: preflightConcept,
        dryRunCapture: (candidate) => capture(candidate, { dryRun: true, journalDir, conceptsDir, tombstonesDir }),
      });
      if (!local.preflightPassed) {
        holdForSource(r, name, local.reason ?? "mechanical preflight did not pass", { candidate: { ...cand }, nearestExisting: local.nearestExisting });
        continue;
      }
      holdForSource(r, name, "external proposal passed mechanical preflight but has no trusted accepted local-evidence reference; reviewer text is advisory and is not source proof", {
        candidate: { ...cand }, nearestExisting: local.nearestExisting, status: "preflight-passed", preflightPassed: true,
      });
    }
  }
  // mex -> F2 gate: VERIFIED facts/lessons only become `mex log` events;
  // unverified ones are HELD as labeled proposals in the findings file.
  const mexRecs = recs.filter((r) => r.target === "mex" && r.invariant).slice(0, MEX_MAX_ITEMS);
  for (const r of mexRecs) {
    const gate = verifyRecommendation(r);
    if (!gate.verified) { applied.mexHeld.push({ invariant: cap(r.invariant, 160), reason: `verification gate: ${gate.problems.join("; ")}` }); continue; }
    if (dryRun) { applied.mex.push({ ok: true, dryRun: true, msg: cap(r.invariant, 120) }); continue; }
    const msg = `CONVREVIEW (verified): ${cap(r.invariant, 220)} (src ${kind} ${id})`.replace(/'/g, "");
    try {
      // Ticket 164 Phase 5: verified invariants journal via fleet-log (the MEX
      // log event is retired; classification routing per plan §12.3).
      const rr = spawnSync("ssh", ["controller", `fleet-log --source agent --type NOTE --status current '${msg}' --ref 'conversation-review/${id}'`], { encoding: "utf8", timeout: 20_000 });
      applied.mex.push({ ok: rr.status === 0, msg: cap(msg, 120) });
    } catch { applied.mex.push({ ok: false, msg: cap(msg, 120) }); }
  }

  // repoql-import -> ALWAYS proposal-only (ticket 151, Sol-confirmed): an
  // import changes what corpus RepoQL searches, and scope/size/refresh/
  // confidentiality cannot be established from a review transcript. These
  // recommendations NEVER trigger rql/host-reset/reindex here; they are
  // surfaced as annotated proposal lines for the closing agent.
  const importRecs = recs.filter((r) => r.target === "repoql-import" && (r.what || r.invariant)).slice(0, CONCEPT_MAX_ITEMS);
  applied.repoqlImportItems = importRecs.map((r) => {
    const gate = verifyRecommendation(r);
    return `- [repoql-import, ${gate.verified ? "verified proposal" : "PROPOSAL — verify before applying"}] ${r.what} — ${r.invariant}${gate.verified ? "" : ` (gate: ${gate.problems.join("; ")})`}`;
  });

  // hub-doc + agentchat -> ALWAYS proposal-only (paste-ready block).
  const hubRecs = recs.filter((r) => r.target === "hub-doc" || r.target === "agentchat");
  if (hubRecs.length) {
    applied.hubDocItems = hubRecs.map((r) => {
      const gate = verifyRecommendation(r);
      return `- [${r.target}${gate.verified ? ", verified" : ", PROPOSAL — verify before applying"}] ${r.what} — ${r.invariant}${gate.verified ? "" : ` (gate: ${gate.problems.join("; ")})`}`;
    });
  }
  return applied;
}

export function findingsBlockMd({ id, kind, findings, applied }) {
  const L = [];
  L.push(`# Conversation review findings — ${kind} ${id}`);
  L.push(`Reviewed ${nowIso()} · question: "${REVIEW_QUESTION}"`);
  L.push("");
  L.push("## RECOMMENDATIONS (advisory; concept proposals never auto-capture — local source acceptance required)");
  for (const r of findings.recommendations) {
    const local = r.localVerification ? ` | local-status=${r.localVerification.status}${r.localVerification.nearestExisting?.uri ? ` | nearest-existing=${r.localVerification.nearestExisting.uri}` : ""}${r.localVerification.reason ? ` | local-reason=${r.localVerification.reason}` : ""}` : "";
    L.push(`- target=${r.target} | ${r.what} | ${r.invariant} | evidence: ${r.evidence || "(none given)"} | confidence=${r.confidence || "?"} | durability=${r.durability || "?"}${r.category ? ` | category=${r.category}` : ""}${local}`);
  }
  if (!findings.recommendations.length) L.push("- (none parsed)");
  L.push("");
  L.push("## CODE FIXES (proposals — standing rules need operator confirmation)");
  for (const f of findings.codeFixes) L.push(`- ${f}`);
  if (!findings.codeFixes.length) L.push("- (none)");
  L.push("");
  L.push("## SKIP");
  for (const s of findings.skip) L.push(`- ${s}`);
  if (!findings.skip.length) L.push("- (none)");
  L.push("");
  L.push("## APPLIED (after mechanical preflight; external concepts held)");
  if (applied.conceptVerification) L.push(`- concept admission: proposed=${applied.conceptVerification.proposed} preflight-passed=${applied.conceptVerification.preflightPassed} needs-source-verification=${applied.conceptVerification.needsSourceVerification}`);
  L.push(`- repoql-concepts captured: ${applied.concepts.length ? applied.concepts.map((c) => c.name).join(", ") : "(none)"}`);
  if (applied.conceptHeld.length) L.push(`- concept candidates HELD: ${applied.conceptHeld.map((c) => `${c.name} (${c.reason ?? c.code})${c.heldId ? ` [heldId: ${c.heldId}]` : ""}`).join("; ")}`);
  L.push(`- mex events logged: ${applied.mex.length}${applied.mexHeld.length ? ` · mex HELD: ${applied.mexHeld.map((m) => m.invariant).join("; ")}` : ""}`);
  L.push(`- hub-doc paste-ready items (proposal-only): ${applied.hubDocItems.length}`);
  if (applied.hubDocItems.length) L.push(...applied.hubDocItems.map((x) => `  ${x}`));
  L.push(`- repoql import proposals (proposal-only, never auto-executed): ${(applied.repoqlImportItems ?? []).length}`);
  if (applied.repoqlImportItems?.length) L.push(...applied.repoqlImportItems.map((x) => `  ${x}`));
  return L.join("\n") + "\n";
}

// ---- entry point: one review for a run or consult id. Fire-and-forget
// caller-side; internal failures are contained and reported in the result. ----
export async function runConversationReview({ runsDir = RUNS_DEFAULT, id, kind = "run", outDir = null, dryRun = false, notify = null, sshHost = process.env.ORCH_CONV_REVIEW_HOST ?? null } = {}) {
  const res = { id, kind, dispatched: false, ok: false, reason: null };
  try {
    if (String(process.env.ORCH_CONV_REVIEW ?? "").toLowerCase() === "off") { res.reason = "ORCH_CONV_REVIEW=off"; return res; }
    const budget = dispatchBudget(runsDir);
    if (!budget.allowed) { res.reason = `daily budget reached (${budget.used}/${budget.maxDay})`; return res; }

    // Build transcript.
    let transcriptMd, state = null;
    if (kind === "run") {
      const b = buildRunTranscript(runsDir, id);
      transcriptMd = b.body; state = b.state;
      if (!state) { res.reason = "no state.json (not a run dir)"; return res; }
      if (await isConfidential(state)) { res.reason = "confidential run — review suppressed (D13)"; return res; }
    } else if (kind === "consult") {
      const dir = join(runsDir, "consult", id);
      if (!existsSync(join(dir, "transcript.md"))) { res.reason = "no transcript.md in consult dir"; return res; }
      const b = buildConsultTranscript(dir, id);
      transcriptMd = b.body;
      if (b.meta && await isConfidential(b.meta)) { res.reason = "confidential consult — review suppressed (D13)"; return res; }
    } else if (kind === "adhoc") {
      try { transcriptMd = readFileSync(id, "utf8"); } catch (e) { res.reason = `unreadable transcript: ${cap(String(e?.message ?? e), 100)}`; return res; }
    } else { res.reason = `unknown kind ${kind}`; return res; }

    // F3 recursion guard: a transcript that IS a review request is never
    // re-reviewed (review-generated conversations are ineligible).
    if (transcriptMd.includes(RECURSION_MARKER) || transcriptMd.includes("origin=conversation-review")) {
      res.reason = "review-origin transcript — recursion guard (F3)"; return res;
    }
    // F4 idempotency: same kind+id+transcript hash => already reviewed.
    const receipt = reviewReceipt(runsDir, { kind, id, transcriptMd });
    if (receipt.existing && !dryRun) { res.reason = `already reviewed (transcript hash match: ${receipt.key})`; return res; }

    const reviewDir = outDir ?? (kind === "adhoc" ? join(runsDir, "conv-review") : join(runsDir, kind === "run" ? id : join("consult", id), "conv-review"));
    mkdirSync(reviewDir, { recursive: true });
    const stem = kind === "adhoc" ? basename(id).replace(/\.md$/, "") : id;
    const transcriptFile = join(reviewDir, `transcript-${stem}.md`);
    writeFileSync(transcriptFile, transcriptMd);

    // TRANSPORT sanity cap: full content, attached as a file. Over the cap
    // the review FAILS HONESTLY (no chunking, no elision — operator order).
    const transcriptBytes = Buffer.byteLength(transcriptMd, "utf8");
    if (transcriptBytes > MAX_TRANSCRIPT_BYTES) {
      res.reason = `transcript ${transcriptBytes}B > cap ${MAX_TRANSCRIPT_BYTES}B — review FAILS honestly (raise ORCH_CONV_REVIEW_MAX_BYTES; no chunking/elision by operator order)`;
      return res;
    }

    // Single short prompt; the transcript rides as a REAL .md attachment.
    const promptFile = join(reviewDir, `prompt-${stem}.md`);
    writeFileSync(promptFile, buildChunkPrompt({ id: stem, kind, isFinal: true, transcriptFile: `transcript-${stem}.md` }));

    if (dryRun) { res.ok = true; res.dryRun = true; res.files = { transcriptFile, promptFile }; res.reason = "dry-run (no dispatch)"; return res; }

    const gw = gatewaysHealthy();
    if (!gw.ok) { res.reason = `gateway probe failed (${gw.detail}) — not dispatched`; return res; }
    // Host choice: explicit pin (arg or ORCH_CONV_REVIEW_HOST) wins; else the
    // first healthy host from the probe (prefer controller, then webserver).
    const chosenHost = sshHost ?? gw.healthy[0] ?? null;

    // Dispatch with attachment + SOL_RAW. One-shot host failover (V3.3.35b
    // operator mandate mirrored at the review layer): a failed call on the
    // chosen host retries ONCE on the other healthy host — a caller pin is
    // honoured for the FIRST attempt only (pin = preference, not a cage).
    const altHost = gw.healthy.find((h) => h !== chosenHost) ?? null;
    const outFile = join(reviewDir, `review-${stem}.md`);
    let last = dispatchReview({ promptFile, outFile, id: stem, attachFile: transcriptFile, sshHost: chosenHost });
    if (!last.ok && altHost && altHost !== chosenHost) {
      try { if (notify) notify(`conversation review failed on ${chosenHost} — one-shot failover to ${altHost}`); } catch { /* fail-open */ }
      last = dispatchReview({ promptFile, outFile, id: stem, attachFile: transcriptFile, sshHost: altHost });
    }
    res.dispatched = true;
    if (!last.ok) {
      res.session = last.session;
      res.reason = `bridge rc=${last.rc} ${last.err ? `(${last.err})` : ""}`;
      return res;
    }
    res.session = last.session;

    const findings = parseFindings(last.body);
    const applied = await applyFindings({ findings, journalDir: reviewDir, runsDir, id: stem, kind });
    const block = findingsBlockMd({ id: stem, kind, findings, applied });
    const findingsFile = join(reviewDir, `findings-${stem}.md`);
    writeFileSync(findingsFile, block);
    recordReceipt(runsDir, receipt.key, { findingsFile, session: last.session, bytes: transcriptBytes, conceptVerification: applied.conceptVerification });
    recordDispatch(runsDir);
    res.ok = true; res.findings = findings; res.applied = applied; res.files = { transcriptFile, promptFile, reviewFile: outFile, findingsFile };
    try { if (notify) notify(`conversation review ready: ${findingsFile} (concepts ${applied.concepts.length}, mex ${applied.mex.length}, held ${applied.conceptHeld.length + applied.mexHeld.length})`); } catch { /* fail-open */ }
    return res;
  } catch (e) {
    res.reason = cap(String(e?.message ?? e), 200);
    return res;
  }
}
