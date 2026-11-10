import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync, mkdirSync, readFileSync, writeFileSync, existsSync, rmSync, symlinkSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join, dirname} from 'node:path';
import {createHash} from 'node:crypto';
import {execFileSync} from 'node:child_process';
import {recordDocumentationObligation, listDocumentationWork, resumeDocumentationWork, validateDocumentationDraft,
  runDocumentationTests, verifiedDocumentationTests, verifyDocumentationClosure, atomicWriteDocumentation} from '../scripts/doc-program.mjs';
import {ingestFile, searchDocs, verifyFile, documentationState} from '../scripts/doc-ingest-node.mjs';
import {documentHash} from '../scripts/doc-repoql.mjs';
import {loadAssessment, evaluateAssessment} from '../scripts/doc-policy.mjs';
import {currentReviewerProfileHash, REVIEWER_NAME} from '../native/windows/openmausbot/maintenance_review.mjs';

const hash = value => createHash('sha256').update(value).digest('hex');
const windowsOnly = {skip: process.platform !== 'win32'};

function fixture(t) {
  const root = mkdtempSync(join(tmpdir(), 'singularity-doc-program-'));
  mkdirSync(join(root, 'src'));
  mkdirSync(join(root, 'tests'));
  writeFileSync(join(root, 'src/feature.mjs'), 'export const enabled = true;\n');
  writeFileSync(join(root, 'tests/feature.test.mjs'), "import test from 'node:test';\ntest('verified feature fixture',()=>{});\n");
  const memory = join(root, 'test-memory.json');
  writeFileSync(memory, JSON.stringify({gatewayKey: 'fixture-only', serviceId: 'fixture', userKey: 'fixture'}));
  const env = {...process.env, MEMORY_SECRETS: memory, SINGULARITY_DOC_DATA: join(root, 'data', 'index'),
    KNOWLEDGE_INDEX_BASE_URL: 'http://127.0.0.1:1', SINGULARITY_SELFLEARN_LLM_URL: 'http://127.0.0.1:1/v1',
    SINGULARITY_SELFLEARN_LLM_MODEL: 'fixture', SELFLEARN_INLINE: '0'};
  const state = {records: [], outage: false, repoqlOutage: false, modelCalls: 0, action: null};
  const fetchImpl = async (url, request) => {
    if (state.outage) throw new Error('controlled MemoryCore outage');
    const body = JSON.parse(request.body);
    let payload;
    if (String(url).endsWith('/conversation/add')) {
      state.records.push(...body.messages.map(message => ({content: message.content, task_id: body.task_id})));
      payload = {code: 0, data: {}};
    } else {
      const messages = state.records.filter(record => record.content.toLowerCase().includes(String(body.query).toLowerCase()));
      payload = {code: 0, data: {messages}};
    }
    return new Response(JSON.stringify(payload), {status: 200});
  };
  const ingest = (file, options) => ingestFile(file, {...options, fetchImpl});
  const search = (query, options) => searchDocs(query, {...options, fetchImpl});
  const repoql = async ({document}) => state.repoqlOutage ? {status: 'DOC_BLOCKED', reason: 'controlled RepoQL outage'} :
    {status: 'REPOQL_VERIFIED', sourceSha256: documentHash(readFileSync(join(root, document), 'utf8'))};
  const reviewer = async request => ({status: 'approved', approved: true, traceVerified: true, reviewer: REVIEWER_NAME,
    nonce: request.nonce, beforeHash: request.beforeHash, afterHash: request.afterHash, diffHash: request.diffHash,
    reviewerProfileSha256: currentReviewerProfileHash()});
  const modelCall = async ({prompt}) => {
    state.modelCalls++;
    const evidence = JSON.parse(prompt.split('\n').at(-1));
    const action = state.action || (evidence.authority ? 'UPDATE' : 'CREATE');
    return JSON.stringify({schema: 'singularity.doc-draft/v1', operation: {action, path: evidence.target,
      oldText: state.oldText || evidence.authority?.text,
      claims: evidence.sources.map(source => ({statement: `The current ${source.path} exports an enabled flag.`,
        source: source.path, quote: readFileSync(join(root, source.path), 'utf8').trim()}))}});
  };
  const work = recordDocumentationObligation({root, session: 'fixture', files: ['src/feature.mjs']});
  const options = {root, env, work, ingest, search, repoql, reviewer, modelCall};
  t.after(() => rmSync(root, {recursive: true, force: true}));
  return {root, env, state, work, options, ingest, search, repoql};
}

