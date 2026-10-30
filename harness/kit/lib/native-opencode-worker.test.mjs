import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { once } from 'node:events';
import { nativeOpenCodeClient,dispatchDecision,validateLoopbackServer,NativeWorkerError } from './native-opencode-worker.mjs';

const model={providerID:'deepseek',modelID:'v4-flash'};
const ready=dispatchDecision({claudeCodeFreeWorkers:0,opencodeCapacity:1,activeOpenCode:0,approvedModel:model,billingClass:'free'});
async function fixture(handler,run) {
  const server=http.createServer(handler); server.listen(0,'127.0.0.1'); await once(server,'listening');
  try { return await run(`http://127.0.0.1:${server.address().port}`); } finally { await new Promise(r=>server.close(r)); }
}
test('zero Claude workers still selects configured OpenCode capacity',()=>{
  assert.equal(ready.status,'READY');
  assert.equal(dispatchDecision({opencodeCapacity:0,approvedModel:model,billingClass:'free'}).status,'DEFERRED');
  assert.equal(dispatchDecision({opencodeCapacity:2,activeOpenCode:2,approvedModel:model,billingClass:'free'}).status,'DEFERRED');
  assert.equal(dispatchDecision({opencodeCapacity:-1,approvedModel:model,billingClass:'free'}).code,'CAPACITY_UNVERIFIED');
  assert.equal(dispatchDecision({opencodeCapacity:1,approvedModel:model,billingClass:'unknown'}).code,'BILLING_NOT_AUTHORIZED');
  assert.equal(dispatchDecision({opencodeCapacity:1,approvedModel:model,billingClass:'subscription'}).code,'BILLING_NOT_AUTHORIZED');
  assert.equal(dispatchDecision({opencodeCapacity:1,approvedModel:model,billingClass:'subscription',allowPaid:true}).status,'READY');
});
test('only explicit local HTTP origins are accepted',()=>{
  for (const url of ['http://localhost:4096','http://example.com:4096','http://127.0.0.1:4096/path','http://a:b@127.0.0.1:4096','https://127.0.0.1:4096','http://127.0.0.1:4096/?token=t','http://127.0.0.1','http://[::1]:4096/#x']) {
    assert.throws(()=>validateLoopbackServer(url),NativeWorkerError);
  }
  assert.equal(validateLoopbackServer('http://127.0.0.1:4096'),'http://127.0.0.1:4096');
});
test('asynchronous OpenCode submit uses authenticated local GUI server; accepted is not completed',async()=>{
  let prompts=0;
  await fixture(async(req,res)=>{
    assert.match(req.headers.authorization??'',/^Basic /);
    res.setHeader('content-type','application/json');
    if(req.url==='/global/health'){ res.end(JSON.stringify({healthy:true,version:'1.2'}));return;}
    if(req.url==='/session' && req.method==='POST'){res.end(JSON.stringify({id:'ses_test_100'}));return;}
    if(req.url==='/session/ses_test_100/prompt_async'){
      prompts++;
      let input='';for await (const part of req) input+=part;
      const body=JSON.parse(input);
      assert.deepEqual(body.model,model);
      assert.equal(body.parts[0].text,'Implement change');
      res.writeHead(204); res.end();return;
    }
    if(req.url==='/session/status'){res.end(JSON.stringify({ses_test_100:{type:'busy'}}));return;}
    res.writeHead(404); res.end('{}');
  },async base=>{
    const client=nativeOpenCodeClient({server:base,password:'testing-secret'});
    assert.deepEqual(await client.health(),{healthy:true,version:'1.2'});
    const response=await client.submit({taskId:'task_1',prompt:'Implement change',decision:ready});
    assert.deepEqual(response,{status:'ACCEPTED',taskId:'task_1',sessionId:'ses_test_100',completed:false});
    const status=await client.status('ses_test_100');
    assert.equal(status.state.type,'busy');
  });
  assert.equal(prompts,1);
});
test('auth rejection and redirect fail closed without token disclosure',async()=>{
  for(const code of [302,401,429]) await fixture((req,res)=>{res.writeHead(code,{location:'http://example.com/steal'});res.end('secret');},async base=>{
    const c=nativeOpenCodeClient({server:base,password:'testing-secret'});
    await assert.rejects(c.health(),e=>e.code===({302:'REDIRECT',401:'AUTH',429:'NO_CAPACITY'}[code]) && !String(e).includes('testing-secret'));
  });
});
test('uncertain delivery preserves session id and forbids blind retry',async()=>{
  await fixture((req,res)=>{
    if(req.url==='/session'){res.setHeader('content-type','application/json');res.end('{"id":"ses_for_reconcile"}');return;}
    res.writeHead(503);res.end('');
  },async base=>{
    const c=nativeOpenCodeClient({server:base,password:'testing-secret'});
    assert.deepEqual(await c.submit({taskId:'task_1',prompt:'Implement change',decision:ready}),{
      status:'DELIVERY_UNCERTAIN',taskId:'task_1',sessionId:'ses_for_reconcile',errorCode:'NO_CAPACITY',retryWithoutReconcile:false,
    });
  });
});
test('no verified capacity never creates a session',async()=>{
  const client=nativeOpenCodeClient({server:'http://127.0.0.1:49999',password:'test'});
  await assert.rejects(client.submit({taskId:'1',prompt:'bad',decision:dispatchDecision({opencodeCapacity:0,approvedModel:model,billingClass:'free'})}),e=>e.code==='CAPACITY');
});
test('worker must observe assistant output before treating a session as responded',async()=>{
  let checks=0;
  await fixture((req,res)=>{
    res.setHeader('content-type','application/json');
    if(req.url==='/session/status') { checks++;res.end(JSON.stringify({ses_test_100:{type:checks<3?'busy':'idle'}}));return; }
    if(req.url==='/session/ses_test_100/message?limit=20') {res.end(JSON.stringify([{info:{role:'assistant'},parts:[{type:'text',text:'Completed output'}]}]));return;}
    res.writeHead(404);res.end('{}');
  },async base=>{
    const c=nativeOpenCodeClient({server:base,password:'test'});
    const r=await c.observeCompletion('ses_test_100',{timeoutMs:1000,pollMs:1,sleep:async()=>{}});
    assert.equal(r.status,'RESPONSE_OBSERVED');
    assert.equal(r.output,'Completed output');
    assert.equal(r.completionVerified,false); // not an acceptance test of changed files
  });
});
test('unknown worker status is not a completion signal',async()=>fixture((req,res)=>{
  res.end('{}');
},async base=>{
  const c=nativeOpenCodeClient({server:base,password:'test'});
  const r=await c.observeCompletion('ses_unknown',{timeoutMs:200,pollMs:1});
  assert.equal(r.status,'UNVERIFIED_COMPLETION');
}));
