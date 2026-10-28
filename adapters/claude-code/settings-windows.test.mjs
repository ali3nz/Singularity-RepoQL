import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import {
  ALL_HOOK_KINDS,
  DOC_HOOK_KINDS,
  DOC_HOOK_SCRIPT,
  HOOK_KINDS,
  HOOK_SCRIPT,
  basenameAny,
  ensureMemoryIntegration,
  handlerSpec,
  hookOwnership,
  isSameHookHandler,
  isSingularityHook,
  isSingularityHookCommand,
  removeMemoryIntegration,
  tokenizeShellCommand,
} from "./settings-merge.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const POSIX_SCRIPT = "/opt/singularity/adapters/claude-code/memory-hook.mjs";
// The real Windows shape: Program Files has a space, the user path has none
// here, and every separator is a backslash that a shell form would eat.
const WIN_NODE = "C:\\Program Files\\nodejs\\node.exe";
const WIN_SCRIPT = "C:\\Users\\Ben Smith\\.claude\\singularity\\adapters\\claude-code\\memory-hook.mjs";
const WIN_DOC_SCRIPT = "C:\\Users\\Ben Smith\\.claude\\singularity\\adapters\\claude-code\\doc-hook.mjs";

const handlersOn = (settings, event) =>
  (settings.hooks?.[event] || []).flatMap((g) => (Array.isArray(g?.hooks) ? g.hooks : []));

const ownedHandlers = (settings) =>
  Object.values(settings.hooks || {}).flatMap((groups) =>
    (groups || []).flatMap((g) => (Array.isArray(g?.hooks) ? g.hooks.filter((h) => isSingularityHook(h)) : [])));

test("POSIX output is byte-identical to the previous release (shell form, no args)", () => {
  // Platform is PINNED: the default is the host platform, so an unpinned test
  // would demand shell form from a Windows host that must use exec form.
  const { settings, changed } = ensureMemoryIntegration({}, { scriptPath: POSIX_SCRIPT, env: {}, platform: "linux" });
  assert.equal(changed, true);
  assert.deepEqual(settings.hooks.SubagentStart, [
    { hooks: [{ type: "command", command: `node ${POSIX_SCRIPT} subagent-start` }] },
  ]);
  assert.deepEqual(settings.hooks.SubagentStop, [
    { hooks: [{ type: "command", command: `node ${POSIX_SCRIPT} subagent-stop` }] },
  ]);
  assert.deepEqual(settings.hooks.SessionStart, [
    { hooks: [{ type: "command", command: `node ${POSIX_SCRIPT.replace(/memory-hook\.mjs$/, DOC_HOOK_SCRIPT)} session-start` }] },
  ]);
  for (const handler of ownedHandlers(settings)) {
    assert.equal("args" in handler, false, "POSIX handlers must not gain an args key");
  }
});

test("win32 output is exec form: absolute node.exe + verbatim args (no shell string)", () => {
  const settings = ensureMemoryIntegration({}, {
    scriptPath: WIN_SCRIPT,
    env: {},
    platform: "win32",
    nodePath: WIN_NODE,
  }).settings;

  const memoryStart = handlersOn(settings, "SubagentStart");
  assert.equal(memoryStart.length, 1);
  assert.deepEqual(memoryStart[0], {
    type: "command",
    command: WIN_NODE,
    args: [WIN_SCRIPT, "subagent-start"],
  });
  assert.equal(memoryStart[0].command.includes("memory-hook"), false, "command is the executable only");
  assert.equal(memoryStart[0].args[0].includes(" "), true, "spaces live inside an argv element, not a shell word");

  const docStop = handlersOn(settings, "Stop");
  assert.deepEqual(docStop[0], { type: "command", command: WIN_NODE, args: [WIN_DOC_SCRIPT, "stop"] });

  // Serialising and re-reading must not alter a backslash or a space.
  const roundTrip = JSON.parse(JSON.stringify(settings));
  assert.deepEqual(roundTrip, settings);
  assert.equal(handlersOn(roundTrip, "SubagentStart")[0].args[0], WIN_SCRIPT);
});

