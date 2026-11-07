#!/usr/bin/env node
/**
 * Narrow, reversible project-scoped MCP installer for native Windows variants.
 * Claude Code -> <workspace>/.mcp.json. OpenChamber (OpenCode 2) ->
 * <workspace>/opencode.json. No user/global settings, credentials or shell.
 * This is MCP registration only; binaries must be installed independently.
 */
import { existsSync, readFileSync, lstatSync, mkdirSync, openSync, closeSync, writeFileSync, fsyncSync, renameSync, unlinkSync } from 'node:fs';
import { join, dirname, resolve, win32 } from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { localWindowsPath } from './plan_claude_code_windows.mjs';
const own = ['repoql','kanzo'];
// Option 2 uses the official Claude Code RepoQL plugin, which already owns
// the RepoQL MCP server. Project scope only adds Kanzo for that option.
const projectServers = variant => variant === 2 ? ['kanzo'] : own;
const digest = x => createHash('sha256').update(x).digest('hex');
const encode = x => Buffer.from(JSON.stringify(x,null,2)+'\n');
const err = message => { throw new Error(message); };
const jname = '.singularity-native-mcp-receipt.json';
const lockname = '.singularity-native-mcp.lock';

// Only a native executable verified as the release pin may be registered.
// A newer official RepoQL release needs the connector ABI and end-to-end tests
// re-run and the release policy migrated before it is accepted.
export function readRqlVersion(text) {
  const output=String(text).trim();
  const bare=/^v?(\d+\.\d+\.\d+)$/i.exec(output);
  if(bare)return bare[1];
  if(output.split(/\r?\n/).some(line=>/^v?\d+\.\d+\.\d+$/i.test(line.trim())))return null;
  const versions=[...output.matchAll(/\b(?:repoql|rql)\b[^\r\n]{0,64}?\bv?(\d+\.\d+\.\d+)\b/gi)].map(m=>m[1]);
  return new Set(versions).size===1 ? versions[0] : null;
}
function verifyInstalledRepoql(rql) {
  if(process.platform!=='win32')return;
  const result=spawnSync(rql,['--version'],{encoding:'utf8',windowsHide:true,timeout:10000,shell:false,maxBuffer:8192});
  if(result.error || result.status!==0 || readRqlVersion(result.stdout)!=='1.7.18')err('REPOQL_RELEASE_PIN_UNVERIFIED_RUN_CONNECTOR_MIGRATION');
}

