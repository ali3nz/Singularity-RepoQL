// Task prompt store reader.
//
// The control service owns the store; runners only read. A missing file means
// "use the in-code default", so a wiped or unreadable store can never stop a
// scheduled run. A file that exists is authoritative and is rendered here:
// {{name}} placeholders are replaced from vars, and an unknown placeholder is a
// loud error (save-time validation should make that unreachable).
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

export const PROMPT_ROOT = process.env.GHOST_PROMPT_DIR || '/var/lib/ghost-control/prompts';
const PLACEHOLDER = /{{\s*([A-Za-z0-9_]+)\s*}}/g;

export function renderTaskPrompt(text, vars = {}) {
  return String(text).replace(PLACEHOLDER, (whole, name) => {
    if (!Object.prototype.hasOwnProperty.call(vars, name)) {
      throw new Error(`task-prompts: unknown placeholder ${whole.trim()} in prompt template`);
    }
    return String(vars[name]);
  });
}

export function readTaskPromptRaw(task, entry, { root = PROMPT_ROOT } = {}) {
  try {
    return readFileSync(join(root, task, `${entry}.md`), 'utf8');
  } catch (error) {
    if (error.code === 'ENOENT') return null;
    throw error;
  }
}

export function loadTaskPrompt(task, entry, vars = {}, fallback = null, { root = PROMPT_ROOT } = {}) {
  const raw = readTaskPromptRaw(task, entry, { root });
  if (raw === null) {
    if (fallback === null || fallback === undefined) {
      throw new Error(`task-prompts: no ${task}/${entry} prompt file and no in-code default`);
    }
    const template = typeof fallback === 'function' ? fallback() : String(fallback);
    return { text: renderTaskPrompt(template, vars), source: 'default', path: null };
  }
  return { text: renderTaskPrompt(raw, vars), source: 'file', path: join(root, task, `${entry}.md`) };
}
