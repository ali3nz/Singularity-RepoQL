// Unit tests for the Claude Code integration installer (pure parts) and the
// settings merge/unmerge helpers. Run:
//   node --test adapters/claude-code/installer.test.mjs
import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
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
  integrationEnv,
  parseFlags,
  planAgentFiles,
  readState,
  saveInstallRecord,
  uninstallFilesForRecord,
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

test("planAgentFiles reports create/present/update; applyAgentFiles is idempotent", () => {
  const source = srcFixture();
  const target = mkdtempSync(join(tmpdir(), "cc-target-"));
  mkdirSync(join(target, ".claude", "agents"), { recursive: true });

  let plan = planAgentFiles(join(target, ".claude", "agents"), source);
  assert.deepEqual(plan.map((f) => f.status), ["create", "create"]);
  applyAgentFiles(plan, { dryRun: false });

  plan = planAgentFiles(join(target, ".claude", "agents"), source);
  assert.deepEqual(plan.map((f) => f.status), ["present", "present"]);
  applyAgentFiles(plan, { dryRun: false }); // second install: nothing rewritten
  assert.equal(readFileSync(join(target, ".claude", "agents", "singularity-thinker.md"), "utf8").includes("reasoning specialist"), true);

  // drift: a locally edited file is refreshed to the shipped definition
  writeFileSync(join(target, ".claude", "agents", "singularity-thinker.md"), "edited locally");
  plan = planAgentFiles(join(target, ".claude", "agents"), source);
  assert.deepEqual(plan.map((f) => f.status), ["present", "update"]);
  applyAgentFiles(plan, { dryRun: false });
  assert.ok(readFileSync(join(target, ".claude", "agents", "singularity-thinker.md"), "utf8").includes("body\n"));
});

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
  const f2 = parseFlags(["--scope", "project", "--project-dir", "/proj"], home, "/proj");
  assert.equal(f2.settingsPath, "/proj/.claude/settings.json");
  assert.equal(f2.agentsTarget, "/proj/.claude/agents");
  const f3 = parseFlags(["--team", "t1", "--user", "u1"], home, "/proj");
  assert.equal(f3.team, "t1");
  assert.equal(f3.user, "u1");
  assert.throws(() => parseFlags(["--bogus"], home, "/proj"), UsageError);
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
