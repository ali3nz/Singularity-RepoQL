// tests/harness-config-schema.test.mjs — the config surfaces callers read.
//
// kit/config.json is the engine's configuration (schemaVersion 3). Its top-level
// keys are frozen so a portable profile cannot silently grow or lose a section:
// the engine still reads every one of them.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(fileURLToPath(new URL("../", import.meta.url)));
const readJson = (rel) => JSON.parse(readFileSync(join(ROOT, rel), "utf8"));

const ENGINE_KEYS = [
  "cache", "claude", "claudeDisabled", "codex", "concurrency", "consult", "context",
  "cursor", "custom", "deployGate", "effort", "fccGhost", "freeModels",
  "freeOnly", "freebucks", "githubSync", "managedWorker", "maxPairSessionsPerDay",
  "maxReviewRounds", "memoryOrchestra", "memoryProvenance", "openaiSol", "opencode",
  "openrouter", "phaseDriver", "phaseTimeoutMinutes", "pollSeconds", "projectPath",
  "projectionCoverage", "quad", "risk", "routing", "schemaVersion", "sessionReuseMinutes",
  "v34", "workerModel", "workerModelNote", "workerTransport", "workers",
];

test("engine config keeps schemaVersion 3", () => {
  const cfg = readJson("harness/kit/config.json");
  assert.equal(cfg.schemaVersion, 3);
});

test("engine config keeps exactly its documented top-level keys", () => {
  const cfg = readJson("harness/kit/config.json");
  assert.deepEqual(Object.keys(cfg).sort(), [...ENGINE_KEYS].sort());
});

test("the harness config declares the mapping table explicitly", () => {
  const cfg = readJson("harness/harness.config.json");
  assert.equal(cfg.schemaVersion, 1);
  assert.equal(cfg.profile, "portable-harness");
  assert.ok(Array.isArray(cfg.mapping.table) && cfg.mapping.table.length >= 3);
  for (const entry of cfg.mapping.table) {
    assert.equal(typeof entry.id, "string");
    assert.equal(typeof entry.container, "string");
    assert.ok(entry.container.startsWith("/"), `${entry.id}: container path must be absolute`);
    assert.ok("hostEnv" in entry, `${entry.id}: hostEnv must be declared (even when null)`);
  }
  assert.deepEqual(cfg.mapping.table.map((e) => e.id).sort(), ["hubDocs", "kit", "workspace"]);
});

test("every optional feature is declared, and defaulted off", () => {
  const cfg = readJson("harness/harness.config.json");
  for (const feature of ["repoql", "openchamberWatch"]) {
    assert.ok(cfg.features[feature], `features.${feature} missing`);
    assert.equal(cfg.features[feature].enabled, false, `features.${feature} must default off in the portable profile`);
  }
});

test("the RepoQL scope registry is portable, not a fleet's published repos", () => {
  const scopes = readJson("harness/kit/config/repoql-scopes.json");
  assert.equal(typeof scopes.scopes, "object");
  const text = JSON.stringify(scopes);
  assert.ok(!/github:\/\//.test(text), "scope registry must not pin an external GitHub import");
  assert.ok(!/\/home\/[^/]+\//.test(text), "scope registry must not name a home path");
});

test("the engine config carries no host-specific paths or subscription entitlements", () => {
  const text = readFileSync(join(ROOT, "harness/kit/config.json"), "utf8");
  for (const forbidden of ["/home/operator", "controller", "webserver", "\"opencode-go/", "m-096e75164d"]) {
    assert.ok(!text.includes(forbidden), `engine config still names ${forbidden}`);
  }
});
