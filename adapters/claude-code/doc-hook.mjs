#!/usr/bin/env node
// doc-hook.mjs — Claude Code documentation-policy hooks ↔ the shared Singularity
// documentation system (scripts/doc-policy.mjs + scripts/memory-doc-ingest.py).
//
//   node doc-hook.mjs session-start   # inside SessionStart
//   node doc-hook.mjs stop            # inside Stop
//
// session-start: injects the BOUNDED start-of-work documentation guidance
// (exactly the same rules text the OpenChamber runbook-nudge start reminder
// uses) via hookSpecificOutput.additionalContext. Purely advisory; failures
// never break a session.
//
// stop: the final-answer closeout check. Runs ONLY when there is something to
// check (never a blanket block):
//   1. retry any PENDING/FAILED MemoryCore documentation ingestion for this
//      workspace's doc stack (event-driven; a no-op when the ledger is clean).
//   2. if this session recorded a documentation assessment (via
//      scripts/doc-policy.mjs assess), verify closure; refusal to document,
//      unverified ingestion or DOC_BLOCKED BLOCK completion with concrete
//      remediation. Bounded: at most MAX_BLOCKS blocks per session, then the
//      hook allows completion with a recorded warning (never an infinite loop).
//     It honours stop_hook_active and never blocks for a session that recorded
//      no assessment (ordinary chat / read-only work).
import { execFileSync } from "node:child_process";
import { join, resolve } from "node:path";
import { existsSync, mkdirSync, readFileSync, writeFileSync, renameSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { loadAssessment, evaluateAssessment } from "../../scripts/doc-policy.mjs";

const HOOK_DIR = fileURLToPath(new URL(".", import.meta.url));
const MAX_BLOCKS = 3;

const START_GUIDANCE =
  "[singularity docs start] Before substantial work: check the project's tracking records for active related work, " +
  "read the relevant existing runbook/documentation if one covers this task, search RepoQL concepts for the files " +
  "and decisions it touches, and search this installation's current indexed documentation when operational context " +
  "helps (`python3 scripts/memory-doc-ingest.py search \"<topic>\"`). Reuse and improve existing docs; do not create duplicates. " +
  "For material changes, documentation is required (features, behaviour/API/deployment/config/security changes, bug fixes worth remembering, " +
  "troubleshooting and recovery procedures). Formatting-only, typo and throwaway edits may be reported with " +
  "DOC_NOT_REQUIRED and a concrete reason.";

export function blockStatePath(session, root) {
  const stateKey = String(session || "").replace(/[^A-Za-z0-9_-]/g, "_").slice(0, 64) || "unknown";
  return join(resolve(root), "data", "doc-policy", `blocks-${stateKey}.count`);
}

function blocksSoFar(session, root) {
  try { return Number(readFileSync(blockStatePath(session, root), "utf8")) || 0; } catch { return 0; }
}

function recordBlock(session, root) {
  try {
    const p = blockStatePath(session, root);
    mkdirSync(p.slice(0, p.lastIndexOf("/")), { recursive: true });
    const tmp = `${p}.${Date.now()}`;
    writeFileSync(tmp, String(blocksSoFar(session, root) + 1));
    renameSync(tmp, p);
  } catch { /* counting must never break the hook */ }
}

export function runPythonScript(args, cwd, timeoutMs = 60_000) {
  let out;
  try {
    out = execFileSync("python3", args, { encoding: "utf8", cwd, timeout: timeoutMs });
  } catch (e) {
    const stderr = String(e?.stderr || e?.message || "");
    return { stdout: String(e?.stdout || ""), stderr, failed: true };
  }
  return { stdout: out, stderr: "", failed: false };
}

const clip = (s, n) => { s = String(s ?? ""); return s.length > n ? s.slice(0, n) : s; };
const policyOn = (env) => String((env && env.OPENCHAMBER_DOC_POLICY) || process.env.OPENCHAMBER_DOC_POLICY || "on").trim().toLowerCase() !== "off";

export async function runDocHook(argv, opts = {}) {
  let input = {};
  try { input = JSON.parse(String(opts.stdin ?? readFileSync(0, "utf8"))) || {}; } catch { /* malformed payload */ }
  const stderr = [];
  const kind = argv[0] || "";
  const root = input.cwd || opts.env?.SINGULARITY_REPO_ROOT || process.cwd();

  if (kind === "session-start") {
    if (!policyOn(opts.env)) {
      return { exitCode: 0, stdout: null, stderr };
    }
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
    if (!policyOn(opts.env)) {
      return { exitCode: 0, stdout: null, stderr };
    }
    // 1. event-driven retry of pending MemoryCore ingestion for this workspace.
    const docIngest = openDocIngestScript(opts.env);
    if (docIngest) {
      const retry = runPythonScript([docIngest, "retry", "--all", "--root", root], root);
      if (retry.failed) stderr.push(`singularity doc hook: ingestion retry unavailable (${clip(String(retry.stderr).split("\n")[0], 120)})`);
      const results = (() => { try { return JSON.parse(retry.stdout || "{}").results || []; } catch { return []; } })();
      for (const r of results) {
        if (r.status && r.status !== "DOC_INGEST_UNCHANGED") {
          stderr.push(`singularity doc hook: ${r.file || r.reason || "doc"} -> ${r.status}`);
        }
      }
    }

    // 2. closeout check for a session that recorded an assessment.
    const session = input.session_id;
    if (!session) return { exitCode: 0, stdout: null, stderr };
    let record;
    try {
      record = loadAssessment(session, root);
    } catch {
      record = null;
      stderr.push("singularity doc hook: unreadable assessment record for this session; allowing completion");
    }
    if (!record) return { exitCode: 0, stdout: null, stderr };
    let findings;
    try {
      findings = evaluateAssessment(record);
    } catch (e) {
      stderr.push(`singularity doc hook: assessment evaluation failed, allowing completion (${clip(String(e?.message || e), 120)})`);
      return { exitCode: 0, stdout: null, stderr };
    }
    if (!findings.length) return { exitCode: 0, stdout: null, stderr };

    const soFar = blocksSoFar(session, root);
    if (soFar >= MAX_BLOCKS) {
      stderr.push(`singularity doc hook: blocking limit reached for this session — allowing completion with unresolved findings: ${findings.length} (session: session ${clip(session, 24)})`);
      return { exitCode: 0, stdout: null, stderr };
    }
    recordBlock(session, root);
    stderr.push(`singularity doc hook: blocking this finish (attempt ${soFar + 1}/${MAX_BLOCKS}) — material task may not close with ${findings.length} documentation finding(s)`);
    return {
      exitCode: 2,
      stdout: JSON.stringify({
        decision: "block",
        reason: findings.join("\n"),
        systemMessage: "Documentation closeout incomplete. Fix the findings above (create/update the runbook, ingest it with scripts/memory-doc-ingest.py, re-run scripts/doc-policy.mjs assess with matching --ingest-status), then finish again. Use DOC_NOT_REQUIRED ONLY for genuinely non-material changes with a concrete reason.",
      }),
      stderr,
    };
  }

  return { exitCode: 0, stdout: null, stderr };
}

function openDocIngestScript(env = {}) {
  const root = env.SINGULARITY_REPO_ROOT || process.env.SINGULARITY_REPO_ROOT;
  const candidate = root ? join(root, "scripts", "memory-doc-ingest.py") : "scripts/memory-doc-ingest.py";
  return existsSync(candidate) ? resolve(candidate) : null;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const res = await runDocHook(process.argv.slice(2), { env: process.env });
  for (const line of res.stderr) process.stderr.write(line + "\n");
  if (res.stdout) process.stdout.write(res.stdout + "\n");
  process.exit(res.exitCode);
}
