#!/usr/bin/env node
/**
 * Transactional, narrow-scope Claude Code settings + agent installer for the
 * native Windows *configuration* layer. NEVER provisions Ghost/Office/services.
 * Actual writes are Windows-only and require explicit --apply. All changes are
 * confined to the selected user's .claude directory. A durable journal permits
 * recovery after partial writes; foreign agents are never overwritten.
 */
import {
  existsSync, lstatSync, mkdirSync, readFileSync, writeFileSync, renameSync,
  rmSync, rmdirSync, readdirSync, openSync, closeSync, fsyncSync, copyFileSync, constants,
} from 'node:fs';
import { createHash, createHmac, randomUUID, timingSafeEqual } from 'node:crypto';
import { join, dirname, basename, resolve, relative, sep, win32 } from 'node:path';
import { fileURLToPath } from 'node:url';
import { AGENT_MAP } from '../../adapters/claude-code/agent-map.mjs';
import { ensureMemoryIntegration, removeMemoryIntegration, hookOwnership, PARENT_HOOK_EVENTS, DOC_HOOK_TIMEOUT_SECONDS } from '../../adapters/claude-code/settings-merge.mjs';
// fleet#993: the supported Configure flow reaches the parent-session memory proxy
// through the existing, already-tested adapters helper — no new provider logic.
import { ensureMainMemoryIntegration, removeMainMemoryIntegration, detectProviderConflicts, isMainMemoryOwnConfig, resolveMainProxyUrl } from '../../adapters/claude-code/main-memory.mjs';
import { localWindowsPath } from './plan_claude_code_windows.mjs';

const HASH = b => createHash('sha256').update(b).digest('hex');
const NAMES = Object.keys(AGENT_MAP).sort(); // AGENT_MAP holds only the retained Windows roles; retired roles are not installed
const PINS = fileURLToPath(new URL('./runtime-pins.json', import.meta.url));

/** A hook command is part of the shipped product, not the build machine. Reject
 * the machine-local `C:\Users\<name>\tools\...` Node copies that produced
 * settings which only worked on the operator's desktop. */
export function assertPortableNodePath(nodeExe) {
  if (/^[A-Za-z]:\\Users\\[^\\]+\\tools\\/i.test(win32.normalize(String(nodeExe))))
    fail('HARDCODED_NODE_TOOL_PATH');
}

/** Resolve the Node runtime without any caller-specific absolute path. The
 * pinned bootstrap location wins, then a discovered pinned-version directory,
 * then node.exe from PATH. `runtimeRoot`/`pinsPath` exist for isolated tests. */
export function resolveNodeExe({explicit, localAppData=process.env.LOCALAPPDATA, pathEnv=process.env.PATH, pinsPath=PINS, runtimeRoot}={}) {
  if (explicit) return explicit;
  if (!localAppData) fail('LOCALAPPDATA_REQUIRED');
  const root=runtimeRoot || join(localAppData,'Singularity','runtime');
  const candidates=[];
  try {
    const pins=JSON.parse(readFileSync(pinsPath,'utf8'));
    if(typeof pins?.node?.version==='string' && /^\d+\.\d+\.\d+$/.test(pins.node.version))
      candidates.push(join(root,`node-v${pins.node.version}`,'node.exe'));
  } catch {}
  try {
    const rank=name=>name.slice('node-v'.length).split('.').map(Number);
    const versions=readdirSync(root,{withFileTypes:true})
      .filter(entry=>entry.isDirectory() && /^node-v\d+\.\d+\.\d+$/.test(entry.name))
      .map(entry=>entry.name).sort((a,b)=>{
        const av=rank(a),bv=rank(b);
        for(let i=0;i<3;i++) if(av[i]!==bv[i]) return bv[i]-av[i];
        return 0;
      });
    for(const version of versions) candidates.push(join(root,version,'node.exe'));
  } catch {}
  for(const candidate of candidates) {
    const stat=pathLstat(candidate);
    if(stat?.isFile() && win32.basename(candidate).toLowerCase()==='node.exe') return candidate;
  }
  for(const dir of String(pathEnv||'').split(win32.delimiter)) {
    if(!dir) continue;
    const candidate=win32.join(dir,'node.exe'), stat=pathLstat(candidate);
    if(stat?.isFile()) return candidate;
  }
  fail('NODE_RUNTIME_NOT_FOUND');
}
// Install Claude skills from the actual shipped skill definitions, not merely
// carry them as inert files. The Office-specific skill is complete-only.
export const CLAUDE_SKILLS = Object.freeze([
  'board', 'claude-office-visual', 'consult-dispatch', 'handoff',
  'hub-doc-update', 'implementation-review', 'issue-closeout',
  'mcp-builder', 'retro', 'statusline-builder',
]);
const skillsFor = (variant) => CLAUDE_SKILLS.filter(x => variant === 2 || x !== 'claude-office-visual');

// Parent-proxy routing keys we may write. Rollback only ever removes a key whose
// current value is still the one we wrote, so a user's later edit survives.
export const MAIN_MEMORY_PROXY_ENV = Object.freeze(['ANTHROPIC_BASE_URL','ANTHROPIC_AUTH_TOKEN','ANTHROPIC_MODEL']);
// Provenance contract with the dedicated credential helper
// (native/windows/configure_parent_memory_proxy.mjs). Never a credential.
export const PARENT_PROXY_RECEIPT = '.singularity-parent-memory-proxy-receipt.json';
export const PARENT_PROXY_RECEIPT_SCHEMA = 'singularity-option2-parent-proxy/v1';
function mainMemoryEnvDelta(before, after) {
  const prev = (before && typeof before.env === 'object') ? before.env : {};
  const next = (after && typeof after.env === 'object') ? after.env : {};
  const written = {}, previous = {};
  for (const k of MAIN_MEMORY_PROXY_ENV) {
    // The parent-session credential is never written by Configure, so it is
    // never journalled either: a receipt must not carry a secret.
    if (k === 'ANTHROPIC_AUTH_TOKEN') continue;
    if (next[k] === undefined || next[k] === prev[k]) continue;
    written[k] = next[k];
    // Absent stays absent. JSON null would make rollback WRITE a null value
    // instead of removing the key it created.
    if (prev[k] !== undefined) previous[k] = prev[k];
  }
  return { written, previous };
}
// Option 2 event forwarding complements, but never replaces, the memory and
// documentation hooks. Office credentials remain only in the referenced file.
export const OFFICE_EVENTS = Object.freeze({
  SessionStart:'session-start', UserPromptSubmit:'prompt',
  PreToolUse:'pre-tool', PostToolUse:'post-tool', Stop:'stop',
  SubagentStop:'subagent-stop', SessionEnd:'session-end',
});
const PARENT_MEMORY_HOOK_ENTRIES = 6; // SubagentStart, SubagentStop, SessionStart, Stop x2, SessionEnd (verifyConfiguration expectedHooks table)
export function expectedHookEvents(variant) { return PARENT_MEMORY_HOOK_ENTRIES + (variant === 2 ? Object.keys(OFFICE_EVENTS).length : 0); }
  function isOfficeHandler(h, officeScript) {
  return h?.type === 'command' && Array.isArray(h.args) &&
    String(h.args[0]||'').replaceAll('\\','/').toLowerCase() === officeScript.replaceAll('\\','/').toLowerCase();
}
function addOfficeHooks(settings, scriptPath, nodeExe) {
  settings.hooks ??= {};
  for (const [event,kind] of Object.entries(OFFICE_EVENTS)) {
    const groups=settings.hooks[event] ?? [];
    if(!Array.isArray(groups))fail('INVALID_HOOK_EVENT_STRUCTURE');
    const spec={type:'command',command:nodeExe,args:[scriptPath,kind]};
    let found=0;
    for(const group of groups){
      if(!group || typeof group!=='object' || Array.isArray(group) || !Array.isArray(group.hooks))
        fail('INVALID_HOOK_GROUP_STRUCTURE');
      for(const h of group.hooks) if(isOfficeHandler(h,scriptPath)) {
        if(group.matcher!==undefined || !sameConfig(h,spec))fail('OFFICE_HOOK_CONFLICT');
        found++;
      }
    }
    if(found>1)fail('DUPLICATE_OFFICE_HOOK');
    if(found===0)settings.hooks[event]=[...groups,{hooks:[spec]}];
  }
}
function removeOfficeHooks(settings, scriptPath, nodeExe, ownedEnv) {
  const next=structuredClone(settings);
  for(const [event,kind] of Object.entries(OFFICE_EVENTS)) {
    const groups=next.hooks?.[event];
    if(!Array.isArray(groups))continue;
    const wanted={type:'command',command:nodeExe,args:[scriptPath,kind]};
    const result=[];
    for(const group of groups){
      if(!Array.isArray(group?.hooks)){result.push(group);continue;}
      const retained=[];
      for(const h of group.hooks){
        if(isOfficeHandler(h,scriptPath)){
          if(group.matcher!==undefined || !sameConfig(h,wanted))fail('OFFICE_HOOK_CHANGED_REFUSE_ROLLBACK');
        }else retained.push(h);
      }
      if(retained.length)result.push({...group,hooks:retained});
    }
    if(result.length)next.hooks[event]=result;
    else delete next.hooks[event];
  }
  if(next.hooks && !Object.keys(next.hooks).length)delete next.hooks;
  if(ownedEnv && Object.hasOwn(next.env||{},'OFFICE_CONFIG')){
    if(next.env.OFFICE_CONFIG!==ownedEnv)fail('OFFICE_CONFIG_CHANGED_REFUSE_ROLLBACK');
    delete next.env.OFFICE_CONFIG;
    if(!Object.keys(next.env).length)delete next.env;
  }
  return next;
}

