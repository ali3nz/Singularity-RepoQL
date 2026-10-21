#!/usr/bin/env node
// doc-policy.mjs — the shared documentation policy for BOTH Singularity clients.
//
// OpenChamber (runbook-nudge + AGENTS.md) and Claude Code (doc-hook.mjs + this
// CLI) follow the SAME rules through these functions and this one deterministic
// command; there is no second policy text and no agent-only judgment.
//
//   node scripts/doc-policy.mjs assess  --session S --files a.py b.py \
//        (--doc-status DOC_UPDATED --docs docs/runbook.md | --doc-status DOC_NOT_REQUIRED --reason "...") \
//        [--capture-status CAPTURED|NO_LESSON|DEFERRED]
//   node scripts/doc-policy.mjs check   --session S
//   node scripts/doc-policy.mjs report  --session S
//   node scripts/doc-policy.mjs discover --dir DIR [--session S]
//
// A material task closes ONLY when its recorded assessment has:
//   DOC_UPDATED        -> each documented file is independently verified against
//                         the INGESTION LEDGER via scripts/memory-doc-ingest.py
//                         verify (caller-claimed --ingest-status text is never
//                         accepted as proof) AND knowledge capture reported
//   DOC_NOT_REQUIRED   -> non-material change set + explicit reason
//   DOC_BLOCKED        -> never closes the task (the reason is surfaced instead)
//
// Exit codes: check 0 = closure complete, 1 = incomplete (findings printed),
// 2 = usage error. No secret is ever read or printed.
import { createHash } from "node:crypto";
import { execFile } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync, renameSync, statSync, readdirSync } from "node:fs";
import { join, resolve, isAbsolute, extname, dirname, relative as relPosix } from "node:path";
import { fileURLToPath } from "node:url";

const sha8 = (s) => createHash("sha256").update(String(s)).digest("hex").slice(0, 8);
const clip = (s, n) => { s = String(s ?? ""); return s.length > n ? s.slice(0, n) : s; };

// This module's directory = <product>/scripts; the product root is its parent.
export const PRODUCT_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
export const DOC_INGEST_SCRIPT = join(PRODUCT_ROOT, "scripts", "memory-doc-ingest.py");

// ── classification (shared with both clients) ────────────────────────────────
// A change set is MATERIAL when any file can change behaviour, operations,
// security of installation, or integration. Formatting/lock/generated/docs-only
// adjustments are NON-MATERIAL by default.
export const SKIP_EXTS = new Set([".md", ".mdx", ".txt", ".rst", ".log", ".lock", ".sum", ".png", ".jpg", ".jpeg", ".gif", ".svg", ".ico", ".woff", ".woff2"]);
export const SKIP_FILES = new Set(["package-lock.json", "yarn.lock", "pnpm-lock.yaml", "SHA256SUMS", "MANIFEST.json"]);
export const SKIP_DIR_PARTS = new Set(["__pycache__", ".git", "node_modules", "vendor", "dist", "build", "gen", "generated", "snapshots", "site-packages", ".venv", "venv", ".tox", "coverage", ".next"]);

export function classifyFiles(files) {
  const material = [];
  const skipped = [];
  for (const f of files) {
    const base = f.split("/").pop() || "";
    const parts = f.split(/[\\/]/);
    const ext = extname(base).toLowerCase();
    const skip =
      SKIP_FILES.has(base) ||
      SKIP_EXTS.has(ext) ||
      parts.some((p) => SKIP_DIR_PARTS.has(p)) ||
      /(^|[\\/])data[\\/](doc-policy|doc-index)[\\/]/.test(f) ||
      base.includes(".min.") ||
      /\.bak|~$|-backup\.|\.tmp$/i.test(base);
    (skip ? skipped : material).push(f);
  }
  return { material, skipped };
}

// A file set that ONLY touches documentation cannot itself demand new docs.
export function isDocsOnlyChange(files) {
  return files.every((f) => SKIP_EXTS.has(extname(f).toLowerCase()));
}

// ── ingestion evidence: the LEDGER is the source of verification ─────────────
// A caller-supplied --ingest-status string is treated as a CLAIM, never as
// proof. `verify` re-derives every fact: record exists for the workspace/scope,
// source exists inside its authorised root, current hash == active revision,
// revision verified, chunks accounted for, no newer unresolved revision.
const DEFAULT_EXEC = (file, args, opts, cb) => execFile(file, args, { encoding: "utf8", ...(opts || {}) }, cb);

