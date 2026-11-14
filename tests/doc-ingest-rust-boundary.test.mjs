// Guarded Rust policy integration for the native Windows Node documentation writer.
// The fake executable is POSIX-only; compiled Windows acceptance is separately
// required by verify_rust_upgrade.ps1 and differential_doc_ingest.py.
import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,mkdirSync,writeFileSync,readFileSync,chmodSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {chunkMarkdown,ingestFile,searchDocs,locateEntryKey,retryDocuments,rootIdOf,statusReport,Blocked} from '../scripts/doc-ingest-node.mjs';

function sandbox() {
  const dir=mkdtempSync(join(tmpdir(),'doc-rust-wave19-'));
  const docs=join(dir,'docs');mkdirSync(docs);
  const memory=join(dir,'memory.json');
  writeFileSync(memory,JSON.stringify({gatewayKey:'test-only',authPrefix:'Bearer ',serviceId:'svc',userKey:'usr'}));
  return {dir,docs,memory,clean(){rmSync(dir,{recursive:true,force:true});}};
}
function fakeBinary(box,responses) {
  const p=join(box.dir,'native-doc-mock.mjs');
  writeFileSync(p,'#!/usr/bin/env node\nconst responses='+JSON.stringify(responses)+';\nprocess.stdout.write(JSON.stringify(responses[process.argv[2]]??{ok:false,code:"NO_CASE"}));\n');
  chmodSync(p,0o700);
  return p;
}

const POSIX=process.platform!=='win32';

test('Unicode chunks never exceed 7000 characters or lose physical-line content',()=>{
  const source='🧠'.repeat(19000);
  const chunks=chunkMarkdown(source,{SINGULARITY_DOC_RUST_BIN:''});
  assert.equal(chunks.length,3);
  assert.ok(chunks.every(s=>Array.from(s).length<=7000));
  assert.equal(chunks.join(''),source);
});

test('a forged native chunk blocks the doc before any MemoryCore write',{skip:!POSIX},async()=>{
  const box=sandbox();
  try {
    const p=join(box.docs,'safe.md');writeFileSync(p,'# Safe\nVerified procedure.\n');
    const bin=fakeBinary(box,{'doc-index-chunks':{ok:true,chunks:['TAMPERED']}});
    let requests=0;
    const env={...process.env,SINGULARITY_DOC_RUST_BIN:bin,SINGULARITY_DOC_DATA:join(box.dir,'state'),
      MEMORY_SECRETS:box.memory,DOC_INDEX_TEAM:'tests',DOC_INDEX_USER:'shared'};
    const output=await ingestFile(p,{root:box.docs,env,
      fetchImpl:async()=>{requests++;throw new Error('MUST NOT CONTACT MEMORYCORE');}});
    assert.equal(output.status,'DOC_INGEST_BLOCKED');
    assert.match(output.reason,/native documentation policy/);
    assert.equal(requests,0);
  }finally{box.clean();}
});

test('a forged native write plan blocks the doc before any MemoryCore write',{skip:!POSIX},async()=>{
  const box=sandbox();
  try {
    const content='# Safe\nVerified procedure.\n';
    const p=join(box.docs,'safe.md');writeFileSync(p,content);
    const bin=fakeBinary(box,{
      'doc-index-chunks':{ok:true,chunks:['# Safe\nVerified procedure.']},
      'doc-index-plan':{ok:true,tasks:[{task_id:'FORGED',marker:'FORGED',text:'FORGED',hash:'BAD'}]},
    });
    let requests=0;
    const env={...process.env,SINGULARITY_DOC_RUST_BIN:bin,SINGULARITY_DOC_DATA:join(box.dir,'state'),
      MEMORY_SECRETS:box.memory,DOC_INDEX_TEAM:'tests',DOC_INDEX_USER:'shared'};
    const output=await ingestFile(p,{root:box.docs,env,
      fetchImpl:async()=>{requests++;throw new Error('MUST NOT CONTACT MEMORYCORE');}});
    assert.equal(output.status,'DOC_INGEST_BLOCKED');
    assert.match(output.reason,/native documentation policy/);
    assert.equal(requests,0);
  }finally{box.clean();}
});

test('forged native stale retrieval cannot bypass absent current ledger',{skip:!POSIX},async()=>{
  const box=sandbox();
  try {
    const bin=fakeBinary(box,{'doc-index-select':{ok:true,indices:[0]}});
    const env={...process.env,SINGULARITY_DOC_RUST_BIN:bin,SINGULARITY_DOC_DATA:join(box.dir,'state'),
      MEMORY_SECRETS:box.memory,SINGULARITY_DOC_ROOTS:'',DOC_INDEX_TEAM:'tests',DOC_INDEX_USER:'shared'};
    const fetchImpl=async()=>({ok:true,text:async()=>JSON.stringify({code:0,data:{messages:[
      {content:'[doc-ref:unindexed.md#12345678 chunk 1/1 hash 00000000]\nroot-id: 00000001\nOld content'},
    ]}})});
    await assert.rejects(searchDocs('old',{env,fetchImpl,limit:5,stale:false}),Blocked);
    const historical=await searchDocs('old',{env,fetchImpl,limit:5,stale:true});
    assert.equal(historical.length,1);
    assert.equal(historical[0].source,'unindexed.md');
  }finally{box.clean();}
});


