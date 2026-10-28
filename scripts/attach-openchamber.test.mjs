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
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import {
  planBundleFiles, applyBundle, attachMain, rollbackAttach, writeAttachManifest,
  classifyCandidateKey, isSameSecret, readAdminKey,
  mergeManagedBlock, stripManagedBlock, mergeJsoncIntegration, parseJsonc,
  MANAGED_BEGIN, MANAGED_END,
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

test("a foreign target keeps its identity: AGENTS.md gains only a managed block, JSONC merges in place", () => {
  const dir = seededTarget();
  const plan = planBundleFiles(dir, BUNDLE, { preserveConflicts: true, variant: "3" });
  const byRel = Object.fromEntries(plan.map((f) => [f.rel, f.status]));
  assert.equal(byRel["AGENTS.md"], "merge-policy", "the target's AGENTS.md is merged, never overwritten");
  assert.equal(byRel["opencode.jsonc"], "merge-jsonc", "the target's opencode.jsonc is merged, never overwritten");
  assert.equal(byRel["dcp.jsonc"], "merge-jsonc", "the target's dcp.jsonc is merged, never overwritten");
  assert.equal(byRel["agents/general.md"], "create", "a missing product agent is still installed");
  assert.equal(byRel["agents/mine.md"], undefined, "an unrelated agent is not part of the bundle");

  const res = applyBundle(plan, dir, { dryRun: false });
  assert.deepEqual(res.refused, [], "a well-formed target is merged without refusal");
  const agents = readFileSync(join(dir, "AGENTS.md"), "utf8");
  assert.ok(agents.startsWith("# my own instructions\n"), "the target's own instructions stay first and intact");
  assert.ok(agents.includes(MANAGED_BEGIN) && agents.includes(MANAGED_END), "the managed policy block is merged in");
  assert.match(agents, /RepoQL/, "the managed policy carries the RepoQL-only issue-reporting rule");
  const oc = readFileSync(join(dir, "opencode.jsonc"), "utf8");
  assert.ok(oc.includes("/home/me/.local/bin/rql"), "the pre-existing RepoQL identity survives");
  assert.ok(oc.includes("// my own RepoQL identity"), "the target's comments are preserved byte-for-byte");
  assert.ok(!oc.includes("/usr/local/bin/rql"), "the product's rql path must not overwrite the target's identity");
  assert.match(oc, /"plugin"\s*:/, "the missing integration key is inserted");
  assert.ok(existsSync(join(dir, "agents", "general.md")), "the product's agent is installed");
  assert.equal(readFileSync(join(dir, "agents", "mine.md"), "utf8"), "# my agent\n", "unrelated agents are untouched");
  rmSync(res.backupDir, { recursive: true, force: true });
  rmSync(dir, { recursive: true, force: true });
});

// ── managed policy block: deterministic, idempotent, block-scoped undo ──────

test("the managed policy block is deterministic and idempotent", () => {
  const base = "# mine\n\nsome text\n";
  const a = mergeManagedBlock(base);
  assert.equal(a.ok, true);
  assert.equal(a.action, "append");
  const b = mergeManagedBlock(a.text);
  assert.equal(b.action, "unchanged", "a second merge writes nothing");
  assert.equal(b.text, a.text);
  const c = mergeManagedBlock(a.text.replace("Do not edit inside the markers.", "stale body"));
  assert.equal(c.action, "update", "a stale block is updated in place");
  assert.ok(c.text.startsWith("# mine\n\nsome text\n"), "content before the block is preserved");
  assert.equal(countOccurrences(c.text, MANAGED_BEGIN), 1, "exactly one block");
});

test("a malformed managed block is refused and the file is not modified", () => {
  const broken = `# mine\n${MANAGED_BEGIN}\nhalf a block\n`;
  const r = mergeManagedBlock(broken);
  assert.equal(r.ok, false);
  assert.match(r.reason, /malformed managed block/);
  assert.equal(r.text, broken, "the caller's text is returned unchanged for a refusal");

  const dup = `${MANAGED_BEGIN}\nx\n${MANAGED_END}\n${MANAGED_BEGIN}\ny\n${MANAGED_END}\n`;
  assert.equal(mergeManagedBlock(dup).ok, false, "two blocks are malformed, not silently chosen between");

  // through the real apply path: refusal keeps the user's file and reports it
  const dir = mkdtempSync(join(tmpdir(), "attach-badblock-"));
  writeFileSync(join(dir, "AGENTS.md"), broken);
  const plan = planBundleFiles(dir, BUNDLE, { preserveConflicts: true, variant: "3" });
  const res = applyBundle(plan, dir, { dryRun: false });
  assert.ok(res.refused.some((r) => r.includes("AGENTS.md")), "the refusal names the file");
  assert.equal(readFileSync(join(dir, "AGENTS.md"), "utf8"), broken, "the malformed file is preserved exactly");
  if (res.backupDir) rmSync(res.backupDir, { recursive: true, force: true });
  rmSync(dir, { recursive: true, force: true });
});

test("stripManagedBlock removes only the owned block, keeping appended user content", () => {
  const withBlock = mergeManagedBlock("# mine\n").text;
  const appended = `${withBlock}\n## my later note\nnever delete this\n`;
  const s = stripManagedBlock(appended);
  assert.equal(s.ok, true);
  assert.equal(s.removed, true);
  assert.ok(!s.text.includes(MANAGED_BEGIN), "the block is gone");
  assert.match(s.text, /never delete this/, "content appended after the block survives");
  assert.equal(stripManagedBlock("# plain\n").removed, false, "a file without a block is a no-op");
});

// ── JSONC merge: comment-preserving, refuse-instead-of-rewrite ──────────────

test("JSONC merge preserves comments, ordering and user values", () => {
  const before = `{
  // keep this comment
  "alpha": 1,
  /* block comment */
  "mcp": { "repoql": { "type": "local", "command": ["/custom/rql", "mcp"] } },
  "beta": "text with // not-a-comment and { brace"
}
`;
  const desired = { mcp: { repoql: { type: "local", command: ["/usr/local/bin/rql", "mcp"] } }, plugin: ["pkg@1.0.0"] };
  const r = mergeJsoncIntegration(before, desired);
  assert.equal(r.ok, true, r.reason);
  assert.ok(r.inserted.includes("plugin"));
  assert.ok(r.text.includes("// keep this comment"), "line comments survive");
  assert.ok(r.text.includes("/* block comment */"), "block comments survive");
  assert.ok(r.text.includes("/custom/rql"), "the user's existing value is NOT replaced");
  assert.ok(r.text.includes("text with // not-a-comment"), "a // inside a string is not a comment");
  const parsed = parseJsonc(r.text);
  assert.deepEqual(parsed.plugin, ["pkg@1.0.0"]);
  // idempotent
  const again = mergeJsoncIntegration(r.text, desired);
  assert.equal(again.action, "unchanged");
  assert.equal(again.text, r.text);
});

test("an unparseable JSONC target is refused, never rewritten", () => {
  const broken = '{ "alpha": 1, /* unterminated\n "beta": 2 }';
  const r = mergeJsoncIntegration(broken, { plugin: [] });
  assert.equal(r.ok, false);
  assert.match(r.reason, /not parseable JSONC/);
  assert.equal(r.text, broken, "the original bytes are returned for a refusal");

  const notObject = "[1,2,3]\n";
  assert.equal(mergeJsoncIntegration(notObject, { plugin: [] }).ok, false);

  // through the apply path: refusal is deterministic INCOMPLETE, file preserved
  const dir = mkdtempSync(join(tmpdir(), "attach-badjsonc-"));
  writeFileSync(join(dir, "opencode.jsonc"), broken);
  const plan = planBundleFiles(dir, BUNDLE, { preserveConflicts: true, variant: "3" });
  const res = applyBundle(plan, dir, { dryRun: false });
  assert.ok(res.refused.some((r) => r.includes("opencode.jsonc")));
  assert.equal(readFileSync(join(dir, "opencode.jsonc"), "utf8"), broken);
  if (res.backupDir) rmSync(res.backupDir, { recursive: true, force: true });
  rmSync(dir, { recursive: true, force: true });
});

// ── variant classification: no Ghost/Office leak into options 1/3 ───────────

test("the plan itself excludes Ghost/Office payload for options 1 and 3", () => {
  const dir = mkdtempSync(join(tmpdir(), "attach-variant-"));
  const three = planBundleFiles(dir, BUNDLE, { preserveConflicts: true, variant: "3" }).map((f) => f.rel);
  assert.ok(!three.includes("agents/ghost.md"), "option 3 must not install the Ghost agent");
  assert.ok(!three.some((r) => r.startsWith("plugins/product-office/")), "option 3 must not install the Office plugin");
  assert.ok(three.includes("agents/general.md"), "option 3 still installs the core agents");
  const four = planBundleFiles(dir, BUNDLE, { preserveConflicts: true, variant: "4" }).map((f) => f.rel);
  assert.ok(four.includes("agents/ghost.md"), "option 4 installs the Ghost agent");
  assert.ok(four.some((r) => r.startsWith("plugins/product-office/")), "option 4 installs the Office plugin");
  rmSync(dir, { recursive: true, force: true });
});

// ── foreign agent/skill conflict: deterministic namespace + ledger ──────────

test("a conflicting foreign agent is preserved and ours lands namespaced", () => {
  const dir = mkdtempSync(join(tmpdir(), "attach-ns-"));
  mkdirSync(join(dir, "agents"), { recursive: true });
  writeFileSync(join(dir, "agents", "general.md"), "# the user's own general agent\n");
  const plan = planBundleFiles(dir, BUNDLE, { preserveConflicts: true, variant: "3" });
  const entry = plan.find((f) => f.rel === "agents/general.md");
  assert.equal(entry.status, "namespace");
  assert.ok(entry.dst.endsWith(join("agents", "singularity-general.md")), "discovery-compatible name, not .md.product");
  const res = applyBundle(plan, dir, { dryRun: false });
  assert.equal(readFileSync(join(dir, "agents", "general.md"), "utf8"), "# the user's own general agent\n");
  assert.ok(existsSync(join(dir, "agents", "singularity-general.md")), "our agent is installed beside it");
  const recorded = res.changed.find((c) => c.rel === "agents/general.md");
  assert.equal(recorded.namespacedFrom, "agents/general.md", "the ledger records the mapping");
  const manifestPath = writeAttachManifest(res.backupDir, { target: { kind: "native", configDir: dir }, changed: res.changed });
  const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
  assert.equal(manifest.namespaceMap["agents/general.md"], join(dir, "agents", "singularity-general.md"));

  // repeat attach is byte-identical (the namespaced file is now "present")
  const snap = readdirRecursive(dir).map((f) => `${f} ${readFileSync(join(dir, f), "utf8")}`).join("\n");
  const second = planBundleFiles(dir, BUNDLE, { preserveConflicts: true, variant: "3" });
  assert.equal(second.find((f) => f.rel === "agents/general.md").status, "present");
  applyBundle(second, dir, { dryRun: false, backupDir: res.backupDir });
  assert.equal(readdirRecursive(dir).map((f) => `${f} ${readFileSync(join(dir, f), "utf8")}`).join("\n"), snap, "repeat attach is byte-identical");

  // rollback removes only what it created (namespaced agents), keeps foreign files
  const rb = rollbackAttach(res.backupDir);
  assert.equal(rb.ok, true, rb.refused.join("; "));
  assert.equal(existsSync(join(dir, "agents", "singularity-general.md")), false, "the namespaced agent is removed again");
  assert.equal(readFileSync(join(dir, "agents", "general.md"), "utf8"), "# the user's own general agent\n");

  // a foreign file already at the namespaced name is refused, not overwritten
  writeFileSync(join(dir, "agents", "singularity-general.md"), "# someone else's singularity-general\n");
  const third = planBundleFiles(dir, BUNDLE, { preserveConflicts: true, variant: "3" });
  assert.equal(third.find((f) => f.rel === "agents/general.md").status, "conflict");
  const res3 = applyBundle(third, dir, { dryRun: false, backupDir: res.backupDir });
  assert.ok(res3.refused.some((r) => r.includes("agents/general.md")));
  assert.equal(readFileSync(join(dir, "agents", "singularity-general.md"), "utf8"), "# someone else's singularity-general\n");
  assert.equal(readFileSync(join(dir, "agents", "general.md"), "utf8"), "# the user's own general agent\n");
  rmSync(dir, { recursive: true, force: true });
});

function countOccurrences(hay, needle) { return String(hay).split(needle).length - 1; }

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

// The package's own plugin credential (data/opencode/config/product-secrets/
// memory.json) is UNTRACKED runtime state that a development checkout can
// carry from an earlier attach. When present, the attach's fallback ("the
// package's own plugin credential") satisfies the key search and this test's
// premise — "no scoped key is available" — is false. Isolate the test from
// that ambient state for its duration; restored in every path.
test("without a scoped key the attach reports INCOMPLETE and writes no credential (B7)", async () => {
  const PKG_MEM = join(ROOT, "data", "opencode", "config", "product-secrets", "memory.json");
  const PKG_MEM_BAK = PKG_MEM + ".test-absent-bak";
  const had = existsSync(PKG_MEM);
  if (had) renameSync(PKG_MEM, PKG_MEM_BAK);
  try {
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
  } finally {
    if (had) renameSync(PKG_MEM_BAK, PKG_MEM);
  }
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

test("option 4 derives the target's ghost.json and the rollback undoes generated package secrets (job-3 findings 4-5)", async () => {
  const pkgOffice = join(ROOT, "secrets", "claude-office.env");
  const pkgGhost = join(ROOT, "secrets", "ghost.env");
  const sentinel = "CLAUDE_OFFICE_TEST_SENTINEL=keep-me\n";
  const bak = (p) => `${p}.test-bak`;
  const hadOffice = existsSync(pkgOffice), hadGhost = existsSync(pkgGhost);
  if (hadOffice) renameSync(pkgOffice, bak(pkgOffice));
  if (hadGhost) renameSync(pkgGhost, bak(pkgGhost));
  mkdirSync(join(ROOT, "secrets"), { recursive: true });
  writeFileSync(pkgOffice, sentinel);
  try {
    const dir = seededTarget();
    const scoped = "sk-scoped-ghost-derivation";
    const { rc, out } = await runAttach(["--config-dir", dir, "--variant", "4", "--with-ghost", "--memory-user-key", scoped]);
    assert.equal(rc, 0, out);

    // finding 4: the option-4 target carries the Ghost identity its wiring requires.
    const ghostPath = join(dir, "product-secrets", "ghost.json");
    assert.ok(existsSync(ghostPath), "option 4 provisions the target's ghost.json");
    const ghost = JSON.parse(readFileSync(ghostPath, "utf8"));
    assert.equal(ghost.userKey, scoped, "the Ghost identity is derived from the target's own scoped key");
    assert.ok(!out.includes(scoped), "the key is never printed");

    // finding 8: the attach records which installation option it performed.
    const m = out.match(/manifest\s+(\S+MANIFEST\.json)/);
    assert.ok(m, `the attach reports its manifest (got: ${out})`);
    const backupDir = dirname(m[1]);
    const manifest = JSON.parse(readFileSync(m[1], "utf8"));
    assert.equal(manifest.variant, "4", "the attach manifest records the installation option");
    assert.equal(manifest.files.find((f) => f.rel === "product-secrets/ghost.json")?.status, "create");
    assert.equal(manifest.files.find((f) => f.rel === "package-secrets/claude-office.env")?.status, "replace");
    assert.equal(manifest.files.find((f) => f.rel === "package-secrets/ghost.env")?.status, "create");
    assert.equal(existsSync(pkgGhost), true, "the Ghost env was generated by the attach");

    // finding 5: the supported rollback restores/removes what the attach wrote
    // OUTSIDE the target config dir too.
    const r = rollbackAttach(backupDir);
    assert.equal(r.ok, true, r.refused.join("; "));
    assert.equal(existsSync(ghostPath), false, "the rollback removes the derived ghost.json");
    assert.equal(existsSync(pkgGhost), false, "the rollback removes a generated package secret");
    assert.equal(readFileSync(pkgOffice, "utf8"), sentinel, "a pre-existing package secret is restored, not deleted");

    rmSync(backupDir, { recursive: true, force: true });
    rmSync(dir, { recursive: true, force: true });
  } finally {
    rmSync(pkgOffice, { force: true });
    rmSync(pkgGhost, { force: true });
    if (hadOffice) renameSync(bak(pkgOffice), pkgOffice);
    if (hadGhost) renameSync(bak(pkgGhost), pkgGhost);
  }
});

test("a rollback without a manifest refuses to touch anything (N-g)", () => {
  const dir = mkdtempSync(join(tmpdir(), "attach-nomanifest-"));
  const r = rollbackAttach(dir);
  assert.equal(r.ok, false);
  assert.equal(r.rc, 2);
  assert.match(r.detail, /no attach manifest/);
  rmSync(dir, { recursive: true, force: true });
});
