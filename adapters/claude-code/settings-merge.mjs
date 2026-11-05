// settings-merge.mjs — pure, tested helpers that merge the Singularity Claude
// Code integration into a Claude Code settings.json WITHOUT touching unrelated
// settings. The installer and uninstaller in scripts/install-claude-code.mjs
// call these; they never delete entries they do not own.
//
// Ownership rule: a hook handler belongs to this integration when it invokes one
// of our hook scripts with one of our kinds. When the caller knows the installed
// path (install/uninstall always do) the SCRIPT PATH must match too, so another
// tool's `memory-hook.mjs` is never claimed or deleted. Two handler FORMS are
// supported and both are owned/removable:
//
//   exec form (Windows, and the documented Claude Code way to avoid shells):
//     { "type": "command", "command": "C:\\Program Files\\nodejs\\node.exe",
//       "args": ["C:\\Users\\Me\\.claude\\singularity\\memory-hook.mjs", "subagent-start"] }
//   shell form (the POSIX install, unchanged since the first release):
//     { "type": "command", "command": "node /opt/.../memory-hook.mjs subagent-start" }
//
// Exec form is not a preference on Windows, it is the only reliable form: the
// shell form is run through Git Bash or PowerShell, `node` need not be on the
// GUI app's PATH, and an unquoted `C:\Users\...` loses its backslashes to the
// shell. `args` is passed verbatim with no shell involved, so paths containing
// spaces and backslashes are safe.
import { join } from "node:path";

export const HOOK_SCRIPT = "memory-hook.mjs";
export const HOOK_KINDS = ["subagent-start", "subagent-stop"];
export const HOOK_EVENTS = ["SubagentStart", "SubagentStop"];
// The documentation hooks live in doc-hook.mjs and cover SessionStart (guidance)
// and Stop (closeout check) — an extension of the SAME integration, never a
// second installation.
export const DOC_HOOK_SCRIPT = "doc-hook.mjs";
export const DOC_HOOK_KINDS = ["session-start", "stop"];
export const DOC_HOOK_EVENTS = ["SessionStart", "Stop"];
// The parent conversation is captured by the SAME memory hook on Stop and
// SessionEnd. These kinds belong to memory-hook.mjs but are opt-in: only the
// native Complete installer binds them, so the POSIX installer's hook set (and
// its verification contract) is unchanged.
export const PARENT_HOOK_KINDS = ["conversation-turn", "session-end"];
export const PARENT_HOOK_EVENTS = ["Stop", "SessionEnd"];
export const HOOK_SCRIPTS = [HOOK_SCRIPT, DOC_HOOK_SCRIPT];
export const ALL_HOOK_KINDS = [...HOOK_KINDS, ...DOC_HOOK_KINDS];
export const ALL_HOOK_EVENTS = [...HOOK_EVENTS, ...DOC_HOOK_EVENTS];
export const MEMORY_ENV_KEYS = ["SINGULARITY_REPO_ROOT", "SINGULARITY_MEMORY_CONFIG"];

const KINDS_BY_SCRIPT = new Map([
  [HOOK_SCRIPT, new Set([...HOOK_KINDS, ...PARENT_HOOK_KINDS])],
  [DOC_HOOK_SCRIPT, new Set(DOC_HOOK_KINDS)],
]);

// A node-family basename: the exec form must name a real executable, and
// `.cmd`/`.bat` shims cannot be spawned by the exec form on Windows.
const NODE_BASENAMES = new Set(["node", "node.exe"]);

/** Basename that works for both separators, regardless of the host platform. */
export function basenameAny(value) {
  let text = String(value ?? "").trim();
  // A quoted executable (a Windows path with spaces) is still one executable.
  if ((text.startsWith('"') && text.endsWith('"')) || (text.startsWith("'") && text.endsWith("'"))) {
    text = text.slice(1, -1);
  }
  const cut = Math.max(text.lastIndexOf("/"), text.lastIndexOf("\\"));
  return cut >= 0 ? text.slice(cut + 1) : text;
}

