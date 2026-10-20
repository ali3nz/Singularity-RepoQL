#!/usr/bin/env node
// doc-policy.mjs — the shared documentation policy for BOTH Singularity clients.
//
// OpenChamber (runbook-nudge + AGENTS.md) and Claude Code (doc-hook.mjs + this
// CLI) follow the SAME rules through these functions and this one deterministic
// command; there is no second policy text and no agent-only judgment.
//
//   node scripts/doc-policy.mjs assess  --session S --files a.py b.py \
//        (--doc-status DOC_UPDATED --docs docs/runbook.md | --doc-status DOC_NOT_REQUIRED --reason "..." )
//   node scripts/doc-policy.mjs check   --session S [--json]
//   node scripts/doc-policy.mjs report  --session S
//
// A material task closes ONLY when its recorded assessment has:
//   DOC_UPDATED        -> docs listed exist under the project doc roots AND were
//                         ingested (memory-doc-ingest statuses INDEXED / verified
//                         UNCHANGED) AND knowledge capture reported
//                         (CAPTURED | NO_LESSON | DEFERRED)
//   DOC_NOT_REQUIRED   -> non-material change set + explicit reason
//   DOC_BLOCKED        -> never closes the task (the reason is surfaced instead)
//
// Exit codes: check 0 = closure complete, 1 = incomplete (findings printed),
// 2 = usage error. No secret is ever read or printed.
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync, renameSync } from "node:fs";
import { join, resolve, isAbsolute, extname } from "node:path";

const sha8 = (s) => createHash("sha256").update(String(s)).digest("hex").slice(0, 8);

// ── classification (shared with both clients) ────────────────────────────────
// A change set is MATERIAL when any file can change behaviour, operations,
// security of installation, or integration. Formatting/lock/generated/docs-only
// adjustments are NON-MATERIAL by default.
export const SKIP_EXTS = new Set([".md", ".mdx", ".txt", ".rst", ".lock", ".sum", ".png", ".jpg", ".jpeg", ".gif", ".svg", ".ico", ".woff", ".woff2"]);
export const SKIP_FILES = new Set(["package-lock.json", "yarn.lock", "pnpm-lock.yaml", "SHA256SUMS", "MANIFEST.json"]);
export const SKIP_DIR_PARTS = new Set(["__pycache__", ".git", "node_modules", "vendor", "dist", "build", "gen", "generated", ".min.", "snapshots"]);

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
    const ingestion = assess.ingestion || [];
    if (!ingestion.length) findings.push("FINDING: DOC_UPDATED requires verified MemoryCore ingestion — run scripts/memory-doc-ingest.py ingest --file <doc> and record its statuses (--ingest-status DOC_INGEST_INDEXED).");
    for (const s of ingestion) {
      if (s !== "DOC_INGEST_INDEXED" && s !== "DOC_INGEST_UNCHANGED") {
        findings.push(`FINDING: documentation ingestion is ${s} for at least one doc — pending/blocking does not close the task; retry (scripts/memory-doc-ingest.py retry --file <doc> --root <root>).`);
      }
    }
    if (docs.length && ingestion.length && docs.length !== ingestion.length) {
      findings.push(`FINDING: ${docs.length} docs listed but ${ingestion.length} ingestion statuses recorded — every documented file needs verified ingestion.`);
    }
  }

  if (!findings.length && !["DOC_UPDATED", "DOC_NOT_REQUIRED"].includes(status)) {
    findings.push(`FINDING: unknown documentation status ${status}`);
  }
  const captureOk = ["CAPTURED", "NO_LESSON", "DEFERRED"].includes(assess.captureStatus);
  if (!captureOk) {
    findings.push("FINDING: knowledge-capture status unreported — state captureStatus: CAPTURED | NO_LESSON | DEFERRED (per docs/memory-capture-promotion.md).");
  }
  return findings;
}

export { sha8 };

// ── state: completed assessments live under data/doc-policy/ ─────────────────
export function stateDir(root = process.env.SINGULARITY_REPO_ROOT || process.cwd()) {
  return join(resolve(root), "data", "doc-policy");
}

export function assessmentPath(session, root) {
  return join(stateDir(root), `${sanitizeSession(session)}.json`);
}

export function sanitizeSession(session) {
  return String(session || "").replace(/[^A-Za-z0-9_-]/g, "_").slice(0, 64) || "session";
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



export function loadAssessment(session, root) {
  const p = assessmentPath(session, root);
  return existsSync(p) ? JSON.parse(readFileSync(p, "utf8")) : null;
}

// ── CLI ──────────────────────────────────────────────────────────────────────
export function main(argv = process.argv.slice(2)) {
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
    console.log("usage: assess | check | report [--json | --pretty] [-h]");
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
    const root = value("--project-root", 0) || process.env.SINGULARITY_REPO_ROOT || process.cwd();
    // reject misplaced prefixes
    const filesInvalid = files.some((f) => !f || isAbsolute(f) === false && f.includes(".."));
    if (filesInvalid) { console.log("assess --files entries must be plain workspace paths"); return 2; }
    if (!process.env.SINGULARITY_DOC_POLICY_ALLOW_ABS) {
      const abs = files.filter((f) => isAbsolute(f) && !f.startsWith(root) && !f.startsWith(resolve(root)));
      if (abs.length) { console.log(`assess --files must stay inside the project root (${resolve(root)}): ${abs.join(", ")}`); return 2; }
    }
    const record = {
      session: sanitizeSession(session),
      recordedAt: new Date().toISOString(),
      projectRoot: process.cwd(),
      files,
      docStatus: docStatus || null,
      docs,
      ingestion: ingestStatuses,
      docReason: reason || null,
      skipJustification: skipJustification || null,
      captureStatus,
    };
    const findings = evaluateAssessment(record);
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
    const root = value("--project-root", 0) || process.env.SINGULARITY_REPO_ROOT || process.cwd();
    const record = loadAssessment(session, root);
    if (!record) {
      console.log(JSON.stringify({ session: sanitizeSession(session), complete: false, findings: ["FINDING: no assessment for this session — a material task must record one (doc-policy.mjs assess)."] }));
      return 1;
    }
    const findings = evaluateAssessment(record);
    if (findings.length) {
      console.log(JSON.stringify({ session: sanitizeSession(session), complete: false, findings }));
      return 1;
    }
    console.log(JSON.stringify({ session: sanitizeSession(session), complete: true, token: record.token, docStatus: record.docStatus, captureStatus: record.captureStatus }));
    return 0;
  }

  if (sub === "report") {
    if (!session) { console.log("report requires --session <id>"); return 2; }
    const root = value("--project-root", 0) || process.env.SINGULARITY_REPO_ROOT || process.cwd();
    const record = loadAssessment(session, root);
    console.log(JSON.stringify(record || { session: sanitizeSession(session), recorded: false }));
    return record ? 0 : 1;
  }

  console.log("usage command: assess | check | report");
  return 2;
}

if (process.argv[1] && process.argv[1].endsWith("doc-policy.mjs")) {
  process.exit(await main());
}
