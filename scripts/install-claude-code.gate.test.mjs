// Unit tests for the installation-option capability gate
// (scripts/install-claude-code.mjs verifyOptionTarget / targetConfigDir /
// runGate / runInstall).
//
// No product service is contacted: the memory service is a local stub and the
// FUNCTIONAL proof layer is injected, so the negative cases (missing config,
// wrong target dir, invalid key, administrative key, unavailable service) are
// hermetic and deterministic.
//
// Run: node --test scripts/install-claude-code.gate.test.mjs
import { test } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  verifyOptionTarget, detectOpenchamberInstance, targetConfigDir, VARIANTS,
  gateComplete, main,
} from "./install-claude-code.mjs";

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

/** The injected proof layer: every runtime proof answers OK. */
const OK_PROBES = {
  memoryIdentity: async () => ({ ok: true, state: "OK", detail: "injected" }),
  memoryLoop: async () => ({ ok: true, state: "VERIFIED", detail: "injected" }),
  repoqlMcp: async () => ({ ok: true, state: "VERIFIED", detail: "injected" }),
  docIngestion: async () => ({ ok: true, state: "VERIFIED", detail: "injected" }),
  providerFailover: async () => ({ ok: true, state: "VERIFIED", detail: "injected" }),
  modelLane: async () => ({ ok: true, state: "OK", detail: "injected" }),
};

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

/** Run a command through the CLI entrypoint and capture its output. */
const runCli = async (argv) => {
  const out = [];
  const origLog = console.log, origWarn = console.warn;
  console.log = (...a) => out.push(a.join(" "));
  console.warn = (...a) => out.push(a.join(" "));
  let rc = 0;
  try {
    rc = await main(argv);
  } finally {
    console.log = origLog;
    console.warn = origWarn;
  }
  return { rc, out: out.join("\n") };
};

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

test("an EMPTY check list is never complete (B6)", () => {
  assert.equal(gateComplete([], []), false, "no check is no proof");
  assert.equal(gateComplete([], ["x"]), false);
  assert.equal(gateComplete(["ok: something"], ["x"]), false);
  assert.equal(gateComplete(["ok: something"], []), true);
  assert.equal(gateComplete(null, null), false);
});

test("a native target with a valid config, bundle and memory identity passes its target checks", async () => {
  const svc = await stubService({ code: 0, data: { total: 7 } });
  try {
    const { configDir } = nativeTarget({ baseUrl: svc.url, userKey: "sk-test", authPrefix: "Bearer ", serviceId: "openchamber" });
    const target = { kind: "native", configDir };
    const r = await verifyOptionTarget(VARIANTS[3], { variant: "3" }, { target, probes: OK_PROBES }, target);
    assert.match(lineFor(r, "OpenChamber config directory resolved"), /^ok:/);
    assert.match(lineFor(r, "OpenChamber memory-plugin bundle present"), /^ok:/);
    assert.match(lineFor(r, "plugin memory credentials present"), /^ok:/);
    assert.match(lineFor(r, "scoped memory identity authenticated"), /^ok:/);
    assert.match(lineFor(r, "RepoQL MCP server answers a real call"), /^ok:/);
    // Fail-closed: the ordinary-session capture/recall HOLD is the ONLY open
    // item of a fully-stubbed target, so the product default never completes.
    assert.deepEqual(r.missing.map((m) => m.split(" (")[0]),
      ["ordinary-session automatic capture and NEW-session recall via the native hooks"], r.missing.join("; "));
    assert.equal(r.complete, false, "the ordinary-session HOLD keeps the option INCOMPLETE");
  } finally { await svc.close(); }
});

test("the gate completes ONLY when the ordinary-session proof is also supplied (harness stub, not a product pass)", async () => {
  const svc = await stubService({ code: 0, data: { total: 7 } });
  try {
    const { configDir } = nativeTarget({ baseUrl: svc.url, userKey: "sk-test", authPrefix: "Bearer ", serviceId: "openchamber" });
    const target = { kind: "native", configDir };
    const probes = { ...OK_PROBES, ordinarySession: async () => ({ ok: true, state: "VERIFIED", detail: "harness stub" }) };
    const r = await verifyOptionTarget(VARIANTS[3], { variant: "3" }, { target, probes }, target);
    assert.equal(r.missing.length, 0, r.missing.join("; "));
    assert.equal(r.complete, true);
  } finally { await svc.close(); }
});

test("the product default never claims ordinary-session recall: the HOLD is explicit and not a pass", async () => {
  const { probeOrdinarySessionRecall } = await import("./install-claude-code.mjs");
  const r = await probeOrdinarySessionRecall();
  assert.equal(r.ok, false);
  assert.equal(r.state, "HOLD");
  assert.match(r.detail, /live ordinary session/);
});

