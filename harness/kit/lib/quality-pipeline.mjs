// quality-pipeline.mjs — V3.3 §2.6 rewrite: FREE CodeRabbit-like quality lane.
//
// Flow: deterministic validation -> FREE reviewer (chain-walking, evidence
// inline) -> FREE fixer (STAGED round-trip: files pushed to the opencode
// context dir, edited by the write-capable quality-fixer agent, fetched back,
// applied + verified coordinator-side) -> revalidation (FINAL snapshot) ->
// independent FREE auditor (receives FINAL evidence, never the pre-fix packet)
// -> QUALITY_GATE.
//
// Free-only (§18): models come exclusively from FREE_MODEL_REGISTRY via
// callFreeRole/pickModel. Never codex/cursor/claude/sol/freebuff/openrouter.
// No approved free model => QUALITY_GATE=UNAVAILABLE. Never paid fallback.
//
// V3.3 §2.6 fixes baked in:
//  A  real ast-grep scan in deterministic validation (zeroIsClean semantics)
//  B  package-script argv spread fixed + unit-tested (selftest)
//  C  FULL evidence pack (changed files, tests, task, validation, AST) —
//     not 80-line excerpts; carried inline (bounded) so the model can judge
//  D  two-snapshot discipline: auditor sees FINAL diff + FINAL validation
//  E  fixer edits a staged copy via the proven bridge mechanism (live-proven
//     round-trip); coordinator applies + verifies — the mirror/staleness
//     problem and the remote-cwd lie are both gone
//  F  browserVerification mapped from a structured evidence file, all four
//     states; auditor never invents browser facts
//  G  failed reviewer ≠ no findings: chain walks; all-fail => UNAVAILABLE
//
// Bounds (§23): max 2 fix rounds, max 2 audit attempts. Validation failure
// after a fix = VALIDATION_FAILURE -> NEEDS_HUMAN_REVIEW, never provider
// failover. Truthful gates: PASS | UNAVAILABLE | NEEDS_HUMAN_REVIEW |
// SKIPPED_NO_CODE_CHANGE. Unavailable is never mapped to pass.
import { readFileSync, writeFileSync, mkdirSync, existsSync, statSync, readdirSync } from "node:fs";
import { join, dirname, relative } from "node:path";
import { spawnSync } from "node:child_process";
import { pickModel, recordModelOutcome } from "./free-model-registry.mjs";
import { recordInvocation, initTelemetry } from "./invocation-telemetry.mjs";
import { callFreeRole } from "./free-role-router.mjs";

// --- deterministic validation (§23): discover, don't invent -----------------
export function discoverChecks(targetDir) {
  const checks = [];
  const has = (p) => existsSync(join(targetDir, p));
  // Git whitespace hygiene — ONLY if the target actually is a git repo
  // (live lesson: /workspace is not; a non-repo git diff exits 129 with a
  // usage dump, which previously got recorded as a bogus FAIL check).
  const isGit = isGitRepo(targetDir);
  if (isGit) checks.push({ name: "git-diff-check", cmd: ["git", "-C", targetDir, "diff", "--check"], optional: true });
  // V3.3 §2.6A/§19: REAL ast-grep structural scan — only when the binary is
  // positively identified (ast-grep --version responds); /usr/bin/sg is
  // util-linux's setgroup and must never be trusted as ast-grep.
  const astGrepBin = findAstGrep();
  if (astGrepBin) {
    for (const rule of [
      { name: "ast-console-debug", rule: "console.debug($$$A)" },  // debug leftovers
      { name: "ast-empty-catch", rule: "try { $$$A } catch { }" }, // swallowed errors (needs full try node)
    ]) {
      checks.push({
        name: rule.name,
        // `run -p <pattern> .` = bare-pattern structural search; path is
        // positional, cwd=targetDir scopes it (§19: advisory, no nit explosion).
        // Exit code: 0 = matches found, 1 = zero matches (grep semantics).
        cmd: [astGrepBin, "run", "-p", rule.rule, "."],
        optional: true,   // advisory: findings recorded, never fail the gate alone
        zeroIsClean: true, // exit 1 = no findings = pass
      });
    }
  }
  if (has("package.json")) {
    const pkg = (() => { try { return JSON.parse(readFileSync(join(targetDir, "package.json"), "utf8")); } catch { return {}; } })();
    for (const [name, script] of [["typecheck", "typecheck"], ["lint", "lint"], ["test", "test"]]) {
      // V3.3 §2.6B: runWith returns ["run", script] — SPREAD it, otherwise the
      // argv becomes ["bun", ["run", script]] (nested array) and bun never runs.
      if (pkg.scripts?.[script]) checks.push({ name, cmd: ["bun", ...runWith(targetDir, script)], cwd: targetDir });
    }
  }
  return checks.filter(Boolean);
}
function runWith(targetDir, script) {
  return ["run", script]; // bun run <script> in cwd targetDir
}

