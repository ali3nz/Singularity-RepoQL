// Tests actual JavaScript call-site routing with a deterministic CLI fixture.
// This does NOT claim the fixture is a compiled Rust implementation.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync, chmodSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { validateLifecycleTransition, isTtlDue } from '../lib/memory-candidate-v2.mjs';

const script = `#!/usr/bin/env node
let text='';process.stdin.setEncoding('utf8');
process.stdin.on('data',d=>text+=d);
process.stdin.on('end',()=>{
const v=JSON.parse(text);const cmd=process.argv[2];
if(cmd==='candidate-transition'){
 if(v.toState==='VERIFIED'&&!v.verification){ console.log(JSON.stringify({ok:true,accepted:false,reason:'lifecycle: CANDIDATE->VERIFIED requires a verification anchor'}));return; }
 const status=v.toState.toLowerCase();
 const candidate={...v.candidate,maturityState:v.toState,status,verification:v.verification};
 console.log(JSON.stringify({ok:true,accepted:true,candidate}));
} else if(cmd==='candidate-ttl')console.log(JSON.stringify({ok:true,due:true,reason:'age 4d > ttl 3d'}));
else console.log(JSON.stringify({ok:false,code:'UNKNOWN_COMMAND'}));
});`;

test('candidate lifecycle and TTL use explicitly enabled native policy', { skip: process.platform === 'win32' }, () => {
  const root = mkdtempSync(join(tmpdir(),'singularity-candidate-native-'));
  const bin = join(root,'native-fixture');
  writeFileSync(bin,script);
  chmodSync(bin,0o700);
  const previous = process.env.SINGULARITY_RUST_MEMORY_POLICY_BIN;
  const candidate={id:'MC20001',claim:'real source',contentDigest:'abcd1234',caseId:'case-1',
    maturityState:'CANDIDATE',provenance:[{kind:'live-evidence',uri:'file:///a'}]};
  try {
    delete process.env.SINGULARITY_RUST_MEMORY_POLICY_BIN;
    const baseline=validateLifecycleTransition(candidate,'VERIFIED',{verification:'test receipt'});
    assert.equal(baseline.status,'verified');
    process.env.SINGULARITY_RUST_MEMORY_POLICY_BIN=bin;
    const result=validateLifecycleTransition(candidate,'VERIFIED',{verification:'test receipt'});
    assert.deepEqual(result,baseline);
    assert.deepEqual(isTtlDue({maturityState:'VERIFIED',ttlDays:3,verifiedAt:'2026-11-01T00:00:00Z'},
      {now:new Date('2026-11-05T00:00:00Z')}),{due:true,reason:'age 4d > ttl 3d'});
    assert.throws(()=>validateLifecycleTransition(candidate,'VERIFIED'),
      /requires a verification anchor/);
  } finally {
    if(previous===undefined) delete process.env.SINGULARITY_RUST_MEMORY_POLICY_BIN;
    else process.env.SINGULARITY_RUST_MEMORY_POLICY_BIN=previous;
    rmSync(root,{recursive:true,force:true});
  }
});