test('A and O automatically create a source-backed document, verify it and derive closure', windowsOnly, async t => {
  const f = fixture(t);
  const result = await resumeDocumentationWork(f.options);
  assert.equal(result.status, 'DOC_FULLY_VERIFIED', result.reason);
  const work = listDocumentationWork(f.root, 'fixture')[0];
  assert.equal(work.operation.action, 'CREATE');
  assert.equal(work.ingestion.status, 'DOC_INGEST_INDEXED');
  assert.equal(verifyFile(work.operation.path, {root: f.root, env: f.env}).status, 'DOC_INGEST_VERIFIED');
  const proof = await verifyDocumentationClosure({...f.options, session: 'fixture'});
  assert.equal(proof.status, 'DOC_FULLY_VERIFIED', proof.reason);
  const assessment = loadAssessment('fixture', f.root);
  assessment.captureStatus = 'NO_LESSON';
  assessment.captureReason = 'Controlled fixture establishes no reusable lesson.';
  const evidence = {[work.operation.path]: verifyFile(work.operation.path, {root: f.root, env: f.env}), __documentationWork: proof};
  assert.equal(evaluateAssessment(assessment, {evidence}).some(finding => /documentation closure independently unverified/.test(finding)), false);
  const rewritten = {...assessment};
  delete rewritten.docWork;
  assert.match(evaluateAssessment(rewritten).join(' '), /independently unverified/);
  assert.equal(evaluateAssessment(rewritten, {evidence}).some(finding => /independently unverified/.test(finding)), false);
  writeFileSync(join(f.root, work.operation.path), '# Concurrent user edit\n');
  assert.equal((await verifyDocumentationClosure({...f.options, session: 'fixture'})).status, 'DOC_BLOCKED');
});

test('B updates the existing authority and retains its previous revision', windowsOnly, async t => {
  const f = fixture(t);
  mkdirSync(join(f.root, 'docs/runbooks'), {recursive: true});
  const path = 'docs/runbooks/existing.md';
  writeFileSync(join(f.root, path), '# Existing authority\n\nsrc/feature.mjs currently has older guidance.\n\nWarning. Preserve deployment backups.\n');
  f.state.oldText = 'src/feature.mjs currently has older guidance.';
  await f.ingest(join(f.root, path), {root: f.root, env: f.env});
  const oldRevision = verifyFile(path, {root: f.root, env: f.env}).revision;
  const result = await resumeDocumentationWork(f.options);
  assert.equal(result.status, 'DOC_FULLY_VERIFIED', result.reason);
  const work = listDocumentationWork(f.root, 'fixture')[0];
  assert.equal(work.operation.path, path);
  assert.equal(work.operation.action, 'UPDATE');
  assert.match(readFileSync(join(f.root, path), 'utf8'), /Warning\. Preserve deployment backups\./);
  assert.notEqual(verifyFile(path, {root: f.root, env: f.env}).revision, oldRevision);
  const current = await f.search('feature', {root: f.root, env: f.env});
  assert.equal(current.some(item => item.revision === oldRevision), false);
});

test('D refuses unverified changes without calling the drafting model', async t => {
  const f = fixture(t);
  writeFileSync(join(f.root, 'tests/feature.test.mjs'), "import test from 'node:test';test('failure',()=>{throw new Error('controlled failure')});");
  const result = await resumeDocumentationWork(f.options);
  assert.equal(result.status, 'DOC_BLOCKED');
  assert.equal(f.state.modelCalls, 0);
  assert.equal(existsSync(join(f.root, 'docs/runbooks/feature.md')), false);
});

test('L and M retain a committed write across outages and resume without redrafting', windowsOnly, async t => {
  const f = fixture(t);
  f.state.outage = true;
  let result = await resumeDocumentationWork(f.options);
  assert.equal(result.status, 'DOC_BLOCKED');
  assert.equal(result.phase, 'WRITTEN');
  f.state.outage = false;
  f.state.repoqlOutage = true;
  result = await resumeDocumentationWork({...f.options, work: null});
  assert.equal(result.status, 'DOC_BLOCKED');
  f.state.repoqlOutage = false;
  result = await resumeDocumentationWork({...f.options, work: null});
  assert.equal(result.status, 'DOC_FULLY_VERIFIED', result.reason);
  assert.equal(f.state.modelCalls, 1);
});

