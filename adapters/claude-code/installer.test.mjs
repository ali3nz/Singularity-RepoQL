// Unit tests for the Claude Code integration installer (pure parts) and the
// settings merge/unmerge helpers. Run:
//   node --test adapters/claude-code/installer.test.mjs
import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, mkdirSync, readFileSync, writeFileSync, statSync, chmodSync, copyFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  ensureMemoryIntegration,
  removeMemoryIntegration,
  settingsPathFor,
  isSingularityHookCommand,
} from "./settings-merge.mjs";
import {
  applyAgentFiles,
  applySettings,
  agentRemovalPlan,
  resolveVariant,
  VARIANTS,
  integrationEnv,
  parseFlags,
  planAgentFiles,
  readState,
  saveInstallRecord,
  uninstallFilesForRecord,
  applyMainMemory,
  UsageError,
} from "../../scripts/install-claude-code.mjs";

const HOOK_SCRIPT = "/srv/singularity/adapters/claude-code/memory-hook.mjs";

test("hook command recognition is precise", () => {
  assert.equal(isSingularityHookCommand(`node ${HOOK_SCRIPT} subagent-start`), true);
  assert.equal(isSingularityHookCommand(`node ${HOOK_SCRIPT} subagent-stop`), true);
  assert.equal(isSingularityHookCommand(`node /other/office-hook.mjs subagent-stop`), false);
  assert.equal(isSingularityHookCommand(`node ${HOOK_SCRIPT} stop`), false);
  assert.equal(isSingularityHookCommand(undefined), false);
});

test("ensureMemoryIntegration adds both hook events and env without touching unrelated settings", () => {
  const existing = {
    model: "opus",
    env: { EXISTING_VAR: "keep-me", SINGULARITY_REPO_ROOT: "/user/override" },
    hooks: {
      PreToolUse: [{ hooks: [{ type: "command", command: "node /other/pretool.mjs" }] }],
      SubagentStop: [{ hooks: [{ type: "command", command: "node /other/officestop.mjs" }] }],
    },
  };
  const { settings, changed } = ensureMemoryIntegration(existing, {
    scriptPath: HOOK_SCRIPT,
    env: integrationEnv("/srv/singularity"),
  });
  assert.equal(changed, true);
  assert.equal(settings.model, "opus", "unrelated settings preserved");
  assert.equal(settings.hooks.PreToolUse[0].hooks[0].command, "node /other/pretool.mjs");
  const stopCommands = settings.hooks.SubagentStop[0].hooks.map((h) => h.command);
  assert.deepEqual(stopCommands, ["node /other/officestop.mjs", `node ${HOOK_SCRIPT} subagent-stop`], "hook appended, other hooks kept");
  assert.deepEqual(settings.hooks.SubagentStart.flatMap((g) => g.hooks.map((h) => h.command)), [`node ${HOOK_SCRIPT} subagent-start`]);
  // env: ours added when absent, user's existing value never overwritten
  assert.equal(settings.env.EXISTING_VAR, "keep-me");
  assert.equal(settings.env.SINGULARITY_REPO_ROOT, "/user/override");
  assert.equal(settings.env.SINGULARITY_MEMORY_CONFIG, "/srv/singularity/data/opencode/config/product-secrets/memory.json");
});

test("re-running ensureMemoryIntegration is a no-op (idempotency)", () => {
  const base = {};
  const first = ensureMemoryIntegration(base, { scriptPath: HOOK_SCRIPT, env: integrationEnv("/srv/singularity") });
  const second = ensureMemoryIntegration(first.settings, { scriptPath: HOOK_SCRIPT, env: integrationEnv("/srv/singularity") });
  assert.equal(second.changed, false);
  assert.deepEqual(second.settings, first.settings);
});

