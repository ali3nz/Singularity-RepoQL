#!/usr/bin/env node
/** Explicit, bounded Tencent-only replay for operator-marked TEST docs.
 * RepoQL indexing is not modified. A post-write dual-backend readback is
 * mandatory; the command does not declare an index ready from write status.
 */
import {resolve} from 'node:path';
import {fileURLToPath} from 'node:url';
import {openSync,writeFileSync,closeSync} from 'node:fs';
import {planReconciliation,reconcileDocuments,loadManifest} from './claude_complete_doc_reconciliation.mjs';
import {canonicalTestDoc,repoqlExecutableRead,repoqlExecutableIndexCount,requirePinnedRepoql} from './claude_complete_doc_parity.mjs';
import {verifyFile,searchDocs,ingestFile} from '../../scripts/doc-ingest-node.mjs';
const fail=x=>{throw new Error(x)};
export async function recoverTencentTestDocs({root,manifest,authorized=false,windowsHost=process.platform==='win32',
    readback,ingest,sourceReader=canonicalTestDoc}={}){
  if(!authorized||!windowsHost)fail('EXPLICIT_WINDOWS_TENCENT_TEST_REPAIR_APPROVAL_REQUIRED');
  const docs=planReconciliation(root,manifest);
  if(typeof readback!=='function'||typeof ingest!=='function')fail('RECOVERY_ADAPTERS_REQUIRED');
  const before=await readback();
  if(!Array.isArray(before?.documents)||before.documents.length!==docs.length)
    fail('RECOVERY_PRE_READBACK_INCOMPLETE');
  const rows=[];
  for(let i=0;i<docs.length;i++){
    const doc=docs[i],row=before.documents[i];
    if(row.source!==doc.relative||row.expectedRevision!==doc.revision||!Array.isArray(row.issues))
      fail('RECOVERY_PRE_READBACK_SCOPE_MISMATCH');
    const eligible=row.issues.length===1&&row.issues[0]==='TENCENT_LEDGER_STALE_OR_UNVERIFIED';
    if(!eligible){rows.push({source:doc.relative,repairAttempted:false,
      outcome:row.status==='TEST_DOCUMENT_VERIFIED'?'ALREADY_VERIFIED':'OPERATOR_REVIEW_REQUIRED'});continue;}
    // Revision is checked immediately before ingest, and ingest enforces the
    // same revision again on its own snapshot before any backend write.
    let current;
    try{current=sourceReader(root,doc.relative,doc.marker)}catch{current=null}
    if(current?.revision!==doc.revision){
      rows.push({source:doc.relative,repairAttempted:false,outcome:'SOURCE_CHANGED_NO_WRITE'});continue;
    }
    let status='DOC_INGEST_FAILED';
    try{status=(await ingest(doc.absolute,{root,expectedRevision:doc.revision}))?.status||status}
    catch{/* no raw service replies or secrets in receipts */}
    rows.push({source:doc.relative,repairAttempted:true,
      outcome:['DOC_INGEST_INDEXED','DOC_INGEST_UNCHANGED'].includes(status)?'TENCENT_WRITE_REPORTED':'TENCENT_REPAIR_NOT_VERIFIED'});
  }
  const after=await readback();
  for(let i=0;i<docs.length;i++){
    const row=rows[i],checked=after?.documents?.[i];
    row.bothBackendsReverified=checked?.source===docs[i].relative &&
      checked?.expectedRevision===docs[i].revision&&checked?.status==='TEST_DOCUMENT_VERIFIED';
    if(row.repairAttempted)
      row.outcome=row.bothBackendsReverified?'TEST_DOCUMENT_RECOVERED':'RECOVERY_READBACK_UNVERIFIED';
  }
  return {schema:'singularity-option2-tencent-test-recovery/v1',variant:2,
    selectedTestDocuments:rows.length,rows,tencentWriteAttempted:rows.some(x=>x.repairAttempted),
    repoqlWritePerformed:false,allRepositoryDocumentsVerified:false,
    nativeClaudeGuiVerified:false,releaseReady:false};
}
function parse(argv){const keys=new Set(['--root','--manifest','--rql-exe','--memory-config','--doc-data','--output','--apply-tencent']);const v={};
 for(let i=0;i<argv.length;i++){
  const key=argv[i];if(!keys.has(key)||Object.hasOwn(v,key))fail('RECOVERY_ARGUMENT_INVALID');
  if(key==='--apply-tencent'){v[key]=true;continue}
  if(!argv[i+1]||argv[i+1].startsWith('--'))fail('RECOVERY_ARGUMENT_VALUE_MISSING');v[key]=argv[++i];
 }return v}
async function main(argv){
 const a=parse(argv);
 if(process.platform!=='win32'||!a['--apply-tencent']||!['--root','--manifest','--rql-exe','--memory-config','--doc-data'].every(x=>a[x]))
   fail('RECOVERY_REQUIRES_WINDOWS_AND_EXPLICIT_APPROVAL');
 const manifest=loadManifest(a['--manifest']);planReconciliation(a['--root'],manifest);
 requirePinnedRepoql(a['--rql-exe']);
 const env={...process.env,SINGULARITY_MEMORY_CONFIG:a['--memory-config'],SINGULARITY_DOC_DATA:a['--doc-data']};
 const readback=()=>reconcileDocuments({root:a['--root'],manifest,
   tencentLedgerRead:(file,root)=>verifyFile(file,{root,env}),
   tencentLiveSearch:(marker,root)=>searchDocs(marker,{root,env,limit:10}),
   repoqlIndexCount:(uri,root)=>repoqlExecutableIndexCount(a['--rql-exe'],uri,root),
   repoqlRead:(uri,root)=>repoqlExecutableRead(a['--rql-exe'],uri,root)});
 const report=await recoverTencentTestDocs({root:a['--root'],manifest,authorized:true,windowsHost:true,readback,
   ingest:(file,opts)=>ingestFile(file,{...opts,env,session:'singularity-test-recovery'})});
 const content=JSON.stringify(report,null,2)+'\n';
 if(a['--output']){const fd=openSync(a['--output'],'wx',0o600);try{writeFileSync(fd,content)}finally{closeSync(fd)}}
 else process.stdout.write(content);
 return report.rows.some(x=>x.repairAttempted&&!x.bothBackendsReverified)?1:0;
}
if(process.argv[1]&&resolve(process.argv[1])===fileURLToPath(import.meta.url)){
 try{process.exitCode=await main(process.argv.slice(2))}
 catch(e){process.stderr.write('TENCENT_TEST_RECOVERY_REFUSED\n');process.exitCode=2}
}
