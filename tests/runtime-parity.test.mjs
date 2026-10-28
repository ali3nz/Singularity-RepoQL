#!/usr/bin/env node
// Runtime-parity checks for the ported live runtime.
//
// These assert the promises the documentation makes, against the files
// themselves: upstream stays byte-exact, every overlay is pinned by hash, the
// capture consumer is disabled by default and identity-free, the connectors
// grant only what their README claims, the Ghost prompt store is generic, the
// compose override is additive and loopback-only, and no live fleet identity
// value leaked into a shipped file.
//
// Run: node --test tests/runtime-parity.test.mjs
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const read = (rel) => readFileSync(join(ROOT, rel), "utf8");
const sha = (rel) => createHash("sha256").update(readFileSync(join(ROOT, rel))).digest("hex");
const series = JSON.parse(read("memory/patches/core-v2.0.2-l1recordids/series.json"));

function walk(rel, out = []) {
  const abs = join(ROOT, rel);
  if (!existsSync(abs)) return out;
  if (statSync(abs).isFile()) { out.push(rel); return out; }
  for (const name of readdirSync(abs).sort()) {
    // Build artifacts are not source: a .pyc embeds the absolute build path.
    if (name === "__pycache__" || name.endsWith(".pyc")) continue;
    walk(join(rel, name), out);
  }
  return out;
}

// Exact live identity values: none of these may appear anywhere in the repo.
const LIVE_IDENTITIES = [
  "agt-e0x6duf3b5",
  "team-c3helqsfu6",
  "usr-c13toood7u",
  "agt-c3he1r0wef",
  "team%3Ateam-c3helqsfu6",
  "agt-c3he",
];

// Ship-path prefixes that only make sense on the fleet host. Provenance pages
// are allowed to name the source they were cut from; executable/config files are not.
const FLEET_PATHS = ["/home/" + "operator", "/mnt/" + "newdata"]; // assembled: the guard scans for these literals
const RUNTIME_PATHS = [
  "memory/portable/capture-consumer.mjs",
  "memory/portable/capture-consumer.env.example",
  "memory/portable/systemd/singularity-capture-run.sh",
  "memory/portable/systemd/tencent-capture.service",
  "memory/portable/systemd/tencent-capture.timer",
  "memory/patches/hub-751/Dockerfile",
  "connectors",
  "ghost/chain.mjs",
  "ghost/chain.example.json",
  "ghost/prompt-store",
  "ghost/task-prompts.mjs",
  "compose/runtime-parity.override.yml",
  "office/office.compose.yml",
  "office/office.deployed.override.example.yml",
];

