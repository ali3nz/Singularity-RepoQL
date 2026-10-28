// tests/harness-guard.test.mjs — the guards that keep the export honest.
//
//   1. single engine authority: the SHIPPED tree carries no run state at all;
//   2. run-id separation: a caller's ORCH_STATE_DIR may not point inside the
//      engine home, so portable-harness run ids cannot overlap another lane's;
//   3. path debt is reported, not hidden: the four engine modules named by the
//      export carry no fleet literal, and the debt list in docs/HARNESS.md must
//      match the files that still do.
//
// "Shipped" is what a release archive would contain: tracked files plus
// untracked files that are not gitignored. The engine creates <kit home>/runs on
// first use — runtime state, gitignored, never shipped — so guarding the live
// working directory instead of the ship set would fail on a developer's machine
// while shipping nothing wrong.
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(fileURLToPath(new URL("../", import.meta.url)));
const KIT = join(ROOT, "harness", "kit");
const LAUNCHER = join(ROOT, "bin", "ai-orchestra");

function walk(dir, out = []) {
  for (const name of readdirSync(dir)) {
    if (name === ".git" || name === "node_modules") continue;
    const p = join(dir, name);
    const st = statSync(p);
    if (st.isDirectory()) walk(p, out);
    else out.push(p);
  }
  return out;
}

/** Every path a release archive would contain, as absolute paths. */
function shippedFiles() {
  const git = spawnSync("git", ["-C", ROOT, "rev-parse", "--is-inside-work-tree"], { encoding: "utf8" });
  if (git.status === 0 && git.stdout.trim() === "true") {
    const listing = (args) =>
      spawnSync("git", ["-C", ROOT, ...args], { encoding: "utf8", maxBuffer: 128 * 1024 * 1024 }).stdout ?? "";
    const all = `${listing(["ls-files", "-z"])}\0${listing(["ls-files", "-z", "-o", "--exclude-standard"])}`;
    return [...new Set(all.split("\0").filter(Boolean))].map((rel) => join(ROOT, rel));
  }
  return walk(ROOT); // unpacked archive: no git metadata, the tree IS the ship set
}

const SHIPPED = shippedFiles();
const SHIPPED_KIT = SHIPPED.filter((f) => f.startsWith(KIT + sep));

const isText = (f) => {
  try {
    return !readFileSync(f, "utf8").includes("\u0000");
  } catch {
    return false;
  }
};
const KIT_TEXT = SHIPPED_KIT.filter(isText);

test("the shipped engine tree carries no runtime state", () => {
  for (const forbidden of ["runs", "state", "audits", "evidence", "bundle", "consultations", "testout", "tmp", "tmp-consult", ".orch"]) {
    const prefix = join(KIT, forbidden) + sep;
    const inside = SHIPPED_KIT.filter((f) => f.startsWith(prefix));
    assert.deepEqual(inside, [], `harness/kit must not ship a ${forbidden}/ directory (${inside.length} shipped file(s))`);
  }
});

test("no run id, ledger or lock can be shipped inside the engine home", () => {
  const suspicious = SHIPPED_KIT.filter((f) => /(^|\/)(CURRENT|COORDINATOR\.lock|run-ledger\.jsonl|engine-usage\.jsonl)$/.test(f));
  assert.deepEqual(suspicious, [], `state files inside the engine home: ${suspicious.join(", ")}`);
});

test("the launcher refuses a state dir inside the engine home", () => {
  const kit = join(ROOT, "harness", "kit");
  const r = spawnSync(process.execPath, [LAUNCHER, "status"], {
    encoding: "utf8",
    timeout: 60_000,
    env: { ...process.env, ORCHESTRA_KIT_HOME: kit, ORCH_STATE_DIR: join(kit, "portable-runs") },
  });
  assert.equal(r.status, 2, `${r.stdout}${r.stderr}`);
  assert.match(r.stderr, /run ids from different harnesses must not overlap/);
});

test("the launcher accepts a state dir outside the engine home and says whose it is", () => {
  const kit = join(ROOT, "harness", "kit");
  const outside = join(ROOT, ".harness-guard-tmp");
  const r = spawnSync(process.execPath, [LAUNCHER, "status"], {
    encoding: "utf8",
    timeout: 60_000,
    env: { ...process.env, ORCHESTRA_KIT_HOME: kit, ORCH_STATE_DIR: outside },
  });
  assert.notEqual(r.status, 2, r.stderr);
  assert.match(r.stderr, /is another harness lane/);
});

test("the exported path authority carries no fleet literal at all", () => {
  const text = readFileSync(join(KIT, "lib", "kit-paths.mjs"), "utf8");
  for (const forbidden of ["/home/operator", "controller", "webserver", "/workspace/work/"]) {
    assert.ok(!text.includes(forbidden), `lib/kit-paths.mjs still contains ${forbidden}`);
  }
});

test("no engine module assigns a fleet path literal any more", () => {
  const ENGINE_MODULES = ["orchestrate.mjs", "lib/kit-paths.mjs", "lib/openchamber-watch.mjs", "lib/repoql-client.mjs"];
  for (const rel of ENGINE_MODULES) {
    const text = readFileSync(join(KIT, rel), "utf8");
    const assigns = text.split("\n").filter((line) => /^\s*(const|let|var)\s+[\w$.]+\s*=\s*["'`]\/home\/[A-Za-z0-9._-]+\//.test(line));
    assert.deepEqual(assigns, [], `${rel} still assigns a fleet path literal`);
  }
});

test("docs/HARNESS.md documents the run-lane separation and the portability debt", () => {
  const doc = readFileSync(join(ROOT, "docs", "HARNESS.md"), "utf8");
  assert.match(doc, /portable-harness run/i);
  assert.match(doc, /ORCH_STATE_DIR/);
  assert.match(doc, /Portability debt/i);

  // Counted over shipped TEXT files only, so a stale byte-code file or a build
  // artefact can never move the number.
  const TOKENS = ["/home/operator", "controller"];
  const residual = KIT_TEXT.filter((f) => {
    const t = readFileSync(f, "utf8");
    return TOKENS.some((x) => t.includes(x));
  });
  const occurrenceCount = residual.reduce((n, f) => {
    const t = readFileSync(f, "utf8");
    return n + TOKENS.reduce((m, x) => m + (t.split(x).length - 1), 0);
  }, 0);

  const match = doc.match(/Portability debt:\s*(\d+)\s+files \((\d+)\s+occurrences\)/);
  assert.ok(match, "docs/HARNESS.md must state the portability debt as 'Portability debt: N files (M occurrences)'");
  assert.equal(Number(match[1]), residual.length, `debt drifted: docs say ${match[1]} files, tree has ${residual.length}`);
  assert.equal(Number(match[2]), occurrenceCount, `debt drifted: docs say ${match[2]} occurrences, tree has ${occurrenceCount}`);
});
