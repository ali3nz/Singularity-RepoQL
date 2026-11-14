#!/usr/bin/env node
/**
 * Explicit live dual-backend read-only acceptance for a small, operator-tagged
 * Markdown test document in Claude Code Complete option 2.
 * This NEVER triggers indexing or changes a source file. Tencent readback and
 * RepoQL content readback are independent requirements. RepoQL is queried
 * through the explicitly pinned native rql.exe CLI, not an assumed MCP URL.
 */
import {lstatSync, readFileSync, realpathSync} from 'node:fs';
import {dirname, relative, resolve, sep, win32} from 'node:path';
import {fileURLToPath} from 'node:url';
import {spawnSync} from 'node:child_process';
import {readRqlVersion} from './configure_project_mcp.mjs';
import {nativeMemoryPolicyEnabled,requestNativeMemoryPolicy} from '../../harness/kit/lib/native-memory-policy.mjs';
import {sha, verifyFile, searchDocs} from '../../scripts/doc-ingest-node.mjs';

const normalize=text=>String(text).replace(/\r\n|\r/g,'\n');
const MARKER=/^DOCPARITY-[A-Za-z0-9_-]{8,64}$/;
function reject(code){throw new Error(code)}
export function canonicalTestDoc(root,file,marker){
  if(!MARKER.test(marker||''))reject('PARITY_MARKER_INVALID');
  const requestedRoot=resolve(root), requestedPath=resolve(requestedRoot,file);
  // Examine the USER-SUPPLIED path before realpathSync follows links. Otherwise
  // a link into the workspace appears regular after resolution and is accepted.
  const candidateRel=relative(requestedRoot,requestedPath);
  if(!candidateRel||candidateRel==='..'||candidateRel.startsWith(`..${sep}`)||candidateRel.startsWith(sep))
    reject('PARITY_DOC_OUTSIDE_ROOT');
  for(let cursor=requestedPath;;cursor=dirname(cursor)){
    if(lstatSync(cursor).isSymbolicLink())reject('PARITY_REPARSE_PATH_REFUSED');
    if(cursor===dirname(cursor))break;
  }
  const rp=realpathSync(requestedRoot),path=realpathSync(requestedPath);
  const rel=relative(rp,path);
  if(!rel||rel==='..'||rel.startsWith(`..${sep}`)||rel.startsWith(sep))reject('PARITY_DOC_OUTSIDE_ROOT');
  if(!/\.md$/i.test(rel)||!lstatSync(path).isFile())reject('PARITY_DOC_MUST_BE_REGULAR_MARKDOWN');
  const bytes=readFileSync(path);
  if(bytes.length<32||bytes.length>8192)reject('PARITY_DOC_SIZE_OUT_OF_BOUNDS');
  const content=normalize(bytes.toString('utf8'));
  if(content.split(marker).length!==2)reject('PARITY_MARKER_MUST_APPEAR_ONCE');
  return {root:rp,absolute:path,relative:rel.replaceAll('\\','/'),content,revision:sha(content).slice(0,8),marker};
}
/** RepoQL `file:///` addresses are repository-root relative, not host absolute paths.
 * Segment encoding preserves spaces and Windows-safe punctuation without
 * accidentally selecting another repository or host drive. */
