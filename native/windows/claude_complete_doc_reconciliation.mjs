#!/usr/bin/env node
/**
 * Read-only multi-document Tencent/RepoQL reconciliation for operator-owned
 * MARKED TEST DOCUMENTS. Never indexes, seeds, repairs, replays, or changes
 * user data. A per-file readback is not a whole-repository parity guarantee.
 */
import {lstatSync,readFileSync,writeFileSync,openSync,closeSync} from 'node:fs';
import {dirname,isAbsolute,resolve,win32} from 'node:path';
import {fileURLToPath} from 'node:url';
import {canonicalTestDoc,verifyDocumentParity,repoqlExecutableRead,repoqlExecutableIndexCount,requirePinnedRepoql} from './claude_complete_doc_parity.mjs';
import {verifyFile,searchDocs} from '../../scripts/doc-ingest-node.mjs';
export const SCHEMA='singularity-claude-complete-reconciliation-manifest/v1';
function fail(code){throw new Error(code)}
const hasOnly=(x,keys)=>x&&typeof x==='object'&&!Array.isArray(x)&&
  Object.keys(x).sort().join(',')===[...keys].sort().join(',');

export function planReconciliation(root,manifest){
  if(!hasOnly(manifest,['schema','documents'])||manifest.schema!==SCHEMA||
    !Array.isArray(manifest.documents)||manifest.documents.length<1||manifest.documents.length>12)
    fail('RECONCILIATION_MANIFEST_INVALID');
  const documents=[],seen=new Set();
  for(const item of manifest.documents){
    if(!hasOnly(item,['file','marker'])||typeof item.file!=='string'||
      !item.file.trim()||isAbsolute(item.file)||win32.isAbsolute(item.file))
      fail('RECONCILIATION_FILE_INVALID');
    // This performs all path, symlink and exact marker checks before any network.
    const doc=canonicalTestDoc(root,item.file,item.marker);
    if(seen.has(doc.relative.toLowerCase()))fail('RECONCILIATION_DUPLICATE_DOCUMENT');
    seen.add(doc.relative.toLowerCase());documents.push(doc);
  }
  return documents;
}

function actionFor(issues){
  if(issues.includes('SOURCE_CHANGED_DURING_READBACK'))return 'STABILIZE_SOURCE_THEN_REPEAT';
  if(issues.some(x=>x.startsWith('TENCENT_')))return 'INVESTIGATE_TENCENT_INGESTION_AND_READBACK';
  if(issues.some(x=>x.startsWith('REPOQL_')))return 'INVESTIGATE_REPOQL_INDEX_AND_READBACK';
  return issues.length?'REVIEW_READBACK_FAILURE':'NONE';
}

