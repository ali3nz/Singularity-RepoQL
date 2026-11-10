import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,mkdirSync,writeFileSync,readFileSync,rmSync,existsSync} from 'node:fs';
import {join} from 'node:path';
import {EventEmitter} from 'node:events';
import {PassThrough} from 'node:stream';
import {tmpdir} from 'node:os';
import {maintainerPlan,provisionMaintainer,maintainerRoutine,verifyMaintainerBot} from './provision_maintainer.mjs';

function fixture(){
 const root=mkdtempSync(join(tmpdir(),'singularity-omb-provision-'));
 const source=join(root,'source'),rcRoot=join(root,'Fleet861RC');
 mkdirSync(join(source,'native','windows','openmausbot'),{recursive:true});
 mkdirSync(join(rcRoot,'stage','omb'),{recursive:true});
 mkdirSync(join(rcRoot,'state','omb'),{recursive:true});
 writeFileSync(join(source,'README.md'),'Singularity');
 writeFileSync(join(source,'native','windows','configure_project_mcp.mjs'),'fixture');
 writeFileSync(join(source,'native','windows','openmausbot','SINGULARITY-MAINTAINER.md'),'This bot only repairs owned source files. '.repeat(14));
 writeFileSync(join(rcRoot,'stage','omb','cli.js'),'vendor CLI fixture');
 writeFileSync(join(rcRoot,'state','omb','instance.json'),JSON.stringify({
  payload:join(rcRoot,'stage','omb'),data_dir:join(rcRoot,'state','omb'),
  mode:'headless-no-pair-task',task:'Fleet893-RC-OpenMausBot',pid:process.pid,port:18211}));
 return {root,source,rcRoot};
}
/** Vendor stub: CLI verbs plus the MCP session the routine wiring uses.
 *  `drift` changes one reported bot field; `drop` removes a pre-existing bot. */
function vendorRun({source,observeRoutine=true,drift=null,drop=false}={}){
 const calls=[],state={creates:0,routines:[],botLists:0};
 const run=(_exe,args,opts)=>{
  calls.push(args);
  assert.equal(opts.env.OMB_PORT,'18211');
  if(args[1]==='mcp'){
   const out=[];
   for(const line of String(opts.input||'').split('\n').filter(Boolean)){
    const f=JSON.parse(line);
    if(f.method==='initialize'){out.push({jsonrpc:'2.0',id:f.id,result:{protocolVersion:'2024-11-05',capabilities:{}}});continue}
    if(f.method!=='tools/call')continue;
    const name=f.params.name,args2=f.params.arguments??{};
    let payload;
    if(name==='list_bots')payload={bots:[{id:'bot-1',name:'Singularity Maintainer'}]};
    else if(name==='trigger'){
     state.creates+=1;
     state.routines.push({id:'trig-1',name:args2.name,enabled:true,
      nextRunAt:new Date(Date.now()+3_600_000).toISOString(),schedule:args2.schedule,for_bot_id:args2.for_bot_id});
     payload={created:true};
    } else if(name==='trigger_info')payload={routines:observeRoutine?state.routines:[]};
    else payload={};
    out.push({jsonrpc:'2.0',id:f.id,result:{content:[{type:'text',text:JSON.stringify(payload)}]}});
   }
   return {status:0,stdout:out.map(f=>JSON.stringify(f)).join('\n')+'\n'};
  }
  if(args[1]==='team'&&args.includes('--check'))return {status:drift?6:0,stdout:'{"ok":true}'};
  if(args[1]==='bots'){
   state.botLists+=1;
   const bot={name:'Singularity Maintainer',team:'Singularity Maintenance',
    cwd:source,approval:'edits',computer:'off',...(drift||{})};
   const other={name:'Existing Bot',team:'Personal'};
   const bots=state.botLists===1?[other,bot]:(drop?[bot]:[other,bot]);
   return {status:0,stdout:JSON.stringify({bots})};
  }
  return {status:0,stdout:'{"ok":true}'};
 };
 return {run,calls,state};
}
function botOnlyVendor({source,bots=[]}={}){
 const calls=[],state={bots:[...bots],teamFiles:[],teamCalls:0};
 const run=(_exe,args,opts)=>{
  calls.push(args);
  assert.equal(opts.env.OMB_PORT,'18211');
  assert.equal(opts.env.OPENMAUSBOT_URL,undefined);
  assert.equal(opts.env.OPENMAUSBOT_TOKEN,undefined);
  if(args[1]==='bots')return {status:0,stdout:JSON.stringify({bots:state.bots})};
  if(args[1]==='team'&&args.includes('--check')){state.checks=(state.checks||0)+1;return {status:0,stdout:'{"ok":true}'}}
  if(args[1]==='team'&&args[2]==='apply'){
   const teamPath=args[3],team=JSON.parse(readFileSync(teamPath,'utf8'));
   state.teamFiles.push(teamPath);state.teamCalls+=1;
   assert.deepEqual(team.teams,[{name:'Singularity Maintenance',prune:false}]);
   assert.equal(team.bots.length,1);
   const bot=team.bots[0];
   for(const forbidden of ['soul','model','provider','apiKey','token'])assert.equal(bot[forbidden],undefined);
   if(!args.includes('--dry-run'))state.bots=[...state.bots,...team.bots];
   return {status:0,stdout:'{"ok":true}'};
  }
  assert.fail('bot-only path must not call chat or routines');
 };
 return {run,calls,state};
}