test("memory/upstream is byte-exact against its provenance table", () => {
  const doc = read("memory/upstream/PROVENANCE.md");
  const rows = [...doc.matchAll(/^\|\s*`([^`]+)`\s*\|\s*`([0-9a-f]{64})`\s*\|$/gm)];
  assert.ok(rows.length >= 10, `expected >=10 checksum rows, got ${rows.length}`);
  for (const [, file, expected] of rows) {
    assert.equal(sha(`memory/upstream/${file}`), expected, `upstream drift: ${file}`);
  }
});

test("the core patch series is self-describing and internally consistent", () => {
  const dir = "memory/patches/core-v2.0.2-l1recordids";
  assert.equal(series.schema, "singularity-memory-patch-series/1");
  assert.equal(series.upstream.commit, "99a1a2c251741658917e3fa700bf8e337ad15a5f");
  assert.match(series.upstream.tarball_sha256, /^[0-9a-f]{64}$/);
  assert.equal(sha(`${dir}/${series.patch.file}`), series.patch.sha256);
  const patch = read(`${dir}/${series.patch.file}`);
  const modified = series.files.filter((f) => f.status === "modified");
  const added = series.files.filter((f) => f.status === "added");
  assert.equal(modified.length, 8, "eight modified upstream files");
  assert.equal(added.length, 1, "one added regression test");
  for (const entry of series.files) {
    assert.match(entry.head_sha256, /^[0-9a-f]{64}$/, entry.path);
    assert.ok(patch.includes(`a/${entry.path}`) && patch.includes(`b/${entry.path}`), `patch names ${entry.path}`);
    if (entry.status === "modified") assert.match(entry.base_sha256, /^[0-9a-f]{64}$/, entry.path);
    else assert.equal(entry.base_sha256, null, entry.path);
  }
  assert.match(series.patch.apply, /patch -p1/);
  assert.match(series.patch.reverse, /--reverse/);
});

test("the hub overlay pins its base and proves it landed", () => {
  const dir = "memory/patches/hub-751";
  const dockerfile = read(`${dir}/Dockerfile`);
  const doc = read(`${dir}/PROVENANCE.md`);
  const baseBundle = "c63a85473c2337ddc83699d82d268c71b0f73f3dc0a08afb18c257b7a6e7ff3a";
  assert.ok(dockerfile.includes("agentmemory/memory-hub@sha256:53a3285b6444628384fc0b9a1b5da66558daddbed8aba880ee66d390764b7c6a"));
  assert.ok(dockerfile.includes(baseBundle), "base bundle hash asserted before the copy");
  assert.ok(dockerfile.indexOf(baseBundle) < dockerfile.indexOf("COPY patch/"), "hash check precedes the overlay");
  const overlay = read(`${dir}/patch/ingest-v2-CSw_7GGw.mjs`);
  const overlaySha = sha(`${dir}/patch/ingest-v2-CSw_7GGw.mjs`);
  assert.ok(doc.includes(overlaySha), "PROVENANCE records the overlay hash");
  assert.ok(dockerfile.includes(overlaySha), "Dockerfile asserts the overlay hash after copying it");
  assert.match(overlay, /PATCH-751/);
  assert.ok(dockerfile.includes("node --check") && dockerfile.includes("grep -q \"PATCH-751\""));
});

test("the capture consumer is disabled by default and carries no identity", () => {
  const env = read("memory/portable/capture-consumer.env.example");
  assert.match(env, /^CAPTURE_ENABLED=0$/m);
  assert.match(env, /^TEAM_ID=$/m, "TEAM_ID has no default");
  assert.match(env, /^USER_ID=$/m, "USER_ID has no default");
  const runner = read("memory/portable/systemd/singularity-capture-run.sh");
  assert.match(runner, /TEAM_ID and USER_ID are required/, "runner fails closed without identity");
  assert.doesNotMatch(runner, /TEAM_ID=fleet/, "no fleet default identity");
  assert.match(runner, /--cidfile/, "own-container cleanup");
  assert.match(runner, /--read-only/);
  assert.match(runner, /--cap-drop=ALL/);
  const unit = read("memory/portable/systemd/tencent-capture.service");
  assert.match(unit, /EnvironmentFile=-\/etc\/singularity\/capture\.env/, "env file optional");
  assert.match(unit, /Type=oneshot/);
  const timer = read("memory/portable/systemd/tencent-capture.timer");
  assert.match(timer, /OnActiveSec=/, "timer measures from activation, not boot");
  const consumer = read("memory/portable/capture-consumer.mjs");
  assert.doesNotMatch(consumer, /agt-e0x6duf3b5/);
  assert.match(consumer, /CAPTURE_ENABLED/);
});

test("connector manifests grant exactly what the README claims", () => {
  const kanzo = read("connectors/kanzo/manifest.yaml");
  assert.match(kanzo, /^scheme: kanzo$/m);
  const kanzoHosts = [...kanzo.matchAll(/^\s+- host: "([^"]+)"$/gm)].map((m) => m[1]);
  assert.deepEqual(kanzoHosts, ["http://localhost:4242"], "one loopback host only");
  assert.match(kanzo, /local: true/);
  assert.match(kanzo, /requestsPerMinute: 6/);
  assert.match(kanzo, /sweepIntervalSeconds: 900/);

  const memory = read("connectors/memorycore/manifest.yaml");
  assert.match(memory, /^scheme: memorycore$/m);
  assert.doesNotMatch(memory, /^network:/m, "no network grant");
  const defaultRoot = [...memory.matchAll(/^\s+default: "([^"]*)"$/gm)].map((m) => m[1]);
  assert.ok(defaultRoot.length >= 1);
  for (const value of defaultRoot) assert.doesNotMatch(value, /^\/home\//, `absolute host path leaked: ${value}`);

  const readme = read("connectors/README.md");
  assert.match(readme, /--allow-local-host http:\/\/localhost:4242/, "README states the loopback grant");
  assert.match(readme, /AGPL-3\.0-only/, "Kanzo licence is recorded");
});

test("connector source hashes match the committed files", () => {
  for (const pkg of ["kanzo", "memorycore"]) {
    const dir = `connectors/${pkg}`;
    const lines = read(`${dir}/SOURCE-SHA256`).trim().split("\n");
    assert.ok(lines.length > 5, `${pkg}: expected a real file list`);
    for (const line of lines) {
      const [expected, rel] = line.split(/\s+/);
      assert.match(expected, /^[0-9a-f]{64}$/);
      assert.equal(sha(join(dir, rel)), expected, `${pkg}/${rel} drifted`);
    }
  }
});

test("no live identity value shipped anywhere", () => {
  const files = [...walk("memory/patches"), ...walk("memory/portable"), ...walk("connectors"),
    ...walk("ghost"), ...walk("compose"), ...walk("office"), "docs/RUNTIME-PARITY.md"];
  for (const rel of files) {
    if (!rel.endsWith(".md") && !rel.endsWith(".json") && !rel.endsWith(".yaml") && !rel.endsWith(".yml")
      && !rel.endsWith(".mjs") && !rel.endsWith(".py") && !rel.endsWith(".sh") && !rel.endsWith(".service")
      && !rel.endsWith(".timer") && !rel.endsWith(".ts") && !rel.endsWith(".patch")) continue;
    const text = read(rel);
    for (const id of LIVE_IDENTITIES) assert.ok(!text.includes(id), `live identity ${id} in ${rel}`);
  }
});

test("runtime files name no fleet host path", () => {
  for (const rel of RUNTIME_PATHS) {
    for (const file of walk(rel)) {
      if (file.endsWith(".md")) continue; // provenance pages name the source they came from
      const text = read(file);
      for (const bad of FLEET_PATHS) assert.ok(!text.includes(bad), `fleet path ${bad} in ${file}`);
    }
  }
});

test("the Ghost prompt store registry is the product's own and seeds are declared", () => {
  const store = read("ghost/prompt-store/prompt_store.py");
  const registry = store.slice(store.indexOf("TASK_PROMPTS = {"), store.indexOf("def _root"));
  const tasks = [...registry.matchAll(/^    "([a-z-]+)": \[/gm)].map((m) => m[1]);
  assert.deepEqual(tasks, ["sweep", "dream", "wake"]);
  for (const fleetTask of ["wake-segment1", "wake-segment2", "wake-uap-research", "positive-news", "ufo-weekly"]) {
    assert.ok(!store.includes(fleetTask), `fleet task id in store: ${fleetTask}`);
  }
  const declared = new Map();
  for (const m of registry.matchAll(/"id": "([a-z-]+)",[^}]*?"placeholders": \[([^\]]*)\]/g)) {
    declared.set(m[1], [...m[2].matchAll(/"([a-z_]+)"/g)].map((x) => x[1]));
  }
  const seeds = JSON.parse(read("ghost/prompt-store/seeds.json"));
  assert.ok(seeds.length >= 3);
  for (const seed of seeds) {
    assert.ok(tasks.includes(seed.task), `seed task ${seed.task} is registered`);
    assert.ok(declared.has(seed.entry), `seed entry ${seed.task}/${seed.entry} is registered`);
    for (const m of seed.text.matchAll(/\{\{\s*([A-Za-z0-9_]+)\s*\}\}/g)) {
      assert.ok(declared.get(seed.entry).includes(m[1]), `placeholder ${m[1]} declared for ${seed.entry}`);
    }
    assert.doesNotMatch(seed.text, /Sol|operator order|issue \d+/i, "seed carries no operator instruction");
  }
});

test("the chain runner takes its steps from config, not from compiled-in commands", () => {
  const chain = read("ghost/chain.mjs");
  assert.match(chain, /configPath/);
  assert.match(chain, /openSync\(lockPath, "wx"\)/, "exclusive lock");
  assert.doesNotMatch(chain, /\/home\//, "no absolute host path");
  const example = JSON.parse(read("ghost/chain.example.json"));
  for (const step of example.steps) {
    assert.ok(!step.args.some((a) => a.startsWith("/")), `relative args only: ${step.id}`);
  }
});

test("the compose override is additive, profile-gated and loopback-only", () => {
  const yml = read("compose/runtime-parity.override.yml");
  const block = yml.slice(yml.indexOf("services:"), yml.indexOf("\nnetworks:"));
  const services = [...block.matchAll(/^  ([a-z-]+):\n((?:    .*\n|\n)*)/gm)];
  assert.ok(services.length >= 3, `memory-core, memory-hub and capture (found ${services.map((m) => m[1]).join(",")})`);
  for (const [, name, body] of services) {
    assert.match(body, /profiles: \["runtime-parity"\]/, `${name} must be profile-gated`);
  }
  assert.doesNotMatch(yml, /0\.0\.0\.0:/, "no wildcard publication");
  assert.match(yml, /127\.0\.0\.1:\$\{MEMORY_CORE_PORT:-8420\}:8420/);
  assert.match(yml, /tencent-memorycore:v2\.0\.2-99a1a2c-l1recordids1/);
  assert.match(yml, /tencent-memory-hub:751-parser-fix/);
  assert.match(yml, /memory\/portable:\/app:ro/);
});

test("Office pins the fork revision the live deployment runs", () => {
  const pin = "95d8bdc5728b23bcf0fee4c371b35e071c44f642";
  const prov = read("office/PROVENANCE.md");
  assert.ok(prov.includes(pin));
  assert.match(prov, /MIT/);
  assert.match(prov, /no Cloudflare Access tenant/i);
  const readme = read("office/README.md");
  assert.ok(readme.includes(`git checkout ${pin}`), "README pins the same revision");
  assert.ok(!readme.includes("4ce0d00"), "the old pin is gone");
  const override = read("office/office.deployed.override.example.yml");
  assert.match(override, /image: \$\{CLAUDE_OFFICE_IMAGE/);
});

test("the parity document states what is unverified", () => {
  const doc = read("docs/RUNTIME-PARITY.md");
  for (const heading of ["## What this cannot claim", "## Source inventory", "## Integrator requirements"]) {
    assert.ok(doc.includes(heading), `missing section: ${heading}`);
  }
});