function plainPath(p) {
  let current = resolve(p);
  while (true) {
    if (existsSync(current)) {
      const st=lstatSync(current);
      if (st.isSymbolicLink() || (current !== resolve(p) && !st.isDirectory())) err('REPARSE_OR_NON_DIRECTORY');
    }
    const parent=dirname(current);if(parent===current)break;current=parent;
  }
}
function fileHash(p) {
  if(!existsSync(p))return null;
  const s=lstatSync(p);if(!s.isFile()||s.isSymbolicLink())err('REPARSE_OR_NON_FILE');
  return digest(readFileSync(p));
}
function readConfig(p){if(!existsSync(p))return {};const x=JSON.parse(readFileSync(p,'utf8'));if(!x||typeof x!=='object'||Array.isArray(x))err('INVALID_CONFIG_OBJECT');return x;}
function atomic(p,b){const tmp=`${p}.pending-${randomUUID()}`;const fd=openSync(tmp,'wx',0o600);try{writeFileSync(fd,b);fsyncSync(fd)}finally{closeSync(fd)}try{renameSync(tmp,p)}catch(e){if(existsSync(tmp))unlinkSync(tmp);throw e}}
function binary(p,name,allowFixture=false){if(!allowFixture)localWindowsPath(p,name);if(win32.basename(p).toLowerCase()!==name+'.exe')err('INVALID_EXECUTABLE_NAME');return p;}
export function buildMcpPlan({variant,workspace,rqlExe,kanzoExe,ombExe=null,nodeExe=null,existing={},allowFixture=false}) {
  if(![1,2,3,4].includes(variant))err('INVALID_VARIANT');
  if(!allowFixture || process.platform==='win32')localWindowsPath(workspace,'workspace');
  const rql=binary(rqlExe,'rql',allowFixture && process.platform!=='win32'),kanzo=binary(kanzoExe,'kanzo',allowFixture && process.platform!=='win32');
  if(Boolean(ombExe)!==Boolean(nodeExe))err('OPENMAUSBOT_REQUIRES_BOTH_EXECUTABLES');
  if(ombExe && variant!==2)err('OPENMAUSBOT_CLAUDE_CODE_OPTION2_ONLY');
  if(ombExe){binary(ombExe,'openmausbot',allowFixture && process.platform!=='win32');binary(nodeExe,'node',allowFixture && process.platform!=='win32');}
  if(!existing||typeof existing!=='object'||Array.isArray(existing))err('INVALID_EXISTING');
  const claude=variant<3;
  // Project MCP clients execute local stdio programs without using shell/PATH.
  // Do not register RepoQL twice in Claude Code Complete: its official plugin
  // is the primary RepoQL MCP provider for this variant.
  const entries=claude ? {
    ...(variant===2?{}:{repoql:{type:'stdio',command:rql,args:['mcp']}}),
    kanzo:{type:'stdio',command:kanzo,args:['mcp']},
    ...(ombExe?{openmausbot:{type:'stdio',command:nodeExe,
      args:[fileURLToPath(new URL('./openmausbot/claude_mcp_launcher.mjs',import.meta.url))],
      env:{SINGULARITY_OMB_EXE:ombExe,SINGULARITY_OMB_PORT:'8799'}}}:{}),
  } : {
    repoql:{type:'local',command:[rql,'mcp']},
    kanzo:{type:'local',command:[kanzo,'mcp']},
  };
  const serverMap=claude?(existing.mcpServers??{}):(existing.mcp?.servers??{});
  if(!serverMap||typeof serverMap!=='object'||Array.isArray(serverMap))err('INVALID_EXISTING_MCP_MAP');
  if(!claude && existing.mcp !== undefined && (!existing.mcp||typeof existing.mcp!=='object'||Array.isArray(existing.mcp)))err('INVALID_EXISTING_MCP');
  // If RepoQL is already registered at project scope, this variant cannot
  // claim plugin-only routing. Refuse, leaving the existing file untouched.
  if(variant===2 && Object.hasOwn(serverMap,'repoql'))err('REPOQL_PLUGIN_PROJECT_MCP_OVERLAP');
  // Never replace an existing managed server, even if its name collides.
  const names=[...projectServers(variant),...(ombExe?['openmausbot']:[])];
  for(const n of names)if(Object.hasOwn(serverMap,n) && JSON.stringify(serverMap[n])!==JSON.stringify(entries[n]))err('FOREIGN_MCP_CONFLICT_'+n);
  const next=structuredClone(existing);
  if(claude)next.mcpServers={...serverMap,...entries};
  else {next.$schema ??= 'https://opencode.ai/config.json';next.mcp={...(existing.mcp||{}),servers:{...serverMap,...entries}};}
  return {schema:'singularity-native-mcp-project/v1',variant,kind:claude?'claude-code-project':'openchamber-opencode2-project',
    workspace,filename:claude?'.mcp.json':'opencode.json',registered:names,
    configuration:next,requires:variant===2
      ? ['native-rql-exe-version-1.7.18','official-repoql-plugin-mcp-and-skills',
         'native-kanzo-exe','rql-connector-smoke','kanzo-mcp-tool-smoke','gui-approval-and-discovery']
      : ['native-rql-exe','native-kanzo-exe','rql-connector-smoke','kanzo-mcp-tool-smoke','gui-approval-and-discovery'],
    runtimeVerified:false};
}
export function prepareProjectMcp({variant,workspace,rqlExe,kanzoExe,ombExe=null,nodeExe=null,allowFixture=false}) {
  // Testable on an isolated filesystem; CLI --apply requires real Windows.
  const file=join(workspace,variant<=2?'.mcp.json':'opencode.json');
  const receipt=join(workspace,jname);
  plainPath(file);plainPath(receipt);plainPath(workspace);
  if(!existsSync(workspace)||!lstatSync(workspace).isDirectory())err('WORKSPACE_MISSING');
  if(existsSync(receipt))err('OUTSTANDING_MCP_RECEIPT');
  const binaries=[rqlExe,kanzoExe,...(ombExe?[ombExe,nodeExe]:[])];
  for(const p of binaries){plainPath(p);if(!existsSync(p)||!lstatSync(p).isFile())err('MCP_BINARY_NOT_INSTALLED');}
  // Fixture mode (source-package tests/extracted-module contracts) uses placeholder
  // binaries that cannot execute; the release pin is checked by the CLI apply path.
  if(!allowFixture)verifyInstalledRepoql(rqlExe);
  if(variant>2 && existsSync(join(workspace,'opencode.jsonc')))err('EXISTING_OPENCODE_JSONC_REQUIRES_MANUAL_MERGE');
  const before=fileHash(file);
  const plan=buildMcpPlan({variant,workspace,rqlExe,kanzoExe,ombExe,nodeExe,existing:readConfig(file),allowFixture:allowFixture||process.platform!=='win32'});
  return {...plan,file,receipt,before,after:digest(encode(plan.configuration))};
}
export function applyProjectMcp(opts){
  const p=prepareProjectMcp(opts), lock=join(p.workspace,lockname);
  const fd=openSync(lock,'wx',0o600);
  try{
    if(fileHash(p.file)!==p.before||existsSync(p.receipt))err('CONCURRENT_CHANGE');
    const backup=p.before?`${p.file}.singularity-backup-${randomUUID()}`:null;
    if(backup){const data=readFileSync(p.file);const bf=openSync(backup,'wx',0o600);try{writeFileSync(bf,data);fsyncSync(bf)}finally{closeSync(bf)}}
    // Persist the exact pending file name BEFORE writing any configuration
    // bytes. A crashed process must not strand an untracked copy containing
    // foreign MCP config or credentials.
    const pendingTmp=`${p.file}.pending-${randomUUID()}`;
    const receipt={schema:'singularity-native-mcp-rollback/v1',variant:p.variant,
      file:p.file,backup,before:p.before,after:p.after,pendingTmp,registered:p.registered};
    atomic(p.receipt,encode(receipt));
    const pendingFd=openSync(pendingTmp,'wx',0o600);
    try{writeFileSync(pendingFd,encode(p.configuration));fsyncSync(pendingFd)}finally{closeSync(pendingFd)}
    renameSync(pendingTmp,p.file);
    return {applied:true,variant:p.variant,receipt:p.receipt,registered:p.registered,runtimeVerified:false};
  } finally{closeSync(fd);unlinkSync(lock)}
}
const ownedSuffix=/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
function pendingOwned(r) {
  // M39–M65 receipts have no pendingTmp; tolerate them for rollback but do
  // not guess or delete other pending files.
  if(r.pendingTmp===undefined)return null;
  const prefix=r.file+'.pending-';
  if(typeof r.pendingTmp!=='string'||!r.pendingTmp.startsWith(prefix)||
     !ownedSuffix.test(r.pendingTmp.slice(prefix.length)))err('MCP_PENDING_TEMP_UNOWNED');
  plainPath(r.pendingTmp);
  let st;try{st=lstatSync(r.pendingTmp)}catch(e){if(e.code==='ENOENT')return null;throw e}
  if(!st.isFile()||st.isSymbolicLink()||fileHash(r.pendingTmp)!==r.after)
    err('MCP_PENDING_TEMP_DRIFT');
  return r.pendingTmp;
}
function restoreOwned(r){
 if(r.restoreTmp===undefined)return null; // Legacy and pre-rollback receipt
 if(!r.before)err('MCP_RESTORE_TEMP_WITHOUT_ORIGINAL');
 const prefix=r.file+'.restore-';
 if(typeof r.restoreTmp!=='string'||!r.restoreTmp.startsWith(prefix)||
    !ownedSuffix.test(r.restoreTmp.slice(prefix.length)))err('MCP_RESTORE_TEMP_UNOWNED');
 plainPath(r.restoreTmp);
 let st;try{st=lstatSync(r.restoreTmp)}catch(e){if(e.code==='ENOENT')return null;throw e}
 if(!st.isFile()||st.isSymbolicLink()||fileHash(r.restoreTmp)!==r.before)
   err('MCP_RESTORE_TEMP_DRIFT');
 return r.restoreTmp;
}
function validateBackup(r){
  if(r.before!==null&&!/^[0-9a-f]{64}$/.test(r.before))err('INVALID_RECEIPT_BEFORE_HASH');
  if(r.before){
    if(typeof r.backup!=='string'||dirname(r.backup)!==dirname(r.file)||
       !r.backup.startsWith(r.file+'.singularity-backup-')||
       !ownedSuffix.test(r.backup.slice((r.file+'.singularity-backup-').length))||
       fileHash(r.backup)!==r.before)err('BACKUP_INVALID');
  }else if(r.backup!==null)err('MCP_UNEXPECTED_BACKUP');
}
export function rollbackProjectMcp({workspace}){
  const receipt=join(workspace,jname),lock=join(workspace,lockname);
  plainPath(receipt);if(!existsSync(receipt))err('NO_MCP_RECEIPT');
  const fd=openSync(lock,'wx',0o600);
  try{
    const r=readConfig(receipt);
    if(r.schema!=='singularity-native-mcp-rollback/v1'||![1,2,3,4].includes(r.variant)||
       r.file!==join(workspace,[1,2].includes(r.variant)?'.mcp.json':'opencode.json')||
       !/^[0-9a-f]{64}$/.test(r.after))err('INVALID_RECEIPT');
    plainPath(r.file);
    const pending=pendingOwned(r);
    const restore=restoreOwned(r);
    const actual=fileHash(r.file);
    if(actual!==r.after&&actual!==r.before)err('MCP_CONFIG_CHANGED_REFUSE_ROLLBACK');
    // Verify ALL rollback inputs before changing the original file. In an
    // interrupted apply, it may still contain the unchanged preinstall bytes.
    validateBackup(r);
    const interrupted=actual===r.before&&actual!==r.after;
    if(!interrupted){
      if(r.before){
        // Journal the exact secret-bearing restore temp BEFORE creating it.
        // An interrupted rollback can be resumed without guessing temp names.
        if(r.restoreTmp===undefined){
          r.restoreTmp=`${r.file}.restore-${randomUUID()}`;
          atomic(receipt,encode(r));
        }
        if(!restore){
          const rf=openSync(r.restoreTmp,'wx',0o600);
          try{writeFileSync(rf,readFileSync(r.backup));fsyncSync(rf)}finally{closeSync(rf)}
        }
        renameSync(r.restoreTmp,r.file);
      }else unlinkSync(r.file);
    }
    // If original settings are already restored, a verified leftover restore
    // temp is cleanup-only. Unknown or modified files remain untouched.
    const leftover=restoreOwned(r);
    if(leftover)unlinkSync(leftover);
    if(pending)unlinkSync(pending);
    if(r.backup)unlinkSync(r.backup);
    unlinkSync(receipt);
    return {rolledBack:true,variant:r.variant,interruptedApplyRecovered:interrupted,
            runtimeVerified:false,releaseReady:false};
  } finally{closeSync(fd);unlinkSync(lock)}
}
/** Read-only owned-install verification. A valid rollback journal is required;
 * a coincidentally matching Kanzo command without ownership is not acceptance. */