function runPython(args, cwd, execImpl, timeoutMs = 60_000) {
  const impl = execImpl || DEFAULT_EXEC;
  return new Promise((done) => {
    impl("python3", args, { cwd, timeout: timeoutMs, windowsHide: true }, (err, stdout, stderr) => {
      done({ err, stdout: String(stdout || ""), stderr: String(stderr || "") });
    });
  });
}

export async function collectEvidence(docs, projectRoot = process.env.SINGULARITY_DOC_EVIDENCE_ROOT || process.cwd(), execImpl = null) {
  const evidence = {};
  const root = resolve(projectRoot);
  for (const d of docs || []) {
    if (!DOC_INGEST_SCRIPT) { evidence[d] = { status: "DOC_INGEST_NOT_VERIFIED", reason: "ingestion verifier not found" }; continue; }
    const r = await runPython([DOC_INGEST_SCRIPT, "verify", "--file", d, "--root", root], root, execImpl);
    try {
      evidence[d] = JSON.parse(r.stdout || "{}");
      if (!evidence[d] || typeof evidence[d].status !== "string") {
        evidence[d] = { status: "DOC_INGEST_NOT_VERIFIED", reason: "verification output missing/unparsable" };
      }
    } catch {
      evidence[d] = { status: "DOC_INGEST_NOT_VERIFIED",
        reason: `verification unavailable: ${clip((r.err && r.err.message) || r.stderr, 120)}` };
    }
  }
  return evidence;
}

// Findings that always block closure, independent of the claimed status.
export function evaluateAssessment(assess, opts = {}) {
  const findings = [];
  const files = assess.files || [];
  const { material } = classifyFiles(files);
  const status = assess.docStatus;

  if (!status) findings.push("FINDING: no documentation assessment recorded — run scripts/doc-policy.mjs assess (DOC_UPDATED | DOC_NOT_REQUIRED <reason> | DOC_BLOCKED).");
  if (status === "DOC_BLOCKED") findings.push(`FINDING: documentation was required but BLOCKED — this does not close the task. Reason: ${assess.docReason || "unspecified"}. Resolve the blocker or complete the documentation, then re-report.`);

  if (status === "DOC_NOT_REQUIRED") {
    if (!assess.docReason || String(assess.docReason).trim().length < 8) {
      findings.push("FINDING: DOC_NOT_REQUIRED needs a concise, specific reason (>= 8 chars).");
    }
    if (material.length && !(assess.skipJustification || "")) {
      findings.push(`FINDING: DOC_NOT_REQUIRED refused — ${material.length} material file(s) changed (${material.slice(0, 5).join(", ")}${material.length > 5 ? ", ..." : ""}). Update docs or explain the skip in a concrete justification.`);
    }
  }

  if (status === "DOC_UPDATED") {
    const docs = assess.docs || [];
    if (!docs.length) findings.push("FINDING: DOC_UPDATED requires at least one created/updated documentation file (--docs).");
    const baseDir = assess.projectRoot || process.cwd();
    for (const d of docs) {
      const onDisk = isAbsolute(d) ? d : join(baseDir, d);
      if (!existsSync(onDisk)) findings.push(`FINDING: documentation file missing on disk: ${d}`);
    }
    // Ledger evidence is the source of truth — claimed status text is not.
    const evidence = opts.evidence || null;
    if (!evidence) {
      findings.push("FINDING: ingestion evidence was not checked — completion requires the ledger verification (scripts/memory-doc-ingest.py verify) for each documented file.");
    } else {
      for (const d of docs) {
        const v = evidence[d];
        if (!v) findings.push(`FINDING: no ingestion evidence captured for documented file: ${d}`);
        else if (v.status !== "DOC_INGEST_VERIFIED") {
          findings.push(`FINDING: documented ingestion NOT verified for ${d}: ${v.status}${v.reason ? ` (${v.reason})` : ""}`);
        }
      }
    }
    // A caller-claimed status still must not contradict (or fake) the evidence.
    const claimed = assess.ingestion || [];
    const allVerified = docs.length > 0 && evidence && docs.every((d) => evidence[d]?.status === "DOC_INGEST_VERIFIED");
    for (const s of claimed) {
      if (s !== "DOC_INGEST_INDEXED" && s !== "DOC_INGEST_UNCHANGED") {
        findings.push(allVerified
          ? `FINDING: claimed ingestion status "${s}" contradicts the verified ledger evidence — correct the assessment.`
          : `FINDING: documentation ingestion is claimed as ${s} — pending/failed/blocked does not close the task; retry (scripts/memory-doc-ingest.py retry --file <doc> --root <root>).`);
      }
    }
    if (docs.length && claimed.length && docs.length !== claimed.length) {
      findings.push(`FINDING: ${docs.length} docs listed but ${claimed.length} ingestion claims recorded — every documented file needs verified ingestion.`);
    }
  }

  if (!findings.length && !["DOC_UPDATED", "DOC_NOT_REQUIRED"].includes(status)) {
    findings.push(`FINDING: unknown documentation status ${status}`);
  }
  const captureOk = ["CAPTURED", "NO_LESSON", "DEFERRED"].includes(assess.captureStatus);
  if (!captureOk) {      findings.push("FINDING: knowledge-capture status unreported — state captureStatus: CAPTURED | NO_LESSON | DEFERRED (per docs/memory-capture-promotion.md).");
  }
  return findings;
}

