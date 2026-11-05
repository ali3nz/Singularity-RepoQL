import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
const fixture=JSON.parse(readFileSync(new URL('../fixtures/final-compat.json',import.meta.url),'utf8'));
test('new source oracle covers phase-timeout and nanny observations',()=>{
 assert.equal(fixture.cases.length,205);
 assert.equal(fixture.cases.filter(x=>x.request.op==='nanny.observe').length,87);
 assert.equal(fixture.cases.filter(x=>x.request.op==='phase_driver.evaluate').length,101);
});
test('oracle includes critical nanny operator-halt and stale-resume cases',()=>{
 const a=fixture.cases.filter(x=>x.request.op==='nanny.observe');
 assert.ok(a.some(x=>x.request.halted && x.request.state?.runState==='RUNNING' && x.expected.actionable===null));
 assert.ok(a.some(x=>x.request.state?.runState==='RUNNING' && x.request.coordinatorState==='DEAD' && x.expected.actionable?.kind==='RESUME'));
 assert.ok(a.some(x=>x.request.state?.runState==='NEEDS_HUMAN_REVIEW' && x.request.staleEvidence===true && x.expected.actionable?.kind==='RE_DRIVE_HOLD'));
});
test('phase driver oracle rejects stalled, dead, and ceiling cases',()=>{
 const a=fixture.cases.filter(x=>x.request.op==='phase_driver.evaluate');
 assert.ok(a.some(x=>x.expected.reason?.includes('stalled driver')));
 assert.ok(a.some(x=>x.expected.reason?.includes('not alive')));
 assert.ok(a.some(x=>x.expected.reason?.includes('ceiling')));
});
