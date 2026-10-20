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
  isCharterFor,
  listAgents,
  loadIdentityMap,
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
// Live-verify mock: a search returns the stored charter for agents that were
// really seeded, so a cached ledger entry is proven to exist instead of being
// reported from the cache alone.
const liveFetch = (calls, seeded = new Set()) => async (url, init) => {
  const body = JSON.parse(init.body);
  calls.push({ url, body });
  if (url.endsWith("/v3/conversation/search")) {
    const name = body.agent_id;
    const messages = seeded.has(name)
      ? [{ id: `m-${name}`, session_id: `agent-profile-${name}`, content: `Persistent MemoryCore profile for OpenChamber agent "${name}" (Singularity-RepoQL). Role: x` }]
      : [];
    return new Response(JSON.stringify({ code: 0, data: { messages } }), { status: 200 });
  }
  seeded.add(body.agent_id);
  return new Response(JSON.stringify({ code: 0, data: { accepted_ids: ["id-1"] } }), { status: 200 });
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

test("first run seeds each agent under its own scope; the second run verifies live and writes nothing", async () => {
  const fx = fixture({ alpha: md("A role"), beta: md("B role") });
  const calls = [];
  const seeded = new Set();
  const opts = { agentsDir: fx.agentsDir, ledgerPath: fx.ledgerPath, env: {}, cfg, fetchImpl: liveFetch(calls, seeded), now };

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
  assert.deepEqual(second.results.map((r) => r.status), ["verified", "verified"]);
  assert.equal(calls.filter((c) => c.url.endsWith("/v3/conversation/add")).length, 2, "no new MemoryCore writes on re-run");
  assert.equal(calls.filter((c) => c.url.endsWith("/v3/conversation/search")).length, 2, "each cached profile is probed live");
});

test("a stale ledger entry is re-seeded, never reported as a live profile", async () => {
  const fx = fixture({ alpha: md("A role") });
  const calls = [];
  const opts = { agentsDir: fx.agentsDir, ledgerPath: fx.ledgerPath, env: {}, cfg, fetchImpl: okFetch(calls), now };
  const first = await provisionAgentProfiles(opts);
  assert.deepEqual(first.results.map((r) => r.status), ["seeded"]);
  // The ledger claims alpha, but the live probe finds no charter for it.
  const second = await provisionAgentProfiles(opts);
  assert.deepEqual(second.results.map((r) => r.status), ["seeded"], "a stale ledger entry is not a live profile");
  assert.ok(calls.some((c) => c.url.endsWith("/v3/conversation/search")), "the cached profile was probed live");
  assert.ok(calls.filter((c) => c.url.endsWith("/v3/conversation/add")).length === 2, "a stale profile is re-seeded");
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

  const second = await provisionAgentProfiles({ ...opts, fetchImpl: liveFetch([], new Set(["alpha"])) });
  assert.deepEqual(second.results.map((r) => r.status), ["verified", "seeded"]);
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

// ---- identity-map mode (bind to existing MemoryCore identities; verify before seed) ----
const mapFor = (names) =>
  Object.fromEntries(names.map((n) => [n, { team_id: "team-shared", user_id: "usr-shared", agent_id: `agt-${n}` }]));
const routedFetch = (calls, { search }) => async (url, init) => {
  const body = JSON.parse(init.body);
  calls.push({ url, body });
  if (url.endsWith("/v3/conversation/search")) {
    return new Response(JSON.stringify(search), { status: 200 });
  }
  return new Response(JSON.stringify({ code: 0, data: { accepted_ids: ["id-1"] } }), { status: 200 });
};

test("identity map: an existing charter is verified and nothing is written", async () => {
  const { agentsDir, ledgerPath } = fixture({ board: md("b") });
  const calls = [];
  const out = await provisionAgentProfiles({
    agentsDir, ledgerPath, cfg, now, identityMap: mapFor(["board"]), env: {},
    fetchImpl: routedFetch(calls, { search: { code: 0, data: { messages: [{ id: "m1", content: "Role charter (seeded 2026-10-19): ... for the OpenChamber agent role 'board'." }] } } }),
  });
  assert.equal(out.failed, 0);
  assert.equal(out.results[0].status, "verified");
  assert.equal(calls.length, 1, "only the search, no conversation/add");
  assert.equal(calls[0].url.endsWith("/v3/conversation/search"), true);
  assert.equal(calls[0].body.team_id, "team-shared");
  assert.equal(calls[0].body.agent_id, "agt-board");
  const ledger = readLedger(ledgerPath);
  assert.equal(ledger.profiles.board.agent_id, "agt-board");
  assert.equal(ledger.profiles.board.source, "existing");
});

test("identity map: a missing charter is seeded under the mapped identity", async () => {
  const { agentsDir, ledgerPath } = fixture({ board: md("b") });
  const calls = [];
  const out = await provisionAgentProfiles({
    agentsDir, ledgerPath, cfg, now, identityMap: mapFor(["board"]), env: {},
    fetchImpl: routedFetch(calls, { search: { code: 0, data: { messages: [] } } }),
  });
  assert.equal(out.results[0].status, "seeded");
  assert.equal(calls.length, 2, "search then conversation/add");
  assert.equal(calls[1].url.endsWith("/v3/conversation/add"), true);
  assert.equal(calls[1].body.agent_id, "agt-board");
});

test("identity map: an agent absent from the map fails without contacting MemoryCore", async () => {
  const { agentsDir, ledgerPath } = fixture({ board: md("b"), explore: md("e") });
  const calls = [];
  const out = await provisionAgentProfiles({
    agentsDir, ledgerPath, cfg, now, identityMap: mapFor(["board"]), env: {},
    fetchImpl: routedFetch(calls, { search: { code: 0, data: { messages: [] } } }),
  });
  const explore = out.results.find((r) => r.name === "explore");
  assert.equal(explore.status, "failed");
  assert.equal(explore.detail, "no identity in map");
  assert.equal(calls.every((c) => c.body.agent_id !== undefined && c.body.agent_id !== "explore"), true);
});

test("identity map: a failed verify is reported and writes nothing", async () => {
  const { agentsDir, ledgerPath } = fixture({ board: md("b") });
  const out = await provisionAgentProfiles({
    agentsDir, ledgerPath, cfg, now, identityMap: mapFor(["board"]), env: {},
    fetchImpl: async () => { throw new TypeError("fetch failed"); },
  });
  assert.equal(out.failed, 1);
  assert.equal(out.results[0].status, "failed");
  assert.equal(existsSync(ledgerPath), false);
});

test("identity map: dry run only reports would-verify and never calls MemoryCore", async () => {
  const { agentsDir, ledgerPath } = fixture({ board: md("b") });
  const calls = [];
  const out = await provisionAgentProfiles({
    agentsDir, ledgerPath, cfg, now, dryRun: true, identityMap: mapFor(["board"]), env: {},
    fetchImpl: routedFetch(calls, { search: { code: 0, data: { messages: [] } } }),
  });
  assert.equal(out.results[0].status, "would-verify");
  assert.equal(calls.length, 0);
});

test("loadIdentityMap keeps complete entries and rejects a map without agents", () => {
  const dir = mkdtempSync(join(tmpdir(), "identity-map-"));
  const good = join(dir, "good.json");
  writeFileSync(good, JSON.stringify({ agents: {
    board: { team_id: "t", user_id: "u", agent_id: "a" },
    partial: { team_id: "t" },
  } }));
  assert.deepEqual(loadIdentityMap(good), { board: { team_id: "t", user_id: "u", agent_id: "a" } });
  const bad = join(dir, "bad.json");
  writeFileSync(bad, JSON.stringify({ teams: {} }));
  assert.throws(() => loadIdentityMap(bad), /no agents object/);
});

test("identity map: an unrelated stored message does NOT count as a charter (seeds instead)", async () => {
  const { agentsDir, ledgerPath } = fixture({ board: md("b") });
  const calls = [];
  const out = await provisionAgentProfiles({
    agentsDir, ledgerPath, cfg, now, identityMap: mapFor(["board"]), env: {},
    fetchImpl: routedFetch(calls, { search: { code: 0, data: { messages: [{ id: "m2", content: "user chat about lunch" }] } } }),
  });
  assert.equal(out.results[0].status, "seeded");
  assert.equal(calls.some((c) => c.url.endsWith("/v3/conversation/add")), true);
});

test("isCharterFor accepts the seeder session and both charter wordings only", () => {
  assert.equal(isCharterFor({ session_id: "agent-profile-board", content: "x" }, "board", "agent-profile-board"), true);
  assert.equal(isCharterFor({ content: "for the OpenChamber agent role 'board'." }, "board", "agent-profile-board"), true);
  assert.equal(isCharterFor({ content: 'OpenChamber agent "board" seeded' }, "board", "agent-profile-board"), true);
  assert.equal(isCharterFor({ content: "OpenChamber agent role 'explore'" }, "board", "agent-profile-board"), false);
  assert.equal(isCharterFor({ content: "lunch" }, "board", "agent-profile-board"), false);
  assert.equal(isCharterFor(null, "board", "agent-profile-board"), false);
});

test("a ledger entry under a different agent_id is re-verified, not reported present", async () => {
  const { agentsDir, ledgerPath } = fixture({ board: md("b") });
  mkdirSync(join(ledgerPath, ".."), { recursive: true });
  writeFileSync(ledgerPath, JSON.stringify({ version: 1, profiles: { board: {
    team_id: "team-shared", user_id: "usr-shared", agent_id: "agt-OLD", seeded_at: "x" } } }));
  const calls = [];
  const out = await provisionAgentProfiles({
    agentsDir, ledgerPath, cfg, now, identityMap: mapFor(["board"]), env: {},
    fetchImpl: routedFetch(calls, { search: { code: 0, data: { messages: [] } } }),
  });
  assert.notEqual(out.results[0].status, "present");
  assert.equal(calls[0].body.agent_id, "agt-board");
});