export { sha8 };

// ── state: completed assessments live under data/doc-policy/ ─────────────────
export function stateDir(root = process.env.SINGULARITY_REPO_ROOT || process.cwd()) {
  return join(resolve(root), "data", "doc-policy");
}

export function sanitizeSession(session) {
  return String(session || "").replace(/[^A-Za-z0-9_-]/g, "_").slice(0, 64) || "session";
}

export function assessmentPath(session, root) {
  return join(stateDir(root), `${sanitizeSession(session)}.json`);
}

export function baselinePath(session, root) {
  return join(stateDir(root), `baseline-${sanitizeSession(session)}.json`);
}

export function writeAssessmentAtomic(session, root, record) {
  const dir = stateDir(root);
  mkdirSync(dir, { recursive: true });
  const path = assessmentPath(session, root);
  const tmp = `${path}.tmp-${Date.now()}`;
  writeFileSync(tmp, JSON.stringify(record, null, 2) + "\n");
  renameSync(tmp, path);
  return path;
}

export function writeBaselineAtomic(session, root, record) {
  const dir = stateDir(root);
  mkdirSync(dir, { recursive: true });
  const path = baselinePath(session, root);
  const tmp = `${path}.tmp-${Date.now()}`;
  writeFileSync(tmp, JSON.stringify(record) + "\n");
  renameSync(tmp, path);
  return path;
}

export function loadAssessment(session, root) {
  const p = assessmentPath(session, root);
  return existsSync(p) ? JSON.parse(readFileSync(p, "utf8")) : null;
}

export function loadBaseline(session, root) {
  const p = baselinePath(session, root);
  return existsSync(p) ? JSON.parse(readFileSync(p, "utf8")) : null;
}

// ── automatic document discovery (shared by both clients) ────────────────────
// Event-driven: a per-session baseline census of eligible documentation is
// diffed against the present state at task completion; new/changed eligible
// Markdown inside authorised roots is ingested (content-hash dedup makes this
// safe and cheap). Tracked AND newly created untracked files are covered; a
// baseline at session start means pre-existing dirty files are not attributed
// to this task. No background polling service — nothing scans while idle.
export const DOC_EXTS = new Set([".md", ".markdown", ".mdx"]);
const DOC_NAME_REJECT = /(^|\/)(\.env[^/]*|id_rsa[^/]*|secrets?[^/]*|credentials.*|.*\.(pem|key))$/i;
const MAX_DISCOVERY_FILES = 600;
const MAX_DISCOVERY_DEPTH = 8;
export const MAX_DOC_INGEST_PER_PASS = 8;

export function docRootsFor(dir, env = process.env) {
  const raw = env && env.SINGULARITY_DOC_ROOTS;
  if (raw && String(raw).trim()) {
    return String(raw).split(":").map((s) => resolve(s.trim(), dir))
      .filter((r) => { try { return statSync(r).isDirectory(); } catch { return false; } });
  }
  return [resolve(dir)];
}

