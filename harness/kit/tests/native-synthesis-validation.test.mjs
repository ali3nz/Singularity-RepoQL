import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,writeFileSync,chmodSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {validateSynthesisSpec} from '../lib/memory-synthesis.mjs';

const fixture = `#!/usr/bin/env node
let s='';process.stdin.setEncoding('utf8');process.stdin.on('data',x=>s+=x);
process.stdin.on('end',()=>{
const {spec}=JSON.parse(s);const type=String(spec.type??'');const summary=String(spec.summary??'').trim();
const sources=Array.isArray(spec.sourceClaimIds)?spec.sourceClaimIds.map(String):[];
const ok=['current_preferences','active_projects','open_decisions','known_conflicts','operator_constraints','recent_supersessions','unfinished_work'];
const problems=[];
if(!ok.includes(type))problems.push('type not in enum: '+type+' (plan §15 initial categories only)');
if(summary.length<8)problems.push('summary: required (8+ chars)');
if(!sources.length)problems.push('sourceClaimIds: synthesis requires at least one valid source claim (plan §14)');
if(sources.length>32)problems.push('sourceClaimIds: exceeds 32');
if(new Set(sources).size!==sources.length)problems.push('sourceClaimIds: duplicates not allowed');
if(process.env.BAD_SYNTHESIS==='admit')problems.length=0;
if(process.env.BAD_SYNTHESIS==='shape')return console.log(JSON.stringify({ok:true,value:{ok:true}}));
console.log(JSON.stringify({ok:true,value:{ok:problems.length===0,problems,type,summary,sources}}));
});`;

test('synthesis native opt-in preserves lineage validation and rejects disagreement', {skip:process.platform==='win32'}, () => {
  const old=process.env.SINGULARITY_RUST_MEMORY_POLICY_BIN;
  const dir=mkdtempSync(join(tmpdir(),'synthesis-native-'));
  const bin=join(dir,'native-mock');writeFileSync(bin,fixture);chmodSync(bin,0o700);
  try {
    delete process.env.SINGULARITY_RUST_MEMORY_POLICY_BIN;
    const valid={type:'active_projects',summary:'Current work item',sourceClaimIds:['claim-a','claim-b']};
    const invalid={type:'active_projects',summary:'Too short',sourceClaimIds:['same','same']};
    const baseline=validateSynthesisSpec(valid);
    assert.equal(baseline.ok,true);
    assert.equal(validateSynthesisSpec(invalid).ok,false);
    process.env.SINGULARITY_RUST_MEMORY_POLICY_BIN=bin;
    assert.deepEqual(validateSynthesisSpec(valid),baseline);
    assert.equal(validateSynthesisSpec(invalid).ok,false);
    process.env.BAD_SYNTHESIS='admit';
    assert.throws(()=>validateSynthesisSpec(invalid),e=>e.code==='NATIVE_SYNTHESIS_MISMATCH');
    process.env.BAD_SYNTHESIS='shape';
    assert.throws(()=>validateSynthesisSpec(valid),e=>e.code==='INVALID_NATIVE_SYNTHESIS_RESPONSE');
    delete process.env.BAD_SYNTHESIS;
    assert.deepEqual(validateSynthesisSpec({}),{ok:false,
      problems:['type not in enum:  (plan §15 initial categories only)','summary: required (8+ chars)','sourceClaimIds: synthesis requires at least one valid source claim (plan §14)'],
      type:'',summary:'',sources:[]});
  } finally {
    delete process.env.BAD_SYNTHESIS;
    if(old===undefined)delete process.env.SINGULARITY_RUST_MEMORY_POLICY_BIN;
    else process.env.SINGULARITY_RUST_MEMORY_POLICY_BIN=old;
    rmSync(dir,{recursive:true,force:true});
  }
});
