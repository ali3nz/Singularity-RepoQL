// settings-merge.mjs — pure, tested helpers that merge the Singularity Claude
// Code integration into a Claude Code settings.json WITHOUT touching unrelated
// settings. The installer and uninstaller in scripts/install-claude-code.mjs
// call these; they never delete entries they do not own.
//
// Ownership rule: a hook handler belongs to this integration when its command
// contains the integration marker (an absolute path to memory-hook.mjs) AND its
// third argv element is one of our kinds. Anything else is preserved verbatim,
// including other hooks on the same events.

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
export const HOOK_SCRIPTS = [HOOK_SCRIPT, DOC_HOOK_SCRIPT];
export const ALL_HOOK_KINDS = [...HOOK_KINDS, ...DOC_HOOK_KINDS];
export const ALL_HOOK_EVENTS = [...HOOK_EVENTS, ...DOC_HOOK_EVENTS];
export const MEMORY_ENV_KEYS = ["SINGULARITY_REPO_ROOT", "SINGULARITY_MEMORY_CONFIG"];

const KINDS_BY_SCRIPT = new Map([
  [HOOK_SCRIPT, new Set(HOOK_KINDS)],
  [DOC_HOOK_SCRIPT, new Set(DOC_HOOK_KINDS)],
]);

export function isSingularityHookCommand(command) {
  if (typeof command !== "string") return false;
  const parts = command.trim().split(/\s+/);
  for (const [script, kinds] of KINDS_BY_SCRIPT) {
    if (parts.some((p) => p.endsWith(script)) && parts.some((p) => kinds.has(p))) return true;
  }
  return false;
}

function handlerCommand(scriptPath, kind) {
  return `node ${scriptPath} ${kind}`;
}

/**
 * Ensure exactly ONE handler per Singularity hook kind (memory subagent hooks
 * and documentation hooks) exists on its event, and ensure the integration's
 * env keys are set. Second handler script (doc hook) is placed on the SAME
 * pre-existing group as the memory hook so owner grouping stays intact.
 * Existing non-empty env values are preserved (a user override wins).
 * Returns { settings: <new Settings>, changed: boolean }.
 */
export function ensureMemoryIntegration(input, opts) {
  const { scriptPath, env = {} } = opts;
  // The doc hook lives beside the memory hook; both are this integration.
  const docScriptPath = String(scriptPath).replace(/memory-hook\.mjs$/, DOC_HOOK_SCRIPT);
  const settings = structuredClone(input) || {};
  settings.hooks = (settings.hooks && typeof settings.hooks === "object") ? settings.hooks : {};
  let changed = false;

  for (let i = 0; i < HOOK_EVENTS.length; i++) {
    const kind = HOOK_KINDS[i];
    const event = HOOK_EVENTS[i];
    const wanted = handlerCommand(scriptPath, kind);
    const groups = Array.isArray(settings.hooks[event]) ? settings.hooks[event] : [];

    const already = groups.some(g =>
      Array.isArray(g?.hooks) && g.hooks.some(h => h?.command === wanted));
    if (already) continue;

    // Attach to an existing matcher group (we do not use matchers; ANY group works).
    let placed = false;
    for (const g of groups) {
      if (Array.isArray(g?.hooks) && !isSingularityHookPresent(g)) {
        g.hooks.push({ type: "command", command: wanted });
        placed = true;
        break;
      }
    }
    if (!placed) {
      const next = groups.slice();
      next.push({ hooks: [{ type: "command", command: wanted }] });
      settings.hooks[event] = next;
    }
    changed = true;
  }

  // Doc hooks: SessionStart guidance + Stop closeout check.
  for (let i = 0; i < DOC_HOOK_EVENTS.length; i++) {
    const kind = DOC_HOOK_KINDS[i];
    const event = DOC_HOOK_EVENTS[i];
    const wanted = handlerCommand(docScriptPath, kind);
    const groups = Array.isArray(settings.hooks[event]) ? settings.hooks[event] : [];

    const already = groups.some(g =>
      Array.isArray(g?.hooks) && g.hooks.some(h => h?.command === wanted));
    if (already) continue;

    let placed = false;
    for (const g of groups) {
      if (Array.isArray(g?.hooks) && !isSingularityHookPresent(g)) {
        g.hooks.push({ type: "command", command: wanted });
        placed = true;
        break;
      }
    }
    if (!placed) {
      const next = groups.slice();
      next.push({ hooks: [{ type: "command", command: wanted }] });
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

function isSingularityHookPresent(group) {
  return Array.isArray(group?.hooks) && group.hooks.some(h => isSingularityHookCommand(h?.command));
}

/**
 * Remove this integration's hook handlers and (only when their value still
 * matches what the installer wrote) its env keys. Everything else is kept.
 * Returns { settings, changed, removedEnvKeys }.
 */
export function removeMemoryIntegration(input, opts) {
  const { scriptPath, env = {} } = opts;
  const settings = structuredClone(input) || {};
  let changed = false;
  let hooksChanged = false;

  if (settings.hooks && typeof settings.hooks === "object") {
    for (const event of ALL_HOOK_EVENTS) {
      const groups = settings.hooks[event];
      if (!Array.isArray(groups)) continue;
      const next = [];
      let eventChanged = false;
      for (const g of groups) {
        if (g && Array.isArray(g.hooks)) {
          const kept = g.hooks.filter(h => !isSingularityHookCommand(h?.command));
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