export function isEligibleDocPath(absPath, rootPath, { maxSizeBytes = 200 * 1024 } = {}) {
  const base = (absPath.split("/").pop() || "");
  if (!DOC_EXTS.has(extname(base).toLowerCase())) return false;
  if (DOC_NAME_REJECT.test(absPath)) return false;
  const parts = absPath.split("/");
  if (parts.some((p) => SKIP_DIR_PARTS.has(p))) return false;
  try {
    const st = statSync(absPath);
    if (!st.isFile() || st.size === 0 || st.size > maxSizeBytes) return false;
    // containment: the scanned file must resolve inside its authorised root
    const rp = resolve(absPath);
    if (!rp.startsWith(resolve(rootPath))) return false;
    return true;
  } catch {
    return false;
  }
}

export function scanDocCensus(dir, env = process.env) {
  const roots = docRootsFor(dir, env);
  const census = new Map();
  for (const rootPath of roots) {
    let count = 0;
    const walk = (path, depth) => {
      if (depth > MAX_DISCOVERY_DEPTH || count >= MAX_DISCOVERY_FILES) return;
      let entries;
      try { entries = readdirSync(path, { withFileTypes: true }); } catch { return; }
      for (const e of entries) {
        if (count >= MAX_DISCOVERY_FILES) return;
        const full = join(path, e.name);
        if (e.isDirectory()) {
          if (!e.name.startsWith(".") || e.name === ".github") walk(full, depth + 1);
          else continue;
          continue;
        }
        if (!e.isFile()) continue;
        if (!isEligibleDocPath(full, rootPath)) continue;
        try {
          const st = statSync(full);
          census.set(resolve(full), { rel: relposixSafe(rootPath, full), root: resolve(rootPath), size: st.size, mtimeMs: Math.floor(st.mtimeMs) });
          count += 1;
        } catch { /* vanished mid-scan */ }
      }
    };
    walk(rootPath, 0);
  }
  return census;
}

function relposixSafe(root, full) {
  const r = relPosix(resolve(root), resolve(full)).split("\\").join("/");
  return r || full.split("/").pop();
}

function runGitStatus(dir, execImpl) {
  const impl = execImpl || DEFAULT_EXEC;
  return new Promise((done) => {
    impl("git", ["-C", dir, "status", "--porcelain", "-z", "--untracked-files=all"],
      { encoding: "utf8", timeout: 5000, windowsHide: true }, (err, stdout) => {
        if (err) return done(null); // not a repo, no git, or timeout: unobservable
        const entries = String(stdout || "").split("\0").filter(Boolean).map((line) => {
          const rest = line.slice(3); // 2 status chars + space
          return rest.split(" -> ").pop().trim();
        }).filter(Boolean);
        done(entries);
      });
  });
}

// One bounded observation: present census + new/unseen dirty files vs baseline.
export async function observeWorkspace(dir, session, { execImpl = null, env = process.env } = {}) {
  const root = resolve(dir);
  const censusFiles = scanDocCensus(root, env);
  const dirty = await runGitStatus(root, execImpl);
  const baselineRec = loadBaseline(session, root) || null;
  const baselineFiles = baselineRec?.files || null;
  const baselineDirty = baselineRec?.dirty || null;
  const changedDocs = [];
  if (baselineFiles) {
    for (const [p, meta] of censusFiles) {
      const prev = baselineFiles[p];
      if (!prev || prev.size !== meta.size || Math.abs(prev.mtimeMs - meta.mtimeMs) > 1) {
        changedDocs.push({ path: p, root: meta.root, rel: meta.rel });
      }
    }
  }
  let newDirty = null; // null = unobservable (no git)
  if (dirty) {
    const baseSet = new Set(baselineDirty || []);
    newDirty = dirty.filter((f) => !baseSet.has(f));
  }
  return { root, censusFiles, baselineRec, changedDocs, dirty, newDirty, observable: dirty !== null };
}

