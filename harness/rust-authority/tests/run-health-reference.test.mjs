import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {cases} from '../scripts/run-health-fixture-source.mjs';
const golden=JSON.parse(readFileSync(new URL('../fixtures/compat.json',import.meta.url),'utf8'));
const actual=golden.cases.filter(c=>c.request.op==='run_health.derive');
const expected=cases();
test('all Rust run-health golden cases reflect the current JavaScript implementation',()=>{
  assert.equal(actual.length,100);
  assert.deepEqual(actual,expected);
});
