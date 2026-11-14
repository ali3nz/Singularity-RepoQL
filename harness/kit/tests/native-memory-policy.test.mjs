// Tests the production Node <-> Rust process boundary without pretending that
// a JavaScript fixture is a compiled Rust binary. Cargo and true differential
// validation are separate, mandatory Windows acceptance steps.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, chmodSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  NativeMemoryPolicyError, nativeLiveSourceOrder, nativeRejectedClaimIndex,
  nativeExactTombstoneIndex, nativeTemporalVerdict,
  requestNativeMemoryPolicy, nativeMemoryPolicyEnabled,
} from '../lib/native-memory-policy.mjs';
import { liveSourceOrder } from '../lib/repoql-client.mjs';
import { currentTruth, historicalTruth } from '../lib/memory-temporal.mjs';
import { claimIsRejected, evaluateTombstones } from '../lib/memory-tombstone.mjs';
import { budgetPayload, splitIntoByteParts, requireWithinBudget, PayloadTooLargeError } from '../lib/payload-budget.mjs';
import { linkedCaptureUnits } from '../../../memory/portable/task-recovery.mjs';
import { nativeLineageFilter, nativeCandidatePolicy, nativeBudgetPayload } from '../lib/native-memory-policy.mjs';
import { excludeInvalidFromCurrentRetrieval } from '../lib/memory-lineage.mjs';
import { precedenceRank, hasAnchoredProvenance, hasIndependentProvenance } from '../lib/memory-candidate-v2.mjs';
import { computeMemoryImpact } from '../lib/memory-impact.mjs';
import { createBuildContextPack } from '../lib/context-pack.mjs';

const original = process.env.SINGULARITY_RUST_MEMORY_POLICY_BIN;
function setBin(value) {
  if (value == null) delete process.env.SINGULARITY_RUST_MEMORY_POLICY_BIN;
  else process.env.SINGULARITY_RUST_MEMORY_POLICY_BIN = value;
}

// Executable test-only policy fixture. It deliberately has predictable
// results, NOT an independent Rust algorithm. Used to assert protocol,
// validation, disabled behavior and opt-in dispatch.
const fixture = `#!/usr/bin/env node
let s=''; process.stdin.setEncoding('utf8');
process.stdin.on('data', d => s+=d);
process.stdin.on('end', () => {
 const v=JSON.parse(s); const cmd=process.argv[2];
 if (process.env.MOCK_RUST_BEHAVIOR==='nonzero') { console.log(JSON.stringify({ok:false,code:'REJECTED'})); process.exit(2); }
 if (process.env.MOCK_RUST_BEHAVIOR==='malformed') { console.log('garbage'); return; }
 if (cmd==='rank') {
   const results=[...v.results].reverse();
   if (process.env.MOCK_RUST_BEHAVIOR==='duplicate' && results.length>1) results[0]=results[1];
   console.log(JSON.stringify({ok:true,results}));
 } else if (cmd==='temporal') console.log(JSON.stringify({ok:true,verdict:'NO_MATCH'}));
 else if (cmd==='payload-budget') {
   const cap=v.totalCap??24000, per=v.perFileCap??8000;
   let spent=0; const included=[], omitted=[], reasons=[];
   for(const f of v.files){const bytes=Buffer.byteLength(f.content,'utf8');
     if(bytes>per){omitted.push({name:f.name,bytes,reason:'per-file cap '+per+' exceeded'});reasons.push(f.name+': '+bytes+'B > per-file cap '+per+'B');}
     else if(spent+bytes>cap){omitted.push({name:f.name,bytes,reason:'total cap '+cap+' would be exceeded'});reasons.push(f.name+': would exceed total cap '+cap+'B');}
     else {spent+=bytes; included.push({name:f.name,bytes,sha256:require('node:crypto').createHash('sha256').update(f.content).digest('hex')});}
   }
   console.log(JSON.stringify({ok:omitted.length===0,totalBytes:spent,included,omitted,reasons}));
 } else if (cmd==='split-bytes') console.log(JSON.stringify({ok:true,parts:[v.text]}));
 else if (cmd==='task-links') console.log(JSON.stringify({ok:true,units:[{unitId:'oc:s1:1-2',sessionId:'s1',firstSeq:1,lastSeq:2,capturedAt:null}]}));
 else if (cmd==='lineage-filter') {
   const kept=[],excluded=[];
   for(const name of v.recordNames){const state=v.states[name];if(state==='invalid'||state==='stale')excluded.push({name,state});else kept.push(name);}
   console.log(JSON.stringify({ok:true,kept,excluded,historical:false}));
 } else if (cmd==='candidate-policy') console.log(JSON.stringify({ok:true,hasAnchoredProvenance:true,isDerivedProvenance:false,hasIndependentProvenance:true,precedenceRank:100}));
 else if (cmd==='memory-impact-files') console.log(JSON.stringify({ok:true,tokens:['harness'],impacted:[]}));
 else if (cmd==='tombstone-check' || cmd==='tombstone-claim') {
   const i=v.tombstones.findIndex(t=>t.rejectedClaim===v.claim);
   console.log(JSON.stringify({ok:true,blocked:i>=0,matchedIndex:i<0?null:i}));
 } else { console.log(JSON.stringify({ok:false,code:'UNKNOWN_COMMAND'})); process.exit(2); }
});
`;

