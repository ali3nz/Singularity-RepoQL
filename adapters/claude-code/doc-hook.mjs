#!/usr/bin/env node
// doc-hook.mjs — Claude Code documentation-policy hooks ↔ the shared Singularity
// documentation system (scripts/doc-policy.mjs + scripts/memory-doc-ingest.py).
//
//   node doc-hook.mjs session-start   # inside SessionStart
//   node doc-hook.mjs stop            # inside Stop
//
// session-start: injects the BOUNDED start-of-work documentation guidance (the
// same rules text the OpenChamber runbook-nudge start reminder uses) and
// snapshots the per-session BASELINE (documentation census + git dirty list, if
// the workspace is a repo). The baseline means pre-existing dirty files are
// never attributed to this session.
//
// stop: the final-answer closeout check. It runs ONLY where it has something
// to check (never a blanket block):
//   1. retries any PENDING/FAILED MemoryCore documentation ingestion for this
//      workspace's ledger (event-driven; no-op when the ledger is clean);
//   2. AUTO-DISCOVERY: diffs the session's documentation baseline against the
//      present state and INGESTS new/changed eligible Markdown automatically
//      (content-hash dedup inside memory-doc-ingest renders repeats as
//      DOC_INGEST_UNCHANGED with no write); tracked and untracked files covered;
//   3. verifies closure from the INGESTION LEDGER, not from claimed status
//      text: a DOC_UPDATED assessment passes only when every documented file
//      is DOC_INGEST_VERIFIED in the ledger right now;
//   4. material implementation changes observed during this session (git-based)
//      must not close without a recorded documentation assessment: the hook
//      BLOCKS with precise remediation, bounded to MAX_BLOCKS per session and
//      always honouring stop_hook_active; chat/read-only sessions (no observed
//      material change, no assessment) are never blocked. Non-git workspaces
//      cannot observe changes, so no block is applied there (reported honestly).
import { join, resolve } from "node:path";
import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import {
  loadAssessment,
  evaluateAssessment,
  collectEvidence,
  observeWorkspace,
  saveSessionBaseline,
  ingestDocChange,
  MAX_DOC_INGEST_PER_PASS,
  classifyFiles,
} from "../../scripts/doc-policy.mjs";

const MAX_BLOCKS = 3;
const clip = (s, n) => { s = String(s ?? ""); return s.length > n ? s.slice(0, n) : s; };
const policyOn = (env) => String((env && env.OPENCHAMBER_DOC_POLICY) || process.env.OPENCHAMBER_DOC_POLICY || "on").trim().toLowerCase() !== "off";

export function blockStatePath(session, root) {
  const stateKey = String(session || "").replace(/[^A-Za-z0-9_-]/g, "_").slice(0, 64) || "unknown";
  return join(resolve(root), "data", "doc-policy", `blocks-${stateKey}.count`);
}

function readCounter(p) {
  try { return Number(readFileSync(p, "utf8")) || 0; } catch { return 0; }
}

import { readFileSync, writeFileSync, renameSync, mkdirSync } from "node:fs";

function bumpCounter(session, root) {
  try {
    const p = blockStatePath(session, root);
    mkdirSync(p.slice(0, p.lastIndexOf("/")), { recursive: true });
    const tmp = `${p}.${Date.now()}`;
    writeFileSync(tmp, String(readCounter(p) + 1));
    renameSync(tmp, p);
  } catch { /* counting must never break the hook */ }
}

export function runPythonScript(args, cwd, timeoutMs = 120_000) {
  try {
    return { stdout: execFileSync("python3", args, { encoding: "utf8", cwd, timeout: timeoutMs }), stderr: "", failed: false };
  } catch (e) {
    return { stdout: String(e?.stdout || ""), stderr: String(e?.stderr || e?.message || ""), failed: true };
  }
}

import { execFileSync } from "node:child_process";