test('native doc retrieval uses synthetic identity and excludes secret environment',{skip:!POSIX},async()=>{
  const box=sandbox();
  try {
    const bin=join(box.dir,'native-doc-capture.mjs');
    const captured=join(box.dir,'captured.json');
    writeFileSync(bin, `#!/usr/bin/env node\nimport {writeFileSync} from 'node:fs';\nlet value='';\nfor await (const part of process.stdin) value+=part;\nwriteFileSync(${JSON.stringify(captured)},JSON.stringify({request:JSON.parse(value),env:process.env}));\nprocess.stdout.write(JSON.stringify({ok:true,indices:[0,2]}));\n`);
    chmodSync(bin,0o700);
    const env={...process.env,SINGULARITY_DOC_RUST_BIN:bin,SINGULARITY_DOC_DATA:join(box.dir,'state'),
      MEMORY_SECRETS:box.memory,TOP_SECRET_TOKEN:'never-in-child',
      SINGULARITY_DOC_ROOTS:'',DOC_INDEX_TEAM:'tests',DOC_INDEX_USER:'shared'};
    const refs=['private/runbook.md#abcdef12','private/runbook.md#abcdef12','private/other.md#dcba4321'];
    const fetchImpl=async()=>({ok:true,text:async()=>JSON.stringify({code:0,data:{messages:
      refs.map((ref)=>({content:`[doc-ref:${ref} chunk 1/1 hash 00000000]\nroot-id: 1234abcd\ntext`}))
    }})});
    const output=await searchDocs('docs',{env,fetchImpl,limit:5,stale:true});
    assert.deepEqual(output.map((row)=>row.source),['private/runbook.md','private/other.md']);
    const data=JSON.parse(readFileSync(captured,'utf8'));
    assert.deepEqual(data.request.candidates.map((row)=>row.rootId),['0','0','1']);
    assert.ok(data.request.candidates.every((row)=>row.rel===''&&row.rev===''));
    const wire=JSON.stringify(data.request);
    for(const phrase of ['private/runbook.md','private/other.md','1234abcd','abcdef12','dcba4321'])
      assert.equal(wire.includes(phrase),false);
    assert.equal(data.env.MEMORY_SECRETS,undefined);
    assert.equal(data.env.TOP_SECRET_TOKEN,undefined);
  }finally{box.clean();}
});

test('ledger locator preserves root pin, ambiguity and fallback matches',()=>{
  const box=sandbox();
  try {
    const root=rootIdOf(box.docs);
    const rel='private/runbook.md';
    const key=`${root}::${rel}`;
    const ledger={docs:{
      [`foreign::${rel}`]:{rel,root:box.dir},
      [key]:{rel,root:box.docs},
      [`${root}::fallback.md`]:{root:box.docs},
    }};
    assert.equal(locateEntryKey(ledger,rel,null,{}),null);
    assert.equal(locateEntryKey(ledger,rel,box.docs,{}),key);
    assert.equal(locateEntryKey(ledger,join(box.docs,'fallback.md'),null,{}),`${root}::fallback.md`);
  }finally{box.clean();}
});

test('status and retry use scoped locator facts and reject forged results',{skip:!POSIX},async()=>{
  const box=sandbox();
  try {
    const root=rootIdOf(box.docs);
    const rel='private/runbook.md';
    const state=join(box.dir,'state');
    const index=join(state,'doc-index');
    mkdirSync(index,{recursive:true});
    const file=join(index,'ledger.json');
    const ledger=JSON.stringify({version:1,docs:{
      [`foreign::${rel}`]:{rel,root:box.dir,root_id:'foreign'},
      [`${root}::${rel}`]:{rel,root:box.docs,root_id:root},
    }});
    writeFileSync(file,ledger);
    const bin=join(box.dir,'locator.mjs');
    writeFileSync(bin,`#!/usr/bin/env node\nlet input='';\nfor await(const p of process.stdin)input+=p;\nif(process.argv[2]!=='doc-index-locate'||process.env.MEMORY_SECRETS||JSON.stringify(JSON.parse(input))!=='{"candidates":[[true,false],[true,true]],"rootPinned":true}')process.exit(2);\nconsole.log('{"ok":true,"index":1}');\n`);
    chmodSync(bin,0o700);
    const env={...process.env,SINGULARITY_DOC_RUST_BIN:bin,SINGULARITY_DOC_DATA:state,MEMORY_SECRETS:box.memory};
    assert.equal(statusReport({env,root:box.docs,filePath:rel})[0].root,root);
    const forged=fakeBinary(box,{'doc-index-locate':{ok:true,index:0}});
    await assert.rejects(retryDocuments({env:{...env,SINGULARITY_DOC_RUST_BIN:forged},
      root:box.docs,filePath:rel,fetchImpl:async()=>{throw new Error('MUST NOT CONTACT MEMORYCORE');}}),Blocked);
    assert.equal(readFileSync(file,'utf8'),ledger);
  }finally{box.clean();}
});
