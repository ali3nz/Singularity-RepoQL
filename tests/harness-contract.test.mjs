// tests/harness-contract.test.mjs — frozen contract for the portable harness.
//
// These are the promises a caller of `bin/ai-orchestra` may rely on:
//   * `help` / `--help` print the operator reference and exit 0;
//   * an unknown verb or no verb prints the usage line and exits non-zero;
//   * `status` on an empty state root says "No current run" and exits non-zero;
//   * the verb surface the help text advertises stays advertised.
// Nothing here needs a provider, a model, RepoQL, ssh or the network.
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, cpSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(fileURLToPath(new URL("../", import.meta.url)));
const LAUNCHER = join(ROOT, "bin", "ai-orchestra");
const FIXTURE = join(ROOT, "tests", "fixtures", "harness-help.txt");

/** Run the launcher with an isolated kit home so the repo tree is never written to. */
function runLauncher(args, { env = {}, kitHome } = {}) {
  const home = kitHome ?? mkdtempSync(join(tmpdir(), "harness-kit-"));
  if (!kitHome) cpSync(join(ROOT, "harness", "kit"), home, { recursive: true });
  const r = spawnSync(process.execPath, [LAUNCHER, ...args], {
    encoding: "utf8",
    timeout: 120_000,
    env: { ...process.env, ORCHESTRA_KIT_HOME: home, ...env },
  });
  return { ...r, home };
}

test("help prints the operator reference and exits 0", () => {
  const r = runLauncher(["help"]);
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /AI ORCHESTRA — OPERATOR COMMANDS/);
  rmSync(r.home, { recursive: true, force: true });
});

test("--help is identical to help (one reference text, not two)", () => {
  const a = runLauncher(["help"]);
  const b = runLauncher(["--help"]);
  assert.equal(b.status, 0, b.stderr);
  assert.equal(b.stdout, a.stdout);
  rmSync(a.home, { recursive: true, force: true });
  rmSync(b.home, { recursive: true, force: true });
});

test("the help text matches the frozen fixture", () => {
  const r = runLauncher(["help"]);
  assert.equal(r.status, 0, r.stderr);
  assert.ok(existsSync(FIXTURE), `missing fixture ${FIXTURE}`);
  assert.equal(r.stdout, readFileSync(FIXTURE, "utf8"));
  rmSync(r.home, { recursive: true, force: true });
});

test("the advertised verb surface stays advertised", () => {
  const r = runLauncher(["help"]);
  const VERBS = [
    "start", "ask", "consult", "plan", "status", "resume", "stop", "salvage",
    "selftest", "engines", "updates", "nanny", "reset", "harvest", "watch",
    "supervise", "quality",
  ];
  for (const verb of VERBS) {
    assert.ok(new RegExp(`\\b${verb}\\b`).test(r.stdout), `help text no longer mentions the ${verb} verb`);
  }
  rmSync(r.home, { recursive: true, force: true });
});

test("an unknown verb is refused with the usage line and a non-zero exit", () => {
  const r = runLauncher(["definitely-not-a-verb"]);
  assert.notEqual(r.status, 0);
  assert.match(`${r.stdout}${r.stderr}`, /Usage: bun orchestrate\.mjs/);
  rmSync(r.home, { recursive: true, force: true });
});

test("no verb is refused the same way (never a silent success)", () => {
  const r = runLauncher([]);
  assert.notEqual(r.status, 0);
  assert.match(`${r.stdout}${r.stderr}`, /Usage: bun orchestrate\.mjs/);
  rmSync(r.home, { recursive: true, force: true });
});

test("status on an empty state root reports honestly instead of inventing a run", () => {
  const r = runLauncher(["status"]);
  assert.notEqual(r.status, 0);
  const output = `${r.stdout}${r.stderr}`;
  if (process.platform === "win32") {
    // Native Windows has no POSIX owner probe: the launcher must fail closed
    // rather than pretend an empty state root is a clean status.
    assert.match(output, /NATIVE_WINDOWS_AUTHORITY_REQUIRED/);
    assert.doesNotMatch(output, /current run:\s*\S+|run id\s*[:=]\s*\S+/i);
  } else {
    assert.match(output, /No current run/i);
  }
  rmSync(r.home, { recursive: true, force: true });
});

test("the launcher adds no verbs of its own", () => {
  const src = readFileSync(LAUNCHER, "utf8");
  assert.ok(!/process\.argv\.slice\(2\)\.(unshift|splice|push)/.test(src), "launcher rewrites the caller's argv");
  assert.ok(!/case\s+["'](start|status|help)["']/.test(src), "launcher dispatches verbs itself");
});