test('a committed but unverified obligation cannot be silently superseded', windowsOnly, async t => {
  const f = fixture(t);
  f.state.outage = true;
  await resumeDocumentationWork(f.options);
  writeFileSync(join(f.root, 'src/feature.mjs'), 'export const enabled = false;\n');
  recordDocumentationObligation({root: f.root, session: 'successor', files: ['src/feature.mjs']});
  const original = listDocumentationWork(f.root, 'fixture')[0];
  assert.equal(original.phase, 'WRITTEN');
  assert.notEqual(original.status, 'DOC_SUPERSEDED');
});

test('test receipts bind the real invocation, sources, test files and output', t => {
  const f = fixture(t);
  f.work.testRun = runDocumentationTests({root: f.root, work: f.work, testFiles: ['tests/feature.test.mjs'], env: f.env});
  const run = JSON.parse(readFileSync(join(f.root, 'data/doc-policy', f.work.testRun.receipt), 'utf8'));
  assert.equal(run.status, 'PASSED', readFileSync(join(f.root, 'data/doc-policy', run.output), 'utf8'));
  assert.equal(verifiedDocumentationTests(f.root, f.work).status, 'PASSED');
  writeFileSync(join(f.root, 'tests/feature.test.mjs'), '// changed after test run\n');
  assert.throws(() => verifiedDocumentationTests(f.root, f.work), /BINDING_INVALID/);
  assert.throws(() => runDocumentationTests({root: f.root, work: f.work, testFiles: ['../outside.mjs']}));
  assert.throws(() => runDocumentationTests({root: f.root, work: f.work, testFiles: ['tests/feature.test.mjs'],
    env: {...f.env, SINGULARITY_INTERNAL_DOC_REVIEW: '1'}}), /INTERNAL_REVIEW/);
});

test('MERGE, SUPERSEDE and ARCHIVE require exact anchors and preserve retained files', t => {
  const f = fixture(t);
  mkdirSync(join(f.root, 'docs'));
  const path = 'docs/existing.md';
  const before = '# Existing\n\nOld guidance.\n';
  const source = f.work.sources[0];
  const evidence = {target: path, authority: {path, text: before}, sources: [source], tests: []};
  for (const action of ['MERGE', 'SUPERSEDE', 'ARCHIVE']) {
    writeFileSync(join(f.root, path), before);
    const operation = {action, path, oldText: 'Old guidance.', claims: [{statement: 'The feature exports a flag.',
      source: source.path, quote: 'export const enabled = true;'}]};
    const raw = JSON.stringify({schema: 'singularity.doc-draft/v1', operation});
    const result = validateDocumentationDraft(raw, evidence, f.root);
    assert.ok(result.after.startsWith(action === 'MERGE' ? '# Existing' : '---'));
    assert.equal(documentationState(result.after), action === 'ARCHIVE' ? 'archived' : action === 'SUPERSEDE' ? 'superseded' : 'active');
    assert.throws(() => validateDocumentationDraft(JSON.stringify({schema: 'singularity.doc-draft/v1',
      operation: {...operation, oldText: 'missing anchor'}}), evidence, f.root), /ANCHOR_AMBIGUOUS/);
  }
});

test('archived guidance is retained for history and excluded from default retrieval', async t => {
  const f = fixture(t);
  mkdirSync(join(f.root, 'docs'));
  const document = 'docs/archived.md';
  writeFileSync(join(f.root, document), '---\ndocument_state: archived\n---\n# Archived feature\n\nRetained instructions.\n');
  assert.equal((await f.ingest(join(f.root, document), {root: f.root, env: f.env})).status, 'DOC_INGEST_INDEXED');
  assert.equal((await f.search('Archived', {root: f.root, env: f.env})).length, 0);
  const historical = await f.search('Archived', {root: f.root, env: f.env, stale: true});
  assert.equal(historical[0].historical, true);
  assert.equal(historical[0].currentGuidance, false);
});

test('native UTF-8 replacement enforces hash preconditions and supports retry', windowsOnly, t => {
  const f = fixture(t);
  const operation = {path: 'docs/runbooks/unicode.md', beforeHash: null, after: '# Runbook\n\nMāori — café 日本語.\n'};
  operation.afterHash = hash(operation.after);
  const receipt = atomicWriteDocumentation(f.root, f.work, operation);
  assert.equal(receipt.status, 'WRITTEN');
  assert.equal(readFileSync(join(f.root, operation.path), 'utf8'), operation.after);
  assert.equal(atomicWriteDocumentation(f.root, f.work, operation, 'verify').status, 'WRITTEN');
  writeFileSync(join(f.root, operation.path), '# Concurrent change\n');
  assert.throws(() => atomicWriteDocumentation(f.root, f.work, operation), /HASH_CONFLICT|RECOVERY_BINDING_MISMATCH/);
});

