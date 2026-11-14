// Narrow self-contained native bridge for the shared documentation runtime.
// The OpenChamber attach installs scripts/ outside the repository and cannot
// import harness/kit/lib. This transport has the same bounded contract as the
// harness bridge, but exposes only the four pure document/lesson commands.
// It never changes state, accesses memory credentials, or falls back after a
// native error. The JavaScript caller independently compares every verdict.
import {spawnSync} from 'node:child_process';
import {isAbsolute,dirname,parse,win32} from 'node:path';
import {lstatSync, readFileSync} from 'node:fs';
import {createHash} from 'node:crypto';

const ENV='SINGULARITY_RUST_MEMORY_POLICY_BIN';
const ALLOWED=new Set(['doc-policy-classify','doc-root-entries','selflearn-candidate-id','selflearn-validate-lesson']);
const DOC_ENV='SINGULARITY_DOC_RUST_BIN';
const DOC_ALLOWED=new Set(['doc-index-chunks','doc-index-plan','doc-index-select','doc-index-locate']);
const INPUT_CAP=256*1024;
const OUTPUT_CAP=1024*1024;
export class NativeMemoryPolicyError extends Error {
  constructor(code,detail=''){
    super(`native memory policy: ${code}${detail ? ` (${detail})` : ''}`);
    this.name='NativeMemoryPolicyError';this.code=code;
  }
}
export function nativeMemoryPolicyEnabled(){return Boolean(process.env[ENV]);}
export function requestNativeMemoryPolicy(command,payload){
  if(!ALLOWED.has(command))throw new NativeMemoryPolicyError('UNSUPPORTED_COMMAND');
  return invokeNativeMemoryPolicy(command,payload,process.env[ENV]);
}
export function nativeDocIndexPolicyEnabled(env=process.env){return Boolean(env?.[DOC_ENV]);}
export function requestNativeDocIndexPolicy(command,payload,env=process.env){
  if(!DOC_ALLOWED.has(command))throw new NativeMemoryPolicyError('UNSUPPORTED_COMMAND');
  return invokeNativeMemoryPolicy(command,payload,env?.[DOC_ENV],env);
}
export function commitNativeDocLedger(payload,env){
  return invokeNativeMemoryPolicy(null,payload,env.SINGULARITY_DOC_LEDGER_COMMIT_RUST_BIN,env);
}
export function writeNativeDocChunk(body, {binary, config, origin, serviceId, env, verify = false, marker = false}) {
  if (!isAbsolute(binary) || (process.platform === 'win32' && !/^[A-Za-z]:[\\/]/.test(binary)))
    throw new NativeMemoryPolicyError('INVALID_NATIVE_BINARY_PATH');
  for (let path = binary; path !== parse(path).root; path = dirname(path)) {
    const info = lstatSync(path);
    if (info.isSymbolicLink() || (path === binary && !info.isFile()))
      throw new NativeMemoryPolicyError('INVALID_NATIVE_BINARY_PATH');
  }
  const digest = env.SINGULARITY_DOC_WRITE_RUST_SHA256;
  if (digest !== undefined && (!/^[a-f0-9]{64}$/.test(digest) ||
      lstatSync(binary).size > 100 * 1024 * 1024 ||
      createHash('sha256').update(readFileSync(binary)).digest('hex') !== digest))
    throw new NativeMemoryPolicyError('DOC_NATIVE_BINARY_HASH_DRIFT');
  const safeEnv = Object.fromEntries(Object.entries(env).filter(([key]) =>
    ['SYSTEMROOT', 'WINDIR'].includes(key.toUpperCase())));
  const input = JSON.stringify({operation:marker?'docFindMarker':verify?'docVerify':'docWrite',
    path:marker?'/v3/conversation/search':verify?'/v3/conversation/query':'/v3/conversation/add',expected_service:serviceId,body});
  if (Buffer.byteLength(input, 'utf8') > 128 * 1024)
    throw new NativeMemoryPolicyError('PAYLOAD_LIMIT_EXCEEDED');
  const result = spawnSync(binary, [], {
    input, encoding:'utf8', windowsHide:true, shell:false, timeout:23000, maxBuffer:4096,
    env:{...safeEnv, SINGULARITY_DOC_WRITE_CONFIG:config, SINGULARITY_DOC_WRITE_ORIGIN:origin},
  });
  if (result.error || result.status !== 0)
    throw new NativeMemoryPolicyError('DOC_NATIVE_WRITE_UNCONFIRMED');
  let output;
  try { output = JSON.parse(result.stdout); } catch { /* no raw child output in logs */ }
  const field = marker ? 'visible' : verify ? 'verified' : 'accepted';
  if (output?.ok !== true || Object.keys(output).length !== 2 ||
      (verify || marker ? typeof output[field] !== 'boolean' : output[field] !== true))
    throw new NativeMemoryPolicyError('DOC_NATIVE_WRITE_UNCONFIRMED');
  return output[field];
}
function invokeNativeMemoryPolicy(command,payload,bin,sourceEnv=null){
  if(!bin)throw new NativeMemoryPolicyError('NATIVE_POLICY_NOT_ENABLED');
  if(bin.includes('\0')||(!isAbsolute(bin)&&!win32.isAbsolute(bin)))
    throw new NativeMemoryPolicyError('INVALID_NATIVE_BINARY_PATH');
  let input;
  try{input=JSON.stringify(payload);}catch{throw new NativeMemoryPolicyError('INVALID_PAYLOAD');}
  if(typeof input!=='string'||Buffer.byteLength(input,'utf8')>INPUT_CAP)
    throw new NativeMemoryPolicyError('PAYLOAD_LIMIT_EXCEEDED');
  // The document policy needs none of the MemoryCore secrets or identities
  // present in the caller's environment. Restrict only this doc-index path.
  const safeEnv=sourceEnv==null ? undefined : Object.fromEntries(
    Object.entries(sourceEnv).filter(([key])=>
      new Set(['PATH','SYSTEMROOT','WINDIR','TEMP','TMP','HOME']).has(key.toUpperCase())));
  const result=spawnSync(bin,command===null ? [] : [command],{
    input,encoding:'utf8',windowsHide:true,shell:false,
    timeout:3500,maxBuffer:OUTPUT_CAP,
    ...(safeEnv===undefined ? {} : {env:safeEnv}),
  });
  if(result.error){
    const code=result.error.code==='ETIMEDOUT'?'NATIVE_POLICY_TIMEOUT':'NATIVE_POLICY_UNAVAILABLE';
    throw new NativeMemoryPolicyError(code,String(result.error.code??'spawn error'));
  }
  let output;
  try{output=JSON.parse(result.stdout);}catch{throw new NativeMemoryPolicyError('INVALID_NATIVE_RESPONSE');}
  if(!output||typeof output!=='object'||Array.isArray(output)||typeof output.ok!=='boolean')
    throw new NativeMemoryPolicyError('INVALID_NATIVE_RESPONSE');
  if(result.status!==0||output.ok!==true)
    throw new NativeMemoryPolicyError('NATIVE_POLICY_REJECTED',String(output.code??result.status??'failure').slice(0,100));
  return output;
}
