import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, readFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { execFileSync } from "node:child_process";
import { runDocHook } from "./doc-hook.mjs";

function workspace(withGit = false) {
  const dir = mkdtempSync(join(tmpdir(), "doc-hook-test-"));
  if (withGit) {
    git(dir, "init", "-q");
    git(dir, "config", "user.email", "t@local");
    git(dir, "config", "user.name", "tlocal");
  }
  return dir;
}

function git(dir, ...args) {
  return execFileSync("git", ["-C", dir, ...args], { encoding: "utf8", timeout: 10000 });
}

test("session-start injects shared guidance and records the per-session baseline", async () => {
  const dir = workspace();
  try {
    const res = await runDocHook(["session-start"], { env: {}, stdin: JSON.stringify({ session_id: "s-b", cwd: dir }) });
    assert.equal(res.exitCode, 0);
    const out = JSON.parse(res.stdout);
    assert.equal(out.hookSpecificOutput.hookEventName, "SessionStart");
    assert.match(out.hookSpecificOutput.additionalContext, /singularity docs start/);
    assert.ok(existsSync(join(dir, "data", "doc-policy", "baseline-s-b.json")), "baseline persisted");
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("stop never blocks chat/read-only sessions (no observation, no assessment)", async () => {
  const dir = workspace();
  try {
    const res = await runDocHook(["stop"], { env: {}, stdin: JSON.stringify({ session_id: "s-none", cwd: dir }) });
    assert.equal(res.exitCode, 0);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("stop honours stop_hook_active even with material unpersisted state", async () => {
  const dir = workspace(true);
  try {
    writeFileSync(join(dir, "new.py"), "x = 1\n"); // would be a material change
    const res = await runDocHook(["stop"], { env: {}, stdin: JSON.stringify({ stop_hook_active: true, session_id: "s2", cwd: dir }) });
    assert.equal(res.exitCode, 0);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("material implementation change without an assessment blocks (bounded), then allows", async () => {
  const dir = workspace(true);
  try {
    writeFileSync(join(dir, "base.txt"), "base\n");
    git(dir, "add", "-A");
    git(dir, "commit", "-qm", "base");
    const start = await runDocHook(["session-start"], { env: {}, stdin: JSON.stringify({ session_id: "s-mat", cwd: dir }) });
    assert.equal(start.exitCode, 0);
    writeFileSync(join(dir, "impl.py"), "def run(): return 42\n"); // material, after baseline
    const res = await runDocHook(["stop"], { env: {}, stdin: JSON.stringify({ session_id: "s-mat", cwd: dir }) });
    assert.equal(res.exitCode, 2, res.stdout);
    const out = JSON.parse(res.stdout);
    assert.equal(out.decision, "block");
    assert.match(out.reason, /material implementation change observed without a documentation assessment/);
    assert.match(res.stderr.join(" "), /attempt 1\/3/);
    // bounded: with a fresh material change and the block counter at MAX,
    // the hook allows completion with an honest warning (no infinite loop).
    writeFileSync(join(dir, "more.py"), "def more(): return 7\n");
    writeFileSync(join(dir, "data", "doc-policy", "blocks-s-mat.count"), "3");
    const res2 = await runDocHook(["stop"], { env: {}, stdin: JSON.stringify({ session_id: "s-mat", cwd: dir }) });
    assert.equal(res2.exitCode, 0);
    assert.match(res2.stderr.join(" "), /blocking limit reached/);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("pre-existing dirty files are NOT attributed (baseline isolation)", async () => {
  const dir = workspace(true);
  try {
    writeFileSync(join(dir, "existing.py"), "a = 1\n"); // dirty BEFORE session
    const start = await runDocHook(["session-start"], { env: {}, stdin: JSON.stringify({ session_id: "s-pre", cwd: dir }) });
    assert.equal(start.exitCode, 0);
    const res = await runDocHook(["stop"], { env: {}, stdin: JSON.stringify({ session_id: "s-pre", cwd: dir }) });
    assert.equal(res.exitCode, 0, "baseline absorbs pre-existing dirt; no block");
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("patient docs-only change does not demand a code assessment but still auto-ingests", async () => {
  const dir = workspace(true);
  try {
    writeFileSync(join(dir, "base.txt"), "base\n");
    git(dir, "add", "-A"); git(dir, "commit", "-qm", "base");
    const start = await runDocHook(["session-start"], { env: {}, stdin: JSON.stringify({ session_id: "s-doc", cwd: dir }) });
    assert.equal(start.exitCode, 0);
    mkdirSync(join(dir, "docs"), { recursive: true });
    writeFileSync(join(dir, "docs", "runbook.md"), "# New runbook\nAuthor steps\n"); // docs-only, untracked
    // No memory config exists in this sandbox, so the Node engine must record an
    // HONEST refusal (BLOCKED) — the point is that the ingestion path ran at all,
    // in-process, with no Python runtime and no subprocess.
    const res = await runDocHook(["stop"], { env: {}, stdin: JSON.stringify({ session_id: "s-doc", cwd: dir }) });
    assert.equal(res.exitCode, 0, "docs-only change does not block for a code assessment");
    assert.match(res.stderr.join(" "), /auto-ingest docs\/runbook\.md -> DOC_INGEST_BLOCKED/);
    const ledgerPath = join(dir, "data", "doc-index", "ledger.json");
    assert.ok(existsSync(ledgerPath), "the shared ledger was written by the Node engine");
    const ledger = JSON.parse(readFileSync(ledgerPath, "utf8"));
    const entry = Object.values(ledger.docs).find((d) => d.rel === "docs/runbook.md");
    assert.ok(entry, "the document is recorded in the ledger");
    assert.equal(entry.root, dir.replace(/\\/g, "/"), "root-scoped identity uses the authorised workspace root");
    assert.equal(entry.revs[Object.keys(entry.revs)[0]].status, "DOC_INGEST_BLOCKED");
    // An unresolved ingestion keeps its baseline slot: the next stop re-discovers it.
    const baseline = JSON.parse(readFileSync(join(dir, "data", "doc-policy", "baseline-s-doc.json"), "utf8"));
    assert.equal(Object.keys(baseline.files).some((p) => p.includes("runbook.md")), false);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("stop never treats runtime backup copies as session documentation (regression: false DOC_UPDATED)", async () => {
  const dir = workspace(true);
  try {
    writeFileSync(join(dir, "base.txt"), "base\n");
    git(dir, "add", "-A"); git(dir, "commit", "-qm", "base");
    const start = await runDocHook(["session-start"], { env: {}, stdin: JSON.stringify({ session_id: "s-backup", cwd: dir }) });
    assert.equal(start.exitCode, 0);
    // Exactly the artifacts the installer/attach path writes inside the
    // workspace; the old census ingested them as the session's docs.
    for (const rel of [
      "data/agent-backups/2026-10-30T08-49-27-992Z/singularity-thinker.md",
      "data/agent-backups/2026-10-30T08-49-28-001Z/singularity-board.md",
      "data/attach-backups/2026-10-30T08-49-29-853Z/AGENTS.md",
    ]) {
      mkdirSync(dirname(join(dir, rel)), { recursive: true });
      writeFileSync(join(dir, rel), "# backup copy\n");
    }
    const res = await runDocHook(["stop"], { env: {}, stdin: JSON.stringify({ session_id: "s-backup", cwd: dir }) });
    assert.equal(res.exitCode, 0, res.stdout);
    assert.doesNotMatch(res.stderr.join(" "), /auto-ingest/, "backup artifacts are not ingested as docs");
    const rec = JSON.parse(readFileSync(join(dir, "data", "doc-policy", "s-backup.json"), "utf8"));
    assert.equal(rec.docStatus, "DOC_NOT_REQUIRED", "a backup-only window is not a documentation update");
    assert.deepEqual(rec.docs, []);
    assert.equal(rec.ingestion.length, 0);
    const lp = join(dir, "data", "doc-index", "ledger.json");
    if (existsSync(lp)) {
      const ledger = JSON.parse(readFileSync(lp, "utf8"));
      assert.equal(Object.values(ledger.docs || {}).some((d) => /agent-backups|attach-backups/.test(d.rel)), false, "no backup entered the ledger");
    }
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("stop blocks an incomplete recorded assessment (ledger evidence, bounded)", async () => {
  const dir = workspace(false);
  try {
    mkdirSync(join(dir, "docs"), { recursive: true });
    writeFileSync(join(dir, "docs", "r.md"), "# Runbook\n");
    mkdirSync(join(dir, "data", "doc-policy"), { recursive: true });
    writeFileSync(join(dir, "data", "doc-policy", "s-bad.json"), JSON.stringify({
      session: "s-bad", files: ["main.py"], docStatus: "DOC_UPDATED", docs: ["docs/r.md"],
      ingestion: ["DOC_INGEST_PENDING"], captureStatus: "CAPTURED", projectRoot: dir,
    }));
    const res = await runDocHook(["stop"], { env: {}, stdin: JSON.stringify({ session_id: "s-bad", cwd: dir }) });
    assert.equal(res.exitCode, 2);
    const out = JSON.parse(res.stdout);
    assert.equal(out.decision, "block");
    assert.match(out.reason, /NOT verified for|ingestion evidence was not checked/);
    writeFileSync(join(dir, "data", "doc-policy", "blocks-s-bad.count"), "3");
    const res2 = await runDocHook(["stop"], { env: {}, stdin: JSON.stringify({ session_id: "s-bad", cwd: dir }) });
    assert.equal(res2.exitCode, 0);
    assert.match(res2.stderr.join(" "), /blocking limit reached/);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("stop verifies a ledger-evidence-backed complete assessment and allows completion", async () => {
  const dir = workspace(true);
  try {
    mkdirSync(join(dir, "docs"), { recursive: true });
    writeFileSync(join(dir, "docs", "r.md"), "# Runbook ready\n");
    mkdirSync(join(dir, "data", "doc-policy"), { recursive: true });
    // A DOC_NOT_REQUIRED record needs no ingestion evidence.
    writeFileSync(join(dir, "data", "doc-policy", "s-ok.json"), JSON.stringify({
      session: "s-ok", files: ["README.md"], docStatus: "DOC_NOT_REQUIRED",
      docReason: "typo fix only", captureStatus: "NO_LESSON",
    }));
    await runDocHook(["session-start"], { env: {}, stdin: JSON.stringify({ session_id: "s-ok", cwd: dir }) });
    const res = await runDocHook(["stop"], { env: {}, stdin: JSON.stringify({ session_id: "s-ok", cwd: dir }) });
    assert.equal(res.exitCode, 0);
    assert.equal(res.stdout, null);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("policy off-switch makes both hooks no-ops", async () => {
  const env = { OPENCHAMBER_DOC_POLICY: "off" };
  const a = await runDocHook(["session-start"], { env, stdin: "{}" });
  assert.equal(a.exitCode, 0);
  assert.equal(a.stdout, null);
  const b = await runDocHook(["stop"], { env, stdin: "{}" });
  assert.equal(b.exitCode, 0);
});

test("malformed stdin never throws and exits 0 quietly", async () => {
  const res = await runDocHook(["session-start"], { env: {}, stdin: "not json" });
  assert.equal(res.exitCode, 0);
});

test("missing workspaces degrade: absent python3 memory secrets leave an honest trace, no crash", async () => {
  const dir = mkdtempSync(join(tmpdir(), "doc-hook-noPy-"));
  try {
    const res = await runDocHook(["stop"], { env: {}, stdin: JSON.stringify({ session_id: "s-x", cwd: dir }) });
    assert.equal(res.exitCode, 0);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