// The official RepoQL Claude plugin owns its own versioned skills, MCP server,
// hooks and agents. Do not duplicate its skill files or silently upgrade rql.
export const REPOQL_CLAUDE_PLUGIN = Object.freeze({
  id:'repoql@repoql-plugins', marketplace:'repoql-plugins',
  source:Object.freeze({source:'github',repo:'RepoQL/RepoQL'}),
});
// 17 skill directories present in RepoQL/RepoQL main on 2026-10-29.
// Update only after an upstream skill inventory review.
export const REPOQL_PLUGIN_SKILLS = Object.freeze([
  'effective-markdown','effective-repoql','findings','flow','installing-connectors',
  'mermaid-diagrams','monitoring-repoql','north-star','odad','plan','research',
  'skill-builder','statusline-builder','system-design','troubleshooting-repoql',
  'using-uplinks','writing-connectors',
]);
const repoqlMarketplace = () => ({source:{...REPOQL_CLAUDE_PLUGIN.source},autoUpdate:false});
const sameConfig = (a,b) => JSON.stringify(a)===JSON.stringify(b);
const approvedRepoqlMarketplace = x => !!x && sameConfig(x.source,REPOQL_CLAUDE_PLUGIN.source) &&
  (x.autoUpdate===undefined || x.autoUpdate===false);
function requestRepoqlPlugin(settings) {
  const {id,marketplace}=REPOQL_CLAUDE_PLUGIN;
  for(const key of ['enabledPlugins','extraKnownMarketplaces']) {
    const value=settings[key];
    if(value!==undefined && (!value || typeof value!=='object' || Array.isArray(value)))
      fail('INVALID_REPOQL_PLUGIN_SETTINGS');
  }
  const expected=repoqlMarketplace();
  const actual=settings.extraKnownMarketplaces?.[marketplace];
  if(actual!==undefined && !approvedRepoqlMarketplace(actual)) fail('REPOQL_MARKETPLACE_CONFLICT');
  const enabled=settings.enabledPlugins?.[id];
  if(enabled!==undefined && enabled!==true) fail('REPOQL_PLUGIN_DISABLED_CONFLICT');
  const owned={marketplaceCreated:actual===undefined,pluginEnableCreated:enabled===undefined};
  settings.extraKnownMarketplaces={...settings.extraKnownMarketplaces,[marketplace]:actual ?? expected};
  settings.enabledPlugins={...settings.enabledPlugins,[id]:true};
  return owned;
}
function checkRepoqlOwnership(settings,owned) {
  if(!owned) return; // pre-M34 receipts own no RepoQL plugin entries
  if((owned.marketplaceCreated && !sameConfig(settings.extraKnownMarketplaces?.[REPOQL_CLAUDE_PLUGIN.marketplace],repoqlMarketplace())) ||
     (owned.pluginEnableCreated && settings.enabledPlugins?.[REPOQL_CLAUDE_PLUGIN.id]!==true))
    fail('REPOQL_PLUGIN_SETTINGS_CHANGED_REFUSE_ROLLBACK');
}
function removeOwnedRepoqlPlugin(settings,owned) {
  if(!owned) return settings;
  const result=structuredClone(settings);
  if(owned.marketplaceCreated){
    delete result.extraKnownMarketplaces[REPOQL_CLAUDE_PLUGIN.marketplace];
    if(!Object.keys(result.extraKnownMarketplaces).length)delete result.extraKnownMarketplaces;
  }
  if(owned.pluginEnableCreated){
    delete result.enabledPlugins[REPOQL_CLAUDE_PLUGIN.id];
    if(!Object.keys(result.enabledPlugins).length)delete result.enabledPlugins;
  }
  return result;
}

/** Windows Claude Code skills retain source semantics but need canonical names
 * and must never instruct a native installer to run Linux/Docker operations. */
export function renderClaudeSkill(name, sourceBytes) {
  if (!CLAUDE_SKILLS.includes(name)) fail('UNKNOWN_SKILL');
  let text=sourceBytes.toString('utf8');
  if(!/^---\r?\n[\s\S]*?\r?\n---/.test(text) || !/^name:.*$/m.test(text))fail('INVALID_SKILL_FRONTMATTER');
  text=text.replace(/^name:.*$/m,`name: ${name}`);
  if(name==='claude-office-visual') {
    const old="Deploy the way the project's office compose file does; do not restart the\n   primary application to apply an office change — they are separate containers.";
    const replacement='Deploy only through the verified native Windows Claude Office service lifecycle.\n   Never use Docker, WSL, Compose or Linux shell provisioning for this installation.';
    const eol=text.includes('\r\n')?'\r\n':'\n';
    const oldN=old.replace(/\n/g,eol);
    if(text.includes(oldN)) text=text.replace(oldN,replacement.replace(/\n/g,eol));
    else if(/office compose file|Deploy.*Docker/i.test(text)) fail('OFFICE_SKILL_NATIVE_BOUNDARY_CHANGED');
  }
  return Buffer.from(text,'utf8');
}
// Real hook module-import closure. A matching hook file alone is insufficient:
// if one of these shared modules is missing, Claude sessions silently degrade.
const HOOK_IMPORT_CLOSURE = [
  'adapters/claude-code/agent-map.mjs',
  'scripts/memory-config-loader.mjs',
  'scripts/memory-reconcile-core.mjs',
  'scripts/doc-policy.mjs',
  'scripts/selflearn-candidates.mjs',
  'scripts/doc-ingest-node.mjs',
  'adapters/claude-code/singularity-workflow.md',
];
const RECEIPT = '.singularity-native-claude-journal.json';
const LOCK = '.singularity-native-claude.lock';
const fail = code => { throw new Error(code); };
const json = obj => Buffer.from(JSON.stringify(obj, null, 2) + '\n');

