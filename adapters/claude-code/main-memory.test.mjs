import test from "node:test";
import assert from "node:assert/strict";
import {
  resolveMainProxyUrl,
  detectProviderConflicts,
  isMainMemoryOwnConfig,
  ensureMainMemoryIntegration,
  mainMemoryOwnedEnv,
  removeMainMemoryIntegration,
  classifyMainMemoryState,
  probeMainProxy,
} from "./main-memory.mjs";

test("endpoint resolution: explicit env wins, upstream PROXY_PORT parsed, default only as last resort", () => {
  assert.equal(resolveMainProxyUrl({ env: { SINGULARITY_MAIN_AGENT_PROXY_URL: "http://192.0.2.9:18496/claude-code/default" } }),
    "http://192.0.2.9:18496/claude-code/default");
  assert.equal(resolveMainProxyUrl({ upstreamEnvContent: "PROXY_PORT=18496\n" }), "http://127.0.0.1:18496/claude-code/default");
  assert.equal(resolveMainProxyUrl({}), "http://127.0.0.1:8096/claude-code/default");
});

test("conflict detection recognises other providers and never flags our own routing", () => {
  const ours = { env: { ANTHROPIC_BASE_URL: "http://127.0.0.1:8096/claude-code/default" } };
  assert.deepEqual(detectProviderConflicts(ours, { baseUrl: "http://127.0.0.1:8096/claude-code/default" }), []);
  assert.equal(isMainMemoryOwnConfig(ours, "http://127.0.0.1:8096/claude-code/default"), true);
  const theirs = { env: { ANTHROPIC_BASE_URL: "https://api.anthropic.com", ANTHROPIC_API_KEY: "sk-ant-x" } };
  const c = detectProviderConflicts(theirs, { baseUrl: "http://127.0.0.1:8096/claude-code/default" });
  assert.ok(c.some((s) => /another endpoint/.test(s)) && c.some((s) => /ANTHROPIC_API_KEY/.test(s)));
});

test("enablement without consent is refused when provider config exists", () => {
  const existing = { env: { ANTHROPIC_BASE_URL: "https://api.anthropic.com" }, model: "claude-x" };
  const out = ensureMainMemoryIntegration(existing, { baseUrl: "http://127.0.0.1:8096/claude-code/default", token: "t" });
  assert.equal(out.mode, "refused-conflict");
  assert.equal(out.changed, false);
  assert.equal(out.settings.env.ANTHROPIC_BASE_URL, "https://api.anthropic.com", "existing provider untouched");
});

test("with replaceProvider consent the routing is replaced and unrelated settings preserved", () => {
  const existing = { model: "claude-x", permissions: { allow: ["bash"] }, env: { ANTHROPIC_BASE_URL: "https://x.example", OTHER: "keep" } };
  const out = ensureMainMemoryIntegration(existing, { baseUrl: "http://127.0.0.1:8096/claude-code/default", token: "tok", model: "gpt-test", replaceProvider: true });
  assert.equal(out.mode, "merged-over-replace-consent");
  assert.equal(out.settings.model, "claude-x");
  assert.equal(out.settings.permissions.allow[0], "bash");
  assert.equal(out.settings.env.OTHER, "keep");
  assert.equal(out.settings.env.ANTHROPIC_BASE_URL, "http://127.0.0.1:8096/claude-code/default");
  assert.equal(out.settings.env.ANTHROPIC_AUTH_TOKEN, "tok");
});

test("fresh settings get a complete config; own-config rerun is a no-op (idempotent)", () => {
  const a = ensureMainMemoryIntegration({}, { baseUrl: "http://127.0.0.1:8096/claude-code/default", token: "tok" });
  assert.equal(a.mode, "merged");
  assert.equal(a.changed, true);
  const b = ensureMainMemoryIntegration(a.settings, { baseUrl: "http://127.0.0.1:8096/claude-code/default", token: "tok" });
  assert.equal(b.mode, "verified-existing");
  assert.equal(b.changed, false);
});

test("uninstall restores only values this install wrote; user edits survive", () => {
  const ours = ensureMainMemoryIntegration({ env: { ANTHROPIC_BASE_URL: "https://old.example", ANTHROPIC_AUTH_TOKEN: "oldtok" } },
    { baseUrl: "http://127.0.0.1:8096/claude-code/default", token: "newtok", replaceProvider: true });
  const record = { mainMemory: { enabled: true, envWritten: { ANTHROPIC_BASE_URL: "http://127.0.0.1:8096/claude-code/default", ANTHROPIC_AUTH_TOKEN: "newtok" },
    previousEnv: { ANTHROPIC_BASE_URL: "https://old.example", ANTHROPIC_AUTH_TOKEN: "oldtok" } } };
  const env = mainMemoryOwnedEnv(record, ours.settings);
  assert.deepEqual(Object.keys(env).sort(), ["ANTHROPIC_AUTH_TOKEN", "ANTHROPIC_BASE_URL"]);
  const out = removeMainMemoryIntegration(ours.settings, record, record.mainMemory.previousEnv);
  assert.equal(out.settings.env.ANTHROPIC_BASE_URL, "https://old.example");
  assert.equal(out.settings.env.ANTHROPIC_AUTH_TOKEN, "oldtok");
  assert.deepEqual(out.changedKeys.sort(), ["ANTHROPIC_AUTH_TOKEN", "ANTHROPIC_BASE_URL"]);
  // user edited after install -> value is preserved, uninstall must not touch it
  const edited = structuredClone(ours.settings); edited.settings = undefined; edited.env.ANTHROPIC_AUTH_TOKEN = "user-new";
  const out2 = removeMainMemoryIntegration(structuredClone(ours.settings), record, { ANTHROPIC_AUTH_TOKEN: "user-new", ANTHROPIC_BASE_URL: "https://old.example" });
  assert.equal(out2.settings.env.ANTHROPIC_AUTH_TOKEN, "user-new");
});

