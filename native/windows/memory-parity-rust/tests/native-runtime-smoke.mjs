// Actual compiled-Rust integration smoke test, to run only on the onsite host.
// This exercises ordinary JS call sites with Rust enabled. The differential
// fixtures independently compare reference JS against Rust without this flag.
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { dirname, resolve } from 'node:path';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../../../..');
const rust = process.env.SINGULARITY_RUST_MEMORY_POLICY_BIN;
assert.ok(rust, 'SINGULARITY_RUST_MEMORY_POLICY_BIN must point to the actual built Rust executable');
const { liveSourceOrder } = await import(pathToFileURL(resolve(root,'harness/kit/lib/repoql-client.mjs')).href);
const { currentTruth, historicalTruth } = await import(pathToFileURL(resolve(root,'harness/kit/lib/memory-temporal.mjs')).href);
const { claimIsRejected, evaluateTombstones } = await import(pathToFileURL(resolve(root,'harness/kit/lib/memory-tombstone.mjs')).href);
const { budgetPayload, splitIntoByteParts } = await import(pathToFileURL(resolve(root,'harness/kit/lib/payload-budget.mjs')).href);
const { linkedCaptureUnits } = await import(pathToFileURL(resolve(root,'memory/portable/task-recovery.mjs')).href);
const { excludeInvalidFromCurrentRetrieval } = await import(pathToFileURL(resolve(root,'harness/kit/lib/memory-lineage.mjs')).href);
const { hasAnchoredProvenance, hasIndependentProvenance } = await import(pathToFileURL(resolve(root,'harness/kit/lib/memory-candidate-v2.mjs')).href);
const { computeMemoryImpact } = await import(pathToFileURL(resolve(root,'harness/kit/lib/memory-impact.mjs')).href);

const dir=mkdtempSync(join(tmpdir(),'singularity-rust-runtime-'));
try {
  const canonical={uri:'local:///src/config.mjs',score:0.1};
  const backup={uri:'local:///src/config.mjs.bak',score:0.9};
  assert.equal(liveSourceOrder([backup,canonical],'src/config.mjs')[0],canonical);
  assert.equal(currentTruth({capsuleBody:'---\nvalidTo: 2026-01-01T00:00:00Z\n---\n',now:new Date('2026-11-12')}),'NO_MATCH');
  assert.equal(historicalTruth({capsuleBody:'---\nvalidFrom: 2026-01-01T00:00:00Z\n---\n',asOf:'2026-02-01T00:00:00Z'}),'MATCH');
  const t=[{status:'active',subject:'Renewal',field:'period',rejectedClaim:'30 days',scope:'concept:///knowledge/**'}];
  assert.equal(claimIsRejected({claim:'30 days',scope:'concept:///knowledge/Renewal.md',tombstones:t}).blocked,true);
  assert.equal(claimIsRejected({claim:'14 days',scope:'concept:///knowledge/Renewal.md',tombstones:t}).blocked,false);
  assert.equal(evaluateTombstones({subject:'Renewal',field:'period',claim:'30 days',scope:'concept:///knowledge/Renewal.md',tombstones:t}).blocked,true);
  assert.equal(budgetPayload([{name:'first',content:'abc'},{name:'second',content:'éé'}],{totalCap:5,perFileCap:6}).ok,false);
  assert.equal(budgetPayload([{name:'first',content:'abc'}],{totalCap:5,perFileCap:6}).ok,true);
  assert.equal(splitIntoByteParts('é🎉é\nhello',6).join(''),'é🎉é\nhello');
  const ledger={units:{'oc:s1:1-2':{task_id:'task-abcdef1234',task_id_source:'binding',agent:'alpha',session_id:'s1',first_seq:1,last_seq:2,status:'reconciled'}}};
  assert.equal(linkedCaptureUnits(ledger,'task-abcdef1234','alpha').length,1);
  writeFileSync(join(dir,'bad.json'),JSON.stringify({recordId:'bad',lineageState:'stale'}));
  assert.deepEqual(excludeInvalidFromCurrentRetrieval(['bad','missing'],dir),{kept:['missing'],excluded:[{name:'bad',state:'stale'}]});
  const cp={provenance:[{kind:'live-evidence',uri:'file:///proof'}]};
  assert.equal(hasAnchoredProvenance(cp),true);
  assert.equal(hasIndependentProvenance(cp),true);
  const doc=join(dir,'memory.md');writeFileSync(doc,'harness context pack');
  assert.equal(computeMemoryImpact({changedFiles:['harness/kit/lib/context-pack.mjs'],knowledgeFiles:[doc]}).impacted.length,1);
  console.log('RUST_NATIVE_MEMORY_RUNTIME_SMOKE_PASSED');
} finally {rmSync(dir,{recursive:true,force:true});}
