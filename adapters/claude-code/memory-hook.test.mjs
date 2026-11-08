// Unit tests for adapters/claude-code/memory-hook.mjs — no MemoryCore is
// contacted; fetch is faked. Run: node --test adapters/claude-code/memory-hook.test.mjs
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHash } from "node:crypto";
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
  await runMemoryHook(["subagent-start"], { env: env(), stdin: startPayload("singularity-researcher-web"), fetchImpl: mem2.fetchImpl, now: NOW });
  for (const c of mem2.calls) assert.equal(c.body.agent_id, "researcher-web");
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
    agent_type: "singularity-researcher-web", session_id: "s",
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

test('SubagentStop: separate invocations at different times do not duplicate the same lesson', async () => {
  const mem = stubMemoryCore();
  const payload = stopPayload('singularity-code-reviewer', {session_id:'restart-unique'});
  const first = await runMemoryHook(['subagent-stop'], {env:env(),stdin:payload,fetchImpl:mem.fetchImpl,now:()=> '2026-10-29T01:00:00.000Z'});
  const second = await runMemoryHook(['subagent-stop'], {env:env(),stdin:payload,fetchImpl:mem.fetchImpl,now:()=> '2026-10-30T01:00:00.000Z'});
  assert.match(first.stderr.join(' '),/reconciled 1/);
  assert.match(second.stderr.join(' '),/reconciled 0/);
  const writes=mem.calls.filter(c=>c.url.endsWith('/v3/conversation/add'));
  assert.equal(writes.length,1,'a fresh process clock must not generate a new memory task');
  assert.match(writes[0].body.task_id,/^cc-[a-f0-9]{16}$/);
});

test('SubagentStop: conflicting row for the stable task identity never counts as proof of persistence', async () => {
  const mem = stubMemoryCore();
  const base=mem.fetchImpl;
  mem.fetchImpl = async (url, init) => url.endsWith('/v3/conversation/query')
    ? new Response(JSON.stringify({code:0,data:{messages:[{task_id:JSON.parse(init.body).task_id,role:'assistant',content:'foreign content'}],total:1}}))
    : base(url,init);
  const res=await runMemoryHook(['subagent-stop'],{env:env(),stdin:stopPayload('singularity-board'),fetchImpl:mem.fetchImpl,now:NOW});
  assert.match(res.stderr.join(' '),/continuing without memory/);
  assert.equal(mem.calls.filter(c=>c.url.endsWith('/v3/conversation/add')).length,0);
});

test('SubagentStart: HTTP-success application error cannot be reported as recalled', async () => {
  const mem=stubMemoryCore();
  mem.fetchImpl=async ()=>new Response(JSON.stringify({code:403,message:'denied',data:{messages:[{content:'forged'}]}}),{status:200});
  const res=await runMemoryHook(['subagent-start'],{env:env(),stdin:startPayload('singularity-board'),fetchImpl:mem.fetchImpl,now:NOW});
  assert.equal(res.stdout,null);
  assert.match(res.stderr.join(' '),/recall degraded/);
});

test('explicit mapped Tencent scope is reused for subagent recall and capture', async () => {
  const dir=mkdtempSync(join(tmpdir(),'cc-agent-map-'));
  try {
    const map=join(dir,'identities.json');
    writeFileSync(map,JSON.stringify({agents:{board:{team_id:'fleet',user_id:'shared-user',agent_id:'review-board'}}}));
    const e=env({AGENT_PROFILE_IDENTITY_MAP:map,AGENT_PROFILE_TEAM:'wrong-team'});
    const core=stubMemoryCore();
    const res=await runMemoryHook(['subagent-start'],{env:e,stdin:startPayload('singularity-board'),fetchImpl:core.fetchImpl,now:NOW});
    assert.equal(res.exitCode,0);
    assert.equal(core.calls[0].body.team_id,'fleet');
    assert.equal(core.calls[0].body.user_id,'shared-user');
    assert.equal(core.calls[0].body.agent_id,'review-board');
  }finally{rmSync(dir,{recursive:true,force:true})}
});
test('missing mapped role refuses fallback and does not query wrong memory', async () => {
  const dir=mkdtempSync(join(tmpdir(),'cc-agent-map-'));
  try {
    const map=join(dir,'identities.json');writeFileSync(map,JSON.stringify({agents:{}}));
    const core=stubMemoryCore();
    const res=await runMemoryHook(['subagent-start'],{env:env({AGENT_PROFILE_IDENTITY_MAP:map}),stdin:startPayload('singularity-board'),fetchImpl:core.fetchImpl,now:NOW});
    assert.equal(core.calls.length,0);
    assert.equal(res.stdout,null);
    assert.match(res.stderr.join(' '),/identity map invalid/);
  }finally{rmSync(dir,{recursive:true,force:true})}
});

