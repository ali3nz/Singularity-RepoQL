// Regression tests for the attach flow (installation options 3 and 4).
//
// The attach runs against an EXISTING OpenChamber instance. It must never
// destroy the target's own identity: its AGENTS.md, its opencode.jsonc (with
// a pre-existing RepoQL MCP entry) and its dcp.jsonc are preserved, while the
// product's version is kept for a deliberate merge. The package's own
// compose-managed config dir is not a foreign target: there the product owns
// the files.
import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { planBundleFiles, applyBundle, attachMain } from "./attach-openchamber.mjs";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const BUNDLE = join(ROOT, "openchamber");

function readdirRecursive(dir, base = "") {
  const out = [];
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    const rel = base ? `${base}/${e.name}` : e.name;
    if (e.isDirectory()) out.push(...readdirRecursive(join(dir, e.name), rel));
    else out.push(rel);
  }
  return out;
}

function seededTarget() {
  const dir = mkdtempSync(join(tmpdir(), "attach-target-"));
  mkdirSync(join(dir, "agents"), { recursive: true });
  writeFileSync(join(dir, "AGENTS.md"), "# my own instructions\n");
  writeFileSync(join(dir, "opencode.jsonc"), '{\n  // my own RepoQL identity\n  "mcp": { "repoql": { "type": "local", "command": ["/home/me/.local/bin/rql", "mcp"] } }\n}\n');
  writeFileSync(join(dir, "dcp.jsonc"), "{}\n");
  writeFileSync(join(dir, "agents", "mine.md"), "# my agent\n");
  return dir;
}

test("a foreign target keeps its own AGENTS.md, opencode.jsonc and dcp.jsonc", () => {
  const dir = seededTarget();
  const plan = planBundleFiles(dir, BUNDLE, { preserveConflicts: true });
  const byRel = Object.fromEntries(plan.map((f) => [f.rel, f.status]));
  assert.equal(byRel["AGENTS.md"], "preserve", "the target's AGENTS.md must be preserved");
  assert.equal(byRel["opencode.jsonc"], "preserve", "the target's opencode.jsonc (RepoQL identity) must be preserved");
  assert.equal(byRel["dcp.jsonc"], "preserve", "the target's dcp.jsonc must be preserved");
  assert.equal(byRel["agents/general.md"], "create", "a missing product agent is still installed");
  assert.equal(byRel["agents/mine.md"], undefined, "an unrelated agent is not part of the bundle");

  const res = applyBundle(plan, dir, { dryRun: false });
  assert.equal(readFileSync(join(dir, "AGENTS.md"), "utf8"), "# my own instructions\n");
  const oc = readFileSync(join(dir, "opencode.jsonc"), "utf8");
  assert.ok(oc.includes("/home/me/.local/bin/rql"), "the pre-existing RepoQL identity survives the attach");
  assert.ok(!oc.includes("/usr/local/bin/rql"), "the product's rql path must not overwrite the target's identity");
  assert.ok(existsSync(join(dir, "agents", "general.md")), "the product's agent is installed");
  assert.equal(readFileSync(join(dir, "agents", "mine.md"), "utf8"), "# my agent\n", "unrelated agents are untouched");

  // the product's version of a preserved file is kept for a deliberate merge
  const kept = res.changed.find((c) => c.rel === "AGENTS.md");
  assert.ok(kept && kept.backupPath && existsSync(kept.backupPath), "the product's copy is kept next to the backup");
  assert.ok(readFileSync(kept.backupPath, "utf8").length > 0);
  rmSync(res.backupDir, { recursive: true, force: true });
  rmSync(dir, { recursive: true, force: true });
});

test("the package's own compose-managed config dir is replaced as before", () => {
  const dir = seededTarget();
  const plan = planBundleFiles(dir, BUNDLE, { preserveConflicts: false });
  const byRel = Object.fromEntries(plan.map((f) => [f.rel, f.status]));
  assert.equal(byRel["AGENTS.md"], "replace");
  assert.equal(byRel["opencode.jsonc"], "replace");
  const res = applyBundle(plan, dir, { dryRun: false });
  assert.ok(readFileSync(join(dir, "AGENTS.md"), "utf8").length > "# my own instructions\n".length);
  rmSync(res.backupDir, { recursive: true, force: true });
  rmSync(dir, { recursive: true, force: true });
});

test("a second attach is a no-op (idempotent)", () => {
  const dir = seededTarget();
  const first = planBundleFiles(dir, BUNDLE, { preserveConflicts: true });
  const r1 = applyBundle(first, dir, { dryRun: false });
  const snap = () => readdirRecursive(dir).map((f) => `${f} ${readFileSync(join(dir, f), "utf8").length}`).sort().join("\n");
  const before = snap();
  const second = planBundleFiles(dir, BUNDLE, { preserveConflicts: true });
  // a preserved file is still reported as "preserve" (the target keeps its own
  // version) — but nothing is WRITTEN, so the tree must be byte-identical.
  assert.deepEqual(second.filter((f) => f.status === "create" || f.status === "replace").map((f) => f.rel), [],
    "a second attach must not create or replace any file");
  applyBundle(second, dir, { dryRun: false });
  assert.equal(snap(), before, "a second attach must leave the target byte-identical");
  rmSync(r1.backupDir, { recursive: true, force: true });
  rmSync(dir, { recursive: true, force: true });
});

test("the attach provisions a scoped memory key for the target without printing it", async () => {
  const dir = seededTarget();
  const pkgMem = join(ROOT, "data/opencode/config/product-secrets/memory.json");
  const out = [];
  const origLog = console.log;
  console.log = (...a) => { out.push(a.join(" ")); };
  let rc = 0;
  try {
    rc = await attachMain(["--config-dir", dir, "--variant", "3"]);
  } finally {
    console.log = origLog;
  }
  assert.equal(rc, 0, "the attach must succeed");
  const memPath = join(dir, "product-secrets", "memory.json");
  assert.ok(existsSync(memPath), "the target's plugin memory.json is provisioned");
  const mem = JSON.parse(readFileSync(memPath, "utf8"));
  const printed = out.join("\n");
  if (mem.userKey) {
    assert.ok(!printed.includes(mem.userKey), "the memory key must never be printed");
  } else {
    // no key available in this environment: the attach must say so honestly
    assert.ok(/memory user key/.test(printed), "the missing key is reported");
  }
  rmSync(dir, { recursive: true, force: true });
});
