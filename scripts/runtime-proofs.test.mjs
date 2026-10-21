// Unit tests for the FUNCTIONAL proof layer (scripts/runtime-proofs.mjs).
//
// The memory identity probe talks to a local stub, so the classification of a
// key (scoped / administrative / undiscriminable / rejected / unreachable /
// wrong scope) is hermetic and deterministic. The RepoQL MCP probe is run
// against a REAL child process (a fake stdio MCP server written to a temp dir),
// so the stateful handshake and the tools/call path are exercised for real. The
// failover probe is run against a local router stub on a random port.
//
// Run: node --test scripts/runtime-proofs.test.mjs
import { test } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { chmodSync, mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  classifyMemoryScope,
  memoryIdentity,
  probeMemoryIdentity,
  probeRepoqlMcp,
  probeProviderFailover,
  isAdministrativeKey,
  readAdministrativeKey,
} from "./runtime-proofs.mjs";

/** A stub memory service with a programmable auth/verify + count answer. */
const stubService = (authPayload, countPayload = { code: 0, data: { total: 1 } }) => new Promise((res) => {
  const s = createServer((req, res2) => {
    let body = "";
    req.on("data", (d) => { body += d; });
    req.on("end", () => {
      res2.writeHead(200, { "content-type": "application/json" });
      res2.end(JSON.stringify(String(req.url || "").includes("/auth/verify") ? authPayload : countPayload));
    });
  });
  s.listen(0, "127.0.0.1", () => res({
    url: `http://127.0.0.1:${s.address().port}`,
    close: () => new Promise((r) => s.close(r)),
  }));
});

test("the key type is classified: administrative, scoped and undiscriminable are distinct", () => {
  assert.equal(classifyMemoryScope({ valid: true, userType: "system_admin" }).state, "ADMIN");
  assert.equal(classifyMemoryScope({ valid: true, userType: "admin" }).state, "ADMIN");
  assert.equal(classifyMemoryScope({ valid: true, userType: "business_user" }).state, "OK");
  assert.equal(classifyMemoryScope({ valid: true, userType: "" }).state, "UNVERIFIED");
  assert.equal(classifyMemoryScope({ valid: true, userType: "unknown_role" }).state, "UNVERIFIED");
  assert.equal(classifyMemoryScope({ valid: true, userType: "service_admin" }).state, "UNVERIFIED");
  assert.equal(classifyMemoryScope({ valid: false, userType: "business_user" }).state, "AUTH_FAILED");
  assert.equal(classifyMemoryScope({}).state, "AUTH_FAILED");
});

test("an ADMINISTRATIVE key is refused by the live probe (B7)", async () => {
  const svc = await stubService({ code: 0, data: { valid: true, user: { user_id: "usr-1", user_type: "system_admin" } } });
  try {
    const r = await probeMemoryIdentity({ config: { baseUrl: svc.url, userKey: "sk-admin", serviceId: "default" } });
    assert.equal(r.ok, false);
    assert.equal(r.state, "ADMIN");
    assert.match(r.detail, /ADMINISTRATIVE/);
  } finally { await svc.close(); }
});

test("a scoped business key is accepted by the live probe", async () => {
  const svc = await stubService({ code: 0, data: { valid: true, user: { user_id: "usr-2", user_type: "business_user" } } });
  try {
    const r = await probeMemoryIdentity({ config: { baseUrl: svc.url, userKey: "sk-scoped", serviceId: "default" } });
    assert.equal(r.ok, true, r.detail);
    assert.equal(r.state, "OK");
    assert.equal(r.userType, "business_user");
  } finally { await svc.close(); }
});

test("a key that authenticates but cannot be classified is UNVERIFIED, never relabelled", async () => {
  const svc = await stubService({ code: 0, data: { valid: true, user: {} } });
  try {
    const r = await probeMemoryIdentity({ config: { baseUrl: svc.url, userKey: "sk-mystery", serviceId: "default" } });
    assert.equal(r.ok, false);
    assert.equal(r.state, "UNVERIFIED");
    assert.match(r.detail, /UNVERIFIED/);
  } finally { await svc.close(); }
});

