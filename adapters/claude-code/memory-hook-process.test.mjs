// Executable (not import-only) acceptance of the real shipped hook against a
// credential-aware loopback HTTP test server. Does not certify actual Tencent.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { spawn } from 'node:child_process';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
const hook=fileURLToPath(new URL('./memory-hook.mjs',import.meta.url));
const DUMMY='local-test-service-key-not-real';
const enough='Reconcile any learned insight only after verifying that the stored task identity belongs to the current agent and the retained content matches the actual outcome. '.repeat(3);
const run=(args,payload,env)=>new Promise((resolve,reject)=>{
  const child=spawn(process.execPath,[hook,...args],{env:{...process.env,...env},stdio:['pipe','pipe','pipe'],windowsHide:true});
  let stdout='',stderr='';
  child.stdout.setEncoding('utf8').on('data',chunk=>stdout+=chunk);
  child.stderr.setEncoding('utf8').on('data',chunk=>stderr+=chunk);
  child.once('error',reject);child.once('close',(code)=>resolve({code,stdout,stderr}));
  child.stdin.end(JSON.stringify(payload));
});
const listen=server=>new Promise(resolve=>server.listen(0,'127.0.0.1',()=>resolve(server.address().port)));
const close=server=>new Promise(resolve=>server.close(resolve));

test('real Node hooks: authenticated capture, retry-safe persistence, scoped recall, and no cross-agent capture',async()=>{
  const stored=[];const calls=[];
  const server=createServer(async(req,res)=>{
    let raw='';for await(const part of req)raw+=part;
    const body=JSON.parse(raw||'{}');
    calls.push({path:req.url,body,auth:req.headers.authorization,redirect:req.headers['x-tdai-user-key']});
    const ok={code:0,data:{messages:[],total:0}};
    if(req.url==='/v3/conversation/add'){
      for(const m of body.messages)stored.push({...m,task_id:body.task_id,session_id:body.session_id,agent_id:body.agent_id});
      ok.data={accepted_ids:['r1']};
    } else if(req.url==='/v3/conversation/query'){
      const rows=stored.filter(x=>x.task_id===body.task_id && x.agent_id===body.agent_id);
      ok.data={messages:rows,total:rows.length};
    } else if(req.url==='/v3/conversation/search') {
      ok.data={messages:stored.filter(x=>x.agent_id===body.agent_id)};
    } else if(req.url==='/v3/atomic/search') {
      ok.data={items:[]};
    } else {res.writeHead(404);res.end('{}');return;}
    res.setHeader('content-type','application/json');res.end(JSON.stringify(ok));
  });
  const port=await listen(server);
  const dir=mkdtempSync(join(tmpdir(),'singularity-m30-exec-'));
  try {
    const config=join(dir,'memory.json');
    writeFileSync(config,JSON.stringify({baseUrl:`http://127.0.0.1:${port}`,userKey:DUMMY}));
    const env={SINGULARITY_MEMORY_CONFIG:config,SINGULARITY_REPO_ROOT:dir};
    const payload={agent_type:'singularity-code-reviewer',session_id:'process-retry',last_assistant_message:enough};
    const first=await run(['subagent-stop'],payload,env);
    await new Promise(r=>setTimeout(r,30));
    const second=await run(['subagent-stop'],payload,env);
    assert.equal(first.code,0);assert.equal(second.code,0);
    assert.match(first.stderr,/reconciled 1/);assert.match(second.stderr,/reconciled 0/);
    assert.equal(stored.length,1,'two independent Node processes must not duplicate memory');
    assert.equal(stored[0].agent_id,'code-reviewer');
    const recall=await run(['subagent-start'],{agent_type:'singularity-code-reviewer',session_id:'fresh-session',prompt:'previous agent lesson'},env);
    assert.equal(recall.code,0);
    assert.match(JSON.parse(recall.stdout).hookSpecificOutput.additionalContext,/Reconcile any learned insight/);
    const foreign=await run(['subagent-stop'],{...payload,agent_type:'unrelated'},env);
    assert.equal(foreign.code,0);assert.equal(stored.length,1);
    assert.ok(calls.every(c=>c.auth===`Bearer ${DUMMY}`));
    assert.equal(recall.stdout.includes(DUMMY),false);
  }finally{await close(server);rmSync(dir,{recursive:true,force:true});}
});

test('MemoryCore client refuses redirects and never sends its user key to redirect origin',async()=>{
  let downstream=0;
  const downstreamServer=createServer((_req,res)=>{downstream++;res.end('credential leak');});
  const downstreamPort=await listen(downstreamServer);
  const redirector=createServer((_req,res)=>{res.writeHead(307,{Location:`http://127.0.0.1:${downstreamPort}/steal`});res.end();});
  const port=await listen(redirector);
  const dir=mkdtempSync(join(tmpdir(),'singularity-m30-redirect-'));
  try {
    const config=join(dir,'memory.json');writeFileSync(config,JSON.stringify({baseUrl:`http://127.0.0.1:${port}`,userKey:DUMMY}));
    const res=await run(['subagent-start'],{agent_type:'singularity-code-reviewer',prompt:'test'},
      {SINGULARITY_MEMORY_CONFIG:config,SINGULARITY_REPO_ROOT:dir});
    assert.equal(res.code,0);assert.equal(res.stdout,'');
    assert.match(res.stderr,/recall degraded/);
    assert.equal(downstream,0);
  }finally{await close(redirector);await close(downstreamServer);rmSync(dir,{recursive:true,force:true});}
});
