// Sanity checks for the real JavaScript state contracts before Rust cutover.
// These tests do NOT exercise the Rust implementation.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { pathToFileURL } from 'node:url';
const root=process.env.ORCHESTRA_REFERENCE_KIT;
if(!root)throw Error('ORCHESTRA_REFERENCE_KIT must name original kit folder');
const moduleOf=async name=>import(pathToFileURL(resolve(root,'lib',name+'.mjs')).href);
const caseStore=await moduleOf('case-store');
const {EngineState}=await moduleOf('engine-state');
function isolated(fn){const dir=mkdtempSync(join(tmpdir(),'orch-rust-reference-'));try{return fn(dir);}finally{rmSync(dir,{recursive:true,force:true});}}

test('case CAS is monotonic and a stale writer cannot replace current state',()=>isolated(dir=>{
 const one=caseStore.writeCase(dir,0,()=>({task:'A'}));
 assert.equal(one.rev,1);
 const stale=caseStore.writeCase(dir,0,()=>({task:'WRONG'}));
 assert.equal(stale.code,'stale');
 assert.equal(JSON.parse(readFileSync(join(dir,'case.json'),'utf8')).task,'A');
 const two=caseStore.writeCase(dir,1,()=>({task:'B'}));
 assert.equal(two.rev,2);
}));
test('pending remote intents remain observable and unsupported completions reject',()=>isolated(dir=>{
 caseStore.journalIntent(dir,{opId:'write-1',op:'post',caseId:'abc'});
 assert.equal(caseStore.pendingIntents(dir).length,1);
 assert.equal(caseStore.journalComplete(dir,'write-1',{state:'unknown'}),true);
 assert.equal(caseStore.pendingIntents(dir).length,0);
 assert.equal(caseStore.readJournal(dir)[0].state,'unknown');
 assert.equal(caseStore.journalComplete(dir,'missing',{state:'done'}),false);
 assert.throws(()=>caseStore.journalComplete(dir,'write-1',{state:'approved'}),/bad state/);
}));
test('Claude is hard disabled and cannot be reactivated',()=>isolated(dir=>{
 const es=new EngineState(dir);
 assert.equal(es.available('claude'),false);
 es.markSuccess('claude');
 assert.equal(es.get('claude').state,'disabled');
}));
test('explicit disabled state blocks an engine regardless of healthy status',()=>isolated(dir=>{
 const es=new EngineState(dir);
 es.update('worker', x=>({...x,state:'available',enabled:false}));
 assert.equal(es.available('worker'),false);
}));