// Windows paths are case-insensitive and may use either separator. Ownership
// compares normalised paths only when the caller supplies the installed path.
function normalisePath(value) {
  return String(value ?? "").trim().replace(/\\/g, "/").replace(/\/{2,}/g, "/").replace(/\/$/, "").toLowerCase();
}

function ownsInstalledPath(scriptValue, opts) {
  const allowed = opts?.scriptPaths ?? (opts?.scriptPath ? [opts.scriptPath] : null);
  if (!allowed) return true;
  const candidate = normalisePath(scriptValue);
  return allowed.some((p) => normalisePath(p) === candidate);
}

/**
 * The memory hook and the doc hook beside it. `previousScriptPaths` are the
 * install paths recorded by an earlier release (a POSIX install upgraded to
 * the native Windows form); only callers that hold that ledger proof supply
 * them, so an unrelated same-named hook is never claimed.
 */
function installedScope(scriptPath, previousScriptPaths = []) {
  const paths = [scriptPath, ...(Array.isArray(previousScriptPaths) ? previousScriptPaths : [])];
  return {
    scriptPaths: paths.flatMap((p) => [String(p), String(p).replace(/memory-hook\.mjs$/i, DOC_HOOK_SCRIPT)]),
  };
}

/**
 * Split a shell-form command into tokens, honouring single and double quotes.
 * Without this a quoted Windows path (`node "C:\Program Files\...\hook.mjs"`)
 * becomes three tokens and ownership detection silently fails.
 */
export function tokenizeShellCommand(command) {
  const text = String(command ?? "").trim();
  if (!text) return [];
  const tokens = [];
  let current = "";
  let quote = null;
  for (const ch of text) {
    if (quote) {
      if (ch === quote) quote = null;
      else current += ch;
      continue;
    }
    if (ch === '"' || ch === "'") {
      quote = ch;
      continue;
    }
    if (/\s/.test(ch)) {
      if (current) {
        tokens.push(current);
        current = "";
      }
      continue;
    }
    current += ch;
  }
  if (current) tokens.push(current);
  return tokens;
}

/**
 * Identify a handler as ours.
 * Returns { script, kind, form } or null. Never guesses: a handler whose kind
 * token does not belong to the matched script is foreign (that is how
 * `memory-hook.mjs stop` stays someone else's business).
 */
export function hookOwnership(handler, opts = {}) {
  if (!handler || typeof handler !== "object") return null;
  const args = Array.isArray(handler.args) ? handler.args.map((a) => String(a)) : null;

  if (args && args.length) {
    const commandBase = basenameAny(handler.command).toLowerCase();
    if (!NODE_BASENAMES.has(commandBase)) return null;
    for (let i = 0; i < args.length; i++) {
      const script = basenameAny(args[i]).toLowerCase();
      const kinds = KINDS_BY_SCRIPT.get(script);
      if (!kinds || !ownsInstalledPath(args[i], opts)) continue;
      for (let j = i + 1; j < args.length; j++) {
        if (kinds.has(args[j])) return { script, kind: args[j], form: "exec" };
      }
    }
    return null;
  }

  const tokens = tokenizeShellCommand(handler.command);
  for (let i = 0; i < tokens.length; i++) {
    const script = basenameAny(tokens[i]).toLowerCase();
    const kinds = KINDS_BY_SCRIPT.get(script);
    if (!kinds || !ownsInstalledPath(tokens[i], opts)) continue;
    for (let j = i + 1; j < tokens.length; j++) {
      if (kinds.has(tokens[j])) return { script, kind: tokens[j], form: "shell" };
    }
  }
  return null;
}

/** Backwards-compatible string predicate (shell-form commands and nothing else). */
export function isSingularityHookCommand(command) {
  return hookOwnership({ command }) !== null;
}

/** Handler-object predicate used by merge/remove: owns exec form as well. */
export function isSingularityHook(handler, opts = {}) {
  return hookOwnership(handler, opts) !== null;
}

