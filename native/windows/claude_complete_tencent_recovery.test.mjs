import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {planReconciliation,SCHEMA} from './claude_complete_doc_reconciliation.mjs';
import {recoverTencentTestDocs} from './claude_complete_tencent_recovery.mjs';
const marker='DOCPARITY-RECOVERY-ABCD1234';
function fixture(){const root=mkdtempSync(join(tmpdir(),'tc-repair-'));
 writeFileSync(join(root,'test.md'),`# Test\n\n${marker}\n\nSafe data.\n`);
 const manifest={schema:SCHEMA,documents:[{file:'test.md',marker}]};
 const doc=planReconciliation(root,manifest)[0];return {root,manifest,doc};}
const row=(doc,issues,status='NEEDS_RECONCILIATION')=>({source:doc.relative,expectedRevision:doc.revision,issues,status});
test('approval and native Windows are mandatory before backend call',async()=>{
 const f=fixture();let called=false;
 await assert.rejects(recoverTencentTestDocs({...f,readback:async()=>{called=true},ingest:async()=>{},windowsHost:false,authorized:true}));
 assert.equal(called,false);
});
test('stale Tencent test revision recovers only after independent dual readback',async()=>{
 const f=fixture();let writes=0,reads=0;
 const r=await recoverTencentTestDocs({...f,authorized:true,windowsHost:true,
  readback:async()=>{reads++;return {documents:[reads===1?row(f.doc,['TENCENT_LEDGER_STALE_OR_UNVERIFIED']):row(f.doc,[],'TEST_DOCUMENT_VERIFIED')]};},
  ingest:async(file,opts)=>{writes++;assert.equal(opts.expectedRevision,f.doc.revision);return {status:'DOC_INGEST_INDEXED'};}});
 assert.equal(writes,1);assert.equal(r.rows[0].outcome,'TEST_DOCUMENT_RECOVERED');
 assert.equal(r.releaseReady,false);assert.equal(r.repoqlWritePerformed,false);
});
test('RepoQL-only issues never cause Tencent writes',async()=>{
 const f=fixture();let writes=0;
 const r=await recoverTencentTestDocs({...f,authorized:true,windowsHost:true,
  readback:async()=>({documents:[row(f.doc,['REPOQL_INDEXED_DOCUMENT_NOT_UNIQUE'])]}),
  ingest:async()=>{writes++}});
 assert.equal(writes,0);assert.equal(r.rows[0].outcome,'OPERATOR_REVIEW_REQUIRED');
});
test('local edit between original precheck and write blocks mutation',async()=>{
 const f=fixture();let writes=0,reads=0;
 const r=await recoverTencentTestDocs({...f,authorized:true,windowsHost:true,
  readback:async()=>{reads++;if(reads===1)writeFileSync(join(f.root,'test.md'),`# changed\n\n${marker}\n\nNew text.\n`);
   return {documents:[row(f.doc,['TENCENT_LEDGER_STALE_OR_UNVERIFIED'])]};},
  ingest:async()=>{writes++}});
 assert.equal(writes,0);assert.equal(r.rows[0].outcome,'SOURCE_CHANGED_NO_WRITE');
});
test('write receipt alone cannot make post-readback pass',async()=>{
 const f=fixture();let writes=0;
 const r=await recoverTencentTestDocs({...f,authorized:true,windowsHost:true,
  readback:async()=>({documents:[row(f.doc,['TENCENT_LEDGER_STALE_OR_UNVERIFIED'])]}),
  ingest:async()=>{writes++;return {status:'DOC_INGEST_INDEXED'};}});
 assert.equal(writes,1);assert.equal(r.rows[0].outcome,'RECOVERY_READBACK_UNVERIFIED');
});
test('engine refuses changed expected revision before any ledger or remote writes',async()=>{
 const f=fixture();const {ingestFile}=await import('../../scripts/doc-ingest-node.mjs');
 const r=await ingestFile(f.doc.absolute,{root:f.root,expectedRevision:'deadbeef',
  env:{SINGULARITY_DOC_DATA:join(f.root,'data'),SINGULARITY_DOC_ROOTS:f.root}});
 assert.equal(r.status,'DOC_INGEST_BLOCKED');
 assert.equal(r.reason,'EXPECTED_SOURCE_REVISION_CHANGED');
});
