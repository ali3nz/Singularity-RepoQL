#!/usr/bin/env node
/**
 * Refresh ONLY the workflow rule owned by an existing native Claude Code install.
 * This is intentionally separate from first-time configuration: upgrading the
 * source must not require removing the user's existing Claude settings/hooks.
 *
 * Default: read-only plan. Apply: Windows only and explicit --apply. The installer
 * receipt establishes ownership. A two-file transaction journal supports resume
 * if Windows restarts between replacement of the rule and the install receipt.
 */
import {createHash, randomUUID} from 'node:crypto';
import {existsSync, lstatSync, readFileSync, writeFileSync, openSync, closeSync,
  renameSync, rmSync, fsyncSync} from 'node:fs';
import {join, resolve, dirname} from 'node:path';
import {fileURLToPath} from 'node:url';

const digest = bytes => createHash('sha256').update(bytes).digest('hex');
const SHA = /^[a-f0-9]{64}$/;
const error = text => {throw new Error(text);};
const ownedFile = path => {
  let at = resolve(path);
  for (;;) {
    try {if(lstatSync(at).isSymbolicLink())error('REPARSE_PATH_REFUSED');}
    catch(e){if(e.code!=='ENOENT')throw e;}
    const parent = dirname(at);
    if (parent === at) break;
    at = parent;
  }
};
const hashFile = path => existsSync(path) ? digest(readFileSync(path)) : null;
function exclusive(path,bytes) {
  const fd = openSync(path,'wx',0o600);
  try {writeFileSync(fd,bytes);fsyncSync(fd);} finally {closeSync(fd);}
}
function atomic(path,bytes) {
  const tmp = `${path}.refresh-${randomUUID()}`;
  exclusive(tmp,bytes);
  try {renameSync(tmp,path);} finally {rmSync(tmp,{force:true});}
}
const serialized = value => JSON.stringify(value,null,2)+'\n';

export function inspectRuleRefresh({source,home}) {
  source=resolve(source);home=resolve(home);
  const claude=join(home,'.claude');
  const target=join(claude,'rules','singularity-workflow.md');
  const sourceFile=join(source,'adapters','claude-code','singularity-workflow.md');
  const receipt=join(claude,'.singularity-native-claude-journal.json');
  for(const file of [source,home,target,sourceFile,receipt])ownedFile(file);
  if(!existsSync(sourceFile)||!existsSync(receipt))error('INSTALL_RECEIPT_OR_SOURCE_MISSING');
  let journal;
  try {journal=JSON.parse(readFileSync(receipt,'utf8'));}
  catch {error('INSTALL_RECEIPT_INVALID');}
  if(journal.schema!=='singularity-claude-native-config/v1'||journal.state!=='APPLIED'||
     resolve(journal.source||'')!==source||!Array.isArray(journal.rules)||journal.rules.length!==1||
     journal.rules[0].path!==target||!SHA.test(journal.rules[0].sha256))
    error('WORKFLOW_RULE_OWNERSHIP_NOT_VERIFIED');
  const next=hashFile(sourceFile),current=hashFile(target);
  if(!next||!current)error('WORKFLOW_RULE_MISSING');
  if(journal.ruleRefresh) {
    const pending=journal.ruleRefresh;
    const expectedBackup=join(claude,'rules',`.singularity-rule-refresh-${pending.id}.bak`);
    if(!/^[a-f0-9-]{36}$/.test(pending.id||'')||pending.path!==target||
       pending.backup!==expectedBackup||!SHA.test(pending.before||'')||!SHA.test(pending.after||'')||
       pending.before!==journal.rules[0].sha256||pending.after!==next||
       hashFile(expectedBackup)!==pending.before||![pending.before,pending.after].includes(current))
      error('RULE_REFRESH_RECOVERY_REQUIRES_REVIEW');
    ownedFile(expectedBackup);
    return {state:'RESUME_REQUIRED',source,target,receipt,current,next,journal,pending};
  }
  if(current!==journal.rules[0].sha256)error('INSTALLED_RULE_CHANGED_REFUSE_OVERWRITE');
  return {state:next===current?'ALREADY_CURRENT':'READY',source,target,receipt,current,next,journal};
}

export function refreshOwnedRule({source,home,apply=false}) {
  const root=resolve(home,'.claude');
  const lock=join(root,'.singularity-native-claude.lock');
  if(!apply) {
    const p=inspectRuleRefresh({source,home});
    return {status:p.state,readOnly:true,sourceSha256:p.next,installedSha256:p.current};
  }
  ownedFile(lock);
  const fd=openSync(lock,'wx',0o600);
  try {
    const p=inspectRuleRefresh({source,home});
    if(p.state==='ALREADY_CURRENT')return {status:'ALREADY_CURRENT',readOnly:false};
    let journal=p.journal;
    let pending=p.pending;
    if(!pending) {
      const id=randomUUID();
      pending={id,path:p.target,before:p.current,after:p.next,
        backup:join(root,'rules',`.singularity-rule-refresh-${id}.bak`)};
      exclusive(pending.backup,readFileSync(p.target));
      journal.ruleRefresh=pending;
      atomic(p.receipt,serialized(journal));
    }
    if(hashFile(p.target)===pending.before)
      atomic(p.target,readFileSync(join(p.source,'adapters','claude-code','singularity-workflow.md')));
    if(hashFile(p.target)!==pending.after)error('WORKFLOW_REFRESH_POSTWRITE_HASH_MISMATCH');
    journal.rules[0].sha256=pending.after;
    delete journal.ruleRefresh;
    atomic(p.receipt,serialized(journal));
    rmSync(pending.backup);
    return {status:'UPDATED',readOnly:false,previousSha256:pending.before,newSha256:pending.after};
  } finally {closeSync(fd);rmSync(lock,{force:true});}
}

function parse(args) {
  const options={};
  for(let i=0;i<args.length;i++) {
    const k=args[i];
    if(k==='--apply'){options.apply=true;continue;}
    if(!['--source','--home'].includes(k)||!args[i+1]||args[i+1].startsWith('--')||options[k])error('INVALID_ARGUMENT');
    options[k]=args[++i];
  }
  if(!options['--source']||!options['--home'])error('SOURCE_AND_HOME_REQUIRED');
  return {source:options['--source'],home:options['--home'],apply:options.apply||false};
}
const invoked=process.argv[1] && resolve(process.argv[1])===fileURLToPath(import.meta.url);
if(invoked) {
  try {
    const opts=parse(process.argv.slice(2));
    if(opts.apply && process.platform!=='win32')error('WINDOWS_APPLY_ONLY');
    process.stdout.write(serialized(refreshOwnedRule(opts)));
  } catch(e) {process.stderr.write(`${String(e?.message||e)}\n`);process.exitCode=2;}
}
