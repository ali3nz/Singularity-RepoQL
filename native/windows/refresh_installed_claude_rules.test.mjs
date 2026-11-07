import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,mkdirSync,writeFileSync,readFileSync,rmSync,symlinkSync} from 'node:fs';
import {join,resolve} from 'node:path';
import {tmpdir} from 'node:os';
import {createHash,randomUUID} from 'node:crypto';
import {inspectRuleRefresh,refreshOwnedRule} from './refresh_installed_claude_rules.mjs';
const sha=x=>createHash('sha256').update(x).digest('hex');
function fixture() {
 const base=mkdtempSync(join(tmpdir(),'claude-rule-refresh-'));
 const source=join(base,'stage'); const home=join(base,'user');
 const dir=join(home,'.claude','rules');mkdirSync(dir,{recursive:true});
 const srcDir=join(source,'adapters','claude-code');mkdirSync(srcDir,{recursive:true});
 const sourceFile=join(srcDir,'singularity-workflow.md');writeFileSync(sourceFile,'new rules');
 const target=join(dir,'singularity-workflow.md');writeFileSync(target,'old rules');
 const receipt=join(home,'.claude','.singularity-native-claude-journal.json');
 const journal={schema:'singularity-claude-native-config/v1',state:'APPLIED',source,
  rules:[{path:target,sha256:sha('old rules')}],agents:[],skills:[]};
 writeFileSync(receipt,JSON.stringify(journal));
 return {base,source,home,target,receipt,journal,sourceFile};
}
function run(fn){const f=fixture();try{fn(f);}finally{rmSync(f.base,{recursive:true,force:true});}}
test('read-only plan cannot alter installed rule or receipt',()=>run(f=>{
 const before=readFileSync(f.receipt,'utf8');
 assert.equal(refreshOwnedRule({source:f.source,home:f.home}).status,'READY');
 assert.equal(readFileSync(f.target,'utf8'),'old rules');
 assert.equal(readFileSync(f.receipt,'utf8'),before);
}));
test('owned installation refreshes rule and journal, is idempotent',()=>run(f=>{
 assert.equal(refreshOwnedRule({source:f.source,home:f.home,apply:true}).status,'UPDATED');
 assert.equal(readFileSync(f.target,'utf8'),'new rules');
 const journal=JSON.parse(readFileSync(f.receipt,'utf8'));
 assert.equal(journal.rules[0].sha256,sha('new rules'));
 assert.equal(journal.ruleRefresh,undefined);
 assert.equal(refreshOwnedRule({source:f.source,home:f.home,apply:true}).status,'ALREADY_CURRENT');
}));
test('modified foreign rule fails closed without writing',()=>run(f=>{
 writeFileSync(f.target,'user customization');
 assert.throws(()=>refreshOwnedRule({source:f.source,home:f.home,apply:true}),/INSTALLED_RULE_CHANGED/);
 assert.equal(readFileSync(f.target,'utf8'),'user customization');
}));
test('unowned file cannot be replaced',()=>run(f=>{
 f.journal.rules=[];writeFileSync(f.receipt,JSON.stringify(f.journal));
 assert.throws(()=>refreshOwnedRule({source:f.source,home:f.home,apply:true}),/OWNERSHIP_NOT_VERIFIED/);
}));
test('crash after rule replacement resumes exactly once',()=>run(f=>{
 const id=randomUUID();const backup=join(f.home,'.claude','rules',`.singularity-rule-refresh-${id}.bak`);
 writeFileSync(backup,'old rules');writeFileSync(f.target,'new rules');
 f.journal.ruleRefresh={id,path:f.target,before:sha('old rules'),after:sha('new rules'),backup};
 writeFileSync(f.receipt,JSON.stringify(f.journal));
 assert.equal(inspectRuleRefresh({source:f.source,home:f.home}).state,'RESUME_REQUIRED');
 assert.equal(refreshOwnedRule({source:f.source,home:f.home,apply:true}).status,'UPDATED');
 assert.equal(refreshOwnedRule({source:f.source,home:f.home}).status,'ALREADY_CURRENT');
}));
test('crash before replacement resumes from recorded backup',()=>run(f=>{
 const id=randomUUID();const backup=join(f.home,'.claude','rules',`.singularity-rule-refresh-${id}.bak`);
 writeFileSync(backup,'old rules');
 f.journal.ruleRefresh={id,path:f.target,before:sha('old rules'),after:sha('new rules'),backup};
 writeFileSync(f.receipt,JSON.stringify(f.journal));
 assert.equal(refreshOwnedRule({source:f.source,home:f.home,apply:true}).status,'UPDATED');
 assert.equal(readFileSync(f.target,'utf8'),'new rules');
}));
test('cannot resume if pending backup or installed rule was tampered',()=>run(f=>{
 const id=randomUUID();const backup=join(f.home,'.claude','rules',`.singularity-rule-refresh-${id}.bak`);
 writeFileSync(backup,'unknown');
 f.journal.ruleRefresh={id,path:f.target,before:sha('old rules'),after:sha('new rules'),backup};
 writeFileSync(f.receipt,JSON.stringify(f.journal));
 assert.throws(()=>refreshOwnedRule({source:f.source,home:f.home,apply:true}),/RECOVERY_REQUIRES_REVIEW/);
}));
test('symlink path denied',()=>run(f=>{
 rmSync(f.target);symlinkSync(f.sourceFile,f.target);
 assert.throws(()=>inspectRuleRefresh({source:f.source,home:f.home}),/REPARSE_PATH_REFUSED/);
}));
