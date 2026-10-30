#!/usr/bin/env node
/** Read-only MemoryCore scoped search acceptance. No write, no auto-seeding.
 * A negative search alone is not proof of authorization isolation.
 */
import {existsSync,lstatSync,readFileSync,openSync,closeSync,writeFileSync} from 'node:fs';
import {resolve} from 'node:path';
import {fileURLToPath} from 'node:url';
import {DELEGATED_ROLES} from './claude_complete_memory_profiles.mjs';
import {loadGhostMemoryConfig,callMemoryCore} from '../../scripts/memory-config-loader.mjs';
const SCHEMA='singularity-option2-ghost-scope-probe/v1';
const MARKER=/^(GHOSTPROOF|DELEGATEPROOF)-[A-Z0-9_-]{10,64}$/;
const fail=x=>{throw new Error(x)};
function identity(x){return x&&typeof x==='object'&&!Array.isArray(x)&&
 Object.keys(x).sort().join(',')==='agent_id,team_id,user_id'&&
 ['team_id','user_id','agent_id'].every(k=>typeof x[k]==='string'&&
 x[k].length>0&&x[k].length<=128&&x[k].trim()===x[k]);}
export function validateProbe(cfg){
 if(!cfg||typeof cfg!=='object'||Array.isArray(cfg)||
   Object.keys(cfg).sort().join(',')!=='delegated,delegatedMarker,ghost,ghostMarker,schema'||
   cfg.schema!==SCHEMA||!identity(cfg.ghost)||!identity(cfg.delegated)||
   cfg.ghost.agent_id!=='ghost'||!DELEGATED_ROLES.includes(cfg.delegated.agent_id)||
   !MARKER.test(cfg.ghostMarker||'')||!cfg.ghostMarker.startsWith('GHOSTPROOF-')||
   !MARKER.test(cfg.delegatedMarker||'')||!cfg.delegatedMarker.startsWith('DELEGATEPROOF-')||
   cfg.ghostMarker===cfg.delegatedMarker)
   fail('GHOST_SCOPE_PROBE_SCHEMA_REFUSED');
 if(cfg.ghost.team_id===cfg.delegated.team_id&&cfg.ghost.user_id===cfg.delegated.user_id&&
   cfg.ghost.agent_id===cfg.delegated.agent_id)fail('GHOST_SCOPE_IDENTITY_COLLISION');
 return cfg;
}
function containsMarker(response,marker){
 if(response?.code!==0||!Array.isArray(response?.data?.messages))fail('GHOST_SCOPE_SEARCH_UNAVAILABLE');
 return response.data.messages.some(m=>typeof m?.content==='string' &&m.content.includes(marker));
}
export async function probeGhostScope({probe,search}={}){
 const p=validateProbe(probe);if(typeof search!=='function')fail('GHOST_SCOPE_SEARCH_REQUIRED');
 const result={schema:'singularity-option2-ghost-search-separation/v1',option:2,
   ownScopeMarkersObserved:false,crossScopeMarkerObserved:false,
   searchSeparationObserved:false,securityAuthorizationProven:false,
   markersWereWritten:false,releaseReady:false,issues:[]};
 // Positive controls BEFORE relying on negative results. Search failures
 // never become negative proofs; raw backend replies are not returned.
 let ownGhost,ownDelegate;
 try{
  ownGhost=containsMarker(await search(p.ghost,p.ghostMarker),p.ghostMarker);
  ownDelegate=containsMarker(await search(p.delegated,p.delegatedMarker),p.delegatedMarker);
 }catch{result.issues.push('GHOST_SCOPE_POSITIVE_SEARCH_FAILED');return result}
 if(!ownGhost||!ownDelegate){result.issues.push('GHOST_SCOPE_POSITIVE_CONTROL_MISSING');return result}
 result.ownScopeMarkersObserved=true;
 try{
  const crossGhost=containsMarker(await search(p.ghost,p.delegatedMarker),p.delegatedMarker);
  const crossDelegate=containsMarker(await search(p.delegated,p.ghostMarker),p.ghostMarker);
  result.crossScopeMarkerObserved=crossGhost||crossDelegate;
  if(result.crossScopeMarkerObserved)result.issues.push('GHOST_SCOPE_CROSS_SCOPE_CONTENT_OBSERVED');
  else result.searchSeparationObserved=true;
 }catch{result.issues.push('GHOST_SCOPE_CROSS_SEARCH_FAILED')}
 return result;
}
function argsOf(argv){const allowed=new Set(['--probe-file','--memory-config','--output','--live']);const args={};
 for(let i=0;i<argv.length;i++){
  const k=argv[i];if(!allowed.has(k)||Object.hasOwn(args,k))fail('GHOST_SCOPE_ARGUMENTS_INVALID');
  if(k==='--live'){args[k]=true;continue}
  if(!argv[i+1]||argv[i+1].startsWith('--'))fail('GHOST_SCOPE_VALUE_REQUIRED');args[k]=argv[++i];
 }return args;}
async function main(argv){
 const a=argsOf(argv);
 if(process.platform!=='win32'||!a['--live']||!a['--probe-file']||!a['--memory-config'])
   fail('NATIVE_WINDOWS_EXPLICIT_GHOST_LIVE_PROBE_REQUIRED');
 for(const path of [a['--probe-file'],a['--memory-config']]){
  if(!existsSync(path)||lstatSync(path).isSymbolicLink()||!lstatSync(path).isFile()||lstatSync(path).size>65536)
    fail('GHOST_SCOPE_PRIVATE_CONFIG_INVALID');
 }
 const probe=validateProbe(JSON.parse(readFileSync(a['--probe-file'],'utf8')));
 const cfg=loadGhostMemoryConfig({SINGULARITY_MEMORY_CONFIG:a['--memory-config']});
 const url=new URL(cfg.baseUrl);
 if(!cfg.gatewayKey&&!cfg.userKey||!['127.0.0.1','localhost','[::1]'].includes(url.hostname)||
    !['http:','https:'].includes(url.protocol)||url.username||url.password)
    fail('GHOST_SCOPE_LOCAL_MEMORY_BACKEND_REQUIRED');
 const search=async(identity,marker)=>callMemoryCore('/v3/conversation/search',{
   ...identity,query:marker,limit:10},cfg);
 const report=await probeGhostScope({probe,search});
 const content=JSON.stringify(report,null,2)+'\n';
 if(a['--output']){const fd=openSync(a['--output'],'wx',0o600);try{writeFileSync(fd,content)}finally{closeSync(fd)}}
 else process.stdout.write(content);
 return report.searchSeparationObserved?0:1;
}
if(process.argv[1]&&resolve(process.argv[1])===fileURLToPath(import.meta.url)){
 try{process.exitCode=await main(process.argv.slice(2))}
 catch{process.stderr.write('GHOST_SCOPE_PROBE_REFUSED\n');process.exitCode=2}
}