test("a rejected key is AUTH_FAILED", async () => {
  const svc = await stubService({ code: 0, data: { valid: false, user: null } });
  try {
    const r = await probeMemoryIdentity({ config: { baseUrl: svc.url, userKey: "sk-bad", serviceId: "default" } });
    assert.equal(r.ok, false);
    assert.equal(r.state, "AUTH_FAILED");
  } finally { await svc.close(); }
});

test("a key that cannot act in the configured identity is WRONG_SCOPE", async () => {
  const svc = await stubService(
    { code: 0, data: { valid: true, user: { user_id: "usr-3", user_type: "business_user" } } },
    { code: 403, message: "not in this team" },
  );
  try {
    const r = await probeMemoryIdentity({
      config: { baseUrl: svc.url, userKey: "sk-scoped", serviceId: "default", identity: { team_id: "team-a", user_id: "u", agent_id: "a" } },
    });
    assert.equal(r.ok, false);
    assert.equal(r.state, "WRONG_SCOPE");
  } finally { await svc.close(); }
});

test("HTTP errors and malformed authentication envelopes never verify an identity", async () => {
  for (const response of [
    { ok: false, body: { code: 0, data: { valid: true, user: { user_type: "business_user" } } } },
    { ok: true, body: null },
    { ok: true, body: { data: { valid: true, user: { user_type: "business_user" } } } },
    { ok: true, body: { code: 500, data: { valid: true, user: { user_type: "business_user" } } } },
  ]) {
    let calls = 0;
    const r = await probeMemoryIdentity({
      config: { baseUrl: "http://memory.invalid", userKey: "fixture-key" },
      fetchImpl: async () => { calls++; return { ok: response.ok, json: async () => response.body }; },
    });
    assert.equal(r.ok, false);
    assert.equal(r.state, "AUTH_FAILED");
    assert.equal(calls, 1, "a rejected authentication must not attempt scoped operations");
  }
});

test("HTTP errors and malformed count envelopes never prove user/team scope", async () => {
  for (const response of [
    { ok: false, body: { code: 0, data: { total: 1 } } },
    { ok: true, body: null },
    { ok: true, body: {} },
    { ok: true, body: { code: 0 } },
    { ok: true, body: { code: 0, data: [] } },
  ]) {
    const r = await probeMemoryIdentity({
      config: { baseUrl: "http://memory.invalid", userKey: "fixture-key" },
      fetchImpl: async (url) => url.endsWith("/auth/verify")
        ? { ok: true, json: async () => ({ code: 0, data: { valid: true, user: { user_type: "business_user" } } }) }
        : { ok: response.ok, json: async () => response.body },
    });
    assert.equal(r.ok, false);
    assert.equal(r.state, "WRONG_SCOPE");
  }
});

test("no key is NO_CREDENTIALS and no request is made", async () => {
  let called = false;
  const r = await probeMemoryIdentity({
    config: { baseUrl: "http://127.0.0.1:1", userKey: "" },
    fetchImpl: async () => { called = true; return { ok: true, status: 200, json: async () => ({}) }; },
  });
  assert.equal(r.state, "NO_CREDENTIALS");
  assert.equal(called, false);
});

test("an unreachable memory service is UNREACHABLE", async () => {
  const r = await probeMemoryIdentity({
    config: { baseUrl: "http://127.0.0.1:1", userKey: "sk-x" },
    fetchImpl: async () => { throw new Error("ECONNREFUSED"); },
  });
  assert.equal(r.state, "UNREACHABLE");
  assert.equal(r.ok, false);
});

test("the probe never returns the key material", async () => {
  const svc = await stubService({ code: 0, data: { valid: true, user: { user_id: "usr-4", user_type: "business_user" } } });
  try {
    const r = await probeMemoryIdentity({ config: { baseUrl: svc.url, userKey: "sk-super-secret", serviceId: "default" } });
    assert.ok(!JSON.stringify(r).includes("sk-super-secret"));
  } finally { await svc.close(); }
});