test("ownership recognises both forms, including quoted shell paths with spaces", () => {
  const exec = { type: "command", command: WIN_NODE, args: [WIN_SCRIPT, "subagent-start"] };
  assert.deepEqual(hookOwnership(exec), { script: HOOK_SCRIPT, kind: "subagent-start", form: "exec" });

  const shell = { type: "command", command: `node ${POSIX_SCRIPT} subagent-stop` };
  assert.deepEqual(hookOwnership(shell), { script: HOOK_SCRIPT, kind: "subagent-stop", form: "shell" });

  const quoted = { type: "command", command: `node "/home/me/My Tools/singularity/doc-hook.mjs" stop` };
  assert.deepEqual(hookOwnership(quoted), { script: DOC_HOOK_SCRIPT, kind: "stop", form: "shell" });

  assert.equal(isSingularityHook(exec), true);
  assert.equal(isSingularityHookCommand(exec.command), false, "the executable path alone is not a hook");

  // A foreign handler that merely mentions our script with an invalid kind is not ours.
  assert.equal(isSingularityHook({ type: "command", command: `node ${POSIX_SCRIPT} session-start` }), false);
  assert.equal(isSingularityHook({ type: "command", command: "node /other/other-hook.mjs subagent-start" }), false);
  // Ownership is by basename (documented): another checkout of OUR hook is still
  // this integration, which is what keeps uninstall after a move reliable.
  assert.equal(isSingularityHook({ type: "command", command: "node /other/memory-hook.mjs subagent-start" }), true);
  // Ownership is interpreter-agnostic: whatever launcher the handler uses, a
  // handler that invokes our script with our kind is ours and must be removable
  // (the previous release behaved the same way).
  assert.equal(isSingularityHook({ type: "command", command: `python3 ${POSIX_SCRIPT} subagent-start` }), true);
  assert.equal(isSingularityHook({ type: "command", command: "echo hi" }), false);
  assert.equal(isSingularityHook(null), false);
});

test("installed-path scope keeps a foreign same-basename hook unowned", () => {
  const foreign = { type: "command", command: `node /other/memory-hook.mjs subagent-start` };
  const ours = { type: "command", command: `node ${POSIX_SCRIPT} subagent-start` };
  // Broad predicate (no installed path) retains the documented legacy behaviour.
  assert.equal(isSingularityHook(foreign), true);
  // With the installed path known, a different file of the same name is foreign.
  assert.equal(isSingularityHook(foreign, { scriptPaths: [POSIX_SCRIPT] }), false);
  assert.equal(isSingularityHook(ours, { scriptPaths: [POSIX_SCRIPT] }), true);

  const foreignExec = { type: "command", command: WIN_NODE, args: ["C:\\Other\\Memory-Hook.mjs", "subagent-start"] };
  assert.equal(isSingularityHook(foreignExec, { scriptPaths: [WIN_SCRIPT] }), false);
});

test("Windows case and quoted executable paths are owned when the installed path matches", () => {
  const upperScript = WIN_SCRIPT.toUpperCase();
  const upperExec = { type: "command", command: `"${WIN_NODE}"`, args: [upperScript, "subagent-start"] };
  assert.deepEqual(hookOwnership(upperExec, { scriptPaths: [WIN_SCRIPT] }), {
    script: HOOK_SCRIPT, kind: "subagent-start", form: "exec",
  });
  const upperShell = { type: "command", command: `node "${upperScript}" subagent-stop` };
  assert.deepEqual(hookOwnership(upperShell, { scriptPaths: [WIN_SCRIPT] }), {
    script: HOOK_SCRIPT, kind: "subagent-stop", form: "shell",
  });
});

test("foreign same-basename handlers survive merge and uninstall; user edits are preserved", () => {
  const user = {
    permissions: { allow: ["Bash(git status)"] },
    hooks: {
      SubagentStart: [{
        matcher: ".*",
        hooks: [
          { type: "command", command: "node /other/memory-hook.mjs subagent-start" },
          { type: "command", command: WIN_NODE, args: ["C:\\Other\\Memory-Hook.mjs", "subagent-start", "--user-flag"] },
        ],
      }],
    },
    env: { KEEP_ME: "user-value" },
  };
  const installed = ensureMemoryIntegration(user, {
    scriptPath: WIN_SCRIPT,
    env: { SINGULARITY_REPO_ROOT: "C:\\work" },
    platform: "win32",
    nodePath: WIN_NODE,
  }).settings;
  // Foreign same-basename handlers (including user args) are untouched; ours
  // is added beside them.
  assert.deepEqual(installed.hooks.SubagentStart[0].hooks.slice(0, 2), user.hooks.SubagentStart[0].hooks);
  assert.equal(installed.hooks.SubagentStart[0].hooks.length, 3);

  // A user edit after install: an extra unrelated hook and env override.
  installed.hooks.UserPromptSubmit = [{ hooks: [{ type: "command", command: "echo after-install" }] }];
  installed.env.KEEP_ME = "edited-after-install";

  const removed = removeMemoryIntegration(installed, {
    scriptPath: WIN_SCRIPT,
    env: { SINGULARITY_REPO_ROOT: "C:\\work" },
  });
  assert.deepEqual(removed.settings.hooks.SubagentStart, user.hooks.SubagentStart, "foreign handler restored, not deleted");
  assert.deepEqual(removed.settings.hooks.UserPromptSubmit, [{ hooks: [{ type: "command", command: "echo after-install" }] }]);
  assert.equal(removed.settings.env.KEEP_ME, "edited-after-install");
  assert.equal(removed.settings.env.SINGULARITY_REPO_ROOT, undefined);
  assert.deepEqual(removed.settings.permissions, user.permissions);
});

