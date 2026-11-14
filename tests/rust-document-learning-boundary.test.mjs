import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,rmSync,readdirSync} from 'node:fs';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {writeNativeCliFixture} from '../native/windows/native_cli_fixture.mjs';
import {classifyFiles,isDocsOnlyChange,parseDocRootEntries} from '../scripts/doc-policy.mjs';
import {candidateId,validateLesson,discoverCandidate} from '../scripts/selflearn-candidates.mjs';

const ENV='SINGULARITY_RUST_MEMORY_POLICY_BIN';
function withNative(response, operation) {
  const dir=mkdtempSync(join(tmpdir(),'singularity-doc-rust-'));
  const binary=writeNativeCliFixture(join(dir,'fake-native'),'#!/usr/bin/env node\nprocess.stdout.write('+JSON.stringify(JSON.stringify(response))+');\n');
  const previous=process.env[ENV];process.env[ENV]=binary;
  try {return operation();}
  finally {
    if(previous===undefined)delete process.env[ENV];else process.env[ENV]=previous;
    rmSync(dir,{recursive:true,force:true});
  }
}

test('classified changes come from Rust only after exact reference comparison',()=>{
  const files=['scripts/logic.mjs','docs/README.md','data/selflearn/pending/x.js'];
  const expected=classifyFiles(files);
  const accepted={ok:true,...expected,docsOnly:false};
  assert.deepEqual(withNative(accepted,()=>classifyFiles(files)),expected);
  assert.throws(()=>withNative({ok:true,material:[],skipped:files,docsOnly:true},()=>classifyFiles(files)),/NATIVE_DOC_POLICY_DIVERGENCE/);
  assert.throws(()=>withNative({ok:false,code:'FAIL'},()=>classifyFiles(files)),/NATIVE_POLICY_REJECTED/);
});

test('documentation-only and Windows root splitting never accept forged results',()=>{
  assert.equal(withNative({ok:true,material:[],skipped:['docs/x.md'],docsOnly:true},
    ()=>isDocsOnlyChange(['docs/x.md'])),true);
  assert.throws(()=>withNative({ok:true,material:[],skipped:[],docsOnly:true},
    ()=>isDocsOnlyChange(['src/main.rs'])),/NATIVE_DOC_POLICY_DIVERGENCE/);
  assert.deepEqual(withNative({ok:true,roots:['C:\\work','D:\\docs']},
    ()=>parseDocRootEntries('C:\\work;D:\\docs','win32')),['C:\\work','D:\\docs']);
  assert.throws(()=>withNative({ok:true,roots:['C','\\work','D','\\docs']},
    ()=>parseDocRootEntries('C:\\work;D:\\docs','win32')),/NATIVE_DOC_ROOTS_DIVERGENCE/);
});

test('self-learning ID is stable and forged Rust identity cannot create a new record',()=>{
  const session='test-session', files=['docs/one.md','src/🧠.rs','docs/one.md'];
  const id=candidateId(session,files);
  assert.equal(withNative({ok:true,id},()=>candidateId(session,files)),id);
  assert.throws(()=>withNative({ok:true,id:'deadbeef'},()=>candidateId(session,files)),/NATIVE_SELFLEARN_ID_DIVERGENCE/);
  assert.throws(()=>withNative({ok:false,code:'INVALID'},()=>candidateId(session,files)),/NATIVE_POLICY_REJECTED/);
});

test('model-generated lesson validation cannot be promoted using a forged Rust verdict',()=>{
  const lesson={schema:'selflearn.lesson.v1',title:'  Verify memory  ',
    lesson:'  Anchor every lesson to source evidence.  ',category:'testing',
    generalizable:true,confidence:'high',needsVerification:false,
    evidenceRefs:['docs/test.md','docs/test.md'],duplicateOf:null};
  // Import is static to preserve the same instance of the source module.
  const expected=validateLesson(lesson,{allowedRefs:['docs/test.md']});
  assert.equal(expected.ok,true);
  assert.deepEqual(withNative({ok:true,value:expected},()=>validateLesson(lesson,{allowedRefs:['docs/test.md']})),expected);
  assert.throws(()=>withNative({ok:true,value:{ok:true,lesson:{...expected.lesson,evidenceRefs:['foreign.md']}}},
    ()=>validateLesson(lesson,{allowedRefs:['docs/test.md']})),/NATIVE_LESSON_VALIDATION_DIVERGENCE/);
  const invalid={...lesson,evidenceRefs:['unverified.md']};
  const reference=validateLesson(invalid,{allowedRefs:['docs/test.md']});
  assert.equal(reference.ok,false);
  assert.deepEqual(withNative({ok:true,value:reference},()=>validateLesson(invalid,{allowedRefs:['docs/test.md']})),reference);
  assert.throws(()=>withNative({ok:true,value:{ok:true,lesson:expected.lesson}},
    ()=>validateLesson(invalid,{allowedRefs:['docs/test.md']})),/NATIVE_LESSON_VALIDATION_DIVERGENCE/);
});


test('a forged Rust candidate ID cannot create a durable self-learning record',()=>{
  const root=mkdtempSync(join(tmpdir(),'singularity-candidate-block-'));
  try {
    assert.throws(()=>withNative({ok:true,id:'00000000'},()=>discoverCandidate({
      session:'session-123',files:['src/feature.rs'],root
    })),/NATIVE_SELFLEARN_ID_DIVERGENCE/);
    assert.deepEqual(readdirSync(root),[]);
  } finally {rmSync(root,{recursive:true,force:true});}
});
