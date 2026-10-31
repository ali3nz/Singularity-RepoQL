// tests/harness-paths.test.mjs — resolved-path assertions for the mapping table.
//
// lib/kit-paths.mjs is the only place that answers "where does this host keep X".
// These assertions pin the translation contract with a synthetic config, so a
// future edit cannot quietly reintroduce a literal path or an eager probe.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { spawnSync } from "node:child_process";

const ROOT = resolve(fileURLToPath(new URL("../", import.meta.url)));
const MODULE = join(ROOT, "harness", "kit", "lib", "kit-paths.mjs");

/** Resolve kit-paths in a child process so the synthetic config is what it loads. */
function resolveWith(config, env = {}) {
  const dir = mkdtempSync(join(tmpdir(), "harness-paths-"));
  const cfg = join(dir, "harness.config.json");
  writeFileSync(cfg, JSON.stringify(config, null, 2));
  const script = `
    const m = await import(${JSON.stringify(pathToFileURL(MODULE).href)});
    const p = m.HARNESS_PATHS;
    process.stdout.write(JSON.stringify({
      kitRoot: p.kitRoot,
      runsDir: p.runsDir,
      configPath: p.configPath,
      kitHostRoot: p.kitHostRoot,
      workspaceHost: p.workspaceHost,
      hubDocsDir: p.hubDocsDir,
      toContainer: p.toContainerPath("/srv/ws/work"),
      toContainerMiss: p.toContainerPath("/unmapped/path"),
      toHost: m.toHostPath(p.kitRoot + "/lib/kit-paths.mjs"),
      toHostUnmapped: m.toHostPath("/anywhere/file.mjs", { hostRoot: null }),
      openchamber: p.openchamber,
      repoqlProbe: p.repoqlStatusProbe(),
      validateInside: p.validateStateDir(${JSON.stringify(join(ROOT, "harness", "kit", "runs"))}),
      validateDotState: p.validateStateDir(${JSON.stringify(join(ROOT, "harness", "kit", "..state"))}),
      validateDots: p.validateStateDir(${JSON.stringify(join(ROOT, "harness", "kit", "..."))}),
      validateSibling: p.validateStateDir(${JSON.stringify(join(ROOT, "harness", "kit-sibling"))}),
      validateOutside: p.validateStateDir("/var/tmp/other-harness-runs"),
    }));`;
  const r = spawnSync(process.execPath, ["--input-type=module", "-e", script], {
    encoding: "utf8",
    timeout: 60_000,
    env: { ...process.env, HARNESS_CONFIG: cfg, ORCH_STATE_DIR: "", ...env },
  });
  rmSync(dir, { recursive: true, force: true });
  assert.equal(r.status, 0, r.stderr);
  return JSON.parse(r.stdout);
}

const SYNTHETIC = {
  schemaVersion: 1,
  profile: "portable-harness",
  mapping: {
    table: [
      { id: "kit", container: "/srv/kit", hostEnv: "TEST_HOST_KIT", hostDefault: null },
      { id: "workspace", container: "/workspace", hostEnv: "TEST_HOST_WS", hostDefault: null },
      { id: "hubDocs", container: "/docs", hostEnv: "TEST_HOST_DOCS", hostDefault: null },
    ],
  },
  features: {
    repoql: { enabled: false, bin: null, cwd: null, hostId: "portable-harness", scopes: { concepts: "concept:///**" } },
    openchamberWatch: { enabled: false, sshHost: null, chatsRoot: null, opencodeDb: null, haConfig: null },
    hubDocs: { dir: null },
  },
  rustAuthority: { mode: "dormant", protocolVersion: 1 },
};

test("an unmapped host makes translation identity, never a guess", () => {
  const p = resolveWith(SYNTHETIC);
  assert.equal(p.workspaceHost, "");
  assert.equal(p.kitHostRoot, null);
  assert.equal(p.toContainer, "/srv/ws/work");
  assert.equal(p.toHostUnmapped, "/anywhere/file.mjs");
  assert.equal(p.hubDocsDir, null);
});

test("a mapped host translates both ways", () => {
  const p = resolveWith(SYNTHETIC, { TEST_HOST_WS: "/srv/ws", TEST_HOST_KIT: "/srv/host-kit", TEST_HOST_DOCS: "/srv/docs" });
  assert.equal(p.workspaceHost, "/srv/ws");
  assert.equal(p.kitHostRoot, "/srv/host-kit");
  assert.equal(p.hubDocsDir, "/srv/docs");
  assert.equal(p.toContainer, "/workspace/work");
  assert.equal(p.toContainerMiss, "/unmapped/path");
  assert.equal(p.toHost.replaceAll("\\", "/"), "/srv/host-kit/lib/kit-paths.mjs");
});

test("the engine owns its state root under the kit home", () => {
  const p = resolveWith(SYNTHETIC);
  assert.equal(p.runsDir, join(p.kitRoot, "runs"));
  assert.equal(p.validateInside.ok, false);
  assert.equal(p.validateInside.code, "STATE_DIR_INSIDE_KIT");
  assert.equal(p.validateOutside.ok, true);
});

test("dot-prefixed child names stay inside, and only a true sibling is outside", () => {
  const p = resolveWith(SYNTHETIC);
  for (const [name, result] of [["..state", p.validateDotState], ["...", p.validateDots]]) {
    assert.equal(result.ok, false, `${name} is a child name inside the kit`);
    assert.equal(result.code, "STATE_DIR_INSIDE_KIT", `${name} must use the inside guard`);
  }
  assert.equal(p.validateSibling.ok, true, "../kit-sibling is a true sibling lane, not a child name");
});

test("unconfigured optional features report unavailable, without probing", () => {
  const p = resolveWith(SYNTHETIC);
  assert.equal(p.openchamber.available, false);
  assert.match(p.openchamber.unavailableReason, /not configured/);
  assert.equal(p.repoqlProbe, null);
});

test("a configured-but-missing binary is still unavailable, not an attempted call", () => {
  const p = resolveWith(
    { ...SYNTHETIC, features: { ...SYNTHETIC.features, repoql: { ...SYNTHETIC.features.repoql, enabled: true, bin: "/nonexistent/rql" } } },
  );
  assert.equal(p.repoqlProbe, null);
});

test("the shipped harness config is the one the engine actually loads", () => {
  const p = resolveWith(SYNTHETIC);
  assert.match(p.configPath, /harness\.config\.json$/);
  assert.match(p.kitRoot, /harness[\\/]kit$/);
});
