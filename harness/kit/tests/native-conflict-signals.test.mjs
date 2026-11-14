import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, chmodSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  contradictionSignal, numericDivergenceSignal, extractInvariant,
  parseCapsule, evaluateCandidateConflict,
} from '../lib/concept-conflict-gate.mjs';
import { NativeMemoryPolicyError } from '../lib/native-memory-policy.mjs';

const executable = `#!/usr/bin/env node
const fs=require('node:fs');
const command=process.argv[2];
const arg=JSON.parse(fs.readFileSync(0,'utf8'));
const invalid=process.env.TEST_NATIVE_CONFLICT_INVALID;
let result;
if(command==='contradiction-signal'||command==='numeric-divergence') {
 result={ok:true,signal:invalid==='signal'?42:
   command==='contradiction-signal'?'native contradiction':'native numeric'};
} else if(command==='extract-invariant') result={ok:true,value:invalid==='invariant'?42:'native invariant'};
else if(command==='candidate-policy') result={ok:true,hasAnchoredProvenance:true,isDerivedProvenance:false,hasIndependentProvenance:true,precedenceRank:100};
else if(command==='parse-capsule') result={ok:true,value:invalid==='capsule'?{wrong:1}:
 {title:'native title',description:null,category:'rule',relevance:null,verification:null,ttl:14,verifiedDate:null}};
else result={ok:false,code:'UNKNOWN_COMMAND'};
console.log(JSON.stringify(result));
`;

test('conflict gate uses selected native values and fails closed on invalid native outputs',
  { skip: process.platform === 'win32' }, () => {
    const prev = process.env.SINGULARITY_RUST_MEMORY_POLICY_BIN;
    const dir = mkdtempSync(join(tmpdir(), 'singularity-conflict-rust-'));
    const bin = join(dir, 'conflict-native');
    writeFileSync(bin, executable);
    chmodSync(bin, 0o700);
    try {
      delete process.env.SINGULARITY_RUST_MEMORY_POLICY_BIN;
      assert.equal(contradictionSignal('policy required value','policy forbidden value'),
        'antonym required/forbidden on shared subject "policy"');
      assert.equal(numericDivergenceSignal('window 14 days','window 30 days'),
        'numeric divergence (14 vs 30)');
      assert.equal(extractInvariant('**Invariant**\nKeep evidence\n**Example**\nNext'),'Keep evidence');
      assert.equal(parseCapsule('---\ncategory: rule\n---\n# Note').category,'rule');
      process.env.SINGULARITY_RUST_MEMORY_POLICY_BIN = bin;
      assert.equal(contradictionSignal('x','y'),'native contradiction');
      assert.equal(numericDivergenceSignal('x','y'),'native numeric');
      assert.equal(extractInvariant('body'),'native invariant');
      assert.equal(parseCapsule('body').title,'native title');
      const result = evaluateCandidateConflict(
        { claim:'policy required value', provenance:[{ kind:'live-evidence', uri:'file:///src/new' }] },
        { matches:[{ uri:'concept:///rule/Prior.md', invariant:'policy forbidden value', category:'rule' }] },
      );
      assert.equal(result.requiresReview,true);
      assert.match(result.reason,/native contradiction/);
      process.env.TEST_NATIVE_CONFLICT_INVALID='signal';
      assert.throws(() => contradictionSignal('x','y'),e=>e instanceof NativeMemoryPolicyError && e.code==='INVALID_NATIVE_CONFLICT_SIGNAL');
      delete process.env.TEST_NATIVE_CONFLICT_INVALID;
      process.env.TEST_NATIVE_CONFLICT_INVALID='capsule';
      assert.throws(() => parseCapsule('body'),e=>e instanceof NativeMemoryPolicyError && e.code==='INVALID_NATIVE_CAPSULE');
      process.env.TEST_NATIVE_CONFLICT_INVALID='invariant';
      assert.throws(() => extractInvariant('body'),e=>e instanceof NativeMemoryPolicyError && e.code==='INVALID_NATIVE_INVARIANT');
      delete process.env.TEST_NATIVE_CONFLICT_INVALID;
      process.env.SINGULARITY_RUST_MEMORY_POLICY_BIN = join(dir,'missing');
      assert.throws(() => contradictionSignal('x','y'),e=>e instanceof NativeMemoryPolicyError && e.code==='NATIVE_POLICY_UNAVAILABLE');
    } finally {
      if (prev === undefined) delete process.env.SINGULARITY_RUST_MEMORY_POLICY_BIN;
      else process.env.SINGULARITY_RUST_MEMORY_POLICY_BIN = prev;
      delete process.env.TEST_NATIVE_CONFLICT_INVALID;
      rmSync(dir,{recursive:true,force:true});
    }
});