export function isGitRepo(targetDir) {
  try {
    const r = spawnSync("git", ["-C", targetDir, "rev-parse", "--is-inside-work-tree"], { encoding: "utf8", timeout: 5000 });
    return r.status === 0 && /true/.test(r.stdout ?? "");
  } catch { return false; }
}

// Positively identify the real ast-grep (never util-linux sg).
export function findAstGrep() {
  for (const b of ["/usr/local/bin/ast-grep", "/usr/bin/ast-grep"]) {
    try {
      const v = spawnSync(b, ["--version"], { encoding: "utf8", timeout: 15_000 });
      if (v.status === 0 && /ast-grep \d/.test(v.stdout ?? "")) return b;
    } catch { /* keep looking */ }
  }
  return null;
}

// Run the discovered checks; capture concise output. Returns { ok, results }.
export function runValidation(targetDir) {
  const results = [];
  let ok = true;
  for (const c of discoverChecks(targetDir)) {
    const t0 = Date.now();
    try {
      const r = spawnSync(c.cmd[0], c.cmd.slice(1), { encoding: "utf8", timeout: 180_000, cwd: c.cwd ?? targetDir, maxBuffer: 8 * 1024 * 1024 });
      // zeroIsClean checks (ast-grep scans) exit 1 when there are no findings —
      // that is a pass, not a failure.
      const passed = c.zeroIsClean ? (r.status === 0 || r.status === 1) : r.status === 0;
      if (!passed && !c.optional) ok = false;
      results.push({ name: c.name, cmd: c.cmd.join(" "), exit: r.status, passed, durationMs: Date.now() - t0, output: `${r.stdout ?? ""}\n${r.stderr ?? ""}`.trim().slice(-1500) });
    } catch (e) {
      results.push({ name: c.name, cmd: c.cmd.join(" "), exit: -1, passed: false, durationMs: Date.now() - t0, output: String(e.message ?? e).slice(0, 300) });
      if (!c.optional) ok = false;
    }
  }
  return { ok, results };
}

// --- structured findings -----------------------------------------------------
export function parseFindings(text) {
  const findings = [];
  try {
    const m = String(text ?? "").match(/\{[\s\S]*\}/);
    if (m) {
      const j = JSON.parse(m[0]);
      if (Array.isArray(j.findings)) {
        for (const f of j.findings) {
          findings.push({
            issueId: f.issueId ?? `Q-${findings.length + 1}`,
            severity: ["CRITICAL", "HIGH", "MEDIUM", "LOW"].includes(f.severity) ? f.severity : "MEDIUM",
            confidence: Number(f.confidence ?? 50),
            file: String(f.file ?? "?").slice(0, 200),
            location: String(f.location ?? "").slice(0, 200),
            problem: String(f.problem ?? "").slice(0, 400),
            evidence: String(f.evidence ?? "").slice(0, 300),
            recommendedFix: String(f.recommendedFix ?? "").slice(0, 300),
          });
        }
      }
    }
  } catch { /* fallthrough */ }
  // Fallback: prose parse of "SEVERITY file: problem" lines (defensive).
  if (!findings.length) {
    for (const m of String(text ?? "").matchAll(/^\s*(CRITICAL|HIGH|MEDIUM|LOW)[:\s]+([^\s:][^\n]*)$/gmi)) {
      findings.push({ issueId: `Q-${findings.length + 1}`, severity: m[1].toUpperCase(), confidence: 60, file: m[2].split(":")[0]?.trim() ?? "?", location: "", problem: m[2].trim(), evidence: "", recommendedFix: "" });
    }
  }
  return findings.slice(0, 20);
}

