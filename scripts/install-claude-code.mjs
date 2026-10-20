#!/usr/bin/env node
// install-claude-code.mjs — idempotent installer for the Singularity Claude Code
// native-agent integration (the "specialised agents on Claude Code" feature).
//
//   node scripts/install-claude-code.mjs install   [--scope user|project] [--project-dir DIR]
//                                                  [--team T] [--user U] [--skip-profiles]
//                                                  [--skip-repoql-mcp] [--dry-run]
//   node scripts/install-claude-code.mjs uninstall [same scope flags] [--dry-run]
//   node scripts/install-claude-code.mjs status
//
// What "install" does (idempotent — re-running never duplicates anything):
//   1. installs the native Claude Code subagent definitions (adapters/claude-code/agents/)
//      into ~/.claude/agents/ (user scope, default) or <project>/.claude/agents/
//   2. merges SubagentStart (memory recall) + SubagentStop (lesson capture) hooks and the
//      integration env into the settings file — merging, never replacing; a timestamped
//      backup is written before the first modification of this run
//   3. provisions/verifies the SAME MemoryCore profiles the OpenChamber agents use
//      (scripts/setup-agent-profiles.mjs identity-map mode; one logical agent = one identity)
//   4. registers the RepoQL MCP server (user scope) when `claude` and `rql` are present
//   5. records everything it changed in data/claude-code-integration.json so "uninstall"
//      removes only this integration — existing agents, hooks, MCP servers and memories stay.
// Credentials never leave memory.json; nothing secret is written to settings or argv.
import { copyFileSync, existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";
import { AGENT_MAP } from "../adapters/claude-code/agent-map.mjs";
import {
  ensureMemoryIntegration,
  removeMemoryIntegration,
  settingsPathFor,
} from "../adapters/claude-code/settings-merge.mjs";
import { loadGhostMemoryConfig } from "../ghost/ghost-memory.mjs";
import { identityFor, provisionAgentProfiles } from "./setup-agent-profiles.mjs";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const AGENTS_SRC = join(ROOT, "adapters/claude-code/agents");
const HOOK_SCRIPT = join(ROOT, "adapters/claude-code/memory-hook.mjs");
const STATE_FILE = process.env.SINGULARITY_CLAUDE_CODE_STATE
  ? resolve(process.env.SINGULARITY_CLAUDE_CODE_STATE)
  : join(ROOT, "data/claude-code-integration.json");
const MCP_SERVER_NAME = "singularity-repoql";

export class UsageError extends Error {}

const readJson = (p) => { try { return JSON.parse(readFileSync(p, "utf8")); } catch { return null; } };
const newDir = (p) => mkdirSync(p, { recursive: true });

function writeSettingsFile(path, settings) {
  newDir(dirname(path));
  writeFileSync(path, JSON.stringify(settings, null, 2) + "\n", { mode: 0o600 });
}

function backupSettingsFile(path) {
  if (!existsSync(path)) return null;
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  const target = `${path}.bak-singularity-${stamp}`;
  copyFileSync(path, target);
  return target;
}

/** Integration env (paths only — never secrets) written into settings env. */
export function integrationEnv(repoRoot, extra = {}) {
  return {
    SINGULARITY_REPO_ROOT: repoRoot,
    SINGULARITY_MEMORY_CONFIG: join(repoRoot, "data/opencode/config/product-secrets/memory.json"),
    ...extra,
  };
}

function claudeBinary() {
  return spawnSync("claude", ["--version"], { encoding: "utf8" }).status === 0 ? "claude" : null;
}

function resolveRqlCommand(candidate) {
  const probe = spawnSync(candidate, ["--version"], { encoding: "utf8" });
  if (probe.status !== 0) return null;
  if (candidate === "rql") {
    const which = spawnSync("which", ["rql"], { encoding: "utf8" });
    return which.status === 0 && which.stdout.trim() ? which.stdout.trim() : "rql";
  }
  return candidate;
}

/** Detect a runnable Linux rql (env override, PATH, then the WSL2 installer location). */
export function detectRql(home, env = process.env) {
  for (const candidate of [env.REPOQL_RQL_PATH, "rql", join(home || "", ".local/bin/rql")]) {
    if (!candidate) continue;
    const resolved = resolveRqlCommand(candidate);
    if (resolved) return resolved;
  }
  return null;
}

// ── flags ────────────────────────────────────────────────────────────────────
export function parseFlags(argv, home, cwd) {
  const flags = { scope: "user", projectDir: resolve(cwd), team: "", user: "", skipProfiles: false, skipRepoqlMcp: false, dryRun: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--scope") {
      flags.scope = argv[++i];
      if (!["user", "project"].includes(flags.scope)) throw new UsageError("--scope must be user|project");
    } else if (a === "--project-dir") {
      flags.projectDir = resolve(argv[++i]);
    } else if (a === "--team") flags.team = argv[++i];
    else if (a === "--user") flags.user = argv[++i];
    else if (a === "--skip-profiles") flags.skipProfiles = true;
    else if (a === "--skip-repoql-mcp") flags.skipRepoqlMcp = true;
    else if (a === "--dry-run") flags.dryRun = true;
    else throw new UsageError(`unknown argument: ${a}`);
  }
  flags.settingsPath = settingsPathFor(flags.scope, home, flags.projectDir);
  flags.agentsTarget = flags.scope === "project"
    ? join(flags.projectDir, ".claude", "agents")
    : join(home, ".claude", "agents");
  return flags;
}

