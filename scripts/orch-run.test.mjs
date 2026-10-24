// orch-run.test.mjs — the operator interface end to end, as a real subprocess.
// Deterministic: no model call is made anywhere in this file.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const CLI = path.join(HERE, "orch-run");

function run(args, stateDir, extraEnv = {}) {
  const res = spawnSync(process.execPath, [CLI, ...args], {
    encoding: "utf8",
    env: { ...process.env, ORCH_STATE_DIR: stateDir, ...extraEnv },
  });
  return { rc: res.status, out: res.stdout, err: res.stderr };
}

function runId(out) {
  const m = out.match(/^run\s+(\S+)$/m);
  assert.ok(m, `no run id in output:\n${out}`);
  return m[1];
}

test("operator flow: start, evidence-gated stages, approval, acceptance", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "orch-cli-"));
  const work = path.join(dir, "work");
  fs.mkdirSync(work);

  const started = run(["start", "port the coordinator", "--mode", "duo", "--revision", "abc123"], dir);
  assert.equal(started.rc, 0, started.err);
  const id = runId(started.out);
  assert.match(started.out, /mode\s+duo/);

  // Stage gate: implement cannot be entered without plan evidence.
  const tooEarly = run(["advance", id, "--to", "implement", "--role", "coordinator"], dir);
  assert.equal(tooEarly.rc, 3, "advancing without evidence must be refused");
  assert.match(tooEarly.err, /missing evidence/);

  assert.equal(run(["evidence", id, "--kind", "plan", "--producer", "coordinator", "--text", "plan: do it"], dir).rc, 0);
  assert.equal(run(["advance", id, "--to", "implement", "--role", "coordinator"], dir).rc, 0);

  const diffFile = path.join(work, "change.diff");
  fs.writeFileSync(diffFile, "diff --git a/x b/x\n+hello\n");
  assert.equal(run(["evidence", id, "--kind", "diff", "--producer", "worker-1", "--file", diffFile], dir).rc, 0);
  assert.equal(run(["advance", id, "--to", "validate", "--role", "coordinator"], dir).rc, 0);

  assert.equal(run(["evidence", id, "--kind", "test-output", "--producer", "worker-1", "--text", "ok 1 - all pass"], dir).rc, 0);
  assert.equal(run(["advance", id, "--to", "review", "--role", "coordinator"], dir).rc, 0);

  // Acceptance needs an approving verdict, then an independent approval.
  const noVerdict = run(["advance", id, "--to", "accept", "--role", "reviewer"], dir);
  assert.equal(noVerdict.rc, 3);
  assert.match(noVerdict.err, /missing evidence/);

  assert.equal(run(["evidence", id, "--kind", "review-verdict", "--producer", "reviewer-1", "--text", "looks correct", "--verdict", "approve"], dir).rc, 0);

  const noApproval = run(["accept", id, "--approver", "reviewer-1"], dir);
  assert.equal(noApproval.rc, 3);
  assert.match(noApproval.err, /no approval recorded/);

  // A coordinator identity may not approve.
  const wrongApprover = run(["approve", id, "--approver", "coordinator", "--role", "coordinator"], dir);
  assert.equal(wrongApprover.rc, 3);
  assert.match(wrongApprover.err, /may not approve/);

  assert.equal(run(["approve", id, "--approver", "reviewer-1", "--role", "reviewer"], dir).rc, 0);

  const accepted = run(["accept", id, "--approver", "reviewer-1"], dir);
  assert.equal(accepted.rc, 0, accepted.err);
  assert.match(accepted.out, /stage\s+done/);
  assert.match(accepted.out, /health\s+COMPLETE/);

  const status = run(["status", id, "--json"], dir);
  assert.equal(status.rc, 0);
  const parsed = JSON.parse(status.out);
  assert.equal(parsed.stage, "done");
  assert.equal(parsed.status, "accepted");
  assert.ok(parsed.history.length >= 5, "history must record every transition");

  assert.equal(run(["verify", id], dir).rc, 0);

  // Tampered evidence invalidates the run: verify fails and acceptance is gone.
  fs.writeFileSync(diffFile, "diff --git a/x b/x\n+tampered\n");
  const tampered = run(["verify", id], dir);
  assert.equal(tampered.rc, 4, "a changed evidence file must fail verification");
  assert.match(tampered.err, /content changed/);
});

test("unknown mode and missing run are usage/state errors, not crashes", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "orch-cli-"));
  const badMode = run(["start", "task", "--mode", "swarm"], dir);
  assert.equal(badMode.rc, 2, "an unknown mode is a usage error");
  assert.match(badMode.err, /unknown mode/);

  const noRuns = run(["status"], dir);
  assert.equal(noRuns.rc, 4);
  assert.match(noRuns.err, /no runs recorded/);

  assert.equal(run(["modes"], dir).rc, 0);
});

test("pause, resume and stop are reflected in status and refused when terminal", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "orch-cli-"));
  const id = runId(run(["start", "lifecycle", "--mode", "solo"], dir).out);

  assert.equal(run(["pause", id, "--reason", "waiting"], dir).rc, 0);
  assert.match(run(["status", id], dir).out, /status paused/);

  assert.equal(run(["resume", id, "--reason", "go"], dir).rc, 0);
  assert.match(run(["status", id], dir).out, /status running/);

  assert.equal(run(["stop", id, "--reason", "operator cancelled"], dir).rc, 0);
  const afterStop = run(["status", id], dir);
  assert.match(afterStop.out, /status failed/);
  assert.equal(run(["history", id], dir).rc, 0);
});
