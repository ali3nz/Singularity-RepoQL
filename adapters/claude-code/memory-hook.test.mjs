// Unit tests for adapters/claude-code/memory-hook.mjs — no MemoryCore is
// contacted; fetch is faked. Run: node --test adapters/claude-code/memory-hook.test.mjs
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runMemoryHook, redactSecrets } from "./memory-hook.mjs";

// A stub MemoryCore that records calls and answers like the shipped core.
function stubMemoryCore({ searchResults = [], atomicResults = [], searchError = null } = {}) {
  const calls = [];
  const rows = []; // rows written via /conversation/add, keyed by task_id
  const impl = async (url, init = {}) => {
    const body = (init.body && JSON.parse(init.body)) || {};
    calls.push({ url, body });
    if (url.endsWith("/v3/conversation/search")) {
      if (searchError) throw new TypeError("fetch failed");
      return new Response(JSON.stringify({ code: 0, data: { messages: searchResults } }), { status: 200 });
    }
    if (url.endsWith("/v3/atomic/search")) {
      return new Response(JSON.stringify({ code: 0, data: { items: atomicResults } }), { status: 200 });
    }
    if (url.endsWith("/v3/conversation/query")) {
      const found = rows.filter((r) => r.task_id === body.task_id && body.agent_id === r.agent_id);
      return new Response(JSON.stringify({ code: 0, data: { messages: found, total: found.length } }), { status: 200 });
    }
    if (url.endsWith("/v3/conversation/add")) {
      const incoming = body.messages.map((m) => ({ ...m, task_id: body.task_id, agent_id: body.agent_id }));
      rows.push(...incoming);
      return new Response(JSON.stringify({ code: 0, data: { accepted_ids: incoming.map((_, i) => `id-${i}`) } }), { status: 200 });
    }
    return new Response(JSON.stringify({ code: 1, message: "unknown endpoint" }), { status: 200 });
  };
  return { fetchImpl: impl, calls, rows };
}

// One shared fixture memory.json (fresh tmp dir, written once at load).
const FIXTURE_DIR = mkdtempSync(join(tmpdir(), "cc-hook-"));
const SHARED_CONFIG = join(FIXTURE_DIR, "memory.json");
writeFileSync(SHARED_CONFIG, JSON.stringify({ baseUrl: "http://memory.test:8420", userKey: "test-key" }));

const env = (overrides = {}) => ({
  SINGULARITY_REPO_ROOT: "/srv/singularity",
  SINGULARITY_MEMORY_CONFIG: SHARED_CONFIG,
  ...overrides,
});
const NOW = () => "2026-10-20T09:00:00Z";

const startPayload = (agentType, extra = {}) => JSON.stringify({
  hook_event_name: "SubagentStart", agent_type: agentType, session_id: "s-1",
  cwd: "/home/user/project", prompt: "review the staged diff", ...extra,
});
const stopPayload = (agentType, extra = {}) => JSON.stringify({
  hook_event_name: "SubagentStop", agent_type: agentType, session_id: "s-1",
  last_assistant_message: ("Verdict: APPROVE. The reconciled write path is re-entrancy safe because the query-before-write " +
    "step deduplicates task rows; regression coverage covers partial write failure and retried reconciles.").repeat(2),
  ...extra,
});

test("SubagentStart: bounded recall is returned as additionalContext with correct identity", async () => {
  const mem = stubMemoryCore({ searchResults: [{ content: "review rule: always check exit codes before continuing", timestamp: "2026-10-01T00:00:00Z" }], atomicResults: [{ content: "lesson: reconcile before write" }] });
  const res = await runMemoryHook(["subagent-start"], { env: env(), stdin: startPayload("singularity-code-reviewer"), fetchImpl: mem.fetchImpl, now: NOW });
  assert.equal(res.exitCode, 0);
  assert.ok(res.stdout?.includes("additionalContext"));
  const out = JSON.parse(res.stdout);
  assert.equal(out.hookSpecificOutput.hookEventName, "SubagentStart");
  assert.ok(out.hookSpecificOutput.additionalContext.includes("check exit codes"));
  assert.ok(out.hookSpecificOutput.additionalContext.includes("reconcile before write"));
  // identity: mapped role, default team/user
  const search = mem.calls.find((c) => c.url.endsWith("/v3/conversation/search"));
  assert.equal(search.body.agent_id, "code-reviewer");
  assert.equal(search.body.team_id, "openchamber-agents");
  assert.equal(search.body.user_id, "pilot-operator");
  assert.equal(search.body.limit, 4); // bounded recall
});

