#!/usr/bin/env node
// setup-agent-profiles.mjs — give every shipped OpenChamber agent its own
// persistent MemoryCore profile, the same way Ghost has one (ghost/ghost-memory.mjs):
// a team/user/agent scope in MemoryCore plus a seeded charter record, so each
// agent's memory exists and can be recalled under its own identity.
//
// Idempotent: profiles recorded in the ledger are re-verified live (an
// authenticated search) and only reported "verified" when the charter really
// exists; a stale ledger entry is re-seeded instead of being presented as a
// live profile.
// Ghost is excluded: it already owns its persistent profile (ghost-companion scope,
// see ghost/setup-ghost.sh) and must not gain a second, conflicting `ghost` scope.
//
// Usage:
//   node scripts/setup-agent-profiles.mjs [--dry-run]
// Env:
//   AGENT_PROFILE_TEAM        MemoryCore team_id for agent profiles (default: openchamber-agents)
//   AGENT_PROFILE_USER        MemoryCore user_id (default: the memory config user, else pilot-operator)
//   AGENT_PROFILE_IDENTITY_MAP  optional path to an identity snapshot
//                             ({ agents: { <name>: { team_id, user_id, agent_id } } }). When set, each
//                             agent is bound to its mapped EXISTING identity: a stored charter there is
//                             verified (no write); only a missing one is seeded. Agents absent from the
//                             map fail. AGENT_PROFILE_TEAM/USER are ignored in this mode.
//   SINGULARITY_MEMORY_CONFIG memory connection config
//                             (default: data/opencode/config/product-secrets/memory.json)
// Exit: 0 every profile present; 1 one or more failed; 2 usage error.
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { basename, dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { callMemoryCore, loadGhostMemoryConfig } from "../ghost/ghost-memory.mjs";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
export const DEFAULT_TEAM = "openchamber-agents";
export const SELF_PROFILED = new Set(["ghost"]);

export function listAgents(agentsDir) {
  return readdirSync(agentsDir)
    .filter((f) => f.endsWith(".md"))
    .map((f) => basename(f, ".md"))
    .filter((n) => !SELF_PROFILED.has(n))
    .sort();
}

// Reads the (possibly folded, multi-line) YAML `description:` from agent frontmatter.
export function agentDescription(mdText) {
  const fm = /^---\r?\n([\s\S]*?)\r?\n---/.exec(mdText);
  if (!fm) return "";
  const lines = fm[1].split(/\r?\n/);
  const i = lines.findIndex((l) => /^description:/.test(l));
  if (i < 0) return "";
  const parts = [lines[i].replace(/^description:\s*/, "")];
  for (let j = i + 1; j < lines.length && /^\s/.test(lines[j]); j++) parts.push(lines[j].trim());
  return parts.join(" ").replace(/^["']|["']$/g, "").replace(/\s+/g, " ").trim();
}

export function charterFor(name, mdText) {
  const desc = agentDescription(mdText) || "OpenChamber agent";
  return `Persistent MemoryCore profile for OpenChamber agent "${name}" (Singularity-RepoQL). Role: ${desc}`.slice(0, 1500);
}

export function identityFor(name, env = process.env, baseIdentity = {}) {
  return {
    team_id: env.AGENT_PROFILE_TEAM || DEFAULT_TEAM,
    user_id: env.AGENT_PROFILE_USER || baseIdentity.user_id || "pilot-operator",
    agent_id: name,
  };
}

// Loads an identity snapshot ({ agents: { <name>: { team_id, user_id, agent_id } } }).
// Used to bind variant agents to EXISTING MemoryCore identities (e.g. a shared MemoryCore)
// instead of creating new scopes. Entries missing any of the three keys are dropped.
export function loadIdentityMap(path) {
  const j = JSON.parse(readFileSync(path, "utf8"));
  if (!j || typeof j.agents !== "object" || j.agents === null) {
    throw new Error("identity map has no agents object");
  }
  const map = {};
  for (const [name, a] of Object.entries(j.agents)) {
    if (a && a.team_id && a.user_id && a.agent_id) {
      map[name] = { team_id: a.team_id, user_id: a.user_id, agent_id: a.agent_id };
    }
  }
  return map;
}

// A search hit proves a charter only when it is this agent's charter: either the seeder's own
// session, or the charter wording used by the shared roster ("OpenChamber agent role '<name>'"
// or the seeder's "OpenChamber agent \"<name>\""). Any other stored message under the identity
// (captured chat, notes) must not count, or the profile would be skipped and never seeded.
export function isCharterFor(message, name, session) {
  if (!message) return false;
  if (message.session_id === session) return true;
  const text = String(message.content ?? message.body ?? "");
  return text.includes(`OpenChamber agent role '${name}'`) || text.includes(`OpenChamber agent "${name}"`);
}

export function readLedger(path) {
  if (!existsSync(path)) return { version: 1, profiles: {} };
  // A corrupt ledger must fail loudly: treating it as empty would re-seed every profile.
  const j = JSON.parse(readFileSync(path, "utf8"));
  return { version: 1, profiles: j.profiles || {} };
}

export async function provisionAgentProfiles({
  agentsDir,
  ledgerPath,
  dryRun = false,
  env = process.env,
  cfg,
  identityMap = null,
  fetchImpl = globalThis.fetch,
  now = () => new Date().toISOString(),
}) {
  const ledger = readLedger(ledgerPath);
  const results = [];
  const saveLedger = () => {
    mkdirSync(dirname(ledgerPath), { recursive: true });
    writeFileSync(ledgerPath, JSON.stringify(ledger, null, 2) + "\n", { mode: 0o600 });
  };
  for (const name of listAgents(agentsDir)) {
    // Map mode binds each agent to an existing identity; the env overrides are ignored there.
    let identity;
    if (identityMap) {
      identity = identityMap[name];
      if (!identity) {
        results.push({ name, status: "failed", identity: { team_id: "-", user_id: "-", agent_id: name }, detail: "no identity in map" });
        continue;
      }
    } else {
      identity = identityFor(name, env, cfg.identity);
    }
    const rec = ledger.profiles[name];
    // A cached ledger entry is NOT acceptance evidence. Present only when the
    // recorded scope matches the requested scope; a changed team or user
    // override must re-seed, never report a profile that was not written.
    if (rec?.seeded_at && rec.team_id === identity.team_id && rec.user_id === identity.user_id
        && rec.agent_id === identity.agent_id) {
      if (dryRun) {
        results.push({ name, status: "would-verify", identity });
        continue;
      }
      // Probe the identity LIVE (authenticated search) before reporting it as
      // present: a stale ledger must never be presented as a live profile.
      let live;
      try {
        live = await callMemoryCore("/v3/conversation/search", {
          ...identity,
          query: `OpenChamber agent "${name}" charter`,
          limit: 10,
        }, cfg, fetchImpl);
      } catch (err) {
        results.push({ name, status: "failed", identity, detail: `verify request error: ${err?.name || "error"}` });
        continue;
      }
      if (live.code !== 0) {
        results.push({ name, status: "failed", identity, detail: `verify ${live.message || live.error || `code ${live.code ?? "?"}`}` });
        continue;
      }
      if ((live.data?.messages || []).some((m) => isCharterFor(m, name, `agent-profile-${name}`))) {
        results.push({ name, status: "verified", identity });
        continue;
      }
      // The ledger claims the profile but the live probe found nothing: fall
      // through and seed it again.
    }
    if (dryRun) {
      results.push({ name, status: identityMap ? "would-verify" : "would-seed", identity });
      continue;
    }
    if (identityMap) {
      // Verify before seeding: any stored message under the mapped identity means the
      // profile already exists (shared core), so writing a second charter would duplicate it.
      let found;
      try {
        found = await callMemoryCore("/v3/conversation/search", {
          ...identity,
          query: `OpenChamber agent "${name}" charter`,
          limit: 10,
        }, cfg, fetchImpl);
      } catch (err) {
        results.push({ name, status: "failed", identity, detail: `verify request error: ${err?.name || "error"}` });
        continue;
      }
      if (found.code !== 0) {
        results.push({ name, status: "failed", identity, detail: `verify ${found.message || found.error || `code ${found.code ?? "?"}`}` });
        continue;
      }
      if ((found.data?.messages || []).some((m) => isCharterFor(m, name, `agent-profile-${name}`))) {
        ledger.profiles[name] = { ...identity, session_id: null, seeded_at: now(), source: "existing" };
        saveLedger();
        results.push({ name, status: "verified", identity });
        continue;
      }
      // No existing profile under this identity: fall through and seed it.
    }
    const text = readFileSync(join(agentsDir, `${name}.md`), "utf8");
    const session = `agent-profile-${name}`;
    let r;
    try {
      r = await callMemoryCore("/v3/conversation/add", {
        ...identity,
        session_id: session,
        task_id: `${session}-seed`,
        messages: [{ role: "assistant", content: charterFor(name, text), recorded_at: now() }],
      }, cfg, fetchImpl);
    } catch (err) {
      // One unreachable/throwing call must not abort the other agents.
      results.push({ name, status: "failed", identity, detail: `request error: ${err?.name || "error"}` });
      continue;
    }
    const accepted = r.data?.accepted_ids;
    if (r.code !== 0 || (Array.isArray(accepted) && accepted.length === 0)) {
      results.push({ name, status: "failed", identity, detail: r.message || r.error || `code ${r.code ?? "?"}` });
      continue;
    }
    ledger.profiles[name] = { ...identity, session_id: session, seeded_at: now() };
    // Persist after every success so an interrupted run never re-seeds finished agents.
    if (!dryRun) saveLedger();
    results.push({ name, status: "seeded", identity });
  }
  return { results, failed: results.filter((r) => r.status === "failed").length };
}

async function main(argv) {
  const unknown = argv.filter((a) => a !== "--dry-run");
  if (unknown.length) {
    console.error(`unknown arguments: ${unknown.join(" ")}\nusage: setup-agent-profiles.mjs [--dry-run]`);
    return 2;
  }
  process.env.SINGULARITY_MEMORY_CONFIG ||= join(ROOT, "data/opencode/config/product-secrets/memory.json");
  const cfg = loadGhostMemoryConfig(process.env);
  let identityMap = null;
  if (process.env.AGENT_PROFILE_IDENTITY_MAP) {
    try {
      identityMap = loadIdentityMap(process.env.AGENT_PROFILE_IDENTITY_MAP);
    } catch (err) {
      console.error(`cannot read AGENT_PROFILE_IDENTITY_MAP: ${err.message}`);
      return 2;
    }
  }
  const out = await provisionAgentProfiles({
    agentsDir: join(ROOT, "openchamber/agents"),
    ledgerPath: join(ROOT, "data/agent-profiles/ledger.json"),
    dryRun: argv.includes("--dry-run"),
    env: process.env,
    cfg,
    identityMap,
  });
  for (const r of out.results) {
    const tail = r.detail ? `  - ${r.detail}` : "";
    console.log(`${r.status.padEnd(10)} ${r.name}  team=${r.identity.team_id} user=${r.identity.user_id}${tail}`);
  }
  console.log(`agent profiles: ${out.results.length} agents, ${out.failed} failed`);
  return out.failed ? 1 : 0;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  process.exit(await main(process.argv.slice(2)));
}