test("the plugin identity falls back to the configured identity block", () => {
  assert.deepEqual(memoryIdentity({ identity: { team_id: "t", user_id: "u", agent_id: "a" } }), { team_id: "t", user_id: "u", agent_id: "a" });
  assert.deepEqual(memoryIdentity({ ghostTeamId: "gt", ghostUserId: "gu", ghostAgentId: "ga" }), { team_id: "gt", user_id: "gu", agent_id: "ga" });
  assert.deepEqual(memoryIdentity({}), { team_id: "default", user_id: "default", agent_id: "default" });
});

// ── RepoQL MCP: a REAL stdio child process ──────────────────────────────────

/** Write an executable fake `rql` whose behaviour is chosen by FAKE_RQL_MODE. */
function fakeRql() {
  const dir = mkdtempSync(join(tmpdir(), "fake-rql-"));
  const path = join(dir, "rql");
  writeFileSync(path, `#!/usr/bin/env node
const readline = require("readline");
const mode = process.env.FAKE_RQL_MODE || "good";
if (mode === "exit") process.exit(3);
if (mode === "silent") setInterval(() => {}, 1000);
const send = (o) => process.stdout.write(JSON.stringify(o) + "\\n");
readline.createInterface({ input: process.stdin }).on("line", (line) => {
  let m; try { m = JSON.parse(line); } catch { return; }
  if (mode === "silent") return;
  if (m.method === "initialize") return send({ jsonrpc: "2.0", id: m.id, result: { protocolVersion: "2024-11-05", capabilities: {}, serverInfo: { name: "fake-rql" } } });
  if (m.method === "tools/list") {
    const tools = mode === "no-query" ? [{ name: "explore", annotations: { readOnlyHint: true } }]
      : [{ name: "query", annotations: { readOnlyHint: true } }, { name: "explore", annotations: { readOnlyHint: true } }];
    return send({ jsonrpc: "2.0", id: m.id, result: { tools } });
  }
  if (m.method === "tools/call") {
    if (mode === "tool-error") return send({ jsonrpc: "2.0", id: m.id, result: { isError: true, content: [{ type: "text", text: "boom" }] } });
    return send({ jsonrpc: "2.0", id: m.id, result: { isError: false, content: [{ type: "text", text: "1" }] } });
  }
});
`, "utf8");
  chmodSync(path, 0o755);
  return path;
}

test("the RepoQL probe makes a real read-only tools/call and verifies it", async () => {
  const bin = fakeRql();
  const prev = process.env.FAKE_RQL_MODE;
  process.env.FAKE_RQL_MODE = "good";
  try {
    const r = await probeRepoqlMcp({ rqlPath: bin, timeout: 8000 });
    assert.equal(r.ok, true, r.detail);
    assert.equal(r.state, "VERIFIED");
    assert.match(r.detail, /tools\/call succeeded/);
  } finally { if (prev === undefined) delete process.env.FAKE_RQL_MODE; else process.env.FAKE_RQL_MODE = prev; }
});

test("a server without the read-only query tool is INCOMPLETE, never a pass", async () => {
  const bin = fakeRql();
  process.env.FAKE_RQL_MODE = "no-query";
  try {
    const r = await probeRepoqlMcp({ rqlPath: bin, timeout: 8000 });
    assert.equal(r.ok, false);
    assert.match(r.detail, /does not expose the read-only query tool/);
  } finally { delete process.env.FAKE_RQL_MODE; }
});

test("a tools/call that reports an error is INCOMPLETE", async () => {
  const bin = fakeRql();
  process.env.FAKE_RQL_MODE = "tool-error";
  try {
    const r = await probeRepoqlMcp({ rqlPath: bin, timeout: 8000 });
    assert.equal(r.ok, false);
    assert.match(r.detail, /reported an error/);
  } finally { delete process.env.FAKE_RQL_MODE; }
});

