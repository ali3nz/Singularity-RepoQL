import {test} from 'node:test';
import assert from 'node:assert/strict';
import {createServer} from 'node:http';
import {createTelemetryTransport} from '../adapter/telemetry-transport.mjs';

// A real local HTTP test of the documented Rust /api/events ingest contract.
// This does not substitute for an actual Rust server test.
test('transport delivers an allowlisted event over loopback HTTP', async () => {
  const captured=[];
  const server=createServer((req,res)=>{
    const chunks=[];
    req.on('data',c=>chunks.push(c));
    req.on('end',()=>{
      captured.push({url:req.url,method:req.method,authorization:req.headers.authorization,
        contentType:req.headers['content-type'], body:JSON.parse(Buffer.concat(chunks).toString('utf8'))});
      res.writeHead(202, {'Content-Type':'application/json'});
      res.end('{"accepted":true}');
    });
  });
  await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
  try {
    const port=server.address().port;
    const transport=createTelemetryTransport({endpoint:`http://127.0.0.1:${port}/api/events`,token:'test-token'});
    assert.equal(transport.emit({kind:'run_completed',runId:'run1',durationMs:7,
      prompt:'must not be transmitted',toolOutput:'private'}),true);
    assert.equal(await transport.flush(),true);
    assert.equal(transport.status().delivered,1);
    assert.equal(captured.length,1);
    assert.equal(captured[0].authorization,'Bearer test-token');
    assert.equal(captured[0].method,'POST');
    assert.equal(captured[0].url,'/api/events');
    assert.equal(captured[0].contentType,'application/json');
    assert.deepEqual(captured[0].body,{kind:'run_completed',runId:'run1',durationMs:7});
  } finally {await new Promise(resolve=>server.close(resolve));}
});
