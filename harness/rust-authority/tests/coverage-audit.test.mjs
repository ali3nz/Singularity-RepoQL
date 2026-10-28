import {test} from 'node:test';
import assert from 'node:assert/strict';
import {getCoverage} from '../scripts/migration-coverage.mjs';
test('migration inventory stays grounded and never reports Rust parity without execution',()=>{
 const coverage=getCoverage();
 assert.equal(coverage.recordedSourceModules,186);
 assert.equal(coverage.rustCandidateSourceModules,16);
 assert.equal(coverage.sourceModulesWithoutCandidate,170);
 assert.equal(coverage.nativeVerifiedModules,0);
 assert.equal(coverage.parityExecuted,0);
 assert.ok(coverage.candidateModules.every(x=>!x.verified));
 assert.ok(coverage.keyBlockingSurfaces.some(x=>x.includes('orchestrate.mjs')));
});
