// Unit test for scripts/install-claude-code.mjs provisionProfiles — no
// MemoryCore is contacted (fetch faked). Verifies the identity-binding
// guarantees: every shipped OpenChamber role except Ghost is mapped to the
// SAME team/user identity that the OpenChamber profile seeder uses.
// Run: node --test scripts/install-claude-code.profiles.test.mjs
import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { provisionProfiles } from "./install-claude-code.mjs";

const repoFixture = () => {
  const root = mkdtempSync(join(tmpdir(), "cc-profiles-"));
  const agentMd = (name) => `---\ndescription: ${name} role\nmode: subagent\n---\nbody\n`;
  const agentsDir = join(root, "openchamber/agents");
  mkdirSync(agentsDir, { recursive: true });
  for (const name of ["thinker", "board", "general"]) writeFileSync(join(agentsDir, `${name}.md`), agentMd(name));
  writeFileSync(join(agentsDir, "ghost.md"), agentMd("ghost")); // must be excluded
  const configDir = join(root, "data/opencode/config/product-secrets");
  mkdirSync(configDir, { recursive: true });
  writeFileSync(join(configDir, "memory.json"), JSON.stringify({ baseUrl: "http://memory.test", userKey: "test-key" }));
  return root;
};

test("profiles bind to one shared identity per role; ghost stays excluded; ledger records all passes", async () => {
  const root = repoFixture();
  const calls = [];
  const seeded = new Set();
  const fetchImpl = async (url, init) => {
    const body = JSON.parse(init.body);
    calls.push({ url, body });
    if (url.endsWith("/v3/conversation/search")) {
      const messages = seeded.has(body.agent_id)
        ? [{ id: `m-${body.agent_id}`, session_id: `agent-profile-${body.agent_id}`, content: `Persistent MemoryCore profile for OpenChamber agent "${body.agent_id}" (Singularity-RepoQL). Role: x` }]
        : [];
      return new Response(JSON.stringify({ code: 0, data: { messages } }), { status: 200 });
    }
    seeded.add(body.agent_id);
    return new Response(JSON.stringify({ code: 0, data: { accepted_ids: ["id-1"] } }), { status: 200 });
  };
  const out = await provisionProfiles({ repoRoot: root, env: {}, dryRun: false, log: () => {}, fetchImpl });
  assert.equal(out.failed, 0);
  assert.deepEqual(out.results.map((r) => [r.name, r.status]).sort(), [
    ["board", "seeded"], ["general", "seeded"], ["thinker", "seeded"],
  ], "ghost is never provisioned by this installer");
  const adds = calls.filter((c) => c.url.endsWith("/v3/conversation/add"));
  assert.deepEqual(adds.map((c) => c.body.agent_id).sort(), ["board", "general", "thinker"]);
  assert.ok(adds.every((c) => c.body.team_id === "openchamber-agents" && c.body.user_id === "pilot-operator"),
    "same defaults the OpenChamber profile seeder resolves — one identity per role");

  // second run: the ledger is re-verified LIVE (a read), and nothing is written
  const writesBefore = calls.filter((c) => c.url.endsWith("/v3/conversation/add")).length;
  const searchesBefore = calls.filter((c) => c.url.endsWith("/v3/conversation/search")).length;
  const again = await provisionProfiles({ repoRoot: root, env: {}, dryRun: false, log: () => {}, fetchImpl });
  assert.equal(again.failed, 0);
  assert.deepEqual(again.results.map((r) => r.status), ["verified", "verified", "verified"]);
  assert.equal(calls.filter((c) => c.url.endsWith("/v3/conversation/add")).length, writesBefore,
    "idempotent re-run writes nothing");
  assert.equal(calls.filter((c) => c.url.endsWith("/v3/conversation/search")).length - searchesBefore, 3,
    "each cached profile is probed live before it is reported as verified");

  // ledger is private and records the binding
  const ledgerPath = join(root, "data/agent-profiles/ledger.json");
  assert.ok(existsSync(ledgerPath));
  assert.equal(statSync(ledgerPath).mode & 0o777, 0o600, "ledger with recorded identities is private");
});

test("identity overrides apply (team/user flags route profiles to the mapped scope)", async () => {
  const root = repoFixture();
  const calls = [];
  const fetchImpl = async (url, init) => {
    calls.push({ url, body: JSON.parse(init.body) });
    return new Response(JSON.stringify({ code: 0, data: { accepted_ids: ["id-1"] } }), { status: 200 });
  };
  await provisionProfiles({ repoRoot: root, env: { AGENT_PROFILE_TEAM: "cust-a", AGENT_PROFILE_USER: "usr-a" }, dryRun: false, log: () => {}, fetchImpl });
  assert.ok(calls.every((c) => c.body.team_id === "cust-a" && c.body.user_id === "usr-a"));
});

test("missing memory config skips provisioning with a clear note (hooks still degrade gracefully)", async () => {
  const root = repoFixture();
  (await import("node:fs")).rmSync(join(root, "data/opencode/config/product-secrets/memory.json"));
  let note = "";
  const out = await provisionProfiles({ repoRoot: root, env: {}, dryRun: false, log: (m) => { note = m; }, fetchImpl: async () => { throw new Error("must not be called"); } });
  assert.equal(out.skipped, true);
  assert.ok(note.includes("provision-secrets.py"), note);
});