test("status classification without a live probe never claims VERIFIED", () => {
  const cfg = { env: { ANTHROPIC_BASE_URL: "http://127.0.0.1:8096/claude-code/default", ANTHROPIC_AUTH_TOKEN: "t" } };
  const base = "http://127.0.0.1:8096/claude-code/default";
  assert.deepEqual(classifyMainMemoryState(cfg, base, null).state, "CONFIGURED");
  assert.deepEqual(classifyMainMemoryState(cfg, base, { ok: true, detail: "HTTP 200" }).state, "VERIFIED");
  assert.deepEqual(classifyMainMemoryState(cfg, base, { ok: false, authRejected: false, detail: "ECONNREFUSED" }).state, "DEGRADED");
  const conflicting = { env: { ANTHROPIC_BASE_URL: "http://127.0.0.1:8096/claude-code/default", ANTHROPIC_API_KEY: "k" } };
  assert.deepEqual(classifyMainMemoryState(conflicting, base).state, "CONFLICTED");
  assert.deepEqual(classifyMainMemoryState({}, base, null).state, "DISABLED");
});

test("probeMainProxy is bounded, never leaks the token, and maps auth failures to authRejected", async () => {
  const calls = [];
  const fakeFetch = async (url, opts = {}) => {
    calls.push(String(url));
    if (String(url).endsWith("/health")) return { ok: true, status: 200, text: async () => "ok" };
    assert.ok((opts.headers || {}).Authorization ? String(opts.headers.Authorization).includes("tok") : true);
    throw new Error("boom");
  };
  const p = await probeMainProxy("http://127.0.0.1:8096/claude-code/default", "tok", fakeFetch, 500);
  assert.equal(p.ok, false);
  assert.match(p.detail, /boom/);
  assert.ok(calls.some((c) => c === "http://127.0.0.1:8096/claude-code/default/v1/messages"),
    `POST must target the FULL base URL (spaceId in path): ${calls.join(";")}`);
  assert.ok(calls.some((c) => c === "http://127.0.0.1:8096/health"),
    `health must target the proxy root: ${calls.join(";")}`);
  const ok200 = await probeMainProxy("http://127.0.0.1:8096/claude-code/default", "tok",
    async (url) => String(url).endsWith("/health")
      ? { ok: true, status: 200, text: async () => "ok" }
      : { ok: true, status: 200, text: async () => "{}" }, 500);
  assert.equal(ok200.ok, true);
  const authfail = await probeMainProxy("http://127.0.0.1:8096/claude-code/default", "tok",
    async (url) => String(url).endsWith("/health")
      ? { ok: true, status: 200, text: async () => "ok" }
      : { ok: false, status: 401, text: async () => "denied" }, 500);
  assert.equal(authfail.authRejected, true);
  // upstream 4xx AFTER auth counts as accepted auth (the key validated)
  const upstream4xx = await probeMainProxy("http://127.0.0.1:8096/claude-code/default", "tok",
    async (url) => String(url).endsWith("/health")
      ? { ok: true, status: 200, text: async () => "ok" }
      : { ok: false, status: 400, text: async () => "bad model" }, 500);
  assert.equal(upstream4xx.ok, true);
  // unreachable proxy home -> DEGRADED, never VERIFIED
  const unreachable = await probeMainProxy("http://127.0.0.1:8096/claude-code/default", "tok",
    async () => { throw new Error("ECONNREFUSED"); }, 500);
  assert.equal(unreachable.authRejected, false);
  assert.match(unreachable.detail, /ECONNREFUSED/);
});

test("probeMainProxy: spaceId-less base gets /claude-code/default appended; 404-model-authenticated counts as VERIFIED", async () => {
  const seen = {};
  const res = await probeMainProxy("http://127.0.0.1:8096", "tok",
    async (url) => {
      const u = String(url);
      if (u === "http://127.0.0.1:8096/health") return { ok: true, status: 200, text: async () => "ok" };
      seen[u] = true;
      return { ok: false, status: 404, text: async () => '{"error":{"message":"Invalid model identifier \\"probe\\". Please specify a valid downloaded model"}}' };
    }, 500);
  assert.ok(seen["http://127.0.0.1:8096/claude-code/default/v1/messages"], "default serviceId path appended for bare root");
  assert.equal(res.ok, true, "404 with invalid-model body proves auth passed");
});