// Run serially: env vars are process-global and the same modules are reused.
test('native memory runtime: default behavior, opt-in dispatch, strict failure', { skip: process.platform === 'win32' }, async () => {
  const dir = mkdtempSync(join(tmpdir(), 'singularity-rust-adapter-'));
  const bin = join(dir, 'fake-native-policy');
  writeFileSync(bin, fixture); chmodSync(bin, 0o700);
  const tombstones = [{status:'active', name:'OldValue', subject:'Renewal', field:'period',
    rejectedClaim:'30 days', scope:'concept:///knowledge/**'}];
  try {
    setBin(null);
    assert.equal(nativeMemoryPolicyEnabled(), false);
    const a = {uri:'local:///src/a.mjs', score:0.4, originalOnly:undefined};
    const b = {uri:'local:///src/b.mjs', score:0.9};
    assert.deepEqual(liveSourceOrder([a,b],'z'),[b,a]);
    assert.equal(currentTruth({capsuleBody:'---\nvalidTo: 2026-01-01T00:00:00Z\n---\n',now:new Date('2026-11-01')}),'NO_MATCH');
    assert.equal(claimIsRejected({claim:'14 days', tombstones}).blocked,false);
    assert.equal(claimIsRejected({claim:'30 days', tombstones}).blocked,true);
    setBin(bin);
    assert.equal(nativeMemoryPolicyEnabled(), true);
    assert.deepEqual(nativeLiveSourceOrder([a,b],'z'), [b,a]);
    assert.equal(liveSourceOrder([a,b], 'z')[1], a, 'returns original JS object, not JSON clone');
    assert.equal(nativeTemporalVerdict('current',{capsuleBody:'body',now:0}), 'NO_MATCH');
    assert.equal(currentTruth({capsuleBody:'body',now:new Date(0)}), 'NO_MATCH');
    assert.equal(historicalTruth({capsuleBody:'body',asOf:'2026-01-01'}),'NO_MATCH');
    assert.equal(nativeRejectedClaimIndex({claim:'30 days', tombstones}),0);
    assert.equal(nativeExactTombstoneIndex({subject:'Renewal',field:'period',claim:'14 days',tombstones}),null);
    assert.equal(evaluateTombstones({subject:'Renewal',field:'period',claim:'30 days',tombstones}).tombstone,tombstones[0]);
    assert.equal(claimIsRejected({claim:'30 days',tombstones}).tombstone,tombstones[0]);
    assert.equal(claimIsRejected({claim:'14 days',tombstones}).blocked,false);
    const budgetFiles=[{name:'one',content:'éé'},{name:'two',content:'abcd'}];
    assert.deepEqual(budgetPayload(budgetFiles,{totalCap:5,perFileCap:6}),
      nativeBudgetPayload(budgetFiles,{totalCap:5,perFileCap:6}));
    assert.equal(budgetPayload(budgetFiles,{totalCap:5,perFileCap:6}).ok,false);
    assert.throws(()=>requireWithinBudget(budgetFiles,{totalCap:5,perFileCap:6}),e=>e instanceof PayloadTooLargeError && e.manifest.omitted.length===1);
    assert.deepEqual(splitIntoByteParts('hi',3),['hi']);
    assert.throws(()=>splitIntoByteParts('abcd',3),e=>e.code==='INVALID_NATIVE_SPLIT_RESPONSE');
    const ledger={units:{'oc:s1:1-2':{task_id:'task-abcdef1234',task_id_source:'binding',agent:'agent-alpha',session_id:'s1',first_seq:1,last_seq:2,status:'reconciled'}}};
    assert.deepEqual(linkedCaptureUnits(ledger,'task-abcdef1234','agent-alpha'),
      [{unitId:'oc:s1:1-2',sessionId:'s1',firstSeq:1,lastSeq:2,capturedAt:null}]);
    assert.deepEqual(nativeLineageFilter(['a','b'],{a:'invalid',b:'known'}),
      {kept:['b'],excluded:[{name:'a',state:'invalid'}]});
    const cp=nativeCandidatePolicy({provenance:[{kind:'live-evidence',uri:'file:///a'}]});
    assert.equal(cp.precedenceRank,100);
    assert.equal(precedenceRank({provenance:[{kind:'live-evidence',uri:'file:///a'}]}),100);
    assert.equal(hasAnchoredProvenance({provenance:[{kind:'live-evidence',uri:'file:///a'}]}),true);
    assert.equal(hasIndependentProvenance({provenance:[{kind:'live-evidence',uri:'file:///a'}]}),true);
    assert.deepEqual(computeMemoryImpact({changedFiles:['harness/main.mjs'],knowledgeFiles:[]}),
      {tokens:['harness'],impacted:[]});
    process.env.MOCK_RUST_BEHAVIOR='duplicate';
    assert.throws(()=>nativeLiveSourceOrder([a,b]),e=>e.code==='INVALID_NATIVE_RANK_PERMUTATION');
    process.env.MOCK_RUST_BEHAVIOR='malformed';
    assert.throws(()=>requestNativeMemoryPolicy('temporal',{}),e=>e.code==='INVALID_NATIVE_RESPONSE');
    process.env.MOCK_RUST_BEHAVIOR='nonzero';
    assert.throws(()=>requestNativeMemoryPolicy('temporal',{}),e=>e.code==='NATIVE_POLICY_REJECTED');
    delete process.env.MOCK_RUST_BEHAVIOR;
    setBin(join(dir,'missing-exe'));
    assert.throws(()=>requestNativeMemoryPolicy('rank',{results:[]}),e=>e instanceof NativeMemoryPolicyError && e.code==='NATIVE_POLICY_UNAVAILABLE');
    const fakeRepoql={
      query:async()=>({ok:true,results:[{uri:'concept:///knowledge/Visible.md',score:.8}]}),
      get:async()=>({ok:true,content:'---\ncategory: knowledge\n---\nNative test content'}),
    };
    const builder=createBuildContextPack({repoql:fakeRepoql,repoqlPrimary:true});
    const context=await builder({stage:'PLAN',mandatory:{task:'required current source'},historicalQueries:['test']});
    assert.ok(context.pack.includes('required current source'), 'mandatory context survives native ranking failure');
    assert.ok(!context.pack.includes('Native test content'), 'unverified memory cannot enter the pack');
    assert.equal(context.manifest.nativeMemoryPolicy?.ok,false);
    assert.ok(context.manifest.omitted.some(o=>o.item==='repoql-ranking'));
    setBin('relative/native.exe');
    assert.throws(()=>requestNativeMemoryPolicy('rank',{results:[]}),e=>e.code==='INVALID_NATIVE_BINARY_PATH');
    setBin(bin);
    assert.throws(()=>requestNativeMemoryPolicy('rank',{results:[{blob:'x'.repeat(300_000)}]}),e=>e.code==='PAYLOAD_LIMIT_EXCEEDED');
    assert.throws(()=>requestNativeMemoryPolicy('fake-command',{}),e=>e.code==='UNSUPPORTED_COMMAND');
  } finally {
    setBin(original);
    delete process.env.MOCK_RUST_BEHAVIOR;
    rmSync(dir,{recursive:true,force:true});
  }
});
