// Regression tests for the attach flow (installation options 3 and 4).
//
// The attach runs against an EXISTING OpenChamber instance. It must never
// destroy the target's own identity: its AGENTS.md, its opencode.jsonc (with
// a pre-existing RepoQL MCP entry) and its dcp.jsonc are preserved, while the
// product's version is kept for a deliberate merge. The package's own
// compose-managed config dir is not a foreign target: there the product owns
// the files.
//
// Security (B7): an ADMINISTRATIVE credential is never propagated into a
// target — it is refused in process and the option is reported INCOMPLETE.
//
// Undo (N-g): every attach records a manifest of the files it created or
// replaced (with the before-hashes), and the supported `rollback` entrypoint
// restores exactly those files, refuses foreign edits and is idempotent.
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import {
  planBundleFiles, applyBundle, attachMain, rollbackAttach,
  classifyCandidateKey, isSameSecret, readAdminKey,
} from "./attach-openchamber.mjs";

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

/** Run the attach with the console captured. */
async function runAttach(args) {
  const out = [];
  const origLog = console.log, origWarn = console.warn;
  console.log = (...a) => { out.push(a.join(" ")); };
  console.warn = (...a) => { out.push(a.join(" ")); };
  let rc = 0;
  try {
    rc = await attachMain(args);
  } finally {
    console.log = origLog;
    console.warn = origWarn;
  }
  return { rc, out: out.join("\n") };
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

  // the product's version of a preserved file is kept for a deliberate merge:
  // it is recorded as productCopy (a preserved file has no backupPath)
  const kept = res.changed.find((c) => c.rel === "AGENTS.md");
  assert.ok(kept && kept.productCopy && existsSync(kept.productCopy), "the product's copy is kept next to the backup");
  assert.ok(readFileSync(kept.productCopy, "utf8").length > 0);
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

// ── B7: the admin key is never propagated ────────────────────────────────────

test("the admin key is recognised in process and refused as a plugin credential (B7)", () => {
  const admin = "sk-admin-key-for-the-test";
  assert.equal(classifyCandidateKey(admin, { adminKey: admin }).class, "admin");
  assert.equal(classifyCandidateKey("sk-business-key", { adminKey: admin }).class, "scoped");
  assert.equal(classifyCandidateKey("", { adminKey: admin }).class, "none");
  assert.equal(classifyCandidateKey("sk-system-root", { adminKey: "other" }).class, "admin");
  assert.equal(isSameSecret(admin, admin), true);
  assert.equal(isSameSecret(admin, "sk-admin-key-for-the-tes"), false);
  assert.equal(isSameSecret(admin, "x"), false);
  assert.equal(isSameSecret("", "x"), false);
});

test("an explicit scoped key is provisioned into the target and never printed (B7)", async () => {
  const dir = seededTarget();
  const scoped = "sk-scoped-business-key";
  const { rc, out } = await runAttach(["--config-dir", dir, "--variant", "3", "--memory-user-key", scoped]);
  assert.equal(rc, 0, out);
  const memPath = join(dir, "product-secrets", "memory.json");
  assert.ok(existsSync(memPath), "the target's plugin memory.json is provisioned");
  const mem = JSON.parse(readFileSync(memPath, "utf8"));
  assert.equal(mem.userKey, scoped, "the scoped key is the target's plugin credential");
  assert.ok(!out.includes(scoped), "the key must never be printed");
  rmSync(dir, { recursive: true, force: true });
});

test("the ADMIN key is never written into a target (B7)", async () => {
  const admin = readAdminKey();
  if (!admin) {
    // no admin key in this checkout: prove the refusal with the classifier
    assert.equal(classifyCandidateKey("sk-system_admin", { adminKey: "" }).class, "admin");
    return;
  }
  const dir = seededTarget();
  const { rc, out } = await runAttach(["--config-dir", dir, "--variant", "3", "--memory-user-key", admin]);
  assert.equal(rc, 5, "an administrative credential must leave the option INCOMPLETE");
  assert.match(out, /ADMINISTRATIVE|administrative/);
  assert.ok(!out.includes(admin), "the admin key must never be printed");
  const memPath = join(dir, "product-secrets", "memory.json");
  if (existsSync(memPath)) {
    const mem = JSON.parse(readFileSync(memPath, "utf8"));
    assert.ok(!mem.userKey || !isSameSecret(mem.userKey, admin),
      "the admin key must never land in the target's plugin configuration");
  }
  rmSync(dir, { recursive: true, force: true });
});

test("without a scoped key the attach reports INCOMPLETE and writes no credential (B7)", async () => {
  const dir = seededTarget();
  const { rc, out } = await runAttach(["--config-dir", dir, "--variant", "3", "--memory-user-key", ""]);
  assert.equal(rc, 5, "no scoped key means the memory capability is INCOMPLETE");
  assert.match(out, /memory user key|INCOMPLETE/);
  const memPath = join(dir, "product-secrets", "memory.json");
  if (existsSync(memPath)) {
    const mem = JSON.parse(readFileSync(memPath, "utf8"));
    const admin = readAdminKey();
    assert.ok(!mem.userKey || !isSameSecret(mem.userKey, admin), "no administrative credential is written");
  }
  rmSync(dir, { recursive: true, force: true });
});

// ── N-g: the supported rollback ───────────────────────────────────────────────

test("the attach records a manifest and the rollback restores exactly what the attach wrote (N-g)", async () => {
  const dir = seededTarget();
  // a conflicting product file (not a preserved identity file) → a replace
  writeFileSync(join(dir, "package.json"), "{\"mine\":true}\n");
  const { rc, out } = await runAttach(["--config-dir", dir, "--variant", "3", "--memory-user-key", "sk-scoped-business-key"]);
  assert.equal(rc, 0, out);
  const m = out.match(/manifest\s+(\S+MANIFEST\.json)/);
  assert.ok(m, `the attach must report its manifest (got: ${out})`);
  const manifestPath = m[1];
  const backupDir = dirname(manifestPath);
  const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
  assert.ok(manifest.files.length > 0, "the manifest lists the files the attach touched");
  const created = manifest.files.find((f) => f.status === "create");
  const replaced = manifest.files.find((f) => f.status === "replace");
  assert.ok(created && created.afterSha, "a created file is recorded with its after-hash");
  assert.ok(replaced && replaced.prevSha && replaced.backupPath, "a replaced file is recorded with its before-hash");

  // The shared policy runtime is a first-class plugin dependency of the attach:
  // byte-identical copies land in <config>/singularity-runtime/scripts/ so the
  // plugin's deterministic import resolves in the FOREIGN target runtime.
  const runtimeFiles = manifest.files.filter((f) => f.rel.startsWith("plugins/singularity-runtime/scripts/"));
  assert.equal(runtimeFiles.length, 4, "doc-policy.mjs, its selflearn-candidates.mjs dependency, memory-doc-ingest.py and its sibling memory_client.py are carried into the target");
  for (const name of ["doc-policy.mjs", "selflearn-candidates.mjs", "memory-doc-ingest.py", "memory_client.py"]) {
    const dst = join(dir, "plugins", "singularity-runtime", "scripts", name);
    assert.ok(existsSync(dst), `${name} is installed into the target runtime`);
    assert.equal(
      readFileSync(dst, "utf8"),
      readFileSync(join(ROOT, "scripts", name), "utf8"),
      `${name} is a byte-identical copy of the repository's shared script`,
    );
  }

  // The WHOLE non-stdlib closure must import in the attached runtime: run the
  // actual ingestion helper's CLI from the INSTALLED copy (its Argparse banner
  // importing memory_client proves the sibling layout), not just the JS module.
  const helper = join(dir, "plugins", "singularity-runtime", "scripts", "memory-doc-ingest.py");
  const banner = spawnSync("python3", [helper, "--help"], { encoding: "utf8", timeout: 30_000 });
  assert.equal(banner.status, 0, `the installed ingestion helper must execute: ${banner.stderr}`);

  // And the plugin's deterministic candidate actually imports BOTH ways from
  // the target's installed layout (the shared sibling copy wins first).
  const targetPlugin = await import(pathToFileURL(join(dir, "plugins", "runbook-nudge", "index.js")).href);
  const trail = [];
  const attachedPolicy = await targetPlugin.loadSharedPolicy((e) => trail.push(e));
  assert.equal(typeof attachedPolicy.autoIngestChangedDocs, "function", "shared policy loads from the attached runtime");
  assert.equal([...trail].some(r => r.decision === "NUDGE-RB-DISCOVERY-MODULE"), true);

  // a foreign edit is REFUSED as a whole: the undo is all-or-nothing, so the
  // replaced file must NOT have been restored by the refused attempt either
  const original = readFileSync(created.dst, "utf8");
  const replacedBefore = readFileSync(replaced.dst, "utf8");
  writeFileSync(created.dst, "edited by the operator\n");
  const refused = rollbackAttach(backupDir);
  assert.equal(refused.ok, false, "a foreign edit must block the rollback");
  assert.ok(refused.refused.length > 0);
  assert.match(refused.refused[0], /changed since the attach/);
  assert.equal(readFileSync(created.dst, "utf8"), "edited by the operator\n", "the foreign edit is preserved");
  assert.equal(readFileSync(replaced.dst, "utf8"), replacedBefore, "a refused rollback writes nothing (all-or-nothing)");

  // undo the foreign edit → the rollback removes what the attach created and
  // restores what it replaced
  writeFileSync(created.dst, original);
  const done = rollbackAttach(backupDir);
  assert.equal(done.ok, true, done.refused.join("; "));
  assert.ok(done.removed.includes(created.rel), "the created file is removed again");
  assert.equal(existsSync(created.dst), false);
  for (const f of runtimeFiles) {
    assert.ok(done.removed.includes(f.rel), `the shared runtime copy ${f.rel} is removed again by the rollback`);
    assert.equal(existsSync(f.dst), false, `${f.rel} is gone after the rollback`);
  }
  if (replaced) {
    assert.ok(done.restored.includes(replaced.rel), "the replaced file is restored from its backup");
    assert.equal(readFileSync(replaced.dst, "utf8"), "{\"mine\":true}\n", "the pre-attach content is back");
  }

  // idempotent: a second rollback changes nothing and reports success
  const again = rollbackAttach(backupDir);
  assert.equal(again.ok, true);
  assert.equal(again.removed.length, 0);
  assert.equal(again.restored.length, 0);

  rmSync(backupDir, { recursive: true, force: true });
  rmSync(dir, { recursive: true, force: true });
});

test("a rollback without a manifest refuses to touch anything (N-g)", () => {
  const dir = mkdtempSync(join(tmpdir(), "attach-nomanifest-"));
  const r = rollbackAttach(dir);
  assert.equal(r.ok, false);
  assert.equal(r.rc, 2);
  assert.match(r.detail, /no attach manifest/);
  rmSync(dir, { recursive: true, force: true });
});