function sameArgs(a, b) {
  return JSON.stringify(a ?? null) === JSON.stringify(b ?? null);
}

/** Structural equality of two command handlers (args absent !== args []). */
export function isSameHookHandler(a, b) {
  return a?.type === "command" && b?.type === "command" && a.command === b.command && sameArgs(a.args, b.args);
}

/**
 * The handler we write for (script, kind).
 *
 * opts.platform / opts.nodePath are injectable so both forms are testable on
 * any host. POSIX output is byte-identical to every previous release; win32
 * output is the exec form with an absolute node executable.
 */
export function handlerSpec(scriptPath, kind, { platform = process.platform, nodePath = process.execPath } = {}) {
  if (String(platform) === "win32") {
    const exe = String(nodePath || "").trim() || "node.exe";
    return { type: "command", command: exe, args: [String(scriptPath), kind] };
  }
  return { type: "command", command: `node ${scriptPath} ${kind}` };
}

/** The handler we want for a (script, kind) pair, plus what it supersedes. */
function desiredHandlers(scriptPath, docScriptPath, opts) {
  const handlers = [
    { event: HOOK_EVENTS[0], kind: HOOK_KINDS[0], spec: handlerSpec(scriptPath, HOOK_KINDS[0], opts) },
    { event: HOOK_EVENTS[1], kind: HOOK_KINDS[1], spec: handlerSpec(scriptPath, HOOK_KINDS[1], opts) },
    { event: DOC_HOOK_EVENTS[0], kind: DOC_HOOK_KINDS[0], spec: handlerSpec(docScriptPath, DOC_HOOK_KINDS[0], opts) },
    { event: DOC_HOOK_EVENTS[1], kind: DOC_HOOK_KINDS[1], spec: handlerSpec(docScriptPath, DOC_HOOK_KINDS[1], opts) },
  ];
  if (opts.parentConversation === true) {
    handlers.push({ event: "Stop", kind: "conversation-turn", spec: handlerSpec(scriptPath, "conversation-turn", opts) });
    handlers.push({ event: "SessionEnd", kind: "session-end", spec: handlerSpec(scriptPath, "session-end", opts) });
  }
  return handlers;
}

/**
 * Ensure exactly ONE handler per Singularity hook kind (memory subagent hooks
 * and documentation hooks) exists on its event, and ensure the integration's
 * env keys are set. Second handler script (doc hook) is placed on the SAME
 * pre-existing group as the memory hook so owner grouping stays intact.
 * Existing non-empty env values are preserved (a user override wins).
 * With opts.parentConversation, the same memory hook is additionally bound to
 * Stop (conversation-turn) and SessionEnd (session-end) for parent capture.
 *
 * Upgrade behaviour: an OWNED handler of the same script+kind written in the
 * other form is REPLACED in place (that is how a legacy POSIX shell command is
 * converted to exec form on Windows instead of sitting beside a broken one).
 * Duplicate owned handlers of the same kind collapse to the first.
 *
 * Returns { settings: <new Settings>, changed: boolean }.
 */
