import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,mkdirSync,writeFileSync,symlinkSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {planReconciliation,reconcileDocuments,SCHEMA} from './claude_complete_doc_reconciliation.mjs';
function fixture(){
 const root=mkdtempSync(join(tmpdir(),'reconcile-'));
 const markers=['DOCPARITY-TEST2026-AAAA1111','DOCPARITY-TEST2026-BBBB2222'];
 for(let i=0;i<2;i++)writeFileSync(join(root,`doc${i}.md`),`# test ${i}\n\n${markers[i]}\n\nText for full readback ${i}.\n`);
 return {root,manifest:{schema:SCHEMA,documents:markers.map((marker,i)=>({file:`doc${i}.md`,marker}))}};
}
test('plans exactly scoped local marked documents',()=>{
 const {root,manifest}=fixture();const docs=planReconciliation(root,manifest);
 assert.equal(docs.length,2);assert.notEqual(docs[0].revision,docs[1].revision);
});
test('records independent per-file success without release claim',async()=>{
 const {root,manifest}=fixture();let calls=0;
 const r=await reconcileDocuments({root,manifest,parityCheck:async ({doc})=>{
  calls++;return {issues:[],exactTestRevisionVerified:true};}});
 assert.equal(calls,2);assert.equal(r.verifiedTestDocuments,2);
 assert.equal(r.unresolvedTestDocuments,0);assert.equal(r.releaseReady,false);
 assert.equal(r.allRepositoryDocumentsVerified,false);
 assert.equal(r.automatedRepairPerformed,false);
 assert.doesNotMatch(JSON.stringify(r),/DOCPARITY-/);
});
test('stale Tencent and missing RepoQL surface different operator actions',async()=>{
 const {root,manifest}=fixture();
 const r=await reconcileDocuments({root,manifest,parityCheck:async ({doc})=>({
  issues:[doc.relative==='doc0.md'?'TENCENT_LEDGER_STALE_OR_UNVERIFIED':'REPOQL_EXACT_CONTENT_NOT_OBSERVED'],
  exactTestRevisionVerified:false})});
 assert.match(r.documents[0].operatorNextAction,/TENCENT/);
 assert.match(r.documents[1].operatorNextAction,/REPOQL/);
 assert.equal(r.unresolvedTestDocuments,2);
});
test('concurrent source edit invalidates a previously successful backend check',async()=>{
 const {root,manifest}=fixture();
 const r=await reconcileDocuments({root,manifest,parityCheck:async ({doc})=>{
  if(doc.relative==='doc0.md')writeFileSync(join(root,'doc0.md'),doc.content+'\nnew edit\n');
  return {issues:[],exactTestRevisionVerified:true};}});
 assert.equal(r.verifiedTestDocuments,1);assert.match(r.documents[0].issues[0],/SOURCE_CHANGED/);
 assert.equal(r.documents[0].operatorNextAction,'STABILIZE_SOURCE_THEN_REPEAT');
});
test('duplicate document or invalid path fails before backend calls',async()=>{
 const {root,manifest}=fixture();manifest.documents[1].file=manifest.documents[0].file;
 let called=false;
 await assert.rejects(reconcileDocuments({root,manifest,parityCheck:async()=>{called=true}}));
 assert.equal(called,false);
});
test('symlinked test files refused before backend calls',()=>{
 const {root,manifest}=fixture();const link=join(root,'link.md');
 try{symlinkSync(join(root,'doc0.md'),link)}catch{return}
 manifest.documents[0].file='link.md';
 assert.throws(()=>planReconciliation(root,manifest),/PARITY_REPARSE_PATH_REFUSED/);
});
test('backend exception does not leak secrets in result',async()=>{
 const {root,manifest}=fixture();
 const r=await reconcileDocuments({root,manifest,parityCheck:async()=>{throw new Error('secret service token')}});
 assert.equal(r.unresolvedTestDocuments,2);assert.doesNotMatch(JSON.stringify(r),/secret service token/);
});
