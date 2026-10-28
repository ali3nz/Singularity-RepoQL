// Explicitly captures a deliberate safety divergence from the ORIGINAL source.
// This is JS source behavior evidence, NOT proof that the Rust code passes.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
const kit = process.env.ORCHESTRA_REFERENCE_KIT;
if (!kit) throw Error('ORCHESTRA_REFERENCE_KIT is required');
const caseStore = await import(pathToFileURL(resolve(kit, 'lib/case-store.mjs')).href);
const {EngineState} = await import(pathToFileURL(resolve(kit, 'lib/engine-state.mjs')).href);
const isolated = fn => {
  const root=mkdtempSync(join(tmpdir(),'orchestra-state-cutover-reference-'));
  try { return fn(root); } finally { rmSync(root,{force:true,recursive:true}); }
};
test('legacy case writer overwrites malformed case JSON when expected rev is zero; native must refuse',()=>isolated(root=>{
  const file=join(root,'case.json');
  writeFileSync(file,'{broken');
  const outcome=caseStore.writeCase(root,0,()=>({phase:'restarted'}));
  assert.equal(outcome.ok,true);
  assert.equal(JSON.parse(readFileSync(file,'utf8')).phase,'restarted');
}));
test('legacy engine-state mutation replaces malformed JSON with defaults; native must refuse',()=>isolated(root=>{
  const file=join(root,'engine-state.json');
  writeFileSync(file,'{broken');
  const es=new EngineState(root);
  es.markSuccess('worker');
  assert.equal(es.get('worker').state,'available');
  assert.notEqual(readFileSync(file,'utf8'),'{broken');
}));