/** Mockable adapters are supplied ONLY by the tests or the live CLI. */
export async function reconcileDocuments({root,manifest,tencentLedgerRead,tencentLiveSearch,repoqlRead,repoqlIndexCount,
  parityCheck=verifyDocumentParity,sourceReader=canonicalTestDoc}={}){
  const docs=planReconciliation(root,manifest); const rows=[];
  for(const doc of docs){
    let result;
    try{result=await parityCheck({doc,tencentLedgerRead,tencentLiveSearch,repoqlRead,repoqlIndexCount})}
    catch{result={issues:['DOCUMENT_READBACK_FAILED'],exactTestRevisionVerified:false}}
    const issues=Array.isArray(result?.issues)?[...result.issues]:['READBACK_RECEIPT_INVALID'];
    let stable=false;
    try{stable=sourceReader(root,doc.relative,doc.marker).revision===doc.revision}
    catch{stable=false}
    if(!stable)issues.push('SOURCE_CHANGED_DURING_READBACK');
    const verified=stable && result?.exactTestRevisionVerified===true && issues.length===0;
    rows.push({source:doc.relative,expectedRevision:doc.revision,
      status:verified?'TEST_DOCUMENT_VERIFIED':'NEEDS_RECONCILIATION',
      issues,operatorNextAction:actionFor(issues)});
  }
  return {schema:'singularity-claude-complete-doc-reconciliation/v1',variant:2,
    inspected:rows.length,verifiedTestDocuments:rows.filter(x=>x.status==='TEST_DOCUMENT_VERIFIED').length,
    unresolvedTestDocuments:rows.filter(x=>x.status!=='TEST_DOCUMENT_VERIFIED').length,
    documents:rows,automatedRepairPerformed:false,repoqlIndexUpdateExecuted:false,
    allRepositoryDocumentsVerified:false,releaseReady:false};
}
function parseArgs(args){
 const accepted=new Set(['--root','--manifest','--rql-exe','--memory-config','--doc-data','--output','--live']);
 const out={};
 for(let i=0;i<args.length;i++){
   const key=args[i]; if(!accepted.has(key)||Object.hasOwn(out,key))fail('RECONCILIATION_ARGUMENT_INVALID');
   if(key==='--live'){out[key]=true;continue}
   if(!args[i+1]||args[i+1].startsWith('--'))fail('RECONCILIATION_ARGUMENT_VALUE_MISSING');
   out[key]=args[++i];
 }
 if(!out['--root']||!out['--manifest'])fail('RECONCILIATION_MANIFEST_REQUIRED');
 return out;
}
export function loadManifest(file){
 const stat=lstatSync(file);if(!stat.isFile()||stat.isSymbolicLink()||stat.size>65536||stat.size<20)
   fail('RECONCILIATION_MANIFEST_FILE_INVALID');
 const content=readFileSync(file,'utf8');return JSON.parse(content);
}
async function main(argv){
 const a=parseArgs(argv),manifest=loadManifest(a['--manifest']);
 // All test file paths must be validated before accessing either backend.
 planReconciliation(a['--root'],manifest);
 let report;
 if(!a['--live']){
   report={schema:'singularity-claude-complete-doc-reconciliation-plan/v1',variant:2,
     testDocumentCount:manifest.documents.length,liveTestsRun:false,releaseReady:false};
 }else{
   if(process.platform!=='win32')fail('NATIVE_WINDOWS_REQUIRED_FOR_LIVE_RECONCILIATION');
   for(const field of ['--rql-exe','--memory-config','--doc-data'])if(!a[field])fail('RECONCILIATION_LIVE_CONFIG_REQUIRED');
   requirePinnedRepoql(a['--rql-exe']);
   const env={...process.env,SINGULARITY_MEMORY_CONFIG:a['--memory-config'],SINGULARITY_DOC_DATA:a['--doc-data']};
   report=await reconcileDocuments({root:a['--root'],manifest,
     tencentLedgerRead:(file,root)=>verifyFile(file,{root,env}),
     tencentLiveSearch:(marker,root)=>searchDocs(marker,{root,env,limit:10}),
     repoqlIndexCount:(uri,root)=>repoqlExecutableIndexCount(a['--rql-exe'],uri,root),
     repoqlRead:(uri,root)=>repoqlExecutableRead(a['--rql-exe'],uri,root)});
 }
 const text=JSON.stringify(report,null,2)+'\n';
 if(a['--output']){
   // Exclusive create. Never replace an existing gate receipt or user file.
   const fd=openSync(a['--output'],'wx',0o600);
   try{writeFileSync(fd,text,'utf8')}finally{closeSync(fd)}
 }else process.stdout.write(text);
 return !a['--live']||report.unresolvedTestDocuments===0?0:1;
}
if(process.argv[1]&&resolve(process.argv[1])===fileURLToPath(import.meta.url)){
 try{process.exitCode=await main(process.argv.slice(2))}
 catch(e){const c=/^[A-Z0-9_]+$/.test(String(e?.message||''))?e.message:'RECONCILIATION_FAILED';
  process.stderr.write('RECONCILIATION_REFUSED:'+c+'\n');process.exitCode=2}
}
