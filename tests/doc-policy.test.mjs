import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, readFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  classifyFiles,
  evaluateAssessment,
  loadAssessment,
  writeAssessmentAtomic,
  stateDir,
  assessmentPath,
  sanitizeSession,
  main as cliMain,
} from "../scripts/doc-policy.mjs";

function scratch() {
  return mkdtempSync(join(tmpdir(), "doc-policy-test-"));
}

test("classification: code/config is material, docs/locks/generated are skipped", () => {
  const { material, skipped } = classifyFiles([
    "src/server.py", "src/app.mjs", "compose/compose.yml", ".github/workflows/ci.yml",
    "README.md", "docs/guide.md", "package-lock.json", "src/app.min.js",
    "notes.tmp", "src/app.js.bak", ".git/config", "SHA256SUMS",
  ]);
  assert.deepEqual(material, ["src/server.py", "src/app.mjs", "compose/compose.yml", ".github/workflows/ci.yml"]);
  assert.equal(skipped.length, 8);
});

test("assessment outcomes: each policy path yields the required findings", () => {
  // No assessment at all
  assert.match(evaluateAssessment({ files: ["a.py"] })[0], /no documentation assessment recorded/);

  // DOC_BLOCKED never closes
  const blocked = evaluateAssessment({ files: ["a.py"], docStatus: "DOC_BLOCKED", docReason: "docs system offline", captureStatus: "NO_LESSON" });
  assert.ok(blocked.some((f) => /BLOCKED/.test(f)));

  // DOC_UPDATED missing docs + ingestion + capture
  const updated = evaluateAssessment({ files: ["a.py"], docStatus: "DOC_UPDATED", captureStatus: null });
  assert.ok(updated.some((f) => /requires at least one created\/updated documentation file/.test(f)));
  assert.ok(updated.some((f) => /verified MemoryCore ingestion/.test(f)));
  assert.ok(updated.some((f) => /knowledge-capture status unreported/.test(f)));

  // DOC_UPDATED with pending ingestion does not close
  const pending = evaluateAssessment({
    files: ["a.py"], docStatus: "DOC_UPDATED", docs: ["docs/r.md"],
    ingestion: ["DOC_INGEST_PENDING"], captureStatus: "CAPTURED",
    // files need not exist under evaluateAssessment (existence checked via existsSync on missing path)
  });
  assert.ok(pending.some((f) => /does not close the task; retry/.test(f)));

  // DOC_UPDATED fully closed leaves no findings (docs exist in tmp root)
  const dir = scratch();
  try { writeFileSync(join(dir, "r.md"), "# Runbook\n"); const opts = { allowMissing: false };
    const clean = evaluateAssessment({
      files: ["a.py"], docStatus: "DOC_UPDATED", docs: [join(dir, "r.md")],
      ingestion: ["DOC_INGEST_INDEXED"], captureStatus: "NO_LESSON",
    });
    assert.deepEqual(clean, []);
  } finally { rmSync(dir, { recursive: true, force: true }); }

  // DOC_NOT_REQUIRED for a non-material set + reason closes
  assert.deepEqual(evaluateAssessment({
    files: ["README.md"], docStatus: "DOC_NOT_REQUIRED", docReason: "typo fix only", captureStatus: "NO_LESSON",
  }), []);

  // DOC_NOT_REQUIRED refused for material files without a skip justification
  assert.ok(evaluateAssessment({
    files: ["a.py"], docStatus: "DOC_NOT_REQUIRED", docReason: "small change", captureStatus: "NO_LESSON",
  }).some((f) => /DOC_NOT_REQUIRED refused/.test(f)));

  // DOC_NOT_REQUIRED with vague reason
  assert.ok(evaluateAssessment({
    files: ["README.md"], docStatus: "DOC_NOT_REQUIRED", docReason: "", captureStatus: "NO_LESSON",
  }).some((f) => /needs a concise, specific reason/.test(f)));
});

test("CLI end-to-end: assess -> check closes; refuses material DOC_NOT_REQUIRED", () => {
  const dir = scratch();
  const calls = [];
  const origLog = console.log;
  const origCwd = process.cwd();
  try {
    console.log = (...a) => { calls.push(a.join(" ")); };
    process.chdir(dir);
    mkdirSync("data", { recursive: true });
    mkdirSync("docs", { recursive: true });
    writeFileSync("docs/new-runbook.md", "# New runbook\nsteps\n");

    // 1. incomplete assessment recorded -> findings, rc 1
    let rc = cliMain(["assess", "--session", "s1", "--files", "src/a.py",
      "--doc-status", "DOC_UPDATED", "--docs", "docs/new-runbook.md", "--capture-status", "CAPTURED"]);
    assert.equal(rc, 1);
    let last = JSON.parse(calls[calls.length - 1]);
    assert.equal(last.complete, false);
    assert.match(last.token, /^SINGDOC-[0-9a-f]{8}$/);
    assert.ok(last.findings.some((f) => /verified MemoryCore ingestion/.test(f)));
    assert.ok(existsSync(assessmentPath("s1", dir)));
    assert.deepEqual(loadAssessment("s1", dir).files, ["src/a.py"]);

    // 2. complete assessment -> rc 0 and check passes
    rc = cliMain(["assess", "--session", "s1", "--files", "src/a.py",
      "--doc-status", "DOC_UPDATED", "--docs", "docs/new-runbook.md",
      "--ingest-status", "DOC_INGEST_INDEXED", "--capture-status", "CAPTURED"]);
    assert.equal(rc, 0);
    rc = cliMain(["check", "--session", "s1"]);
    assert.equal(rc, 0);
    assert.match(calls[calls.length - 1].replace(/\s+/g, ""), /"complete":true/);

    // 3. second session not checked -> rc 1 with the missing-record finding
    rc = cliMain(["check", "--session", "s2"]);
    assert.equal(rc, 1);
    assert.match(JSON.parse(calls[calls.length - 1]).findings[0], /no assessment for this session/);
  } finally {
    console.log = origLog;
    process.chdir(origCwd);
    rmSync(dir, { recursive: true, force: true });
  }
});

test("assessment records are atomic and isolated per sanitized session", () => {
  const dir = scratch();
  try {
    const rec = { files: ["x.py"], docStatus: "DOC_BLOCKED", captureStatus: "NO_LESSON" };
    const p1 = writeAssessmentAtomic("we/ird:session", dir, rec);
    const p2 = writeAssessmentAtomic("ok-session", dir, rec);
    assert.equal(p1.includes("we_ird_session.json"), true);
    assert.equal(p2.includes("ok-session.json"), true);
    assert.equal(sanitizeSession("../../x"), "______x");
    assert.match(readFileSync(p1, "utf8"), /files/);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("state dir lives under project data/ (product-local, not runtime data in git)", () => {
  const dir = scratch();
  mkdirSync(join(dir, ".git"), { recursive: true });
  mkdirSync(join(dir, "data"), { recursive: true });
  assert.equal(stateDir(dir).startsWith(dir), true);
  assert.equal(stateDir(dir).includes(join("data", "doc-policy")), true);
  rmSync(dir, { recursive: true, force: true });
});
