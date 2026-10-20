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
import { chmodSync, copyFileSync, existsSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { createInterface } from "node:readline/promises";
import { AGENT_MAP } from "../adapters/claude-code/agent-map.mjs";
import {
  ensureMemoryIntegration,
  removeMemoryIntegration,
  settingsPathFor,
  ALL_HOOK_EVENTS,
} from "../adapters/claude-code/settings-merge.mjs";
import {
  resolveMainProxyUrl,
  ensureMainMemoryIntegration,
  removeMainMemoryIntegration,
  classifyMainMemoryState,
  probeMainProxy,
} from "../adapters/claude-code/main-memory.mjs";
import { loadGhostMemoryConfig } from "../ghost/ghost-memory.mjs";
import { identityFor, provisionAgentProfiles } from "./setup-agent-profiles.mjs";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const AGENTS_SRC = join(ROOT, "adapters/claude-code/agents");
const HOOK_SCRIPT = join(ROOT, "adapters/claude-code/memory-hook.mjs");
const DOC_HOOK_SCRIPT = join(ROOT, "adapters/claude-code/doc-hook.mjs");
const STATE_FILE = process.env.SINGULARITY_CLAUDE_CODE_STATE
  ? resolve(process.env.SINGULARITY_CLAUDE_CODE_STATE)
  : join(ROOT, "data/claude-code-integration.json");
const MCP_SERVER_NAME = "singularity-repoql";

export class UsageError extends Error {}

const readJson = (p) => { try { return JSON.parse(readFileSync(p, "utf8")); } catch { return null; } };
const newDir = (p) => mkdirSync(p, { recursive: true });

// Reads the harness settings file with the missing-file and malformed-file
// cases KEPT APART: a missing file legitimately means "start from an empty
// configuration", but an existing unparseable file must NEVER be treated as
// empty — the installer refuses the modification instead of overwriting it.
export function readSettingsFileStrict(p) {
  if (!existsSync(p)) return { exists: false, settings: {} };
  try { return { exists: true, settings: JSON.parse(readFileSync(p, "utf8")) }; }
  catch (e) { return { exists: true, malformed: e?.message || String(e) }; }
}

// Credential-bearing files (harness settings with routing tokens and the
// integration state ledger) are 0600. Writing with mode 0600 does not fix a
// PRE-EXISTING file's mode, so the restriction is (re)applied explicitly and
// verified. POSIX only — Windows ACL semantics are out of scope here.
function enforceSecretPermissions(path) {
  if (process.platform === "win32") return { enforced: true, mode: "n/a (windows)" };
  let enforced = false;
  try { chmodSync(path, 0o600); enforced = true; } catch { /* fall through to verification */ }
  try {
    const ok = (statSync(path).mode & 0o777) === 0o600;
    return { enforced: enforced && ok, mode: ok ? "0600" : "mismatch", verified: ok };
  } catch { return { enforced, mode: "unverified", verified: false }; }
}

function writeSettingsFile(path, settings) {
  newDir(dirname(path));
  writeFileSync(path, JSON.stringify(settings, null, 2) + "\n", { mode: 0o600 });
  const perm = enforceSecretPermissions(path);
  if (perm.enforced === false) warn(`  settings: WARN could not enforce 0600 on ${path} (${perm.mode})`);
}

function backupSettingsFile(path) {
  if (!existsSync(path)) return null;
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  const target = `${path}.bak-singularity-${stamp}`;
  copyFileSync(path, target);
  enforceSecretPermissions(target); // a settings backup can contain routing tokens
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
// ── installation variants (§5): exactly four ────────────────────────────────
// Variant 1 Claude Code + MemoryCore; 2 Claude Code Complete (adds Ghost +
// Office, Ghost via the claude backend); 3 Existing OpenChamber + MemoryCore;
// 4 OpenChamber Complete (adds Ghost + Office on the openchamber backend).
// Variant selection only VALIDATES and REPORTS mandatory capabilities — the
// underlying install flow (profiles, hooks, routing, RepoQL MCP) stays single
// and reused; no second installer is created.
export const VARIANTS = Object.freeze({
  1: { name: "Claude Code + MemoryCore", ghost: false, office: false },
  2: { name: "Claude Code Complete", ghost: true, office: true, ghostBackend: "claude-code" },
  3: { name: "Existing OpenChamber + MemoryCore", ghost: false, office: false, openchamber: true },
  4: { name: "OpenChamber Complete", ghost: true, office: true, ghostBackend: "openchamber", openchamber: true },
});

/**
 * Validate a variant selection against the environment without changing it:
 * returns { ok, problems, notes }. Mandatory capabilities must be VERIFIED,
 * not merely configured, so the installer reports what is still missing
 * rather than claiming success.
 */
export function resolveVariant(flags, deps = {}) {
  const v = VARIANTS[flags.variant];
  if (!v) return { ok: false, problems: [`variant ${flags.variant} is not one of 1..4`], notes: [] };
  const problems = [];
  const notes = [];
  if (flags.skipProfiles) problems.push("specialist-agent profile provisioning is mandatory in every variant — --skip-profiles cannot be combined with a variant");
  if (flags.scope !== "user") notes.push(`variant runs written at user scope; project scope (${flags.scope}) still works for the integration itself`);
  if (v.ghost) {
    // Deps may override existence probes (unit tests, relocated checkouts).
    const ghostOk = deps.ghostSetupExists ? deps.ghostSetupExists(join(ROOT, "ghost", "setup-ghost.sh")) : existsSync(join(ROOT, "ghost", "setup-ghost.sh"));
    if (!ghostOk) problems.push("Ghost is mandatory for this variant but ghost/setup-ghost.sh is missing from the package");
    else notes.push(`Ghost backend for this variant: ${v.ghostBackend} — set GHOST_BACKEND=${v.ghostBackend} when running ghost/ghost-gateway.mjs (see ghost/README.md)`);
  }
  if (v.office) {
    const officeOk = deps.officeComposeExists ? deps.officeComposeExists(join(ROOT, "office", "office.compose.yml")) : existsSync(join(ROOT, "office", "office.compose.yml"));
    if (!officeOk) problems.push("Claude Office is mandatory for this variant but office/office.compose.yml is missing from the package");
  }
  if (v.openchamber) {
    // Never install a duplicate OpenChamber: detect the EXISTING instance.
    const home = deps.home || process.env.HOME || "";
    const existing = deps.detectOpenchamber
      ? deps.detectOpenchamber()
      : (existsSync(join(home, ".config", "opencode")) || existsSync(join(home, ".local", "share", "opencode")));
    if (!existing) {
      problems.push("this variant attaches to an EXISTING OpenChamber installation but none was detected (~/.config/opencode or ~/.local/share/opencode) — install OpenChamber first (docs/OPENCHAMBER-SETUP.md)");
    } else {
      notes.push("reusing the detected existing OpenChamber installation; nothing gets reinstalled");
    }
  }
  return { ok: problems.length === 0, problems, notes, variant: v };
}

export function parseFlags(argv, home, cwd) {
  const flags = { scope: "user", projectDir: resolve(cwd), team: "", user: "", skipProfiles: false, skipRepoqlMcp: false, dryRun: false,
    mainMemory: null, // null = offer interactively (TTY), off when non-interactive
    replaceProvider: false, probe: false, variant: null };
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
    else if (a === "--enable-main-memory") flags.mainMemory = true;
    else if (a === "--no-main-memory") flags.mainMemory = false;
    else if (a === "--replace-provider") flags.replaceProvider = true;
    else if (a === "--probe") flags.probe = true;
    else if (a === "--variant") {
      flags.variant = argv[++i];
      if (!["1", "2", "3", "4"].includes(flags.variant)) throw new UsageError("--variant must be 1, 2, 3 or 4 (see README §START HERE)");
    }
    else throw new UsageError(`unknown argument: ${a}`);
  }
  flags.settingsPath = settingsPathFor(flags.scope, home, flags.projectDir);
  flags.agentsTarget = flags.scope === "project"
    ? join(flags.projectDir, ".claude", "agents")
    : join(home, ".claude", "agents");
  return flags;
}

// ── step 1: agent definition files ───────────────────────────────────────────
// ── agent files: inventory with proof-of-ownership, never filename-only ──────
// Content is the ownership proof.: an existing SAME-NAME file whose content
// differs from ours is user-owned until backed up and recorded; uninstall
// restores it only while the installed content is still untouched.
const shaFile = (p) => createHash("sha256").update(readFileSync(p)).digest("hex");

export function planAgentFiles(targetDir, sourceDir = AGENTS_SRC) {
  const plan = [];
  for (const file of readdirSync(sourceDir).filter((f) => f.endsWith(".md")).sort()) {
    const source = join(sourceDir, file);
    const target = join(targetDir, file);
    let status, prevSha = null, prevMode = null;
    if (!existsSync(target)) {
      status = "create";
    } else {
      const ours = shaFile(source), cur = shaFile(target);
      prevSha = cur; prevMode = statSync(target).mode & 0o777;
      status = ours === cur ? "present" : "replace";
    }
    plan.push({ source, target, status, content: readFileSync(source, "utf8"), prevSha, prevMode });
  }
  return plan;
}

function backupRunDir() {
  return process.env.SINGULARITY_AGENT_BACKUP_DIR
    || join(dirname(process.env.SINGULARITY_CLAUDE_CODE_STATE || STATE_FILE), "agent-backups");
}

/** Copy the pre-existing file into the integration backup area; 0600. */
function backupAgentFile(target) {
  const dir = join(backupRunDir(), new Date().toISOString().replace(/[:.]/g, "-"));
  newDir(dir);
  const backup = join(dir, require_ok_basename(target));
  copyFileSync(target, backup);
  enforceSecretPermissions(backup);
  return backup;
}

function require_ok_basename(p) {
  return p.split(/[\\/]/).pop() || "agent.md";
}

export function applyAgentFiles(plan, { dryRun }) {
  const changed = [];
  const ledger = [];
  for (const f of plan) {
    if (f.status === "present") {
      // Already the exact packaged content: record ownership so uninstall can
      // prove it later (repeated installs stay idempotent: no new backups).
      ledger.push({ target: f.target, action: "present", installedSha: shaFile(f.target) });
      continue;
    }
    if (!dryRun) {
      newDir(dirname(f.target));
      let backupPath = null;
      if (f.status === "replace") backupPath = backupAgentFile(f.target);
      writeFileSync(f.target, f.content);
      ledger.push({
        target: f.target, action: f.status,
        prevSha: f.prevSha, prevMode: f.prevMode, backupPath,
        installedSha: shaFile(f.target),
      });
    }
    changed.push(f.target);
  }
  return { changed, ledger };
}

// ── step 2: settings hooks + env (merge, never replace; backup first) ────────
export function applySettings(settingsPath, scriptPath, env, { dryRun }) {
  const rf = readSettingsFileStrict(settingsPath);
  if (rf.malformed) {
    // A malformed existing file is a real configuration — never silently reset.
    warn(`  settings: REFUSED — ${settingsPath} exists but is not valid JSON: ${rf.malformed}`);
    warn("  settings: the file is preserved unchanged; fix or remove it, then re-run install");
    return { changed: false, backup: null, merged: null, refused: "malformed-settings", error: rf.malformed };
  }
  const { settings: merged, changed } = ensureMemoryIntegration(rf.settings, { scriptPath, env });
  let backup = null;
  if (changed && !dryRun) {
    backup = backupSettingsFile(settingsPath);
    writeSettingsFile(settingsPath, merged);
  }
  return { changed, backup, merged };
}

// ── step 2b: MAIN-AGENT persistent memory (proxy routing) ─────────────────────
// The normal parent session gets persistent memory when Claude Code routes its
// model requests through the Singularity proxy. Specialist agents keep their
// own identities through the hook system regardless. Consent rules:
//   - no existing provider config  -> enabled when requested (guided installs
//     offer this by default; non-interactive installs state --enable-main-memory)
//   - existing provider config     -> additionally requires --replace-provider
//   - the previous values are recorded for uninstall restore; only the values
//     this installer wrote are ever removed.
export function applyMainMemory(settingsPath, { mainMemoryFlags, repoRoot, dryRun, log, warn }) {  if (mainMemoryFlags.enabled === false) {
    log("  main:     disabled (--no-main-memory) — specialist agents keep their own memory hooks");
    return { skipped: true };
  }
  const memCfgPath = join(repoRoot, "data/opencode/config/product-secrets/memory.json");
  if (!existsSync(memCfgPath)) {
    log("  main:     memory config missing — skipped (run python3 scripts/provision-secrets.py, then re-run with --enable-main-memory)");
    return { skipped: true, reason: "no memory.json" };
  }
  const upstreamEnvPath = join(repoRoot, "memory/upstream/.env");
  let upstreamContent = null;
  try { upstreamContent = readFileSync(upstreamEnvPath, "utf8"); } catch { /* no explicit port: defaults apply */ }
  const baseUrl = resolveMainProxyUrl({ env: process.env, upstreamEnvContent: upstreamContent });
  const memCfg = readJson(memCfgPath) || {};
  // The scoped business-user key routes proxy traffic — never printed, never
  // logged; it is written ONLY into the 0600 settings file.
  const token = typeof memCfg.userKey === "string" && memCfg.userKey ? memCfg.userKey : null;
  if (!token) {
    log("  main:     memory config has no scoped user key — skipped (provision a business-user key first)");
    return { skipped: true, reason: "no scoped user key" };
  }
  const model = process.env.SINGULARITY_MAIN_AGENT_MODEL || (typeof memCfg.mainModel === "string" && memCfg.mainModel) || null;
  const strict = readSettingsFileStrict(settingsPath);
  if (strict.malformed) {
    warn(`  main:     REFUSED — ${settingsPath} exists but is not valid JSON: ${strict.malformed}`);
    warn("  main:     not configured — the existing file is preserved; fix the JSON, then re-run");
    return { refused: true, malformed: true, conflicts: [`settings exists but is not valid JSON: ${strict.malformed}`] };
  }
  const existing = strict.settings;
  const outcome = ensureMainMemoryIntegration(existing, {
    baseUrl, token, model, replaceProvider: mainMemoryFlags.replaceProvider,
  });
  if (outcome.mode === "refused-conflict") {
    for (const r of outcome.reasons) warn(`  main:     ${r}`);
    warn("  main:     NOT configured — pass --replace-provider to change existing provider routing explicitly, or keep your current provider");
    return { refused: true, conflicts: outcome.reasons, baseUrl };
  }
  let backup = null;
  if (outcome.changed && !dryRun) {
    backup = backupSettingsFile(settingsPath);
    writeSettingsFile(settingsPath, outcome.settings);
  }
  log(outcome.mode === "verified-existing"
    ? `  main:     Singularity proxy routing already present (${baseUrl})${outcome.changed ? ", completed" : ", no change"}`
    : `  main:     normal-agent proxy routing ${dryRun ? "(dry run) " : ""}written (${baseUrl})${backup ? ` — backup: ${backup}` : ""} — close and reopen Claude Code once`);
  if (outcome.mode === "merged-over-replace-consent") {
    for (const r of outcome.reasons) log(`  main:     replaced per consent: ${r}`);
  }
  return { applied: true, mode: outcome.mode, changed: outcome.changed, baseUrl, backup };
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
  enforceSecretPermissions(stateFile);
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

// One guided question during interactive installs (a prompt never prints or
// replays any secret value). Non-TTY callers never reach this.
let _rl = null;
async function readLine(prompt) {
  _rl = _rl || createInterface({ input: process.stdin, output: process.stdout });
  return _rl.question(prompt);
}

export async function runInstall(flags) {
  log(`installing the Singularity Claude Code integration (${flags.scope} scope)${flags.dryRun ? " — dry run" : ""}`);

  // Variant validation (§5): mandatory capabilities are verified BEFORE any
  // files change; a variant with unmet requirements refuses install.
  let variantOutcome = null;
  if (flags.variant) {
    variantOutcome = resolveVariant(flags);
    log(`  variant:  ${flags.variant} — ${variantOutcome.variant.name}`);
    for (const n of variantOutcome.notes) log(`  variant note: ${n}`);
    if (!variantOutcome.ok) {
      for (const p of variantOutcome.problems) warn(`  variant REFUSED: ${p}`);
      warn(`  variant:  installation stopped unmodified; resolve the mandatory capabilities above, then re-run`);
      return 4; // variant requirement refusal: the on-disk state was not touched
    }
  } else {
    log("  variant:  none selected — install runs with the base integration only (README §START HERE lists variants 1-4)");
  }

  // Main-agent memory decision: explicit flags win; otherwise offer interactively
  // and default OFF for non-interactive runs (the guided experience still OFFERS,
  // and automation opts in with --enable-main-memory).
  let mainMemoryFlags;
  if (flags.mainMemory === true || flags.mainMemory === false) {
    mainMemoryFlags = { enabled: flags.mainMemory, replaceProvider: flags.replaceProvider };
  } else if (process.stdout.isTTY) {
    try {
      const reply = (await readLine("Enable persistent memory for your NORMAL Claude Code sessions via the Singularity proxy? [Y/n] ")).trim().toLowerCase();
      mainMemoryFlags = { enabled: reply !== "n" && reply !== "no", replaceProvider: flags.replaceProvider };
    } catch {
      mainMemoryFlags = { enabled: false, replaceProvider: flags.replaceProvider };
    }
  } else {
    mainMemoryFlags = { enabled: false, replaceProvider: flags.replaceProvider };
    log("  main:     non-interactive run — pass --enable-main-memory to enable normal-agent persistent memory (see docs/CLAUDE-CODE-SETUP.md)");
  }

  const envOverrides = {
    ...(flags.team ? { AGENT_PROFILE_TEAM: flags.team } : {}),
    ...(flags.user ? { AGENT_PROFILE_USER: flags.user } : {}),
  };
  const envForSettings = integrationEnv(ROOT, envOverrides);

  // 1. agent definition files
  const agentPlan = planAgentFiles(flags.agentsTarget);
  for (const f of agentPlan) log(`  agents:   ${f.status.padEnd(7)} ${f.target}${f.prevSha ? " (backed up before replace)" : ""}`);
  const { changed: agentChanges, ledger: agentLedger } = applyAgentFiles(agentPlan, { dryRun: flags.dryRun });

  // 2. settings hooks + env (memory + documentation hooks; merge, never replace)
  const settings = applySettings(flags.settingsPath, HOOK_SCRIPT, envForSettings, { dryRun: flags.dryRun });
  log(settings.changed
    ? `  settings: memory + documentation hooks and env merged into ${flags.settingsPath}${settings.backup ? ` (backup: ${settings.backup})` : ""}`
    : `  settings: already up to date (${flags.settingsPath})`);

  // 2b. main-agent persistent memory (proxy routing; consent rules above)
  const preMainEnv = readJson(flags.settingsPath)?.env || {};
  const main = applyMainMemory(flags.settingsPath, { mainMemoryFlags, repoRoot: ROOT, dryRun: flags.dryRun, log, warn });
  if (main?.malformed) {
    log("next: fix the malformed settings file, then re-run the installer to complete configuration");
  }

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
    // Previous ANTHROPIC_* values (captured before our merge) for restore-at-uninstall.
    const prevAnthropic = main && !main.skipped && !main.refused
      ? Object.fromEntries(["ANTHROPIC_BASE_URL", "ANTHROPIC_AUTH_TOKEN", "ANTHROPIC_MODEL"]
          .map((k) => [k, preMainEnv[k] !== undefined ? preMainEnv[k] : undefined]))
      : null;
    saveInstallRecord({
      installedAt: new Date().toISOString(),
      scope: flags.scope,
      projectDir: flags.scope === "project" ? flags.projectDir : null,
      settingsPath: flags.settingsPath,
      agentsDir: flags.agentsTarget,
      hooksScript: HOOK_SCRIPT,
      docHooksScript: DOC_HOOK_SCRIPT,
      envWritten: envForSettings,
      mainMemory: main && !main.skipped && !main.refused ? {
        enabled: true, baseUrl: main.baseUrl, mode: main.mode,
        envWritten: main.changed
          ? Object.fromEntries(["ANTHROPIC_BASE_URL", "ANTHROPIC_AUTH_TOKEN", "ANTHROPIC_MODEL"]
              .map((k) => [k, (readJson(flags.settingsPath)?.env || {})[k]]))
          : {},
        previousEnv: prevAnthropic || {},
      } : { enabled: false, refused: Boolean(main?.refused), baseUrl: main?.baseUrl || null, conflicts: main?.conflicts || [] },
      agentsChanged: agentChanges,
      agentLedger,
      agentLedger,
      mcp: mcp && !mcp.present ? { name: mcp.name, transport: mcp.transport, command: mcp.command, scope: mcp.scope } : null,
      profileLedger: join(ROOT, "data/agent-profiles/ledger.json"),
      variant: flags.variant
        ? { id: flags.variant, name: VARIANTS[flags.variant].name, ghostBackend: VARIANTS[flags.variant].ghostBackend || null, verified: variantOutcome.ok }
        : null,
    });
  }

  main && main.applied && log("next: proxy routing is active for new Claude Code sessions; verify with `status --probe` and docs/CLAUDE-CODE-SETUP.md");

  log("next: restart Claude Code, run /agents to confirm discovery, then follow the verification checks in docs/CLAUDE-CODE-SETUP.md");
  return 0;
}

export function uninstallFilesForRecord(record) {
  return Object.keys(AGENT_MAP)
    .map((n) => join(record.agentsDir, `${n}.md`))
    .filter((p) => existsSync(p));
}

/**
 * Safe per-file removal plan (proof of ownership, never the filename alone):
 *   remove                 — ledger-proven ours, unmodified since install
 *   restore                — ledger-proven ours; the pre-install file is backed
 *                            up and verified, so the ORIGINAL content+mode
 *                            returns in place of the installed version
 *   user-modified-keep     — the file changed after install: refuse to destroy
 *                            newer user work; keep and report
 *   remove-unchanged-source— no ledger (legacy record) but the file content is
 *                            exactly the packaged source: ours by content proof
 *   keep-unowned           — no proof of ownership: never touched
 */
export function agentRemovalPlan(record, sourceDir = AGENTS_SRC) {
  const ledger = Array.isArray(record.agentLedger) ? record.agentLedger : null;
  return Object.keys(AGENT_MAP).map((n) => {
    const p = join(record.agentsDir, `${n}.md`);
    if (!existsSync(p)) return { target: p, action: "absent" };
    const curSha = shaFile(p);
    if (ledger) {
      const e = ledger.find((x) => x.target === p);
      if (!e) {
        // Not in this record's ledger: treat by content proof against the package.
        const src = join(sourceDir, `${n}.md`);
        return (existsSync(src) && shaFile(src) === curSha)
          ? { target: p, action: "remove-unchanged-source" }
          : { target: p, action: "keep-unowned" };
      }
      if (curSha !== e.installedSha) return { target: p, action: "user-modified-keep" };
      if (e.action === "replace" && e.backupPath && existsSync(e.backupPath)) {
        const prevSha = shaFile(e.backupPath);
        if (prevSha !== e.prevSha) {
          return { target: p, action: "keep-backup-unverified", error: "backup content != recorded pre-install hash" };
        }
        return { target: p, action: "restore", backupPath: e.backupPath, prevMode: e.prevMode ?? null };
      }
      return { target: p, action: "remove" };
    }
    // Legacy record without a ledger: content proof against the current package only.
    const src = join(sourceDir, `${n}.md`);
    return (existsSync(src) && shaFile(src) === curSha)
      ? { target: p, action: "remove-unchanged-source" }
      : { target: p, action: "keep-unowned" };
  });
}

const AGENT_ACTION_LOG = {
  absent: (p) => p,
  remove: (p) => `remove ${p}`,
  restore: (p) => `restore original: ${p}`,
  "user-modified-keep": (p) => `KEEP user-modified file (changed after install, will not overwrite): ${p}`,
  "keep-unowned": (p) => `KEEP unowned file (no proof this path was installed by Singularity): ${p}`,
  "remove-unchanged-source": (p) => `remove ${p} (content matches packaged source)`,
  "keep-backup-unverified": (p) => `KEEP installed file — restoration refused: backup failed verification (${p})`,
};

export function runUninstall(flags) {
  const record = readState().installs.find((r) => r.settingsPath === flags.settingsPath);
  if (!record) {
    log(`no recorded install for ${flags.settingsPath} — nothing to uninstall`);
    return 0;
  }
  log(`uninstalling the Singularity Claude Code integration (${record.scope})${flags.dryRun ? " — dry run" : ""}`);

  // 1. agent definitions (proof-based: restore originals, never destroy unknown work)
  const agentPlan2 = agentRemovalPlan(record);
  for (const item of agentPlan2) log(`  agents:   ${AGENT_ACTION_LOG[item.action]?.(item.target) || item.target}`);
  if (!flags.dryRun) {
    for (const item of agentPlan2) {
      if (item.action === "remove" || item.action === "remove-unchanged-source") rmSync(item.target, { force: true });
      else if (item.action === "restore") {
        copyFileSync(item.backupPath, item.target);
        if (item.prevMode && process.platform !== "win32") {
          try { chmodSync(item.target, item.prevMode); } catch { /* best effort, already restored */ }
        }
      }
      // keep-* / user-modified-keep / keep-backup-unverified: leave untouched.
    }
  }

  // 2. settings hooks + env (only values the installer wrote)
  const envRestore = { ...(record.envWritten || {}) };
  const strict = readSettingsFileStrict(flags.settingsPath);
  if (strict.malformed) {
    warn(`  settings: REFUSED — ${flags.settingsPath} is not valid JSON: ${strict.malformed}`);
    warn("  settings: hooks/env cleanup skipped; the file and the install record are preserved; fix the JSON and re-run uninstall");
    if (!flags.dryRun) {
      // Keep the record: a later uninstall must still know what to clean.
      log("  settings: install record kept for a later cleanup pass");
      return 3; // refusal exit code: settings not cleaned up
    }
    return 0;
  }
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

  // 2b. main-agent proxy routing (only the env values recorded as written by
  // this install are restored/removed; MemoryCore memories are kept; a value
  // edited by the user after install is never touched).
  if (record.mainMemory?.enabled) {
    const eu = removeMainMemoryIntegration(readJson(flags.settingsPath) || existing, record, record.mainMemory.previousEnv || {});
    if (eu.changedKeys.length) {
      log(`  main: removed/restored ${eu.changedKeys.join(", ")}`);
      if (!flags.dryRun) writeSettingsFile(flags.settingsPath, eu.settings);
    } else {
      log("  main: no main-agent proxy values to remove (unchanged since install or user-modified)");
    }
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

export function readSettings(flags) {
  return readJson(flags.settingsPath) || readJson(join(process.env.HOME || "", ".claude", "settings.json")) || {};
}

export function collectSpecialistStatus(record) {
  const settings = readJson(record.settingsPath) || {};
  const events = settings?.hooks ? Object.keys(settings.hooks) : [];
  const present = ["SubagentStart", "SubagentStop"].filter((k) => events.includes(k));
  const ledger = readJson(record.profileLedger || join(ROOT, "data/agent-profiles/ledger.json"));
  const count = ledger?.profiles ? Object.keys(ledger.profiles).length : 0;
  return { present, profilesSeeded: count };
}

export async function runStatus(flags) {
  const installs = readState().installs;
  const record = installs.find((r) => r.settingsPath === flags.settingsPath);
  if (!record) {
    log(`not installed for ${flags.settingsPath}`);
    return 0;
  }
  log(`install: scope=${record.scope} settings=${record.settingsPath} installedAt=${record.installedAt}`);
  log(`agents dir: ${record.agentsDir}`);
  log(`hooks: ${record.hooksScript}${record.docHooksScript ? ` + ${record.docHooksScript}` : ""}`);
  if (record.variant) log(`variant: ${record.variant.id} — ${record.variant.name}${record.variant.ghostBackend ? ` (ghost backend: ${record.variant.ghostBackend})` : ""}${record.variant.verified ? "" : " [unverified]"}`);
  log(`env keys: ${Object.keys(record.envWritten || {}).join(", ") || "(none)"}`);
  const settings = readJson(record.settingsPath);
  const events = settings?.hooks ? Object.keys(settings.hooks).filter((k) => ["SubagentStart", "SubagentStop", "SessionStart", "Stop"].includes(k)) : [];
  log(`settings hook events: ${events.join(", ") || "(none)"}`);
  log(`mcp: ${record.mcp ? `${record.mcp.name} (${record.mcp.scope})` : "(not registered by this install)"}`);

  // MAIN AGENT MEMORY — the normal parent session. Not VERIFIED from the settings
  // text alone: an authenticated probe against the proxy upgrades it.
  const baseUrl = record.mainMemory?.enabled && record.mainMemory.baseUrl
    ? record.mainMemory.baseUrl
    : resolveMainProxyUrl({ env: process.env });
  let probe = null;
  if (flags.probe && record.mainMemory?.enabled) {
    const token = readJson(record.envWritten?.SINGULARITY_MEMORY_CONFIG || join(ROOT, "data/opencode/config/product-secrets/memory.json"))?.userKey || null;
    probe = await probeMainProxy(baseUrl, token);
  }
  const mainState = record.mainMemory?.enabled
    ? classifyMainMemoryState(settings, baseUrl, probe)
    : (record.mainMemory?.refused
        ? { state: "CONFLICTED", detail: `installer refused: ${(record.mainMemory.conflicts || []).join("; ")}` }
        : { state: "DISABLED", detail: "main-agent proxy routing not enabled for this install" });
  log(`MAIN AGENT MEMORY: ${mainState.state}${mainState.detail ? ` — ${mainState.detail}` : ""}`);
  log(`  endpoint: ${record.mainMemory?.enabled ? baseUrl : "(not routed)"}`);

  // SPECIALISED AGENT MEMORY — hook presence + seeded identity ledger.
  const spe = collectSpecialistStatus(record);
  log(`SPECIALISED AGENT MEMORY: ${spe.present.length === 2 ? (spe.profilesSeeded ? "CONFIGURED" : "CONFIGURED (no seeded profiles: run setup-agent-profiles.mjs)") : "DISABLED"}`);
  log(`  hooks: ${spe.present.join(", ") || "(none)"} | profiles seeded: ${spe.profilesSeeded}`);
  return 0;
}

export async function main(argv) {
  const [command, ...rest] = argv;
  if (!["install", "uninstall", "status"].includes(command)) {
    log("usage: install-claude-code.mjs install|uninstall|status [--scope user|project] [--project-dir DIR] [--team T] [--user U] [--skip-profiles] [--skip-repoql-mcp] [--enable-main-memory] [--no-main-memory] [--replace-provider] [--probe] [--dry-run]");
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
