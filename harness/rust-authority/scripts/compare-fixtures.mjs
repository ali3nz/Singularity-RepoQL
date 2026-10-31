// Golden differential verifier. Builds are NOT performed by this script.
// Usage: node scripts/compare-fixtures.mjs ./target/debug/orchestra-observer
import { spawn } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
const exe=process.argv[2];if(!exe)throw Error('pass Rust binary path');
const fixture=JSON.parse(readFileSync(new URL('../fixtures/compat.json',import.meta.url),'utf8'));
const sort=(x)=>Array.isArray(x)?x.map(sort):x&&typeof x==='object'?Object.fromEntries(Object.keys(x).sort().map(k=>[k,sort(x[k])])):x;
const child=spawn(resolve(exe),['compat-lines'],{stdio:['pipe','pipe','inherit']});
let out=''; let oversized=false; let stdinError=null; const limit=16*1024*1024;
child.stdout.setEncoding('utf8');
child.stdout.on('data',s=>{ out+=s; if(out.length>limit){oversized=true;child.kill('SIGKILL');} });
child.stdin.on('error',e=>{stdinError=e;});
child.stdin.end(fixture.cases.map(v=>JSON.stringify(v.request)).join('\n')+'\n');
const timeout=setTimeout(()=>child.kill('SIGKILL'),120000);
const exit=await new Promise((resolveExit,reject)=>{child.on('error',reject);child.on('close',resolveExit);});
clearTimeout(timeout);
if(oversized)throw Error('Rust output exceeds bounded response budget');
if(stdinError && stdinError.code!=='EPIPE')throw stdinError;
if(exit!==0)throw Error(`Rust process exit: ${exit===null?'terminated or timed out':exit}`);
const lines=out.trim().split('\n').map(s=>JSON.parse(s));
let failures=0;
for(let i=0;i<fixture.cases.length;i++){
 const actual=JSON.stringify(sort(lines[i]));const expected=JSON.stringify(sort(fixture.cases[i].expected));
 if(actual!==expected){failures++;if(failures<=20)console.error(`MISMATCH ${i} ${JSON.stringify(fixture.cases[i].request)}\n  JS=${expected}\n  RS=${actual}`);}
}
console.log(`${fixture.cases.length-failures}/${fixture.cases.length} JS/Rust golden cases matched`);
if(failures||lines.length!==fixture.cases.length)process.exit(1);