test('native writer refuses protected and reparse targets', windowsOnly, t => {
  const f = fixture(t);
  const operation = {path: 'docs/SECURITY.md', beforeHash: null, after: '# Protected\n', afterHash: hash('# Protected\n')};
  assert.throws(() => atomicWriteDocumentation(f.root, f.work, operation), /PATH_REFUSED/);
  const outside = mkdtempSync(join(tmpdir(), 'singularity-doc-outside-'));
  t.after(() => rmSync(outside, {recursive: true, force: true}));
  mkdirSync(join(f.root, 'docs'));
  symlinkSync(outside, join(f.root, 'docs/runbooks'), 'junction');
  assert.throws(() => atomicWriteDocumentation(f.root, f.work, {...operation, path: 'docs/runbooks/outside.md'}), /REPARSE/);
});

test('owned busy journals are refused and a depleted pass retains its obligation', async t => {
  const f = fixture(t);
  const lock = join(f.root, 'data/doc-policy', f.work.id + '.json.lock');
  mkdirSync(lock);
  const busy = await resumeDocumentationWork(f.options);
  assert.equal(busy.reason, 'DOC_WORK_BUSY');
  rmSync(lock, {recursive: true});
  const depleted = await resumeDocumentationWork({...f.options, budgetMs: 0});
  assert.equal(depleted.status, 'DOC_BLOCKED');
  assert.equal(f.state.modelCalls, 0);
  assert.notEqual(listDocumentationWork(f.root, 'fixture')[0].status, 'DOC_FULLY_VERIFIED');
});

test('C a verified formatting-only outcome preserves the document and remote record count', windowsOnly, async t => {
  const f = fixture(t);
  const created = await resumeDocumentationWork(f.options);
  assert.equal(created.status, 'DOC_FULLY_VERIFIED', created.reason);
  const initial = listDocumentationWork(f.root, 'fixture')[0];
  const document = readFileSync(join(f.root, initial.operation.path), 'utf8');
  const recordCount = f.state.records.length;
  writeFileSync(join(f.root, 'src/feature.mjs'), 'export const enabled    = true;\n');
  const work = recordDocumentationObligation({root: f.root, session: 'formatting', files: ['src/feature.mjs']});
  f.state.action = 'NO_CHANGE';
  const result = await resumeDocumentationWork({...f.options, work});
  assert.equal(result.status, 'DOC_FULLY_VERIFIED', result.reason);
  assert.equal(readFileSync(join(f.root, initial.operation.path), 'utf8'), document);
  assert.equal(f.state.records.length, recordCount);
  const proof = await verifyDocumentationClosure({...f.options, session: 'formatting'});
  assert.equal(proof.status, 'DOC_FULLY_VERIFIED', proof.reason);
  assert.equal(proof.docStatus, 'DOC_NOT_REQUIRED');
  assert.deepEqual(proof.sourceFiles, ['src/feature.mjs']);
  const assessment = {...loadAssessment('formatting', f.root), files: ['src/feature.mjs'],
    captureStatus: 'NO_LESSON', captureReason: 'Formatting-only fixture introduces no reusable lesson.'};
  assert.deepEqual(evaluateAssessment(assessment, {evidence: {__documentationWork: proof}}), []);
});

test('scoped source diff exposes a functional edit beyond the bounded source excerpt', windowsOnly, async t => {
  const f = fixture(t);
  const prefix = '// Existing source context.\n'.repeat(300);
  writeFileSync(join(f.root, 'src/feature.mjs'), prefix + 'export const enabled = true;\n');
  execFileSync('git', ['init', '--quiet'], {cwd: f.root, windowsHide: true});
  execFileSync('git', ['add', '--', 'src/feature.mjs'], {cwd: f.root, windowsHide: true});
  writeFileSync(join(f.root, 'src/feature.mjs'), prefix + 'export const enabled = false;\n');
  const work = recordDocumentationObligation({root: f.root, session: 'fixture', files: ['src/feature.mjs']});
  let evidence;
  const modelCall = async ({prompt}) => {
    evidence = JSON.parse(prompt.split('\n').at(-1));
    throw new Error('FIXTURE_EVIDENCE_CAPTURED');
  };
  const result = await resumeDocumentationWork({...f.options, work, modelCall});
  assert.equal(result.status, 'DOC_BLOCKED');
  assert.match(result.reason, /FIXTURE_EVIDENCE_CAPTURED/);
  assert.equal(evidence.changes.observable, true);
  assert.match(evidence.changes.diff, /src\/feature\.mjs/);
  assert.match(evidence.changes.diff, /\+export const enabled = false;/);
  assert.equal(evidence.sources[0].excerpt.includes('enabled = false'), false);
  assert.equal(existsSync(join(f.root, 'docs/feature.md')), false);
});