test("SubagentStart: identity overrides route recall to the configured team/user", async () => {
  const mem = stubMemoryCore({ searchResults: [] });
  const e = env({ AGENT_PROFILE_TEAM: "team-x", AGENT_PROFILE_USER: "usr-y" });
  await runMemoryHook(["subagent-start"], { env: e, stdin: startPayload("singularity-board"), fetchImpl: mem.fetchImpl, now: NOW });
  const search = mem.calls.find((c) => c.url.endsWith("/v3/conversation/search"));
  assert.equal(search.body.agent_id, "board");
  assert.equal(search.body.team_id, "team-x");
  assert.equal(search.body.user_id, "usr-y");
});

test("SubagentStart: non-Singularity subagents and the parent session never touch memory", async () => {
  const mem = stubMemoryCore();
  await runMemoryHook(["subagent-start"], { env: env(), stdin: startPayload("Explore"), fetchImpl: mem.fetchImpl, now: NOW });
  await runMemoryHook(["subagent-start"], { env: env(), stdin: startPayload("general-purpose"), fetchImpl: mem.fetchImpl, now: NOW });
  await runMemoryHook(["subagent-stop"], { env: env(), stdin: stopPayload("some-other-agent"), fetchImpl: mem.fetchImpl, now: NOW });
  assert.equal(mem.calls.length, 0);
});

test("SubagentStart: an unreachable MemoryCore degrades without breaking the agent", async () => {
  const mem = stubMemoryCore();
  mem.fetchImpl = async () => { throw new TypeError("fetch failed"); };
  const res = await runMemoryHook(["subagent-start"], { env: env(), stdin: startPayload("singularity-thinker"), fetchImpl: mem.fetchImpl, now: NOW });
  assert.equal(res.exitCode, 0);
  assert.equal(res.stdout, null, "nothing is claimed as recalled");
  assert.ok(res.stderr.join(" ").includes("continuing without memory"));
});

test("SubagentStart: no configured install exits silently", async () => {
  const mem = stubMemoryCore();
  const res = await runMemoryHook(["subagent-start"], { env: {}, stdin: startPayload("singularity-explore"), fetchImpl: mem.fetchImpl, now: NOW });
  assert.equal(res.exitCode, 0);
  assert.equal(res.stdout, null);
});

test("SubagentStop: a qualifying lesson is reconciled under the agent's own identity", async () => {
  const mem = stubMemoryCore();
  const res = await runMemoryHook(["subagent-stop"], { env: env(), stdin: stopPayload("singularity-code-reviewer"), fetchImpl: mem.fetchImpl, now: NOW });
  assert.equal(res.exitCode, 0);
  const add = mem.calls.find((c) => c.url.endsWith("/v3/conversation/add"));
  assert.ok(add, "conversation/add was called");
  assert.equal(add.body.agent_id, "code-reviewer", "attribution is the review agent, never the parent");
  assert.equal(add.body.messages[0].role, "assistant");
  assert.ok(add.body.messages[0].content.includes("Singularity lesson from code-reviewer"));
  assert.ok(res.stderr.join(" ").includes("reconciled 1"), "persistence is verified, not assumed");
});

test("SubagentStop: retries of the same invocation are idempotent (no duplicate records)", async () => {
  const mem = stubMemoryCore();
  await runMemoryHook(["subagent-stop"], { env: env(), stdin: stopPayload("singularity-code-reviewer"), fetchImpl: mem.fetchImpl, now: NOW });
  const res = await runMemoryHook(["subagent-stop"], { env: env(), stdin: stopPayload("singularity-code-reviewer"), fetchImpl: mem.fetchImpl, now: NOW });
  const add = mem.calls.find((c) => c.url.endsWith("/v3/conversation/add"));
  // first run: 1 query + 1 add (+1 verify query) ; second run: query finds it, no second add
  assert.ok(mem.calls.some((c) => c.url.endsWith("/v3/conversation/add")));
  assert.ok(!res.stderr.join(" ").includes("reconciled 1"), "second run must not report a new write");
  assert.ok(mem.calls.filter((c) => c.url.endsWith("/v3/conversation/add")).length === 1, "exactly one add across the retry");
});