// ── step 1: agent definition files ───────────────────────────────────────────
export function planAgentFiles(targetDir, sourceDir = AGENTS_SRC) {
  const plan = [];
  for (const file of readdirSync(sourceDir).filter((f) => f.endsWith(".md")).sort()) {
    const source = join(sourceDir, file);
    const target = join(targetDir, file);
    const content = readFileSync(source, "utf8");
    const status = !existsSync(target) ? "create" : (readFileSync(target, "utf8") === content ? "present" : "update");
    plan.push({ source, target, status, content });
  }
  return plan;
}

export function applyAgentFiles(plan, { dryRun }) {
  const changed = [];
  for (const f of plan) {
    if (f.status === "present") continue;
    if (!dryRun) { newDir(dirname(f.target)); writeFileSync(f.target, f.content); }
    changed.push(f.target);
  }
  return changed;
}

// ── step 2: settings hooks + env (merge, never replace; backup first) ────────
export function applySettings(settingsPath, scriptPath, env, { dryRun }) {
  const existing = readJson(settingsPath) || {};
  const { settings: merged, changed } = ensureMemoryIntegration(existing, { scriptPath, env });
  let backup = null;
  if (changed && !dryRun) {
    backup = backupSettingsFile(settingsPath);
    writeSettingsFile(settingsPath, merged);
  }
  return { changed, backup, merged };
}

// ── step 3: MemoryCore profiles (shared identities with OpenChamber) ─────────
// Runs the EXISTING seeder in identity-map mode: every openchamber/agents role
// (except Ghost, which owns its own profile) is bound to the identity the
// AGENT_PROFILE_TEAM/AGENT_PROFILE_USER env (or defaults) resolve — so an
// OpenChamber agent and its Claude Code twin are the SAME MemoryCore identity.
export async function provisionProfiles({ repoRoot, env, dryRun, log, fetchImpl = globalThis.fetch }) {
  const configPath = join(repoRoot, "data/opencode/config/product-secrets/memory.json");
  if (!existsSync(configPath)) {
    log("memory config missing — profiles skipped for now (run python3 scripts/provision-secrets.py, then re-run this installer; the hooks degrade gracefully meanwhile)");
    return { skipped: true, results: [], failed: 0 };
  }
  const agentsDir = join(repoRoot, "openchamber/agents");
  const identities = {};
  for (const f of readdirSync(agentsDir).filter((x) => x.endsWith(".md"))) {
    const name = f.replace(/\.md$/, "");
    if (name === "ghost") continue; // Ghost owns its own ghost-companion profile
    identities[name] = identityFor(name, env);
  }
  const results = await provisionAgentProfiles({
    agentsDir,
    ledgerPath: join(repoRoot, "data/agent-profiles/ledger.json"),
    dryRun,
    env,
    cfg: loadGhostMemoryConfig({ ...env, SINGULARITY_MEMORY_CONFIG: configPath }),
    identityMap: identities,
    fetchImpl,
  });
  return results;
}

// ── step 4: RepoQL MCP (never removes an existing MCP integration) ───────────
export function repoqlMcpPlan({ rqlPath, claudeBin, dryRun, log }) {
  if (!rqlPath) {
    log("RepoQL not detected — skipping MCP registration (see docs/REPOQL-SETUP.md)");
    return null;
  }
  if (!claudeBin) {
    log("claude CLI not found — register the RepoQL MCP server manually:");
    log(`  claude mcp add --scope user --transport stdio ${MCP_SERVER_NAME} -- ${rqlPath} mcp`);
    return null;
  }
  const check = spawnSync(claudeBin, ["mcp", "get", MCP_SERVER_NAME], { encoding: "utf8" });
  if (check.status === 0 && (check.stdout + check.stderr).includes(MCP_SERVER_NAME)) {
    log("RepoQL MCP already configured");
    return { name: MCP_SERVER_NAME, present: true };
  }
  if (!dryRun) {
    const add = spawnSync(claudeBin, ["mcp", "add", "--scope", "user", "--transport", "stdio", MCP_SERVER_NAME, "--", rqlPath, "mcp"], { encoding: "utf8" });
    if (add.status !== 0) {
      log(`claude mcp add failed (rc=${add.status}): ${(add.stderr || add.stdout || "").trim()}`);
      return null;
    }
  }
  return { name: MCP_SERVER_NAME, transport: "stdio", command: rqlPath, scope: "user" };
}