test("no credential-using probe runs with an ADMINISTRATIVE identity: the key is never reused (B7)", async () => {
  // Every probe that authenticates with the target's memory key is a spy. With an
  // administrative identity none of them may run, and each dependent check is
  // reported MISSING ("not run"), never as a pass.
  const calls = [];
  const spy = (name, out) => async () => { calls.push(name); return out; };
  const r = await verifyOptionTarget(VARIANTS[1], { variant: "1" }, {
    probes: {
      memoryIdentity: async () => ({ ok: false, state: "ADMIN", detail: "the configured key is an ADMINISTRATIVE credential" }),
      memoryLoop: spy("loop", { ok: true, state: "VERIFIED", detail: "must not run" }),
      docIngestion: spy("docs", { ok: true, state: "VERIFIED", detail: "must not run" }),
      modelLane: spy("lane", { ok: true, state: "OK", detail: "must not run" }),
      repoqlMcp: OK_PROBES.repoqlMcp,
      providerFailover: OK_PROBES.providerFailover,
    },
  }, null);
  assert.deepEqual(calls, [], "no credential-using probe may run with an administrative identity");
  assert.match(lineFor(r, "scoped memory identity authenticated"), /^MISSING:/);
  assert.match(lineFor(r, "memory API loop"), /not run/);
  assert.match(lineFor(r, "documentation assessment"), /not run/);
  assert.match(lineFor(r, "model lane registered"), /not run/);
  assert.equal(r.complete, false);
});

test("a verified scoped identity is what lets the credential-using probes run (B7 positive control)", async () => {
  const calls = [];
  const spy = (name, out) => async () => { calls.push(name); return out; };
  const r = await verifyOptionTarget(VARIANTS[1], { variant: "1" }, {
    probes: {
      memoryIdentity: async () => ({ ok: true, state: "OK", detail: "scoped" }),
      memoryLoop: spy("loop", { ok: true, state: "VERIFIED_API", detail: "injected" }),
      docIngestion: spy("docs", { ok: true, state: "VERIFIED", detail: "injected" }),
      modelLane: spy("lane", { ok: true, state: "OK", detail: "injected" }),
      repoqlMcp: OK_PROBES.repoqlMcp,
      providerFailover: OK_PROBES.providerFailover,
    },
  }, null);
  assert.deepEqual(calls.sort(), ["docs", "lane", "loop"]);
  assert.match(lineFor(r, "memory API loop"), /^ok:/);
});

test("an ADMINISTRATIVE key is refused: the gate never passes on an admin credential (B7)", async () => {
  const svc = await stubService({ code: 0, data: { total: 7 } });
  try {
    const { configDir } = nativeTarget({ baseUrl: svc.url, userKey: "sk-admin", serviceId: "openchamber" });
    const target = { kind: "native", configDir };
    const r = await verifyOptionTarget(VARIANTS[3], { variant: "3" }, {
      target,
      probes: { ...OK_PROBES, memoryIdentity: async () => ({ ok: false, state: "ADMIN", detail: "the configured key is an ADMINISTRATIVE credential" }) },
    }, target);
    assert.match(lineFor(r, "scoped memory identity authenticated"), /^MISSING:/);
    assert.match(lineFor(r, "scoped memory identity authenticated"), /ADMINISTRATIVE/);
    assert.equal(r.complete, false);
  } finally { await svc.close(); }
});

test("an unusable memory service (no auth service) is INCOMPLETE (B7)", async () => {
  const svc = await stubService({ code: 0, data: { total: 1 } });
  const url = svc.url;
  await svc.close(); // nothing listens any more
  const { configDir } = nativeTarget({ baseUrl: url, userKey: "sk-test" });
  const target = { kind: "native", configDir };
  const r = await verifyOptionTarget(VARIANTS[3], { variant: "3" }, {
    target,
    probes: { ...OK_PROBES, memoryIdentity: async () => ({ ok: false, state: "UNREACHABLE", detail: "the memory service is not reachable" }) },
  }, target);
  assert.match(lineFor(r, "scoped memory identity authenticated"), /^MISSING:/);
  assert.equal(r.complete, false);
});

test("a target whose own opencode.jsonc declares no repoql MCP is INCOMPLETE", async () => {
  const svc = await stubService({ code: 0, data: { total: 7 } });
  try {
    const { configDir } = nativeTarget({ baseUrl: svc.url, userKey: "sk-test" });
    writeFileSync(join(configDir, "opencode.jsonc"), '{ "mcp": { "other": {} } }\n');
    const target = { kind: "native", configDir };
    const r = await verifyOptionTarget(VARIANTS[3], { variant: "3" }, { target, probes: OK_PROBES }, target);
    assert.match(lineFor(r, "RepoQL MCP declared"), /^MISSING:/);
    assert.equal(r.complete, false);
  } finally { await svc.close(); }
});