const AUTO_FIX_THRESHOLD = { CRITICAL: 70, HIGH: 70, MEDIUM: 80, LOW: 999 }; // §19

function actionable(f) {
  return f.confidence >= (AUTO_FIX_THRESHOLD[f.severity] ?? 999);
}

// --- evidence pack (§2.6C): FULL bounded evidence, not 80-line excerpts ------
const FILE_CAP = 12_000;   // chars per file
const PACK_CAP = 60_000;   // chars for the whole pack

function listSourceFiles(targetDir, depth = 2) {
  const out = [];
  const walk = (dir, d) => {
    let entries = [];
    try { entries = readdirSync(dir, { withFileTypes: true }); } catch { return; }
    for (const e of entries) {
      if (e.name.startsWith(".") || e.name === "node_modules" || e.name === "runs" || e.name === "backups") continue;
      const p = join(dir, e.name);
      if (e.isDirectory()) { if (d > 0) walk(p, d - 1); continue; }
      if (/\.(mjs|js|ts|sh|md|json|ya?ml)$/.test(e.name)) {
        try { out.push({ rel: relative(targetDir, p), size: statSync(p).size, mtime: statSync(p).mtimeMs }); } catch { /* skip */ }
      }
    }
  };
  walk(targetDir, depth);
  return out.sort((a, b) => b.mtime - a.mtime); // most recently touched first
}

// Build the review/audit evidence pack. gitRepo => full diff + changed files;
// otherwise the most recently modified sources (bounded). `extraFiles` maps
// pack-name -> absolute local path (tests, task text, browser evidence...).
function buildEvidencePack(targetDir, { deterministicText, astText, task, extraFiles = {}, changedOnly = null } = {}) {
  const parts = [];
  let budget = PACK_CAP;
  const push = (title, text) => {
    if (!text || budget <= 0) return;
    const t = String(text).slice(0, Math.min(budget, FILE_CAP));
    parts.push(`===== ${title} =====\n${t}\n`);
    budget -= t.length;
  };
  if (task) push("ORIGINAL TASK", task);
  if (deterministicText) push("DETERMINISTIC VALIDATION", deterministicText);
  if (astText) push("AST-GREP SCAN", astText);
  for (const [name, p] of Object.entries(extraFiles)) {
    try { push(name, readFileSync(p, "utf8")); } catch { /* skip missing */ }
  }
  let files = [];
  if (changedOnly?.length) files = changedOnly;
  else if (isGitRepo(targetDir)) {
    try {
      const n = spawnSync("git", ["-C", targetDir, "diff", "HEAD", "--name-only"], { encoding: "utf8", timeout: 10_000 });
      files = (n.stdout ?? "").split("\n").filter(Boolean).map((rel) => ({ rel }));
    } catch { /* fallthrough */ }
  }
  if (!files.length) files = listSourceFiles(targetDir).slice(0, 8).map((f) => ({ rel: f.rel }));
  for (const f of files.slice(0, 10)) {
    try { push(`FILE: ${f.rel}`, readFileSync(join(targetDir, f.rel), "utf8")); } catch { /* skip */ }
  }
  return parts.join("\n");
}

