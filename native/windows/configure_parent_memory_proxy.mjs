#!/usr/bin/env node
/**
 * Explicit, owner-checked parent-session memory proxy configuration for native
 * Claude Code Complete. Does not take over an existing foreign model provider.
 * Configuration files are local and private; receipts never include secrets.
 */
import {existsSync,lstatSync,readFileSync,writeFileSync,mkdirSync,openSync,closeSync,fsyncSync,renameSync,unlinkSync} from 'node:fs';
import {dirname,join,resolve} from 'node:path';
import {createHash,createHmac,randomBytes,randomUUID} from 'node:crypto';
import {fileURLToPath} from 'node:url';
import {ensureMainMemoryIntegration,detectProviderConflicts} from '../../adapters/claude-code/main-memory.mjs';

const SCHEMA='singularity-option2-parent-proxy/v1';
const RECEIPT='.singularity-parent-memory-proxy-receipt.json';
const LOCK='.singularity-parent-memory-proxy.lock';
const hash=x=>createHash('sha256').update(x).digest('hex');
const serialize=x=>Buffer.from(JSON.stringify(x,null,2)+'\n');
function reject(message){throw new Error(message)}
function assertPlain(path,allowMissing=false){
 let cursor=resolve(path);
 while(true){
  if(existsSync(cursor)){
   const st=lstatSync(cursor);if(st.isSymbolicLink())reject('PROXY_PATH_SYMLINK_REFUSED');
  }else if(!allowMissing)reject('PROXY_PATH_MISSING');
  const up=dirname(cursor);if(up===cursor)break;cursor=up;
 }
}
function objectFrom(path){const bytes=readFileSync(path);if(bytes.length<1||bytes.length>65536)reject('PROXY_CONFIG_SIZE_INVALID');
 const item=JSON.parse(bytes.toString('utf8'));
 if(!item||typeof item!=='object'||Array.isArray(item))reject('PROXY_CONFIG_OBJECT_REQUIRED');return item;}