function fakeChild(vendor){
 return ()=>{
  const child=new EventEmitter();child.stdout=new PassThrough();child.stdin=new PassThrough();child.killed=false;
  let buf='';
  child.stdin.on('data',d=>{buf+=d.toString();let i;
   while((i=buf.indexOf('\n'))>=0){const line=buf.slice(0,i);buf=buf.slice(i+1);if(!line.trim())continue;
    const out=vendor('node',['cli.js','mcp'],{input:line+'\n',env:{OMB_PORT:'18211'}});if(out.stdout)child.stdout.write(out.stdout)}});
  child.kill=()=>{child.killed=true;child.stdout.end();setImmediate(()=>child.emit('close'))};
  return child;
 };
}test('maintainer plan is read-only and only provisions one named bot without pruning',async()=>{
 const x=fixture();try{
  const plan=maintainerPlan(x);const team=JSON.parse(plan.team);
  assert.deepEqual(team.teams,[{name:'Singularity Maintenance',prune:false}]);
  assert.equal(team.bots.length,1);assert.equal(team.bots[0].name,'Singularity Maintainer');
  assert.equal(team.bots[0].computer,'off');assert.equal(team.bots[0].approval,'edits');
  assert.equal(team.bots[0].model,undefined);
  assert.equal(plan.scheduledChecksConfigured,false,'the plan creates no schedule');
  assert.equal(plan.routine.name,'Singularity maintenance sweep');
  assert.equal(plan.routine.schedule.everyMinutes,60);
  const result=await provisionMaintainer(x);assert.equal(result.mode,'READ_ONLY');
  assert.equal(result.runtimeAgentVerified,false);assert.equal(result.scheduleVerified,false);
 }finally{rmSync(x.root,{recursive:true,force:true})}
});
test('initial-bot verification is read-only: bot list plus config check',()=>{
 const x=fixture(),v=vendorRun({source:x.source});try{
  const result=verifyMaintainerBot({...x,run:v.run});
  assert.equal(result.present,true);assert.equal(result.ambiguous,false);
  assert.equal(v.calls.length,2);assert.equal(v.calls[0][1],'bots');
  assert.ok(v.calls[1].includes('--check'));
  assert.equal(v.calls.some(args=>(args[1]==='team'&&!args.includes('--check'))||args[1]==='mcp'),false);
 }finally{rmSync(x.root,{recursive:true,force:true})}
});
test('initial-bot verification reports drift when the config check exits 6',()=>{
 const x=fixture(),v=vendorRun({source:x.source,drift:{approval:'full'}});try{
  const result=verifyMaintainerBot({...x,run:v.run});
  assert.equal(result.present,true);assert.equal(result.botConfigVerified,false);
 }finally{rmSync(x.root,{recursive:true,force:true})}
});
test('bot-only apply reuses one existing Maintainer without applying or writing state',async()=>{
 const x=fixture(),v=botOnlyVendor({source:x.source,bots:[
  {name:'Singularity Maintainer',team:'Existing Team',model:'operator-choice'},
  {name:'Existing Bot',team:'Personal'}]});try{
  const result=await provisionMaintainer({...x,apply:true,botOnly:true,run:v.run,allowFixture:true});
  assert.equal(result.botRegistrationVerified,true);assert.equal(result.botReused,true);
  assert.equal(result.scheduleRequested,false);assert.equal(result.scheduleVerified,false);
  assert.equal(v.calls.length,2);assert.equal(v.state.teamCalls,0);
  assert.equal(v.calls.some(args=>args[1]==='mcp'),false);
  assert.equal(existsSync(join(x.rcRoot,'state','maintainer-provision')),false);
 }finally{rmSync(x.root,{recursive:true,force:true})}
});
test('bot-only apply creates a missing bot with no persistent Soul or routine state',async()=>{
 const x=fixture(),v=botOnlyVendor({source:x.source,bots:[{name:'Existing Bot',team:'Personal'}]});try{
  const result=await provisionMaintainer({...x,apply:true,botOnly:true,run:v.run,allowFixture:true});
  assert.equal(result.botRegistrationVerified,true);assert.equal(result.botReused,false);
  assert.equal(result.scheduleRequested,false);assert.equal(result.scheduleVerified,false);
  assert.equal(result.otherBotsPreserved,true);assert.equal(v.state.teamCalls,2);
  assert.equal(v.state.checks,1,'post-apply --check readback ran');
  assert.equal(v.state.bots.length,2);
  assert.equal(v.calls.some(args=>args[1]==='mcp'),false);
  assert.equal(v.state.teamFiles.every(path=>existsSync(path)),false,'temporary team files are removed');
  assert.equal(existsSync(join(x.rcRoot,'state','maintainer-provision')),false);
 }finally{rmSync(x.root,{recursive:true,force:true})}
});
test('bot-only apply refuses duplicate default bots without changing them',async()=>{
 const x=fixture(),v=botOnlyVendor({source:x.source,bots:[
  {name:'Singularity Maintainer',team:'A'},{name:'Singularity Maintainer',team:'B'}]});try{
  await assert.rejects(()=>provisionMaintainer({...x,apply:true,botOnly:true,run:v.run,allowFixture:true}),/OMB_BOT_AMBIGUOUS/);
  assert.equal(v.calls.length,1);assert.equal(v.state.teamCalls,0);
 }finally{rmSync(x.root,{recursive:true,force:true})}
});
test('maintainer apply uses vendor dryrun and readback and permits no duplicate provisioning',async()=>{
 const x=fixture(),v=vendorRun({source:x.source});
 try{
  const options={...x,apply:true,run:v.run,spawnChild:fakeChild(v.run),allowFixture:true};
  const first=await provisionMaintainer(options);
  assert.equal(first.botRegistrationVerified,true);
  assert.equal(first.botConfigVerified,true);
  assert.deepEqual(first.botConfigFieldsCompared,['team','title','description','soul','approval','computer','cwd']);
  assert.equal(first.otherBotsPreserved,true);
  assert.equal(first.scheduleVerified,true);
  assert.equal(first.scheduleCreated,true);
  assert.equal(first.liveRulesLoadedVerified,false);
  assert.equal(first.reloadRequired,true);
  const second=await provisionMaintainer(options);
  assert.equal(second.botRegistrationVerified,true);
  assert.equal(second.scheduleCreated,false,'an existing routine is not created twice');
  assert.equal(v.state.creates,1);
  const vendor=v.calls.filter(a=>a[1]!=='mcp');
  assert.equal(vendor.length,10);                      // 2x (bots, dry-run, apply, bots, check)
  assert.equal(vendor[0][1],'bots');
  assert.ok(vendor[1].includes('--dry-run'));
  assert.equal(vendor[2][2],'apply');
  const f=join(x.rcRoot,'state','maintainer-provision','team.json');
  assert.equal(JSON.parse(readFileSync(f,'utf8')).bots.length,1);
 }finally{rmSync(x.root,{recursive:true,force:true})}
});
test('a bot with the right name but drifted configuration is refused',async()=>{
 const x=fixture(),v=vendorRun({source:x.source,drift:{approval:'full'}});
 try{
  await assert.rejects(()=>provisionMaintainer({...x,apply:true,run:v.run,spawnChild:fakeChild(v.run),allowFixture:true}),/OMB_BOT_CONFIG_MISMATCH/);
 }finally{rmSync(x.root,{recursive:true,force:true})}
});
test('removing an unrelated bot during apply is refused',async()=>{
 const x=fixture(),v=vendorRun({source:x.source,drop:true});
 try{
  await assert.rejects(()=>provisionMaintainer({...x,apply:true,run:v.run,spawnChild:fakeChild(v.run),allowFixture:true}),/OMB_UNRELATED_BOT_REMOVED/);
 }finally{rmSync(x.root,{recursive:true,force:true})}
});
test('a concurrent provisioning run is refused by the exclusive lock',async()=>{
 const x=fixture(),v=vendorRun({source:x.source});
 try{
  const state=join(x.rcRoot,'state','maintainer-provision');
  mkdirSync(state,{recursive:true});
  writeFileSync(join(state,'.lock'),JSON.stringify({pid:process.pid,at:new Date().toISOString()}));
  await assert.rejects(()=>provisionMaintainer({...x,apply:true,run:v.run,spawnChild:fakeChild(v.run),allowFixture:true}),/OMB_MAINTAINER_PROVISION_BUSY/);
 }finally{rmSync(x.root,{recursive:true,force:true})}
});
test('a recorded pid that is not running is refused on the target platform',()=>{
 const x=fixture();try{
  // 12345 can be a live pid on a busy Windows host; use one no OS allocates.
  const f=join(x.rcRoot,'state','omb','instance.json');
  writeFileSync(f,JSON.stringify({...JSON.parse(readFileSync(f,'utf8')),pid:2147483000}));
  assert.throws(()=>maintainerPlan({source:x.source,rcRoot:x.rcRoot,requireLivePid:true}),/OMB_INSTANCE_PID_NOT_RUNNING/);
 }finally{rmSync(x.root,{recursive:true,force:true})}
});
test('a routine that is not observed keeps scheduleVerified false with a precise reason',async()=>{
 const x=fixture(),v=vendorRun({source:x.source,observeRoutine:false});
 try{
  const r=await provisionMaintainer({...x,apply:true,run:v.run,spawnChild:fakeChild(v.run),allowFixture:true});
  assert.equal(r.botRegistrationVerified,true);
  assert.equal(r.scheduleVerified,false);
  assert.equal(r.scheduleReason,'OMB_ROUTINE_NOT_OBSERVED');
 }finally{rmSync(x.root,{recursive:true,force:true})}
});
test('the routine definition is a bounded interval with judgement in its instructions',()=>{
 const r=maintainerRoutine({now:0});
 assert.equal(r.schedule.type,'interval');
 assert.ok(r.schedule.everyMinutes>=5&&r.schedule.everyMinutes<=1440);
 assert.equal(r.schedule.anchorAt,new Date(0).toISOString());
 assert.equal(r.overlap,'skip');
 assert.match(r.instructions,/maintenance_repair\.mjs --apply/);
 assert.match(r.instructions,/never start another scheduler/);
 assert.match(r.instructions,/reload/);
});
test('maintainer provisioning refuses unowned or drifted files',async()=>{
 const x=fixture(),v=vendorRun({source:x.source});
 try{
  const state=join(x.rcRoot,'state','maintainer-provision');mkdirSync(state,{recursive:true});
  writeFileSync(join(state,'team.json'),'unowned');
  await assert.rejects(()=>provisionMaintainer({...x,apply:true,run:v.run,spawnChild:fakeChild(v.run),allowFixture:true}),/MAINTAINER_PROVISION_FOREIGN_FILES/);
 }finally{rmSync(x.root,{recursive:true,force:true})}
});
test('maintainer refuses foreign OMB state or missing source markers',()=>{
 const x=fixture();try{
  const instance=join(x.rcRoot,'state','omb','instance.json'),data=JSON.parse(readFileSync(instance,'utf8'));
  data.payload=join(x.root,'other');writeFileSync(instance,JSON.stringify(data));
  assert.throws(()=>maintainerPlan(x),/OMB_OWNED_HEADLESS_INSTANCE_UNVERIFIED/);
 }finally{rmSync(x.root,{recursive:true,force:true})}
});