test("a server that never answers times out as INCOMPLETE", async () => {
  const bin = fakeRql();
  process.env.FAKE_RQL_MODE = "silent";
  try {
    const r = await probeRepoqlMcp({ rqlPath: bin, timeout: 1500 });
    assert.equal(r.ok, false);
    assert.equal(r.state, "INCOMPLETE");
    assert.match(r.detail, /did not answer within/);
  } finally { delete process.env.FAKE_RQL_MODE; }
});

test("a server that exits before answering is INCOMPLETE (no stand-in passes)", async () => {
  const bin = fakeRql();
  process.env.FAKE_RQL_MODE = "exit";
  try {
    const r = await probeRepoqlMcp({ rqlPath: bin, timeout: 8000 });
    assert.equal(r.ok, false);
    assert.equal(r.state, "INCOMPLETE");
  } finally { delete process.env.FAKE_RQL_MODE; }
});

test("a missing RepoQL binary is MISSING and nothing is spawned", async () => {
  const r = await probeRepoqlMcp({ rqlPath: "/nonexistent/rql-binary-xyz", timeout: 1000 });
  assert.equal(r.ok, false);
  assert.equal(r.state, "MISSING");
});

// ── Provider failover: credentials + a live two-provider ladder + a completion ─

test("the ADMINISTRATIVE key is recognised in-process; only a boolean leaves the comparison (B7)", () => {
  const root = mkdtempSync(join(tmpdir(), "admin-key-"));
  mkdirSync(join(root, "memory", "upstream"), { recursive: true });
  writeFileSync(join(root, "memory", "upstream", ".admin-key"), "TESTADMIN-admin-value-0000\n");
  const adminKey = readAdministrativeKey(root);
  assert.equal(isAdministrativeKey("TESTADMIN-admin-value-0000", adminKey), true);
  assert.equal(isAdministrativeKey("TESTSCOPED-scoped-value-1111", adminKey), false);
  assert.equal(isAdministrativeKey("TESTADMIN-admin-value-000", adminKey), false, "a prefix is not a match");
  assert.equal(isAdministrativeKey("", adminKey), false, "an empty candidate is never a match");
  assert.equal(isAdministrativeKey("TESTADMIN-admin-value-0000", ""), false, "no administrative key means no match");
  assert.equal(readAdministrativeKey(mkdtempSync(join(tmpdir(), "no-admin-key-"))), "", "a missing key file reads as empty");
});

/** A stub router: programmable /health ladder and /chat/completions answer. */
const stubRouter = ({ ladder, completion }) => new Promise((res) => {
  const s = createServer((req, res2) => {
    req.on("data", () => {});
    req.on("end", () => {
      res2.writeHead(200, { "content-type": "application/json" });
      if (req.url === "/health") return res2.end(JSON.stringify({ status: "ok", ladder }));
      res2.end(JSON.stringify(completion));
    });
  });
  s.listen(0, "127.0.0.1", () => res({
    url: `http://127.0.0.1:${s.address().port}`,
    close: () => new Promise((r) => s.close(r)),
  }));
});

test("the failover proof needs two provider credentials (MISSING otherwise)", async () => {
  const root = mkdtempSync(join(tmpdir(), "failover-root-"));
  mkdirSync(join(root, "secrets"), { recursive: true });
  writeFileSync(join(root, "secrets", "groq-api-key"), "placeholder\n");
  const r = await probeProviderFailover({ root, routerUrl: "http://127.0.0.1:1" });
  assert.equal(r.ok, false);
  assert.equal(r.state, "MISSING");
});

test("a provider credential that cannot complete a minimal real request is INCOMPLETE — never a silent skip", async () => {
  const root = mkdtempSync(join(tmpdir(), "failover-root-"));
  mkdirSync(join(root, "secrets"), { recursive: true });
  writeFileSync(join(root, "secrets", "groq-api-key"), "placeholder\n");
  writeFileSync(join(root, "secrets", "cohere-api-key"), "placeholder\n");
  const rejecting = async () => ({ status: 401, json: async () => ({ error: { message: "bad key" } }) });
  const r = await probeProviderFailover({ root, routerUrl: "http://127.0.0.1:1", fetchImpl: rejecting });
  assert.equal(r.ok, false, r.detail);
  assert.equal(r.state, "INCOMPLETE");
  assert.match(r.detail, /rejected with HTTP 401/);
});