export function repoqlDocumentUri(doc){
  if(!doc?.relative || doc.relative.startsWith('/') || doc.relative.split('/').some(x => !x || x==='.' || x==='..'))
    reject('REPOQL_RELATIVE_DOCUMENT_URI_INVALID');
  const expected='file:///' + doc.relative.split('/').map(encodeURIComponent).join('/');
  if (!nativeMemoryPolicyEnabled()) return expected;
  const native=requestNativeMemoryPolicy('repoql-doc-uri',{relative:doc.relative});
  if (native.uri!==expected) reject('NATIVE_REPOQL_URI_DIVERGENCE');
  return native.uri;
}
/** Receipts prove the selected TEST document only, never global consistency. */
export async function verifyDocumentParity({doc, tencentLedgerRead, tencentLiveSearch, repoqlRead, repoqlIndexCount}){
  if(!doc?.root||!doc?.relative||!MARKER.test(doc.marker||'') ||
      !/^[0-9a-f]{8}$/.test(doc.revision||''))reject('PARITY_DOCUMENT_INVALID');
  const report={schema:'singularity-claude-complete-dual-doc-readback/v1',variant:2,
    source:doc.relative,expectedRevision:doc.revision,
    tencentLedgerVerified:false,tencentLiveVerified:false,repoqlIndexVerified:false,repoqlLiveVerified:false,
    exactTestRevisionVerified:false,releaseReady:false,
    claudeDesktopPluginReadbackVerified:false,issues:[]};
  let ledger;
  try{ledger=await tencentLedgerRead(doc.relative,doc.root)}
  catch{report.issues.push('TENCENT_LEDGER_UNAVAILABLE');return report;}
  if(ledger?.status!=='DOC_INGEST_VERIFIED'||ledger.revision!==doc.revision){
    report.issues.push('TENCENT_LEDGER_STALE_OR_UNVERIFIED');return report;
  }
  report.tencentLedgerVerified=true;
  try{
    const items=await tencentLiveSearch(doc.marker,doc.root);
    const current=Array.isArray(items)?items.filter(x=>x.source===doc.relative&&
      x.root===ledger.root&&x.revision===doc.revision):[];
    if(current.length!==1){report.issues.push('TENCENT_LIVE_CURRENT_REVISION_NOT_UNIQUE');return report;}
    report.tencentLiveVerified=true;
  }catch{report.issues.push('TENCENT_LIVE_SEARCH_FAILED');return report;}
  try{
    // `rql read` can resolve a file without establishing a separately
    // observable index row. Require a unique index entry before comparing
    // full content. The SQL adapter is mandatory for live acceptance.
    if(typeof repoqlIndexCount!=='function'){
      report.issues.push('REPOQL_INDEX_QUERY_UNAVAILABLE');return report;
    }
    const count=await repoqlIndexCount(repoqlDocumentUri(doc),doc.root);
    if(count!==1){report.issues.push('REPOQL_INDEXED_DOCUMENT_NOT_UNIQUE');return report;}
    report.repoqlIndexVerified=true;
  }catch{report.issues.push('REPOQL_INDEX_QUERY_FAILED');return report;}
  try{
    const actual=await repoqlRead(repoqlDocumentUri(doc)+' => content',doc.root);
    // Byte-identical normalized source content is required as an uninterrupted
    // span. A mere keyword/filename/symbol hit or partial output is NOT proof.
    if(typeof actual!=='string' || !actual.includes(doc.content)){
      report.issues.push('REPOQL_EXACT_CONTENT_NOT_OBSERVED');return report;
    }
    report.repoqlLiveVerified=true;
  }catch{report.issues.push('REPOQL_READ_FAILED');return report;}
  report.exactTestRevisionVerified=true;
  return report;
}

