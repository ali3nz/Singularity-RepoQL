import { test } from 'node:test';
import assert from 'node:assert/strict';
import { pathToFileURL } from 'node:url';
import { resolve } from 'node:path';
import { evaluateWorkerShadow } from '../adapter/worker-shadow.mjs';

const base = process.env.ORCHESTRA_REFERENCE_KIT;
if (!base) throw Error('Set ORCHESTRA_REFERENCE_KIT to the extracted original JS kit root');
const worker = await import(pathToFileURL(resolve(base, 'lib/worker-completion.mjs')).href);

test('prose-only completion cannot be approved', () => {
  const x = evaluateWorkerShadow('Done. All tests passed!',worker);
  assert.equal(x.primary.decision.allow,false);
  assert.equal(x.primary.decision.reason,'NO_COMPLETION_RECORD');
  assert.equal(x.shadow.status,'disabled');
});

test('missing Rust executable cannot alter JS gate', () => {
  const x = evaluateWorkerShadow('Done. All tests passed!',worker,{rustBinary:'/nonexistent/orchestra-observer'});
  assert.equal(x.primary.decision.allow,false);
  assert.equal(x.shadow.status,'unavailable');
});

test('failed criteria remain blocked when Rust is absent', () => {
  const record = {status:'complete',changedFiles:[],criteriaResults:[{criterionId:'required',pass:false}],
    tests:[],runtimeEvidence:[],deviations:[],knownIssues:[],rollbackPoint:'r'};
  const status = '```json\n' + JSON.stringify({workerCompletion:record}) + '\n```';
  const x = evaluateWorkerShadow([status],worker,{rustBinary:'/nonexistent/orchestra-observer'});
  assert.equal(x.primary.decision.reason,'FAILED_CRITERIA');
  assert.equal(x.primary.decision.allow,false);
});