export function verifyProjectMcp({variant,workspace}) {
  if(variant!==2)err('OPTION2_VERIFIER_ONLY');
  const file=join(workspace,'.mcp.json'),receipt=join(workspace,jname);
  plainPath(file);plainPath(receipt);
  if(!existsSync(receipt))err('MCP_INSTALL_RECEIPT_MISSING');
  const r=readConfig(receipt);
  if(r.schema!=='singularity-native-mcp-rollback/v1'||r.variant!==2||r.file!==file||
     !/^[a-f0-9]{64}$/.test(r.after))err('MCP_INSTALL_RECEIPT_INVALID');
  if(pendingOwned(r))err('MCP_PENDING_TEMP_REMAINS');
  if(r.restoreTmp!==undefined){restoreOwned(r);err('MCP_ROLLBACK_IN_PROGRESS')}
  if(fileHash(file)!==r.after)err('MCP_CONFIG_CHANGED_AFTER_INSTALL');
  const config=readConfig(file);
  if(!config.mcpServers||typeof config.mcpServers!=='object'||Array.isArray(config.mcpServers)||
     !Object.hasOwn(config.mcpServers,'kanzo')||Object.hasOwn(config.mcpServers,'repoql')||
     config.mcpServers.kanzo?.type!=='stdio'||
     !Array.isArray(config.mcpServers.kanzo.args)||
     config.mcpServers.kanzo.args.length!==1||config.mcpServers.kanzo.args[0]!=='mcp')
    err('MCP_OPTION2_OWNERSHIP_DRIFT');
  const registered=Array.isArray(r.registered)?r.registered:['kanzo'];
  if(registered.includes('openmausbot')) {
    const entry=config.mcpServers.openmausbot;
    if(entry?.type!=='stdio'||!Array.isArray(entry.args)||entry.args.length!==1||
       !entry.args[0].replaceAll('\\','/').endsWith('/openmausbot/claude_mcp_launcher.mjs')||
       typeof entry.env?.SINGULARITY_OMB_EXE!=='string'||
       entry.env?.SINGULARITY_OMB_PORT!=='8799'||
       Object.hasOwn(entry.env,'OPENMAUSBOT_TOKEN'))err('OPENMAUSBOT_MCP_OWNERSHIP_DRIFT');
  }
  if(r.before){
    if(!r.backup||dirname(r.backup)!==dirname(file)||
       !r.backup.startsWith(file+'.singularity-backup-')||fileHash(r.backup)!==r.before)
      err('MCP_BACKUP_MISSING_OR_CHANGED');
  }else if(r.backup!==null)err('MCP_UNEXPECTED_BACKUP');
  return {installedConfigVerified:true,variant:2,registered,
          officialRepoqlPluginRuntimeVerified:false,kanzoRuntimeVerified:false,
          releaseReady:false};
}
function main(argv){
  const vals={};let command='plan';
  for(let i=0;i<argv.length;i++){
    if(['--apply','--rollback','--verify'].includes(argv[i])) {command=argv[i].slice(2);continue;}
    const key=argv[i].replace(/^--/,'');if(!['variant','workspace','rql-exe','kanzo-exe','omb-exe','node-exe'].includes(key)||i+1>=argv.length)err('USAGE');vals[key]=argv[++i];
  }
  if(!['plan','verify'].includes(command)&&process.platform!=='win32')err('WINDOWS_ONLY_MUTATION');
  const opts={variant:Number(vals.variant),workspace:vals.workspace,rqlExe:vals['rql-exe'],kanzoExe:vals['kanzo-exe'],ombExe:vals['omb-exe'],nodeExe:vals['node-exe']};
  if(command==='plan') {
    // A real Windows preview validates installed binaries and *actual* existing
    // project config but must never print foreign settings or possible secrets.
    const p=process.platform==='win32'?prepareProjectMcp(opts):buildMcpPlan({...opts,existing:{}});
    process.stdout.write(JSON.stringify({mode:'READ_ONLY',variant:p.variant,kind:p.kind,filename:p.filename,
      registered:p.registered,existingConfigChecked:process.platform==='win32',
      executables:p.configuration?.mcpServers?Object.fromEntries(Object.entries(p.configuration.mcpServers).filter(([k])=>own.includes(k)||k==='openmausbot')):
        Object.fromEntries(Object.entries(p.configuration?.mcp?.servers||{}).filter(([k])=>own.includes(k)||k==='openmausbot')),
      runtimeVerified:false},null,2)+'\n');return;
  }
  const out=command==='verify'?verifyProjectMcp({workspace:opts.workspace,variant:opts.variant}):
            command==='rollback'?rollbackProjectMcp({workspace:opts.workspace}):applyProjectMcp(opts);
  process.stdout.write(JSON.stringify(out,null,2)+'\n');
}
if(process.argv[1]&&fileURLToPath(import.meta.url)===resolve(process.argv[1]))try{main(process.argv.slice(2))}catch(e){process.stderr.write('SINGULARITY_MCP_CONFIG_REFUSED: '+e.message+'\n');process.exitCode=2}
