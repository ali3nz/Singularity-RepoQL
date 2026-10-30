import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import {once} from 'node:events';
import {callManagedSeat} from './openchamber-managed-seat.mjs';

const model='deepseek/v4-flash';
const env='SINGULARITY_TEST_OPENCODE_PASSWORD';
async function fixture(handler,fn){
  const server=http.createServer(handler); server.listen(0,'127.0.0.1');await once(server,'listening');
  const base=`http://127.0.0.1:${server.address().port}`;
  try{return await fn(base);}finally{await new Promise(r=>server.close(r));}
}
const config=(base,extra={})=>({server:base,providerID:'deepseek',modelID:'v4-flash',
  capacity:1,active:0,billingClass:'free',allowPaid:false,passwordEnv:env,
  expectedDirectory:'C:\\repoql',writeApproved:true,...extra});

test('Windows refuses legacy Docker/SSH when no native backend is configured',async()=>{
  const r=await callManagedSeat(model,'A task',{platform:'win32',nativeConfig:null,
    execInject:()=>{throw new Error('must not execute Docker');}});
  assert.equal(r.ok,false);assert.match(r.output,/CONFIG/);
});
test('Windows managed seat sends to local GUI HTTP server, not docker, with explicit free capacity',async()=>{
  process.env[env]='test-secret';
  let count=0;
  try { await fixture(async(req,res)=>{
    assert.match(req.headers.authorization??'',/^Basic /);
    res.setHeader('content-type','application/json');
    if(req.url==='/global/health'){res.end(JSON.stringify({healthy:true,version:'1.2'}));return;}
    if(req.url==='/path'){res.end(JSON.stringify({directory:'C:/repoql'}));return;}
    if(req.url==='/session'){res.end(JSON.stringify({id:'ses_native_test'}));return;}
    if(req.url==='/session/ses_native_test/prompt_async'){count++;res.writeHead(204);res.end();return;}
    if(req.url==='/session/status'){res.end(JSON.stringify({ses_native_test:{type:'idle'}}));return;}
    if(req.url==='/session/ses_native_test/message?limit=20'){
      res.end(JSON.stringify([{info:{role:'assistant'},parts:[{type:'text',text:'Read-only tests completed; write requested.'}]}]));return;
    }
    res.writeHead(404);res.end('{}');
  },async base=>{
    const r=await callManagedSeat(model,'Check and edit',{platform:'win32',nativeConfig:config(base),timeoutSec:3});
    assert.equal(r.ok,true);assert.equal(r.transport,'native-opencode-http');
    assert.equal(r.sessionId,'ses_native_test');assert.equal(r.completionVerified,false);
  }); }
  finally{delete process.env[env];}
  assert.equal(count,1);
});
test('missing approval, capacity or workspace prevents Windows implementation dispatch',async()=>{
  const r=await callManagedSeat(model,'A task',{platform:'win32',nativeConfig:config('http://127.0.0.1:4096',{writeApproved:false})});
  assert.equal(r.ok,false);assert.match(r.output,/CONFIG/);
  const capped=await callManagedSeat(model,'A task',{platform:'win32',nativeConfig:config('http://127.0.0.1:4096',{capacity:0})});
  assert.equal(capped.ok,false);assert.match(capped.output,/NO_OPEN_CODE_CAPACITY/);
  process.env[env]='test-secret';
  try{await fixture((req,res)=>{
    res.setHeader('content-type','application/json');
    if(req.url==='/global/health'){res.end('{"healthy":true}');return;}
    if(req.url==='/path'){res.end('{"directory":"D:/other"}');return;}
    assert.fail('must not submit into another workspace');
  },async base=>{
    const bad=await callManagedSeat(model,'A task',{platform:'win32',nativeConfig:config(base)});
    assert.equal(bad.ok,false);assert.match(bad.output,/WORKSPACE_MISMATCH/);
  });}finally{delete process.env[env];}
});
test('Windows allows explicitly approved free billing class for native OpenChamber seat',async()=>{
  const {validateManagedSeat}=await import('./openchamber-managed-seat.mjs');
  const seat={transport:'openchamber-managed',model,billingClass:'free'};
  assert.equal(validateManagedSeat(seat,{platform:'win32',nativeConfig:{billingClass:'free'}}).ok,true);
  assert.equal(validateManagedSeat(seat,{platform:'linux'}).ok,false);
});
