// Unit tests for scripts/setup-agent-profiles.mjs — no MemoryCore is contacted;
// fetch is faked. Run: node --test scripts/setup-agent-profiles.test.mjs
import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  agentDescription,
  charterFor,
  identityFor,
  listAgents,
  provisionAgentProfiles,
  readLedger,
} from "./setup-agent-profiles.mjs";

const md = (desc) => `---\ndescription: ${desc}\nmode: subagent\n---\nbody\n`;
const cfg = {
  baseUrl: "http://memory.test",
  authPrefix: "Bearer ",
  gatewayKey: "test-key",
  userKey: "",
  serviceId: "default",
  identity: { user_id: "operator-test" },
};
const fixture = (agents) => {
  const dir = mkdtempSync(join(tmpdir(), "agent-profiles-"));
  const agentsDir = join(dir, "agents");
  mkdirSync(agentsDir);
  for (const [name, text] of Object.entries(agents)) writeFileSync(join(agentsDir, `${name}.md`), text);
  writeFileSync(join(agentsDir, "NOTES.txt"), "not an agent definition");
  return { agentsDir, ledgerPath: join(dir, "data", "ledger.json") };
};
const okFetch = (calls, accepted = ["id-1"]) => async (url, init) => {
  calls.push({ url, body: JSON.parse(init.body) });
  return new Response(JSON.stringify({ code: 0, data: { accepted_ids: accepted } }), { status: 200 });
};
const now = () => "2026-10-20T00:00:00Z";

test("listAgents returns agent .md files sorted, excluding Ghost (already self-profiled)", () => {
  const { agentsDir } = fixture({ thinker: md("t"), ghost: md("g"), board: md("b") });
  assert.deepEqual(listAgents(agentsDir), ["board", "thinker"]);
});

test("agentDescription joins folded multi-line YAML description", () => {
  const t = "---\ndescription: Ghost — persistent companion\n  agent that dreams.\nmode: primary\n---\n";
  assert.equal(agentDescription(t), "Ghost — persistent companion agent that dreams.");
  assert.equal(agentDescription("no frontmatter"), "");
});

test("charterFor names the agent and carries its role", () => {
  const c = charterFor("explore", md("Fast codebase explorer"));
  assert.match(c, /"explore"/);
  assert.match(c, /Role: Fast codebase explorer/);
});

test("identityFor: agent name is agent_id; team and user are overridable", () => {
  assert.deepEqual(identityFor("board", {}, { user_id: "u1" }), {
    team_id: "openchamber-agents",
    user_id: "u1",
    agent_id: "board",
  });
  assert.deepEqual(identityFor("board", { AGENT_PROFILE_TEAM: "t2", AGENT_PROFILE_USER: "u2" }, {}), {
    team_id: "t2",
    user_id: "u2",
    agent_id: "board",
  });
});

test("first run seeds each agent under its own scope; second run is a no-op", async () => {
  const fx = fixture({ alpha: md("A role"), beta: md("B role") });
  const calls = [];
  const opts = { agentsDir: fx.agentsDir, ledgerPath: fx.ledgerPath, env: {}, cfg, fetchImpl: okFetch(calls), now };

  const first = await provisionAgentProfiles(opts);
  assert.equal(first.failed, 0);
  assert.deepEqual(first.results.map((r) => r.status), ["seeded", "seeded"]);
  assert.deepEqual(calls.map((c) => c.body.agent_id), ["alpha", "beta"]);
  assert.ok(calls.every((c) => c.body.team_id === "openchamber-agents" && c.body.user_id === "operator-test"));
  assert.ok(calls.every((c) => c.url === "http://memory.test/v3/conversation/add"));
  assert.match(calls[0].body.messages[0].content, /"alpha"/);
  assert.ok(existsSync(fx.ledgerPath));
  assert.deepEqual(Object.keys(readLedger(fx.ledgerPath).profiles).sort(), ["alpha", "beta"]);

  const second = await provisionAgentProfiles(opts);
  assert.deepEqual(second.results.map((r) => r.status), ["present", "present"]);
  assert.equal(calls.length, 2, "no new MemoryCore writes on re-run");
});

test("a MemoryCore rejection is reported as failed and not recorded in the ledger", async () => {
  const fx = fixture({ alpha: md("A role") });
  const fetchImpl = async () => new Response(JSON.stringify({ code: 50001, message: "boom" }), { status: 200 });
  const out = await provisionAgentProfiles({ agentsDir: fx.agentsDir, ledgerPath: fx.ledgerPath, env: {}, cfg, fetchImpl, now });
  assert.equal(out.failed, 1);
  assert.equal(out.results[0].status, "failed");
  assert.equal(out.results[0].detail, "boom");
  assert.equal(existsSync(fx.ledgerPath), false);
});

