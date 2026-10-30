import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const hook=fileURLToPath(new URL('./office-hook.mjs',import.meta.url));
const events={
  'session-start':'session_start',prompt:'user_prompt_submit',
  'pre-tool':'pre_tool_use','post-tool':'post_tool_use',
  stop:'stop','subagent-stop':'subagent_stop','session-end':'session_end',
};
function run(kind,endpoint,payload){
  return new Promise((resolve,reject)=>{
    const child=spawn(process.execPath,[hook,kind],{env:{...process.env,OFFICE_ENDPOINT:endpoint,OFFICE_INGEST_KEY:'test-ingest-key',OFFICE_CONFIG:''},stdio:['pipe','pipe','pipe']});
    let out='',err='';
    child.stdout.on('data',x=>out+=x);
    child.stderr.on('data',x=>err+=x);
    child.on('error',reject);
    child.on('close',code=>resolve({code,out,err}));
    child.stdin.end(JSON.stringify(payload));
  });
}
async function server(handler){
  const http=createServer(handler);
  await new Promise(resolve=>http.listen(0,'127.0.0.1',resolve));
  return {endpoint:`http://127.0.0.1:${http.address().port}`,close:()=>new Promise(resolve=>http.close(resolve))};
}

test('all seven Office hooks forward only allowlisted metadata and never transcript content',async()=>{
  const received=[];
  const web=await server((req,res)=>{
    let body='';req.on('data',x=>body+=x);req.on('end',()=>{
      received.push({key:req.headers['x-api-key'],body:JSON.parse(body)});
      res.writeHead(204);res.end();
    });
  });
  try {
    for(const [kind,type] of Object.entries(events)){
      const payload={session_id:'session-A',cwd:'C:\\Workspace\\Repo',tool_name:'Read',tool_use_id:'tool-1',
        prompt:'PRIVATE-PROMPT',tool_input:{password:'PRIVATE-INPUT'},tool_response:{output:'PRIVATE-OUTPUT'}};
      const status=await run(kind,web.endpoint,payload);
      assert.equal(status.code,0);assert.equal(status.out,'');assert.equal(status.err,'');
      assert.equal(received.at(-1).body.event_type,type);
      assert.equal(received.at(-1).key,'test-ingest-key');
      assert.equal(received.at(-1).body.session_id,'cc-session-A');
      assert.doesNotMatch(JSON.stringify(received.at(-1)),/PRIVATE-PROMPT|PRIVATE-INPUT|PRIVATE-OUTPUT/);
    }
    assert.equal(received.length,7);
  }finally {await web.close()}
});

test('Office hook refuses credential-bearing HTTP redirects',async()=>{
  const downstream=[];
  const destination=await server((req,res)=>{downstream.push(req.headers);res.end('unexpected');});
  const redirector=await server((_req,res)=>{res.writeHead(307,{Location:destination.endpoint+'/redirect'});res.end();});
  try {
    const result=await run('stop',redirector.endpoint,{session_id:'one'});
    assert.equal(result.code,0);
    assert.equal(downstream.length,0);
  }finally{await redirector.close();await destination.close()}
});