export function ensureMemoryIntegration(input, opts) {
  const { scriptPath, env = {} } = opts;
  const platform = opts.platform ?? process.platform;
  const nodePath = opts.nodePath ?? process.execPath;
  // The doc hook lives beside the memory hook; both are this integration.
  const docScriptPath = String(scriptPath).replace(/memory-hook\.mjs$/i, DOC_HOOK_SCRIPT);
  const ownedPaths = installedScope(scriptPath, opts.previousScriptPaths);
  const settings = structuredClone(input) || {};
  settings.hooks = (settings.hooks && typeof settings.hooks === "object") ? settings.hooks : {};
  let changed = false;

  for (const { event, spec } of desiredHandlers(scriptPath, docScriptPath, {
    platform, nodePath, parentConversation: opts.parentConversation,
  })) {
    const groups = Array.isArray(settings.hooks[event]) ? settings.hooks[event] : [];
    const wanted = hookOwnership(spec);

    // Idempotent: the exact handler is already present.
    const already = groups.some((g) =>
      Array.isArray(g?.hooks) && g.hooks.some((h) => isSameHookHandler(h, spec)));
    if (already) continue;

    // Replace an owned handler of the same script+kind (legacy form), in place.
    let replaced = false;
    for (const g of groups) {
      if (!Array.isArray(g?.hooks)) continue;
      const index = g.hooks.findIndex((h) => {
        const owned = hookOwnership(h, ownedPaths);
        return owned && owned.script === wanted.script && owned.kind === wanted.kind;
      });
      if (index >= 0) {
        g.hooks[index] = spec;
        replaced = true;
        changed = true;
        break;
      }
    }
    if (replaced) continue;

    // Attach ONLY to a matcher-free group: a foreign matcher would suppress
    // SessionStart/Stop or subagent events and silently disable our hooks.
    let placed = false;
    for (const g of groups) {
      if (Array.isArray(g?.hooks) && g.matcher === undefined && !isSingularityHookPresent(g, ownedPaths)) {
        g.hooks.push(spec);
        placed = true;
        break;
      }
    }
    if (!placed) {
      const next = groups.slice();
      next.push({ hooks: [spec] });
      settings.hooks[event] = next;
    }
    changed = true;
  }

  // Only create an env object when we actually have a value to add: an
  // uninstall must not leave an empty env:{} behind.
  for (const [key, value] of Object.entries(env)) {
    if (value === undefined || value === "") continue;
    settings.env = (settings.env && typeof settings.env === "object") ? settings.env : {};
    if (settings.env[key]) continue;
    settings.env[key] = value;
    changed = true;
  }

  return { settings, changed };
}

function isSingularityHookPresent(group, opts) {
  return Array.isArray(group?.hooks) && group.hooks.some((h) => isSingularityHook(h, opts));
}

/**
 * Remove this integration's hook handlers and (only when their value still
 * matches what the installer wrote) its env keys. Everything else is kept.
 * Both handler forms are removed: a Windows install upgraded over a POSIX one
 * (or the reverse) leaves no orphaned command behind.
 * Returns { settings, changed, removedEnvKeys }.
 */
export function removeMemoryIntegration(input, opts) {
  const { scriptPath, env = {} } = opts;
  const ownedPaths = installedScope(scriptPath, opts.previousScriptPaths);
  const settings = structuredClone(input) || {};
  let changed = false;
  let hooksChanged = false;

  if (settings.hooks && typeof settings.hooks === "object") {
    for (const event of new Set([...ALL_HOOK_EVENTS, ...PARENT_HOOK_EVENTS])) {
      const groups = settings.hooks[event];
      if (!Array.isArray(groups)) continue;
      const next = [];
      let eventChanged = false;
      for (const g of groups) {
        if (g && Array.isArray(g.hooks)) {
          const kept = g.hooks.filter((h) => !isSingularityHook(h, ownedPaths));
          if (kept.length !== g.hooks.length) eventChanged = true;
          if (kept.length) next.push({ ...g, hooks: kept });
        } else {
          next.push(g);
        }
      }
      if (eventChanged) {
        hooksChanged = true;
        if (next.length) settings.hooks[event] = next;
        else delete settings.hooks[event];
      }
    }
    // An uninstall that emptied the hooks map must not leave hooks:{} behind.
    if (hooksChanged && Object.keys(settings.hooks).length === 0) delete settings.hooks;
  }

  const removedEnvKeys = [];
  if (settings.env && typeof settings.env === "object") {
    for (const [key, value] of Object.entries(env)) {
      if (key in settings.env && settings.env[key] === value) {
        delete settings.env[key];
        removedEnvKeys.push(key);
        changed = true;
      }
    }
    if (removedEnvKeys.length && Object.keys(settings.env).length === 0) delete settings.env;
  }

  return { settings, changed: changed || hooksChanged, removedEnvKeys };
}

export function settingsPathFor(scope, home, projectDir) {
  if (scope === "project") return join(projectDir, ".claude", "settings.json");
  return join(home, ".claude", "settings.json");
}