function pathLstat(path) {
  try { return lstatSync(path); } catch(e) { if (e?.code==='ENOENT') return null; throw e; }
}
function assertPlainAncestors(path) {
  let at = resolve(path);
  while (true) {
    const stat = pathLstat(at);
    if (stat) {
      if (stat.isSymbolicLink() || (!stat.isDirectory() && at !== resolve(path))) fail('REPARSE_OR_NON_DIRECTORY_PATH');
    }
    const parent = dirname(at);
    if (parent === at) break;
    at = parent;
  }
}
function readObject(path, optional = false) {
  if (!existsSync(path) && optional) return {};
  const value = JSON.parse(readFileSync(path, 'utf8'));
  if (!value || typeof value !== 'object' || Array.isArray(value)) fail('INVALID_SETTINGS_OBJECT');
  return value;
}
function validOfficeConfig(path) {
  try {
    const value=readObject(path);
    if(typeof value.endpoint!=='string' || typeof value.ingestKey!=='string' || !value.ingestKey.trim()) return false;
    const url=new URL(value.endpoint);
    return ['http:','https:'].includes(url.protocol) && Boolean(url.hostname) && !url.username && !url.password;
  }catch {return false;}
}
function writeExclusive(path, bytes) {
  const handle = openSync(path, 'wx', 0o600);
  try { writeFileSync(handle, bytes); fsyncSync(handle); }
  finally { closeSync(handle); }
}
function atomicWrite(path, bytes) {
  const tmp = `${path}.pending-${randomUUID()}`;
  try { writeExclusive(tmp, bytes); renameSync(tmp, path); }
  finally { if (existsSync(tmp)) rmSync(tmp); }
}
function fileHash(path) {
  const stat = pathLstat(path);
  if (!stat) return null;
  if (!stat.isFile() || stat.isSymbolicLink()) fail('REPARSE_OR_NON_FILE_PATH');
  return HASH(readFileSync(path));
}
function guardedUnlink(path, expected) {
  assertPlainAncestors(path);
  const got = fileHash(path);
  if (got === null) return;
  if (got !== expected) fail('OWNED_FILE_CHANGED_REFUSE_DELETE');
  rmSync(path);
}
function ownedPendingSettings(j){
  // M32–M67 receipts have no pending-settings field. Never guess temp names.
  if(j.pendingSettingsTmp===undefined)return null;
  const prefix=j.settingsPath+'.pending-';
  if(typeof j.pendingSettingsTmp!=='string'||!j.pendingSettingsTmp.startsWith(prefix)||
     !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(j.pendingSettingsTmp.slice(prefix.length)))
    fail('JOURNAL_PENDING_SETTINGS_UNOWNED');
  assertPlainAncestors(j.pendingSettingsTmp);
  const got=fileHash(j.pendingSettingsTmp);
  if(got===null)return null;
  if(got!==j.afterSha256)fail('JOURNAL_PENDING_SETTINGS_CHANGED');
  return j.pendingSettingsTmp;
}
function ownedRollbackMerge(j){
 if(j.rollbackMerge===undefined)return null;
 const r=j.rollbackMerge,prefix=j.settingsPath+'.merge-';
 if(!r||typeof r!=='object'||Array.isArray(r)||
    Object.keys(r).sort().join(',')!=='afterSha,beforeSha,tmp'||
    !/^[0-9a-f]{64}$/.test(r.beforeSha)||!/^[0-9a-f]{64}$/.test(r.afterSha)||
    typeof r.tmp!=='string'||!r.tmp.startsWith(prefix)||
    !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(r.tmp.slice(prefix.length)))
    fail('CLAUDE_ROLLBACK_MERGE_JOURNAL_INVALID');
 assertPlainAncestors(r.tmp);
 const got=fileHash(r.tmp);
 if(got!==null&&got!==r.afterSha)fail('CLAUDE_ROLLBACK_MERGE_TEMP_CHANGED');
 return {data:r,tempPresent:got!==null};
}
function ownedRollbackRestore(j){
  if(j.rollbackRestore===undefined)return null;
  const r=j.rollbackRestore,prefix=j.settingsPath+'.restore-';
  if(!r||typeof r!=='object'||Array.isArray(r)||
     Object.keys(r).sort().join(',')!=='fromSha,tmp,toSha'||
     typeof r.fromSha!=='string'||typeof r.toSha!=='string'||
     r.fromSha!==j.afterSha256||r.toSha!==j.beforeSha256||!j.backup||
     !/^[0-9a-f]{64}$/.test(r.fromSha)||!/^[0-9a-f]{64}$/.test(r.toSha)||
     typeof r.tmp!=='string'||!r.tmp.startsWith(prefix)||
     !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(r.tmp.slice(prefix.length)))
    fail('CLAUDE_ROLLBACK_RESTORE_JOURNAL_INVALID');
  assertPlainAncestors(r.tmp);
  const got=fileHash(r.tmp);
  if(got!==null&&got!==r.toSha)fail('CLAUDE_ROLLBACK_RESTORE_TEMP_CHANGED');
  return {data:r,tempPresent:got!==null};
}
function verifyRoot(source, variant) {
  const manifest = readObject(join(source, 'NATIVE_WINDOWS_SOURCE_MANIFEST.json'));
  if (manifest.variant !== variant || manifest.gui !== 'claude-desktop-code' ||
      manifest.repoql?.requiredVersion !== '1.7.18' ||
      manifest.features?.ghost !== false ||
      manifest.features?.office !== (variant === 2)) fail('WRONG_OR_UNVERIFIED_SOURCE_VARIANT');
  if (!Array.isArray(manifest.files) || manifest.files.length < 19 + HOOK_IMPORT_CLOSURE.length) fail('MANIFEST_FILE_HASHES_REQUIRED');
  const checks = new Map(manifest.files.map(row=>[row.path,row.sha256]));
  const ownedFiles = [
    'adapters/claude-code/memory-hook.mjs',
    'adapters/claude-code/doc-hook.mjs',
    ...(variant===2 ? ['adapters/claude-code/office-hook.mjs'] : []),
    ...HOOK_IMPORT_CLOSURE,
    ...NAMES.map(name=>`adapters/claude-code/agents/${name}.md`),
    ...skillsFor(variant).map(name=>`openchamber/skills/${name}/SKILL.md`),
  ];
  for (const name of ownedFiles) {
    const file = join(source,...name.split('/'));
    assertPlainAncestors(file);
    if (!/^[0-9a-f]{64}$/.test(checks.get(name)||'') || fileHash(file)!==checks.get(name)) fail('SOURCE_HASH_PROVENANCE_MISMATCH');
  }
}

/** Exported for isolated filesystem tests. The command-line apply/rollback paths
 * additionally require process.platform === win32; tests never write user's settings. */