export async function saveSessionBaseline(session, dir, { execImpl = null, env = process.env } = {}) {
  const root = resolve(dir);
  const censusFiles = scanDocCensus(root, env);
  const dirty = await runGitStatus(root, execImpl) || [];
  const files = {};
  for (const [p, meta] of censusFiles) files[p] = { size: meta.size, mtimeMs: meta.mtimeMs, rel: meta.rel, root: meta.root };
  return writeBaselineAtomic(session, root, { created: new Date().toISOString(), files, dirty });
}

export async function ingestDocChange(absDoc, docRoot, session, { execImpl = null, env = process.env } = {}) {
  const workspaceRoot = resolve(env?.SINGULARITY_REPO_ROOT || process.cwd());
  const cwd = workspaceRoot;
  const args = [DOC_INGEST_SCRIPT, "ingest", "--file", resolve(absDoc), "--root", resolve(docRoot), "--session", session || "auto-discovery"];
  const r = await runPython(args, cwd, execImpl, 120_000);
  try { return JSON.parse(r.stdout || "{}"); }
  catch {
    return { status: "DOC_INGEST_FAILED", reason: `ingestion unavailable: ${clip((r.err && r.err.message) || r.stderr, 140)}` };
  }
}

const INGEST_RESOLVED_STATES = new Set(["DOC_INGEST_INDEXED", "DOC_INGEST_UNCHANGED"]);

// The shared auto-ingestion pass. Ingests only NEW/CHANGED eligible docs
// (content-hash dedup inside memory-doc-ingest renders repeats as
// DOC_INGEST_UNCHANGED with no MemoryCore write).
export async function autoIngestChangedDocs(dir, session, { execImpl = null, env = process.env } = {}) {
  const obs = await observeWorkspace(dir, session, { execImpl, env });
  const results = [];
  const targets = obs.changedDocs.slice(0, MAX_DOC_INGEST_PER_PASS);
  for (const doc of targets) {
    const res = await ingestDocChange(doc.path, doc.root, session, { execImpl, env });
    results.push({ file: doc.rel, ...res });
  }
  // Refresh the baseline ONLY once every change this round is resolved.
  // A PENDING/FAILED doc keeps its place vs the baseline so the next check
  // re-discovers it (the ledger alone also drives `retry --all`, but an
  // undiscovered future edit would otherwise be masked by a premature
  // refresh). Concurrent sessions/hooks are safe: each session diffs against
  // its own baseline and the ledger transaction is authoritative.
  if (!results.some((r) => r.status && !INGEST_RESOLVED_STATES.has(r.status))) {
    await saveSessionBaseline(session, dir, { execImpl, env });
  }
  // ── automatic durable-learning assessment (§7) ─────────────────────────────
  // Runs on the SAME lifecycle events this pass already serves for both
  // clients (no new hook framework, no coordinator, no second store). It never
  // approves knowledge by itself: CAPTURED is recorded only on the task's own
  // verified ingestion evidence from THIS pass, NO_LESSON only when nothing
  // material was observed, and everything else is DEFERRED so the agent's
  // gated propose path (scripts/memory_turn_capture.py) still owns promotion.
  let learning = null;
  try {
    learning = await recordAutomaticLearningAssessment(session, dir, { execImpl, env, results, observable: obs.observable, dirty: obs.dirty, newDirty: obs.newDirty });
  } catch (e) {
    learning = { status: "DEFERRED", assessment: null, detail: `automatic assessment could not run: ${String(e?.message || e).slice(0, 100)}` };
  }
  return { ...obs, results, ingested: targets.length, observable: obs.observable, learning };
}

/**
 * The ONE automatic learning assessment. Honest disposition rules:
 *   - CAPTURED: this pass verified the documentation (DOC_INGEST_VERIFIED in
 *     the ledger) — the verified doc IS the task's durable knowledge; its
 *     ledger record (searchable) is the automatic candidate, already deduped
 *     by content hash. RepoQL promotion stays with the documented gated path.
 *   - NO_LESSON: nothing material was observed this pass (no eligible doc
 *     change, nothing new dirty) — the existing NO_LESSON contract.
 *   - DEFERRED: material work exists but the agent's verified lesson token is
 *     unreported — the candidate is RECORDED here (never lost), promotion
 *     stays with the human/agent gated path.
 * Idempotent + single write owner: a session assessment the agent already
 * claimed (any explicit capture status) is NEVER overwritten; concurrent
 * passes for the same session repeat the same deterministic write (atomic
 * rename) so two sessions evaluate their own keys independently (§8).
 */
