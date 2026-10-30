#!/usr/bin/env node
/**
 * Claude Code Complete (Option 2) delegated MemoryCore profile acceptance.
 * Explicit identity map binds the eight delegated roles to EXISTING shared
 * identities. Never seed Ghost or nine main-session roles here.
 *
 * plan    : local, read-only identity/parent-route inspection, no network.
 * verify  : authenticated LIVE readbacks for all eight roles; no writes.
 * seed    : explicit Windows --apply; idempotent seeding and live verification.
 *
 * A successful profile receipt says NOTHING about parent-session capture,
 * Ghost isolation, RepoQL indexing, or Claude Desktop execution.
 */
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { AGENT_MAP } from '../../adapters/claude-code/agent-map.mjs';
import { classifyMainMemoryState, resolveMainProxyUrl } from '../../adapters/claude-code/main-memory.mjs';
import { loadGhostMemoryConfig } from '../../scripts/memory-config-loader.mjs';
import { loadIdentityMap, provisionAgentProfiles } from '../../scripts/setup-agent-profiles.mjs';

const ROOT=resolve(dirname(fileURLToPath(import.meta.url)),'../..');
export const DELEGATED_ROLES=Object.freeze(Object.values(AGENT_MAP)
  .filter(item=>item.surface==='subagent' && item.memoryAgentId)
  .map(item=>item.memoryAgentId).sort());
export const MAIN_ROLES=Object.freeze(Object.entries(AGENT_MAP)
  .filter(([,item])=>item.surface==='main').map(([name])=>name).sort());
function reject(message){throw new Error(message)}

/** Validate the entire mapped delegated namespace BEFORE any network calls. */
export function validateDelegatedMap(map){
  if(!map || typeof map!=='object'||Array.isArray(map))reject('IDENTITY_MAP_REQUIRED');
  const seen=new Set();
  for(const name of DELEGATED_ROLES){
    const id=map[name];
    if(id && (typeof id!=='object'||Array.isArray(id)||
      Object.keys(id).sort().join(',')!=='agent_id,team_id,user_id'))
      reject('DELEGATED_IDENTITY_SHAPE_INVALID');
    if(!id || !['team_id','user_id','agent_id'].every(field=>
      typeof id[field]==='string' && id[field].trim()===id[field] &&
      id[field].length>=1 && id[field].length<=128))reject('DELEGATED_IDENTITY_MISSING_OR_INVALID');
    if(id.team_id.toLowerCase()==='ghost-companion'||id.agent_id.toLowerCase()==='ghost')
      reject('GHOST_MEMORY_SCOPE_FORBIDDEN');
    const key=JSON.stringify([id.team_id,id.user_id,id.agent_id]);
    if(seen.has(key))reject('DELEGATED_IDENTITY_COLLISION');
    seen.add(key);
  }
  return {delegatedRoles:DELEGATED_ROLES.length,mainRolesExcluded:MAIN_ROLES.length,
    ghostExcluded:true,identityMapValidated:true};
}

function readJsonObject(path){
  const raw=readFileSync(path);
  if(raw.length>64*1024)reject('CONFIG_FILE_TOO_LARGE');
  const v=JSON.parse(raw.toString('utf8'));
  if(!v||typeof v!=='object'||Array.isArray(v))reject('CONFIG_NOT_OBJECT');
  return v;
}

