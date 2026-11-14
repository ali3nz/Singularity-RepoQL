import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, chmodSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { classifyDocImpact, renderDocImpactReport } from '../lib/doc-impact.mjs';

const program = `#!/usr/bin/env node
const fs=require('node:fs');
const cmd=process.argv[2];
const input=JSON.parse(fs.readFileSync(0,'utf8'));
if(process.env.TEST_RUST_DOC_MISMATCH) {console.log(JSON.stringify({wrong:true})); process.exit(0);}
if(cmd==='doc-impact-stdin') {
 const entries=[],unmapped=[];
 for(const item of input.changedFiles) {
  const path=(typeof item==='string'?item:item.path).replace(/^work\\/ai-orchestration\\//,'');
  if(path==='config.json')entries.push({path,docs:['documentation/ai-orchestration.md'],disposition:'review-required'});
  else unmapped.push(path);
 }
 console.log(JSON.stringify({entries,unmapped}));
} else if(cmd==='doc-render-stdin') {
 const x=input.classification;
 const lines=['## Source-to-doc impact classification'];
 for(const e of x.entries)lines.push('- '+e.path+' -> '+e.docs.join(', ')+' ['+e.disposition+']');
 if(x.unmapped.length)lines.push('- UNMAPPED (unclassified, NOT no-impact — human classification required): '+x.unmapped.join(', '));
 if(!x.entries.length&&!x.unmapped.length)lines.push('- (no changed files classified)');
 console.log(JSON.stringify({report:lines.join('\\n')}));
} else {process.exit(2)}
`;

test('documentation classifier may use exact native results but never trusts mismatches',
  {skip:process.platform==='win32'}, () => {
    const original=process.env.SINGULARITY_RUST_EVIDENCE_POLICY_BIN;
    const dir=mkdtempSync(join(tmpdir(),'singularity-native-doc-'));
    const bin=join(dir,'rust-doc-evidence');
    writeFileSync(bin,program); chmodSync(bin,0o700);
    try {
      delete process.env.SINGULARITY_RUST_EVIDENCE_POLICY_BIN;
      const ref=classifyDocImpact(['config.json','unknown.mjs']);
      assert.equal(ref.entries[0].path,'config.json');
      assert.deepEqual(ref.unmapped,['unknown.mjs']);
      const expected=renderDocImpactReport(ref);
      process.env.SINGULARITY_RUST_EVIDENCE_POLICY_BIN=bin;
      assert.deepEqual(classifyDocImpact(['config.json','unknown.mjs']),ref);
      assert.equal(renderDocImpactReport(ref),expected);
      process.env.TEST_RUST_DOC_MISMATCH='1';
      assert.throws(()=>classifyDocImpact(['config.json']),/RUST_DOC_POLICY_REFERENCE_MISMATCH/);
      assert.throws(()=>renderDocImpactReport(ref),/RUST_DOC_POLICY_REFERENCE_MISMATCH/);
      delete process.env.TEST_RUST_DOC_MISMATCH;
      process.env.SINGULARITY_RUST_EVIDENCE_POLICY_BIN=join(dir,'missing');
      assert.throws(()=>classifyDocImpact(['config.json']),/RUST_DOC_POLICY_EXECUTION_FAILED/);
    } finally {
      if(original===undefined) delete process.env.SINGULARITY_RUST_EVIDENCE_POLICY_BIN;
      else process.env.SINGULARITY_RUST_EVIDENCE_POLICY_BIN=original;
      delete process.env.TEST_RUST_DOC_MISMATCH;
      rmSync(dir,{recursive:true,force:true});
    }
});