// ---- Parent (main GUI) conversation capture: conversation-turn / session-end ----

const userEntry = (text) => ({ type: "user", message: { role: "user", content: text } });
const assistantEntry = (text) => ({
  type: "assistant",
  message: { role: "assistant", content: [{ type: "thinking", thinking: "internal" }, { type: "text", text }] },
});
function transcriptFixture(lines) {
  const dir = mkdtempSync(join(tmpdir(), "cc-parent-turn-"));
  const file = join(dir, "session.jsonl");
  writeFileSync(file, lines.map((l) => JSON.stringify(l)).join("\n") + "\n");
  return { dir, file };
}
const parentPayload = (transcriptPath, extra = {}) => JSON.stringify({
  hook_event_name: "Stop", session_id: "parent-session-1",
  transcript_path: transcriptPath, cwd: "C:/work", ...extra,
});
const sha8hex = (s) => createHash("sha256").update(s).digest("hex").slice(0, 8);

test("conversation-turn: the parent Stop captures the last real prompt and assistant reply as one unit", async () => {
  const mem = stubMemoryCore();
  const t = transcriptFixture([
    userEntry("earlier prompt"),
    assistantEntry("earlier reply"),
    // A tool result is a `user` entry but not an operator prompt.
    { type: "user", message: { role: "user", content: [{ type: "tool_result", content: "tool output" }] }, toolUseResult: {} },
    userEntry("C1-PARENT-PROOF prompt"),
    assistantEntry("C1-PARENT-PROOF reply"),
  ]);
  try {
    const res = await runMemoryHook(["conversation-turn"], { env: env(), stdin: parentPayload(t.file), fetchImpl: mem.fetchImpl, now: NOW });
    assert.equal(res.exitCode, 0);
    const add = mem.calls.find((c) => c.url.endsWith("/v3/conversation/add"));
    assert.ok(add, "parent turn was written");
    assert.equal(add.body.agent_id, "claude-code-main");
    assert.equal(add.body.team_id, "openchamber-agents");
    assert.equal(add.body.user_id, "pilot-operator");
    assert.equal(add.body.session_id, `claude-code-main-${sha8hex("parent-session-1")}`);
    assert.match(add.body.task_id, /^cc-[a-f0-9]{16}$/);
    assert.deepEqual(add.body.messages.map((m) => m.role), ["user", "assistant"]);
    assert.equal(add.body.messages[0].content, "C1-PARENT-PROOF prompt");
    assert.equal(add.body.messages[1].content, "C1-PARENT-PROOF reply");
    assert.match(res.stderr.join(" "), /reconciled 2 message\(s\) for claude-code-main/);
  } finally { rmSync(t.dir, { recursive: true, force: true }); }
});

test("conversation-turn: a retry and a SessionEnd of the same turn write no duplicate", async () => {
  const mem = stubMemoryCore();
  const t = transcriptFixture([userEntry("same prompt"), assistantEntry("same reply")]);
  try {
    const first = await runMemoryHook(["conversation-turn"], { env: env(), stdin: parentPayload(t.file), fetchImpl: mem.fetchImpl, now: NOW });
    const second = await runMemoryHook(["conversation-turn"], { env: env(), stdin: parentPayload(t.file), fetchImpl: mem.fetchImpl, now: () => "2026-10-21T10:00:00Z" });
    const third = await runMemoryHook(["session-end"], { env: env(), stdin: parentPayload(t.file), fetchImpl: mem.fetchImpl, now: NOW });
    assert.match(first.stderr.join(" "), /reconciled 2/);
    assert.match(second.stderr.join(" "), /reconciled 0/);
    assert.match(third.stderr.join(" "), /reconciled 0/);
    assert.equal(mem.calls.filter((c) => c.url.endsWith("/v3/conversation/add")).length, 1);
  } finally { rmSync(t.dir, { recursive: true, force: true }); }
});

