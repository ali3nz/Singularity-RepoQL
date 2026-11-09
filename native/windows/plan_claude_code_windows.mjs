#!/usr/bin/env node
/**
 * Read-only, credential-safe Windows Claude Code settings plan for options 1/2.
 * Nothing is installed, modified or launched. This is NOT an installer.
 * A Windows operator must verify Claude Desktop Code-tab/CLI settings scope and
 * import the plan through an approved, backed-up configuration change.
 */
import { readFileSync } from 'node:fs';
import { win32 as path } from 'node:path';
import { ensureMemoryIntegration, hookOwnership } from '../../adapters/claude-code/settings-merge.mjs';
import { AGENT_MAP } from '../../adapters/claude-code/agent-map.mjs';

export function localWindowsPath(value, kind='file') {
  if (typeof value !== 'string' || !/^[a-z]:\\/i.test(value) || value.length > 1024 || /[\x00-\x1f<>"|?*]/.test(value)) throw new Error(`${kind}: expected local absolute drive path`);
  if (value.includes('/') || value.endsWith(' ') || value.endsWith('.') || value.includes('\\\\')) throw new Error(`${kind}: noncanonical path`);
  for (const segment of value.slice(3).split('\\')) {
    if (!segment || segment === '.' || segment === '..' || /[. ]$/.test(segment) || segment.includes(':') || /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(\.|$)/i.test(segment)) throw new Error(`${kind}: unsafe path segment`);
  }
  return value;
}

function settingsObject(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('existing settings must be a JSON object');
  return value;
}

export function buildPlan({ variant, repoRoot, nodeExe, existingSettings = {} }) {
  if (variant !== 1 && variant !== 2) throw new Error('Claude Code preview supports only options 1 and 2');
  const root = localWindowsPath(repoRoot, 'repoRoot');
  const node = localWindowsPath(nodeExe, 'nodeExe');
  if (path.basename(node).toLowerCase() !== 'node.exe') throw new Error('nodeExe must be node.exe');
  const existing = settingsObject(existingSettings);
  const hook = path.join(root, 'adapters', 'claude-code', 'memory-hook.mjs');
  const env = { SINGULARITY_REPO_ROOT: root, SINGULARITY_MEMORY_CONFIG: path.join(root, 'data', 'opencode', 'config', 'product-secrets', 'memory.json') };
  const result = ensureMemoryIntegration(existing, { scriptPath: hook, env, platform: 'win32', nodePath: node });
  const ownedScriptPaths = [hook, path.join(root, 'adapters','claude-code','doc-hook.mjs')];
  const managedHooks = [];
  for (const event of ['SubagentStart','SubagentStop','SessionStart','Stop']) {
    for (const group of result.settings.hooks?.[event] ?? []) {
      for (const spec of Array.isArray(group?.hooks) ? group.hooks : []) {
        const owned = hookOwnership(spec, {scriptPaths:ownedScriptPaths});
        if (owned) managedHooks.push({ event, command:spec.command, args:spec.args, kind:owned.kind });
      }
    }
  }
  if (managedHooks.length !== 4 || managedHooks.some(h => h.command !== node || !Array.isArray(h.args))) throw new Error('expected four direct-exec Singularity hooks');
  return {
    schema:'singularity-claude-code-native-preview/v1', variant,
    target:'claude-code-cli-and-desktop-code-tab-requires-independent-validation',
    mode:'READ_ONLY_NO_INSTALLATION', releaseReady:false,
    changed:result.changed, agentDefinitions:Object.keys(AGENT_MAP).sort(),
    managedHooks, newEnvironmentPaths:env,
    // This legacy preview covers memory hooks only; it MUST NOT be mistaken
    // for the native Complete installer's Office and RepoQL plugin plan.
    memoryHookPreviewOnly:true, officeEventHooksInPreview:false,
    completeInstaller:'native/windows/configure_claude_code_windows.mjs',
    officeIncludedByVariant:variant===2,
    unverified:[
      'Existing settings and 9 agent definitions have not been installed',
      'This preview does not include Office handlers, skills or RepoQL plugin settings; use the Complete native installer plan',
      'Native Claude Desktop Code-tab hook and MCP acceptance remains untested',
      'Tencent memory.json and live capture/new-session recall are not provisioned or verified',
      ...(variant===2 ? ['Claude Office application runtime is an external pinned fork, not present in this source ZIP'] : []),
      'Do not apply without Windows ACL/symlink checks, backup and explicit operator approval',
    ],
    // Deliberately omit full settings, foreign hook bodies, env values beyond
    // managed paths, and any source file contents; existing settings may hold secrets.
  };
}

function main(argv) {
  let variant, repoRoot, nodeExe, existing;
  for (let i=0;i<argv.length;i++) {
    const opt=argv[i];
    if (!['--variant','--repo-root','--node-exe','--existing-settings'].includes(opt) || i+1>=argv.length) throw new Error('usage: --variant 1|2 --repo-root C:\\... --node-exe C:\\... [--existing-settings local-fixture.json]');
    const val=argv[++i];
    if (opt==='--variant') variant=Number(val);
    if (opt==='--repo-root') repoRoot=val;
    if (opt==='--node-exe') nodeExe=val;
    if (opt==='--existing-settings') existing=val;
  }
  // Existing settings file is read-only. Never print it, even on invalid JSON.
  let settings={};
  if (existing) settings=settingsObject(JSON.parse(readFileSync(existing,'utf8')));
  process.stdout.write(JSON.stringify(buildPlan({variant,repoRoot,nodeExe,existingSettings:settings}),null,2)+'\n');
}
if (process.argv[1] && process.argv[1].replaceAll('\\','/').endsWith('/plan_claude_code_windows.mjs')) {
  try { main(process.argv.slice(2)); } catch(e) { process.stderr.write('CLAUDE_CODE_NATIVE_PLAN_REJECTED: '+e.message+'\n'); process.exitCode=2; }
}