test("removeMemoryIntegration deletes only this integration's entries", () => {
  const existing = {
    model: "opus",
    env: { EXISTING_VAR: "keep-me", ...integrationEnv("/srv/singularity") },
    hooks: {
      SubagentStart: [{ hooks: [{ type: "command", command: `node ${HOOK_SCRIPT} subagent-start` }] }, { hooks: [{ type: "command", command: "node /other/otherstart.mjs" }] }],
      SessionStart: [{ hooks: [{ type: "command", command: "node /other/session.mjs" }] }],
    },
  };
  const { settings, changed, removedEnvKeys } = removeMemoryIntegration(existing, {
    scriptPath: HOOK_SCRIPT,
    env: integrationEnv("/srv/singularity"),
  });
  assert.equal(changed, true);
  assert.equal(settings.model, "opus");
  assert.ok(settings.hooks.SubagentStart, "the event survives because a foreign hook remains");
  assert.ok(settings.hooks.SubagentStart.some(g => g.hooks.some(h => h.command === "node /other/otherstart.mjs")), "foreign SubagentStart handler preserved");
  assert.ok(!settings.hooks.SubagentStart.some(g => g.hooks.some(isSingularityHookCommand)), "our handler is gone");
  assert.ok(settings.hooks.SessionStart, "foreign SessionStart hook preserved");
  assert.deepEqual(removedEnvKeys.sort(), ["SINGULARITY_MEMORY_CONFIG", "SINGULARITY_REPO_ROOT"]);
  assert.equal(settings.env.EXISTING_VAR, "keep-me");
});

test("removeMemoryIntegration keeps env keys that were edited by the user afterwards", () => {
  const existing = { env: { SINGULARITY_REPO_ROOT: "/elsewhere/now" } };
  const { changed, removedEnvKeys } = removeMemoryIntegration(existing, { scriptPath: HOOK_SCRIPT, env: integrationEnv("/srv/singularity") });
  assert.equal(changed, false);
  assert.deepEqual(removedEnvKeys, []);
  assert.equal(existing.env.SINGULARITY_REPO_ROOT, "/elsewhere/now");
});

test("settingsPathFor picks user vs project layout", () => {
  assert.equal(settingsPathFor("user", "/home/u", "/proj"), "/home/u/.claude/settings.json");
  assert.equal(settingsPathFor("project", "/home/u", "/proj"), "/proj/.claude/settings.json");
});

// ── installer (pure planning + file application) ─────────────────────────────
const srcFixture = () => {
  const dir = mkdtempSync(join(tmpdir(), "cc-src-"));
  writeFileSync(join(dir, "singularity-thinker.md"), "---\nname: singularity-thinker\ndescription: reasoning specialist\n---\nbody\n");
  writeFileSync(join(dir, "singularity-board.md"), "---\nname: singularity-board\ndescription: advisory board\n---\nbody\n");
  return dir;
};

test("planAgentFiles reports create/present/replace; applyAgentFiles is idempotent", () => {
  const source = srcFixture();
  const target = mkdtempSync(join(tmpdir(), "cc-target-"));
  mkdirSync(join(target, ".claude", "agents"), { recursive: true });

  let plan = planAgentFiles(join(target, ".claude", "agents"), source);
  assert.deepEqual(plan.map((f) => f.status), ["create", "create"]);
  const first = applyAgentFiles(plan, { dryRun: false });
  assert.equal(first.changed.length, 2);
  assert.equal(first.ledger.filter((e) => e.action === "create").length, 2);

  plan = planAgentFiles(join(target, ".claude", "agents"), source);
  assert.deepEqual(plan.map((f) => f.status), ["present", "present"]);
  const second = applyAgentFiles(plan, { dryRun: false }); // second install: nothing rewritten
  assert.equal(second.changed.length, 0, "repeated install is idempotent: no new writes");
  assert.equal(second.ledger.every((e) => e.action === "present"), true);
  assert.equal(readFileSync(join(target, ".claude", "agents", "singularity-thinker.md"), "utf8").includes("reasoning specialist"), true);

  // drift: differing content is a user-owned file — replan markers "replace".
  // The replace IS backed up and ledgered at apply time (see the ownership tests).
  writeFileSync(join(target, ".claude", "agents", "singularity-thinker.md"), "edited locally");
  plan = planAgentFiles(join(target, ".claude", "agents"), source);
  assert.deepEqual(plan.map((f) => f.status), ["present", "replace"]);
  assert.ok(plan[1].prevSha, "pre-replace hash captured");
  applyAgentFiles(plan, { dryRun: false });
  assert.ok(readFileSync(join(target, ".claude", "agents", "singularity-thinker.md"), "utf8").includes("body\n"));
});