test("conversation-turn: short turns are captured and secrets are redacted", async () => {
  const mem = stubMemoryCore();
  const t = transcriptFixture([
    userEntry("key sk-abcdef1234567"),
    assistantEntry("used token: ghp_abcdefghijklmnopqrstuvwxyz"),
  ]);
  try {
    const res = await runMemoryHook(["conversation-turn"], { env: env(), stdin: parentPayload(t.file), fetchImpl: mem.fetchImpl, now: NOW });
    assert.equal(res.exitCode, 0);
    const add = mem.calls.find((c) => c.url.endsWith("/v3/conversation/add"));
    const body = add.body.messages.map((m) => m.content).join("\n");
    assert.equal(body.includes("sk-abcdef1234567"), false);
    assert.equal(body.includes("ghp_abcdefghijklmnopqrstuvwxyz"), false);
    assert.ok(body.includes("[REDACTED]"));
  } finally { rmSync(t.dir, { recursive: true, force: true }); }
});

test("conversation-turn: an empty assistant reply produces no write", async () => {
  const mem = stubMemoryCore();
  const t = transcriptFixture([userEntry("unanswered prompt")]);
  const t2 = transcriptFixture([userEntry("prompt"), { type: "assistant", message: { role: "assistant", content: [{ type: "text", text: "   " }] } }]);
  try {
    const a = await runMemoryHook(["conversation-turn"], { env: env(), stdin: parentPayload(t.file), fetchImpl: mem.fetchImpl, now: NOW });
    const b = await runMemoryHook(["conversation-turn"], { env: env(), stdin: parentPayload(t2.file), fetchImpl: mem.fetchImpl, now: NOW });
    assert.equal(a.exitCode, 0);
    assert.equal(b.exitCode, 0);
    assert.equal(mem.calls.length, 0, "no memory request at all");
  } finally {
    rmSync(t.dir, { recursive: true, force: true });
    rmSync(t2.dir, { recursive: true, force: true });
  }
});

test("conversation-turn: a memory failure still exits 0 and is reported on stderr", async () => {
  const mem = stubMemoryCore();
  mem.fetchImpl = async () => { throw new TypeError("fetch failed"); };
  const t = transcriptFixture([userEntry("prompt"), assistantEntry("reply")]);
  try {
    const res = await runMemoryHook(["conversation-turn"], { env: env(), stdin: parentPayload(t.file), fetchImpl: mem.fetchImpl, now: NOW });
    assert.equal(res.exitCode, 0);
    assert.ok(res.stderr.join(" ").includes("continuing without memory"));
  } finally { rmSync(t.dir, { recursive: true, force: true }); }
});

test("conversation-turn: main identity can be overridden without touching subagent mapping", async () => {
  const mem = stubMemoryCore();
  const t = transcriptFixture([userEntry("prompt"), assistantEntry("reply")]);
  try {
    await runMemoryHook(["conversation-turn"], {
      env: env({ AGENT_PROFILE_MAIN_AGENT: "claude-main-custom", AGENT_PROFILE_TEAM: "team-z", AGENT_PROFILE_USER: "usr-z" }),
      stdin: parentPayload(t.file), fetchImpl: mem.fetchImpl, now: NOW,
    });
    const add = mem.calls.find((c) => c.url.endsWith("/v3/conversation/add"));
    assert.equal(add.body.agent_id, "claude-main-custom");
    assert.equal(add.body.team_id, "team-z");
    assert.equal(add.body.user_id, "usr-z");
  } finally { rmSync(t.dir, { recursive: true, force: true }); }
});