export function prepareConfiguration({source, home, nodeExe, memoryConfig, officeConfig, variant, parentMemoryProxy, mainProxyUrl: mainProxyUrlOption = null, mainProxyModel = null}) {
  if (variant !== 1 && variant !== 2) fail('CLAUDE_VARIANT_1_OR_2_ONLY');
  // An arbitrary .exe path would turn a Claude hook into an unrelated process
  // launcher. Match the read-only planner and require the actual Node basename.
  if (win32.basename(nodeExe).toLowerCase() !== 'node.exe') fail('NODE_EXE_NAME_REQUIRED');
  assertPortableNodePath(nodeExe);
  const claude = join(home, '.claude');
  const settingsPath = join(claude, 'settings.json');
  const agentsDir = join(claude, 'agents');
  const rulesDir = join(claude, 'rules');
  const skillsDir = join(claude, 'skills');
  const receiptPath = join(claude, RECEIPT);
  for (const p of [source,home,nodeExe,memoryConfig,...(variant===2 && officeConfig?[officeConfig]:[]),claude,settingsPath,agentsDir,skillsDir,receiptPath]) assertPlainAncestors(p);
  // Existence is insufficient: a directory at either path otherwise produces
  // a healthy-looking configuration that can never execute or read credentials.
  if (!existsSync(home) || !lstatSync(home).isDirectory() ||
      !pathLstat(nodeExe)?.isFile() || !pathLstat(memoryConfig)?.isFile())
    fail('REQUIRED_LOCAL_RUNTIME_NOT_PRESENT');
  if(variant===2){
    if(!officeConfig || !pathLstat(officeConfig)?.isFile())fail('OFFICE_CONFIG_FILE_REQUIRED');
    if(!validOfficeConfig(officeConfig))fail('OFFICE_CONFIG_INVALID');
  }
  verifyRoot(source, variant);
  if (existsSync(receiptPath)) fail('UNRESOLVED_INSTALL_JOURNAL');
  const settings = readObject(settingsPath, true);
  if ((settings.hooks !== undefined && (!settings.hooks || typeof settings.hooks !== 'object' || Array.isArray(settings.hooks))) ||
      (settings.env !== undefined && (!settings.env || typeof settings.env !== 'object' || Array.isArray(settings.env)))) fail('INVALID_SETTINGS_STRUCTURE');
  // The general-purpose merge helper tolerates malformed events for legacy
  // callers. The native installer must NOT silently replace a user's malformed
  // hook/event value or accept a matching hook hidden behind a matcher.
  const ownedPaths=[join(source,'adapters','claude-code','memory-hook.mjs'),
    join(source,'adapters','claude-code','doc-hook.mjs')];
  const officeScript=join(source,'adapters','claude-code','office-hook.mjs');
  for (const event of [...new Set(['SubagentStart','SubagentStop','SessionStart','Stop',...PARENT_HOOK_EVENTS,...(variant===2?Object.keys(OFFICE_EVENTS):[])])]) {
    const groups=settings.hooks?.[event];
    if (groups === undefined) continue;
    if (!Array.isArray(groups)) fail('INVALID_HOOK_EVENT_STRUCTURE');
    for (const group of groups) {
      if (!group || typeof group !== 'object' || Array.isArray(group) || !Array.isArray(group.hooks))
        fail('INVALID_HOOK_GROUP_STRUCTURE');
      if (group.matcher !== undefined && group.hooks.some(h => hookOwnership(h,{scriptPaths:ownedPaths})))
        fail('MATCHER_BOUND_SINGULARITY_HOOK');
    }
  }
  const scriptPath = join(source, 'adapters', 'claude-code', 'memory-hook.mjs');
  const env = {SINGULARITY_REPO_ROOT:source,SINGULARITY_MEMORY_CONFIG:memoryConfig,REPOQL_NO_BOOTSTRAP:'1',
    ...(variant===2?{OFFICE_CONFIG:officeConfig}:{})};
  // Silent preservation of a stale override would result in hooks running with
  // the wrong memory namespace. Refuse rather than mutating a user preference.
  for (const [key, value] of Object.entries(env)) {
    if (Object.hasOwn(settings.env || {},key) && settings.env[key] !== value)
      fail('EXISTING_MEMORY_ENV_CONFLICT');
  }
  const merge = ensureMemoryIntegration(settings, {scriptPath,env,platform:'win32',nodePath:nodeExe,parentConversation:true});
  if(variant===2)addOfficeHooks(merge.settings,officeScript,nodeExe);
  // fleet#993 (Beta B2): parent-session memory routing is part of the supported
  // Configure flow, not only the separate installer plan. Default-on for the
  // Claude Code Complete variant (2); `parentMemoryProxy:false` is the explicit
  // opt-out. A foreign provider configuration is REFUSED, never rewritten: the
  // shared helper returns 'refused-conflict' and `merge.settings` stays as-is.
  const parentProxyEnabled = parentMemoryProxy ?? (variant === 2);
  const mainProxyUrl = parentProxyEnabled
    ? String(mainProxyUrlOption || resolveMainProxyUrl({ env: process.env })).replace(/\/$/, '')
    : null;
  let parentProxy = {
    enabled: Boolean(parentProxyEnabled), configured: false, verified: false,
    liveMemoryRecallVerified: false, mode: 'disabled', reasons: [], baseUrl: mainProxyUrl,
    alreadyOwned: false, envWritten: {}, prevEnv: {}, provenanceBasis: null, provenanceFailure: null,
  };
  if (parentProxyEnabled) {
    const alreadyOwned = isMainMemoryOwnConfig(merge.settings, mainProxyUrl);
    const conflicts = detectProviderConflicts(merge.settings, { baseUrl: mainProxyUrl });
    // A token that exists is not a token that authenticates OUR proxy, and a
    // surviving proxy URL does not make an arbitrary token ours: a placeholder or
    // replaced credential must fail closed even while the route looks healthy.
    const existingEnv = (merge.settings && typeof merge.settings.env === 'object' && merge.settings.env) ? merge.settings.env : {};
    const existingToken = typeof existingEnv.ANTHROPIC_AUTH_TOKEN === 'string' && existingEnv.ANTHROPIC_AUTH_TOKEN.trim().length > 0;
    let proxyReceipt = null;
    try { proxyReceipt = JSON.parse(readFileSync(join(claude, PARENT_PROXY_RECEIPT), 'utf8')); } catch { proxyReceipt = null; }
    // Ownership proofs, strongest first. "Some token exists" is never one:
    //  a) credential binding — the helper's APPLIED receipt carries a salted
    //     HMAC-SHA256 of the exact token it installed (never the token itself), so
    //     the token on disk is provably the helper's. This is the only proof that
    //     survives later settings writes, and it is bound to the credential value
    //     rather than to a file digest, so a replaced token fails closed.
    //  b) legacy exact digest — receipts written before the binding existed cannot
    //     prove which token is on disk. Such a receipt is trusted only while the
    //     settings file is byte-identical to the helper's write, and the weaker
    //     basis is reported so a reviewer can tell the two apart. Once settings
    //     drift, an unbound receipt fails closed instead of authorising anything.
    const receiptNamesThisSettings = Boolean(
      proxyReceipt && typeof proxyReceipt === 'object' &&
      proxyReceipt.schema === PARENT_PROXY_RECEIPT_SCHEMA && proxyReceipt.state === 'APPLIED' &&
      proxyReceipt.settings === settingsPath &&
      typeof proxyReceipt.afterSha === 'string' && /^[0-9a-f]{64}$/.test(proxyReceipt.afterSha)
    );
    const receiptSalt = receiptNamesThisSettings && typeof proxyReceipt.credentialSalt === 'string' ? proxyReceipt.credentialSalt : '';
    const receiptBinding = receiptNamesThisSettings && typeof proxyReceipt.credentialBinding === 'string' ? proxyReceipt.credentialBinding : '';
    const receiptHasBinding = /^[0-9a-f]{32}$/.test(receiptSalt) && /^[0-9a-f]{64}$/.test(receiptBinding);
    const credentialBindingMatches = Boolean(
      receiptHasBinding && existingToken &&
      timingSafeEqual(
        createHmac('sha256', Buffer.from(receiptSalt, 'hex'))
          .update(existingEnv.ANTHROPIC_AUTH_TOKEN, 'utf8').digest(),
        Buffer.from(receiptBinding, 'hex'))
    );
    const legacyDigestProvenance = Boolean(
      receiptNamesThisSettings && !receiptHasBinding &&
      proxyReceipt.afterSha === fileHash(settingsPath)
    );
    const authProvenanceVerified = Boolean(
      existingToken && receiptNamesThisSettings && (credentialBindingMatches || legacyDigestProvenance)
    );
    const provenanceBasis = !authProvenanceVerified ? null
      : (credentialBindingMatches ? 'credential-binding' : 'legacy-receipt-exact-digest');
    // Actionable, secret-free reason for the refusal. Each names what is missing
    // so the operator knows whether to run the helper or drop a foreign token.
    const provenanceFailure = authProvenanceVerified ? null
      : (!receiptNamesThisSettings ? 'PARENT_PROXY_RECEIPT_ABSENT'
        : (receiptHasBinding ? 'PARENT_PROXY_CREDENTIAL_BINDING_MISMATCH'
          : 'PARENT_PROXY_RECEIPT_UNBOUND_AND_SETTINGS_DRIFTED'));
    let parentProxyRefusedMissingAuth = false;
    if (!authProvenanceVerified && conflicts.length === 0) {
      // Fail closed and mutate nothing: provider routing is not written without a
      // credential whose proxy ownership is established.
      parentProxy = {
        enabled: true, configured: false, verified: false,
        liveMemoryRecallVerified: false, mode: 'refused-auth-provenance',
        reasons: ['PARENT_PROXY_AUTH_PROVENANCE_REQUIRED', provenanceFailure],
        action: provenanceFailure === 'PARENT_PROXY_RECEIPT_ABSENT'
          ? 'Run the supported credential step first: configure_parent_memory_proxy.mjs --apply with its private config file (it owns the parent-proxy token and records a credential binding), then re-run Configure. No settings were changed and no credential was read.'
          : 'The ANTHROPIC_AUTH_TOKEN on disk is not the credential the supported helper installed for this proxy (it was replaced, is a placeholder, or the receipt predates the credential binding and settings have since changed). Re-run configure_parent_memory_proxy.mjs --apply with its private config file, then re-run Configure. No settings were changed and no credential was read.',
        baseUrl: mainProxyUrl, alreadyOwned,
        authPresent: existingToken, authProvenanceVerified: false,
        provenanceBasis: null, provenanceFailure,
        envWritten: {}, prevEnv: {},
      };
      parentProxyRefusedMissingAuth = true;
    }
    const applied = parentProxyRefusedMissingAuth ? null : ensureMainMemoryIntegration(merge.settings, {
      baseUrl: mainProxyUrl,
      // A parent-session credential is never written, validated or journalled
      // here: that belongs to the scoped probe and the user's own secret store.
      token: null,
      model: mainProxyModel,
    });
    const delta = !applied || applied.mode === 'refused-conflict' ? {written:{},previous:{}} : mainMemoryEnvDelta(merge.settings, applied.settings);
    if (applied) parentProxy = {
      enabled: true,
      configured: applied.mode !== 'refused-conflict',
      verified: false, // only a scoped live probe may upgrade this; config alone cannot
      liveMemoryRecallVerified: false,
      mode: applied.mode,
      reasons: (applied.mode === 'refused-conflict' ? applied.reasons : conflicts).map(String),
      baseUrl: mainProxyUrl,
      alreadyOwned,
      // Presence and provenance only; the credential value is never returned,
      // logged or journalled, and neither are the receipt's salt or binding.
      authPresent: existingToken, authProvenanceVerified: true, provenanceBasis,
      envWritten: delta.written,
      prevEnv: delta.previous,
    };
    if (applied && parentProxy.configured) merge.settings = applied.settings;
  }
  const repoqlPluginOwned=requestRepoqlPlugin(merge.settings);
  const originalSettingsHash = fileHash(settingsPath);
  const agentWrites = [];
  for (const name of NAMES) {
    const src = join(source,'adapters','claude-code','agents',`${name}.md`);
    const target = join(agentsDir,`${name}.md`);
    assertPlainAncestors(src);
    assertPlainAncestors(target);
    if (!existsSync(src) || !lstatSync(src).isFile()) fail('AGENT_SOURCE_MISSING');
    const bytes = readFileSync(src);
    const destHash = fileHash(target);
    const hash = HASH(bytes);
    if (destHash && destHash !== hash) fail('FOREIGN_AGENT_CONFLICT');
    agentWrites.push({src,target,sha256:hash,create:destHash===null});
  }
  const workflowSrc=join(source,'adapters','claude-code','singularity-workflow.md');
  const workflowTarget=join(rulesDir,'singularity-workflow.md');
  assertPlainAncestors(workflowSrc);assertPlainAncestors(workflowTarget);
  const workflowHash=fileHash(workflowSrc),presentWorkflowHash=fileHash(workflowTarget);
  if(!workflowHash)fail('WORKFLOW_RULE_SOURCE_MISSING');
  if(presentWorkflowHash && presentWorkflowHash!==workflowHash)fail('FOREIGN_WORKFLOW_RULE_CONFLICT');
  const ruleWrites=[{src:workflowSrc,target:workflowTarget,sha256:workflowHash,create:presentWorkflowHash===null}];
  const skillWrites = [];
  for (const name of skillsFor(variant)) {
    const src = join(source,'openchamber','skills',name,'SKILL.md');
    const directory = join(skillsDir,name);
    const target = join(directory,'SKILL.md');
    assertPlainAncestors(src);assertPlainAncestors(directory);assertPlainAncestors(target);
    if (fileHash(src)===null) fail('SKILL_SOURCE_MISSING');
    const data=renderClaudeSkill(name,readFileSync(src));
    const sourceHash=HASH(data);
    const existingDir = pathLstat(directory);
    if (existingDir && (!existingDir.isDirectory() || existingDir.isSymbolicLink())) fail('FOREIGN_SKILL_DIRECTORY_CONFLICT');
    const existingHash = fileHash(target);
    if (existingDir && existingHash===null) fail('FOREIGN_SKILL_DIRECTORY_CONFLICT');
    if (existingHash && existingHash!==sourceHash) fail('FOREIGN_SKILL_CONFLICT');
    skillWrites.push({src,target,directory,data,sha256:sourceHash,create:existingHash===null});
  }
  const next = json(merge.settings);
  return {schema:1,source,home,claude,settingsPath,agentsDir,rulesDir,skillsDir,receiptPath,
    scriptPath,env,originalSettingsHash,nextSettingsHash:HASH(next),nextSettings:next,
    agentWrites,ruleWrites,skillWrites,newEnv:Object.fromEntries(Object.entries(env).filter(([k])=>!(k in (settings.env || {})))),
    changedSettings:originalSettingsHash!==HASH(next),repoqlPluginOwned,parentProxy,variant,officeScript,officeConfig};
}