const START_GUIDANCE =
  "[singularity docs start] Before substantial work: check the project's tracking records for active related work, " +
  "read the relevant existing runbook/documentation if one covers this task, search RepoQL concepts for the files " +
  "and decisions it touches, and search this installation's current indexed documentation when operational context " +
  "helps (`python3 scripts/memory-doc-ingest.py search \"<topic>\"`; bounded result). Reuse and improve existing docs; do not " +
  "create duplicates. For material changes, documentation is required (features, behaviour/API/deployment/config/security changes, bug fixes worth remembering, " +
  "troubleshooting and recovery procedures). Formatting-only, typo and throwaway edits may be reported with " +
  "DOC_NOT_REQUIRED and a concrete reason.";

function workspaceRootOf(input, optsEnv = {}) {
  return resolve(input.cwd || optsEnv.SINGULARITY_REPO_ROOT || process.env.SINGULARITY_REPO_ROOT || process.cwd());
}

function openDocIngestScript(env = {}) {
  const root = env.SINGULARITY_REPO_ROOT || process.env.SINGULARITY_REPO_ROOT;
  const candidate = root ? join(root, "scripts", "memory-doc-ingest.py") : "scripts/memory-doc-ingest.py";
  return existsSync(candidate) ? resolve(candidate) : null;
}

export async function runDocHook(argv, opts = {}) {
  let input = {};
  let inputOk = true;
  try { input = JSON.parse(String(opts.stdin ?? readFileSync(0, "utf8"))) || {}; } catch { /* malformed payload */ inputOk = false; }
  // A payload that cannot be parsed carries no trustworthy session identity or
  // workspace: falling back to the caller's cwd would let a malformed invocation
  // act against an ambiguous (possibly unrelated) tree. Treat it as a no-op.
  if (!inputOk) return { exitCode: 0, stdout: null, stderr: [] };
  const stderr = [];
  const kind = argv[0] || "";
  const root = workspaceRootOf(input, opts.env || {});

  if (kind === "session-start") {
    if (!policyOn(opts.env)) return { exitCode: 0, stdout: null, stderr };
    try {
      // Baseline: pre-existing dirty files stay unattributable to this session.
      await saveSessionBaseline(input.session_id || "unknown", root, { env: opts.env || process.env });
    } catch { /* baseline failure must not break the session */ }
    return {
      exitCode: 0,
      stdout: JSON.stringify({
        hookSpecificOutput: { hookEventName: "SessionStart", additionalContext: START_GUIDANCE },
      }),
      stderr,
    };
  }

  if (kind === "stop") {
    if (input.stop_hook_active) return { exitCode: 0, stdout: null, stderr }; // never loop on our own block
    if (!policyOn(opts.env)) return { exitCode: 0, stdout: null, stderr };
    const session = input.session_id;

    // 1. event-driven retry of pending ingestion for this workspace ledger.
    const docIngest = openDocIngestScript(opts.env || {});
    if (docIngest) {
      const retry = runPythonScript([docIngest, "retry", "--all", "--root", root], root);
      if (retry.failed) stderr.push(`singularity doc hook: ingestion retry unavailable (${clip(retry.stderr.split("\n")[0], 120)})`);
      else {
        for (const r of parseJsonList(retry.stdout)) {
          if (r && r.status && r.status !== "DOC_INGEST_UNCHANGED") {
            stderr.push(`singularity doc hook: ${r.file || ""} -> ${r.status}`);
          }
        }
      }
    }

    let obs = null;
    let autoIngest = [];
    let materialObserved = false;
    let observable = false;
    if (session) {
      try {
        // 2. AUTO-DISCOVERY: ingest new/changed eligible docs since the baseline.
        obs = await observeWorkspace(root, session, { env: opts.env || process.env });
        observable = obs.observable;
        if (obs.baselineRec) {
          const targets = obs.changedDocs.slice(0, MAX_DOC_INGEST_PER_PASS);
          let unresolved = false;
          for (const doc of targets) {
            const res = await ingestDocChange(doc.path, doc.root, session, { env: opts.env || process.env });
            autoIngest.push({ file: doc.rel, ...res });
            if (res.status && res.status !== "DOC_INGEST_UNCHANGED") {
              stderr.push(`singularity doc hook: auto-ingest ${doc.rel} -> ${res.status}`);
            }
            if (res.status && res.status !== "DOC_INGEST_INDEXED" && res.status !== "DOC_INGEST_UNCHANGED") {
              unresolved = true;
            }
          }
          // Refresh the baseline only when this round's changes are resolved:
          // an unresolved doc keeps its baseline slot so the next stop re-discovers
          // it (and the ledger still drives `retry --all`).
          if (!unresolved) {
            try {
              await saveSessionBaseline(session, root, { env: opts.env || process.env });
            } catch { /* baseline refresh best effort; stale baseline only means a re-diff next stop */ }
          }
        }
        // 4. observed material changes this session (never pre-existing dirt).
        if (observable) {
          const { material } = classifyFiles(obs.newDirty || []);
          materialObserved = material.length > 0;
          if (materialObserved) {
            stderr.push(`singularity doc hook: observed material change(s): ${clip(material.slice(0, 4).join(", "), 120)}${material.length > 4 ? ", ..." : ""}`);
          }
        }
      } catch (e) {
        stderr.push(`singularity doc hook: observed state unavailable, continuing (${clip(String(e?.message || e), 120)})`);
      }
    }

    // 3./4. verify closure from LEDGER evidence, never claimed statuses.
    if (session) {
      let record = null;
      try { record = loadAssessment(session, root); } catch { record = null; }
      if (record) {
        let findings;
        try {
          const evidence = record.docStatus === "DOC_UPDATED" && (record.docs || []).length
            ? await collectEvidence(record.docs, root)
            : null;
          findings = evaluateAssessment(record, { evidence });
        } catch (e) {
          findings = [`FINDING: assessment evaluation failed (${clip(String(e?.message || e), 120)})`];
        }
        if (findings.length) return blockOnce(session, root, findings, stderr);
        return { exitCode: 0, stdout: null, stderr };
      }
      if (materialObserved && !record) {
        return blockOnce(session, root, [
          "FINDING: material implementation change observed without a documentation assessment — record one (node scripts/doc-policy.mjs assess --session <id> --files ... --doc-status DOC_UPDATED|DOC_NOT_REQUIRED [<reason>] --capture-status CAPTURED|NO_LESSON|DEFERRED); documentation-only or trivial work may report DOC_NOT_REQUIRED with a concrete reason.",
        ], stderr);
      }
    }
    return { exitCode: 0, stdout: null, stderr };
  }

  return { exitCode: 0, stdout: null, stderr };
}