test("rollback after a POSIX→exec upgrade restores the prior settings, then the POSIX form is repeatable", () => {
  const before = {
    permissions: { allow: ["Bash(git status)"] },
    hooks: { SessionStart: [{ hooks: [{ type: "command", command: "node /other/session.mjs" }] }] },
    env: { KEEP_ME: "1" },
  };
  const posix = ensureMemoryIntegration(before, {
    scriptPath: POSIX_SCRIPT, env: { SINGULARITY_REPO_ROOT: "/work" }, platform: "linux",
  }).settings;
  const upgraded = ensureMemoryIntegration(posix, {
    scriptPath: WIN_SCRIPT, env: { SINGULARITY_REPO_ROOT: "C:\\work" },
    platform: "win32", nodePath: WIN_NODE, previousScriptPaths: [POSIX_SCRIPT],
  }).settings;
  // The recorded legacy path is what the upgrade replaces; its env value is
  // still what the install wrote, so rollback removes it.
  const rolledBack = removeMemoryIntegration(upgraded, {
    scriptPath: WIN_SCRIPT, env: { SINGULARITY_REPO_ROOT: "/work" },
  }).settings;
  assert.deepEqual(rolledBack, before, "rollback restores the exact pre-upgrade settings");

  const reestablished = ensureMemoryIntegration(rolledBack, {
    scriptPath: POSIX_SCRIPT, env: { SINGULARITY_REPO_ROOT: "/work" }, platform: "linux",
  }).settings;
  assert.deepEqual(reestablished, posix, "the previous integration form is reproducible");
});

test("tokenizer keeps quoted paths whole and both separators", () => {
  assert.deepEqual(tokenizeShellCommand(`node "${WIN_SCRIPT}" subagent-start`), ["node", WIN_SCRIPT, "subagent-start"]);
  assert.deepEqual(tokenizeShellCommand("node  /a/b.mjs\tstop"), ["node", "/a/b.mjs", "stop"]);
  assert.equal(basenameAny(WIN_SCRIPT), "memory-hook.mjs");
  assert.equal(basenameAny("/a/b/memory-hook.mjs"), "memory-hook.mjs");
});

test("win32 merge is idempotent (second run changes nothing)", () => {
  const first = ensureMemoryIntegration({ hooks: {} }, {
    scriptPath: WIN_SCRIPT, env: {}, platform: "win32", nodePath: WIN_NODE,
  });
  const second = ensureMemoryIntegration(first.settings, {
    scriptPath: WIN_SCRIPT, env: {}, platform: "win32", nodePath: WIN_NODE,
  });
  assert.equal(second.changed, false);
  assert.deepEqual(second.settings, first.settings);
  assert.equal(ownedHandlers(second.settings).length, 4, "exactly one handler per hook kind");
});

test("a POSIX install is UPGRADED in place to exec form on win32 (no duplicate, no broken command)", () => {
  const posix = ensureMemoryIntegration({ hooks: { SessionStart: [{ hooks: [{ type: "command", command: "node /other/session.mjs" }] }] } }, {
    scriptPath: POSIX_SCRIPT, env: {}, platform: "linux",
  }).settings;
  const groupBefore = posix.hooks.SessionStart.length;

  const upgraded = ensureMemoryIntegration(posix, {
    scriptPath: WIN_SCRIPT, env: {}, platform: "win32", nodePath: WIN_NODE,
    previousScriptPaths: [POSIX_SCRIPT],
  }).settings;

  assert.equal(upgraded.hooks.SessionStart.length, groupBefore, "no extra group is created");
  assert.equal(upgraded.hooks.SessionStart[0].hooks[0].command, "node /other/session.mjs", "foreign handler untouched");
  const replaced = upgraded.hooks.SessionStart[0].hooks[1];
  assert.deepEqual(replaced, { type: "command", command: WIN_NODE, args: [WIN_DOC_SCRIPT, "session-start"] });
  assert.equal(upgraded.hooks.SubagentStart[0].hooks[0].command, WIN_NODE);
  assert.equal(JSON.stringify(upgraded).includes(`node ${POSIX_SCRIPT}`), false, "no legacy shell command survives");
  assert.equal(ownedHandlers(upgraded).length, 4);
});

