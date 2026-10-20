// Unit tests for the installation-option capability gate
// (scripts/install-claude-code.mjs verifyOptionTarget / targetConfigDir).
//
// No product service is contacted: the memory service is a local stub, so the
// negative cases (missing config, wrong target dir, invalid key, unavailable
// service) are hermetic and deterministic.
//
// Run: node --test scripts/install-claude-code.gate.test.mjs
import { test } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { existsSync, mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { verifyOptionTarget, detectOpenchamberInstance, targetConfigDir, VARIANTS } from "./install-claude-code.mjs";

const today = () => new Date().toISOString().slice(0, 10);

/** A stub memory service: every count call answers with the given payload. */
const stubService = (payload) => new Promise((res) => {
  const s = createServer((req, res2) => {
    let body = "";
    req.on("data", (d) => { body += d; });
    req.on("end", () => {
      res2.writeHead(200, { "content-type": "application/json" });
      res2.end(JSON.stringify(payload));
    });
  });
  s.listen(0, "127.0.0.1", () => res({
    url: `http://127.0.0.1:${s.address().port}`,
    close: () => new Promise((r) => s.close(r)),
  }));
});

/** A native OpenChamber-shaped config dir with a valid plugin bundle. */
const nativeTarget = (memory) => {
  const root = mkdtempSync(join(tmpdir(), "oc-gate-"));
  const configDir = join(root, ".config", "opencode");
  mkdirSync(join(configDir, "plugins", "product-office"), { recursive: true });
  writeFileSync(join(configDir, "plugins", "product-office", "package.json"), "{}\n");
  writeFileSync(join(configDir, "AGENTS.md"), "# agents\n");
  // a realistic target declares the RepoQL MCP in its OWN opencode.jsonc
  writeFileSync(join(configDir, "opencode.jsonc"),
    '{\n  "mcp": { "repoql": { "type": "local", "command": ["/usr/local/bin/rql", "mcp"] } }\n}\n');
  if (memory) {
    mkdirSync(join(configDir, "product-secrets"), { recursive: true });
    writeFileSync(join(configDir, "product-secrets", "memory.json"), JSON.stringify(memory));
  }
  return { root, configDir };
};

/** A ghost agent dir with a COMPLETED consolidation journal for today. */
const completeGhostDir = () => {
  const agentDir = mkdtempSync(join(tmpdir(), "ghost-gate-"));
  mkdirSync(join(agentDir, "dreams"), { recursive: true });
  writeFileSync(join(agentDir, "dreams", `${today()}.md`),
    `# Dream ${today()} (ghost) — complete\n\n- outcome: complete\n- changed_files: MEMORY.md\n- commit: abc1234\n`, "utf8");
  return agentDir;
};

const lineFor = (result, label) => result.checked.find((c) => c.includes(label)) || "";

test("targetConfigDir never falls back to the package config when the target has none", () => {
  assert.equal(targetConfigDir(null), null);
  assert.equal(targetConfigDir({ kind: "none" }), null);
  assert.equal(targetConfigDir({ kind: "native", configDir: null }), null,
    "a native install without an OpenCode config dir resolves to nothing");
  assert.equal(targetConfigDir({ kind: "native", configDir: "/tmp/x" }), "/tmp/x");
});

test("discovery: a home with only a data dir is NOT an OpenChamber target (N6)", () => {
  const home = mkdtempSync(join(tmpdir(), "home-dataonly-"));
  mkdirSync(join(home, ".local", "share", "opencode"), { recursive: true });
  const found = detectOpenchamberInstance({ home, docker: false });
  assert.equal(found.kind, "none", "a data dir alone is not a target");

  const home2 = mkdtempSync(join(tmpdir(), "home-config-"));
  mkdirSync(join(home2, ".config", "opencode"), { recursive: true });
  const found2 = detectOpenchamberInstance({ home: home2, docker: false });
  assert.equal(found2.kind, "native");
  assert.equal(found2.configDir, join(home2, ".config", "opencode"));
});

test("a native target with a valid config, bundle and memory identity passes its target checks", async () => {
  const svc = await stubService({ code: 0, data: { total: 7 } });
  try {
    const { configDir } = nativeTarget({ baseUrl: svc.url, userKey: "sk-test", authPrefix: "Bearer ", serviceId: "openchamber" });
    const target = { kind: "native", configDir };
    const r = await verifyOptionTarget(VARIANTS[3], { variant: "3" }, { target }, target);
    assert.match(lineFor(r, "OpenChamber config directory resolved"), /^ok:/);
    assert.match(lineFor(r, "OpenChamber memory-plugin bundle present"), /^ok:/);
    assert.match(lineFor(r, "plugin memory credentials provisioned"), /^ok:/);
    assert.equal(r.complete, true, r.missing.join("; "));
  } finally { await svc.close(); }
});

test("a target whose own opencode.jsonc declares no repoql MCP is INCOMPLETE", async () => {
  const svc = await stubService({ code: 0, data: { total: 7 } });
  try {
    const { root, configDir } = nativeTarget({ baseUrl: svc.url, userKey: "sk-test" });
    writeFileSync(join(configDir, "opencode.jsonc"), '{ "mcp": { "other": {} } }\n');
    const target = { kind: "native", configDir };
    const r = await verifyOptionTarget(VARIANTS[3], { variant: "3" }, { target }, target);
    assert.match(lineFor(r, "RepoQL MCP declared"), /^MISSING:/);
    assert.equal(r.complete, false);
  } finally { await svc.close(); }
});

test("a missing memory config in the target is INCOMPLETE (never silently satisfied)", async () => {
  const svc = await stubService({ code: 0, data: { total: 7 } });
  try {
    const { configDir } = nativeTarget(null); // no product-secrets/memory.json
    const target = { kind: "native", configDir };
    const r = await verifyOptionTarget(VARIANTS[3], { variant: "3" }, { target }, target);
    assert.match(lineFor(r, "plugin memory credentials provisioned"), /^MISSING:/);
    assert.equal(r.complete, false);
  } finally { await svc.close(); }
});

test("a config in the WRONG directory is not used (no wrong-dir fallback)", async () => {
  const svc = await stubService({ code: 0, data: { total: 7 } });
  try {
    const { root, configDir } = nativeTarget(null); // the target has NO config of its own
    // a plausible-looking config OUTSIDE the target config dir
    mkdirSync(join(root, "elsewhere", "product-secrets"), { recursive: true });
    writeFileSync(join(root, "elsewhere", "product-secrets", "memory.json"), JSON.stringify({ baseUrl: svc.url, userKey: "sk-test" }));
    const target = { kind: "native", configDir };
    const r = await verifyOptionTarget(VARIANTS[3], { variant: "3" }, { target }, target);
    assert.match(lineFor(r, "plugin memory credentials provisioned"), /^MISSING:/,
      "only the target's own config dir counts");
  } finally { await svc.close(); }
});

test("an invalid key (service rejects it) is INCOMPLETE", async () => {
  const svc = await stubService({ code: 401, message: "invalid api key" });
  try {
    const { configDir } = nativeTarget({ baseUrl: svc.url, userKey: "sk-bad" });
    const target = { kind: "native", configDir };
    const r = await verifyOptionTarget(VARIANTS[4], { variant: "4" }, { target, ghostAgentDir: completeGhostDir() }, target);
    assert.match(lineFor(r, "Ghost memory identity reachable"), /^MISSING:/);
    assert.equal(r.complete, false);
  } finally { await svc.close(); }
});

test("an unavailable memory service is INCOMPLETE", async () => {
  const svc = await stubService({ code: 0, data: { total: 1 } });
  const url = svc.url;
  await svc.close(); // nothing listens any more
  const { configDir } = nativeTarget({ baseUrl: url, userKey: "sk-test" });
  const target = { kind: "native", configDir };
  const r = await verifyOptionTarget(VARIANTS[4], { variant: "4" }, { target, ghostAgentDir: completeGhostDir() }, target);
  assert.match(lineFor(r, "Ghost memory identity reachable"), /^MISSING:/);
  assert.equal(r.complete, false);
});

test("a checkpointed dream journal is NOT a completed consolidation (N1)", async () => {
  const svc = await stubService({ code: 0, data: { total: 7 } });
  try {
    const { configDir } = nativeTarget({ baseUrl: svc.url, userKey: "sk-test" });
    const target = { kind: "native", configDir };
    const agentDir = mkdtempSync(join(tmpdir(), "ghost-gate-ck-"));
    mkdirSync(join(agentDir, "dreams"), { recursive: true });
    writeFileSync(join(agentDir, "dreams", `${today()}.md`),
      `# Dream ${today()} (ghost) — checkpointed\n\n- outcome: checkpointed (step-failed:experiences)\n- changed_files: none\n- commit: (no memory commit this run)\n`, "utf8");
    const r = await verifyOptionTarget(VARIANTS[4], { variant: "4" }, { target, ghostAgentDir: agentDir }, target);
    assert.match(lineFor(r, "Ghost dream consolidation completed today"), /^MISSING:/);
    assert.match(lineFor(r, "Ghost dream consolidation completed today"), /checkpoint/);
  } finally { await svc.close(); }
});

test("a completed dream journal with provenance IS accepted (N1)", async () => {
  const svc = await stubService({ code: 0, data: { total: 7 } });
  try {
    const { configDir } = nativeTarget({ baseUrl: svc.url, userKey: "sk-test" });
    const target = { kind: "native", configDir };
    const r = await verifyOptionTarget(VARIANTS[4], { variant: "4" }, { target, ghostAgentDir: completeGhostDir() }, target);
    assert.match(lineFor(r, "Ghost dream consolidation completed today"), /^ok:/);
    assert.match(lineFor(r, "Ghost memory identity reachable"), /^ok:/);
  } finally { await svc.close(); }
});

test("Office is INCOMPLETE without an office.json (never a silent pass)", async () => {
  const svc = await stubService({ code: 0, data: { total: 7 } });
  try {
    const { configDir } = nativeTarget({ baseUrl: svc.url, userKey: "sk-test" });
    const target = { kind: "native", configDir };
    const r = await verifyOptionTarget(VARIANTS[4], { variant: "4" }, { target, ghostAgentDir: completeGhostDir() }, target);
    assert.match(lineFor(r, "Claude Office"), /^MISSING:/);
  } finally { await svc.close(); }
});

test("the gate command target selection keeps the historical stack untouched", () => {
  // The historical compose-managed container is never re-created by the gate:
  // the gate only reads. This asserts the discovery contract, not the runtime.
  const found = detectOpenchamberInstance({ docker: false });
  assert.ok(["none", "native", "container", "compose-managed"].includes(found.kind));
  assert.ok(!existsSync(join(tmpdir(), "singularity-openchamber")));
});
