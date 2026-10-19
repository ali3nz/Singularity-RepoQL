#!/usr/bin/env node
// setup-agent-profiles.mjs — give every shipped OpenChamber agent its own
// persistent MemoryCore profile, the same way Ghost has one (ghost/ghost-memory.mjs):
// a team/user/agent scope in MemoryCore plus a seeded charter record, so each
// agent's memory exists and can be recalled under its own identity.
//
// Idempotent: profiles recorded in the ledger are skipped, so re-running is safe.
// Ghost is excluded: it already owns its persistent profile (ghost-companion scope,
// see ghost/setup-ghost.sh) and must not gain a second, conflicting `ghost` scope.
//
// Usage:
//   node scripts/setup-agent-profiles.mjs [--dry-run]
// Env:
//   AGENT_PROFILE_TEAM        MemoryCore team_id for agent profiles (default: openchamber-agents)
//   AGENT_PROFILE_USER        MemoryCore user_id (default: the memory config user, else pilot-operator)
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
    const identity = identityFor(name, env, cfg.identity);
    const rec = ledger.profiles[name];
    // Present only when the recorded scope matches the requested scope; a changed
    // team or user override must re-seed, never report a profile that was not written.
    if (rec?.seeded_at && rec.team_id === identity.team_id && rec.user_id === identity.user_id) {
      results.push({ name, status: "present", identity });
      continue;
    }
    if (dryRun) {
      results.push({ name, status: "would-seed", identity });
      continue;
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
  const out = await provisionAgentProfiles({
    agentsDir: join(ROOT, "openchamber/agents"),
    ledgerPath: join(ROOT, "data/agent-profiles/ledger.json"),
    dryRun: argv.includes("--dry-run"),
    env: process.env,
    cfg,
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
