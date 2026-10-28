import {test} from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
const data=JSON.parse(readFileSync(new URL('../fixtures/resource-lease.json',import.meta.url),'utf8'));
const byName=(name)=>data.scenarios.find(x=>x.name===name);
const outcomes=(name)=>byName(name).expected;
test('resource-lease golden corpus covers all safety decision paths',()=>{
 assert.equal(data.schema,'orchestra-resource-lease-v1');
 assert.equal(data.scenarios.length,7);
 assert.equal(data.scenarios.reduce((n,s)=>n+s.expected.length,0),38);
 for(const item of data.scenarios)assert.equal(item.operations.length,item.expected.length);
});
test('source reference never permits timeout-based takeover of a living owner',()=>{
 assert.equal(outcomes('live-foreign-expired')[0].reason,'owner-alive-heartbeat-stale');
 assert.equal(outcomes('dead-foreign-takeover')[1].lease.takeover,true);
 assert.equal(outcomes('basic')[6].reason,'held-by-other-case');
 assert.equal(outcomes('basic')[7].reason,'not-lease-owner');
 assert.equal(outcomes('invalid-store')[0].error,true);
});
