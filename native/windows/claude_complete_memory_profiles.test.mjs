import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,mkdirSync,writeFileSync,readFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {DELEGATED_ROLES,MAIN_ROLES,validateDelegatedMap,assessDelegatedProfiles} from './claude_complete_memory_profiles.mjs';
const map=()=>Object.fromEntries(DELEGATED_ROLES.map(x=>[x,{team_id:'shared-team',user_id:'operator-test',agent_id:x}]));
function fixture(){
 const home=mkdtempSync(join(tmpdir(),'cc-complete-prof-'));
 const agentsDir=join(home,'agents');mkdirSync(agentsDir);
 for(const name of DELEGATED_ROLES)writeFileSync(join(agentsDir,`${name}.md`),`---\ndescription: role ${name}\n---\nbody\n`);
 return {agentsDir,ledgerPath:join(home,'ledger.json')};
}
const cfg={baseUrl:'http://127.0.0.1:8420',gatewayKey:'secret-NOT-IN-REPORT',userKey:'',serviceId:'default',authPrefix:'Bearer ',identity:{user_id:'operator-test'}};
const settings={env:{ANTHROPIC_BASE_URL:'http://127.0.0.1:8096/claude-code/default'}};
const remote=(calls,seeded=new Set())=>async (url,init)=>{
 const body=JSON.parse(init.body);calls.push({url,body});
 if(url.endsWith('/search')){
   const entries=seeded.has(body.agent_id)?[{session_id:`agent-profile-${body.agent_id}`,content:`Persistent MemoryCore profile for OpenChamber agent "${body.agent_id}".`}]:[];
   return new Response(JSON.stringify({code:0,data:{messages:entries}}));
 }
 seeded.add(body.agent_id);
 return new Response(JSON.stringify({code:0,data:{accepted_ids:['one']}}));
};
test('roster is eight delegated and nine excluded main roles',()=>{
 assert.equal(DELEGATED_ROLES.length,8);assert.equal(MAIN_ROLES.length,9);
 assert.equal(validateDelegatedMap(map()).identityMapValidated,true);
 assert.ok(!DELEGATED_ROLES.includes('ghost'));
});
test('refuses missing, colliding, or Ghost identities before contact',()=>{
 const x=map();delete x.board;assert.throws(()=>validateDelegatedMap(x),/MISSING/);
 const y=map();y.board=y.explore;assert.throws(()=>validateDelegatedMap(y),/COLLISION/);
 const z=map();z.board.agent_id='ghost';assert.throws(()=>validateDelegatedMap(z),/GHOST/);
 const extra=map();extra.board.extra='injection';assert.throws(()=>validateDelegatedMap(extra),/SHAPE/);
});
test('plan is read-only and does not print scoped IDs or credentials',async()=>{
 const result=await assessDelegatedProfiles({map:map(),settings,mode:'plan',fetchImpl:()=>{throw Error('network forbidden')}});
 assert.equal(result.parentSession.state,'CONFIGURED');assert.equal(result.profileReadbacksVerified,false);
 assert.equal(result.releaseReady,false);assert.doesNotMatch(JSON.stringify(result),/operator-test|secret/);
});
test('verify is read-only: missing charter fails and creates no ledger',async()=>{
 const f=fixture(),calls=[];
 const result=await assessDelegatedProfiles({mode:'verify',map:map(),cfg,settings,...f,fetchImpl:remote(calls)});
 assert.equal(result.profileReadbacksVerified,false);
 assert.equal(result.results.length,8);assert.ok(result.results.every(x=>x.status==='failed'));
 assert.ok(calls.every(c=>c.url.endsWith('/search')));
 assert.throws(()=>readFileSync(f.ledgerPath));
});
test('seed requires explicit native Windows apply and loopback core',async()=>{
 const f=fixture();const x={mode:'seed',map:map(),cfg,settings,...f};
 await assert.rejects(assessDelegatedProfiles({...x,platform:'linux',apply:true}),/WINDOWS_EXPLICIT_APPLY_REQUIRED/);
 await assert.rejects(assessDelegatedProfiles({...x,platform:'win32',apply:false}),/WINDOWS_EXPLICIT_APPLY_REQUIRED/);
 await assert.rejects(assessDelegatedProfiles({...x,cfg:{...cfg,baseUrl:'https://memory.example.com'},platform:'win32',apply:true}),/NON_LOOPBACK/);
});
test('seed all eight, independently read back, never write Ghost or main roles, safe rerun',async()=>{
 const f=fixture(),calls=[],seeded=new Set(),fetchImpl=remote(calls,seeded);
 const props={mode:'seed',map:map(),cfg,settings,...f,platform:'win32',apply:true,fetchImpl};
 const first=await assessDelegatedProfiles(props);
 assert.equal(first.profileReadbacksVerified,true);
 assert.equal(first.releaseReady,false);
 assert.equal(first.results.length,8);
 assert.equal(calls.filter(x=>x.url.endsWith('/add')).length,8);
 assert.ok(calls.every(x=>DELEGATED_ROLES.includes(x.body.agent_id)));
 const second=await assessDelegatedProfiles(props);
 assert.equal(second.profileReadbacksVerified,true);
 assert.equal(calls.filter(x=>x.url.endsWith('/add')).length,8);
 assert.doesNotMatch(JSON.stringify(first),/secret-NOT-IN-REPORT|operator-test/);
});
test('seed receipt cannot pass without post-seed live readback',async()=>{
 const f=fixture(),calls=[],seeded=new Set();let queries=0;
 const flaky=async(url,init)=>{
  if(url.endsWith('/search')){
    queries++;
    return new Response(JSON.stringify({code:0,data:{messages:[]}}));
  }
  return remote(calls,seeded)(url,init);
 };
 const r=await assessDelegatedProfiles({mode:'seed',map:map(),cfg,settings,...f,platform:'win32',apply:true,fetchImpl:flaky});
 assert.equal(r.profileReadbacksVerified,false);
 assert.ok(r.issues.includes('POST_SEED_READBACK_INCOMPLETE'));
});