function argsOf(args){
  const keys=new Set(['--root','--file','--marker','--rql-exe','--memory-config','--doc-data','--live']);
  const out={};
  for(let i=0;i<args.length;i++){
    const key=args[i];if(!keys.has(key)||Object.hasOwn(out,key))reject('PARITY_ARGUMENTS_INVALID');
    if(key==='--live'){out[key]=true;continue;}
    if(!args[i+1]||args[i+1].startsWith('--'))reject('PARITY_ARGUMENT_VALUE_MISSING');
    out[key]=args[++i];
  }
  if(!['--root','--file','--marker','--rql-exe','--memory-config','--doc-data'].every(x=>out[x]))
    reject('PARITY_ARGUMENTS_REQUIRED');
  return out;
}
export function repoqlExecutableIndexCount(exe,uri,root){
  // URI originates from pathToFileURL on an approved local test document;
  // single-quote doubling prevents SQL literal injection for path names.
  const literal=uri.replaceAll("'","''");
  const sql=`SELECT COUNT(*) AS exact_indexed_files FROM Files WHERE uri = '${literal}'`;
  const run=spawnSync(exe,['query','--json',sql],{cwd:root,shell:false,encoding:'utf8',timeout:30000,maxBuffer:1024*1024,windowsHide:true});
  if(run.error||run.status!==0||run.signal||typeof run.stdout!=='string')reject('REPOQL_CLI_INDEX_QUERY_FAILED');
  // Use RepoQL's documented JSON query output, not a guessed pretty-table
  // format. No shell, no SQL interpolation beyond one escaped URI literal.
  let parsed;
  try { parsed=JSON.parse(run.stdout); } catch { reject('REPOQL_INDEX_COUNT_UNPARSEABLE'); }
  const rows=Array.isArray(parsed)?parsed:[parsed];
  if(rows.length!==1 || !rows[0] || typeof rows[0]!=='object' ||
      Object.keys(rows[0]).length!==1 || !Object.hasOwn(rows[0],'exact_indexed_files'))
    reject('REPOQL_INDEX_COUNT_UNPARSEABLE');
  const value=rows[0].exact_indexed_files;
  if(!Number.isSafeInteger(value)||value<0)reject('REPOQL_INDEX_COUNT_UNPARSEABLE');
  return value;
}
export function repoqlExecutableRead(exe,uri,root){
  const run=spawnSync(exe,['read',uri],{cwd:root,shell:false,encoding:'utf8',timeout:30000,maxBuffer:1024*1024,windowsHide:true});
  if(run.error||run.status!==0||run.signal || typeof run.stdout!=='string')reject('REPOQL_CLI_READ_FAILED');
  return normalize(run.stdout);
}
export function requirePinnedRepoql(exe){
  if(typeof exe!=='string'||!(/^[A-Za-z]:\\/.test(exe))||
    win32.basename(exe).toLowerCase()!=='rql.exe')reject('NATIVE_RQL_EXE_PATH_REQUIRED');
  const run=spawnSync(exe,['--version'],{shell:false,encoding:'utf8',timeout:5000,maxBuffer:4096,windowsHide:true});
  if(run.error||run.status!==0||run.signal||readRqlVersion(run.stdout)!=='1.7.18')
    reject('REPOQL_EXACT_VERSION_REQUIRED');
}
async function main(argv){
  if(process.platform!=='win32')reject('NATIVE_WINDOWS_LIVE_PARITY_ONLY');
  const a=argsOf(argv);
  if(!a['--live'])reject('EXPLICIT_LIVE_ACCEPTANCE_REQUIRED');
  requirePinnedRepoql(a['--rql-exe']);
  const doc=canonicalTestDoc(a['--root'],a['--file'],a['--marker']);
  const env={...process.env,SINGULARITY_MEMORY_CONFIG:a['--memory-config'],SINGULARITY_DOC_DATA:a['--doc-data']};
  const out=await verifyDocumentParity({doc,
    tencentLedgerRead:(rel,root)=>verifyFile(rel,{root,env}),
    tencentLiveSearch:(query,root)=>searchDocs(query,{root,env,limit:10}),
    repoqlIndexCount:(uri,root)=>repoqlExecutableIndexCount(a['--rql-exe'],uri,root),
    repoqlRead:(uri,root)=>repoqlExecutableRead(a['--rql-exe'],uri,root),
  });
  process.stdout.write(JSON.stringify(out,null,2)+'\n');
  return out.exactTestRevisionVerified?0:1;
}
if(process.argv[1]&&resolve(process.argv[1])===fileURLToPath(import.meta.url)){
  try{process.exitCode=await main(process.argv.slice(2));}
  catch(e){const msg=/^[A-Z0-9_]+$/.test(String(e?.message||''))?e.message:'PARITY_ACCEPTANCE_FAILED';
    process.stderr.write('CLAUDE_COMPLETE_DOC_PARITY_REFUSED: '+msg+'\n');process.exitCode=2;}
}