function configOf(path){assertPlain(path);const value=objectFrom(path);
 if(Object.keys(value).sort().join(',')!=='baseUrl,model,schema,token'||value.schema!==SCHEMA ||
    typeof value.baseUrl!=='string'||typeof value.token!=='string'||typeof value.model!=='string'||
    value.token.length<8||value.token.length>4096||value.model.length<1||value.model.length>128)
    reject('PROXY_CONFIG_SCHEMA_INVALID');
 let url;try{url=new URL(value.baseUrl)}catch{reject('PROXY_LOOPBACK_URL_REQUIRED')}
 if(url.protocol!=='http:'||url.hostname!=='127.0.0.1'||!url.port||url.username||url.password||
   !/^\/claude-code\/[a-zA-Z0-9_-]{1,64}$/.test(url.pathname)||url.search||url.hash||
   value.baseUrl!==url.href)reject('PROXY_LOOPBACK_URL_REQUIRED');
 return value;
}
function paths(home){if(typeof home!=='string'||!home)reject('HOME_REQUIRED');
 const claude=join(resolve(home),'.claude');const settings=join(claude,'settings.json');
 assertPlain(claude);assertPlain(settings,true);
 return {claude,settings,receipt:join(claude,RECEIPT),lock:join(claude,LOCK)};
}
function withLock(lock,run){const fd=openSync(lock,'wx',0o600);try{return run()}finally{closeSync(fd);unlinkSync(lock)}}
function writeNew(file,bytes){const fd=openSync(file,'wx',0o600);try{writeFileSync(fd,bytes);fsyncSync(fd)}finally{closeSync(fd)}}
function current(file){return existsSync(file)?readFileSync(file):null}
export function planParentProxy({home,configFile}){
 const p=paths(home),cfg=configOf(configFile),before=current(p.settings),settings=before?objectFrom(p.settings):{};
 if(existsSync(p.receipt))reject('OUTSTANDING_PARENT_PROXY_RECEIPT');
 const conflicts=detectProviderConflicts(settings,{baseUrl:cfg.baseUrl});
 // Never quietly switch foreign model providers, including existing keys;
 // route adoption requires a separate operator/provider migration.
 if(conflicts.length)reject('FOREIGN_PROVIDER_CONFLICT_REFUSED');
 if(settings.env?.ANTHROPIC_AUTH_TOKEN!==undefined && settings.env.ANTHROPIC_AUTH_TOKEN!==cfg.token)
   reject('EXISTING_PROVIDER_TOKEN_CONFLICT_REFUSED');
 if(settings.env?.ANTHROPIC_MODEL!==undefined && settings.env.ANTHROPIC_MODEL!==cfg.model)
   reject('EXISTING_PROVIDER_MODEL_CONFLICT_REFUSED');
 const merged=ensureMainMemoryIntegration(settings,{baseUrl:cfg.baseUrl,token:cfg.token,model:cfg.model,replaceProvider:false});
 if(merged.mode==='refused-conflict')reject('FOREIGN_PROVIDER_CONFLICT_REFUSED');
 const after=serialize(merged.settings);
 // Bind the credential value this helper installs, without storing or printing
 // it. A salted HMAC lets the consumer prove the token on disk is still the one
 // written here; a replaced or placeholder token fails closed instead of being
 // trusted because the proxy URL happens to survive.
 const credentialSalt=randomBytes(16).toString('hex');
 const credentialBinding=createHmac('sha256',Buffer.from(credentialSalt,'hex')).update(cfg.token).digest('hex');
 return {paths:p,before,after,beforeSha:before?hash(before):null,afterSha:hash(after),
   changed:before===null||!before.equals(after),endpointConfigured:true,
   credentialSalt,credentialBinding,liveProviderVerified:false};
}
export function applyParentProxy({home,configFile,apply=false,windowsHost=process.platform==='win32'}){
 if(!windowsHost||!apply)reject('NATIVE_WINDOWS_AND_EXPLICIT_APPLY_REQUIRED');
 const p=planParentProxy({home,configFile});
 if(!p.changed)reject('PARENT_PROXY_NO_CHANGE_TO_OWN');
 return withLock(p.paths.lock,()=>{
   if(existsSync(p.paths.receipt)||!((current(p.paths.settings)===null&&p.before===null)||
      (current(p.paths.settings)?.equals(p.before)===true)))reject('CONCURRENT_SETTINGS_CHANGE');
   const backup=p.before===null?null:p.paths.settings+'.singularity-parent-backup-'+randomUUID();
   if(backup)writeNew(backup,p.before);
   const tmp=p.paths.settings+'.singularity-parent-new-'+randomUUID();
   const receipt={schema:SCHEMA,state:'APPLIED',settings:p.paths.settings,backup,
     beforeSha:p.beforeSha,afterSha:p.afterSha,pendingTmp:tmp,
     credentialSalt:p.credentialSalt,credentialBinding:p.credentialBinding};
   // Journal the exact owned secret-bearing temporary file BEFORE writing it.
   // Otherwise an interruption leaves credentials in an orphaned file that
   // receipt-owned rollback cannot safely identify or clean.
   writeNew(p.paths.receipt,serialize(receipt));
   try{writeNew(tmp,p.after);renameSync(tmp,p.paths.settings)}
   catch(e){try{unlinkSync(tmp)}catch{};throw e}
   if(hash(readFileSync(p.paths.settings))!==p.afterSha)reject('PARENT_PROXY_WRITE_VERIFY_FAILED');
   return {applied:true,option:2,settingsChanged:true,providerRuntimeVerified:false,releaseReady:false};
 });
}
// Only the journal-owned temp file is eligible for cleanup. Never glob for
// stale files because foreign files may belong to another application.
function pendingPath(journal,settings){
 if(journal.pendingTmp===undefined)return null; // M56 receipt
 const prefix=settings+'.singularity-parent-new-';
 if(typeof journal.pendingTmp!=='string'||!journal.pendingTmp.startsWith(prefix)||
    !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(journal.pendingTmp.slice(prefix.length)))
   reject('PARENT_PROXY_PENDING_TEMP_UNOWNED');
 assertPlain(journal.pendingTmp,true);
 return journal.pendingTmp;
}
function checkPending(journal,settings){
 const tmp=pendingPath(journal,settings);
 if(!tmp)return null;
 let stat;
 try{stat=lstatSync(tmp)}catch(e){if(e.code==='ENOENT')return null;throw e}
 if(!stat.isFile()||stat.isSymbolicLink()||hash(readFileSync(tmp))!==journal.afterSha)
   reject('PARENT_PROXY_PENDING_TEMP_DRIFT');
 return tmp;
}