test('same-session completed revisions flatten aliases without discarding proof artifacts', windowsOnly, async t => {
  const f = fixture(t);
  assert.equal((await resumeDocumentationWork(f.options)).status, 'DOC_FULLY_VERIFIED');
  const original = listDocumentationWork(f.root, 'fixture').find(work => work.id === f.work.id);
  const retained = {testRun: original.testRun, request: original.request, review: original.review,
    completedChunks: original.completedChunks};
  let latest = original;
  for (let revision = 1; revision <= 20; revision++) {
    writeFileSync(join(f.root, 'src/feature.mjs'), 'export const enabled = true;\nexport const revision = ' + revision + ';\n');
    const successor = recordDocumentationObligation({root: f.root, session: 'fixture', files: ['src/feature.mjs']});
    assert.equal((await verifyDocumentationClosure({...f.options, session: 'fixture'})).status, 'DOC_BLOCKED');
    const result = await resumeDocumentationWork({...f.options, work: successor});
    assert.equal(result.status, 'DOC_FULLY_VERIFIED', result.reason);
    latest = listDocumentationWork(f.root, 'fixture').find(work => work.id === successor.id);
    const history = listDocumentationWork(f.root, 'fixture');
    for (const previous of history.filter(work => work.id !== latest.id)) {
      assert.equal(previous.status, 'DOC_SUPERSEDED');
      assert.equal(previous.supersededBy, latest.id);
    }
    assert.equal(loadAssessment('fixture', f.root).docWork.id, latest.id);
    const proof = await verifyDocumentationClosure({...f.options, session: 'fixture'});
    assert.equal(proof.status, 'DOC_FULLY_VERIFIED', proof.reason);
  }
  const historical = listDocumentationWork(f.root, 'fixture').find(work => work.id === original.id);
  assert.deepEqual({testRun: historical.testRun, request: historical.request, review: historical.review,
    completedChunks: historical.completedChunks}, retained);
});

test('returning to superseded source bytes creates a fresh stable generation', windowsOnly, async t => {
  const f = fixture(t);
  const initial = readFileSync(join(f.root, 'src/feature.mjs'), 'utf8');
  assert.equal((await resumeDocumentationWork(f.options)).status, 'DOC_FULLY_VERIFIED');
  writeFileSync(join(f.root, 'src/feature.mjs'), 'export const enabled = false;\n');
  const changed = recordDocumentationObligation({root: f.root, session: 'fixture', files: ['src/feature.mjs']});
  assert.equal((await resumeDocumentationWork({...f.options, work: changed})).status, 'DOC_FULLY_VERIFIED');
  writeFileSync(join(f.root, 'src/feature.mjs'), initial);
  const restored = recordDocumentationObligation({root: f.root, session: 'fixture', files: ['src/feature.mjs']});
  assert.notEqual(restored.id, f.work.id);
  assert.equal(restored.status, 'DOC_BLOCKED');
  assert.equal(recordDocumentationObligation({root: f.root, session: 'fixture', files: ['src/feature.mjs']}).id, restored.id);
  assert.equal((await verifyDocumentationClosure({...f.options, session: 'fixture'})).status, 'DOC_BLOCKED');
  const calls = f.state.modelCalls;
  const result = await resumeDocumentationWork({...f.options, work: restored});
  assert.equal(result.status, 'DOC_FULLY_VERIFIED', result.reason);
  assert.equal(f.state.modelCalls, calls + 1);
  const proof = await verifyDocumentationClosure({...f.options, session: 'fixture'});
  assert.equal(proof.status, 'DOC_FULLY_VERIFIED', proof.reason);
});