// --- fixer: STAGED round-trip via the bridge (§2.6E, live-proven) ------------
// Stage findings + affected files -> quality-fixer agent edits the staged
// copies -> fetch back -> coordinator applies + verifies. No worktree, no
// container, no mirror dependency, no remote-cwd lie.
function runFixerRound({ fixerModel, sshHost, findings, targetDir, files, qDir, write, round }) {
  const stage = join(qDir, `fix-stage-${round}`);
  try { mkdirSync(stage, { recursive: true }); } catch { /* best-effort */ }
  const manifest = []; // staged-name -> real absolute path
  const pushEntries = [];
  const reqParts = [
    "You are the FREE code FIXER. The findings below were verified against the staged files in your working directory.",
    "For EACH finding: (1) verify it against the staged file content, (2) reject false findings, (3) make the smallest safe fix with your edit tool, (4) preserve behavior, (5) do NOT rewrite unrelated code or mass-format.",
    `Respond with ONE JSON object: {"fixed":[{"issueId":"...","what":"..."}],"rejected":[{"issueId":"...","why":"..."}]}. Your FINAL message must be exactly that JSON.`,
    "FINDINGS:",
    JSON.stringify(findings, null, 2),
  ];
  const nameFor = (rel) => rel.replace(/[\/\\]/g, "__");
  for (const rel of files) {
    const src = join(targetDir, rel);
    if (!existsSync(src)) continue;
    const staged = nameFor(rel);
    try { writeFileSync(join(stage, staged), readFileSync(src, "utf8")); } catch { continue; }
    manifest.push({ staged, rel, real: src });
    pushEntries.push(join(stage, staged));
  }
  const reqFile = join(stage, "REQUEST.md");
  writeFileSync(reqFile, reqParts.join("\n"));
  pushEntries.push(reqFile);
  const out = join(qDir, `fix-round-${round}-out.txt`);
  const editPairs = manifest.map((m) => `${m.staged}=${join(stage, `EDITED__${m.staged}`)}`).join(":");
  const env = {
    ...process.env,
    OPENCODE_SSH_HOST: sshHost,
    OPENCODE_MODEL: fixerModel,
    OPENCODE_AGENT: "quality-fixer", // write-capable agent (edit: allow, no bash)
    ORCH_CONTEXT_PUSH: pushEntries.join(":"),
    ORCH_CONTEXT_EDIT: editPairs,
    BRIDGE_TIMEOUT_SEC: "600",
  };
  const r = spawnSync("bash", [join(import.meta.dir ?? process.cwd(), "opencode-bridge.sh"), reqFile, out], { encoding: "utf8", env, timeout: 660_000, maxBuffer: 8 * 1024 * 1024 });
  const ok = r.status === 0;
  // Fetch-backs landed in stage/EDITED__<name> — apply coordinator-side.
  const applied = [], failed = [];
  for (const m of manifest) {
    const edited = join(stage, `EDITED__${m.staged}`);
    if (!existsSync(edited)) continue;
    try {
      const before = readFileSync(m.real, "utf8");
      const after = readFileSync(edited, "utf8");
      if (before === after) continue;
      writeFileSync(m.real, after);
      applied.push({ rel: m.rel, bytes: after.length - before.length });
    } catch (e) {
      failed.push({ rel: m.rel, error: String(e.message ?? e).slice(0, 120) });
    }
  }
  let parsed = { fixed: [], rejected: [] };
  try { parsed = JSON.parse((readFileSync(out, "utf8") ?? "").match(/\{[\s\S]*\}/)?.[0] ?? "{}"); } catch { /* parser stays defensive */ }
  return { ok, applied, failed, parsed };
}

// --- browser evidence (§2.6F): structured file, all four states --------------
function mapBrowserEvidence(browserEvidence) {
  // Expected shape: { required, attempted, result, evidence }. Missing file =
  // not required. attempted-with-no-result or failed attempt => honest states.
  if (!browserEvidence || !existsSync(browserEvidence)) return "NOT_REQUIRED";
  try {
    const j = JSON.parse(readFileSync(browserEvidence, "utf8"));
    if (!j.required) return "NOT_REQUIRED";
    if (j.result === "PASS") return "PASS";
    if (j.result === "FAIL") return "FAIL";
    return "UNAVAILABLE"; // required but not proven (attempted or not)
  } catch { return "UNAVAILABLE"; }
}

