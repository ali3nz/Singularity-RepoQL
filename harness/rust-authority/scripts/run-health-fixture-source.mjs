// Deterministic input matrix for the new Rust run-health compat operation.
// Expected results must be derived from the current JavaScript source.
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { deriveRunHealth } from '../../kit/lib/run-health.mjs';

export const FIXED_AT = '2026-11-12T00:00:00.000Z';
export function scenarios() {
  const retrieval = [undefined, 'healthy', 'degraded', 'unreachable', 'failed', null];
  const worker = [undefined, 'active', 'waiting_external', 'waiting_gate', 'expired', 'stalled', null];
  const gate = [undefined, 'accepted', 'blocked', 'pending', 'not_required'];
  const learning = [undefined, 'captured', 'pending', 'failed', null];
  const github = [undefined, 'synced', 'pending', 'failed', null];
  const out = [];
  for (let i=0; i<100; i++) {
    const st = {
      runId: `run-${String(i).padStart(3,'0')}`,
      retrievalNotes: retrieval[i%retrieval.length],
      runState: i%9===0 ? 'COMPLETED' : (i%4===0 ? 'RUNNING' : undefined),
      workerLeaseState: worker[(i*3)%worker.length],
      gateState: gate[(i*3)%gate.length],
      gatePending: i%4===1,
      criteriaResults: i%7===0 ? [{id:'check',ok:false}] : [{id:'check',ok:true}],
      evidenceComplete: i%3===0,
      githubIssue: i%11===0 ? 123 : null,
      githubStatus: github[(i*2)%github.length],
      learningStatus: learning[(i*3)%learning.length],
      journalOutcomeAt: i%6===0 ? '2026-11-11T18:00:00Z' : null,
      memory: i%11===0 ? {stagedRefs:'legacy-text'} : (i%5===0 ? {stagedRefs:['concept']} : (i%5===1 ? {staging:true} : {})),
    };
    const evidenceManifest = i%4===0 ? {entries:[{sha256:'aabbcc'}]}
      : i%4===1 ? {entries:[{sha256:'aabbcc'},{sha256:''}]}
      : i%4===2 ? {entries:[]} : null;
    const lease = i%6===0 ? {state:'waiting_external'} : (i%6===1 ? {state:'expired'} : null);
    const ghStatus = i%8===0 ? 'not_required' : null;
    const runId = i%10===0 ? `explicit-${i}` : null;
    out.push({state:st,lease,ghStatus,runId,evidenceManifest});
  }
  return out;
}
export function referenceFor(input) {
  const folder = mkdtempSync(join(tmpdir(),'run-health-oracle-'));
  const env = process.env.SINGULARITY_RUST_COMPAT_BIN;
  try {
    delete process.env.SINGULARITY_RUST_COMPAT_BIN;
    if (input.evidenceManifest !== null) writeFileSync(join(folder,'evidence-manifest.json'),JSON.stringify(input.evidenceManifest));
    const ref = deriveRunHealth({state:input.state,lease:input.lease,ghStatus:input.ghStatus,runId:input.runId,runDir:folder});
    return {...ref,generatedAt:FIXED_AT};
  } finally {
    if (env !== undefined) process.env.SINGULARITY_RUST_COMPAT_BIN=env;
    rmSync(folder,{recursive:true,force:true});
  }
}
export function cases() {
  return scenarios().map(inputs=>{
    const wire=JSON.parse(JSON.stringify({...inputs,generatedAt:FIXED_AT}));
    return {request:{op:'run_health.derive',inputs:wire},expected:referenceFor(wire)};
  });
}