test("agent-file ownership: user file is backed up before replace and RESTORED at uninstall", () => {
  const source = srcFixture();
  const agentsDir = mkdtempSync(join(tmpdir(), "cc-agents-"));
  const target = join(agentsDir, "singularity-board.md");
  const original = "my own board notes — DO NOT DESTROY";
  writeFileSync(target, original, { mode: 0o644 });

  let plan = planAgentFiles(agentsDir, source);
  assert.equal(plan.find((f) => f.target === target).status, "replace");
  const { ledger } = applyAgentFiles(plan, { dryRun: false });
  const entry = ledger.find((e) => e.target === target);
  assert.equal(entry.action, "replace");
  assert.ok(entry.backupPath && existsSync(entry.backupPath), "original backed up");
  assert.equal(readFileSync(entry.backupPath, "utf8"), original, "backup preserves user content verbatim");
  if (process.platform !== "win32") assert.equal(readFileSync(entry.backupPath).length > 0, true);

  // A ledger-equipped record with the installed content restores the original.
  const record = { agentsDir, agentLedger: ledger };
  const plan2 = agentRemovalPlan(record, source);
  const restoreItem = plan2.find((x) => x.target === target);
  assert.equal(restoreItem.action, "restore", "ledger-proven installed file restores the pre-install original");
  // simulate uninstall application:
  copyFileSync(restoreItem.backupPath, restoreItem.target);
  assert.equal(readFileSync(target, "utf8"), original, "original content returns");

  // Refusal of unsafe restoration: the user changed the file AFTER install.
  writeFileSync(target, "brand-new user edits made later");
  const plan3 = agentRemovalPlan(record, source);
  assert.equal(plan3.find((x) => x.target === target).action, "user-modified-keep",
    "newer user changes are never overwritten by uninstall");
});

test("agent-file ownership: unowned files are kept; untracked-but-package-identical are removable", () => {
  const source = srcFixture();
  const agentsDir = mkdtempSync(join(tmpdir(), "cc-agents-"));
  // A user's own agent file that happens to share our naming pattern: no ledger
  // entry, content differs from the package -> never touched.
  const foreign = join(agentsDir, "singularity-thinker.md");
  writeFileSync(foreign, "foreign hand-written");
  // An identical copy of the packaged source without a ledger: content proof.
  const copy = join(agentsDir, "singularity-board.md");
  copyFileSync(join(source, "singularity-board.md"), copy);
  const plan = agentRemovalPlan({ agentsDir, agentLedger: null }, source);
  assert.equal(plan.find((x) => x.target === foreign).action, "keep-unowned");
  assert.equal(plan.find((x) => x.target === copy).action, "remove-unchanged-source");
});

test("applySettings refuses a malformed existing settings file and preserves it; missing file is fine", () => {
  const dir = mkdtempSync(join(tmpdir(), "cc-bad-"));
  const settingsPath = join(dir, "settings.json");
  writeFileSync(settingsPath, "{ model: \"haiku\", BROKEN,,, :");
  const refused = applySettings(settingsPath, HOOK_SCRIPT, integrationEnv("/srv/s"), { dryRun: false });
  assert.equal(refused.refused, "malformed-settings");
  assert.equal(refused.changed, false);
  assert.equal(readFileSync(settingsPath, "utf8"), "{ model: \"haiku\", BROKEN,,, :", "malformed file is preserved byte-exact");
  assert.equal(refused.backup, null, "no destructive side effects on refusal");

  // A missing file is NOT the malformed case: fresh install proceeds.
  const missingPath = join(dir, "nested", "settings.json");
  const fresh = applySettings(missingPath, HOOK_SCRIPT, integrationEnv("/srv/s"), { dryRun: false });
  assert.equal(fresh.refused, undefined);
  assert.equal(fresh.changed, true);
  assert.ok(existsSync(missingPath));
});