// The exact settings restore temp is recorded before any old settings bytes are
// written. Its digest is the previous saved settings digest, not a new secret.
function restoreTempPath(journal,settings){
 if(journal.restoreTmp===undefined)return null;
 const prefix=settings+'.singularity-parent-restore-';
 if(!journal.beforeSha||typeof journal.restoreTmp!=='string'||!journal.restoreTmp.startsWith(prefix)||
    !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(journal.restoreTmp.slice(prefix.length)))
    reject('PARENT_PROXY_RESTORE_TEMP_UNOWNED');
 assertPlain(journal.restoreTmp,true);
 return journal.restoreTmp;
}
function checkRestoreTemp(journal,settings){
 const tmp=restoreTempPath(journal,settings);
 if(!tmp)return null;
 let stat;
 try{stat=lstatSync(tmp)}catch(e){if(e.code==='ENOENT')return null;throw e}
 if(!stat.isFile()||stat.isSymbolicLink()||hash(readFileSync(tmp))!==journal.beforeSha)
    reject('PARENT_PROXY_RESTORE_TEMP_DRIFT');
 return tmp;
}
function journalRestore(file,journal,restoreTmp){
 // The journal replacement itself contains hashes and paths, never token bytes.
 const receiptTemp=file+'.journal-'+randomUUID();
 writeNew(receiptTemp,serialize({...journal,restoreTmp}));
 renameSync(receiptTemp,file);
}

