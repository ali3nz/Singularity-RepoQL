import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,mkdirSync,writeFileSync,existsSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {writeNativeCliFixture} from './native_cli_fixture.mjs';
import {DELEGATED_ROLES,validateDelegatedMap} from './claude_complete_memory_profiles.mjs';
import {reconcileDocuments,SCHEMA} from './claude_complete_doc_reconciliation.mjs';
import {repoqlDocumentUri} from './claude_complete_doc_parity.mjs';

const ENV='SINGULARITY_RUST_MEMORY_POLICY_BIN';
function withNative(response,task,marker=null){
  const dir=mkdtempSync(join(tmpdir(),'singularity-native-acceptance-'));
  const bin=writeNativeCliFixture(join(dir,'fake-native'),`#!/usr/bin/env node\n${marker===null?'':`require('node:fs').writeFileSync(${JSON.stringify(marker)},'spawned');\n`}process.stdout.write(${JSON.stringify(JSON.stringify(response))});\n`);
  const previous=process.env[ENV];process.env[ENV]=bin;
  const cleanup=()=>{if(previous===undefined)delete process.env[ENV];else process.env[ENV]=previous;rmSync(dir,{recursive:true,force:true});};
  try {
    const result=task();
    if (result && typeof result.finally==='function') return result.finally(cleanup);
    cleanup();return result;
  } catch (error) {cleanup();throw error;}
}
function map(){return Object.fromEntries(DELEGATED_ROLES.map(name=>[name,{team_id:'team',user_id:'test',agent_id:name}]));}

test('delegated identity chooses checked Rust result and refuses forged approval',()=>{
  const expected={delegatedRoles:5,mainRolesExcluded:4,identityMapValidated:true};
  // serde_json object keys are usually alphabetical; property insertion order
  // must not influence the parity decision.
  const reordered={identityMapValidated:true,mainRolesExcluded:4,delegatedRoles:5};
  assert.deepEqual(withNative({ok:true,value:reordered},()=>validateDelegatedMap(map())),expected);
  assert.throws(()=>withNative({ok:true,value:{...expected,identityMapValidated:false}},()=>validateDelegatedMap(map())),/NATIVE_DELEGATED_IDENTITY_DIVERGENCE/);
  assert.throws(()=>withNative({ok:true,value:{...expected,ghostExcluded:true}},()=>validateDelegatedMap(map())),/NATIVE_DELEGATED_IDENTITY_DIVERGENCE/);
  assert.throws(()=>withNative({ok:false,code:'ERROR'},()=>validateDelegatedMap(map())),/NATIVE_POLICY_REJECTED/);
});

test('invalid delegated identity is rejected by the original authority before Rust',()=>{
  const invalid=map();invalid.board=invalid.thinker;
  assert.throws(()=>withNative({ok:true,value:{delegatedRoles:5,mainRolesExcluded:4,identityMapValidated:true}},()=>validateDelegatedMap(invalid)),/DELEGATED_IDENTITY_COLLISION/);
});

test('retired identities are rejected before native contact',()=>{
  const dir=mkdtempSync(join(tmpdir(),'singularity-retired-native-'));
  const marker=join(dir,'spawned');
  try {
    for (const [field,value] of [['team_id','ghost-companion'],['agent_id','Ghost']]) {
      const invalid=map();invalid.board[field]=value;
      assert.throws(()=>withNative({ok:true,value:{delegatedRoles:5,mainRolesExcluded:4,identityMapValidated:true}},
        ()=>validateDelegatedMap(invalid),marker),/RETIRED_MEMORY_SCOPE_FORBIDDEN/);
      assert.equal(existsSync(marker),false);
    }
    withNative({ok:true,value:{delegatedRoles:5,mainRolesExcluded:4,identityMapValidated:true}},()=>validateDelegatedMap(map()),marker);
    assert.equal(existsSync(marker),true);
  } finally {rmSync(dir,{recursive:true,force:true});}
});

function docFixture(){
  const root=mkdtempSync(join(tmpdir(),'singularity-reconcile-'));
  mkdirSync(join(root,'docs'));
  const marker='DOCPARITY-TEST-ABCDEF123456';
  writeFileSync(join(root,'docs','test.md'),`# Test\n\n${marker}\n\nThe test content must be stable for parity.\n`);
  return {root,manifest:{schema:SCHEMA,documents:[{file:'docs/test.md',marker}]}};
}

test('documentation reconciliation returns checked native action and blocks forged action',async()=>{
  const {root,manifest}=docFixture();
  const args={root,manifest,parityCheck:async()=>({issues:['REPOQL_READ_FAILED'],exactTestRevisionVerified:false})};
  try{
    const result=await withNative({ok:true,action:'INVESTIGATE_REPOQL_INDEX_AND_READBACK'},()=>reconcileDocuments(args));
    assert.equal(result.documents[0].operatorNextAction,'INVESTIGATE_REPOQL_INDEX_AND_READBACK');
    await assert.rejects(withNative({ok:true,action:'NONE'},()=>reconcileDocuments(args)),/NATIVE_DOC_RECONCILIATION_DIVERGENCE/);
  } finally {rmSync(root,{recursive:true,force:true});}
});

test('RepoQL source URI uses checked Rust encoding and refuses forged path selection',()=>{
  const doc={relative:'docs/space and ☃/note (1).md'};
  const correct='file:///docs/space%20and%20%E2%98%83/note%20(1).md';
  assert.equal(withNative({ok:true,uri:correct},()=>repoqlDocumentUri(doc)),correct);
  assert.throws(()=>withNative({ok:true,uri:'file:///different.md'},()=>repoqlDocumentUri(doc)),/NATIVE_REPOQL_URI_DIVERGENCE/);
  assert.throws(()=>withNative({ok:true,uri:correct},()=>repoqlDocumentUri({relative:'../secret.md'})),/REPOQL_RELATIVE_DOCUMENT_URI_INVALID/);
});
