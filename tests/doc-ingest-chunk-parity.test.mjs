// Native Windows Node can validate the Python chunk contract without Python.
import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {fileURLToPath} from 'node:url';
import {chunkMarkdown} from '../scripts/doc-ingest-node.mjs';
const golden=JSON.parse(readFileSync(fileURLToPath(new URL('./fixtures/doc-ingest/wave19-chunk-golden.json',import.meta.url)),'utf8'));
test('Node Windows documentation chunks match Python Unicode/long-line golden cases',()=>{
  assert.equal(golden.schema,'singularity-doc-index-chunk-golden/v1');
  assert.ok(golden.cases.length>=70);
  for(const entry of golden.cases){
    const parts=chunkMarkdown(entry.input,{SINGULARITY_DOC_RUST_BIN:''});
    assert.deepEqual(parts,entry.chunks,entry.name);
    assert.ok(parts.every(chunk=>Array.from(chunk).length<=7000),entry.name);
  }
});