test("partial failure seeds the good agents and retries only the failed one", async () => {
  const fx = fixture({ alpha: md("A"), beta: md("B") });
  let n = 0;
  const calls = [];
  const fetchImpl = async (url, init) => {
    calls.push(JSON.parse(init.body).agent_id);
    n += 1;
    const ok = n !== 2; // second call (beta) fails on the first run
    return new Response(JSON.stringify(ok ? { code: 0, data: { accepted_ids: ["x"] } } : { code: 1, message: "down" }), { status: 200 });
  };
  const opts = { agentsDir: fx.agentsDir, ledgerPath: fx.ledgerPath, env: {}, cfg, fetchImpl, now };
  const first = await provisionAgentProfiles(opts);
  assert.deepEqual(first.results.map((r) => r.status), ["seeded", "failed"]);
  assert.deepEqual(Object.keys(readLedger(fx.ledgerPath).profiles), ["alpha"]);

  const second = await provisionAgentProfiles({ ...opts, fetchImpl: okFetch([]) });
  assert.deepEqual(second.results.map((r) => r.status), ["present", "seeded"]);
  assert.equal(second.failed, 0);
});

test("accepted_ids empty counts as failure even with code 0", async () => {
  const fx = fixture({ alpha: md("A") });
  const out = await provisionAgentProfiles({
    agentsDir: fx.agentsDir, ledgerPath: fx.ledgerPath, env: {}, cfg,
    fetchImpl: okFetch([], []), now,
  });
  assert.equal(out.failed, 1);
});

test("dry-run makes no network calls and writes no ledger", async () => {
  const fx = fixture({ alpha: md("A"), beta: md("B") });
  const fetchImpl = async () => { throw new Error("network must not be touched in dry-run"); };
  const out = await provisionAgentProfiles({ agentsDir: fx.agentsDir, ledgerPath: fx.ledgerPath, dryRun: true, env: {}, cfg, fetchImpl, now });
  assert.deepEqual(out.results.map((r) => r.status), ["would-seed", "would-seed"]);
  assert.equal(existsSync(fx.ledgerPath), false);
});

test("a thrown request is a per-agent failure; other agents still seed and persist", async () => {
  const fx = fixture({ alpha: md("A"), beta: md("B") });
  const fetchImpl = async (url, init) => {
    if (JSON.parse(init.body).agent_id === "alpha") throw new TypeError("fetch failed");
    return new Response(JSON.stringify({ code: 0, data: { accepted_ids: ["x"] } }), { status: 200 });
  };
  const out = await provisionAgentProfiles({ agentsDir: fx.agentsDir, ledgerPath: fx.ledgerPath, env: {}, cfg, fetchImpl, now });
  assert.deepEqual(out.results.map((r) => r.status), ["failed", "seeded"]);
  assert.equal(out.results[0].detail, "request error: TypeError");
  assert.deepEqual(Object.keys(readLedger(fx.ledgerPath).profiles), ["beta"], "success persisted even though a later agent failed");
});

test("changing the team/user override re-seeds instead of reporting a false present", async () => {
  const fx = fixture({ alpha: md("A") });
  const calls = [];
  const base = { agentsDir: fx.agentsDir, ledgerPath: fx.ledgerPath, cfg, fetchImpl: okFetch(calls), now };
  await provisionAgentProfiles({ ...base, env: {} });
  const again = await provisionAgentProfiles({ ...base, env: { AGENT_PROFILE_TEAM: "other-team", AGENT_PROFILE_USER: "other-user" } });
  assert.equal(again.results[0].status, "seeded");
  assert.equal(calls.length, 2);
  assert.equal(calls[1].body.team_id, "other-team");
  assert.equal(calls[1].body.user_id, "other-user");
  const rec = readLedger(fx.ledgerPath).profiles.alpha;
  assert.equal(rec.team_id, "other-team");
});

test("a corrupt ledger throws instead of re-seeding every profile", () => {
  const fx = fixture({ alpha: md("A") });
  mkdirSync(join(fx.ledgerPath, ".."), { recursive: true });
  writeFileSync(fx.ledgerPath, "{not json");
  assert.throws(() => readLedger(fx.ledgerPath));
});
