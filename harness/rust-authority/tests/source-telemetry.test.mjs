import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,readFileSync,rmSync} from 'node:fs';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {pathToFileURL} from 'node:url';
import {fromInvocation,fromObserver,SUPPORTED_OBSERVER_TRANSITIONS} from '../adapter/source-telemetry.mjs';
import {REFERENCE_KIT} from './reference-kit.mjs';

const src=REFERENCE_KIT;
const usage=await import(pathToFileURL(join(src,'lib','invocation-telemetry.mjs')).href);
const observer=await import(pathToFileURL(join(src,'lib','observer-sink.mjs')).href);

test('actual source invocation ledger translates only safe bounded fields',()=>{
  const root=mkdtempSync(join(tmpdir(),'orchestra-usage-test-'));
  try{
    usage.initTelemetry(root);
    assert.equal(usage.recordInvocation({engine:'openai-sol',runId:'r44',success:true,attempt:1,
      durationMs:440,inputTokens:100,outputTokens:20,purpose:'Customer password',note:'SECRET NOTE'}),true);
    const rows=readFileSync(join(root,'engine-usage.jsonl'),'utf8').trim().split('\n');
    const translated=fromInvocation(JSON.parse(rows[0]));
    assert.equal(translated.kind,'model_invocation');
    assert.equal(translated.runId,'r44');
    assert.equal(translated.success,true);
    assert.equal(translated.durationMs,440);
    assert.equal(translated.inputTokens,100);
    assert.equal(translated.costUsd,undefined);
    assert.equal(translated.purpose,undefined);
    assert.equal(translated.note,undefined);
    assert.equal(JSON.stringify(translated).includes('SECRET'),false);
  }finally{rmSync(root,{recursive:true,force:true});}
});

test('actual source observer events translate run lifecycle without sensitive labels',()=>{
  const root=mkdtempSync(join(tmpdir(),'orchestra-observer-test-'));
  const file=join(root,'events.jsonl');
  try{
    const emitted=observer.emitObserverEvent(file,{transition:'run_completed',caseId:'r44',
      agentSessionId:'s44',visualRole:'CONSULTANT',engine:'openai-sol',
      displayName:'Sensitive customer name',phase:'SECRET TASK TITLE',status:'customer secrets'});
    assert.equal(emitted.ok,true);
    const row=JSON.parse(readFileSync(file,'utf8'));
    const translated=fromObserver(row);
    assert.deepEqual(translated,{kind:'run_completed',runId:'r44',sessionId:'s44',engine:'openai-sol',role:'CONSULTANT'});
    assert.equal(JSON.stringify(translated).includes('SECRET'),false);
  }finally{rmSync(root,{recursive:true,force:true});}
});

test('missing IDs and unknown transitions are dropped, never invented',()=>{
  assert.equal(fromObserver({transition:'run_completed',displayName:'Ben'}),null);
  assert.equal(fromObserver({transition:'unrecognized',caseId:'r1'}),null);
  assert.equal(fromInvocation({runId:'r1',prompt:'secret'}),null);
  assert.equal(fromInvocation({engine:'provider',runId:'../secret'}).runId,undefined);
});

test('translates source transition allowlist, with no raw fields',()=>{
  assert.ok(SUPPORTED_OBSERVER_TRANSITIONS.includes('run_completed'));
  for(const transition of SUPPORTED_OBSERVER_TRANSITIONS){
    const event=fromObserver({transition,caseId:'r1',phase:'Secret phase description',displayName:'Secret person'});
    assert.ok(event && event.kind && event.runId==='r1',transition);
    assert.deepEqual(Object.keys(event).sort(),['kind','runId']);
  }
});