export function verifyParentProxy({home}){
 const p=paths(home);if(!existsSync(p.receipt))return {configured:false,issues:['NO_PARENT_PROXY_RECEIPT'],runtimeVerified:false};
 const journal=objectFrom(p.receipt);
 if(journal.schema!==SCHEMA||journal.state!=='APPLIED'||journal.settings!==p.settings||
    !/^[a-f0-9]{64}$/.test(journal.afterSha)||
    (journal.beforeSha!==null&&!/^[a-f0-9]{64}$/.test(journal.beforeSha))||
    (journal.credentialBinding!==undefined&&
      !(/^[a-f0-9]{32}$/.test(journal.credentialSalt||'')&&/^[a-f0-9]{64}$/.test(journal.credentialBinding))))
    reject('PARENT_PROXY_RECEIPT_INVALID');
 const pending=checkPending(journal,p.settings);
 checkRestoreTemp(journal,p.settings);
 const rollbackStarted=journal.restoreTmp!==undefined;
 const ok=!rollbackStarted && hash(readFileSync(p.settings))===journal.afterSha && pending===null;
 return {configured:ok,issues:rollbackStarted?['PARENT_PROXY_ROLLBACK_IN_PROGRESS']:(pending?['PARENT_PROXY_PENDING_TEMP_REMAINS']:(ok?[]:['PARENT_PROXY_SETTINGS_DRIFT'])),
   runtimeVerified:false,liveMemoryRecallVerified:false,releaseReady:false};
}
export function rollbackParentProxy({home,apply=false,windowsHost=process.platform==='win32'}){
 if(!windowsHost||!apply)reject('NATIVE_WINDOWS_AND_EXPLICIT_APPLY_REQUIRED');
 const p=paths(home);
 return withLock(p.lock,()=>{
  if(!existsSync(p.receipt))reject('NO_PARENT_PROXY_RECEIPT');
  const journal=objectFrom(p.receipt);
  if(journal.schema!==SCHEMA||journal.state!=='APPLIED'||journal.settings!==p.settings||
     !/^[a-f0-9]{64}$/.test(journal.afterSha))reject('PARENT_PROXY_RECEIPT_INVALID');
  const pending=checkPending(journal,p.settings);
  const restorePending=checkRestoreTemp(journal,p.settings);
  const actual=current(p.settings),actualSha=actual?hash(actual):null;
  if(actualSha!==journal.afterSha){
    // Interrupted apply may leave the ORIGINAL settings unchanged. This is a
    // recoverable owned journal, not foreign drift; never overwrite either.
    if(actualSha===journal.beforeSha){
      if(journal.beforeSha){
        if(typeof journal.backup!=='string'||!journal.backup.startsWith(p.settings+'.singularity-parent-backup-'))
          reject('PARENT_PROXY_BACKUP_UNOWNED');
        if(existsSync(journal.backup)){
          assertPlain(journal.backup);
          if(hash(readFileSync(journal.backup))!==journal.beforeSha)reject('PARENT_PROXY_BACKUP_CHANGED');
          unlinkSync(journal.backup);
        }else if(journal.restoreTmp===undefined)reject('PARENT_PROXY_BACKUP_MISSING');
      }else if(journal.backup!==null||journal.restoreTmp!==undefined)reject('PARENT_PROXY_UNEXPECTED_BACKUP');
      if(restorePending)unlinkSync(restorePending);
      if(pending)unlinkSync(pending);
      unlinkSync(p.receipt);
      return {rolledBack:true,interruptedApplyRecovered:true,releaseReady:false};
    }
    reject('PARENT_PROXY_SETTINGS_DRIFT');
  }
  if(journal.beforeSha){
    if(typeof journal.backup!=='string'||!journal.backup.startsWith(p.settings+'.singularity-parent-backup-'))
      reject('PARENT_PROXY_BACKUP_UNOWNED');
    assertPlain(journal.backup);
    if(hash(readFileSync(journal.backup))!==journal.beforeSha)reject('PARENT_PROXY_BACKUP_CHANGED');
    const temp=restoreTempPath(journal,p.settings)||p.settings+'.singularity-parent-restore-'+randomUUID();
    if(journal.restoreTmp===undefined)journalRestore(p.receipt,journal,temp);
    if(!restorePending)writeNew(temp,readFileSync(journal.backup));
    if(hash(readFileSync(temp))!==journal.beforeSha)reject('PARENT_PROXY_RESTORE_TEMP_DRIFT');
    renameSync(temp,p.settings);
    unlinkSync(journal.backup);
  }else {
    if(journal.backup!==null||journal.restoreTmp!==undefined)reject('PARENT_PROXY_UNEXPECTED_BACKUP');
    unlinkSync(p.settings);
  }
  if(pending)unlinkSync(pending);
  unlinkSync(p.receipt);
  return {rolledBack:true,option:2,providerRuntimeVerified:false,releaseReady:false};
 });
}
function main(argv){
 const vals={};const keys=['--home','--config','--mode','--apply'];
 for(let i=0;i<argv.length;i++){const k=argv[i];if(!keys.includes(k)||Object.hasOwn(vals,k))reject('INVALID_ARGUMENT');
  if(k==='--apply'){vals[k]=true;continue}
  if(!argv[i+1]||argv[i+1].startsWith('--'))reject('ARGUMENT_VALUE_REQUIRED');vals[k]=argv[++i]}
 const mode=vals['--mode']||'plan';const home=vals['--home'];
 let result;
 if(mode==='plan'){if(vals['--apply'])reject('PLAN_REFUSES_APPLY');const plan=planParentProxy({home,configFile:vals['--config']});
  result={mode,option:2,configurationChangeNeeded:plan.changed,providerRuntimeVerified:false,releaseReady:false}}
 else if(mode==='apply'){result=applyParentProxy({home,configFile:vals['--config'],apply:vals['--apply']===true})}
 else if(mode==='verify'){if(vals['--apply'])reject('VERIFY_REFUSES_APPLY');result=verifyParentProxy({home})}
 else if(mode==='rollback'){result=rollbackParentProxy({home,apply:vals['--apply']===true})}
 else reject('INVALID_MODE');
 process.stdout.write(JSON.stringify(result,null,2)+'\n');
}
if(process.argv[1]&&resolve(process.argv[1])===fileURLToPath(import.meta.url)){
 try{main(process.argv.slice(2))}catch{process.stderr.write('PARENT_PROXY_CONFIGURATION_REFUSED\n');process.exitCode=2}
}