test("SubagentStop: different agents never cross-attribute (own identity per agent)", async () => {
  const mem = stubMemoryCore();
  await runMemoryHook(["subagent-stop"], { env: env(), stdin: stopPayload("singularity-board"), fetchImpl: mem.fetchImpl, now: NOW });
  await runMemoryHook(["subagent-stop"], { env: env(), stdin: stopPayload("singularity-code-reviewer"), fetchImpl: mem.fetchImpl, now: NOW });
  const adds = mem.calls.filter((c) => c.url.endsWith("/v3/conversation/add"));
  assert.deepEqual(adds.map((c) => c.body.agent_id).sort(), ["board", "code-reviewer"]);
  const boardQuery = mem.calls.find((c) => c.url.endsWith("/v3/conversation/query") && c.body.agent_id === "board");
  assert.ok(boardQuery, "reconciliation queried board's own scope");
  // recall for one agent must filter by that agent's identity only
  const mem2 = stubMemoryCore();
  await runMemoryHook(["subagent-start"], { env: env(), stdin: startPayload("singularity-quality-fixer"), fetchImpl: mem2.fetchImpl, now: NOW });
  for (const c of mem2.calls) assert.equal(c.body.agent_id, "quality-fixer");
});

test("SubagentStop: trivial, interrupted or empty output is never captured", async () => {
  const mem = stubMemoryCore();
  await runMemoryHook(["subagent-stop"], { env: env(), stdin: JSON.stringify({ agent_type: "singularity-thinker", session_id: "s", last_assistant_message: "short" }), fetchImpl: mem.fetchImpl, now: NOW });
  await runMemoryHook(["subagent-stop"], { env: env(), stdin: JSON.stringify({ agent_type: "singularity-thinker", session_id: "s" }), fetchImpl: mem.fetchImpl, now: NOW });
  await runMemoryHook(["subagent-stop"], { env: env(), stdin: JSON.stringify({ agent_type: "singularity-thinker" }), fetchImpl: mem.fetchImpl, now: NOW });
  assert.equal(mem.calls.filter((c) => c.url.endsWith("/v3/conversation/add")).length, 0);
});

test("SubagentStop: secret-shaped values are redacted before persistence", async () => {
  const mem = stubMemoryCore();
  const payload = JSON.stringify({
    agent_type: "singularity-quality-fixer", session_id: "s",
    last_assistant_message: "Configured the client with sk-abcdef1234567 endpoints and long " + "context ".repeat(30),
  });
  await runMemoryHook(["subagent-stop"], { env: env(), stdin: payload, fetchImpl: mem.fetchImpl, now: NOW });
  const add = mem.calls.find((c) => c.url.endsWith("/v3/conversation/add"));
  assert.equal(add.body.messages[0].content.includes("sk-abcdef1234567"), false);
  assert.ok(add.body.messages[0].content.includes("[REDACTED]"));
});

test("SubagentStop: a failed write is a visible degraded state, never a stored claim", async () => {
  const mem = stubMemoryCore();
  mem.fetchImpl = async () => new Response(JSON.stringify({ code: 50001, message: "core down" }), { status: 200 });
  const res = await runMemoryHook(["subagent-stop"], { env: env(), stdin: stopPayload("singularity-explore"), fetchImpl: mem.fetchImpl, now: NOW });
  assert.equal(res.exitCode, 0, "the harness is never blocked");
  assert.ok(res.stderr.join(" ").includes("continuing without memory"), "degraded state recorded");
});

test("WSL2-style Windows drive paths as config targets still resolve (config is read from the mount)", async () => {
  const tmp = join(mkdtempSync(join(tmpdir(), "cc-hook-wsl-")), "memory.json");
  writeFileSync(tmp, JSON.stringify({ baseUrl: "http://127.0.0.1:8420", userKey: "k" }));
  const mem = stubMemoryCore({ searchResults: [] });
  const e = { SINGULARITY_REPO_ROOT: "/mnt/c/Users/me/Singularity-RepoQL", SINGULARITY_MEMORY_CONFIG: tmp };
  const res = await runMemoryHook(["subagent-start"], { env: e, stdin: startPayload("singularity-general"), fetchImpl: mem.fetchImpl, now: NOW });
  assert.equal(res.exitCode, 0);
  assert.ok(mem.calls.length >= 1, "config resolved from the WSL mount location");
});

test("redactSecrets covers common key shapes", () => {
  assert.equal(redactSecrets("sk-abcd1234-AAAA-bbbb token ghp_abcdefghijklmnopqrstuvwxyz AKIAIOSFODNN7EXAMPLE api_key=secretvalue1234").includes("sk-abcd1234"), false);
  assert.ok(redactSecrets("token: ghp_xxxxxxxxxxxxxxxxxxxx").includes("[REDACTED]"));
});