test('same-file sessions retain their own completed proofs', windowsOnly, async t => {
  const f = fixture(t);
  assert.equal((await resumeDocumentationWork(f.options)).status, 'DOC_FULLY_VERIFIED');
  f.state.action = 'NO_CHANGE';
  const other = recordDocumentationObligation({root: f.root, session: 'other-session', files: ['src/feature.mjs']});
  const result = await resumeDocumentationWork({...f.options, work: other});
  assert.equal(result.status, 'DOC_FULLY_VERIFIED', result.reason);
  assert.equal(listDocumentationWork(f.root, 'fixture')[0].status, 'DOC_FULLY_VERIFIED');
  for (const session of ['fixture', 'other-session']) {
    const proof = await verifyDocumentationClosure({...f.options, session});
    assert.equal(proof.status, 'DOC_FULLY_VERIFIED', proof.reason);
  }
});

test('cross-session supersession cannot borrow an independently complete proof', windowsOnly, async t => {
  const f = fixture(t);
  assert.equal((await resumeDocumentationWork(f.options)).status, 'DOC_FULLY_VERIFIED');
  f.state.action = 'NO_CHANGE';
  const other = recordDocumentationObligation({root: f.root, session: 'other-session', files: ['src/feature.mjs']});
  assert.equal((await resumeDocumentationWork({...f.options, work: other})).status, 'DOC_FULLY_VERIFIED');
  const original = listDocumentationWork(f.root, 'fixture')[0];
  original.status = 'DOC_SUPERSEDED'; original.phase = 'SUPERSEDED'; original.supersededBy = other.id;
  writeFileSync(join(f.root, 'data/doc-policy', original.id + '.json'), JSON.stringify(original));
  const proof = await verifyDocumentationClosure({...f.options, session: 'fixture'});
  assert.equal(proof.status, 'DOC_BLOCKED');
  assert.match(proof.reason, /DOC_SUPERSESSION_SCOPE_INVALID/);
});

test('same-session written work stays blocking until a covering successor is independently verified', windowsOnly, async t => {
  const f = fixture(t);
  f.state.outage = true;
  assert.equal((await resumeDocumentationWork(f.options)).status, 'DOC_BLOCKED');
  const original = listDocumentationWork(f.root, 'fixture')[0];
  assert.equal(original.phase, 'WRITTEN');
  writeFileSync(join(f.root, 'src/feature.mjs'), 'export const enabled = false;\n');
  const successor = recordDocumentationObligation({root: f.root, session: 'fixture', files: ['src/feature.mjs']});
  assert.notEqual(listDocumentationWork(f.root, 'fixture').find(work => work.id === original.id).status, 'DOC_SUPERSEDED');
  assert.equal((await verifyDocumentationClosure({...f.options, session: 'fixture'})).status, 'DOC_BLOCKED');
  f.state.outage = false;
  const result = await resumeDocumentationWork({...f.options, work: successor});
  assert.equal(result.status, 'DOC_FULLY_VERIFIED', result.reason);
  const historical = listDocumentationWork(f.root, 'fixture').find(work => work.id === original.id);
  assert.equal(historical.status, 'DOC_SUPERSEDED');
  assert.equal(historical.supersededBy, successor.id);
  assert.deepEqual(historical.testRun, original.testRun);
  assert.deepEqual(historical.review, original.review);
  const proof = await verifyDocumentationClosure({...f.options, session: 'fixture'});
  assert.equal(proof.status, 'DOC_FULLY_VERIFIED', proof.reason);
});

test('supersession still rejects a forged chain longer than sixteen hops', windowsOnly, async t => {
  const f = fixture(t);
  assert.equal((await resumeDocumentationWork(f.options)).status, 'DOC_FULLY_VERIFIED');
  const original = listDocumentationWork(f.root, 'fixture')[0];
  let next = original.id;
  for (let index = 0; index < 17; index++) {
    const id = 'doc-' + hash('forged-hop-' + index).slice(0, 24);
    const alias = {...original, id, status: 'DOC_SUPERSEDED', phase: 'SUPERSEDED', supersededBy: next};
    writeFileSync(join(f.root, 'data/doc-policy', id + '.json'), JSON.stringify(alias));
    next = id;
  }
  const proof = await verifyDocumentationClosure({...f.options, session: 'fixture'});
  assert.equal(proof.status, 'DOC_BLOCKED');
  assert.match(proof.reason, /DOC_SUPERSESSION_CHAIN_INVALID/);
});