// ── state for safe uninstall ─────────────────────────────────────────────────
export function readState(stateFile = STATE_FILE) {
  return readJson(stateFile) || { version: 1, installs: [] };
}

function writeState(state, stateFile = STATE_FILE) {
  newDir(dirname(stateFile));
  writeFileSync(stateFile, JSON.stringify(state, null, 2) + "\n", { mode: 0o600 });
}

export function saveInstallRecord(record, stateFile = STATE_FILE) {
  const state = readState(stateFile);
  state.installs = state.installs.filter((r) => r.settingsPath !== record.settingsPath);
  state.installs.push(record);
  writeState(state, stateFile);
}

function removeInstallRecord(settingsPath, stateFile = STATE_FILE) {
  const state = readState(stateFile);
  const before = state.installs.length;
  state.installs = state.installs.filter((r) => r.settingsPath !== settingsPath);
  if (state.installs.length !== before) writeState(state, stateFile);
  return before !== state.installs.length;
}

// ── commands ─────────────────────────────────────────────────────────────────
const log = (m) => console.log(m);
const warn = (m) => console.warn(m);

export async function runInstall(flags) {
  log(`installing the Singularity Claude Code integration (${flags.scope} scope)${flags.dryRun ? " — dry run" : ""}`);

  const envOverrides = {
    ...(flags.team ? { AGENT_PROFILE_TEAM: flags.team } : {}),
    ...(flags.user ? { AGENT_PROFILE_USER: flags.user } : {}),
  };
  const envForSettings = integrationEnv(ROOT, envOverrides);

  // 1. agent definition files
  const agentPlan = planAgentFiles(flags.agentsTarget);
  for (const f of agentPlan) log(`  agents:   ${f.status.padEnd(7)} ${f.target}`);
  const agentChanges = applyAgentFiles(agentPlan, { dryRun: flags.dryRun });

  // 2. settings hooks + env
  const settings = applySettings(flags.settingsPath, HOOK_SCRIPT, envForSettings, { dryRun: flags.dryRun });
  log(settings.changed
    ? `  settings: hooks + env merged into ${flags.settingsPath}${settings.backup ? ` (backup: ${settings.backup})` : ""}`
    : `  settings: already up to date (${flags.settingsPath})`);

  // 3. MemoryCore profiles — same identities as OpenChamber
  let profileOutcome = { results: [], failed: 0, skipped: true };
  if (!flags.skipProfiles) {
    const profileEnv = { ...process.env, ...(flags.team ? { AGENT_PROFILE_TEAM: flags.team } : {}), ...(flags.user ? { AGENT_PROFILE_USER: flags.user } : {}) };
    try {
      profileOutcome = await provisionProfiles({ repoRoot: ROOT, env: profileEnv, dryRun: flags.dryRun, log });
      for (const r of profileOutcome.results || []) log(`  profile:  ${r.status.padEnd(7)} ${r.name}`);
      if (profileOutcome.failed) warn(`  ${profileOutcome.failed} profile(s) failed — fix MemoryCore, then re-run this installer`);
    } catch (e) {
      warn(`  profile provisioning error: ${e?.message || e}`);
    }
  } else {
    log("  profiles: skipped (--skip-profiles)");
  }

  // 4. RepoQL MCP
  let mcp = null;
  if (!flags.skipRepoqlMcp) {
    mcp = repoqlMcpPlan({ rqlPath: detectRql(process.env.HOME, process.env), claudeBin: claudeBinary(), dryRun: flags.dryRun, log });
    if (mcp && !mcp.present) log(`  repoql:   registered ${MCP_SERVER_NAME} (stdio: ${mcp.command})`);
  } else {
    log("  repoql:   skipped (--skip-repoql-mcp)");
  }

  // 5. record for safe uninstall
  if (!flags.dryRun) {
    saveInstallRecord({
      installedAt: new Date().toISOString(),
      scope: flags.scope,
      projectDir: flags.scope === "project" ? flags.projectDir : null,
      settingsPath: flags.settingsPath,
      agentsDir: flags.agentsTarget,
      hooksScript: HOOK_SCRIPT,
      envWritten: envForSettings,
      agentsChanged: agentChanges,
      mcp: mcp && !mcp.present ? { name: mcp.name, transport: mcp.transport, command: mcp.command, scope: mcp.scope } : null,
      profileLedger: join(ROOT, "data/agent-profiles/ledger.json"),
    });
  }

  log("next: restart Claude Code, run /agents to confirm discovery, then follow the verification checks in docs/CLAUDE-CODE-SETUP.md");
  return 0;
}