test("rate-limited live providers are INCOMPLETE (retry later), never a pass", async () => {
  const root = mkdtempSync(join(tmpdir(), "failover-root-"));
  mkdirSync(join(root, "secrets"), { recursive: true });
  writeFileSync(join(root, "secrets", "groq-api-key"), "placeholder\n");
  writeFileSync(join(root, "secrets", "cohere-api-key"), "placeholder\n");
  const limited = async () => ({ status: 429, json: async () => ({ error: { message: "rate limited" } }) });
  const r = await probeProviderFailover({ root, routerUrl: "http://127.0.0.1:1", fetchImpl: limited });
  assert.equal(r.ok, false);
  assert.match(r.detail, /RATE_LIMITED|rate\s?limited/i);
});

test("both live providers verified + controlled fallback proven = VERIFIED (mock upstreams, no quota burn beyond two ping calls)", async () => {
  const root = mkdtempSync(join(tmpdir(), "failover-root-"));
  mkdirSync(join(root, "secrets"), { recursive: true });
  writeFileSync(join(root, "secrets", "groq-api-key"), "placeholder\n");
  writeFileSync(join(root, "secrets", "cohere-api-key"), "placeholder\n");
  const liveOK = async () => ({ status: 200, json: async () => ({ choices: [{ message: { content: "pong" } }] }) });
  const r = await probeProviderFailover({ root, routerUrl: "http://127.0.0.1:1", fetchImpl: liveOK });
  assert.equal(r.ok, true, r.detail);
  assert.equal(r.state, "VERIFIED");
  assert.match(r.detail, /lastModel=cohere-a\+/);
});

test("a production router advertising ONE provider cannot host a controlled fallback — the gate says so explicitly", async () => {
  const root = mkdtempSync(join(tmpdir(), "failover-root-"));
  mkdirSync(join(root, "secrets"), { recursive: true });
  writeFileSync(join(root, "secrets", "groq-api-key"), "placeholder\n");
  writeFileSync(join(root, "secrets", "cohere-api-key"), "placeholder\n");
  const one = await stubRouter({ ladder: ["groq-120b"], completion: { choices: [] }, inject: null });
  try {
    // layer-1 fetches must look like completions; the /health fetch must answer
    // like health. The /health call is proxied to the REAL stub router here.
    const mixed = async (url) => {
      if (String(url).includes("/health")) {
        const res = await fetch(url);
        return { status: 200, ok: true, json: async () => res.clone ? await res.json() : res };
      }
      return { status: 200, ok: true, json: async () => ({ choices: [{ message: { content: "pong" } }] }) };
    };
    const r = await probeProviderFailover({ root, routerUrl: one.url, fetchImpl: mixed });
    assert.equal(r.ok, false);
    assert.equal(r.state, "INCOMPLETE");
    assert.match(r.detail, /runs 1 provider/);
  } finally { await one.close(); }
});

test("provider credentials that cannot be reached are INCOMPLETE with the real reason — never a silent pass", async () => {
  const root = mkdtempSync(join(tmpdir(), "failover-root-"));
  mkdirSync(join(root, "secrets"), { recursive: true });
  writeFileSync(join(root, "secrets", "groq-api-key"), "placeholder\n");
  writeFileSync(join(root, "secrets", "cohere-api-key"), "placeholder\n");
  const unreachable = async () => { throw new Error("connect ECONNREFUSED"); };
  const r = await probeProviderFailover({ root, routerUrl: "http://127.0.0.1:1", fetchImpl: unreachable });
  assert.equal(r.ok, false);
  assert.equal(r.state, "INCOMPLETE");
  assert.match(r.detail, /unreachable/);
});
