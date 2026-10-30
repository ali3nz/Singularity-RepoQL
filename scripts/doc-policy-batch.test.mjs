import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync, mkdirSync, rmSync, writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {
  acknowledgeResolvedDocs, autoIngestChangedDocs, MAX_DOC_INGEST_PER_PASS, observeWorkspace,
  parseDocRootEntries, saveSessionBaseline,
} from './doc-policy.mjs';

test('Windows configured documentation roots preserve drive letters',()=>{
  assert.deepEqual(parseDocRootEntries('C:\\docs;D:\\knowledge','win32'),['C:\\docs','D:\\knowledge']);
  assert.deepEqual(parseDocRootEntries('/var/docs:/opt/knowledge','linux'),['/var/docs','/opt/knowledge']);
});

test('bounded ingestion acknowledges only resolved files and retains the tail and failed entries',async()=>{
  const root=mkdtempSync(join(tmpdir(),'doc-policy-batch-'));
  const env={SINGULARITY_DOC_ROOTS:join(root,'docs')};
  try {
    mkdirSync(join(root,'docs'));
    await saveSessionBaseline('batch',root,{env});
    for(let i=0;i<MAX_DOC_INGEST_PER_PASS+2;i++) {
      writeFileSync(join(root,'docs',`doc-${String(i).padStart(2,'0')}.md`),`# Test document ${i}\n`);
    }
    const first=await observeWorkspace(root,'batch',{env});
    assert.equal(first.changedDocs.length,MAX_DOC_INGEST_PER_PASS+2);
    const processed=first.changedDocs.slice(0,MAX_DOC_INGEST_PER_PASS).map((doc,i)=>({
      doc,result:{status:i===0?'DOC_INGEST_FAILED':'DOC_INGEST_INDEXED'},
    }));
    assert.equal(acknowledgeResolvedDocs('batch',root,first,processed),MAX_DOC_INGEST_PER_PASS-1);
    const second=await observeWorkspace(root,'batch',{env});
    assert.equal(second.changedDocs.length,3,'one failed plus two unprocessed remain discoverable');
    assert.ok(second.changedDocs.some(d=>d.path===processed[0].doc.path));
    const remaining=second.changedDocs.map(doc=>({doc,result:{status:'DOC_INGEST_UNCHANGED'}}));
    assert.equal(acknowledgeResolvedDocs('batch',root,second,remaining),3);
    const third=await observeWorkspace(root,'batch',{env});
    assert.equal(third.changedDocs.length,0,'the next pass cannot repeat successful documents forever');
  }finally{rmSync(root,{recursive:true,force:true});}
});


test('fully successful ingestion does not acknowledge an edit made during the pass',async()=>{
  const root=mkdtempSync(join(tmpdir(),'doc-policy-race-'));
  const env={SINGULARITY_REPO_ROOT:root,SINGULARITY_DOC_ROOTS:join(root,'docs')};
  try {
    mkdirSync(join(root,'docs'));
    await saveSessionBaseline('race',root,{env});
    const doc=join(root,'docs','runbook.md');
    writeFileSync(doc,'# First revision\n');
    let first=true;
    // Simulate a successful ingestion response for the observed file, while
    // another writer commits a newer revision before the callback completes.
    const execImpl=(binary,args,options,cb)=>{
      if(binary==='git') return cb(new Error('not a git repo'),'','');
      assert.equal(binary,'python3');
      if(first){
        writeFileSync(doc,'# A newer revision after ingestion began\n');
        first=false;
      }
      cb(null,JSON.stringify({status:'DOC_INGEST_INDEXED'}),'');
    };
    const firstPass=await autoIngestChangedDocs(root,'race',{execImpl,env});
    assert.equal(firstPass.results[0].status,'DOC_INGEST_INDEXED');
    const pending=await observeWorkspace(root,'race',{execImpl,env});
    assert.equal(pending.changedDocs.length,1,'the concurrent revision must remain discoverable');
    const secondPass=await autoIngestChangedDocs(root,'race',{execImpl,env});
    assert.equal(secondPass.results.length,1);
    const done=await observeWorkspace(root,'race',{execImpl,env});
    assert.equal(done.changedDocs.length,0,'the acknowledged revision no longer replays');
  }finally{rmSync(root,{recursive:true,force:true});}
});
