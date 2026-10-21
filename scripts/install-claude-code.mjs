#!/usr/bin/env node
// install-claude-code.mjs — idempotent installer for the Singularity Claude Code
// native-agent integration (the "specialised agents on Claude Code" feature).
//
//   node scripts/install-claude-code.mjs install --variant 1|2|3|4
//      [--scope user|project] [--project-dir DIR]
//      [--team T] [--user U] [--skip-profiles] [--skip-repoql-mcp] [--dry-run]
//      [--enable-main-memory | --no-main-memory] [--replace-provider]
//   node scripts/install-claude-code.mjs uninstall [same scope flags] [--dry-run]
//   node scripts/install-claude-code.mjs status [--probe]
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
import { spawn, spawnSync } from "node:child_process";
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
// Shared OpenChamber discovery: the installer and the attach flow must resolve
// the SAME target config dir (a native data dir with no OpenCode config must
// never silently fall back to the package's own data/opencode/config).
import { discoverOpenchamber, resolveConfigDir } from "./attach-openchamber.mjs";
// Native Office payload contract: the gate ingests an event produced by the
// SHIPPED plugin mapper, not a hand-written shape.
import { mapOfficeEvent } from "../openchamber/plugins/product-office/office-events.js";
// The canonical model lane (derived, never a hardcoded route) and the
// FUNCTIONALLY VERIFIED proof layer: the gate separates CONFIGURED facts from
// runtime proofs, and a proof that cannot run is a FAIL-CLOSED MISSING.
import { resolveModelLane, probeModelLane, modelLaneAdvice, readUpstreamEnvContent } from "./model-lane.mjs";
import { probeMemoryIdentity, probeMemoryLoop, probeRepoqlMcp, probeDocIngestion, probeProviderFailover, isAdministrativeKey, readAdministrativeKey } from "./runtime-proofs.mjs";

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
// ── installation options (README §START HERE): exactly four ─────────────────
// Option 1 Claude Code + MemoryCore; 2 Claude Code Complete (adds Ghost +
// Office, Ghost via the claude backend); 3 Existing OpenChamber + MemoryCore;
// 4 OpenChamber Complete (adds Ghost + Office on the openchamber backend).
// These are the ONLY installation surfaces: Ghost and Claude Office are
// automatically included in options 2/4 and absent from options 1/3 — there
// are no component selectors or other package combinations. Option selection
// only VALIDATES and REPORTS mandatory capabilities — the underlying install
// flow (profiles, hooks, routing, RepoQL MCP) stays single and reused; no
// second installer is created.
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
/** The user-facing option surface: exactly four numbered installation options. */
export function installOptionLines() {
  return ["1", "2", "3", "4"].map((n) => {
    const v = VARIANTS[n];
    const parts = [`  ${n}  ${v.name}`];
    if (v.openchamber) parts.push("(attaches to an EXISTING OpenChamber)");
    parts.push(v.ghost
      ? `— Ghost and Claude Office are automatically included (GHOST_BACKEND=${v.ghostBackend}) and cannot be deselected`
      : "— Ghost and Claude Office are not part of this option");
    return parts.join(" ");
  });
}

/** Map a wizard reply to an installation option id; anything else is refused. */
export function parseOptionChoice(reply) {
  const t = String(reply ?? "").trim();
  return ["1", "2", "3", "4"].includes(t) ? t : null;
}

/** Usage surface: four numbered installation options + advanced configuration. */
export function usageText() {
  return [
    "usage: install-claude-code.mjs install|uninstall|status|gate [--variant 1|2|3|4]",
    "",
    "commands:",
    "  install    run one of the four installation options (selected with --variant)",
    "  uninstall  remove the Singularity integration (memories and profiles are kept)",
    "  status     report what is installed (--probe verifies main-agent routing)",
    "  gate       verify an ATTACH option's target capabilities without installing Claude Code",
    "             (options 3/4 only: --variant 3|4 [--container NAME | --config-dir DIR])",
    "",
    "installation options — exactly four, selected with --variant:",
    ...installOptionLines(),
    "",
    "advanced configuration (within any selected installation option, not options themselves):",
    "  --scope user|project  --project-dir DIR  --team T  --user U",
    "  --enable-main-memory | --no-main-memory  --replace-provider",
    "  --skip-profiles  --skip-repoql-mcp  --probe  --dry-run",
    "  --container NAME  --config-dir DIR  (gate target selection)",
  ].join("\n");
}

/**
 * Discover the EXISTING OpenChamber installation an attach option (3/4) must
 * reuse — never a duplicate. Detection order: native config dir, this
 * package's own compose-managed stack, then any other running OpenChamber
 * container. Read-only: nothing here starts, stops or reconfigures anything.
 */
export function detectOpenchamberInstance(deps = {}) {
  if (deps.detectOpenchamberInstance) return deps.detectOpenchamberInstance();
  return discoverOpenchamber({ home: deps.home, docker: deps.docker });
}

/**
 * Resolve the host-side config directory of the detected instance. This is the
 * only supported source of truth for an attach option's target config: a
 * container's config comes from its bind mounts, a native install from
 * ~/.config/opencode, and the package's own stack from the repo data dir. There
 * is deliberately NO package-local fallback: an unresolved target is reported
 * as missing, never silently pointed at data/opencode/config.
 */
export function targetConfigDir(inst) {
  if (!inst || inst.kind === "none") return null;
  if (inst.kind === "container") return resolveConfigDir(inst); // throws with a precise message
  return inst.configDir || null;
}

export function resolveVariant(flags, deps = {}) {
  const v = VARIANTS[flags.variant];
  if (!v) return { ok: false, problems: [`option ${flags.variant} is not one of 1..4 (exactly four installation options exist)`], notes: [] };
  const problems = [];
  const notes = [];
  if (flags.skipProfiles) problems.push("specialist-agent profile provisioning is mandatory in every installation option — --skip-profiles cannot be combined with an installation option");
  if (flags.scope !== "user") notes.push(`option runs written at user scope; project scope (${flags.scope}) still works for the integration itself`);
  if (v.ghost) {
    // Ghost + Claude Office are automatically IN the complete options: no
    // selector exists; the package must still carry the parts.
    // Deps may override existence probes (unit tests, relocated checkouts).
    const ghostOk = deps.ghostSetupExists ? deps.ghostSetupExists(join(ROOT, "ghost", "setup-ghost.sh")) : existsSync(join(ROOT, "ghost", "setup-ghost.sh"));
    if (!ghostOk) problems.push("Ghost is mandatory for this installation option but ghost/setup-ghost.sh is missing from the package");
    else notes.push(`Ghost backend for this installation option: ${v.ghostBackend} — set GHOST_BACKEND=${v.ghostBackend} when running ghost/ghost-gateway.mjs (see ghost/README.md)`);
  }
  if (v.office) {
    const officeOk = deps.officeComposeExists ? deps.officeComposeExists(join(ROOT, "office", "office.compose.yml")) : existsSync(join(ROOT, "office", "office.compose.yml"));
    if (!officeOk) problems.push("Claude Office is mandatory for this installation option but office/office.compose.yml is missing from the package");
  }
  if (v.openchamber) {
    // Never install a duplicate OpenChamber: detect the EXISTING instance
    // (native config, a running OpenChamber container, or this package's own
    // compose stack) before anything changes.
    const inst = deps.detectOpenchamberInstance
      ? deps.detectOpenchamberInstance()
      : deps.detectOpenchamber
        ? (deps.detectOpenchamber() ? { kind: "detected" } : { kind: "none" })
        : detectOpenchamberInstance({ home: deps.home, docker: deps.docker });
    if (!inst || inst.kind === "none") {
      problems.push("this installation option attaches to an EXISTING OpenChamber installation but none was detected (native ~/.config/opencode, a running OpenChamber container, or this package's compose stack) — see docs/OPENCHAMBER-SETUP.md");
    } else {
      notes.push(`reusing the detected existing OpenChamber (${inst.kind}${inst.container ? `: ${inst.container}` : ""}); nothing gets reinstalled`);
    }
  }
  return { ok: problems.length === 0, problems, notes, variant: v };
}

