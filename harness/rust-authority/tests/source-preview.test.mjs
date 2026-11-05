import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,appendFileSync,writeFileSync,rmSync} from 'node:fs';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {readTail,summarizeLedgers,MAX_SCAN_BYTES,MAX_ROWS} from '../scripts/source-telemetry-preview.mjs';

test('read-only preview reports coverage without leaking raw identifiers or fields',()=>{
  const dir=mkdtempSync(join(tmpdir(),'orchestra-preview-'));
  try{
    const u=join(dir,'usage.jsonl'),o=join(dir,'observer.jsonl');
    writeFileSync(u,JSON.stringify({engine:'sol',success:true,runId:'SECRET_CUSTOMER',durationMs:19,note:'password'})+'\n');
    writeFileSync(o,JSON.stringify({caseId:'r1',transition:'run_completed',displayName:'customer secret'})+'\n');
    const result=summarizeLedgers(u,o);
    assert.equal(result.counts.usage,1);
    assert.equal(result.counts.observer,1);
    assert.equal(result.counts.unknownCost,1);
    assert.deepEqual(result.counts.byKind,{model_invocation:1,run_completed:1});
    const raw=JSON.stringify(result);
    assert.equal(raw.includes('SECRET_CUSTOMER'),false);
    assert.equal(raw.includes('password'),false);
    assert.equal(raw.includes('customer secret'),false);
  }finally{rmSync(dir,{recursive:true,force:true});}
});

test('tail reader bounds file size and skips partial edge records',()=>{
  const dir=mkdtempSync(join(tmpdir(),'orchestra-tail-'));
  try{
    const f=join(dir,'data.jsonl');
    writeFileSync(f,`${'x'.repeat(520*1024)}\n`);
    appendFileSync(f,JSON.stringify({engine:'s1'})+'\n');
    appendFileSync(f,'{"engine":"s2"');
    const result=readTail(f);
    assert.ok(result.scannedBytes<=MAX_SCAN_BYTES);
    assert.ok(result.lines.length<=MAX_ROWS);
    assert.deepEqual(result.lines,[JSON.stringify({engine:'s1'})]);
    assert.equal(result.truncated,true);
    assert.equal(result.totalBytes>result.scannedBytes,true);
  }finally{rmSync(dir,{recursive:true,force:true});}
});

test('missing source ledgers report missing, not zero activity',()=>{
  const v=summarizeLedgers('/unavailable/engine-usage.jsonl','/unavailable/observer-events.jsonl');
  assert.equal(v.files.usage.missing,true);
  assert.equal(v.files.observer.missing,true);
});
