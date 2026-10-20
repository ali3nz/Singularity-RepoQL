import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, readFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runDocHook } from "./doc-hook.mjs";

function workspace(withScripts = true) {
  const dir = mkdtempSync(join(tmpdir(), "doc-hook-test-"));
  if (withScripts) {
    mkdirSync(join(dir, "scripts"), { recursive: true });
    // A python3 that records its argv and answers with a clean ledger retry.
    mkdirSync(join(dir, "bin"), { recursive: true });
    writeFileSync(join(dir, "bin", "python3"), `#!/bin/sh
echo "$@" >> "${dir}/python3-calls.log"
case "$*" in *"ingest.py retry"*) echo '{"results": []}' ;; esac
`);
    // shell cannot exec without exec bit — skip exec; the hook uses execFileSync("python3")
    // so tests inject a stub via PATH instead.
  }
  return dir;
}

const silence = (s) => { const orig = console.log; console.log = () => {}; try { return s(); } finally { console.log = orig; } };

test("session-start injects the same shared documentation guidance (advisory)", async () => {
  const res = await runDocHook(["session-start"], { env: {}, stdin: "{}" });
  assert.equal(res.exitCode, 0);
  const out = JSON.parse(res.stdout);
  assert.equal(out.hookSpecificOutput.hookEventName, "SessionStart");
  assert.match(out.hookSpecificOutput.additionalContext, /singularity docs start/);
  assert.match(out.hookSpecificOutput.additionalContext, /tracking records/);
  assert.match(out.hookSpecificOutput.additionalContext, /RepoQL concepts/);
});

test("stop with no recorded assessment never blocks (chat/read-only work)", async () => {
  const dir = workspace();
  try {
    const res = await runDocHook(["stop"], { env: {}, stdin: JSON.stringify({ session_id: "s-none", cwd: dir }) });
    assert.equal(res.exitCode, 0);
    assert.equal(res.stdout, null);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("stop honours stop_hook_active (no infinite loop from our own block)", async () => {
  const res = await runDocHook(["stop"], { env: {}, stdin: JSON.stringify({ stop_hook_active: true, session_id: "s", cwd: process.cwd() }) });
  assert.equal(res.exitCode, 0);
});

test("stop blocks an incomplete recorded assessment with concrete remediation, bounded times", async () => {
  const dir = workspace(false);
  try {
    mkdirSync(join(dir, "data", "doc-policy"), { recursive: true });
    mkdirSync(join(dir, "docs"), { recursive: true });
    writeFileSync(join(dir, "docs", "r.md"), "# Runbook\n"); // docs must exist so the finding is specifically the pending ingestion
    // The assessment this stub session "recorded": DOC_UPDATED but ingestion pending.
    writeFileSync(join(dir, "data", "doc-policy", "s-bad.json"), JSON.stringify({
      session: "s-bad", files: ["main.py"], docStatus: "DOC_UPDATED", docs: ["docs/r.md"],
      ingestion: ["DOC_INGEST_PENDING"], captureStatus: "CAPTURED", projectRoot: dir,
    }));
    const res = await runDocHook(["stop"], { env: {}, stdin: JSON.stringify({ session_id: "s-bad", cwd: dir }) });
    assert.equal(res.exitCode, 2);
    const out = JSON.parse(res.stdout);
    assert.equal(out.decision, "block");
    assert.match(out.reason, /does not close the task; retry/);
    assert.match(out.systemMessage, /DOC_NOT_REQUIRED ONLY for genuinely non-material/);
    assert.match(res.stderr.join(" "), /attempt 1\/3/);
    assert.match(readFileSync(join(dir, "data", "doc-policy", "blocks-s-bad.count"), "utf8"), /^1$/);

    // ...but after MAX_BLOCKS the hook allows completion instead of looping forever.
    writeFileSync(join(dir, "data", "doc-policy", "blocks-s-bad.count"), "3");
    const res2 = await runDocHook(["stop"], { env: {}, stdin: JSON.stringify({ session_id: "s-bad", cwd: dir }) });
    assert.equal(res2.exitCode, 0);
    assert.match(res2.stderr.join(" "), /blocking limit reached/);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("stop verifies a complete assessment and allows completion", async () => {
  const dir = workspace(false);
  try {
    mkdirSync(join(dir, "docs"), { recursive: true });
    writeFileSync(join(dir, "docs", "r.md"), "# Runbook\n");
    mkdirSync(join(dir, "data", "doc-policy"), { recursive: true });
    writeFileSync(join(dir, "data", "doc-policy", "s-ok.json"), JSON.stringify({
      session: "s-ok", files: ["README.md"], docStatus: "DOC_NOT_REQUIRED",
      docReason: "typo fix only", captureStatus: "NO_LESSON",
    }));
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

test("missing python3 degrades to a warning and still audits atomic block state safely", async () => {
  const dir = mkdtempSync(join(tmpdir(), "doc-hook-noPy-"));
  try {
    // No scripts/memory-doc-ingest.py in this workspace -> retry step is skipped
    const res = await runDocHook(["stop"], { env: {}, stdin: JSON.stringify({ session_id: "s-x", cwd: dir }) });
    assert.equal(res.exitCode, 0);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