test("credential-bearing files are 0600 with pre-existing modes corrected (POSIX)", { skip: process.platform === "win32" }, () => {
  const dir = mkdtempSync(join(tmpdir(), "cc-perm-"));
  const settingsPath = join(dir, "settings.json");
  // A pre-existing group/world-readable settings file with a token inside:
  // mode 0600 at write time would NOT fix it — explicit enforcement must.
  writeFileSync(settingsPath, JSON.stringify({ model: "haiku", env: { ANTHROPIC_AUTH_TOKEN: "sk-test-only" } }), { mode: 0o664 });
  chmodSync(settingsPath, 0o664);
  applySettings(settingsPath, HOOK_SCRIPT, integrationEnv("/srv/s"), { dryRun: false });
  assert.equal(numberToModeString((statSync(settingsPath).mode & 0o777)), "600", "enforced and verified 0600");
  // The backup of a token-bearing settings file is also restricted.
  const first = applySettings(join(dir, "other.json"), HOOK_SCRIPT, integrationEnv("/srv/s"), { dryRun: false });
  assert.equal(first.backup, null);
});

function numberToModeString(mode) { return mode.toString(8); }

test("applySettings writes a timestamped backup before the first change; skips when idempotent", () => {
  const dir = mkdtempSync(join(tmpdir(), "cc-settings-"));
  const settingsPath = join(dir, "settings.json");
  writeFileSync(settingsPath, JSON.stringify({ model: "haiku" }));
  const first = applySettings(settingsPath, HOOK_SCRIPT, integrationEnv("/srv/s"), { dryRun: false });
  assert.equal(first.changed, true);
  assert.ok(first.backup && existsSync(first.backup), "backup written");
  assert.equal(JSON.parse(readFileSync(first.backup, "utf8")).model, "haiku");
  assert.equal(JSON.parse(readFileSync(settingsPath, "utf8")).model, "haiku", "pre-existing settings kept");

  const second = applySettings(settingsPath, HOOK_SCRIPT, integrationEnv("/srv/s"), { dryRun: false });
  assert.equal(second.changed, false);
  assert.equal(second.backup, null, "no churn when already installed");
});

test("uninstalled state: removeMemoryIntegration leaves foreign hooks behind after uninstalling ours", () => {
  const settings = ensureMemoryIntegration({ hooks: { SessionStart: [{ hooks: [{ type: "command", command: "echo plain" }] }] } }, { scriptPath: HOOK_SCRIPT, env: {} }).settings;
  const after = removeMemoryIntegration(settings, { scriptPath: HOOK_SCRIPT, env: {} });
  assert.deepEqual(after.settings, { hooks: { SessionStart: [{ hooks: [{ type: "command", command: "echo plain" }] }] } });
});

test("parseFlags: defaults, project scope paths, team/user overrides, unknown flag rejected", () => {
  const home = "/home/test-user";
  const f1 = parseFlags([], home, "/proj");
  assert.equal(f1.scope, "user");
  assert.equal(f1.settingsPath, join(home, ".claude/settings.json"));
  assert.equal(f1.agentsTarget, join(home, ".claude/agents"));
  assert.equal(f1.mainMemory, null, "main-agent memory is an explicit decision (no silent default in flags)");
  const f2 = parseFlags(["--scope", "project", "--project-dir", "/proj"], home, "/proj");
  assert.equal(f2.settingsPath, "/proj/.claude/settings.json");
  assert.equal(f2.agentsTarget, "/proj/.claude/agents");
  const f3 = parseFlags(["--team", "t1", "--user", "u1"], home, "/proj");
  assert.equal(f3.team, "t1");
  assert.equal(f3.user, "u1");
  const f4 = parseFlags(["--enable-main-memory", "--replace-provider", "--probe"], home, "/proj");
  assert.equal(f4.mainMemory, true);
  assert.equal(f4.replaceProvider, true);
  assert.equal(f4.probe, true);
  const f5 = parseFlags(["--no-main-memory"], home, "/proj");
  assert.equal(f5.mainMemory, false);
  assert.throws(() => parseFlags(["--bogus"], home, "/proj"), UsageError);
});