export function parseFlags(argv, home, cwd) {
  const flags = { scope: "user", projectDir: resolve(cwd), team: "", user: "", skipProfiles: false, skipRepoqlMcp: false, dryRun: false,
    mainMemory: null, // null = offer interactively (TTY), off when non-interactive
    replaceProvider: false, probe: false, variant: null, container: null, configDir: null };
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
    else if (a === "--container") flags.container = argv[++i];
    else if (a === "--config-dir") flags.configDir = argv[++i];
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
  // B7: an ADMINISTRATIVE key is never written into Claude Code settings: the
  // routing token is sent with every parent-session request. Refused here, before
  // anything is read for writing; this run changes nothing.
  if (isAdministrativeKey(token, readAdministrativeKey(repoRoot))) {
    warn("  main:     REFUSED — the memory config's key is the ADMINISTRATIVE key and is never written into Claude Code settings (no value printed)");
    warn("  main:     provision a dedicated scoped business-user key (provision-secrets.py --memory-user-key), then re-run");
    return { refused: true, conflicts: ["the memory config's key is administrative (refused; nothing written)"], baseUrl };
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

// ── mandatory-capability verification (the option gate) ─────────────────────
// "Installed" never means "a file exists": every capability mandatory for the
// selected option is verified against the live state (settings content, seeded
// profile results, registered MCP, reachable services). Anything missing or
// declined yields INCOMPLETE — consent is never forced and a mandatory
// capability is never waived (--no-main-memory / --skip-* cannot pass).

function hostOfficeEndpoint(endpoint) {
  // office.json points the plugin at the in-network alias; host-side checks
  // reach the same service through its published loopback port.
  const m = String(endpoint || "").match(/^http:\/\/product-office:8000(.*)$/);
  return m ? `http://127.0.0.1:3128${m[1]}` : String(endpoint || "");
}

/** Read one KEY=VALUE from a dotenv file (never prints the value). */
const readEnvValue = (p, key) => {
  try {
    const t = readFileSync(p, "utf8");
    const m = t.match(new RegExp(`^\\s*${key}\\s*=\\s*(.*)$`, "m"));
    return m ? m[1].trim().replace(/^["']|["']$/g, "") : "";
  } catch { return ""; }
};

/**
 * Functional dream acceptance: a COMPLETED consolidation journal dated today.
 * A checkpointed journal is explicitly NOT acceptance (a checkpoint is not a
 * finished consolidation), and a pre-existing unrelated journal does not count.
 * Provenance (a memory commit or changed files) is required alongside the
 * completed outcome so a "complete" line cannot be asserted without evidence.
 */
export function dreamOutcomeToday(agentDir = join(ROOT, "data/ghost")) {
  const dir = join(agentDir, "dreams");
  const today = new Date().toISOString().slice(0, 10);
  let files = [];
  try { files = readdirSync(dir).filter((f) => f.endsWith(".md")).sort(); } catch { return { complete: false, detail: "no dream journal directory" }; }
  const todays = files.filter((f) => f.includes(today));
  if (!todays.length) return { complete: false, detail: "no dream journal dated today" };
  const read = (f) => { try { return readFileSync(join(dir, f), "utf8") || ""; } catch { return ""; } };
  const complete = todays.find((f) => /^- outcome:\s*complete\b/m.test(read(f)));
  if (!complete) {
    const checkpointed = todays.some((f) => /^- outcome:\s*checkpointed\b/m.test(read(f)));
    return { complete: false, provenance: false, detail: checkpointed
      ? "today's journal is checkpointed — a checkpoint is not a completed consolidation"
      : "today's journal records no completed consolidation" };
  }
  const text = read(complete);
  const hasCommit = /^- commit:\s*(?!\(no memory commit this run\))\S/m.test(text);
  const hasChanged = /^- changed_files:\s*(?!none\b)\S/m.test(text);
  return { complete: true, provenance: hasCommit || hasChanged, journal: complete, detail: "completed consolidation" };
}

/**
 * Host-side transport mapping for the in-network memory alias. The plugin
 * config pins the in-network alias (http://memory-core:8420); the host reaches
 * the same service on its published loopback port (the product's host-side
 * scripts use http://127.0.0.1:8420 too). This maps the TRANSPORT only — the
 * config directory is never guessed.
 */
function hostMemoryBaseUrl(cfg) {
  const raw = String(cfg?.baseUrl || "");
  const m = raw.match(/^https?:\/\/(?:memory-core|tdai-memory-core)(:\d+)?/);
  if (!m) return raw;
  return `http://127.0.0.1${m[1] || ":8420"}`;
}

/**
 * Claude Office FUNCTIONAL probe: a real native event payload built with the
 * SHIPPED plugin mapper is POSTed with the ingest key, then the session list is
 * read back with the read key. A POST 200 alone is NOT acceptance (§6): the
 * event must have been consumed (read-back finds the session, project name
 * stored, and the derived display name correct).
 */
export async function probeOfficeFunctional(officeConfigPath = join(ROOT, "data/opencode/config/product-secrets/office.json")) {
  let officeOk = false, officeDetail = "";
  try {
    const cfg = readJson(officeConfigPath);
    if (!cfg?.endpoint || !cfg?.ingestKey) {
      officeDetail = `office config missing endpoint/ingestKey (${officeConfigPath}; run provision-secrets.py for an option that includes Office)`;
    } else {
      const url = hostOfficeEndpoint(cfg.endpoint);
      const base = url.replace(/\/api\/v1\/events$/, "");
      const sessionID = `ses_verify${Date.now().toString(36)}`;
      const mapped = mapOfficeEvent(
        { type: "session.created", created: Date.now(), data: { sessionID } },
        { location: { directory: "/home/openchamber/workspaces/install-verify" }, parentID: null }
      );
      if (!mapped.length) {
        officeDetail = "native event mapper produced no event (capture-root contract)";
      } else {
        const payload = mapped[0];
        const res = await fetch(url, {
          method: "POST",
          headers: { "Content-Type": "application/json", "X-API-Key": cfg.ingestKey },
          body: JSON.stringify(payload),
          signal: AbortSignal.timeout(6000),
        });
        if (!res.ok) {
          officeDetail = `ingest rejected HTTP ${res.status}`;
        } else {
          const adminKey = process.env.CLAUDE_OFFICE_API_KEY
            || readEnvValue(join(ROOT, "secrets", "claude-office.env"), "CLAUDE_OFFICE_API_KEY");
          if (!adminKey) {
            officeDetail = "read key unavailable — cannot verify the event was consumed (set CLAUDE_OFFICE_API_KEY)";
          } else {
            const list = await fetch(`${base}/api/v1/sessions`, {
              headers: { "X-API-Key": adminKey }, signal: AbortSignal.timeout(6000),
            });
            if (!list.ok) {
              officeDetail = `session read-back failed HTTP ${list.status}`;
            } else {
              const sessions = await list.json().catch(() => null);
              const hit = Array.isArray(sessions) && sessions.find((s) => s && s.id === payload.session_id);
              if (!hit) {
                officeDetail = `ingest returned HTTP 200 but session ${payload.session_id} was not present on read-back`;
              } else if (hit.projectName !== payload.data.project_name) {
                officeDetail = `consumed but project_name was not stored (read-back projectName=${JSON.stringify(hit.projectName)})`;
              } else if (hit.displayName !== payload.data.project_name) {
                // Claude Office derives the session display name from
                // data.project_name (its own documented priority).
                officeDetail = `consumed but the derived display name differs (read-back displayName=${JSON.stringify(hit.displayName)})`;
              } else {
                officeOk = true;
                officeDetail = `native event consumed and read back (HTTP 200; session ${payload.session_id}, project ${payload.data.project_name})`;
              }
            }
          }
        }
      }
    }
  } catch (e) { officeDetail = `Office not reachable: ${String(e?.message || e).slice(0, 120)}`; }
  return { ok: officeOk, detail: officeDetail };
}

/**
 * Run a probe child process and collect its output. The probe is ASYNC on
 * purpose: a synchronous child would block the parent's event loop, so an
 * in-process service (used by the tests) could never answer the probe.
 */
function runProbe(cmd, args, { env, timeout = 25000 } = {}) {
  return new Promise((resolve) => {
    let child;
    try {
      child = spawn(cmd, args, { cwd: ROOT, env: env || process.env });
    } catch (e) {
      resolve({ code: -1, out: "", err: String(e?.message || e) });
      return;
    }
    let out = "", err = "";
    child.stdout?.on("data", (d) => { out += String(d); });
    child.stderr?.on("data", (d) => { err += String(d); });
    const timer = setTimeout(() => { try { child.kill("SIGKILL"); } catch { /* already gone */ } }, timeout);
    child.on("error", (e) => { clearTimeout(timer); resolve({ code: -1, out, err: err || String(e?.message || e) }); });
    child.on("close", (code) => { clearTimeout(timer); resolve({ code, out, err }); });
  });
}

const lastLine = (s) => String(s || "").trim().split("\n").filter(Boolean).slice(-1)[0] || "";

/** Host-side probe: the shipped strict ghost-memory client, authenticated. */
export async function probeGhostMemoryOnHost(configPath) {
  const cfg = readJson(configPath);
  const env = { ...process.env, SINGULARITY_MEMORY_CONFIG: configPath };
  const mapped = hostMemoryBaseUrl(cfg);
  if (mapped) env.GHOST_MC_URL = mapped;
  const r = await runProbe("node", [join(ROOT, "ghost/ghost-memory.mjs"), "stats"], { env, timeout: 25000 });
  if (r.code === 0) {
    return { ok: true, detail: `authenticated Ghost memory identity reachable (${configPath}${mapped ? " via " + mapped : ""})` };
  }
  const tail = lastLine(r.err || r.out);
  return { ok: false, detail: `ghost memory stats failed rc=${r.code}${tail ? `: ${tail}` : ""}` };
}

/**
 * In-container probe (installation options 3/4): the identity is checked
 * INSIDE the target, where the in-network alias actually resolves. Read-only:
 * the config is read, two authenticated count calls are made, and only a
 * verdict (no secret, no message content) is printed.
 */
async function probeGhostMemoryInContainer(container, configPath) {
  const script = `
const fs=require('fs');
let c;try{c=JSON.parse(fs.readFileSync(process.argv[1],'utf8'));}catch(e){console.log(JSON.stringify({error:'config-missing-or-unreadable'}));process.exit(1);}
const base=String(c.baseUrl||'').replace(/\\/+$/,'');
const key=c.userKey||c.gatewayKey||'';
if(!base||!key){console.log(JSON.stringify({error:'no-service-key'}));process.exit(1);}
const h={'content-type':'application/json','x-tdai-service-id':c.serviceId||'default','authorization':(c.authPrefix||'Bearer ')+key};
if(c.userKey)h['x-tdai-user-key']=c.userKey;
const id={team_id:c.ghostTeamId||'ghost-companion',user_id:c.ghostUserId||'pilot-operator',agent_id:c.ghostAgentId||'ghost'};
(async()=>{try{
  const r=await fetch(base+'/v3/conversation/count',{method:'POST',headers:h,body:JSON.stringify(id)});
  const j=await r.json();
  if(j.code!==0){console.log(JSON.stringify({error:'count-failed',code:j.code}));process.exit(1);}
  const a=await fetch(base+'/v3/atomic/count',{method:'POST',headers:h,body:JSON.stringify(id)});
  const k=await a.json();
  if(k.code!==0){console.log(JSON.stringify({error:'count-failed',code:k.code}));process.exit(1);}
  console.log(JSON.stringify({ok:true,l0:Number(j.data&&j.data.total||0),l1:Number(k.data&&k.data.total||0)}));
}catch(e){console.log(JSON.stringify({error:String((e&&e.message)||e)}));process.exit(1);}})();`;
  const r = await runProbe("docker", ["exec", container, "node", "-e", script, configPath], { timeout: 30000 });
  if (r.code !== 0) {
    const tail = lastLine(r.err || r.out);
    return { ok: false, detail: `in-container memory probe failed rc=${r.code}${tail ? `: ${tail}` : ""}` };
  }
  let j = null;
  try { j = JSON.parse(lastLine(r.out) || "null"); } catch { j = null; }
  if (!j || !j.ok) return { ok: false, detail: `in-container memory probe: ${j?.error || "unreadable result"}` };
  return { ok: true, detail: `authenticated Ghost memory identity reachable inside ${container} (l0=${j.l0}, l1=${j.l1})` };
}

/**
 * Option-target capability checks (installation options 3/4, and the Ghost /
 * Office parts of option 2). Shared by the full install gate and the
 * `gate` command, so the native OpenChamber entrypoint exercises the SAME code.
 * @param v variant definition
 * @param flags parsed flags (flags.variant used for messages)
 * @param ctx install context ({ target, variantOutcome })
 * @param target detected/explicit OpenChamber target
 */
/**
 * The completeness rule of the gate: a capability that was never checked is
 * never complete. An empty check list can NEVER produce INSTALL COMPLETE.
 */
export function gateComplete(checked, missing) {
  return Array.isArray(checked) && checked.length > 0 && Array.isArray(missing) && missing.length === 0;
}

/**
 * The FUNCTIONALLY VERIFIED layer of the gate. Every probe here runs a REAL
 * shipped product path against the TARGET's own configuration:
 *
 *   - live memory authentication + SCOPE classification (a key that is merely
 *     present is never a scoped identity; an administrative key is refused)
 *   - the shipped memory loop: capture, later-session retrieval and verified
 *     knowledge promotion
 *   - a real RepoQL MCP call (handshake + tools/list)
 *   - the shipped documentation assessment + verified ingestion pipeline
 *   - the shipped provider failover router (two working providers)
 *
 * A probe that cannot run is a FAIL-CLOSED MISSING. Stubs may be injected
 * (ctx.probes) for unit tests, but an injected stub never turns into a
 * product PASS: the gate still reports what it could not prove.
 */
async function verifyRuntimeProofs({ memoryConfigPath, memoryBaseUrl, identity, probes = {}, execIn = null, rqlPath = null, ordinaryBinding = null }) {
  const missing = [];
  const checked = [];
  const note = (ok, label, detail = "") => {
    checked.push(`${ok ? "ok" : "MISSING"}: ${label}${detail ? ` — ${detail}` : ""}`);
    if (!ok) missing.push(detail ? `${label} (${detail})` : label);
  };

  // 1. live authentication + scope: decided ONCE by the caller (verifyOptionTarget)
  //    and shared with every credential-using check below. Presence, a non-empty
  //    file or an HTTP 200 are never enough.
  note(identity.ok, "scoped memory identity authenticated (live auth/verify, non-administrative)", identity.detail);

  // B7: a credential-using runtime proof runs ONLY with that verified scoped
  // identity. An administrative, unverified or rejected key is never reused by
  // the memory loop, the documentation ingestion or the model lane.
  const scoped = identity.ok === true;
  const notRun = (what) => ({ ok: false, state: "NOT_RUN",
    detail: `not run: ${what} needs a verified scoped memory identity — an administrative, unverified or rejected key is never used` });

  // 2. the shipped memory API loop (capture -> search -> knowledge promotion).
  //    This is an API-level proof only; normal-session capture and recall are
  //    checked separately in item 6 below and are never implied by this one.
  const loop = !scoped ? notRun("the memory loop")
    : probes.memoryLoop
      ? await probes.memoryLoop({ root: ROOT, memoryConfigPath, memoryBaseUrl })
      : await probeMemoryLoop({ root: ROOT, memoryConfigPath, memoryBaseUrl });
  note(loop.ok, "memory API loop: capture, search and verified knowledge promotion", loop.detail);

  // 3. a real RepoQL MCP tools/call (read-only query)
  const mcp = probes.repoqlMcp
    ? await probes.repoqlMcp({ rqlPath, cwd: ROOT, execIn })
    : await probeRepoqlMcp({ rqlPath, cwd: ROOT, execIn });
  note(mcp.ok, "RepoQL MCP server answers a real call", mcp.detail);

  // 4. automatic documentation assessment + verified ingestion (scoped identity only)
  const docs = !scoped ? notRun("documentation ingestion")
    : probes.docIngestion
      ? await probes.docIngestion({ root: ROOT, memoryConfigPath, memoryBaseUrl })
      : await probeDocIngestion({ root: ROOT, memoryConfigPath, memoryBaseUrl });
  note(docs.ok, "documentation assessment and verified ingestion", docs.detail);

  // 5. two working providers with a controlled failover
  const providers = probes.providerFailover
    ? await probes.providerFailover({ root: ROOT })
    : await probeProviderFailover({ root: ROOT });
  note(providers.ok, "two working providers with a controlled failover", providers.detail);

  // 6. ORDINARY-SESSION capture and NEW-session recall through the native
  //    lifecycle hooks. This needs a live conversation in the installed
  //    runtime, so the gate consumes EVIDENCE and never fakes it. For an
  //    OpenChamber target the evidence MUST be from the option's OWN native
  //    driver (acceptance-ordinary-session.mjs --runtime openchamber): a
  //    Claude Code file can never satisfy an OpenChamber install, and an
  //    option-3 file can never satisfy an option-4 gate.
  const ordinary = probes.ordinarySession
    ? await probes.ordinarySession({ root: ROOT, memoryConfigPath, memoryBaseUrl })
    : await probeOrdinarySessionRecall(ordinaryBinding || {});
  note(ordinary.ok, "ordinary-session automatic capture and NEW-session recall via the native hooks", ordinary.detail);

  return { checked, missing, identityOk: scoped };
}

/**
 * Ordinary-session proof (REAL, §6-round): ordinary capture and NEW-session
 * recall are proven by EVIDENCE produced by
 * scripts/acceptance-ordinary-session.mjs — two independent headless Claude
 * sessions through the production memory proxy with a unique single-run tag,
 * every stage recorded, corroborated LIVE against the memory service at gate
 * time. A claim file, a manual checkbox or configured hooks are never enough:
 *   - static schema checks (kind, both stages VERIFIED, two DISTINCT real
 *     Claude session ids — UUID shaped, uniqueness, no key-shaped material);
 *   - a live re-check that the tag is STILL searchable through the REAL
 *     service (schema-complete fabrication can never pass; a fabricator
 *     without the stack cannot corroborate);
 * Everything else stays an explicit fail-closed HOLD naming the exact
 * procedure — nothing is faked.
 */
export async function probeOrdinarySessionRecall(binding = {}) {
  const acceptance = await import("./acceptance-ordinary-session.mjs");
  const path = process.env.SINGULARITY_ORDINARY_SESSION_EVIDENCE || "";
  const runHint = binding.expectRuntime === "openchamber"
    ? `run scripts/acceptance-ordinary-session.mjs run --runtime openchamber${binding.expectOption ? ` --option ${binding.expectOption}` : ""} --evidence <file> (two real OpenChamber/OpenCode sessions: unique-tag capture through the installed plugin, NEW-session recall; no Claude Code dependency)`
    : "run scripts/acceptance-ordinary-session.mjs run --evidence <file> (two real sessions: unique-tag capture, NEW-session recall through the production proxy)";
  if (!path || !existsSync(path)) {
    return {
      ok: false,
      state: "HOLD",
      detail: `HOLD — needs a live ordinary session: ${runHint}, or set SINGULARITY_ORDINARY_SESSION_EVIDENCE to its evidence file; no evidence found`,
    };
  }
  const e = acceptance.evidenceFromDisk(path);
  const verdict = acceptance.evidenceVerdict(e, binding);
  if (!verdict.ok) return { ok: false, state: verdict.state, detail: `ordinary-session evidence rejected: ${verdict.detail}` };
  const live = await acceptance.verifyEvidenceLive(e, {});
  if (!live.ok) return { ok: false, state: live.state, detail: `ordinary-session evidence not corroborated: ${live.detail}` };
  return { ok: true, state: "VERIFIED", detail: `real ordinary-session capture and NEW-session recall verified with evidence ${path}: ${live.detail}` };
}

export async function verifyOptionTarget(v, flags, ctx, target) {
  const missing = [];
  const checked = [];
  const probes = (ctx && ctx.probes) || {};
  // The TARGET's own configuration is the only source of truth for the
  // credentials the plugin uses — never the package root.
  let resolvedConfigDir = null;
  let memoryConfigPath = null;
  let officeConfigPath = null;
  const note = (ok, label, detail = "") => {
    checked.push(`${ok ? "ok" : "MISSING"}: ${label}${detail ? ` — ${detail}` : ""}`);
    if (!ok) missing.push(detail ? `${label} (${detail})` : label);
  };

  // 6. options 3/4: existing OpenChamber reused, bundle present, plugin secrets live
  if (!v.openchamber) {
    // Options 1/2 install into Claude Code: the package's own plugin
    // configuration is the target configuration for them.
    memoryConfigPath = join(ROOT, "data/opencode/config/product-secrets/memory.json");
    officeConfigPath = join(ROOT, "data/opencode/config/product-secrets/office.json");
  }
  if (v.openchamber) {
    const inst = target;
    note(inst.kind !== "none", "existing OpenChamber detected (reused, never reinstalled)",
      inst.kind === "none" ? "none found" : `${inst.kind}${inst.container ? `: ${inst.container}` : ""}`);
    if (inst.kind !== "none") {
      let cfgDir = null, cfgErr = "";
      try { cfgDir = targetConfigDir(inst); } catch (e) { cfgErr = String(e?.message || e); }
      resolvedConfigDir = cfgDir;
      note(Boolean(cfgDir), "OpenChamber config directory resolved",
        cfgDir || (cfgErr || `no config dir for ${inst.kind} — pass an explicit target (--config-dir/--container) or fix the OpenChamber install`));
      if (cfgDir) {
        const bundleOk = existsSync(join(cfgDir, "plugins", "product-office", "package.json")) && existsSync(join(cfgDir, "AGENTS.md"));
        note(bundleOk, "OpenChamber memory-plugin bundle present",
          bundleOk ? cfgDir : `bundle incomplete in ${cfgDir} — run scripts/attach-openchamber.mjs --variant ${flags.variant}`);
        // The target's OWN MCP wiring must declare the RepoQL MCP: the attach
        // never overwrites a target's opencode.jsonc, so a pre-existing
        // RepoQL identity survives — and this check proves the code
        // intelligence is actually wired into the target.
        const ocCfgPath = join(cfgDir, "opencode.jsonc");
        let repoqlOk = false, repoqlDetail = "";
        if (existsSync(ocCfgPath)) {
          const ocText = readFileSync(ocCfgPath, "utf8");
          repoqlOk = /"repoql"\s*:/.test(ocText);
          repoqlDetail = repoqlOk
            ? ocCfgPath
            : `${ocCfgPath} declares no mcp.repoql entry — add the block from docs/REPOQL-SETUP.md (the attach never overwrites your own config)`;
        } else {
          repoqlDetail = `no opencode.jsonc in the target config (${cfgDir})`;
        }
        note(repoqlOk, "RepoQL MCP declared in the target's opencode.jsonc", repoqlDetail);
        const memCfgPath = join(cfgDir, "product-secrets", "memory.json");
        memoryConfigPath = memCfgPath;
        officeConfigPath = join(cfgDir, "product-secrets", "office.json");
        const cfg = readJson(memCfgPath);
        const secretsOk = Boolean(cfg && typeof cfg.userKey === "string" && cfg.userKey);
        note(secretsOk, "plugin memory credentials present (a key is configured; its scope is verified live below)",
          secretsOk ? memCfgPath : "memory.json missing or has no userKey in the target config");
      }
    }
  }

  // The scoped memory identity is decided ONCE, live, from the TARGET's own
  // configuration. Every credential-using check below (Ghost memory, memory
  // loop, documentation ingestion, model lane) depends on this single decision.
  const memCfgEarly = memoryConfigPath ? readJson(memoryConfigPath) : null;
  const memBaseEarly = memCfgEarly ? hostMemoryBaseUrl(memCfgEarly) : "";
  // An ADMINISTRATIVE key is recognised LOCALLY (this installation's own admin key,
  // compared in-process) and is never presented to the memory service.
  const identity = isAdministrativeKey(memCfgEarly && memCfgEarly.userKey, readAdministrativeKey(ROOT))
    ? { ok: false, state: "ADMIN", detail: "the configured memory key is this installation's ADMINISTRATIVE key (matched locally; no request was sent)" }
    : probes.memoryIdentity
      ? await probes.memoryIdentity({ config: memCfgEarly, baseUrl: memBaseEarly })
      : await probeMemoryIdentity({ config: memCfgEarly, baseUrl: memBaseEarly });
  const scoped = identity.ok === true;

  // 7. options 2/4: Ghost functional (config, memory identity, dream cycle, backend)
  if (v.ghost) {
    // Static configuration state is reported as static — never as functional
    // acceptance. The functional checks below are the authenticated memory
    // probe and the completed-consolidation journal.
    const envOk = existsSync(join(ROOT, "secrets", "ghost.env"));
    checked.push(`${envOk ? "ok" : "MISSING"}: Ghost static config (secrets/ghost.env)${envOk ? "" : " — run bash ghost/setup-ghost.sh"}`);
    if (!envOk) missing.push("Ghost static config (secrets/ghost.env)");

    let memOk = false, memDetail = "";
    // B7: the Ghost memory probe authenticates with the target's key, so it runs
    // ONLY with a verified scoped identity — never with an administrative one.
    if (!scoped) {
      memDetail = `not run: ${identity.detail} — an administrative, unverified or rejected key is never used`;
    } else try {
      const inst = target || (ctx && ctx.target) || detectOpenchamberInstance();
      if (v.openchamber && (inst.kind === "container" || inst.kind === "compose-managed")) {
        // Probe INSIDE the target: that is where the in-network alias resolves.
        const p = await probeGhostMemoryInContainer(inst.container, "/home/openchamber/.config/opencode/product-secrets/memory.json");
        memOk = p.ok; memDetail = p.detail;
      } else {
        const ghostCfg = memoryConfigPath
          || (v.openchamber ? null : join(ROOT, "data/opencode/config/product-secrets/memory.json"));
        if (!ghostCfg) memDetail = "no resolved OpenChamber config dir for the Ghost memory config";
        else {
          const p = await probeGhostMemoryOnHost(ghostCfg);
          memOk = p.ok; memDetail = p.detail;
        }
      }
    } catch (e) { memDetail = String(e?.message || e); }
    note(memOk, "Ghost memory identity reachable (authenticated probe)", memDetail);

    const dream = dreamOutcomeToday((ctx && ctx.ghostAgentDir) || undefined);
    note(dream.complete && dream.provenance, "Ghost dream consolidation completed today",
      dream.complete
        ? `${dream.journal} — ${dream.provenance ? "with memory commit/changed files" : "no provenance recorded"}`
        : (dream.detail || "no dream journal for today"));

    let daemon = false;
    const ps = spawnSync("docker", ["ps", "--format", "{{.Names}}"], { encoding: "utf8" });
    if (ps.status === 0) daemon = String(ps.stdout || "").split("\n").includes("singularity-ghost-dream");
    checked.push(`${daemon ? "ok" : "note"}: Ghost dream daemon ${daemon ? "running" : "not running — a one-shot dream still counts if the journal is complete"}`);

    if (v.ghostBackend === "claude-code") {
      const cliOk = Boolean(claudeBinary());
      note(cliOk, "Ghost claude-code backend available (claude CLI)", cliOk ? "" : "claude CLI not detected — the Claude Code backend cannot run turns");
      try {
        const res = await fetch("http://127.0.0.1:18003/healthz", { signal: AbortSignal.timeout(4000) });
        const j = await res.json().catch(() => null);
        if (j && j.backend) {
          note(j.backend === "claude-code" && j.execAvailable !== false,
            "Ghost gateway reports the claude-code backend",
            `backend=${j.backend} execAvailable=${j.execAvailable}`);
        } else {
          checked.push("note: Ghost gateway /healthz did not report a backend — start it with `node ghost/ghost-gateway.mjs` (GHOST_BACKEND=claude-code) for interactive turns");
        }
      } catch {
        checked.push("note: Ghost gateway not reachable on 127.0.0.1:18003 — start `node ghost/ghost-gateway.mjs` (GHOST_BACKEND=claude-code) for interactive turns");
      }
    } else if (v.ghostBackend === "openchamber") {
      try {
        const res = await fetch("http://127.0.0.1:18003/healthz", { signal: AbortSignal.timeout(4000) });
        const j = await res.json().catch(() => null);
        if (j && j.backend) {
          note(j.backend === "openchamber", "Ghost gateway reports the openchamber backend", `backend=${j.backend} execAvailable=${j.execAvailable}`);
        } else {
          checked.push("note: Ghost gateway /healthz did not report a backend — start it on the host for headless Ghost turns (docs/GHOST-SETUP.md)");
        }
      } catch {
        checked.push("note: Ghost gateway not reachable on 127.0.0.1:18003 — the dream daemon uses the memory proxy directly; start the host gateway for headless Ghost turns (docs/GHOST-SETUP.md)");
      }
    }
  }

  // 8. options 2/4: Claude Office functional (native payload consumed, read back)
  if (v.office) {
    const office = await probeOfficeFunctional(officeConfigPath);
    note(office.ok, "Claude Office reachable and authenticated (native event consumed)", office.detail);
  }

  // ── FUNCTIONALLY VERIFIED: the real runtime proofs ────────────────────────
  const memCfg = memoryConfigPath ? readJson(memoryConfigPath) : null;
  const memBase = memCfg ? hostMemoryBaseUrl(memCfg) : "";
  const execIn = target && target.kind === "container" ? target.container : null;
  const proofs = await verifyRuntimeProofs({
    memoryConfigPath,
    memoryBaseUrl: memBase,
    identity,
    probes,
    execIn,
    rqlPath: detectRql(process.env.HOME, process.env),
    // An OpenChamber target verifies the option's OWN native driver: runtime
    // "openchamber", bound to the exact installation option (3 or 4).
    ordinaryBinding: v.openchamber
      // Canonical option ids are STRINGS (the CLI shape and the evidence shape).
      ? { expectRuntime: "openchamber", expectOption: String(flags.variant) || null }
      : null,
  });
  for (const c of proofs.checked) checked.push(c);
  missing.push(...proofs.missing);

  // The model lane is DERIVED from the canonical configuration and must be
  // proven by a real completion: a reachable proxy or a listed model is never
  // a proof. Option 3 uses the operator's own OpenChamber provider, so the
  // product's own lane is not part of that option.
  if (v.ghost || !v.openchamber) {
    if (!scoped) {
      // B7: the lane authenticates with the target's key — never an administrative one.
      note(false, "model lane registered and working (real completion through the derived lane)",
        `not run: ${identity.detail} — the lane never uses an administrative, unverified or rejected key`);
    } else {
      const lane = resolveModelLane({ flavour: "host", env: process.env, upstreamEnvContent: readUpstreamEnvContent(ROOT) });
      const laneProbe = probes.modelLane
        ? await probes.modelLane({ lane, key: (memCfg && memCfg.userKey) || "" })
        : await probeModelLane({ gatewayUrl: lane.route, key: (memCfg && memCfg.userKey) || "", serviceId: lane.spaceId });
      note(laneProbe.ok, "model lane registered and working (real completion through the derived lane)",
        laneProbe.ok ? laneProbe.detail : `${laneProbe.detail} — ${modelLaneAdvice(laneProbe.state)}`);
    }
  }

  // A capability that was never checked is never complete: an empty check
  // list can NEVER produce INSTALL COMPLETE.
  if (!checked.length) missing.push("no capability check was executed (an empty check list is never complete)");
  return { complete: gateComplete(checked, missing), missing, checked };
}

async function verifyOptionCapabilities(flags, ctx) {
  const { settings, main, profileOutcome, mcp, variantOutcome } = ctx;
  const v = variantOutcome.variant;
  const missing = [];
  const checked = [];
  const note = (ok, label, detail = "") => {
    checked.push(`${ok ? "ok" : "MISSING"}: ${label}${detail ? ` — ${detail}` : ""}`);
    if (!ok) missing.push(detail ? `${label} (${detail})` : label);
  };

  if (flags.dryRun) return { complete: true, missing, checked, dryRun: true };

  // 1. specialist agent definitions installed with packaged content
  try {
    const recheck = planAgentFiles(flags.agentsTarget);
    const okAll = recheck.length === Object.keys(AGENT_MAP).length && recheck.every((f) => f.status === "present");
    note(okAll, "seven specialist agent definitions installed",
      okAll ? "" : `${recheck.filter((f) => f.status !== "present").length} file(s) do not match the packaged content`);
  } catch (e) { note(false, "seven specialist agent definitions installed", String(e?.message || e)); }

  // 2. memory + documentation hooks merged into settings
  try {
    const st = readSettingsFileStrict(flags.settingsPath);
    const events = st.malformed ? [] : Object.keys(st.settings?.hooks || {});
    const okHooks = ALL_HOOK_EVENTS.every((k) => events.includes(k));
    note(okHooks, "memory + documentation hooks merged", okHooks ? "" : `present: ${events.join(", ") || "(none)"}`);
  } catch (e) { note(false, "memory + documentation hooks merged", String(e?.message || e)); }

  // 3. specialist MemoryCore profiles provisioned (never skippable). A cached
  // ledger entry ("present") is NOT acceptance evidence — the seeder now probes
  // each cached profile live before reporting "verified", so only a live,
  // authenticated existence check (seeded|verified) passes.
  const prof = profileOutcome || { skipped: true, results: [], failed: 0 };
  const profOk = !prof.skipped && prof.failed === 0 && Array.isArray(prof.results) &&
    prof.results.length >= 7 && prof.results.every((r) => ["seeded", "verified"].includes(r.status));
  note(profOk, "specialist MemoryCore profiles provisioned",
    prof.skipped ? "skipped — provision the plugin secrets, then re-run" : prof.failed ? `${prof.failed} failed` : "");

  // 4. RepoQL MCP registered (mandatory in every option)
  if (flags.skipRepoqlMcp) {
    note(false, "RepoQL MCP registered", "--skip-repoql-mcp cannot pass an installation option");
  } else {
    note(Boolean(mcp), "RepoQL MCP registered",
      mcp ? (mcp.present ? "already configured" : `registered (${mcp.command})`) : "rql or claude CLI not detected — see docs/REPOQL-SETUP.md");
  }

  // 5. normal-session memory routing (options 1/2; consent decline => INCOMPLETE)
  if (v.openchamber && !flags.mainMemory) {
    checked.push("ok: normal-session routing handled by the OpenChamber plugin for this option");
  } else {
    const mainOk = main && (main.applied || (main.mode === "verified-existing"));
    if (mainOk) note(true, "normal-session memory routing", `mode: ${main.mode}`);
    else if (main?.refused) note(false, "normal-session memory routing", `refused: ${(main.conflicts || []).join("; ")} — pass --replace-provider after explicit consent, or keep your provider`);
    else note(false, "normal-session memory routing",
      main?.skipped
        ? `declined or unprovisioned (${main.reason || "consent declined"}) — a declined capability leaves the install INCOMPLETE; it is never forced`
        : "not applied");
  }

  // 6-8. option-target checks (existing OpenChamber reuse, Ghost functional,
  // Claude Office consumption) — shared with the `gate` command so the native
  // OpenChamber entrypoint exercises the same code path.
  const target = ctx.target || detectOpenchamberInstance();
  const t = await verifyOptionTarget(v, flags, ctx, target);
  for (const c of t.checked) checked.push(c);
  missing.push(...t.missing);

  // A capability that was never checked is never complete.
  if (!checked.length) missing.push("no capability check was executed (an empty check list is never complete)");
  return { complete: gateComplete(checked, missing), missing, checked };
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

  // Option validation: mandatory capabilities are verified BEFORE any files
  // change; an option with unmet requirements refuses install. Exactly four
  // installation options exist — an install without one is stopped (on an
  // interactive terminal the four options are offered as a numbered menu), so
  // there is never an unnumbered "base" install.
  if (!flags.variant) {
    if (process.stdin.isTTY && process.stdout.isTTY) {
      log("Select an installation option (exactly four exist — README §START HERE):");
      for (const line of installOptionLines()) log(line);
      let chosen = null;
      try { chosen = parseOptionChoice(await readLine("installation option [1-4]: ")); } catch { chosen = null; }
      if (!chosen) {
        warn("no installation option selected — installation stopped unmodified");
        return 2;
      }
      flags.variant = chosen;
    } else {
      warn("no installation option selected — installation stopped unmodified");
      warn("exactly four installation options exist: select one with --variant 1|2|3|4 (README §START HERE)");
      return 2;
    }
  }
  // Installation options 3 and 4 ATTACH to an EXISTING OpenChamber: they are
  // not Claude Code installations. The installer refuses them BEFORE touching
  // anything and points at the documented native entrypoints.
  if (["3", "4"].includes(String(flags.variant))) {
    warn(`installation option ${flags.variant} attaches to an EXISTING OpenChamber and is not a Claude Code install — nothing was changed.`);
    warn(`  start:   SINGULARITY_VARIANT=${flags.variant} bash scripts/start.sh`);
    warn(`  verify:  node scripts/install-claude-code.mjs gate --variant ${flags.variant} [--container NAME | --config-dir DIR]`);
    return 2;
  }
  const variantOutcome = resolveVariant(flags);
  log(`  option:   ${flags.variant} — ${variantOutcome.variant.name}`);
  for (const n of variantOutcome.notes) log(`  option note: ${n}`);
  if (!variantOutcome.ok) {
    for (const p of variantOutcome.problems) warn(`  option REFUSED: ${p}`);
    warn("  option:   installation stopped unmodified; resolve the mandatory capabilities above, then re-run");
    return 4; // option requirement refusal: the on-disk state was not touched
  }

  // Main-agent memory decision: explicit flags win; otherwise offer interactively
  // and default OFF for non-interactive runs (the guided experience still OFFERS,
  // and automation opts in with --enable-main-memory).
  let mainMemoryFlags;
  if (flags.mainMemory === true || flags.mainMemory === false) {
    mainMemoryFlags = { enabled: flags.mainMemory, replaceProvider: flags.replaceProvider };
  } else if (process.stdout.isTTY) {
    try {
      const reply = (await readLine(`configuration for installation option ${flags.variant}: enable persistent memory for your NORMAL Claude Code sessions via the Singularity proxy? [Y/n] `)).trim().toLowerCase();
      mainMemoryFlags = { enabled: reply !== "n" && reply !== "no", replaceProvider: flags.replaceProvider };
    } catch {
      mainMemoryFlags = { enabled: false, replaceProvider: flags.replaceProvider };
    }
  } else {
    mainMemoryFlags = { enabled: false, replaceProvider: flags.replaceProvider };
    log("  main:     non-interactive run — advanced configuration: pass --enable-main-memory to enable normal-agent persistent memory (see docs/CLAUDE-CODE-SETUP.md)");
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
      mcp: mcp && !mcp.present ? { name: mcp.name, transport: mcp.transport, command: mcp.command, scope: mcp.scope } : null,
      profileLedger: join(ROOT, "data/agent-profiles/ledger.json"),
      variant: { id: flags.variant, name: VARIANTS[flags.variant].name, ghostBackend: VARIANTS[flags.variant].ghostBackend || null, verified: variantOutcome.ok },
    });
  }

  main && main.applied && log("next: proxy routing is active for new Claude Code sessions; verify with `status --probe` and docs/CLAUDE-CODE-SETUP.md");
  log("next: restart Claude Code, run /agents to confirm discovery, then follow the verification checks in docs/CLAUDE-CODE-SETUP.md");

  // ── mandatory-capability gate ────────────────────────────────────────────────
  const gate = await verifyOptionCapabilities(flags, { settings, main, profileOutcome, mcp, variantOutcome });
  for (const c of gate.checked) log(`  gate:     ${c}`);
  if (!gate.complete) {
    warn("INSTALL INCOMPLETE — mandatory capabilities not verified for this installation option:");
    for (const m of gate.missing) warn(`  - ${m}`);
    warn("  nothing was forced and no mandatory capability was waived; resolve the items above and re-run the same option (idempotent).");
    if (!flags.dryRun) {
      const state = readState();
      const rec = state.installs.find((r) => r.settingsPath === flags.settingsPath);
      if (rec && rec.variant) { rec.variant.verified = false; rec.variant.incomplete = gate.missing; writeState(state); }
    }
    return 5; // INCOMPLETE: on-disk integration exists but the option is not verified
  }
  log(`INSTALL COMPLETE — installation option ${flags.variant} (${VARIANTS[flags.variant].name}) verified.`);
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
  if (record.variant) log(`option: ${record.variant.id} — ${record.variant.name}${record.variant.ghostBackend ? ` (ghost backend: ${record.variant.ghostBackend})` : ""}${record.variant.verified ? "" : record.variant.incomplete?.length ? ` — INCOMPLETE: ${record.variant.incomplete.join("; ")}` : " [unverified]"}`);
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
  // B7: an ADMINISTRATIVE key is reported, never probed: the probe would present it.
  const adminLocalKey = readAdministrativeKey(ROOT);
  const settingsTokenIsAdmin = isAdministrativeKey(settings?.env?.ANTHROPIC_AUTH_TOKEN || "", adminLocalKey);
  const memoryTokenIsAdmin = isAdministrativeKey(readJson(record.envWritten?.SINGULARITY_MEMORY_CONFIG || join(ROOT, "data/opencode/config/product-secrets/memory.json"))?.userKey || "", adminLocalKey);
  let probe = null;
  if (flags.probe && record.mainMemory?.enabled && !memoryTokenIsAdmin) {
    const token = readJson(record.envWritten?.SINGULARITY_MEMORY_CONFIG || join(ROOT, "data/opencode/config/product-secrets/memory.json"))?.userKey || null;
    probe = await probeMainProxy(baseUrl, token);
  }
  const mainState = settingsTokenIsAdmin
    ? { state: "ADMINISTRATIVE-TOKEN", detail: "the routing token in Claude Code settings equals the memory stack ADMINISTRATIVE key (value not printed): rotate it to a scoped key; the installer refuses to write it again" }
    : memoryTokenIsAdmin
      ? { state: "REFUSED", detail: "the memory config's key is the ADMINISTRATIVE key: not routed and not probed" }
      : record.mainMemory?.enabled
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

/**
 * Native OpenChamber entrypoint for installation options 3/4: verify the
 * option's target capabilities WITHOUT installing Claude Code. Exercises the
 * same verifyOptionTarget code the full install gate runs.
 *
 *   node scripts/install-claude-code.mjs gate --variant 3|4 [--container NAME | --config-dir DIR]
 *
 * Exit 0 = INSTALL COMPLETE (target capabilities verified); 5 = INSTALL
 * INCOMPLETE (the missing items are printed). Nothing is written.
 */
export async function runGate(argv) {
  let flags;
  try {
    flags = parseFlags(argv, process.env.HOME, process.cwd());
  } catch (e) {
    log(`usage error: ${e.message}`);
    log(usageText());
    return 2;
  }
  if (!flags.variant) {
    warn("gate requires --variant 3|4 (the installation options that attach to an existing OpenChamber)");
    return 2;
  }
  if (!["3", "4"].includes(String(flags.variant))) {
    // The gate verifies the ATTACH options only. Options 1/2 are Claude Code
    // installations and are verified by their own installer — the gate must
    // never answer for them (an empty check list once looked complete).
    warn(`the gate verifies the ATTACH installation options (3 and 4) only — option ${flags.variant} is a Claude Code installation option:`);
    warn(`  node scripts/install-claude-code.mjs install --variant ${flags.variant}`);
    warn("usage: node scripts/install-claude-code.mjs gate --variant 3|4 [--container NAME | --config-dir DIR]");
    return 2;
  }
  // The target is supplied explicitly or discovered; resolveVariant's existence
  // check is satisfied by the explicit/discovered target below.
  const variantOutcome = resolveVariant(flags, { detectOpenchamber: () => true });
  if (!variantOutcome.ok) {
    for (const p of variantOutcome.problems) warn(`  option REFUSED: ${p}`);
    return 4;
  }
  let target;
  if (flags.container) {
    target = { kind: "container", container: flags.container };
  } else if (flags.configDir) {
    if (!existsSync(flags.configDir)) { warn(`--config-dir ${flags.configDir} does not exist`); return 2; }
    target = { kind: "native", configDir: flags.configDir };
  } else {
    target = detectOpenchamberInstance();
  }
  log(`gate: option ${flags.variant} — ${variantOutcome.variant.name}`);
  log(`gate: target ${target.kind}${target.container ? ` (${target.container})` : ""}${target.configDir ? ` config=${target.configDir}` : ""}`);
  const r = await verifyOptionTarget(variantOutcome.variant, flags, { variantOutcome, target }, target);
  for (const c of r.checked) log(`  ${c}`);
  if (r.complete) log(`INSTALL COMPLETE — option ${flags.variant} target capabilities verified`);
  else log(`INSTALL INCOMPLETE — option ${flags.variant}: ${r.missing.join("; ")}`);
  return r.complete ? 0 : 5;
}

export async function main(argv) {
  const [command, ...rest] = argv;
  if (!["install", "uninstall", "status", "gate"].includes(command)) {
    log(usageText());
    return 2;
  }
  let flags;
  try {
    flags = parseFlags(rest, process.env.HOME, process.cwd());
  } catch (e) {
    log(`usage error: ${e.message}`);
    log(usageText());
    return 2;
  }
  if (command === "install") return runInstall(flags);
  if (command === "uninstall") return runUninstall(flags);
  if (command === "gate") return runGate(rest);
  return runStatus(flags);
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  process.exit(await main(process.argv.slice(2)));
}