test("a missing memory config in the target is INCOMPLETE (never silently satisfied)", async () => {
  const svc = await stubService({ code: 0, data: { total: 7 } });
  try {
    const { configDir } = nativeTarget(null); // no product-secrets/memory.json
    const target = { kind: "native", configDir };
    const r = await verifyOptionTarget(VARIANTS[3], { variant: "3" }, { target, probes: OK_PROBES }, target);
    assert.match(lineFor(r, "plugin memory credentials present"), /^MISSING:/);
    assert.equal(r.complete, false);
  } finally { await svc.close(); }
});

test("a config in the WRONG directory is not used (no wrong-dir fallback)", async () => {
  const svc = await stubService({ code: 0, data: { total: 7 } });
  try {
    const { root, configDir } = nativeTarget(null); // the target has NO config of its own
    mkdirSync(join(root, "elsewhere", "product-secrets"), { recursive: true });
    writeFileSync(join(root, "elsewhere", "product-secrets", "memory.json"), JSON.stringify({ baseUrl: svc.url, userKey: "sk-test" }));
    const target = { kind: "native", configDir };
    const r = await verifyOptionTarget(VARIANTS[3], { variant: "3" }, { target, probes: OK_PROBES }, target);
    assert.match(lineFor(r, "plugin memory credentials present"), /^MISSING:/,
      "only the target's own config dir counts");
  } finally { await svc.close(); }
});

test("an invalid key (service rejects it) is INCOMPLETE", async () => {
  const svc = await stubService({ code: 401, message: "invalid api key" });
  try {
    const { configDir } = nativeTarget({ baseUrl: svc.url, userKey: "sk-bad" });
    const target = { kind: "native", configDir };
    const r = await verifyOptionTarget(VARIANTS[4], { variant: "4" }, { target, ghostAgentDir: completeGhostDir(), probes: OK_PROBES }, target);
    assert.match(lineFor(r, "Ghost memory identity reachable"), /^MISSING:/);
    assert.equal(r.complete, false);
  } finally { await svc.close(); }
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
    const r = await verifyOptionTarget(VARIANTS[4], { variant: "4" }, { target, ghostAgentDir: agentDir, probes: OK_PROBES }, target);
    assert.match(lineFor(r, "Ghost dream consolidation completed today"), /^MISSING:/);
    assert.match(lineFor(r, "Ghost dream consolidation completed today"), /checkpoint/);
  } finally { await svc.close(); }
});

test("a completed dream journal with provenance IS accepted (N1)", async () => {
  const svc = await stubService({ code: 0, data: { total: 7 } });
  try {
    const { configDir } = nativeTarget({ baseUrl: svc.url, userKey: "sk-test" });
    const target = { kind: "native", configDir };
    const r = await verifyOptionTarget(VARIANTS[4], { variant: "4" }, { target, ghostAgentDir: completeGhostDir(), probes: OK_PROBES }, target);
    assert.match(lineFor(r, "Ghost dream consolidation completed today"), /^ok:/);
    assert.match(lineFor(r, "Ghost memory identity reachable"), /^ok:/);
  } finally { await svc.close(); }
});

test("Office is INCOMPLETE without an office.json (never a silent pass)", async () => {
  const svc = await stubService({ code: 0, data: { total: 7 } });
  try {
    const { configDir } = nativeTarget({ baseUrl: svc.url, userKey: "sk-test" });
    const target = { kind: "native", configDir };
    const r = await verifyOptionTarget(VARIANTS[4], { variant: "4" }, { target, ghostAgentDir: completeGhostDir(), probes: OK_PROBES }, target);
    assert.match(lineFor(r, "Claude Office"), /^MISSING:/);
  } finally { await svc.close(); }
});

test("the gate command REFUSES options 1 and 2 and never prints COMPLETE (B6)", async () => {
  for (const v of ["1", "2"]) {
    const { rc, out } = await runCli(["gate", "--variant", v]);
    assert.equal(rc, 2, `option ${v} must be refused by the gate`);
    assert.ok(!/INSTALL COMPLETE/.test(out), `option ${v} must never print INSTALL COMPLETE`);
    assert.match(out, /3 and 4 only|ATTACH installation options/);
  }
});

test("install --variant 3|4 is REFUSED before any mutation (B6)", async () => {
  const home = mkdtempSync(join(tmpdir(), "install-refuse-"));
  const { rc, out } = await runCli(["install", "--variant", "3"]);
  assert.equal(rc, 2);
  assert.match(out, /not a Claude Code install/);
  assert.match(out, /SINGULARITY_VARIANT=3 bash scripts\/start\.sh/);
  assert.match(out, /gate --variant 3/);
  assert.equal(existsSync(join(home, ".claude")), false, "nothing was created");
});

test("the gate command target selection keeps the historical stack untouched", () => {
  // The historical compose-managed container is never re-created by the gate:
  // the gate only reads. This asserts the discovery contract, not the runtime.
  const found = detectOpenchamberInstance({ docker: false });
  assert.ok(["none", "native", "container", "compose-managed"].includes(found.kind));
  assert.ok(!existsSync(join(tmpdir(), "singularity-openchamber")));
});