test("applyMainMemory: fresh settings get proxy routing when enabled; token never printed or logged", () => {
  const dir = mkdtempSync(join(tmpdir(), "cc-main-"));
  const settingsPath = join(dir, "settings.json");
  const cfgDir = join(dir, "data", "opencode", "config", "product-secrets");
  mkdirSync(cfgDir, { recursive: true });
  const TOKEN = "sk-unit-test-token-value";
  writeFileSync(join(cfgDir, "memory.json"), JSON.stringify({ baseUrl: "http://stub", authPrefix: "Bearer ", gatewayKey: "g", serviceId: "s", userKey: TOKEN }));
  mkdirSync(join(dir, "memory", "upstream"), { recursive: true });
  writeFileSync(join(dir, "memory", "upstream", ".env"), "PROXY_PORT=18496\n");

  const logs = [];
  const log = (m) => logs.push(String(m));
  const warn = (m) => logs.push("WARN " + m);
  const out = applyMainMemory(settingsPath, { mainMemoryFlags: { enabled: true, replaceProvider: false }, repoRoot: dir, dryRun: false, log, warn });
  assert.equal(out.applied, true);
  assert.equal(out.baseUrl, "http://127.0.0.1:18496/claude-code/default");
  const settings = JSON.parse(readFileSync(settingsPath, "utf8"));
  assert.equal(settings.env.ANTHROPIC_BASE_URL, "http://127.0.0.1:18496/claude-code/default");
  assert.equal(settings.env.ANTHROPIC_AUTH_TOKEN, TOKEN);
  for (const l of logs) assert.ok(!l.includes(TOKEN), "token must never appear in installer output: " + l);
});

test("applyMainMemory refuses on existing provider config without explicit replace consent", () => {
  const dir = mkdtempSync(join(tmpdir(), "cc-main2-"));
  const settingsPath = join(dir, "settings.json");
  const cfgDir = join(dir, "data", "opencode", "config", "product-secrets");
  mkdirSync(cfgDir, { recursive: true });
  writeFileSync(join(cfgDir, "memory.json"), JSON.stringify({ userKey: "k" }));
  writeFileSync(settingsPath, JSON.stringify({ env: { ANTHROPIC_BASE_URL: "https://api.anthropic.com" } }));
  const warns = [];
  let out = applyMainMemory(settingsPath, { mainMemoryFlags: { enabled: true, replaceProvider: false }, repoRoot: dir, dryRun: false, log: () => {}, warn: (m) => warns.push(m) });
  assert.equal(out.refused, true);
  assert.ok(warns.some((m) => /--replace-provider/.test(m)));
  assert.equal(JSON.parse(readFileSync(settingsPath, "utf8")).env.ANTHROPIC_BASE_URL, "https://api.anthropic.com", "settings untouched on refusal");
  const changes = [];
  out = applyMainMemory(settingsPath, { mainMemoryFlags: { enabled: true, replaceProvider: true }, repoRoot: dir, dryRun: false, log: (m) => changes.push(m), warn: () => {} });
  assert.equal(out.applied, true);
  assert.equal(JSON.parse(readFileSync(settingsPath, "utf8")).env.ANTHROPIC_BASE_URL.startsWith("http://127.0.0.1:8096"), true);
  assert.ok(changes.some((m) => /replaced per consent/.test(m)));
});

test("applyMainMemory: no memory config or no scoped key degrades with instructions", () => {
  const dir = mkdtempSync(join(tmpdir(), "cc-main3-"));
  const settingsPath = join(dir, "settings.json");
  const logs = [];
  const out = applyMainMemory(settingsPath, { mainMemoryFlags: { enabled: true }, repoRoot: dir, dryRun: false, log: (m) => logs.push(m), warn: () => {} });
  assert.equal(out.skipped, true);
  assert.ok(logs.some((m) => /provision-secrets|business-user key/.test(m)));
});