/** Mutates only the selected .claude settings and absent agent definitions.
 * A journal is written before the first change. If interrupted, rollback reads
 * the journal and only touches files which still equal their expected hash. */
export function applyConfiguration(config) {
  const p = prepareConfiguration(config);
  mkdirSync(p.claude,{recursive:true});
  mkdirSync(p.agentsDir,{recursive:true});mkdirSync(p.rulesDir,{recursive:true});mkdirSync(p.skillsDir,{recursive:true});
  assertPlainAncestors(p.claude);assertPlainAncestors(p.agentsDir);assertPlainAncestors(p.rulesDir);assertPlainAncestors(p.skillsDir);
  const lock = join(p.claude,LOCK);
  const lockFd = openSync(lock,'wx',0o600);
  try {
    // Recheck after taking the lock; this doesn't prevent other applications
    // from editing settings, but detects changes immediately before commit.
    if (fileHash(p.settingsPath) !== p.originalSettingsHash || existsSync(p.receiptPath)) fail('CONFIGURATION_CHANGED_DURING_PLAN');
    const backup = `${p.settingsPath}.singularity-backup-${randomUUID()}`;
    const pendingSettingsTmp=`${p.settingsPath}.pending-${randomUUID()}`;
    const journal = {
      schema:'singularity-claude-native-config/v1',state:'PREPARED',
      variant:p.variant,source:p.source,settingsPath:p.settingsPath,backup:p.originalSettingsHash?backup:null,
      beforeSha256:p.originalSettingsHash,afterSha256:p.nextSettingsHash,
      pendingSettingsTmp,
      agents:p.agentWrites.filter(a=>a.create).map(a=>({path:a.target,sha256:a.sha256})),
      rules:p.ruleWrites.filter(a=>a.create).map(a=>({path:a.target,sha256:a.sha256})),
      skills:p.skillWrites.filter(a=>a.create).map(a=>({path:a.target,sha256:a.sha256})),
      // store only installation-controlled keys/paths; no settings or secrets
      env:p.newEnv,repoqlPluginOwned:p.repoqlPluginOwned,scriptPath:p.scriptPath,nodeExe:config.nodeExe,memoryConfig:config.memoryConfig,
      // ownership record only: the proxy token is never journalled or logged
      ...(p.parentProxy?.configured ? {parentMemory:{baseUrl:p.parentProxy.baseUrl,envWritten:p.parentProxy.envWritten,prevEnv:p.parentProxy.prevEnv}} : {}),
      ...(p.variant===2?{officeScript:p.officeScript,officeConfig:p.officeConfig}:{}),
    };
    // Journal ownership FIRST. A crash while copying backup or writing the
    // settings temp must not strand an unknown credential-bearing file.
    writeExclusive(p.receiptPath,json(journal));
    try {
      if (p.originalSettingsHash) writeExclusive(backup,readFileSync(p.settingsPath));
      for (const rule of p.ruleWrites.filter(a=>a.create)) {
        if(existsSync(rule.target))fail('WORKFLOW_RULE_CHANGED_DURING_APPLY');
        copyFileSync(rule.src,rule.target,constants.COPYFILE_EXCL);
        if(fileHash(rule.target)!==rule.sha256)fail('WORKFLOW_RULE_HASH_MISMATCH');
      }
      for (const skill of p.skillWrites.filter(a=>a.create)) {
        if (existsSync(skill.directory)) fail('SKILL_DIRECTORY_CHANGED_DURING_APPLY');
        mkdirSync(skill.directory);
        writeExclusive(skill.target,skill.data);
        if(fileHash(skill.target)!==skill.sha256)fail('COPIED_SKILL_HASH_MISMATCH');
      }
      for (const agent of p.agentWrites.filter(a=>a.create)) {
        // If another process raced to create a file, refuse, never overwrite.
        if (existsSync(agent.target)) fail('AGENT_CHANGED_DURING_APPLY');
        copyFileSync(agent.src, agent.target, constants.COPYFILE_EXCL);
        if (fileHash(agent.target)!==agent.sha256) fail('COPIED_AGENT_HASH_MISMATCH');
      }
      if (p.changedSettings) {
        if (fileHash(p.settingsPath)!==p.originalSettingsHash) fail('SETTINGS_CHANGED_DURING_APPLY');
        writeExclusive(pendingSettingsTmp,p.nextSettings);
        renameSync(pendingSettingsTmp,p.settingsPath);
      }
      atomicWrite(p.receiptPath,json({...journal,state:'APPLIED'}));
      return {state:'CONFIGURED_UNVERIFIED',agentDefinitions:NAMES.length,skillsInstalled:skillsFor(p.variant).length,workflowRuleInstalled:true,
        newlyCreatedAgents:journal.agents.length,settingsChanged:p.changedSettings,
        fullProductInstalled:false,officeRuntimeInstalled:false,ghostRuntimeInstalled:false,
        repoqlPluginRequested:true,repoqlPluginSkillsVerified:false,repoqlVersionPinned:'1.7.18',
        officeEventHooksConfigured:p.variant===2,officeEventHooksVerified:false,
        parentProxyConfigured:Boolean(p.parentProxy?.configured),parentProxyVerified:false,
        parentProxyMode:p.parentProxy?.mode ?? 'disabled',parentProxyRefused:p.parentProxy?.mode==='refused-conflict',
        parentProxyAuthPresent:p.parentProxy?.authPresent === true,
        parentProxyAuthProvenanceVerified:p.parentProxy?.authProvenanceVerified === true,
        parentProxyAuthProvenanceBasis:p.parentProxy?.provenanceBasis ?? null,
        parentProxyAuthRequired:p.parentProxy?.mode==='refused-auth-provenance',
        parentProxyAction:p.parentProxy?.action ?? null,
        parentProxyReasons:[...(p.parentProxy?.reasons ?? [])],liveMemoryRecallVerified:false};
    } catch(e) {
      // Preserve journal and backup for safe explicit recovery if interrupted.
      throw new Error('CONFIGURATION_PARTIAL_RECOVERY_REQUIRED: '+e.message);
    }
  } finally { closeSync(lockFd);rmSync(lock,{force:true}); }
}

/** Recover a previous apply without deleting user-owned/newly edited files.
 * Settings are restored exactly if unchanged, or owned hooks are removed via
 * the tested shared helper while preserving other updates. */
