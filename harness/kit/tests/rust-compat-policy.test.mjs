import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, chmodSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { buildRunSummary } from '../lib/run-summary.mjs';
import { deriveRunHealth } from '../lib/run-health.mjs';
import { completionGateDecision } from '../lib/worker-completion.mjs';
import { parseGate } from '../lib/gate-parser.mjs';
import { verifiedRustCompat, RustCompatPolicyError } from '../lib/rust-compat-policy.mjs';

const dir = mkdtempSync(join(tmpdir(), 'rust-compat-policy-'));
const bin = join(dir, 'native-compat-mock');
writeFileSync(bin, `#!/usr/bin/env node
const {readFileSync} = require('node:fs');
const request = JSON.parse(readFileSync(0, 'utf8'));
if (request.op !== process.env.MOCK_OP) process.exit(7);
if (process.env.MOCK_FAILURE === 'exit') process.exit(8);
if (process.env.MOCK_FAILURE === 'invalid') { process.stdout.write('broken'); process.exit(0); }
let reply=JSON.parse(process.env.MOCK_REPLY ?? 'null');
if (process.env.MOCK_DYNAMIC_TS === '1' && request.op === 'run_health.derive') reply.generatedAt = request.inputs.generatedAt;
process.stdout.write(JSON.stringify(reply));
`);
chmodSync(bin, 0o755);
const old = Object.fromEntries(['SINGULARITY_RUST_COMPAT_BIN','MOCK_OP','MOCK_REPLY','MOCK_FAILURE','MOCK_DYNAMIC_TS'].map(k => [k,process.env[k]]));
process.on('exit', () => rmSync(dir, {recursive:true, force:true}));
function restore() {
  for (const [k,v] of Object.entries(old)) if (v === undefined) delete process.env[k]; else process.env[k] = v;
}
function use(op, reply) {
  process.env.SINGULARITY_RUST_COMPAT_BIN=bin;
  process.env.MOCK_OP=op;
  process.env.MOCK_REPLY=JSON.stringify(reply);
  delete process.env.MOCK_FAILURE;
  delete process.env.MOCK_DYNAMIC_TS;
}

// A native Windows build uses the actual Rust binary in the differential suite;
// the shebang stub below is intentionally only a Linux transport test.
const transport = process.platform === 'win32' ? test.skip : test;

transport('accepted run summary is native only on exact output agreement', () => {
  restore();
  const fixed={runNumber:41,title:'Bound task history',date:'2026-11-12',memoryRefs:['concept:///rule/History.md']};
  const expected=buildRunSummary(fixed);
  use('run_summary.build',expected);
  assert.equal(buildRunSummary(fixed),expected);
  process.env.MOCK_REPLY=JSON.stringify(expected+' UNVERIFIED');
  assert.throws(()=>buildRunSummary(fixed), e=>e instanceof RustCompatPolicyError && e.code==='NATIVE_REFERENCE_MISMATCH');
  restore();
});

transport('health projection accepts the native result only when all fields agree', () => {
  restore();
  const state={runId:'case-041', runState:'COMPLETED', retrievalNotes:'degraded', gateState:'accepted', evidenceComplete:true, githubIssue:41, memory:{stagedRefs:['doc']}};
  // Derive once to get a fixed time; the clock changes on the second call,
  // so this test exercises the native result directly with the fixed witness.
  const expected=deriveRunHealth({state});
  use('run_health.derive',expected);
  process.env.MOCK_DYNAMIC_TS='1';
  const actual = deriveRunHealth({state});
  assert.equal(actual.worker,'complete');
  assert.equal(actual.retrieval,'degraded');
  assert.equal(actual.generatedAt.length,24);
  process.env.MOCK_REPLY=JSON.stringify({...expected,gate:'blocked'});
  assert.throws(()=>verifiedRustCompat('run_health.derive',{inputs:{state, generatedAt:expected.generatedAt}},expected), e=>e.code==='NATIVE_REFERENCE_MISMATCH');
  restore();
});

transport('worker completion gate never accepts a forged approved native result', () => {
  restore();
  const input={found:true,completion:{status:'complete',criteriaResults:[{criterionId:'build',pass:false}],knownIssues:[]},problems:[]};
  const expected=completionGateDecision(input);
  assert.equal(expected.reason,'FAILED_CRITERIA');
  use('worker.decision',expected);
  assert.deepEqual(completionGateDecision(input),expected);
  process.env.MOCK_REPLY=JSON.stringify({allow:true,reason:'OK'});
  assert.throws(()=>completionGateDecision(input),e=>e.code==='NATIVE_REFERENCE_MISMATCH');
  restore();
});

transport('V2 gate parsing uses Rust only on exact verdict and signoff parity', () => {
  restore();
  const payload=JSON.stringify({schema:'orchestration-gate-v2',stage:'plan',verdict:'APPROVED',risk:'LOW',planSignoff:'APPROVED',plan:[{step:'compile'}]});
  const expected=parseGate(payload,'plan');
  use('gate.parse',expected);
  assert.deepEqual(parseGate(payload,'plan'),expected);
  process.env.MOCK_REPLY=JSON.stringify({...expected,gate:{...expected.gate,verdict:'BLOCKED'}});
  assert.throws(()=>parseGate(payload,'plan'),e=>e.code==='NATIVE_REFERENCE_MISMATCH');
  restore();
});

transport('legacy gate fallback keeps its existing source contract',()=>{
  restore();
  use('gate.parse',{error:'should not be invoked'});
  const legacy=parseGate('VERDICT: CONFIRMED','plan');
  assert.equal(legacy.compatibilityMode,true);
  assert.equal(legacy.verdict,'APPROVED');
  restore();
});

transport('bad executable paths, invalid output and failed processes block without fallback', () => {
  restore();
  process.env.SINGULARITY_RUST_COMPAT_BIN='relative-unsafe-bin';
  assert.throws(()=>verifiedRustCompat('worker.decision',{extraction:{}},{allow:false}),e=>e.code==='INVALID_BINARY_PATH');
  use('worker.decision',{allow:false});
  process.env.MOCK_FAILURE='invalid';
  assert.throws(()=>verifiedRustCompat('worker.decision',{extraction:{}},{allow:false}),e=>e.code==='INVALID_NATIVE_RESPONSE');
  process.env.MOCK_FAILURE='exit';
  assert.throws(()=>verifiedRustCompat('worker.decision',{extraction:{}},{allow:false}),e=>e.code==='NATIVE_REJECTED');
  delete process.env.MOCK_FAILURE;
  assert.throws(()=>verifiedRustCompat('unsupported',{extraction:{}},{}),e=>e.code==='UNSUPPORTED_OPERATION');
  restore();
});

transport('binary absence leaves reference behavior unchanged', () => {
  restore();
  delete process.env.SINGULARITY_RUST_COMPAT_BIN;
  assert.deepEqual(verifiedRustCompat('worker.decision',{extraction:{}},{allow:false,reason:'REFERENCE'}),{allow:false,reason:'REFERENCE'});
  restore();
});
