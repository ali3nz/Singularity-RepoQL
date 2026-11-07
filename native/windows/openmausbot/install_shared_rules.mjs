#!/usr/bin/env node
/** Scoped installer for OpenMausBot's shared bot-ancestor AGENTS.md.
 * Default ~/.openmausbot/bots/AGENTS.md is read as an ancestor of each bot
 * workspace (server/bot-folder.ts + server/lending-memory.ts). No polling.
 * Existing user AGENTS.md is never overwritten. No user-global Claude edits.
 */
import { existsSync, lstatSync, mkdirSync, readFileSync, writeFileSync, renameSync, unlinkSync, openSync, closeSync, fsyncSync } from 'node:fs';
import { join, dirname, resolve, isAbsolute } from 'node:path';
import { homedir } from 'node:os';
import { createHash, randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
const digest=x=>createHash('sha256').update(x).digest('hex');
const fail=m=>{throw new Error(m)};
const own='AGENTS.md',receipt='.singularity-openmausbot-rules.json';
export function planRules({dataDir=join(homedir(),'.openmausbot'), template=fileURLToPath(new URL('./AGENTS.md',import.meta.url))}={}) {
  if(typeof dataDir!=='string'||!isAbsolute(dataDir))fail('DATA_DIR_MUST_BE_ABSOLUTE');
  const botDir=join(resolve(dataDir),'bots');
  if(!existsSync(dataDir)||!lstatSync(dataDir).isDirectory())fail('OPENMAUSBOT_DATA_DIR_NOT_INSTALLED');
  if(!existsSync(botDir)||!lstatSync(botDir).isDirectory())fail('OPENMAUSBOT_BOTS_DIR_NOT_INSTALLED');
  for(let p=botDir;p!==dirname(p);p=dirname(p)){
    if(existsSync(p) && lstatSync(p).isSymbolicLink())fail('REPARSE_PATH_REFUSED');
  }
  const target=join(botDir,own), stamp=join(botDir,receipt), bytes=readFileSync(template);
  for(const f of [target,stamp]) if(existsSync(f) && (!lstatSync(f).isFile()||lstatSync(f).isSymbolicLink()))fail('REPARSE_FILE_REFUSED');
  const original=existsSync(target)?readFileSync(target):null;
  const state=original===null?'absent':original.equals(bytes)?'matching':'foreign';
  return {botDir,target,stamp,bytes,sha256:digest(bytes),state};
}
export function installRules(opts={},fixture=false) {
  if(process.platform!=='win32'&&!fixture)fail('WINDOWS_ONLY_MUTATION');
  const p=planRules(opts);
  if(p.state==='foreign')fail('EXISTING_AGENTS_FILE_PRESERVED');
  if(p.state==='matching')return {changed:false,matched:true,receipt:existsSync(p.stamp),sha256:p.sha256};
  if(existsSync(p.stamp))fail('OLD_RECEIPT_WITHOUT_RULES');
  // A receipt must exist before the owned file is created; crashed installs are
  // visibly incomplete and will be refused instead of overwritten.
  const j=JSON.stringify({schema:1,target:p.target,sha256:p.sha256})+'\n';
  const fd=openSync(p.stamp,'wx',0o600);
  try{writeFileSync(fd,j);fsyncSync(fd)}finally{closeSync(fd)}
  // 'wx' refuses a concurrent user-created AGENTS.md instead of replacing it.
  const tf=openSync(p.target,'wx',0o600);
  try{writeFileSync(tf,p.bytes);fsyncSync(tf)}finally{closeSync(tf)}
  return {changed:true,matched:true,receipt:true,sha256:p.sha256};
}
export function verifyRules(opts={}){
  const p=planRules(opts);
  if(p.state!=='matching'||!existsSync(p.stamp))fail('RULES_NOT_INSTALLED_OR_CHANGED');
  const r=JSON.parse(readFileSync(p.stamp,'utf8'));
  if(r.schema!==1||r.target!==p.target||r.sha256!==p.sha256)fail('RULES_RECEIPT_INVALID');
  return {verified:true,sha256:p.sha256,loadedIntoActiveTurn:false,gateEnforcementVerified:false};
}
export function rollbackRules(opts={},fixture=false){
  if(process.platform!=='win32'&&!fixture)fail('WINDOWS_ONLY_MUTATION');
  const p=planRules(opts);
  if(!existsSync(p.stamp))fail('RULES_RECEIPT_MISSING');
  verifyRules(opts);
  unlinkSync(p.target);unlinkSync(p.stamp);
  return {rolledBack:true};
}
if(process.argv[1]&&resolve(process.argv[1])===fileURLToPath(import.meta.url))try {
  const args=process.argv.slice(2);const mode=args.shift()??'plan';
  if(args.length)fail('USAGE');
  const p=planRules();let o;
  if(mode==='plan')o={mode:'READ_ONLY',state:p.state,sha256:p.sha256,gateEnforcementVerified:false};
  else if(mode==='apply')o=installRules();
  else if(mode==='verify')o=verifyRules();
  else if(mode==='rollback')o=rollbackRules();
  else fail('USAGE');
  process.stdout.write(JSON.stringify(o)+'\n');
}catch(e){process.stderr.write('OMB_RULES_REFUSED: '+e.message+'\n');process.exitCode=2}
