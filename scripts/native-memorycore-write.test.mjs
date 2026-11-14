import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { writeNativeCliFixture } from '../native/windows/native_cli_fixture.mjs';
import { loadMemoryConfig, callMemoryCore } from './memory-config-loader.mjs';
import { provisionAgentProfiles } from './setup-agent-profiles.mjs';

const dir = mkdtempSync(join(tmpdir(), 'singularity-native-writer-'));
const savedWriter = process.env.SINGULARITY_RUST_MEMORYCORE_WRITER_BIN;
const savedReader = process.env.SINGULARITY_RUST_MEMORYCORE_READER_BIN;
const configFile = join(dir, 'memory.json');
writeFileSync(configFile, JSON.stringify({hostBaseUrl:'http://127.0.0.1:8420',
  gatewayKey:'fixture-gateway-secret', userKey:'fixture-user-secret',
  authPrefix:'Bearer ', serviceId:'default'}));
const cfg=loadMemoryConfig({SINGULARITY_MEMORY_CONFIG:configFile});
const body={team_id:'t',user_id:'u',agent_id:'a',session_id:'s',task_id:'task',
  messages:[{role:'assistant',content:'memory text'}]};
function executable(response, label, record=false) {
  const receipt=join(dir,`${label}.receipt`);
  const source=`#!/usr/bin/env node\nlet bytes='';\nprocess.stdin.on('data',c=>bytes+=c);\nprocess.stdin.on('end',()=>{\n`+
    (record?`require('node:fs').writeFileSync(${JSON.stringify(receipt)}, JSON.stringify({input:JSON.parse(bytes), config:process.env.MEMORYCORE_V3_CONFIG_FILE}));\n`:'')+
    `process.stdout.write(${JSON.stringify(JSON.stringify(response))});\n});\n`;
  const path=writeNativeCliFixture(join(dir, `${label}`),source);
  return {path,receipt};
}
function referenceFetch(tally) {
  return async (_url,opts)=>{ tally.count++; assert.equal(opts.redirect,'error');
    return {ok:true,status:200,text:async()=>JSON.stringify({code:0,data:{accepted_ids:['i1']}})};
  };
}
test.after(()=>{
  if(savedWriter===undefined)delete process.env.SINGULARITY_RUST_MEMORYCORE_WRITER_BIN;
  else process.env.SINGULARITY_RUST_MEMORYCORE_WRITER_BIN=savedWriter;
  if(savedReader===undefined)delete process.env.SINGULARITY_RUST_MEMORYCORE_READER_BIN;
  else process.env.SINGULARITY_RUST_MEMORYCORE_READER_BIN=savedReader;
  rmSync(dir,{recursive:true,force:true});
});
test('normal write path still calls the existing MemoryCore client once',async()=>{
  delete process.env.SINGULARITY_RUST_MEMORYCORE_WRITER_BIN;
  const tally={count:0};
  const reply=await callMemoryCore('/v3/conversation/add',body,cfg,referenceFetch(tally));
  assert.equal(reply.code,0); assert.equal(tally.count,1);
});
test('selected native writer performs exactly one write and no JS HTTP write',async()=>{
  const {path,receipt}=executable({ok:true,payload:{code:0,data:{accepted_ids:['i1']}}},'success',true);
  process.env.SINGULARITY_RUST_MEMORYCORE_WRITER_BIN=path;
  const tally={count:0};
  const reply=await callMemoryCore('/v3/conversation/add',body,cfg,referenceFetch(tally));
  assert.equal(reply.code,0); assert.equal(tally.count,0);
  const recorded=JSON.parse(readFileSync(receipt,'utf8'));
  assert.equal(recorded.input.operation,'v3Write');
  assert.equal(recorded.input.path,'/v3/conversation/add');
  assert.deepEqual(recorded.input.body,body);
  assert.equal(recorded.config,configFile);
  assert.equal(JSON.stringify(recorded).includes('fixture-gateway-secret'),false);
  assert.equal(JSON.stringify(recorded).includes('fixture-user-secret'),false);
});
test('ambiguous writer delivery cannot cause a fallback or second write',async()=>{
  const {path,receipt}=executable({ok:false,code:'DELIVERY_UNCERTAIN'},'uncertain',true);
  process.env.SINGULARITY_RUST_MEMORYCORE_WRITER_BIN=path;
  const tally={count:0};
  await assert.rejects(callMemoryCore('/v3/conversation/add',body,cfg,referenceFetch(tally)),/WRITE_UNCONFIRMED/);
  assert.equal(tally.count,0);
  assert.equal(JSON.parse(readFileSync(receipt,'utf8')).input.operation,'v3Write');
});
test('forged native success without application confirmation is rejected',async()=>{
  const {path}=executable({ok:true,payload:{code:403,data:{accepted_ids:['forged']}}},'forged');
  process.env.SINGULARITY_RUST_MEMORYCORE_WRITER_BIN=path;
  await assert.rejects(callMemoryCore('/v3/conversation/add',body,cfg,referenceFetch({count:0})),/WRITE_UNCONFIRMED/);
});
test('selected native write refuses a missing executable without JS fallback',async()=>{
  process.env.SINGULARITY_RUST_MEMORYCORE_WRITER_BIN=join(dir,'missing.exe');
  const tally={count:0};
  await assert.rejects(callMemoryCore('/v3/conversation/add',body,cfg,referenceFetch(tally)),/EXECUTABLE_INVALID/);
  assert.equal(tally.count,0);
});
test('selected native write rejects an off-host URL before spawning or fetching',async()=>{
  const {path}=executable({ok:true,payload:{code:0}},'remote');
  process.env.SINGULARITY_RUST_MEMORYCORE_WRITER_BIN=path;
  const tally={count:0};
  await assert.rejects(callMemoryCore('/v3/conversation/add',body,
    {...cfg,baseUrl:'http://127.0.0.1.attacker.invalid:8420'},referenceFetch(tally)),/CONFIG_DIVERGENCE|NON_LOCAL_ORIGIN/);
  assert.equal(tally.count,0);
});
test('selected native write refuses an inconsistent credential configuration',async()=>{
  const {path}=executable({ok:true,payload:{code:0}},'bad-credential');
  process.env.SINGULARITY_RUST_MEMORYCORE_WRITER_BIN=path;
  const tally={count:0};
  await assert.rejects(callMemoryCore('/v3/conversation/add',body,
    {...cfg,gatewayKey:'other-secret'},referenceFetch(tally)),/CONFIG_DIVERGENCE/);
  assert.equal(tally.count,0);
});
test('native writer selection never intercepts unrelated mutations',async()=>{
  const {path}=executable({ok:true,payload:{code:0}},'not-intercepted');
  process.env.SINGULARITY_RUST_MEMORYCORE_WRITER_BIN=path;
  const tally={count:0};
  assert.equal((await callMemoryCore('/v3/atomic/delete',{...body},cfg,referenceFetch(tally))).code,0);
  assert.equal(tally.count,1);
});