function parseJsonList(out) {
  try {
    const parsed = JSON.parse(out || "{}");
    return Array.isArray(parsed.results) ? parsed.results : [];
  } catch {
    return [];
  }
}

function blockOnce(session, root, findings, stderr) {
  const soFar = readCounter(blockStatePath(session, root));
  if (soFar >= MAX_BLOCKS) {
    stderr.push(`singularity doc hook: blocking limit reached for session — allowing completion with ${findings.length} unresolved finding(s) (reported honestly, not closed silently)`);
    return { exitCode: 0, stdout: null, stderr };
  }
  bumpCounter(session, root);
  stderr.push(`singularity doc hook: blocking this finish (attempt ${soFar + 1}/${MAX_BLOCKS}) — ${findings.length} documentation finding(s)`);
  return {
    exitCode: 2,
    stdout: JSON.stringify({
      decision: "block",
      reason: findings.join("\n"),
      systemMessage: "Documentation closeout incomplete. Fix the findings above (create/update the runbook, then verify ingestion with scripts/memory-doc-ingest.py verify, and re-run scripts/doc-policy.mjs assess with matching states), then finish again. Use DOC_NOT_REQUIRED ONLY for genuinely non-material changes with a concrete reason.",
    }),
    stderr,
  };
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const res = await runDocHook(process.argv.slice(2), { env: process.env });
  for (const line of res.stderr) process.stderr.write(line + "\n");
  if (res.stdout) process.stdout.write(res.stdout + "\n");
  process.exit(res.exitCode);
}