export function rollbackConfiguration({home}) {
  const claude=join(home,'.claude'), receiptPath=join(claude,RECEIPT);
  for (const p of [home,claude,receiptPath]) assertPlainAncestors(p);
  if (!existsSync(receiptPath)) fail('NO_INSTALL_JOURNAL');
  const lock=join(claude,LOCK), fd=openSync(lock,'wx',0o600);
  try {
    const j=readObject(receiptPath);
    if (j.schema!=='singularity-claude-native-config/v1' || !['PREPARED','APPLIED'].includes(j.state) ||
        ![1,2].includes(j.variant) || j.settingsPath!==join(claude,'settings.json') ||
        !Array.isArray(j.agents) || j.agents.length>17 /* legacy journals may list up to 17 */) fail('JOURNAL_INVALID');
    const agentsDir=join(claude,'agents');
    const rulesDir=join(claude,'rules');
    const skillsDir=join(claude,'skills');
    if(j.rules!==undefined && (!Array.isArray(j.rules)||j.rules.length>1))fail('JOURNAL_RULE_INVALID');
    if(j.skills!==undefined && (!Array.isArray(j.skills)||j.skills.length>CLAUDE_SKILLS.length))fail('JOURNAL_SKILLS_INVALID');
    for(const a of j.skills||[]){
      const name=CLAUDE_SKILLS.find(n=>a.path===join(skillsDir,n,'SKILL.md'));
      if(!name || (j.variant===1 && name==='claude-office-visual') || !/^[0-9a-f]{64}$/.test(a.sha256))fail('JOURNAL_SKILLS_INVALID');
    }
    for(const r of j.rules || []){
      if(r.path!==join(rulesDir,'singularity-workflow.md')||!/^[0-9a-f]{64}$/.test(r.sha256))fail('JOURNAL_RULE_INVALID');
    }
    for (const a of j.agents) {
      if (typeof a.path!=='string' || dirname(a.path)!==agentsDir || !/^singularity-[a-z-]+\.md$/.test(basename(a.path)) ||
          !/^[0-9a-f]{64}$/.test(a.sha256)) fail('JOURNAL_AGENT_INVALID');
    }
    if(j.parentMemory!==undefined){
      const pm=j.parentMemory;
      if(!pm || typeof pm!=='object' || !pm.envWritten || typeof pm.envWritten!=='object' || Array.isArray(pm.envWritten) ||
         Object.keys(pm.envWritten).some(k=>!MAIN_MEMORY_PROXY_ENV.includes(k)) ||
         (pm.prevEnv!==undefined && (!pm.prevEnv || typeof pm.prevEnv!=='object' || Array.isArray(pm.prevEnv))))
        fail('JOURNAL_PARENT_MEMORY_INVALID');
    }
    if(j.repoqlPluginOwned!==undefined && (!j.repoqlPluginOwned ||
        typeof j.repoqlPluginOwned.marketplaceCreated!=='boolean' ||
        typeof j.repoqlPluginOwned.pluginEnableCreated!=='boolean'))fail('JOURNAL_REPOQL_PLUGIN_INVALID');
    if (j.backup && (dirname(j.backup)!==claude || !basename(j.backup).startsWith('settings.json.singularity-backup-'))) fail('JOURNAL_BACKUP_INVALID');
    const ownedPending=ownedPendingSettings(j);
    const ownedMerge=ownedRollbackMerge(j);
    const ownedRestore=ownedRollbackRestore(j);
    if(ownedMerge&&ownedRestore)fail('CLAUDE_ROLLBACK_CONFLICTING_JOURNALS');
    const backupPresent=j.backup ? fileHash(j.backup) : null;
    if (j.backup && backupPresent!==j.beforeSha256) {
      // The journal is now committed before the backup. A crash before the
      // backup exists is recoverable only when original settings are intact.
      const originalIntact=(j.state==='PREPARED' && backupPresent===null &&
                            fileHash(j.settingsPath)===j.beforeSha256);
      if(!originalIntact)fail('SETTINGS_BACKUP_CHANGED');
    }
    // Validate every owned agent hash before changing ANYTHING.
    for (const a of j.agents) if (fileHash(a.path)!==null && fileHash(a.path)!==a.sha256) fail('OWNED_AGENT_CHANGED_REFUSE_ROLLBACK');
    for (const r of j.rules || []) if(fileHash(r.path)!==null && fileHash(r.path)!==r.sha256)fail('OWNED_WORKFLOW_RULE_CHANGED_REFUSE_ROLLBACK');
    for (const a of j.skills || []) if(fileHash(a.path)!==null && fileHash(a.path)!==a.sha256)fail('OWNED_SKILL_CHANGED_REFUSE_ROLLBACK');
    const current = fileHash(j.settingsPath);
    const mergeComplete=Boolean(ownedMerge&&current===ownedMerge.data.afterSha);
    const restoreComplete=Boolean(ownedRestore&&current===ownedRestore.data.toSha);
    if(ownedMerge&&!mergeComplete&&current!==ownedMerge.data.beforeSha)
      fail('CLAUDE_ROLLBACK_MERGE_SETTINGS_CHANGED');
    if(ownedRestore&&!restoreComplete&&current!==ownedRestore.data.fromSha)
      fail('CLAUDE_ROLLBACK_RESTORE_SETTINGS_CHANGED');
    if(!mergeComplete && current!==j.afterSha256 && current!==j.beforeSha256 && current!==null)
      checkRepoqlOwnership(readObject(j.settingsPath),j.repoqlPluginOwned);
    // If existing user settings disappeared after configuration, do not finish
    // rollback by deleting the receipt. That would lose the only reference to
    // the protected backup and strand the original settings. Never guess that
    // another application intended those settings to be permanently removed.
    if (j.backup && current === null) fail('USER_SETTINGS_MISSING_MANUAL_RECOVERY_REQUIRED');
    // A pre-existing Singularity hook may have been legitimately present before
    // this installer ran. If the user subsequently edited settings, a generic
    // `removeMemoryIntegration` would remove that PRE-EXISTING hook as well.
    // Without a three-way, ownership-aware merge, refuse and retain the journal
    // and backup rather than silently deleting pre-install functionality.
    if (!mergeComplete && current !== j.afterSha256 && current !== j.beforeSha256 &&
        current !== null && j.backup) {
      const original = readObject(j.backup);
      const ownedPaths = [j.scriptPath, String(j.scriptPath).replace(/memory-hook\.mjs$/i,'doc-hook.mjs')];
      const hasOriginalHook = ['SubagentStart','SubagentStop','SessionStart','Stop','SessionEnd'].some(event =>
        (Array.isArray(original.hooks?.[event]) ? original.hooks[event] : []).some(group =>
          (Array.isArray(group?.hooks) ? group.hooks : []).some(handler =>
            hookOwnership(handler,{scriptPaths:ownedPaths}))));
      const hasOriginalOfficeHook=j.officeScript && Object.keys(OFFICE_EVENTS).some(event =>
        (Array.isArray(original.hooks?.[event])?original.hooks[event]:[]).some(group =>
          (Array.isArray(group?.hooks)?group.hooks:[]).some(h => isOfficeHandler(h,j.officeScript))));
      if (hasOriginalHook || hasOriginalOfficeHook) fail('PREEXISTING_HOOKS_REQUIRE_MANUAL_MERGE');
    }
    if (current===j.afterSha256) {
      if (j.backup && backupPresent!==null) {
        if(!ownedRestore){
          j.rollbackRestore={fromSha:current,toSha:j.beforeSha256,
            tmp:j.settingsPath+'.restore-'+randomUUID()};
          atomicWrite(receiptPath,json(j));
        }
        if(fileHash(j.settingsPath)!==current)fail('CLAUDE_ROLLBACK_RESTORE_SOURCE_CHANGED');
        if(!ownedRestore?.tempPresent)writeExclusive(j.rollbackRestore.tmp,readFileSync(j.backup));
        renameSync(j.rollbackRestore.tmp,j.settingsPath);
      } else if (j.backup && current!==j.beforeSha256) fail('SETTINGS_BACKUP_REQUIRED_FOR_RECOVERY');
      else if (current!==null) rmSync(j.settingsPath);
    } else if (current!==j.beforeSha256 && current!==null && !mergeComplete) {
      const settings=readObject(j.settingsPath);
      const removed=removeMemoryIntegration(settings,{scriptPath:j.scriptPath,env:j.env});
      const officeClean=j.variant===2 && j.officeScript
        ? removeOfficeHooks(removed.settings,j.officeScript,j.nodeExe,j.env?.OFFICE_CONFIG) : removed.settings;
      // fleet#993: strip parent-proxy env only where the value is still ours.
      const proxyClean=j.parentMemory
        ? removeMainMemoryIntegration(officeClean,{mainMemory:{envWritten:j.parentMemory.envWritten}},j.parentMemory.prevEnv||{})
        : {settings:officeClean,changedKeys:[]};
      const cleaned=removeOwnedRepoqlPlugin(proxyClean.settings,j.repoqlPluginOwned);
      // A map emptied by our own removals must not survive as `env: {}` when the
      // pre-install settings had no env object (or an empty one).
      if(cleaned.env && typeof cleaned.env==='object' && !Array.isArray(cleaned.env) &&
         Object.keys(cleaned.env).length===0){
        const pre=j.backup ? readObject(j.backup) : null;
        const preEnv=pre && typeof pre.env==='object' && !Array.isArray(pre.env) ? pre.env : null;
        if(!preEnv || Object.keys(preEnv).length===0) delete cleaned.env;
      }
      if (removed.changed || proxyClean.changedKeys.length || !sameConfig(cleaned,settings)) {
        const bytes=json(cleaned),afterSha=HASH(bytes);
        if(ownedMerge){
          if(ownedMerge.data.beforeSha!==current||ownedMerge.data.afterSha!==afterSha)
            fail('CLAUDE_ROLLBACK_MERGE_RECOMPUTE_CHANGED');
        } else {
          j.rollbackMerge={beforeSha:current,afterSha,tmp:j.settingsPath+'.merge-'+randomUUID()};
          atomicWrite(receiptPath,json(j));
        }
        if(fileHash(j.settingsPath)!==current)fail('CLAUDE_ROLLBACK_SOURCE_CHANGED');
        if(!ownedMerge?.tempPresent)writeExclusive(j.rollbackMerge.tmp,bytes);
        renameSync(j.rollbackMerge.tmp,j.settingsPath);
      }
    }
    for (const a of j.agents) guardedUnlink(a.path,a.sha256);
    for (const r of j.rules || []) guardedUnlink(r.path,r.sha256);
    for (const a of j.skills || []) {guardedUnlink(a.path,a.sha256);try{rmdirSync(dirname(a.path))}catch(e){if(e.code!=='ENOTEMPTY'&&e.code!=='EEXIST'&&e.code!=='ENOENT')throw e}}
    if (j.backup) guardedUnlink(j.backup,j.beforeSha256);
    if (ownedPending) guardedUnlink(ownedPending,j.afterSha256);
    if (ownedMerge?.tempPresent) guardedUnlink(ownedMerge.data.tmp,ownedMerge.data.afterSha);
    if (ownedRestore?.tempPresent) guardedUnlink(ownedRestore.data.tmp,ownedRestore.data.toSha);
    rmSync(receiptPath);
    return {state:'CLAUDE_CONFIGURATION_ROLLED_BACK',removedOwnedAgents:j.agents.length,removedOwnedRules:(j.rules||[]).length,removedOwnedSkills:(j.skills||[]).length,
      otherUserSettingsPreserved:true,externalServicesUntouched:true};
  } finally {closeSync(fd);rmSync(lock,{force:true});}
}