// --- the pipeline -------------------------------------------------------------
export async function runQualityPipeline({ runsDir, runId = null, targetDir, noFix = false, sshHost = "controller", maxFixRounds = 2, maxAuditAttempts = 2, task = null, browserEvidence = null }) {
  const t_wall = Date.now();
  initTelemetry(runsDir); // V3.3 §2.1: bind ledger to the caller's runsDir
  const qDir = runId ? join(runsDir, runId, "quality") : join(runsDir, "quality-manual");
  try { mkdirSync(qDir, { recursive: true }); } catch { /* best-effort */ }
  const write = (name, data) => { try { writeFileSync(join(qDir, name), typeof data === "string" ? data : JSON.stringify(data, null, 2)); } catch { /* best-effort */ } };

  // §22 independence: auditor must differ from reviewer+fixer where possible.
  const reg = await import("./free-model-registry.mjs");
  const reviewerPick = pickModel("qualityReview", runsDir);
  const fixerPick = pickModel("qualityFix", runsDir);
  const usedIds = [reviewerPick?.model, fixerPick?.model].filter(Boolean);
  const auditExclude = reg.FREE_MODEL_REGISTRY.qualityAudit.filter((m) => usedIds.includes(m));

  if (!reviewerPick) {
    write("summary.json", { gate: "UNAVAILABLE", reason: "no approved free reviewer model", paid: 0, freebucks: 0 });
    return { gate: "UNAVAILABLE", findings: [], fixed: null, rejected: null, reason: "no approved free reviewer model" };
  }

  // Deterministic validation BEFORE review (§23).
  const before = runValidation(targetDir);
  const fmtVal = (v) => v.results.map((r) => `${r.passed ? "PASS" : "FAIL"} ${r.name} (${r.durationMs}ms)\n${r.output}`).join("\n\n");
  write("deterministic-before.txt", fmtVal(before));
  if (!before.ok) {
    write("summary.json", { gate: "NEEDS_HUMAN_REVIEW", reason: "deterministic validation fails BEFORE review — fix tests first", paid: 0, freebucks: 0 });
    return { gate: "NEEDS_HUMAN_REVIEW", findings: [], fixed: null, rejected: null, reason: "pre-review validation failed" };
  }
  const astGrep = findAstGrep();
  const astScan = astGrep ? spawnSync(astGrep, ["run", "-p", "console.debug($$$A)", "."], { encoding: "utf8", cwd: targetDir, timeout: 30_000 }) : null;
  const astText = astGrep ? `${astScan?.stdout ?? ""}(exit ${astScan?.status}: ${astScan?.status === 0 ? "findings above" : "clean"})` : "ast-grep not installed";

  // §24: no code change under review => nothing for quality to judge.
  const packCandidates = listSourceFiles(targetDir, 1);
  if (!isGitRepo(targetDir) && !packCandidates.length) {
    write("summary.json", { gate: "SKIPPED_NO_CODE_CHANGE", paid: 0, freebucks: 0 });
    return { gate: "SKIPPED_NO_CODE_CHANGE", findings: [], fixed: null, rejected: null };
  }
  const detText = before.results.map((r) => `${r.passed ? "PASS" : "FAIL"} ${r.name} (${r.durationMs}ms)`).join("\n");
  const browserState = mapBrowserEvidence(browserEvidence);
  const browserEvidenceText = browserEvidence && existsSync(browserEvidence) ? readFileSync(browserEvidence, "utf8").slice(0, 2000) : null;

  // --- reviewer (read-only chain; §2.6G: failure ≠ empty findings) ----------
  const reviewPack = buildEvidencePack(targetDir, { deterministicText: detText, astText, task, extraFiles: browserEvidenceText ? { "BROWSER-EVIDENCE.json": browserEvidence } : {} });
  const reviewPrompt = [
    "You are a FREE code-quality REVIEWER (read-only). Review the change set described in the EVIDENCE PACK for: logic defects, unmet requirements, regressions, security problems, input validation, state/concurrency bugs, resource leaks, error handling, edge cases, incorrect API usage, compatibility, performance, unnecessary complexity, meaningful duplication, dead task-introduced code, missing/weak tests.",
    "The evidence pack contains the full current content of the relevant files — judge from it. Do NOT run bash; do NOT read other files.",
    `Browser verification state (authoritative, do not re-decide): BROWSER_VERIFICATION=${browserState}.`,
    "Respond with ONE JSON object: {\"findings\":[{\"issueId\":\"Q-1\",\"severity\":\"CRITICAL|HIGH|MEDIUM|LOW\",\"confidence\":0-100,\"file\":\"...\",\"location\":\"...\",\"problem\":\"...\",\"evidence\":\"...\",\"recommendedFix\":\"...\"}]}. No findings => {\"findings\":[]}. Your FINAL line must be the JSON object.",
    "EVIDENCE PACK:",
    reviewPack,
  ].join("\n");
  const rev = callFreeRole("qualityReview", reviewPrompt, {
    runsDir, runId, component: "quality", role: "QUALITY_REVIEW", purpose: "review", sshHost, timeoutSec: 300, readOnly: true,
  });
  // §2.6G: a failed reviewer is NOT "no findings" — walk the chain (done) and
  // if EVERY reviewer failed, the gate is UNAVAILABLE, never a fake pass.
  if (!rev.ok) {
    write("review.json", { ok: false, attempts: rev.attempts.map((a) => ({ model: a.model, failureClass: a.failureClass })), findings: null });
    write("summary.json", { gate: "UNAVAILABLE", reason: `free reviewer chain failed (${rev.failureClass})`, paid: 0, freebucks: 0 });
    return { gate: "UNAVAILABLE", findings: [], fixed: null, rejected: null, reason: "reviewer chain failed" };
  }
  const findings = parseFindings(rev.output);
  write("review.json", { model: rev.model, ok: true, findings });

  let fixed = 0, rejected = 0, rounds = 0;

  // --- fixer (STAGED round-trip; §2.6E) ---
  let finalVal = before;
  let fixerModelUsed = null;
  if (!noFix && findings.length && fixerPick && findings.some(actionable)) {
    fixerModelUsed = fixerPick.model;
    const autoFixable = findings.filter(actionable);
    const affectedFiles = [...new Set(autoFixable.map((f) => f.file).filter((f) => f && f !== "?"))];
    const stageFiles = affectedFiles.length ? affectedFiles : listSourceFiles(targetDir, 1).slice(0, 3).map((f) => f.rel);
    for (let round = 1; round <= maxFixRounds; round++) {
      rounds = round;
      const fr = runFixerRound({ fixerModel: fixerPick.model, sshHost, findings: autoFixable, targetDir, files: stageFiles, qDir, write, round });
      recordModelOutcome(fixerPick.model, runsDir, { success: fr.ok, durationMs: null });
      try { recordInvocation({ runId, component: "quality", role: "QUALITY_FIX", purpose: `fix-round-${round}`, engine: "opencode", model: fixerPick.model, billingClass: "free", success: fr.ok, failureClass: fr.ok ? "NONE" : "MODEL_FAILURE", rc: fr.ok ? 0 : 1, paid: false }); } catch { /* */ }
      fixed += (fr.parsed.fixed ?? []).length + fr.applied.length;
      rejected += (fr.parsed.rejected ?? []).length;
      write(`fix-round-${round}.json`, { model: fixerPick.model, ok: fr.ok, applied: fr.applied, failed: fr.failed, ...fr.parsed });
      // deterministic revalidation after EVERY fix round (§23)
      finalVal = runValidation(targetDir);
      write("deterministic-after.txt", fmtVal(finalVal));
      if (!finalVal.ok) {
        write("summary.json", { gate: "NEEDS_HUMAN_REVIEW", reason: `fix round ${round} regressed deterministic validation (VALIDATION_FAILURE)`, fixed, rejected, rounds: round, paid: 0, freebucks: 0 });
        return { gate: "NEEDS_HUMAN_REVIEW", findings, fixed, rejected, reason: "fix regressed validation" };
      }
      break; // one pass per invocation; re-review happens on the next cycle
    }
  }

  // --- auditor (read-only, independent §22, FINAL snapshot §2.6D) -----------
  // §2.6D: the auditor receives the FINAL state — re-run validation + AST,
  // rebuild the pack from the CURRENT tree — never the pre-fix packet.
  const finalDet = finalVal.results.map((r) => `${r.passed ? "PASS" : "FAIL"} ${r.name} (${r.durationMs}ms)`).join("\n");
  const finalAst = astGrep ? spawnSync(astGrep, ["run", "-p", "console.debug($$$A)", "."], { encoding: "utf8", cwd: targetDir, timeout: 30_000 }) : null;
  const finalAstText = astGrep ? `${finalAst?.stdout ?? ""}(exit ${finalAst?.status}: ${finalAst?.status === 0 ? "findings above" : "clean"})` : "ast-grep not installed";
  const finalPack = buildEvidencePack(targetDir, { deterministicText: finalDet, astText: finalAstText, task, extraFiles: browserEvidenceText ? { "BROWSER-EVIDENCE.json": browserEvidence } : {} });
  let gate = "NEEDS_HUMAN_REVIEW";
  let audit = null;
  if (browserState === "FAIL" || browserState === "UNAVAILABLE") {
    // §2.6F: structured browser evidence is authoritative — required-but-
    // unproven (UNAVAILABLE) or failed (FAIL) can never pass the gate.
    gate = "NEEDS_HUMAN_REVIEW";
    audit = { model: null, ok: false, note: `browser verification ${browserState} (structured evidence)` };
    write("audit-skip-browser.json", audit);
  } else {
    const auditPrompt = [
      "You are an independent FREE code AUDITOR (read-only). You did NOT review or fix this code.",
      "Decide whether the described FINAL change set is acceptable: correct, tested, no regressions, no security defects.",
      "The evidence pack contains the full FINAL content of the relevant files plus FINAL deterministic validation — judge from it. Do NOT run bash; do NOT read other files.",
      `Browser verification was decided deterministically from structured evidence: BROWSER_VERIFICATION=${browserState}. Do not invent a browser verdict.`,
      "Respond with EXACTLY one line starting QUALITY_AUDIT=PASS or QUALITY_AUDIT=FAIL, then optional short findings.",
      "FINAL EVIDENCE PACK:",
      finalPack,
    ].join("\n");
    const aud = callFreeRole("qualityAudit", auditPrompt, {
      runsDir, runId, component: "quality", role: "QUALITY_AUDIT", purpose: "audit", sshHost, timeoutSec: 300, readOnly: true,
      exclude: auditExclude, maxAuditAttempts,
    });
    const auditAttempts = aud.attempts.filter((a) => !a.skipped);
    audit = { model: aud.model ?? null, ok: aud.ok, attempts: auditAttempts.map((a) => ({ model: a.model, failureClass: a.failureClass })), output: (aud.output ?? "").slice(0, 4000) };
    write("audit.json", audit);
    if (aud.ok && /QUALITY_AUDIT=PASS/i.test(aud.output)) gate = "PASS";
    else if (!aud.ok) gate = "UNAVAILABLE"; // every independent auditor failed — never fake it
    else gate = "NEEDS_HUMAN_REVIEW";
  }

  const summary = {
    gate, browserVerification: browserState, reviewer: rev.model, fixer: fixerModelUsed, auditor: audit?.model ?? null,
    findings: findings.length, fixed, rejected, rounds,
    finalValidation: finalVal.ok ? "PASS" : "FAIL",
    paid: 0, freebucks: 0, durationMs: Date.now() - t_wall,
  };
  write("summary.json", summary);
  return { gate, findings, fixed, rejected, rounds, summary };
}