/** Receipts intentionally contain NO credentials, user IDs, URLs or content. */
export async function assessDelegatedProfiles({mode='plan',map,cfg,agentsDir,ledgerPath,
  settings={},proxyUrl=resolveMainProxyUrl(),fetchImpl=globalThis.fetch,
  env={},now, platform=process.platform,apply=false}={}){
  if(!['plan','verify','seed'].includes(mode))reject('UNKNOWN_PROFILE_MODE');
  const inventory=validateDelegatedMap(map);
  const parent=classifyMainMemoryState(settings,proxyUrl);
  const receipt={schema:'singularity-claude-complete-memory-profiles/v1',variant:2,
    mode,delegatedRoles:DELEGATED_ROLES.length,mainRolesExcluded:MAIN_ROLES.length,
    ghostExcluded:true,identityMapValidated:true,
    parentSession:{state:parent.state,liveVerified:false},
    repoqlVerified:false,officeVerified:false,ghostMemoryIsolationVerified:false,
    claudeDesktopVerified:false,profileReadbacksVerified:false,
    seedOperationsPermitted:false,releaseReady:false,results:[],issues:[]};
  if(parent.state!=='CONFIGURED')receipt.issues.push('PARENT_MEMORY_PROXY_NOT_CONFIGURED');
  if(mode==='plan'){
    receipt.issues.push('LIVE_MEMORYCORE_READBACK_REQUIRED');
    return receipt;
  }
  if(!cfg?.baseUrl || !cfg?.gatewayKey && !cfg?.userKey)
    reject('MEMORYCORE_AUTH_CONFIG_REQUIRED');
  const url=new URL(cfg.baseUrl);
  if(!['http:','https:'].includes(url.protocol)||url.username||url.password||
    !['127.0.0.1','localhost','[::1]'].includes(url.hostname))
    reject('MEMORYCORE_NON_LOOPBACK_REFUSED');
  if(mode==='seed' && (!apply || platform!=='win32'))reject('WINDOWS_EXPLICIT_APPLY_REQUIRED');
  receipt.seedOperationsPermitted=mode==='seed';
  const out=await provisionAgentProfiles({agentsDir,ledgerPath,agentNames:DELEGATED_ROLES,
    identityMap:map,verifyOnly:mode==='verify',cfg,env,fetchImpl,now});
  receipt.results=out.results.map(({name,status})=>({role:name,status}));
  receipt.profileReadbacksVerified=out.failed===0 && mode==='verify' &&
    receipt.results.every(x=>x.status==='verified');
  // Seed succeeds only when live search independently corroborates all eight.
  if(mode==='seed' && out.failed===0){
    const verify=await provisionAgentProfiles({agentsDir,ledgerPath,agentNames:DELEGATED_ROLES,
      identityMap:map,verifyOnly:true,cfg,env,fetchImpl,now});
    receipt.profileReadbacksVerified=verify.failed===0 &&
      verify.results.every(x=>x.status==='verified');
    if(!receipt.profileReadbacksVerified)receipt.issues.push('POST_SEED_READBACK_INCOMPLETE');
  }
  if(out.failed)receipt.issues.push('DELEGATED_PROFILES_MISSING_OR_UNREACHABLE');
  if(receipt.profileReadbacksVerified)receipt.issues.push('PARENT_AND_GHOST_LIVE_ACCEPTANCE_OUTSTANDING');
  return receipt;
}

function parseArgs(argv){
  const allowed=new Set(['--identity-map','--memory-config','--ledger','--agents-dir','--settings','--proxy-url','--apply']);
  const parsed={};
  for(let i=0;i<argv.length;i++){
    const k=argv[i];if(!allowed.has(k)||Object.hasOwn(parsed,k))reject('INVALID_ARGUMENTS');
    if(k==='--apply'){parsed[k]=true;continue;}
    if(i+1>=argv.length||argv[i+1].startsWith('--'))reject('ARGUMENT_VALUE_REQUIRED');
    parsed[k]=argv[++i];
  }
  return parsed;
}
async function main(argv){
  const mode=argv.shift();
  if(!['plan','seed','verify'].includes(mode))reject('usage: plan|verify|seed --identity-map FILE --memory-config FILE [--settings FILE] [--apply for seed]');
  const args=parseArgs(argv);
  if(!args['--identity-map']||!args['--memory-config'])reject('IDENTITY_AND_MEMORY_CONFIG_REQUIRED');
  if(mode==='seed'&&!args['--ledger'])reject('PRIVATE_LEDGER_PATH_REQUIRED_FOR_SEED');
  const identityMap=loadIdentityMap(args['--identity-map']);
  const settings=args['--settings']?readJsonObject(args['--settings']):{};
  if(!existsSync(args['--memory-config']))reject('MEMORY_CONFIG_MISSING');
  readJsonObject(args['--memory-config']);
  const cfg=loadGhostMemoryConfig({SINGULARITY_MEMORY_CONFIG:args['--memory-config']});
  const result=await assessDelegatedProfiles({mode,map:identityMap,cfg,settings,
    agentsDir:args['--agents-dir']||join(ROOT,'openchamber','agents'),
    ledgerPath:args['--ledger']||join(ROOT,'data','agent-profiles','ledger.json'),
    proxyUrl:args['--proxy-url']||resolveMainProxyUrl(),apply:!!args['--apply']});
  process.stdout.write(JSON.stringify(result,null,2)+'\n');
  // A successful plan or eight-role verification can exit zero without
  // claiming parent memory, Ghost, RepoQL or product release acceptance.
  return mode==='plan' || result.profileReadbacksVerified ? 0 : 1;
}
if(process.argv[1] && resolve(process.argv[1])===fileURLToPath(import.meta.url)){
  try{process.exitCode=await main(process.argv.slice(2));}
  catch(e){
    const code=/^[A-Z0-9_]+$/.test(String(e?.message||''))?e.message:'INVALID_CONFIGURATION_OR_BACKEND';
    process.stderr.write(`CLAUDE_COMPLETE_MEMORY_ACCEPTANCE_REFUSED: ${code}\n`);process.exitCode=2;
  }
}