/** Read-only validation of the official Claude plugin's local cache. It checks
 * the installed registry, expected cache namespace, official plugin identity,
 * exact source-reviewed skill inventory, and canonical SKILL.md frontmatter.
 * Asset completeness is NOT proof of plugin loading in the native GUI.
 * No plugin code is executed and no plugin-owned files are modified. */
export function inspectRepoqlSkillAssets({home}) {
  const claude=join(home,'.claude');
  const registry=join(claude,'plugins','installed_plugins.json');
  const expected=[...REPOQL_PLUGIN_SKILLS];
  const base={pluginRegistered:false,cacheValidated:false,skillAssetsPresent:false,
    expected:expected.length,present:0,missing:expected,unexpected:[],
    invalid:[],pluginVersion:null,issues:[]};
  const issue=(value,code)=>{ if(!value.issues.includes(code)) value.issues.push(code); };
  let data;
  try {
    if(fileHash(registry)===null) {issue(base,'PLUGIN_INSTALL_REGISTRY_MISSING');return base;}
    data=readObject(registry);
  } catch {issue(base,'PLUGIN_INSTALL_REGISTRY_INVALID');return base;}
  const entries=data.plugins?.[REPOQL_CLAUDE_PLUGIN.id];
  if(!Array.isArray(entries) || !entries.length) {issue(base,'PLUGIN_NOT_REGISTERED');return base;}
  const cacheRoot=resolve(claude,'plugins','cache');
  let best=null;
  for(const entry of entries) {
    if(!entry || entry.scope!=='user' || typeof entry.installPath!=='string')continue;
    const dir=resolve(entry.installPath);
    // Only a user-scoped cache for this official plugin can satisfy a user's
    // Claude Code Complete installation. Other marketplace caches cannot.
    const parts=relative(cacheRoot,dir).split(sep);
    if(parts.length!==3 || parts[0]!==REPOQL_CLAUDE_PLUGIN.marketplace ||
       parts[1]!=='repoql' || !parts[2] || parts[2]==='..') continue;
    try {
      if(!pathLstat(dir)?.isDirectory()) continue;
      assertPlainAncestors(dir);
    } catch {continue;}
    const outcome={...base,pluginRegistered:true,missing:[...expected],unexpected:[],invalid:[],issues:[]};
    const manifestFile=join(dir,'.claude-plugin','plugin.json');
    let plugin;
    try {
      if(fileHash(manifestFile)===null)throw Error();
      plugin=readObject(manifestFile);
      if(plugin.name!=='repoql')throw Error();
      outcome.cacheValidated=true;
      outcome.pluginVersion=typeof plugin.version==='string'?plugin.version:null;
    } catch {issue(outcome,'PLUGIN_MANIFEST_MISSING_OR_INVALID');}
    const skillsRoot=join(dir,'skills');
    let observed=[];
    try {
      assertPlainAncestors(skillsRoot);
      if(!pathLstat(skillsRoot)?.isDirectory())throw Error();
      observed=readdirSync(skillsRoot,{withFileTypes:true})
        .filter(x=>x.isDirectory() || x.isSymbolicLink()).map(x=>x.name).sort();
    } catch {issue(outcome,'PLUGIN_SKILL_DIRECTORY_UNAVAILABLE');}
    outcome.unexpected=observed.filter(name=>!REPOQL_PLUGIN_SKILLS.includes(name));
    if(outcome.unexpected.length)issue(outcome,'PLUGIN_SKILL_INVENTORY_DRIFT');
    outcome.missing=[];
    for(const name of expected){
      const path=join(skillsRoot,name,'SKILL.md');
      try {
        assertPlainAncestors(path);
        const meta=pathLstat(path);
        if(!meta?.isFile() || meta.isSymbolicLink() || meta.size>256*1024 || meta.size===0)throw Error();
        const content=readFileSync(path,'utf8');
        const fm=/^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/.exec(content)?.[1];
        const title=fm && /^name:\s*([^\r\n]+)\s*$/m.exec(fm)?.[1].trim();
        if(title!==name)throw Error();
      } catch {
        outcome.missing.push(name);
        if(observed.includes(name))outcome.invalid.push(name);
      }
    }
    outcome.present=expected.length-outcome.missing.length;
    if(outcome.missing.length)issue(outcome,'PLUGIN_SKILLS_MISSING_OR_INVALID');
    if(!outcome.cacheValidated)issue(outcome,'PLUGIN_IDENTITY_UNVERIFIED');
    outcome.skillAssetsPresent=outcome.cacheValidated &&
      outcome.missing.length===0 && outcome.unexpected.length===0;
    if(outcome.skillAssetsPresent)return outcome;
    // Prefer the most complete, verified candidate without merging skill
    // files across different plugin versions (which could hide a bad install).
    if(!best || (Number(outcome.cacheValidated)*100+outcome.present)>
                (Number(best.cacheValidated)*100+best.present))best=outcome;
  }
  if(best)return best;
  issue(base,'PLUGIN_USER_SCOPE_OR_CACHE_INVALID');
  return base;
}

