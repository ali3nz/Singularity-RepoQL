#!/usr/bin/env node
/**
 * Provision exactly one scoped Windows-local Singularity Maintainer through the
 * vendor's documented `openmausbot team apply` contract, then wire that bot's own
 * routine through the vendor `trigger` tool and read it back with `trigger_info`.
 * No generic OMB API, credentials, bot registry manipulation, additional
 * supervisor, second scheduler or AI calls.
 *
 * Verified vendor contract (installed bundle + native/windows/openmausbot/headless.py):
 *   team apply <file> [--dry-run] [--json]     creates/updates the named bot
 *   bots --json                                readback of registered bots
 *   node cli.js mcp + trigger {action:'create', when:'schedule', for_bot_id,
 *      name, instructions, schedule}           the bot's own routine
 *   trigger_info {action:'list'}               readback: ids, enabled, nextRunAt
 *
 * Plan is read-only. Apply takes one exclusive lock, snapshots the bot list
 * before and after, requires the applied configuration (not just the name) and
 * reports scheduleVerified only when trigger_info lists the routine enabled
 * with a future run. Unrelated bots are never pruned; drift is reported.
 */
import {existsSync, lstatSync, readFileSync, mkdirSync, openSync, writeFileSync,
        closeSync, fsyncSync, renameSync, unlinkSync} from 'node:fs';
