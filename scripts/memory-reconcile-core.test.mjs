import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, chmodSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { reconcileMemoryUnit } from './memory-reconcile-core.mjs';

function storage() {
  const stored = [];
  const requests = [];
  const request = async (path, body) => {
    requests.push({path, body});
    if (path === '/conversation/query') {
      return { messages: stored.map(row => ({...row})), total: stored.length };
    }
    if (path === '/conversation/add') {
      stored.push(...body.messages.map(row => ({...row, task_id:body.task_id})));
      return {ok:true};
    }
    throw new Error('unexpected path');
  };
  return {stored, requests, request};
}
const unit = {
  task_id:'task-123', session_id:'session-a', messages:[
    {role:'user',content:'hello',timestamp:'t1'},
    {role:'user',content:'hello',timestamp:'t1'},
    {role:'assistant',content:'reply',recorded_at:'t2'}
  ]
};

const mock = `#!/usr/bin/env node
let input = '';process.stdin.setEncoding('utf8');process.stdin.on('data',d=>input+=d);
process.stdin.on('end',()=>{
const req=JSON.parse(input), counts=new Map();
const key = v=>JSON.stringify([v.role,v.content,v.recorded_at??v.timestamp]);
for(const row of req.rows)counts.set(key(row),(counts.get(key(row))??0)+1);
const missing=[];
req.messages.forEach((m,i)=>{const k=key(m),c=counts.get(k)??0;if(c)counts.set(k,c-1);else missing.push(i)});
if(process.env.BAD_RUST_RECONCILE==='omit')missing.length=0;
if(process.env.BAD_RUST_RECONCILE==='duplicate')missing.splice(0,missing.length,0,0);
if(process.env.BAD_RUST_RECONCILE==='invalid')return console.log(JSON.stringify({ok:true,missingIndexes:['bad'],totalMessages:req.messages.length}));
console.log(JSON.stringify({ok:true,missingIndexes:missing,totalMessages:req.messages.length}));
});`;

test('memory reconciliation preserves duplicate counts, task scope and readback', async () => {
  const old = process.env.SINGULARITY_RUST_MEMORY_POLICY_BIN;
  delete process.env.SINGULARITY_RUST_MEMORY_POLICY_BIN;
  try {
    const s=storage();
    s.stored.push({...unit.messages[0],task_id:'task-123'}, {...unit.messages[0],task_id:'other-task'});
    const result=await reconcileMemoryUnit(s.request,{},unit);
    assert.deepEqual(result,{verified:true,written:2});
    assert.equal(s.stored.length,4);
    assert.equal(s.requests.filter(r=>r.path==='/conversation/add').length,1);
    const again=await reconcileMemoryUnit(s.request,{},unit);
    assert.deepEqual(again,{verified:true,written:0});
  } finally {if(old===undefined)delete process.env.SINGULARITY_RUST_MEMORY_POLICY_BIN;else process.env.SINGULARITY_RUST_MEMORY_POLICY_BIN=old}
});

test('native reconciliation output is checked before writes and cannot bypass readback', {skip:process.platform==='win32'}, async () => {
  const old = process.env.SINGULARITY_RUST_MEMORY_POLICY_BIN;
  const d=mkdtempSync(join(tmpdir(),'singularity-reconcile-native-'));
  const bin=join(d,'fake-native');writeFileSync(bin,mock);chmodSync(bin,0o700);
  try {
    process.env.SINGULARITY_RUST_MEMORY_POLICY_BIN=bin;
    const s=storage();
    assert.deepEqual(await reconcileMemoryUnit(s.request,{},unit),{verified:true,written:3});
    assert.deepEqual(await reconcileMemoryUnit(s.request,{},unit),{verified:true,written:0});
    for(const bad of ['omit','duplicate','invalid']) {
      process.env.BAD_RUST_RECONCILE=bad;
      const other=storage();
      await assert.rejects(()=>reconcileMemoryUnit(other.request,{},unit),e =>
        e.code==='NATIVE_RECONCILIATION_MISMATCH'||e.code==='INVALID_NATIVE_RECONCILIATION_RESPONSE');
      assert.equal(other.requests.filter(r=>r.path==='/conversation/add').length,0);
    }
  } finally {
    delete process.env.BAD_RUST_RECONCILE;
    if(old===undefined)delete process.env.SINGULARITY_RUST_MEMORY_POLICY_BIN;
    else process.env.SINGULARITY_RUST_MEMORY_POLICY_BIN=old;
    rmSync(d,{recursive:true,force:true});
  }
});


test('reconciliation continues past a full page of unrelated task rows', async () => {
  const old=process.env.SINGULARITY_RUST_MEMORY_POLICY_BIN;
  delete process.env.SINGULARITY_RUST_MEMORY_POLICY_BIN;
  try {
    const requests=[];
    const existing={...unit.messages[0],task_id:unit.task_id};
    const other=Array.from({length:100},()=>({role:'user',content:'noise',task_id:'other-task'}));
    const request=async (path,body) => {
      requests.push({path,body});
      if(path==='/conversation/add') throw new Error('existing row must not be duplicated');
      return body.offset===0? {messages:other,total:101} : {messages:[existing],total:101};
    };
    const onlyOne={...unit,messages:[unit.messages[0]]};
    assert.deepEqual(await reconcileMemoryUnit(request,{},onlyOne),{verified:true,written:0});
    assert.equal(requests.filter(x=>x.body.offset===100).length,2);
  } finally {if(old===undefined)delete process.env.SINGULARITY_RUST_MEMORY_POLICY_BIN;else process.env.SINGULARITY_RUST_MEMORY_POLICY_BIN=old}
});