/** Offline configuration integrity only; NEVER reports backend or memory parity. */
export function verifyConfiguration({home}) {
  const claude=join(home,'.claude');
  const journalPath=join(claude,RECEIPT);
  for (const path of [home,claude,journalPath]) assertPlainAncestors(path);
  if (!existsSync(journalPath)) return {configured:false,runtimeVerified:false,issues:['NO_CONFIG_RECEIPT']};
  const j=readObject(journalPath);
  if (j.schema!=='singularity-claude-native-config/v1' || j.state!=='APPLIED' ||
      j.settingsPath!==join(claude,'settings.json') || ![1,2].includes(j.variant) ||
      !Array.isArray(j.agents) || j.agents.length>17 /* legacy journals may list up to 17 */ ||
      !Array.isArray(j.skills) || j.skills.length>CLAUDE_SKILLS.length || !j.nodeExe || !j.memoryConfig) fail('INVALID_CONFIG_RECEIPT');
  const issues=[];
  if(j.rollbackMerge!==undefined){ownedRollbackMerge(j);issues.push('ROLLBACK_MERGE_IN_PROGRESS')}
  if(j.rollbackRestore!==undefined){ownedRollbackRestore(j);issues.push('ROLLBACK_RESTORE_IN_PROGRESS')}
  if(j.rollbackMerge!==undefined&&j.rollbackRestore!==undefined)fail('CLAUDE_ROLLBACK_CONFLICTING_JOURNALS');
  if(ownedPendingSettings(j))issues.push('PENDING_SETTINGS_TEMP_REMAINS');
  try { verifyRoot(j.source,j.variant); } catch { issues.push('SOURCE_PROVENANCE_DRIFT'); }
  if (!existsSync(j.settingsPath)) issues.push('SETTINGS_MISSING');
  const memoryStat=pathLstat(j.memoryConfig);
  if (!memoryStat || !memoryStat.isFile() || memoryStat.isSymbolicLink()) issues.push('MEMORY_CONFIG_MISSING_OR_UNSAFE');
  const nodeStat=pathLstat(j.nodeExe);
  if (!nodeStat || !nodeStat.isFile() || nodeStat.isSymbolicLink()) issues.push('NODE_RUNTIME_MISSING_OR_UNSAFE');
  const settings=existsSync(j.settingsPath)?readObject(j.settingsPath):{};
  if (settings.env?.SINGULARITY_REPO_ROOT!==j.source ||
      settings.env?.SINGULARITY_MEMORY_CONFIG!==j.memoryConfig) issues.push('MEMORY_ENV_DRIFT');
  if(j.variant===2){
    if(!j.officeConfig || settings.env?.OFFICE_CONFIG!==j.officeConfig ||
       !pathLstat(j.officeConfig)?.isFile() || !validOfficeConfig(j.officeConfig))issues.push('OFFICE_CONFIG_DRIFT');
    const officeScript=join(j.source,'adapters','claude-code','office-hook.mjs');
    for(const [event,kind] of Object.entries(OFFICE_EVENTS)){
      const matches=[];
      for(const group of (Array.isArray(settings.hooks?.[event])?settings.hooks[event]:[]))
        for(const h of (Array.isArray(group?.hooks)?group.hooks:[]))
          if(isOfficeHandler(h,officeScript))matches.push({h,group});
      const want={type:'command',command:j.nodeExe,args:[officeScript,kind]};
      if(matches.length!==1 || matches[0].group.matcher!==undefined || !sameConfig(matches[0].h,want))
        issues.push(`OFFICE_HOOK_${event.toUpperCase()}_DRIFT`);
    }
  }

  if(j.repoqlPluginOwned!==undefined) {
    if(!approvedRepoqlMarketplace(settings.extraKnownMarketplaces?.[REPOQL_CLAUDE_PLUGIN.marketplace]) ||
       settings.enabledPlugins?.[REPOQL_CLAUDE_PLUGIN.id]!==true ||
       settings.env?.REPOQL_NO_BOOTSTRAP!=='1') issues.push('REPOQL_PLUGIN_REQUEST_DRIFT');
  } else issues.push('REPOQL_PLUGIN_NOT_CONFIGURED');
  const docScript=j.scriptPath.replace(/memory-hook\.mjs$/i,'doc-hook.mjs');
  // Two memory-hook kinds share the Stop event (doc closeout + parent turn), so
  // the expected set is a table, not an event→kind map.
  const expectedHooks=[
    {event:'SubagentStart',kind:'subagent-start',script:j.scriptPath},
    {event:'SubagentStop',kind:'subagent-stop',script:j.scriptPath},
    {event:'SessionStart',kind:'session-start',script:docScript},
    {event:'Stop',kind:'stop',script:docScript},
    {event:'Stop',kind:'conversation-turn',script:j.scriptPath},
    {event:'SessionEnd',kind:'session-end',script:j.scriptPath},
  ];
  for (const expected of expectedHooks) {
    const groups=settings.hooks?.[expected.event] || [];
    const owned=[];
    for (const group of (Array.isArray(groups)?groups:[])) {
      for (const h of (Array.isArray(group.hooks)?group.hooks:[])) {
        const matched=hookOwnership(h,{scriptPaths:[j.scriptPath,docScript]});
        if (matched?.kind===expected.kind) owned.push({h,group});
      }
    }
    const drift=expected.kind==='conversation-turn'
      ? `HOOK_${expected.event.toUpperCase()}_CONVERSATION_TURN_DRIFT`
      : `HOOK_${expected.event.toUpperCase()}_DRIFT`;
    if (owned.length!==1 || owned[0].h.type!=='command' ||
        owned[0].h.command!==j.nodeExe ||
        !Array.isArray(owned[0].h.args) || owned[0].h.args.length!==2 ||
        owned[0].h.args[0]!==expected.script || owned[0].h.args[1]!==expected.kind ||
        (expected.script===docScript && owned[0].h.timeout!==DOC_HOOK_TIMEOUT_SECONDS) ||
        owned[0].group.matcher!==undefined) issues.push(drift);
  }
  const rule=join(claude,'rules','singularity-workflow.md');
  const expectedRule=join(j.source,'adapters','claude-code','singularity-workflow.md');
  if(fileHash(rule)!==fileHash(expectedRule)||fileHash(rule)===null)issues.push('WORKFLOW_RULE_DRIFT');
  const agentsDir=join(claude,'agents');
  for(const name of NAMES) {
    const target=join(agentsDir,`${name}.md`);
    assertPlainAncestors(target);
    const sourceFile=join(j.source,'adapters','claude-code','agents',`${name}.md`);
    const original=fileHash(sourceFile),installed=fileHash(target);
    if (original===null || installed===null || installed!==original) issues.push('AGENT_DEFINITION_DRIFT');
  }
  for(const name of skillsFor(j.variant)) {
    const target=join(claude,'skills',name,'SKILL.md');
    const sourceFile=join(j.source,'openchamber','skills',name,'SKILL.md');
    assertPlainAncestors(target);
    const expected=fileHash(sourceFile)===null ? null : HASH(renderClaudeSkill(name,readFileSync(sourceFile)));
    const actual=fileHash(target);
    if(expected===null||actual!==expected)issues.push('SKILL_DEFINITION_DRIFT');
  }
  const repoqlAssets=inspectRepoqlSkillAssets({home});
  return {configured:issues.length===0,variant:j.variant,agentsExpected:NAMES.length,skillsExpected:skillsFor(j.variant).length,hookEventsExpected:expectedHookEvents(j.variant),
    issues:[...new Set(issues)],runtimeVerified:false,officeRuntimeVerified:false,ghostRuntimeVerified:false,
    repoqlPluginRequested:j.repoqlPluginOwned!==undefined,officeEventHooksConfigured:j.variant===2 && !issues.some(x=>x.startsWith('OFFICE_')),
    officeEventHooksVerified:false,repoqlPluginSkillAssets:repoqlAssets,
    repoqlPluginCacheComplete:repoqlAssets.skillAssetsPresent,
    repoqlPluginSkillsVerified:false,repoqlRuntimeVerified:false};
}

function parse(argv) {
  const options={};
  for (let i=0;i<argv.length;i++) {
    const arg=argv[i];
    if (!['--mode','--variant','--source','--home','--node-exe','--memory-config','--office-config','--apply'].includes(arg)) fail('UNKNOWN_ARGUMENT');
    if (arg==='--apply') {options.apply=true;continue;}
    if (!argv[i+1] || argv[i+1].startsWith('--')) fail('MISSING_ARGUMENT');
    if (options[arg]!==undefined) fail('DUPLICATE_ARGUMENT');
    options[arg]=argv[++i];
  }
  return options;
}
function main(argv) {
  const o=parse(argv);
  const mode=o['--mode']||'plan';
  if (!['plan','apply','rollback','verify'].includes(mode)) fail('MODE_REQUIRED');
  if (['apply','rollback'].includes(mode) && (process.platform!=='win32' || !o.apply)) fail('WINDOWS_EXPLICIT_APPLY_REQUIRED');
  const nodeExe=['rollback','verify'].includes(mode) ? undefined : (o['--node-exe'] || resolveNodeExe());
  if (process.platform==='win32') {
    for (const field of ['--home', ...(['rollback','verify'].includes(mode)?[]:['--source','--memory-config',...(Number(o['--variant'])===2?['--office-config']:[])])])
      localWindowsPath(o[field],field);
    if (nodeExe) localWindowsPath(nodeExe,'--node-exe');
  }
  if (mode==='verify') {
    process.stdout.write(JSON.stringify(verifyConfiguration({home:o['--home']}))+'\n');return;
  }
  if (mode==='rollback') {
    process.stdout.write(JSON.stringify(rollbackConfiguration({home:o['--home']}))+'\n');return;
  }
  const config={source:o['--source'],home:o['--home'],nodeExe,memoryConfig:o['--memory-config'],officeConfig:o['--office-config'],variant:Number(o['--variant'])};
  if (mode==='plan') {
    const p=prepareConfiguration(config);
    process.stdout.write(JSON.stringify({state:'CLAUDE_CONFIGURATION_PLAN_ONLY',variant:p.variant,
      agents:NAMES.length,agentsToCreate:p.agentWrites.filter(x=>x.create).length,skills:skillsFor(p.variant).length,skillsToCreate:p.skillWrites.filter(x=>x.create).length,
      settingsChanged:p.changedSettings,officeEventHooksPlanned:p.variant===2,repoqlPluginRequested:true,repoqlPluginSkillsVerified:false,fullProductInstalled:false,
      warning:'Official RepoQL plugin is requested via Claude settings, but skills, marketplace consent and rql runtime remain unverified until the native GUI completes installation'})+'\n');return;
  }
  process.stdout.write(JSON.stringify(applyConfiguration(config))+'\n');
}
if (process.argv[1] && fileURLToPath(import.meta.url)===resolve(process.argv[1])) {
  try {main(process.argv.slice(2));}catch(e){
    // Never include path, settings contents or memory configuration in diagnostics.
    const code = String(e?.message || '');
    process.stderr.write('CLAUDE_NATIVE_CONFIG_REJECTED: '+(/^[A-Z][A-Z0-9_ :]{0,100}$/.test(code) ? code : 'INVALID_OR_UNSAFE_CONFIGURATION')+'\n');
    process.exitCode=2;
  }
}
