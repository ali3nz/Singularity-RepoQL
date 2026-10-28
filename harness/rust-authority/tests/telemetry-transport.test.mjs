import {test} from 'node:test';
import assert from 'node:assert/strict';
import {createTelemetryTransport,cleanEvent} from '../adapter/telemetry-transport.mjs';

test('disabled unless explicit loopback collector and token', () => {
  for (const endpoint of [undefined,'https://example.org/api/events','http://localhost:7878/api/events',
    'http://127.0.0.1:7878/other', 'http://127.0.0.1:7878/api/events?x=1']) {
    const t = createTelemetryTransport({endpoint,token:'s',fetchImpl:async()=>({status:202})});
    assert.equal(t.status().enabled,false);
    assert.equal(t.emit({kind:'run_started'}),false);
  }
});

test('payload allowlist strips prompts, outputs, credentials and nested values', () => {
  const event = cleanEvent({kind:'run_started',runId:'abc',prompt:'secret',toolOutput:'secret',
    apiKey:'secret',opaque:{secrets:'x'},context:['x'],durationMs:14,success:true});
  assert.deepEqual(JSON.parse(event), {kind:'run_started',runId:'abc',durationMs:14,success:true});
  assert.equal(cleanEvent({prompt:'secret'}),null);
  assert.equal(cleanEvent({kind:'x',agent:'z'.repeat(129)}),JSON.stringify({kind:'x'}));
  assert.equal(cleanEvent({kind:'x',engine:'e',stage:'x\ny'}),JSON.stringify({kind:'x',engine:'e'}));
  assert.equal(cleanEvent({kind:'x',model:'x'.repeat(128),provider:'y'.repeat(128)}).length>0,true);
});

test('structured field types reject secrets smuggled through allowlisted labels', () => {
  assert.equal(cleanEvent({kind:'Private customer information'}),null);
  assert.equal(cleanEvent({engine:'token=private'}),null);
  const record=JSON.parse(cleanEvent({kind:'run_started',runId:'../../private',
    engine:'openai/worker',model:'customer apiKey=xyz',purpose:'Read private invoice',
    agent:'normal-worker',success:'yes',durationMs:-100,inputTokens:1.5,
    costUsd:-19,outputTokens:10,rc:-1,prompt:'raw content'}));
  assert.deepEqual(record,{kind:'run_started',engine:'openai/worker',
    agent:'normal-worker',outputTokens:10,rc:-1});
  assert.equal(cleanEvent({kind:'x',engine:'ok',runId:'é'.repeat(10)}),JSON.stringify({kind:'x',engine:'ok'}));
  assert.equal(cleanEvent({engine:'provider'}),JSON.stringify({engine:'provider',kind:'model_invocation'}));
});

test('successful delivery is nonblocking and auditable', async () => {
  let release;
  const pending = new Promise(resolve => {release=resolve;});
  const calls=[];
  const t=createTelemetryTransport({endpoint:'http://127.0.0.1:7878/api/events',token:'abc',
    fetchImpl:async(url,init)=>{calls.push({url,init});await pending;return {status:202}}});
  assert.equal(t.emit({kind:'run_completed',runId:'r1',prompt:'DO NOT TRANSMIT'}),true);
  assert.equal(t.status().inFlight,1);
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(calls.length,1);
  assert.equal(JSON.parse(calls[0].init.body).prompt,undefined);
  assert.equal(calls[0].init.headers.Authorization,'Bearer abc');
  release();await t.flush();
  assert.deepEqual({...t.status()}, {enabled:true,acceptedForDelivery:1,delivered:1,failed:0,dropped:0,inFlight:0});
});

test('rejections and HTTP failures never escape into caller and preserve counters', async () => {
  const t=createTelemetryTransport({endpoint:'http://127.0.0.1:7878/api/events',token:'abc',
    fetchImpl:async()=>{throw Error('collector unavailable')}});
  assert.equal(t.emit({kind:'run_failed'}),true);
  await t.flush();
  assert.equal(t.status().failed,1);
  const f=createTelemetryTransport({endpoint:'http://127.0.0.1:7878/api/events',token:'abc',
    fetchImpl:async()=>({status:403})});
  assert.equal(f.emit({kind:'run_failed'}),true);await f.flush();
  assert.equal(f.status().failed,1);
});

test('inflight limit drops instead of building unbounded queues', async () => {
  let release;
  const pending = new Promise(resolve=>{release=resolve;});
  const t=createTelemetryTransport({endpoint:'http://127.0.0.1:7878/api/events',token:'abc',maxInflight:2,
    fetchImpl:async()=>{await pending;return {status:202}}});
  assert.equal(t.emit({kind:'run_started'}),true);
  assert.equal(t.emit({kind:'run_started'}),true);
  assert.equal(t.emit({kind:'run_started'}),false);
  assert.equal(t.status().dropped,1);
  release();await t.flush();
  assert.equal(t.status().delivered,2);
});