test('selected native writer rejects unscoped input before subprocess',async()=>{
  const {path,receipt}=executable({ok:true,payload:{code:0}},'unscoped',true);
  process.env.SINGULARITY_RUST_MEMORYCORE_WRITER_BIN=path;
  await assert.rejects(callMemoryCore('/v3/conversation/add',
    {messages:[{role:'assistant',content:'x'}]},cfg,referenceFetch({count:0})),/WRITE_BODY_INVALID/);
  assert.throws(()=>readFileSync(receipt,'utf8'));
});
test('native-seeded charter is only recorded after a verified live readback',async()=>{
  const {path}=executable({ok:true,payload:{code:0,data:{accepted_ids:['i1']}}},'charter');
  process.env.SINGULARITY_RUST_MEMORYCORE_WRITER_BIN=path;
  const agentsDir=join(dir,'charter-agents');
  const ledgerPath=join(dir,'charter-ledger.json');
  const {mkdirSync,existsSync}=await import('node:fs');
  mkdirSync(agentsDir,{recursive:true});
  writeFileSync(join(agentsDir,'example.md'),'---\ndescription: X\n---\nAgent');
  let probes=0;
  const fetchImpl=async(url)=>{
    assert.ok(url.endsWith('/v3/conversation/search'));
    probes++;
    return {ok:true,status:200,text:async()=>JSON.stringify({code:0,data:{messages:[{
      session_id:'agent-profile-example',
      content:'Persistent MemoryCore profile for OpenChamber agent "example" (Singularity-RepoQL). Role: X'
    }]}})};
  };
  const result=await provisionAgentProfiles({agentsDir,ledgerPath,cfg,env:{},fetchImpl,
    now:()=> '2026-11-12T00:00:00Z'});
  assert.equal(result.failed,0); assert.equal(result.results[0].status,'seeded');
  assert.equal(probes,1); assert.equal(existsSync(ledgerPath),true);
});
test('native write acknowledgement without readback does not update profile ledger',async()=>{
  const {path}=executable({ok:true,payload:{code:0,data:{accepted_ids:['i1']}}},'no-readback');
  process.env.SINGULARITY_RUST_MEMORYCORE_WRITER_BIN=path;
  const agentsDir=join(dir,'not-verified-agents');
  const ledgerPath=join(dir,'not-verified-ledger.json');
  const {mkdirSync,existsSync}=await import('node:fs');
  mkdirSync(agentsDir,{recursive:true});
  writeFileSync(join(agentsDir,'example.md'),'---\ndescription: X\n---\nAgent');
  const result=await provisionAgentProfiles({agentsDir,ledgerPath,cfg,env:{},
    fetchImpl:async()=>({ok:true,status:200,text:async()=>JSON.stringify({code:0,data:{messages:[]}})}),
    now:()=> '2026-11-12T00:00:00Z'});
  assert.equal(result.failed,1); assert.equal(result.results[0].status,'failed');
  assert.equal(existsSync(ledgerPath),false);
});