import {join, resolve, dirname, isAbsolute} from 'node:path';
import {createHash, randomUUID} from 'node:crypto';
import {spawnSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import {ensureMaintainerRoutine, readMaintainerRoutine} from './omb_chat.mjs';

const fail=s=>{throw Error(s)};
const digest=s=>createHash('sha256').update(s).digest('hex');
const expectedTask='Fleet893-RC-OpenMausBot';
const botName='Singularity Maintainer';
const teamName='Singularity Maintenance';
const receiptName='provision-receipt.json';
const sourcePrompt='native/windows/openmausbot/SINGULARITY-MAINTAINER.md';
const routineName='Singularity maintenance sweep';
const NL='\n';

function safePath(p){
  if(!p||!isAbsolute(p))fail('ABSOLUTE_PATH_REQUIRED');
  for(let at=resolve(p);;at=dirname(at)){
    if(existsSync(at)&&lstatSync(at).isSymbolicLink())fail('SYMLINK_PATH_REFUSED');
    if(dirname(at)===at)break;
  }
  return resolve(p);
}
function readObject(p){const x=JSON.parse(readFileSync(p,'utf8'));
  if(!x||Array.isArray(x)||typeof x!=='object')fail('INVALID_JSON_OBJECT');return x;}
function regular(p){safePath(p);if(!existsSync(p)||!lstatSync(p).isFile())fail('REQUIRED_FILE_MISSING');return p;}
function hashIfExists(p){return existsSync(p)?digest(readFileSync(regular(p))):null;}
function atomicFile(p,content){
  const tmp=p+'.pending-'+randomUUID();const fd=openSync(tmp,'wx',0o600);
  try{writeFileSync(fd,content);fsyncSync(fd)}finally{closeSync(fd)}
  try{renameSync(tmp,p)}catch(e){if(existsSync(tmp))unlinkSync(tmp);throw e}
}
function pidRunning(pid){
  try{process.kill(pid,0);return true}catch(error){return error?.code==='EPERM'}
}
function instanceFor(rcRoot,{requireLivePid=false}={}){
  const stage=safePath(join(rcRoot,'stage','omb'));
  const data=safePath(join(rcRoot,'state','omb'));
  const file=regular(join(data,'instance.json'));
  const instance=readObject(file);
  const cli=regular(join(stage,'cli.js'));
  if(instance.payload!==stage||instance.data_dir!==data||
     instance.mode!=='headless-no-pair-task'||instance.task!==expectedTask||
     !Number.isInteger(instance.port)||instance.port<1024||instance.port>65534||
     !Number.isInteger(instance.pid)||instance.pid<=0)fail('OMB_OWNED_HEADLESS_INSTANCE_UNVERIFIED');
  // A recorded pid is not a running server: on the target platform the instance
  // must actually be alive, otherwise the vendor CLI would be pointed at a dead port.
  if(requireLivePid&&!pidRunning(instance.pid))fail('OMB_INSTANCE_PID_NOT_RUNNING');
  return {stage,data,cli,port:instance.port,pid:instance.pid};
}

/** The one routine this product owns: a bounded, idempotent maintenance sweep.
 *  `schedule` uses the vendor's verified interval shape (everyMinutes 5..1440,
 *  anchorAt timestamp); `overlap:'skip'` never queues a second sweep. */
export function maintainerRoutine({now=Date.now(),rcRoot=null}={}){
  const args=rcRoot?` --data-dir ${rcRoot}/state/omb --workspace ${rcRoot}`:'';
  return {
    name:routineName,
    instructions:[
      'Run one bounded Singularity maintenance sweep on this machine.',
      `Use the read-only audit first: node native/windows/openmausbot/maintenance_audit.mjs${args};`,
      'it composes the existing static inventory, OMB rules, memory-profile plan and documentation reconciliation, and reports a live prober as NOT_VERIFIED until that prober is actually run.',
      'Then repair the one owned defect class, the receipt-owned OpenMausBot shared rules file, through',
      `node native/windows/openmausbot/maintenance_repair.mjs --apply${args};`,
      'that command delivers the verified report to this bot chat and retries any unacknowledged message with the same occurrence id.',
      'Never edit anything outside the Singularity installation, never install or upgrade software, never change credentials or firewall,',
      'never start another scheduler or watcher, never approve your own change. If the occurrence is already fixed, report already-fixed.',
      'Report the exact status, on-disk readback and report path in chat, and say that a live bot reload is required before the repaired rules apply.',
      'If a step fails, report the failure instead of a fix.',
    ].join(' '),
    schedule:{type:'interval',everyMinutes:360,anchorAt:new Date(now).toISOString()},
    overlap:'skip',
  };
}

export function maintainerPlan({source,rcRoot,now=Date.now(),requireLivePid=false}){
  source=safePath(source);rcRoot=safePath(rcRoot);
  const prompt=regular(join(source,sourcePrompt));
  regular(join(source,'native/windows/configure_project_mcp.mjs'));
  regular(join(source,'README.md'));
  const ins=instanceFor(rcRoot,{requireLivePid});
  const state=safePath(join(rcRoot,'state','maintainer-provision'));
  const soulBytes=readFileSync(prompt);
  if(soulBytes.length<150||soulBytes.length>24000)fail('OMB_SOUL_LENGTH_INVALID');
  const team={version:1,teams:[{name:teamName,prune:false}],bots:[{
    name:botName,team:teamName,title:'Singularity maintenance',
    description:'Find, repair, verify and report defects in the local Singularity installation',
    soul:{file:'SOUL.md'},approval:'edits',computer:'off',cwd:source,
  }]};
  return {schema:'singularity-omb-maintainer-provision/v1',source,rcRoot,
    vendorCli:ins.cli,vendorDir:ins.stage,port:ins.port,pid:ins.pid,state,
    soul:soulBytes.toString('utf8'),team:JSON.stringify(team,null,2)+NL,
    plannedBot:botName,existingBotsPreserved:true,model:'existing-server-default',
    routine:maintainerRoutine({now,rcRoot}),
    scheduledChecksPlanned:true,
    scheduledChecksConfigured:false};
}
function checkPrior(plan){
  const f=join(plan.state,'SOUL.md'),t=join(plan.state,'team.json'),r=join(plan.state,receiptName);
  const prev=existsSync(r)?readObject(regular(r)):null;
  if(prev){
    if(prev.schema!==1||prev.soulHash!==hashIfExists(f)||prev.teamHash!==hashIfExists(t))
      fail('MAINTAINER_PROVISION_STATE_CHANGED_REFUSE_OVERWRITE');
  }else if(existsSync(f)||existsSync(t))fail('MAINTAINER_PROVISION_FOREIGN_FILES');
  return {f,t,r};
}
function vendorRun(plan,args,run=spawnSync){
  const env={...process.env,OMB_PORT:String(plan.port)};
  delete env.OPENMAUSBOT_URL;delete env.OPENMAUSBOT_TOKEN;
  const result=run(process.execPath,[plan.vendorCli,...args],{
    cwd:plan.vendorDir,env,encoding:'utf8',timeout:120000,windowsHide:true,
    shell:false,maxBuffer:32768,
  });
  if(result.error||result.status!==0)fail('OMB_VENDOR_COMMAND_FAILED');
  return String(result.stdout||'');
}
function botList(plan,run){
  let result;
  try{result=JSON.parse(vendorRun(plan,['bots','--json'],run))}catch{fail('OMB_BOT_READBACK_UNVERIFIED')}
  const bots=Array.isArray(result)?result:Array.isArray(result.bots)?result.bots:
    Array.isArray(result.data?.bots)?result.data.bots:null;
  if(!bots)fail('OMB_BOT_READBACK_UNVERIFIED');
  return bots;
}
/** Readback must describe the configuration we asked for, not just a matching name. */
function verifyAppliedBot(bots,before,source){
  const same=bots.filter(b=>b&&b.name===botName);
  if(same.length!==1)fail('OMB_BOT_READBACK_UNVERIFIED');
  const bot=same[0];
  if(bot.team!==undefined&&bot.team!==teamName)fail('OMB_BOT_TEAM_MISMATCH');
  const compared=[];
  for(const [field,want] of [['cwd',source],['approval','edits'],['computer','off']]){
    if(bot[field]===undefined)continue;             // this vendor build does not report it
    if(String(bot[field])!==String(want))fail('OMB_BOT_'+field.toUpperCase()+'_MISMATCH');
    compared.push(field);
  }
  const after=new Set(bots.map(b=>b.name));
  for(const b of before)if(b?.name&&!after.has(b.name))fail('OMB_UNRELATED_BOT_REMOVED');
  return {configFieldsCompared:compared,otherBotsPreserved:true};
}

export function provisionMaintainer({source,rcRoot,apply=false,run=spawnSync,allowFixture=false,now=Date.now()}){
  if(apply&&process.platform!=='win32'&&!allowFixture)fail('WINDOWS_ONLY_MUTATION');
  const p=maintainerPlan({source,rcRoot,now,requireLivePid:process.platform==='win32'});
  const response={schema:p.schema,mode:apply?'APPLY':'READ_ONLY',
    bot:p.plannedBot,model:p.model,existingBotsPreserved:true,routine:p.routine.name,
    runtimeAgentVerified:false,scheduleVerified:false,chatReportVerified:false};
  if(!apply)return response;
  const {f,t,r}=checkPrior(p);
  mkdirSync(p.state,{recursive:true,mode:0o700});
  // One exclusive lock spans the state writes and every vendor call, so two
  // concurrent applies cannot interleave SOUL/team/receipt or the team apply.
  const lock=join(p.state,'.lock');
  try{
    const fd=openSync(lock,'wx',0o600);
    try{writeFileSync(fd,JSON.stringify({pid:process.pid,at:new Date(now).toISOString()}));fsyncSync(fd)}finally{closeSync(fd)}
  }catch(error){
    if(error?.code==='EEXIST')fail('OMB_MAINTAINER_PROVISION_BUSY');
    throw error;
  }
  try{
    const before=botList(p,run);
    // A bot may need a current model login. In that case team apply will refuse,
    // leave the prior team untouched and the caller will see a precise blocker.
    atomicFile(f,p.soul);atomicFile(t,p.team);
    atomicFile(r,JSON.stringify({schema:1,soulHash:digest(p.soul),teamHash:digest(p.team)})+NL);
    vendorRun(p,['team','apply',t,'--dry-run','--json'],run);
    vendorRun(p,['team','apply',t,'--json'],run);
    const bots=botList(p,run);
    const applied=verifyAppliedBot(bots,before,p.source);
    // The routine belongs to the bot itself: create it through the vendor trigger
    // tool, then confirm with trigger_info. A failure here does not undo the bot,
    // and is reported as unverified rather than assumed.
    let schedule;
    try{
      schedule=ensureMaintainerRoutine({cli:p.vendorCli,port:p.port,routine:p.routine,run});
    }catch(error){
      schedule={created:false,verified:false,reason:String(error?.message||error).slice(0,120)};
    }
    return {...response,botRegistrationVerified:true,
      botConfigVerified:applied.configFieldsCompared.length>0,
      botConfigFieldsCompared:applied.configFieldsCompared,
      otherBotsPreserved:applied.otherBotsPreserved,
      scheduleCreated:schedule.created===true,scheduleVerified:schedule.verified===true,
      scheduleReason:schedule.reason??null,scheduleTriggerId:schedule.triggerId??null,
      scheduleNextRunAt:schedule.nextRunAt??null,chatReportVerified:false,
      liveRulesLoadedVerified:false,reloadRequired:true};
  } finally {
    try{unlinkSync(lock)}catch{/* already gone */}
  }
}

/** Read-only: is the Maintainer's routine present, enabled and scheduled? */
export function verifyMaintainerSchedule({rcRoot,run=spawnSync,now=Date.now()}){
  const ins=instanceFor(safePath(rcRoot),{requireLivePid:process.platform==='win32'});
  const result=readMaintainerRoutine({cli:ins.cli,port:ins.port,name:routineName,run,now});
  return {schema:'singularity-omb-maintainer-schedule/v1',mode:'READ_ONLY',routine:routineName,...result};
}

function main(args){
  const kv={};let apply=false,verifySchedule=false;
  for(let i=0;i<args.length;i++){
    if(args[i]==='--apply'){if(apply)fail('USAGE');apply=true;continue}
    if(args[i]==='--verify-schedule'){if(verifySchedule)fail('USAGE');verifySchedule=true;continue}
    if(!['--source','--rc-root'].includes(args[i])||kv[args[i]]||!args[i+1])fail('USAGE');
    kv[args[i]]=args[++i];
  }
  if(verifySchedule){
    if(!kv['--rc-root'])fail('USAGE');
    const v=verifyMaintainerSchedule({rcRoot:kv['--rc-root']});
    process.stdout.write(JSON.stringify(v)+NL);
    if(v.verified!==true)process.exitCode=1;
    return;
  }
  if(!kv['--source']||!kv['--rc-root'])fail('USAGE');
  const r=provisionMaintainer({source:kv['--source'],rcRoot:kv['--rc-root'],apply});
  process.stdout.write(JSON.stringify(r)+NL);
  // A bot without its verified routine is not an installed Maintainer.
  if(apply&&r.scheduleVerified!==true)process.exitCode=1;
}
if(process.argv[1]&&resolve(process.argv[1])===fileURLToPath(import.meta.url)){
  try{main(process.argv.slice(2))}
  catch(e){process.stderr.write('OMB_MAINTAINER_PROVISION_REFUSED: '+e.message+NL);process.exitCode=2}
}
