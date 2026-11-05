import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,mkdirSync,writeFileSync,symlinkSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {canonicalTestDoc,repoqlDocumentUri,verifyDocumentParity} from './claude_complete_doc_parity.mjs';
const marker='DOCPARITY-2026SESSION-ABCD1234';
function fixture(){const dir=mkdtempSync(join(tmpdir(),'cc-doc-parity-'));const root=join(dir,'hub');mkdirSync(root);
 const content=`# Acceptance test\n\n${marker}\n\nThis text must match exactly in RepoQL.\n`;
 writeFileSync(join(root,'probe.md'),content);return {root,doc:canonicalTestDoc(root,'probe.md',marker)};}
function sources(doc,{revision=doc.revision,repoql=doc.content,tencent=true,root='abc'}={}){
 return {tencentLedgerRead:async()=>({status:'DOC_INGEST_VERIFIED',revision,root}),
 tencentLiveSearch:async()=>tencent?[{source:doc.relative,revision,root}]:[],
 repoqlIndexCount:async()=>1, repoqlRead:async()=>`RepoQL read:\n${repoql}\n--end--`};}
test('exact Tencent ledger, live Tencent and full RepoQL content required',async()=>{
 const {doc}=fixture();const r=await verifyDocumentParity({doc,...sources(doc)});
 assert.equal(r.exactTestRevisionVerified,true);
 assert.equal(r.tencentLiveVerified,true);
 assert.equal(r.repoqlLiveVerified,true);
 assert.equal(r.releaseReady,false);
 assert.equal(r.claudeDesktopPluginReadbackVerified,false);
 assert.doesNotMatch(JSON.stringify(r),/This text must match|DOCPARITY/);
});
test('local file edit refuses old ledger without querying other backends',async()=>{
 const {root,doc}=fixture();writeFileSync(join(root,'probe.md'),doc.content+'newer revision\n');
 const changed=canonicalTestDoc(root,'probe.md',marker);let calls=0;
 const r=await verifyDocumentParity({doc:changed,tencentLedgerRead:async()=>({status:'DOC_INGEST_VERIFIED',revision:doc.revision,root:'abc'}),
 tencentLiveSearch:async()=>{calls++;return[]},repoqlRead:async()=>{calls++;return''}});
 assert.equal(r.exactTestRevisionVerified,false);assert.equal(calls,0);
 assert.deepEqual(r.issues,['TENCENT_LEDGER_STALE_OR_UNVERIFIED']);
});
test('live Tencent search wrong root/revision refuses RepoQL query',async()=>{
 const {doc}=fixture();let called=false;
 const r=await verifyDocumentParity({doc,...sources(doc,{tencent:false}),repoqlRead:async()=>{called=true;return doc.content;}});
 assert.equal(r.exactTestRevisionVerified,false);assert.equal(called,false);
});
test('RepoQL filename or partial excerpt is not current revision proof',async()=>{
 const {doc}=fixture();const r=await verifyDocumentParity({doc,...sources(doc,{repoql:`file:///probe.md\n${marker}`})});
 assert.equal(r.repoqlLiveVerified,false);assert.equal(r.exactTestRevisionVerified,false);
});
test('missing/duplicate marker, oversized doc, and escape outside root rejected before network',()=>{
 const {root,doc}=fixture();
 assert.throws(()=>canonicalTestDoc(root,'probe.md','bad'),/PARITY_MARKER_INVALID/);
 writeFileSync(join(root,'probe.md'),doc.content+marker);
 assert.throws(()=>canonicalTestDoc(root,'probe.md',marker),/PARITY_MARKER_MUST_APPEAR_ONCE/);
 writeFileSync(join(root,'probe.md'),'a'.repeat(9000)+marker);
 assert.throws(()=>canonicalTestDoc(root,'probe.md',marker),/PARITY_DOC_SIZE_OUT_OF_BOUNDS/);
 assert.throws(()=>canonicalTestDoc(root,'../outside.md',marker));
});
test('backend errors are not echoed or accepted',async()=>{
 const {doc}=fixture();const r=await verifyDocumentParity({doc,...sources(doc),repoqlRead:()=>{throw Error('secret response must not leak')}});
 assert.equal(r.exactTestRevisionVerified,false);
 assert.deepEqual(r.issues,['REPOQL_READ_FAILED']);
 assert.doesNotMatch(JSON.stringify(r),/secret/);
});

test('rejects symlinked document and symlinked parent before realpath',()=>{
 const {root,doc}=fixture();
 for(const [name,target,isDir] of [
    ['linked.md',join(root,'probe.md'),false],
    ['linked-dir',root,true],
 ]){
   const link=join(root,name);
   try{symlinkSync(target,link,isDir?'dir':'file');}catch{return;}
   assert.throws(()=>canonicalTestDoc(root,isDir?'linked-dir/probe.md':'linked.md',marker),/PARITY_REPARSE_PATH_REFUSED/);
 }
});

test('RepoQL content alone is not accepted without an independent indexed Files row',async()=>{
 const {doc}=fixture();
 const missing=await verifyDocumentParity({doc,...sources(doc),repoqlIndexCount:async()=>0});
 assert.equal(missing.exactTestRevisionVerified,false);
 assert.deepEqual(missing.issues,['REPOQL_INDEXED_DOCUMENT_NOT_UNIQUE']);
 assert.equal(missing.repoqlLiveVerified,false);
 const absent=await verifyDocumentParity({doc,...sources(doc),repoqlIndexCount:undefined});
 assert.deepEqual(absent.issues,['REPOQL_INDEX_QUERY_UNAVAILABLE']);
});
test('RepoQL indexed file count must be exactly one and errors never leak',async()=>{
 const {doc}=fixture();
 const duplicate=await verifyDocumentParity({doc,...sources(doc),repoqlIndexCount:async()=>2});
 assert.equal(duplicate.repoqlIndexVerified,false);
 const fail=await verifyDocumentParity({doc,...sources(doc),repoqlIndexCount:async()=>{throw Error('secret')}});
 assert.deepEqual(fail.issues,['REPOQL_INDEX_QUERY_FAILED']);
 assert.doesNotMatch(JSON.stringify(fail),/secret/);
});

test('RepoQL uses indexed repository-relative URI rather than C-drive absolute path',async()=>{
 const {doc}=fixture(); let seen=[];
 const r=await verifyDocumentParity({doc,...sources(doc),
  repoqlIndexCount:async uri=>{seen.push(uri);return 1},
  repoqlRead:async uri=>{seen.push(uri);return doc.content}});
 assert.equal(r.exactTestRevisionVerified,true);
 assert.deepEqual(seen,['file:///probe.md','file:///probe.md => content']);
 assert.equal(repoqlDocumentUri({...doc,relative:'folder/file name.md'}),'file:///folder/file%20name.md');
});