test("uninstall removes BOTH forms and keeps everything it does not own", () => {
  const user = {
    permissions: { allow: ["Bash(git status)"] },
    hooks: {
      SessionStart: [{ hooks: [{ type: "command", command: "node /other/session.mjs" }] }],
    },
    env: { KEEP_ME: "1" },
  };
  const env = { SINGULARITY_REPO_ROOT: "C:\\work", SINGULARITY_MEMORY_CONFIG: "C:\\work\\memory.json" };
  // A legacy POSIX handler of ours survives as an owned handler until removed.
  const legacy = {
    ...user,
    hooks: {
      ...user.hooks,
      SubagentStart: [{ hooks: [{ type: "command", command: `node ${POSIX_SCRIPT} subagent-start` }] }],
    },
  };
  const installed = ensureMemoryIntegration(legacy, {
    scriptPath: WIN_SCRIPT, env, platform: "win32", nodePath: WIN_NODE,
    previousScriptPaths: [POSIX_SCRIPT],
  }).settings;
  assert.equal(ownedHandlers(installed).length, 4, "legacy handler replaced, not duplicated");
  assert.equal(installed.hooks.SubagentStart[0].hooks[0].command, WIN_NODE);

  const removed = removeMemoryIntegration(installed, { scriptPath: WIN_SCRIPT, env });
  assert.equal(removed.changed, true);
  assert.deepEqual(removed.removedEnvKeys.sort(), Object.keys(env).sort());
  assert.deepEqual(removed.settings, user, "user settings, foreign hook and env restored exactly");
  assert.equal(ownedHandlers(removed.settings).length, 0);
});

test("uninstall removes an exec-form handler merged by an earlier Windows install", () => {
  const installed = ensureMemoryIntegration({}, {
    scriptPath: WIN_SCRIPT, env: {}, platform: "win32", nodePath: WIN_NODE,
  }).settings;
  const removed = removeMemoryIntegration(installed, { scriptPath: WIN_SCRIPT, env: {} });
  assert.deepEqual(removed.settings, {});
});

test("merge attaches to an existing matcher group and preserves its matcher", () => {
  const settings = {
    hooks: { SubagentStart: [{ matcher: ".*", hooks: [{ type: "command", command: "echo user" }] }] },
  };
  const merged = ensureMemoryIntegration(settings, {
    scriptPath: WIN_SCRIPT, env: {}, platform: "win32", nodePath: WIN_NODE,
  }).settings;
  assert.equal(merged.hooks.SubagentStart.length, 1);
  assert.equal(merged.hooks.SubagentStart[0].matcher, ".*");
  assert.deepEqual(merged.hooks.SubagentStart[0].hooks[0], { type: "command", command: "echo user" });
  assert.equal(merged.hooks.SubagentStart[0].hooks[1].command, WIN_NODE);
});

test("handlerSpec defaults to the host platform and keeps POSIX form there", () => {
  const spec = handlerSpec("/x/memory-hook.mjs", "subagent-start", { platform: "linux" });
  assert.deepEqual(spec, { type: "command", command: "node /x/memory-hook.mjs subagent-start" });
  assert.equal(isSameHookHandler(spec, { type: "command", command: "node /x/memory-hook.mjs subagent-start" }), true);
  assert.equal(isSameHookHandler(spec, { type: "command", command: "node /x/memory-hook.mjs subagent-start", args: [] }), false);
});

test("exported kind lists stay aligned with the scripts they belong to", () => {
  assert.deepEqual(HOOK_KINDS, ["subagent-start", "subagent-stop"]);
  assert.deepEqual(DOC_HOOK_KINDS, ["session-start", "stop"]);
  assert.equal(new Set(ALL_HOOK_KINDS).size, 4);
});

test("settings-snippet template is placeholder-based exec form (no /path/to, no shell string)", () => {
  const snippet = JSON.parse(readFileSync(join(HERE, "settings-snippet.json"), "utf8"));
  const text = JSON.stringify(snippet);
  assert.equal(text.includes("/path/to"), false);
  assert.equal(text.includes("node /"), false);
  assert.match(snippet._comment, /EXEC FORM/);
  const events = Object.keys(snippet.hooks);
  assert.deepEqual(events.sort(), ["PostToolUse", "PreToolUse", "SessionEnd", "SessionStart", "Stop", "SubagentStop", "UserPromptSubmit"]);
  const kinds = [];
  for (const event of events) {
    for (const group of snippet.hooks[event]) {
      for (const handler of group.hooks) {
        assert.equal(handler.type, "command");
        assert.equal(handler.command, "{{NODE_EXE}}", `${event} uses the node placeholder`);
        assert.equal(Array.isArray(handler.args), true);
        assert.equal(handler.args.length, 2);
        assert.equal(handler.args[0], "{{OFFICE_HOOK}}");
        kinds.push(handler.args[1]);
      }
    }
  }
  assert.deepEqual(kinds.sort(), ["post-tool", "pre-tool", "prompt", "session-end", "session-start", "stop", "subagent-stop"]);
});