test("--no-main-memory keeps hooks but leaves proxy routing untouched", () => {
  const dir = mkdtempSync(join(tmpdir(), "cc-main4-"));
  const settingsPath = join(dir, "settings.json");
  writeFileSync(settingsPath, JSON.stringify({ env: { ANTHROPIC_BASE_URL: "https://existing.example" } }));
  const out = applyMainMemory(settingsPath, { mainMemoryFlags: { enabled: false }, repoRoot: dir, dryRun: false, log: () => {}, warn: () => {} });
  assert.equal(out.skipped, true);
  assert.equal(JSON.parse(readFileSync(settingsPath, "utf8")).env.ANTHROPIC_BASE_URL, "https://existing.example");
});

test("state record round-trip and uninstall file plan", () => {
  const dir = mkdtempSync(join(tmpdir(), "cc-state-"));
  const stateFile = join(dir, "state.json");
  const agentsDir = mkdtempSync(join(tmpdir(), "cc-agents-"));
  writeFileSync(join(agentsDir, "singularity-thinker.md"), "x");
  writeFileSync(join(agentsDir, "singularity-board.md"), "x");
  saveInstallRecord({ installedAt: "now", scope: "user", settingsPath: "/s", agentsDir, hooksScript: HOOK_SCRIPT, envWritten: {}, mcp: null, profileLedger: "/l" }, stateFile);
  const state = readState(stateFile);
  assert.equal(state.installs.length, 1);
  const plan = uninstallFilesForRecord(state.installs[0]);
  assert.equal(plan.length, 2, "only our agent names are planned for removal");
  // a foreign agent file in the same directory is never touched
  const foreign = join(agentsDir, "some-users-agent.md");
  assert.ok(!plan.includes(foreign));
});

test("variant matrix: exactly four variants with correct mandatory flags", () => {
  assert.deepEqual(Object.keys(VARIANTS), ["1", "2", "3", "4"]);
  assert.equal(VARIANTS[1].ghost, false);
  assert.equal(VARIANTS[2].ghost && VARIANTS[2].office && VARIANTS[2].ghostBackend, "claude-code");
  assert.equal(VARIANTS[3].openchamber, true);
  assert.equal(VARIANTS[4].ghost && VARIANTS[4].office && VARIANTS[4].ghostBackend, "openchamber");
});

test("resolveVariant: variant 2 requires Ghost+Office and reports the claude backend", () => {
  const flags = { variant: "2", skipProfiles: false, scope: "user" };
  const res = resolveVariant(flags, {});
  assert.equal(res.ok, true, "the package bundles ghost/office so variant 2 resolves");
  assert.ok(res.notes.some((n) => n.includes("GHOST_BACKEND=claude-code")));

  // A user-modified checkout with the_ghost setup removed must refuse.
  const missing = resolveVariant({ ...flags }, { ghostSetupExists: () => false });
  assert.equal(missing.ok, false);
  assert.ok(missing.problems[0].includes("Ghost is mandatory"));

  const officeMissing = resolveVariant({ ...flags }, { officeComposeExists: () => false });
  assert.equal(officeMissing.ok, false);
  assert.ok(officeMissing.problems[0].includes("Claude Office is mandatory"));
});

test("resolveVariant: variant 3/4 attach to an existing OpenChamber and refuse duplicates", () => {
  const home = mkdtempSync(join(tmpdir(), "variant-home-"));
  const absent = resolveVariant({ variant: "3", skipProfiles: false, scope: "user" }, { home, detectOpenchamber: () => false });
  assert.equal(absent.ok, false);
  assert.match(absent.problems.join(";"), /EXISTING OpenChamber/);
  const present = resolveVariant({ variant: "4", skipProfiles: false, scope: "user" }, { home, detectOpenchamber: () => true });
  assert.equal(present.ok, true);
  assert.ok(present.notes.some((n) => n.includes("reusing the detected existing OpenChamber")));
});

test("resolveVariant: --skip-profiles conflicts with any variant because specialist agents are mandatory", () => {
  const res = resolveVariant({ variant: "1", skipProfiles: true, scope: "user" }, {});
  assert.equal(res.ok, false);
  assert.match(res.problems[0], /mandatory in every variant/);
});