export function uninstallFilesForRecord(record) {
  return Object.keys(AGENT_MAP)
    .map((n) => join(record.agentsDir, `${n}.md`))
    .filter((p) => existsSync(p));
}

export function runUninstall(flags) {
  const record = readState().installs.find((r) => r.settingsPath === flags.settingsPath);
  if (!record) {
    log(`no recorded install for ${flags.settingsPath} — nothing to uninstall`);
    return 0;
  }
  log(`uninstalling the Singularity Claude Code integration (${record.scope})${flags.dryRun ? " — dry run" : ""}`);

  // 1. agent definitions (only ours)
  for (const p of uninstallFilesForRecord(record)) {
    log(`  agent removed: ${p}`);
  }
  if (!flags.dryRun) {
    for (const p of uninstallFilesForRecord(record)) rmSync(p, { force: true });
  }

  // 2. settings hooks + env (only values the installer wrote)
  const envRestore = { ...(record.envWritten || {}) };
  const existing = readJson(flags.settingsPath) || {};
  const { settings: cleaned, changed, removedEnvKeys } = removeMemoryIntegration(existing, { scriptPath: record.hooksScript, env: envRestore });
  if (changed && !flags.dryRun) {
    const backup = backupSettingsFile(flags.settingsPath);
    writeSettingsFile(flags.settingsPath, cleaned);
    if (removedEnvKeys.length) log(`  settings: integration hooks+env removed (${removedEnvKeys.join(", ")})${backup ? ` — backup: ${backup}` : ""}`);
    else log(`  settings: integration hooks removed${backup ? ` — backup: ${backup}` : ""}`);
  } else {
    log("  settings: nothing to change");
  }

  // 3. RepoQL MCP (only when this install registered it)
  if (record.mcp?.name && !flags.dryRun && claudeBinary()) {
    const r = spawnSync("claude", ["mcp", "remove", record.mcp.name, "--scope", record.mcp.scope || "user"], { encoding: "utf8" });
    log(r.status === 0
      ? `  repoql: removed ${record.mcp.name}`
      : `  repoql: remove failed rc=${r.status} (remove manually: claude mcp remove ${record.mcp.name})`);
  } else if (record.mcp?.name) {
    log(`  repoql: would remove ${record.mcp.name}`);
  }

  if (!flags.dryRun) removeInstallRecord(flags.settingsPath);
  log("memory profiles and captured memories are intentionally kept (docs/CLAUDE-CODE-SETUP.md §uninstall)");
  return 0;
}

export function runStatus(flags) {
  const record = readState().installs.find((r) => r.settingsPath === flags.settingsPath);
  if (!record) {
    log(`not installed for ${flags.settingsPath}`);
    return 0;
  }
  log(`install: scope=${record.scope} settings=${record.settingsPath} installedAt=${record.installedAt}`);
  log(`agents dir: ${record.agentsDir}`);
  log(`hooks: ${record.hooksScript}`);
  log(`env keys: ${Object.keys(record.envWritten || {}).join(", ") || "(none)"}`);
  const settings = readJson(flags.settingsPath);
  const events = settings?.hooks ? Object.keys(settings.hooks).filter((k) => ["SubagentStart", "SubagentStop"].includes(k)) : [];
  log(`settings hook events: ${events.join(", ") || "(none)"}`);
  log(`mcp: ${record.mcp ? `${record.mcp.name} (${record.mcp.scope})` : "(not registered by this install)"}`);
  const ledger = readJson(record.profileLedger || join(ROOT, "data/agent-profiles/ledger.json"));
  log(`profiles ledger entries: ${ledger?.profiles ? Object.keys(ledger.profiles).length : 0}`);
  return 0;
}

export async function main(argv) {
  const [command, ...rest] = argv;
  if (!["install", "uninstall", "status"].includes(command)) {
    log("usage: install-claude-code.mjs install|uninstall|status [--scope user|project] [--project-dir DIR] [--team T] [--user U] [--skip-profiles] [--skip-repoql-mcp] [--dry-run]");
    return 2;
  }
  let flags;
  try {
    flags = parseFlags(rest, process.env.HOME, process.cwd());
  } catch (e) {
    log(`usage error: ${e.message}`);
    return 2;
  }
  if (command === "install") return runInstall(flags);
  if (command === "uninstall") return runUninstall(flags);
  return runStatus(flags);
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  process.exit(await main(process.argv.slice(2)));
}