export async function recordAutomaticLearningAssessment(session, dir, { execImpl = null, env = process.env, results = [], observable = true, dirty = null, newDirty = null } = {}) {
  const root = env.SINGULARITY_REPO_ROOT || process.cwd();
  const existing = loadAssessment(session, root);
  if (existing && ["CAPTURED", "NO_LESSON", "DEFERRED"].includes(existing.captureStatus))
    return { status: existing.captureStatus, assessment: null, detail: "an already-claimed assessment is kept (never overwritten)" };
  const guarded = (rec) => {
    const merged = { ...(existing || {}), ...rec };
    writeAssessmentAtomic(session, root, merged);
    return merged;
  };
  const verifiedDocs = (results || []).filter((r) => r.status === "DOC_INGEST_VERIFIED");
  if (verifiedDocs.length) {
    const rec = guarded({ files: verifiedDocs.map((r) => r.file), docStatus: "DOC_UPDATED", docReason: "automatic pass: this session's docs ingested and verified", docs: verifiedDocs.map((r) => r.file), ingestion: verifiedDocs.map(() => "DOC_INGEST_VERIFIED"), captureStatus: "CAPTURED", captureReason: "automatic: verified ingestion evidence is the durable candidate (promotion stays gated)", automatic: true, recordedAt: new Date().toISOString() });
    return { status: "CAPTURED", assessment: rec, detail: `automatic CAPTURED from ${verifiedDocs.length} verified ingestion record(s)` };
  }
  const materialObserved = observable === false
    ? (results || []).length > 0
    : (newDirty ? newDirty.length > 0 : (results || []).length > 0);
  if (!materialObserved) {
    if (existing) return { status: existing.captureStatus || "NO_LESSON", assessment: existing, detail: "existing assessment kept" };
    const rec = guarded({ files: [], docStatus: "DOC_NOT_REQUIRED", docReason: "automatic pass: no material change observed in this session's window", docs: [], ingestion: [], captureStatus: "NO_LESSON", captureReason: "automatic: nothing material was observed, so no lesson candidate exists", automatic: true, recordedAt: new Date().toISOString() });
    return { status: "NO_LESSON", assessment: rec, detail: "automatic NO_LESSON: nothing material changed this pass (observable)" };
  }
  const rec = guarded({ files: (results || []).map((r) => r.file), captureStatus: "DEFERRED", captureReason: "automatic: material work observed but the agent's verified lesson token is unreported — uses the gated propose path (data/selflearn pending), nothing is lost", automatic: true, recordedAt: new Date().toISOString(), deferredPending: "data/selflearn/pending" });
  return { status: "DEFERRED", assessment: rec, detail: "automatic DEFERRED: material work, gated promotion pending" };
}

// ── CLI ──────────────────────────────────────────────────────────────────────
export async function main(argv = process.argv.slice(2)) {
  const sub = argv[0];
  const value = (name, i) => {
    const idx = argv.indexOf(name, i);
    return idx >= 0 ? argv[idx + 1] : undefined;
  };
  const all = (name, i) => {
    const pos = argv.indexOf(name, i);
    if (pos < 0) return [];
    const rest = [];
    for (let k = pos + 1; k < argv.length && !argv[k].startsWith("--"); k++) rest.push(argv[k]);
    return rest;
  };
  const session = value("--session", 0);
  if (!sub) {
    console.log("usage: assess | check | report | discover [--session, --dir, --project-root, --json]");
    return 2;
  }

  if (sub === "assess") {
    if (!session) { console.log("assess requires --session <session-or-task id>"); return 2; }
    const files = all("--files", 0);
    if (!files.length) { console.log("assess requires --files <changed files...>"); return 2; }
    const docStatus = value("--doc-status", 0);
    const docs = all("--docs", 0);
    const ingestStatuses = all("--ingest-status", 0);
    const reason = value("--reason", 0);
    const skipJustification = value("--skip-justification", 0);
    const captureStatus = value("--capture-status", 0) || null;
    const root = resolve(value("--project-root", 0) || process.env.SINGULARITY_REPO_ROOT || process.cwd());
    // reject misplaced prefixes
    const filesInvalid = files.some((f) => !f || (isAbsolute(f) === false && f.includes("..")));
    if (filesInvalid) { console.log("assess --files entries must be plain workspace paths"); return 2; }
    if (!process.env.SINGULARITY_DOC_POLICY_ALLOW_ABS) {
      const abs = files.filter((f) => isAbsolute(f) && !f.startsWith(root));
      if (abs.length) { console.log(`assess --files must stay inside the project root (${root}): ${abs.join(", ")}`); return 2; }
    }
    const record = {
      session: sanitizeSession(session),
      recordedAt: new Date().toISOString(),
      projectRoot: root,
      files,
      docStatus: docStatus || null,
      docs,
      ingestion: ingestStatuses,
      docReason: reason || null,
      skipJustification: skipJustification || null,
      captureStatus,
    };
    // DOC_UPDATED collects INDEPENDENT ledger evidence at record time; the
    // check command re-collects at verification time (evidence must hold then).
    const evidence = record.docStatus === "DOC_UPDATED" && record.docs.length
      ? await collectEvidence(record.docs, root) : null;
    const findings = evaluateAssessment(record, { evidence });
    record.findings = findings;
    record.token = `SINGDOC-${sha8(JSON.stringify(record))}`;
    const path = writeAssessmentAtomic(session, root, record);
    if (findings.length) {
      console.log(JSON.stringify({ recorded: path, token: record.token, complete: false, findings, nextStep: findings[0].replace(/^FINDING: /, "").split(" — ")[0] }, null, 2));
      return 1;
    }
    console.log(JSON.stringify({ recorded: path, token: record.token, complete: true, findings: [] }, null, 2));
    return 0;
  }

  if (sub === "check") {
    if (!session) { console.log("check requires --session <id>"); return 2; }
    const root = resolve(value("--project-root", 0) || process.env.SINGULARITY_REPO_ROOT || process.cwd());
    const record = loadAssessment(session, root);
    if (!record) {
      console.log(JSON.stringify({ session: sanitizeSession(session), complete: false, findings: ["FINDING: no assessment for this session — a material task must record one (doc-policy.mjs assess)."] }));
      return 1;
    }
    // Evidence is re-collected AT CHECK TIME against the current ledger and
    // current source hashes — a status that was true earlier does not count
    // if the document changed afterwards or the record disappeared.
    const evidence = record.docStatus === "DOC_UPDATED" && (record.docs || []).length
      ? await collectEvidence(record.docs, root) : null;
    const findings = evaluateAssessment(record, { evidence });
    if (findings.length) {
      console.log(JSON.stringify({ session: sanitizeSession(session), complete: false, findings }));
      return 1;
    }
    console.log(JSON.stringify({ session: sanitizeSession(session), complete: true, token: record.token, docStatus: record.docStatus, captureStatus: record.captureStatus }));
    return 0;
  }

  if (sub === "report") {
    if (!session) { console.log("report requires --session <id>"); return 2; }
    const root = resolve(value("--project-root", 0) || process.env.SINGULARITY_REPO_ROOT || process.cwd());
    const record = loadAssessment(session, root);
    console.log(JSON.stringify(record || { session: sanitizeSession(session), recorded: false }));
    return record ? 0 : 1;
  }

  if (sub === "discover") {
    const dir = resolve(value("--dir", 0) || process.env.OPENCHAMBER_DOC_WORKSPACE || process.cwd());
    const session = value("--session", 0) || "default";
    // Also ingest the changed docs; DOC_NOT_REQUIRED/assessment checks are the
    // callers' business (OpenChamber uses reminders + deterministic check).
    const state = await autoIngestChangedDocs(dir, sanitizeSession(session));
    console.log(JSON.stringify({
      dir,
      ingested: state.ingested,
      results: state.results,
      observable: state.observable,
      note: state.observable === false ? "workspace is not a git repository — material-change observation unavailable for assessment enforcement" : undefined,
    }));
    return 0;
  }

  console.log("usage command: assess | check | report | discover");
  return 2;
}

let docPolicyMainRun = false;
if (process.argv[1] && process.argv[1].endsWith("doc-policy.mjs") && !process.argv.includes("--check")) {
  docPolicyMainRun = true;
}
if (docPolicyMainRun) {
  process.exit(await main());
}
