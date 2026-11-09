import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdirSync, writeFileSync, readFileSync, readdirSync, existsSync, rmSync, symlinkSync, lstatSync} from 'node:fs';
import {join, dirname, basename} from 'node:path';
import {fileURLToPath} from 'node:url';
import {EventEmitter} from 'node:events';
import {spawnSync} from 'node:child_process';
import {PassThrough} from 'node:stream';
import {createHash} from 'node:crypto';
import {createRepairFixtureHarness, detect, repair, runCli} from './maintenance_repair.mjs';
import {REVIEW_RECEIPT_SCHEMA, REVIEWER_NAME, buildReviewRequest, buildReviewerPrompt,
        parseReviewerTrace, readCanonicalReviewerProfile, reviewCandidate, reviewMatchesRequest,
        MAINTENANCE_REVIEW_REQUIREMENT, MAINTENANCE_REPAIR_SCOPE} from './maintenance_review.mjs';

// The owned installer treats any byte that differs from its own template as a
// user-modified (foreign) file, so the drift fixture must use the real template.
const TEMPLATE = readFileSync(join(dirname(fileURLToPath(import.meta.url)), 'AGENTS.md'), 'utf8');
const sha = (bytes) => createHash('sha256').update(bytes).digest('hex');

function reviewContextFixture(defect, files) {
  const sorted = [...files].sort((a, b) => a.path.localeCompare(b.path));
  const rules = sorted.find(({path}) => path === 'bots/AGENTS.md');
  const missing = defect === 'OMB_SHARED_RULES_MISSING';
  return {requirement: MAINTENANCE_REVIEW_REQUIREMENT, scope: MAINTENANCE_REPAIR_SCOPE,
    evidence: {defect, detectorState: missing ? 'absent' : 'matching',
      causeCode: missing ? 'RULES_FILE_ABSENT' : 'RULES_RECEIPT_INVALID',
      rootCause: missing ? 'The receipt-owned bots/AGENTS.md rules file is absent.' : 'The ownership receipt failed verification.',
      desiredTemplateSha256: sha(rules.after),
      beforeImages: sorted.map(({path, before}) => ({path, present: before !== null,
        sha256: before === null ? null : sha(Buffer.from(before))}))},
    checks: {detectionStatus: 'FAILED_EXPECTED', detectionResult: 'Observed fixture defect.',
      planRulesStatus: 'PASSED', preApplyTests: 'NOT_RUN', postApplyVerification: 'NOT_RUN'}};
}

function sandbox({withRules = false, rules = 'owned rules\n', withReceipt = false} = {}) {
  const fixture = createRepairFixtureHarness();
  const {root, dataDir, home, workspace} = fixture;
  mkdirSync(join(dataDir, 'bots'), {recursive: true});
  if (withRules) writeFileSync(join(dataDir, 'bots', 'AGENTS.md'), rules);
  if (withReceipt) writeFileSync(join(dataDir, 'bots', '.singularity-openmausbot-rules.json'), JSON.stringify({schema: 1, target: join(dataDir, 'bots', 'AGENTS.md'), sha256: 'stale'}));
  return fixture;
}

const paths = (s) => ({home: s.home, dataDir: s.dataDir, workspace: s.workspace});
const rules = (s) => join(s.dataDir, 'bots', 'AGENTS.md');
const reports = (s) => {
  const dir = join(s.home, 'reports', 'maintenance');
  return existsSync(dir) ? readdirSync(dir).filter((f) => f.endsWith('.md')) : [];
};
const reportText = (s) => {
  const files = reports(s);
  return files.length ? readFileSync(join(s.home, 'reports', 'maintenance', files[0]), 'utf8') : '';
};
const outbox = (s) => {
  const f = join(s.home, 'reports', 'maintenance', '.outbox.json');
  return existsSync(f) ? JSON.parse(readFileSync(f, 'utf8')) : {schema: 1, pending: {}};
};
const ledger = (s) => {
  const f = join(s.home, 'reports', 'maintenance', '.ledger.json');
  return existsSync(f) ? JSON.parse(readFileSync(f, 'utf8')) : {schema: 1, fixes: {}};
};

function reviewerTrace(prompt, {receipt = {}, omitAgent = false, final = 'dispatcher finished'} = {}) {
  const marker = 'REQUEST_JSON=';
  const payloadStart = prompt.lastIndexOf(marker) + marker.length;
  const request = JSON.parse(prompt.slice(payloadStart));
  const callId = 'review-call-1';
  const result = {
    schema: REVIEW_RECEIPT_SCHEMA,
    nonce: request.nonce,
    reviewer: REVIEWER_NAME,
    reviewerProfileSha256: request.reviewerProfileSha256,
    beforeHash: request.beforeHash,
    afterHash: request.afterHash,
    diffHash: request.diffHash,
    decision: 'APPROVE',
    findings: [],
    ...receipt,
  };
  const events = [];
  if (!omitAgent) {
    events.push({type: 'assistant', message: {content: [{type: 'tool_use', id: callId, name: 'Agent',
      input: {subagent_type: REVIEWER_NAME, prompt}}]}});
    events.push({type: 'user', message: {content: [{type: 'tool_result', tool_use_id: callId,
      content: JSON.stringify(result)}]}});
  }
  events.push({type: 'result', subtype: 'success', is_error: false, result: final});
  return events.map((event) => JSON.stringify(event)).join('\n') + '\n';
}

function fakeReviewSpawn({receipt = {}, omitAgent = false, beforeRespond = null, audit = []} = {}) {
  return (command, args, options) => {
    const call = {command, args: [...args], shell: options.shell, windowsHide: options.windowsHide,
      cwd: options.cwd, inheritedEnvironment: options.env === process.env};
    audit.push(call);
    const child = new EventEmitter();
    child.stdout = new PassThrough();
    child.stderr = new PassThrough();
    child.stdin = new PassThrough();
    child.killed = false;
    child.kill = () => { child.killed = true; child.stdout.end(); child.stderr.end(); setImmediate(() => child.emit('close', 1)); };
    let input = '';
    child.stdin.on('data', (chunk) => { input += chunk.toString(); });
    child.stdin.on('finish', () => {
      const promptMarker = 'AGENT_PROMPT_JSON=';
      const prompt = JSON.parse(input.slice(input.lastIndexOf(promptMarker) + promptMarker.length).trim());
      call.input = input;
      call.reviewerPrompt = prompt;
      beforeRespond?.(prompt);
      const trace = reviewerTrace(prompt, {receipt, omitAgent});
      child.stdout.end(trace);
      child.stderr.end();
      setImmediate(() => child.emit('close', 0));
    });
    return child;
  };
}

function fixtureReviewOptions(options = {}) {
  return {platform: 'win32', claudeExe: process.execPath, spawnImpl: fakeReviewSpawn(options)};
}

function repairFixture(fixture, opts = {}) {
  const deps = {...(opts.deps ?? {})};
  if (!deps.reviewOptions) deps.reviewOptions = fixtureReviewOptions();
  const {deps: _deps, ...rest} = opts;
  return fixture.repair({...rest, deps});
}

function reviewFixture() {
  const files = [{path: 'bots/AGENTS.md', before: null, after: Buffer.from('exact rules\r\n')}];
  const request = buildReviewRequest({defect: 'OMB_SHARED_RULES_MISSING', context: reviewContextFixture('OMB_SHARED_RULES_MISSING', files),
    nonce: '00000000-0000-4000-8000-000000000001',
    files});
  const loaded = readCanonicalReviewerProfile();
  assert.equal(loaded.ok, true);
  const prompt = buildReviewerPrompt(request, loaded.profile.profileSha256);
  const expected = {...request, reviewerProfileSha256: loaded.profile.profileSha256, prompt};
  return {request, expected, prompt};
}

test('review accepts only the matching read-only Agent tool result', () => {
  const {expected, prompt} = reviewFixture();
  const accepted = parseReviewerTrace(reviewerTrace(prompt), expected);
  assert.equal(accepted.status, 'approved');
  assert.equal(accepted.traceVerified, true);

  const absent = parseReviewerTrace(reviewerTrace(prompt, {omitAgent: true, final: 'APPROVE'}), expected);
  assert.equal(absent.status, 'invalid');
  assert.equal(absent.reason, 'REVIEW_AGENT_CALL_MISSING_OR_EXTRA');
});

test('an errored or unspecified terminal cannot approve a matching reviewer result', () => {
  const {request, expected, prompt} = reviewFixture();
  for (const terminalError of [true, undefined]) {
    const events = reviewerTrace(prompt).trim().split('\n').map((line) => JSON.parse(line));
    events.at(-1).is_error = terminalError;
    const trace = events.map((event) => JSON.stringify(event)).join('\n');
    const result = parseReviewerTrace(trace, expected);
    assert.equal(result.status, 'unavailable');
    assert.equal(result.reason, 'REVIEW_CLI_INCOMPLETE');
    assert.equal(reviewMatchesRequest(result, request), false);
  }
});

test('review rejection is never upgraded by the dispatcher final message', () => {
  const {expected, prompt} = reviewFixture();
  const rejected = parseReviewerTrace(reviewerTrace(prompt, {
    receipt: {decision: 'REJECT', findings: ['blocking finding']}, final: 'APPROVE',
  }), expected);
  assert.equal(rejected.status, 'rejected');
  assert.equal(rejected.reason, 'REVIEWER_REJECTED');
});

test('stale nonce and mismatched hashes fail closed', () => {
  const {expected, prompt} = reviewFixture();
  const stale = parseReviewerTrace(reviewerTrace(prompt, {
    receipt: {nonce: '11111111-1111-4111-8111-111111111111'},
  }), expected);
  assert.equal(stale.status, 'invalid');
  assert.equal(stale.reason, 'REVIEW_RECEIPT_STALE');
  const mismatch = parseReviewerTrace(reviewerTrace(prompt, {receipt: {diffHash: '0'.repeat(64)}}), expected);
  assert.equal(mismatch.status, 'invalid');
  assert.equal(mismatch.reason, 'REVIEW_RECEIPT_HASH_MISMATCH');
});

test('review request requires original requirement, evidence and explicit not-run checks', () => {
  const files = [{path: 'bots/AGENTS.md', before: null, after: Buffer.from('exact rules\n')}];
  assert.throws(() => buildReviewRequest({defect: 'OMB_SHARED_RULES_MISSING', files}), /REVIEW_CONTEXT_REQUIRED/);
  const request = buildReviewRequest({defect: 'OMB_SHARED_RULES_MISSING', files,
    context: reviewContextFixture('OMB_SHARED_RULES_MISSING', files)});
  const diff = JSON.parse(request.diffContent);
  assert.equal(diff.context.requirement, MAINTENANCE_REVIEW_REQUIREMENT);
  assert.equal(diff.context.scope, MAINTENANCE_REPAIR_SCOPE);
  assert.equal(diff.context.evidence.causeCode, 'RULES_FILE_ABSENT');
  assert.equal(diff.context.evidence.beforeImages[0].path, 'bots/AGENTS.md');
  assert.equal(diff.context.evidence.beforeImages[0].present, false);
  assert.equal(diff.context.evidence.desiredTemplateSha256, sha(Buffer.from('exact rules\n')));
  assert.equal(diff.context.checks.preApplyTests, 'NOT_RUN');
  assert.equal(diff.context.checks.postApplyVerification, 'NOT_RUN');
});

test('review prompt carries exact before and after bytes with their hashes', async () => {
  const before = Buffer.from('old rules\r\n');
  const after = Buffer.from('new rules\nwith two lines\r\n');
  const files = [{path: 'bots/AGENTS.md', before, after}];
  const request = buildReviewRequest({defect: 'OMB_SHARED_RULES_MISSING',
    nonce: '00000000-0000-4000-8000-000000000002',
    files, context: reviewContextFixture('OMB_SHARED_RULES_MISSING', files)});
  const audit = [];
  const result = await reviewCandidate(request, fixtureReviewOptions({audit}));
  assert.equal(result.status, 'approved');
  assert.equal(audit.length, 1);
  const marker = 'REQUEST_JSON=';
  const payload = JSON.parse(audit[0].reviewerPrompt.slice(audit[0].reviewerPrompt.lastIndexOf(marker) + marker.length));
  const diff = JSON.parse(payload.diffContent);
  assert.equal(payload.nonce, request.nonce);
  assert.equal(payload.beforeHash, request.beforeHash);
  assert.equal(payload.afterHash, request.afterHash);
  assert.equal(payload.diffHash, request.diffHash);
  assert.equal(diff.files[0].before.text, before.toString('utf8'));
  assert.equal(diff.files[0].before.base64, before.toString('base64'));
  assert.equal(diff.files[0].after.text, after.toString('utf8'));
  assert.equal(diff.files[0].after.base64, after.toString('base64'));
  assert.equal(audit[0].shell, false);
  assert.equal(audit[0].windowsHide, true);
  assert.equal(audit[0].args.includes('--restricted'), false);
  assert.equal(audit[0].args.includes('--strict-mcp-config'), false);
  assert.equal(audit[0].args.includes('--no-session-persistence'), true);
  assert.equal(audit[0].args.includes('--permission-mode') &&
    audit[0].args[audit[0].args.indexOf('--permission-mode') + 1] === 'dontAsk', true);
  assert.equal(audit[0].args.includes('--setting-sources'), false);
  assert.equal(audit[0].args.includes('--settings'), false);
  assert.equal(audit[0].args[audit[0].args.indexOf('--tools') + 1], 'Agent');
  const agents = JSON.parse(audit[0].args[audit[0].args.indexOf('--agents') + 1]);
  assert.deepEqual(agents[REVIEWER_NAME].tools, ['Read', 'Grep', 'Glob']);
  assert.equal(audit[0].inheritedEnvironment, true);
});

test('unavailable review writes only a bounded blocked report, not repair outputs', async () => {
  const s = sandbox();
  const r = await repairFixture(s, {deps: {reviewOptions: {
    platform: 'win32', claudeExe: join(s.root, 'missing-claude.exe'), spawnImpl: fakeReviewSpawn(),
  }}});
  assert.equal(r.status, 'review-unavailable');
  assert.equal(r.review.state, 'unavailable');
  assert.equal(r.reason, 'REVIEW_CLI_UNAVAILABLE');
  assert.equal(r.reportState, 'written');
  assert.equal(existsSync(rules(s)), false);
  assert.equal(existsSync(join(s.dataDir, 'bots', '.singularity-openmausbot-rules.json')), false);
  assert.equal(existsSync(join(s.home, 'reports', 'maintenance', '.ledger.json')), false);
  assert.equal(r.chatDelivered, false);
  assert.equal(r.chatState, 'CHAT_DELIVERY_PENDING');
  assert.equal(Object.keys(outbox(s).pending).length, 1);
  assert.equal(existsSync(join(s.home, 'reports', 'maintenance', '.lock')), false);
  assert.equal(existsSync(join(s.home, 'reports', 'maintenance', '.backups')), false);
  assert.equal(reports(s).length, 1);
  assert.match(reportText(s), /Status: BLOCKED/);
  assert.match(reportText(s), /Review gate: unavailable/);
  assert.match(reportText(s), /Root cause: The receipt-owned bots\/AGENTS.md rules file is absent\./);
  assert.match(reportText(s), /safe cause code RULES_FILE_ABSENT/);
  assert.match(reportText(s), /pre-apply tests NOT_RUN/);
  assert.match(reportText(s), /desired template sha256 [0-9a-f]{64}/);
  assert.match(reportText(s), /Modified project-owned repair files: none/);
  assert.doesNotMatch(reportText(s), /Status: FIXED|APPROVE/);
});

test('detector exceptions produce bounded BLOCKED reports with truthful acknowledged or pending delivery', async () => {
  const privateFailure = 'PRIVATE_DETECTOR_FAILURE_DETAIL';
  for (const acknowledged of [true, false]) {
    const s = sandbox();
    const reviewerCalls = [];
    const messages = [];
    const r = await repairFixture(s, {
      sendChat: (message, {sendId}) => {
        messages.push(message);
        assert.equal(outbox(s).pending[sendId].message, message, 'the bounded notice is durable before send');
        return acknowledged;
      },
      deps: {planRules: () => { throw new Error(privateFailure); },
        reviewOptions: fixtureReviewOptions({audit: reviewerCalls})},
    });
    assert.equal(r.status, 'unable-to-repair');
    assert.equal(r.defect, 'OMB_RULES_DETECTION_FAILED');
    assert.equal(r.reason, 'DETECTION_FAILED');
    assert.deepEqual(r.changed, []);
    assert.equal(r.review.state, 'not-run');
    assert.equal(r.reportState, 'written');
    assert.deepEqual(reviewerCalls, []);
    assert.equal(existsSync(rules(s)), false);
    assert.equal(existsSync(join(s.dataDir, 'bots', '.singularity-openmausbot-rules.json')), false);
    assert.equal(existsSync(join(s.home, 'reports', 'maintenance', '.backups')), false);
    assert.deepEqual(ledger(s).fixes, {});
    assert.equal(existsSync(join(s.home, 'reports', 'maintenance', '.lock')), false);
    const report = reportText(s);
    assert.match(report, /Status: BLOCKED/);
    assert.match(report, /Observed defect: OMB_RULES_DETECTION_FAILED/);
    assert.match(report, /Root cause: Owned rules detection failed before it could establish the target state; the detailed error was withheld\./);
    assert.match(report, /Detection evidence: state unavailable; safe cause code RULES_DETECTION_FAILED/);
    assert.match(report, /Relevant checks: defect detection FAILED; planRules NOT_RUN; pre-apply tests NOT_RUN; post-apply verification NOT_RUN/);
    assert.match(report, /Review gate: not-run; reason DETECTION_FAILED/);
    assert.doesNotMatch(report, new RegExp(privateFailure));
    assert.equal(messages.length, 1);
    assert.match(messages[0], /Singularity Maintainer: BLOCKED OMB_RULES_DETECTION_FAILED; cause DETECTION_FAILED/);
    assert.doesNotMatch(messages[0], new RegExp(privateFailure));
    if (acknowledged) {
      assert.equal(r.chatDelivered, true);
      assert.equal(r.chatState, 'delivered');
      assert.equal(Object.keys(outbox(s).pending).length, 0);
      assert.match(report, /OpenMausBot chat delivery: acknowledged/);
    } else {
      assert.equal(r.chatDelivered, false);
      assert.equal(r.chatState, 'CHAT_DELIVERY_PENDING');
      const pending = outbox(s).pending[r.sendId];
      assert.ok(pending);
      assert.equal(pending.attempts, 1);
      assert.match(report, /OpenMausBot chat delivery: pending; durably queued for retry/);
      assert.doesNotMatch(pending.message, new RegExp(privateFailure));
    }
  }
});

test('detector failure holds the lock until its bounded notification is acknowledged', async () => {
  const s = sandbox();
  let announceStarted;
  let releaseSender;
  const started = new Promise((resolve) => { announceStarted = resolve; });
  const senderGate = new Promise((resolve) => { releaseSender = resolve; });
  const firstRun = repairFixture(s, {sendChat: async (_message, {sendId}) => {
    assert.ok(outbox(s).pending[sendId]);
    announceStarted(sendId);
    await senderGate;
    return true;
  }, deps: {planRules: () => { throw new Error('PRIVATE_DETECTOR_FAILURE'); }}});
  const sendId = await started;
  const lock = join(s.home, 'reports', 'maintenance', '.lock');
  assert.equal(existsSync(lock), true);
  const concurrent = await repairFixture(s, {
    sendChat: () => { throw new Error('sender must not run while the lock is held'); },
    deps: {planRules: () => { throw new Error('second detector must not run'); }},
  });
  assert.equal(concurrent.status, 'busy');
  assert.equal(concurrent.reason, 'MAINTENANCE_LOCK_HELD');
  releaseSender();
  const completed = await firstRun;
  assert.equal(completed.status, 'unable-to-repair');
  assert.equal(completed.chatDelivered, true);
  assert.equal(completed.sendId, sendId);
  assert.equal(existsSync(lock), false);
  assert.equal(Object.keys(outbox(s).pending).length, 0);
});

test('blocked receipt drift reports the observed cause and both before images', async () => {
  for (const withReceipt of [false, true]) {
    const s = sandbox({withRules: true, rules: TEMPLATE, withReceipt});
    const beforeRules = readFileSync(rules(s));
    const receiptPath = join(s.dataDir, 'bots', '.singularity-openmausbot-rules.json');
    const beforeReceipt = existsSync(receiptPath) ? readFileSync(receiptPath) : null;
    const r = await repairFixture(s, {deps: {reviewOptions: {
      platform: 'win32', claudeExe: join(s.root, 'missing-claude.exe'), spawnImpl: fakeReviewSpawn(),
    }}});
    const report = reportText(s);
    assert.equal(r.status, 'review-unavailable');
    assert.equal(r.defect, 'OMB_RULES_RECEIPT_DRIFT');
    assert.match(report, /Observed defect: OMB_RULES_RECEIPT_DRIFT/);
    assert.match(report, /Detection evidence: state matching;/);
    assert.match(report, /Root cause: The shared rules match the current template, but the ownership receipt/);
    assert.match(report, /bots\/AGENTS\.md=present sha256=[0-9a-f]{64}/);
    assert.match(report, withReceipt
      ? /bots\/\.singularity-openmausbot-rules\.json=present sha256=[0-9a-f]{64}/
      : /bots\/\.singularity-openmausbot-rules\.json=absent sha256=unavailable/);
    assert.match(report, withReceipt
      ? /safe cause code RULES_RECEIPT_INVALID/
      : /safe cause code RULES_NOT_INSTALLED_OR_CHANGED/);
    assert.match(report, /pre-apply tests NOT_RUN/);
    assert.deepEqual(readFileSync(rules(s)), beforeRules);
    assert.equal(existsSync(receiptPath), beforeReceipt !== null);
    if (beforeReceipt) assert.deepEqual(readFileSync(receiptPath), beforeReceipt);
    assert.equal(existsSync(join(s.home, 'reports', 'maintenance', '.backups')), false);
    assert.equal(Object.keys(outbox(s).pending).length, 1);
  }
});

test('review-gate report destination rejects a reparse point', async (t) => {
  const s = sandbox();
  const redirected = join(s.root, 'redirected-reports');
  mkdirSync(redirected);
  try { symlinkSync(redirected, join(s.home, 'reports'), 'junction'); }
  catch { t.skip('directory junction creation is unavailable in this environment'); return; }
  const messages = [];
  const r = await repairFixture(s, {sendChat: (message) => { messages.push(message); return true; }});
  assert.equal(r.reportState, 'unavailable');
  assert.equal(r.reportReason, 'REPORT_PATH_UNSAFE');
  assert.equal(r.chatDelivered, true);
  assert.equal(r.chatQueued, false);
  assert.equal(r.chatPending, 0);
  assert.equal(messages.length, 1);
  assert.match(messages[0], /BLOCKED MAINTENANCE_CHECK; cause REPORT_PATH_UNSAFE/);
  assert.match(messages[0], /Report: unavailable \(REPORT_PATH_UNSAFE\)/);
  assert.doesNotMatch(messages[0], new RegExp(s.root.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
  assert.equal(readdirSync(redirected).length, 0);
  assert.equal(existsSync(rules(s)), false);
});

test('foreign shared rules are reported without reviewer execution or target mutation', async () => {
  const privateContent = 'private user-owned rules must not appear in reports or chat\n';
  const s = sandbox({withRules: true, rules: privateContent});
  const before = readFileSync(rules(s));
  const messages = [];
  const reviewerCalls = [];
  const r = await repairFixture(s, {sendChat: (message) => { messages.push(message); return true; },
    deps: {reviewOptions: fixtureReviewOptions({audit: reviewerCalls})}});
  assert.equal(r.status, 'approval-blocked');
  assert.equal(r.defect, 'OMB_SHARED_RULES_FOREIGN');
  assert.equal(r.reason, 'OWNED_FILE_MODIFIED_BY_USER');
  assert.deepEqual(r.changed, []);
  assert.deepEqual(readFileSync(rules(s)), before);
  assert.deepEqual(reviewerCalls, []);
  assert.equal(r.reportState, 'written');
  assert.equal(r.chatDelivered, true);
  assert.match(reportText(s), /Root cause: The shared rules were modified outside the receipt-owned template; user content was preserved\./);
  assert.match(reportText(s), /Detection evidence: state foreign;/);
  assert.match(reportText(s), /safe cause code RULES_FILE_FOREIGN/);
  assert.match(reportText(s), /Review gate: not-run; reason OWNED_FILE_MODIFIED_BY_USER/);
  assert.match(reportText(s), /OpenMausBot chat delivery: acknowledged/);
  assert.doesNotMatch(reportText(s), /private user-owned rules|[A-Z]:\\/);
  assert.doesNotMatch(messages[0], /private user-owned rules|[A-Z]:\\/);
  assert.match(messages[0], /BLOCKED OMB_SHARED_RULES_FOREIGN; cause OWNED_FILE_MODIFIED_BY_USER/);
  assert.equal(Object.keys(outbox(s).pending).length, 0);
});

test('unsafe directory reparse points at shared rules have a distinct cause and are never followed', async () => {
  const s = sandbox();
  const external = join(s.root, 'private-external-rules');
  mkdirSync(external);
  const marker = join(external, 'marker.txt');
  const privateContent = Buffer.from('private external rules marker\n');
  writeFileSync(marker, privateContent);
  mkdirSync(join(external, 'child'));
  writeFileSync(join(external, 'child', 'keep.txt'), 'keep this external tree\n');
  const beforeEntries = readdirSync(external).sort();
  symlinkSync(external, rules(s), 'junction');
  assert.equal(lstatSync(rules(s)).isSymbolicLink(), true);
  const before = readFileSync(marker);
  const messages = [];
  const r = await repairFixture(s, {sendChat: (message) => { messages.push(message); return true; }});
  assert.equal(r.status, 'approval-blocked');
  assert.equal(r.defect, 'OMB_RULES_UNSAFE_PATH');
  assert.equal(r.reason, 'RULES_PATH_UNSAFE');
  assert.deepEqual(r.changed, []);
  assert.equal(r.review.state, 'not-run');
  assert.equal(r.reportState, 'written');
  assert.equal(r.chatDelivered, true);
  assert.deepEqual(readFileSync(marker), before);
  assert.deepEqual(readdirSync(external).sort(), beforeEntries);
  assert.equal(lstatSync(rules(s)).isSymbolicLink(), true);
  assert.match(reportText(s), /Root cause: The shared rules path is unsafe; no repair was attempted\./);
  assert.match(reportText(s), /Detection evidence: state unsafe;/);
  assert.match(reportText(s), /safe cause code RULES_PATH_UNSAFE/);
  assert.doesNotMatch(reportText(s), /private external rules marker|keep this external tree|[A-Z]:\\/);
  assert.doesNotMatch(messages[0], /private external rules marker|keep this external tree|[A-Z]:\\/);
  assert.match(messages[0], /BLOCKED OMB_RULES_UNSAFE_PATH; cause RULES_PATH_UNSAFE/);
});

test('unsafe outbox entries are rejected without writing through the path or claiming a pending send', async () => {
  const s = sandbox({withRules: true, rules: 'private foreign rules\n'});
  const maintenance = join(s.home, 'reports', 'maintenance');
  mkdirSync(maintenance, {recursive: true});
  const outboxPath = join(maintenance, '.outbox.json');
  mkdirSync(outboxPath);
  let sendCount = 0;
  const r = await repairFixture(s, {sendChat: () => { sendCount++; return true; }});
  assert.equal(r.status, 'approval-blocked');
  assert.equal(r.reportState, 'written');
  assert.equal(r.chatDelivered, false);
  assert.equal(r.chatState, 'unavailable');
  assert.equal(r.chatQueued, false);
  assert.equal(r.chatPending, 0);
  assert.equal(r.chatReason, 'OUTBOX_PATH_UNSAFE');
  assert.equal(sendCount, 0);
  assert.equal(lstatSync(outboxPath).isDirectory(), true);
  assert.match(reportText(s), /OpenMausBot chat delivery: not queued \(OUTBOX_PATH_UNSAFE\)/);
  assert.doesNotMatch(reportText(s), /private foreign rules|[A-Z]:\\/);
});

test('a blocked notification is durably queued and retried once with its original send id', async () => {
  const s = sandbox({withRules: true, rules: 'user owned rules\n'});
  const first = await repairFixture(s);
  assert.equal(first.status, 'approval-blocked');
  assert.equal(first.chatState, 'CHAT_DELIVERY_PENDING');
  const firstId = first.sendId;
  assert.match(firstId, /^[0-9a-f]{16}$/);
  assert.equal(outbox(s).pending[firstId].sendId, firstId);
  assert.match(outbox(s).pending[firstId].message, /Report: reports\/maintenance\//);
  assert.doesNotMatch(outbox(s).pending[firstId].message, /[A-Z]:\\|user owned rules/);

  const sent = [];
  const second = await repairFixture(s, {sendChat: (message, options) => {
    sent.push(options.sendId);
    assert.doesNotMatch(message, /[A-Z]:\\|user owned rules/);
    return {acknowledged: true};
  }});
  assert.equal(second.status, 'approval-blocked');
  assert.deepEqual(sent.filter((id) => id === firstId), [firstId]);
  assert.equal(new Set(sent).size, sent.length);
  assert.equal(Object.keys(outbox(s).pending).length, 0);
});

test('blocked notification awaits chat acknowledgement while holding the maintenance lock', async () => {
  const s = sandbox({withRules: true, rules: 'user owned rules\n'});
  let notifyStarted;
  let releaseSender;
  const started = new Promise((resolve) => { notifyStarted = resolve; });
  const gate = new Promise((resolve) => { releaseSender = resolve; });
  const firstRun = repairFixture(s, {sendChat: async (_message, options) => {
    notifyStarted(options.sendId);
    await gate;
    return true;
  }});
  const sendId = await started;
  const lock = join(s.home, 'reports', 'maintenance', '.lock');
  assert.equal(existsSync(lock), true);
  const concurrent = await repairFixture(s, {sendChat: () => true});
  assert.equal(concurrent.status, 'busy');
  assert.equal(concurrent.reason, 'MAINTENANCE_LOCK_HELD');
  releaseSender();
  const first = await firstRun;
  assert.equal(first.status, 'approval-blocked');
  assert.equal(first.sendId, sendId);
  assert.equal(first.chatDelivered, true);
  assert.equal(existsSync(lock), false);
});

test('a rejected or hash-mismatched review never writes a repair', async () => {
  const rejected = sandbox();
  const rejectResult = await repairFixture(rejected, {deps: {reviewOptions: fixtureReviewOptions({
    receipt: {decision: 'REJECT', findings: ['blocking issue']},
  })}});
  assert.equal(rejectResult.status, 'review-rejected');
  assert.equal(existsSync(rules(rejected)), false);
  assert.equal(reports(rejected).length, 1);
  assert.match(reportText(rejected), /Status: BLOCKED/);
  assert.match(reportText(rejected), /reason REVIEWER_REJECTED/);
  assert.equal(existsSync(join(rejected.home, 'reports', 'maintenance', '.backups')), false);

  const mismatch = sandbox();
  const mismatchResult = await repairFixture(mismatch, {deps: {reviewOptions: fixtureReviewOptions({
    receipt: {afterHash: '0'.repeat(64)},
  })}});
  assert.equal(mismatchResult.status, 'review-invalid');
  assert.equal(mismatchResult.reason, 'REVIEW_RECEIPT_HASH_MISMATCH');
  assert.equal(existsSync(rules(mismatch)), false);
  assert.equal(existsSync(join(mismatch.dataDir, 'bots', '.singularity-openmausbot-rules.json')), false);
  assert.equal(existsSync(join(mismatch.home, 'reports', 'maintenance', '.ledger.json')), false);
  assert.equal(Object.keys(outbox(mismatch).pending).length, 1);
  assert.equal(existsSync(join(mismatch.home, 'reports', 'maintenance', '.backups')), false);
  assert.equal(reports(mismatch).length, 1);
  assert.match(reportText(mismatch), /Status: BLOCKED/);
});

test('production repair and CLI reject injected reviewer or gates before any target writes', async () => {
  const s = sandbox();
  await assert.rejects(() => repair(paths(s), {deps: {
    reviewOptions: {platform: 'win32', claudeExe: process.execPath, spawnImpl: fakeReviewSpawn()},
    reviewCandidate: async () => ({status: 'approved', approved: true, traceVerified: true}),
  }}), /PRODUCTION_DEPENDENCY_INJECTION_REFUSED/);
  assert.equal(existsSync(rules(s)), false);
  assert.equal(existsSync(join(s.dataDir, 'bots', '.singularity-openmausbot-rules.json')), false);
  assert.equal(reports(s).length, 0);
  assert.equal(existsSync(join(s.home, 'reports', 'maintenance', '.lock')), false);

  await assert.rejects(() => runCli(['--apply', '--home', s.home, '--data-dir', s.dataDir,
    '--workspace', s.workspace], {platform: 'win32', reviewSpawn: fakeReviewSpawn()}),
  /PRODUCTION_DEPENDENCY_INJECTION_REFUSED/);
  await assert.rejects(() => runCli(['--apply', '--fixture', '--home', s.home,
    '--data-dir', s.dataDir, '--workspace', s.workspace]), /USAGE/);
  await assert.rejects(() => repair(paths(s), {allowFixture: true}), /PRODUCTION_DEPENDENCY_INJECTION_REFUSED/);
  const hiddenOptions = Object.defineProperty({}, 'allowFixture', {value: true});
  const inheritedOptions = Object.create({allowFixture: true});
  const symbolOptions = {[Symbol('fixture')]: true};
  for (const options of [hiddenOptions, inheritedOptions, symbolOptions]) {
    await assert.rejects(() => repair(paths(s), options), /PRODUCTION_DEPENDENCY_INJECTION_REFUSED/);
    await assert.rejects(() => runCli(['--apply', '--home', s.home, '--data-dir', s.dataDir,
      '--workspace', s.workspace], options), /PRODUCTION_DEPENDENCY_INJECTION_REFUSED/);
  }
  assert.equal(existsSync(rules(s)), false);
  assert.equal(reports(s).length, 0);
});

test('production preserves existing Windows targets when metadata restoration is unsupported',
  {skip: process.platform !== 'win32' && process.env.SINGULARITY_SKIP_WINDOWS_TESTS === '1'}, () => {
    assert.equal(process.platform, 'win32', 'WINDOWS_METADATA_TEST_REQUIRES_WINDOWS');
    const readSecurityDescriptor = (file) => {
      const result = spawnSync('powershell.exe', ['-NoLogo', '-NoProfile', '-NonInteractive', '-Command',
        "Import-Module (Join-Path $PSHOME 'Modules/Microsoft.PowerShell.Security') -ErrorAction Stop; " +
        '[Console]::Write((Get-Acl -LiteralPath $env:SINGULARITY_METADATA_TEST_PATH).Sddl)'], {
        env: {...process.env, SINGULARITY_METADATA_TEST_PATH: file},
        encoding: 'utf8', windowsHide: true, timeout: 15000,
      });
      assert.equal(result.status, 0, 'WINDOWS_FIXTURE_ACL_READ_FAILED');
      return result.stdout;
    };
    const cases = [
      {withRules: true, rules: TEMPLATE},
      {withReceipt: true},
      {withRules: true, rules: TEMPLATE, withReceipt: true},
    ];
    for (const options of cases) {
      const s = sandbox(options);
      const targetPaths = [rules(s), join(s.dataDir, 'bots', '.singularity-openmausbot-rules.json')];
      const snapshots = targetPaths.map((file) => ({file, present: existsSync(file),
        ...(existsSync(file) ? {bytes: readFileSync(file), info: lstatSync(file),
          securityDescriptor: readSecurityDescriptor(file)} : {})}));
      const repairModule = new URL('./maintenance_repair.mjs', import.meta.url).href;
      const program = `import {repair} from ${JSON.stringify(repairModule)};
        const result = await repair(${JSON.stringify(paths(s))});
        process.stdout.write(JSON.stringify(result));`;
      // The subprocess has an empty user profile, so a guard regression cannot
      // invoke the installed reviewer or use the operator's login context.
      const child = spawnSync(process.execPath, ['--input-type=module', '-e', program], {
        env: {...process.env, USERPROFILE: s.home},
        encoding: 'utf8', windowsHide: true, timeout: 30000,
      });
      assert.equal(child.status, 0);
      const result = JSON.parse(child.stdout);
      assert.equal(result.status, 'review-unavailable');
      assert.equal(result.reason, 'REVIEW_METADATA_PRESERVATION_UNSUPPORTED');
      assert.equal(result.review.state, 'not-run');
      assert.deepEqual(result.changed, []);
      assert.equal(result.chatDelivered, false);
      for (const entry of snapshots) {
        assert.equal(existsSync(entry.file), entry.present);
        if (!entry.present) continue;
        assert.deepEqual(readFileSync(entry.file), entry.bytes);
        const info = lstatSync(entry.file);
        for (const field of ['mode', 'uid', 'gid', 'mtimeMs', 'ctimeMs', 'birthtimeMs', 'ino', 'dev'])
          assert.equal(info[field], entry.info[field], field);
        assert.equal(readSecurityDescriptor(entry.file), entry.securityDescriptor);
      }
      for (const name of ['.backups', '.ledger.json', '.lock'])
        assert.equal(existsSync(join(s.home, 'reports', 'maintenance', name)), false, name);
      assert.equal(Object.keys(outbox(s).pending).length, 1);
      assert.equal(reports(s).length, 1);
      assert.match(reportText(s), /REVIEW_METADATA_PRESERVATION_UNSUPPORTED/);
      assert.match(reportText(s), /Review gate: not-run;/);
    }
  });

test('a baseline changed during review is stale and receives no repair writes', async () => {
  const s = sandbox();
  const externalContent = 'external rules changed during review\n';
  const r = await repairFixture(s, {deps: {reviewOptions: fixtureReviewOptions({
    beforeRespond: () => writeFileSync(rules(s), externalContent),
  })}});
  assert.equal(r.status, 'review-stale');
  assert.equal(r.reason, 'REVIEW_BASELINE_CHANGED');
  assert.equal(readFileSync(rules(s), 'utf8'), externalContent);
  assert.equal(existsSync(join(s.dataDir, 'bots', '.singularity-openmausbot-rules.json')), false);
  assert.equal(existsSync(join(s.home, 'reports', 'maintenance', '.ledger.json')), false);
  assert.equal(Object.keys(outbox(s).pending).length, 1);
  assert.equal(existsSync(join(s.home, 'reports', 'maintenance', '.backups')), false);
  assert.equal(reports(s).length, 1);
  assert.match(reportText(s), /Status: BLOCKED/);
  assert.match(reportText(s), /reason REVIEW_BASELINE_CHANGED/);
});

test('a receipt changed during backup is preserved and blocks the approved write', async () => {
  const s = sandbox({withRules: true, rules: TEMPLATE, withReceipt: true});
  const receiptPath = join(s.dataDir, 'bots', '.singularity-openmausbot-rules.json');
  const beforeRules = readFileSync(rules(s));
  const externalReceipt = Buffer.from('external receipt bytes during backup\n');
  const r = await repairFixture(s, {deps: {afterBackup: () => writeFileSync(receiptPath, externalReceipt)}});
  assert.equal(r.status, 'review-stale');
  assert.equal(r.reason, 'REVIEW_BASELINE_CHANGED');
  assert.deepEqual(readFileSync(rules(s)), beforeRules);
  assert.deepEqual(readFileSync(receiptPath), externalReceipt);
  assert.equal(existsSync(join(s.home, 'reports', 'maintenance', '.ledger.json')), false);
  const report = reportText(s);
  assert.match(report, /Status: BLOCKED/);
  assert.match(report, /Backup state: created and retained/);
  assert.match(report, /Current target readback: bots\/\.singularity-openmausbot-rules\.json=present sha256=[0-9a-f]{64}/);
  assert.match(report, /reason REVIEW_BASELINE_CHANGED/);
});

test('backup hashes the copied before image and rechecks a source change during copying', async () => {
  const s = sandbox({withRules: true, rules: TEMPLATE, withReceipt: true});
  const beforeRules = readFileSync(rules(s));
  const beforeReceipt = readFileSync(join(s.dataDir, 'bots', '.singularity-openmausbot-rules.json'));
  const externalRules = Buffer.from('newer user rules appeared while backup was copying\n');
  const r = await repairFixture(s, {deps: {afterBackupCopy: ({name, source}) => {
    if (name === 'AGENTS.md') writeFileSync(source, externalRules);
  }}});
  assert.equal(r.status, 'review-stale');
  assert.equal(r.reason, 'REVIEW_BASELINE_CHANGED');
  assert.deepEqual(readFileSync(rules(s)), externalRules);
  assert.deepEqual(readFileSync(join(s.dataDir, 'bots', '.singularity-openmausbot-rules.json')), beforeReceipt);
  assert.match(reportText(s), /Backup state: created and retained/);
  const backupsRoot = join(s.home, 'reports', 'maintenance', '.backups');
  const backupDirs = readdirSync(backupsRoot);
  assert.equal(backupDirs.length, 1);
  const backupDir = join(backupsRoot, backupDirs[0]);
  assert.deepEqual(readFileSync(join(backupDir, 'AGENTS.md')), beforeRules);
  assert.deepEqual(readFileSync(join(backupDir, '.singularity-openmausbot-rules.json')), beforeReceipt);
  assert.equal(existsSync(join(s.home, 'reports', 'maintenance', '.ledger.json')), false);
  assert.match(reportText(s), /Current target readback: .*bots\/AGENTS\.md=present sha256=[0-9a-f]{64}/);
});

test('a receipt changed immediately before its write stays untouched', async () => {
  const s = sandbox({withRules: true, rules: TEMPLATE, withReceipt: true});
  const receiptPath = join(s.dataDir, 'bots', '.singularity-openmausbot-rules.json');
  const beforeRules = readFileSync(rules(s));
  const externalReceipt = Buffer.from('user receipt changed at write boundary\n');
  const r = await repairFixture(s, {deps: {beforeReceiptWrite: () => writeFileSync(receiptPath, externalReceipt)}});
  assert.equal(r.status, 'review-stale');
  assert.equal(r.reason, 'REVIEW_BASELINE_CHANGED');
  assert.deepEqual(readFileSync(rules(s)), beforeRules);
  assert.deepEqual(readFileSync(receiptPath), externalReceipt);
  assert.equal(reports(s).length, 1);
  assert.match(reportText(s), /Current target readback: bots\/\.singularity-openmausbot-rules\.json=present sha256=[0-9a-f]{64}/);
  assert.equal(reportText(s).includes('user receipt changed at write boundary'), false);
});

test('partial mutation failure rolls back only the reviewed candidate and reports readback', async () => {
  const s = sandbox();
  const receiptPath = join(s.dataDir, 'bots', '.singularity-openmausbot-rules.json');
  const receipt = JSON.stringify({schema: 1, target: rules(s), sha256: sha(Buffer.from(TEMPLATE))}) + '\n';
  const messages = [];
  const r = await repairFixture(s, {sendChat: (message) => { messages.push(message); return true; },
    deps: {installRules: () => {
      writeFileSync(receiptPath, receipt);
      throw new Error('INJECTED_PARTIAL_WRITE');
    }}});
  assert.equal(r.status, 'attempted-unverified');
  assert.equal(r.reason, 'INJECTED_PARTIAL_WRITE');
  assert.equal(r.reportState, 'written');
  assert.equal(r.rollback, 'restored-and-verified');
  assert.equal(r.verdict, 'ROLLED_BACK');
  assert.equal(r.chatDelivered, true);
  assert.equal(existsSync(rules(s)), false);
  assert.equal(existsSync(receiptPath), false);
  const report = reportText(s);
  assert.match(report, /Verdict: ROLLED_BACK/);
  assert.match(report, /Post-apply verification: NOT_RUN/);
  assert.match(report, /Rollback: restored-and-verified/);
  assert.match(report, /OpenMausBot chat delivery: acknowledged/);
  assert.match(report, /post-rollback targets .*bots\/\.singularity-openmausbot-rules\.json=absent/);
  assert.match(messages[0], /Singularity Maintainer: ROLLED_BACK OMB_SHARED_RULES_MISSING; cause INJECTED_PARTIAL_WRITE/);
  assert.doesNotMatch(messages[0], /[A-Z]:\\/);
});

test('a stale nonce writes only a blocked report and leaves targets byte-identical', async () => {
  const s = sandbox({withRules: true, rules: TEMPLATE, withReceipt: true});
  const beforeRules = readFileSync(rules(s));
  const receiptPath = join(s.dataDir, 'bots', '.singularity-openmausbot-rules.json');
  const beforeReceipt = readFileSync(receiptPath);
  const r = await repairFixture(s, {deps: {reviewOptions: fixtureReviewOptions({
    receipt: {nonce: '11111111-1111-4111-8111-111111111111'},
  })}});
  assert.equal(r.status, 'review-stale');
  assert.equal(r.reason, 'REVIEW_RECEIPT_STALE');
  assert.deepEqual(readFileSync(rules(s)), beforeRules);
  assert.deepEqual(readFileSync(receiptPath), beforeReceipt);
  assert.equal(existsSync(join(s.home, 'reports', 'maintenance', '.ledger.json')), false);
  assert.equal(Object.keys(outbox(s).pending).length, 1);
  assert.equal(existsSync(join(s.home, 'reports', 'maintenance', '.lock')), false);
  assert.equal(existsSync(join(s.home, 'reports', 'maintenance', '.backups')), false);
  assert.equal(reports(s).length, 1);
  assert.match(reportText(s), /Status: BLOCKED/);
  assert.match(reportText(s), /reason REVIEW_RECEIPT_STALE/);
});

test('missing owned rules are repaired and independently verified', async () => {
  const s = sandbox();
  const r = await repairFixture(s);
  assert.equal(r.status, 'fixed-and-verified');
  assert.equal(r.changed.includes(rules(s)), true);
  assert.equal(existsSync(join(s.dataDir, 'bots', '.singularity-openmausbot-rules.json')), true);
  assert.equal(reports(s).length, 1);
  const report = reportText(s);
  assert.match(report, /Detector evidence: state absent; safe cause code RULES_FILE_ABSENT; desired template sha256 [0-9a-f]{64}/);
  assert.match(report, /Before images: bots\/\.singularity-openmausbot-rules\.json=absent sha256=unavailable; bots\/AGENTS\.md=absent sha256=unavailable/);
  assert.match(report, /Independent review: singularity-code-reviewer APPROVE; nonce [0-9a-f-]{36}; before [0-9a-f]{64}; after [0-9a-f]{64}; diff [0-9a-f]{64}/);
  assert.match(report, /Approved and applied diff summary \(relative paths; file contents omitted\):/);
  assert.match(report, /- bots\/\.singularity-openmausbot-rules\.json: absent -> present sha256=[0-9a-f]{64}/);
  assert.match(report, /- bots\/AGENTS\.md: absent -> present sha256=[0-9a-f]{64}/);
  assert.match(report, /Review-plan checks: PASSED; pre-apply test suite NOT_RUN/);
  assert.match(report, /Post-apply verification: PASSED; verifyRules\(\) returned verified:true; rules sha256 [0-9a-f]{16}…/);
  assert.match(report, /Additional automated tests: NOT_RUN by the runtime repair path/);
  assert.equal(report.includes(TEMPLATE), false, 'report records hashes and states, not file contents');
  assert.equal(detect(paths(s)).defect, null);
});

test('a verified fix is idempotent: retry adds no report and no second chat', async () => {
  const s = sandbox();
  const sent = [];
  await repairFixture(s, {sendChat: (m) => { sent.push(m); return true; }});
  const again = await repairFixture(s, {sendChat: (m) => { sent.push(m); return true; }});
  assert.equal(again.status, 'already-fixed');
  assert.equal(again.duplicate, true);
  assert.equal(sent.length, 1);
  assert.equal(reports(s).length, 1);
});

test('a genuine recurrence of the same defect is repaired again, never suppressed', async () => {
  const s = sandbox();
  const sent = [];
  const sendChat = (m, {sendId}) => {
    const match = /^singularity-maintainer-([a-f0-9]{16})-(\d+)$/.exec(sendId);
    assert.ok(match);
    const row = outbox(s).pending[sendId];
    assert.ok(row, 'the fixed occurrence is pending before the sender is called');
    assert.equal(row.fingerprint, match[1]);
    assert.equal(row.occurrence, Number(match[2]));
    const evidence = ledger(s).fixes[match[1]];
    assert.equal(evidence.sendId, sendId);
    assert.equal(evidence.occurrences, Number(match[2]));
    assert.equal(evidence.chatDelivered, false);
    sent.push(sendId);
    sent.push(m);
    return true;
  };
  const first = await repairFixture(s, {sendChat});
  assert.equal(first.status, 'fixed-and-verified');
  assert.equal(first.occurrences, 1);
  assert.equal(first.chatDelivered, true);
  assert.match(first.sendId, /-1$/);
  rmSync(rules(s), {force: true});                        // the same defect recurs
  assert.equal(detect(paths(s)).defect, 'OMB_SHARED_RULES_MISSING');
  const second = await repairFixture(s, {sendChat});
  assert.equal(second.status, 'fixed-and-verified');
  assert.equal(second.duplicate, false);
  assert.equal(second.recurrence, true);
  assert.equal(second.occurrences, 2);
  assert.match(second.sendId, /-2$/);
  assert.notEqual(second.sendId, first.sendId);
  assert.equal(existsSync(rules(s)), true);
  assert.equal(reports(s).length, 2);
  assert.equal(sent.filter((value) => typeof value === 'string' && value.startsWith('singularity-maintainer-')).length, 2);
  assert.equal(detect(paths(s)).defect, null);
});

test('an unacknowledged chat is queued with a stable send id and retried once, then delivered', async () => {
  const s = sandbox();
  const first = await repairFixture(s, {sendChat: (_message, {sendId}) => {
    const row = outbox(s).pending[sendId];
    assert.ok(row, 'outbox row is persisted before the sender call');
    assert.equal(row.attempts, 0);
    assert.equal(row.sendId, sendId);
    assert.equal(row.occurrence, 1);
    const match = /^singularity-maintainer-([a-f0-9]{16})-1$/.exec(sendId);
    assert.ok(match);
    assert.equal(ledger(s).fixes[match[1]].sendId, sendId, 'occurrence evidence is durable before send');
    assert.equal(ledger(s).fixes[match[1]].occurrences, 1);
    return false;
  }});
  assert.equal(first.status, 'fixed-and-verified');
  assert.equal(first.chatDelivered, false);
  assert.equal(first.chatState, 'CHAT_DELIVERY_PENDING');
  const queued = outbox(s).pending;
  assert.equal(Object.keys(queued).length, 1);
  const key = Object.keys(queued)[0];
  assert.equal(queued[key].attempts, 1);

  const sends = [];
  const retry = await repairFixture(s, {
    sendChat: (message, opts) => {
      const row = outbox(s).pending[opts.sendId];
      assert.ok(row, 'the retry uses the original durable row');
      assert.equal(row.fingerprint, queued[key].fingerprint);
      assert.equal(row.occurrence, queued[key].occurrence);
      assert.equal(ledger(s).fixes[row.fingerprint].sendId, opts.sendId);
      sends.push(opts.sendId);
      return {acknowledged: true};
    }});
  assert.equal(retry.status, 'already-fixed');           // no repair, only the retry
  assert.equal(retry.chatRetried, 1);
  assert.equal(retry.chatPending, 0);
  assert.deepEqual(sends, [queued[key].sendId]);          // same idempotency key, sent once
  assert.equal(Object.keys(outbox(s).pending).length, 0);
  assert.equal(ledger(s).fixes[queued[key].fingerprint].chatDelivered, true);
  assert.match(reportText(s), /OpenMausBot chat delivery: acknowledged/);

  const third = await repairFixture(s, {sendChat: () => { throw new Error('must not be called'); }});
  assert.equal(third.chatRetried, 0);
});

test('a queued fixed occurrence recovers its send id after interruption before the ledger commit', async () => {
  const s = sandbox();
  const now = Date.parse('2026-11-10T10:15:00.000Z');
  let senderCalls = 0;
  const first = await repairFixture(s, {now, sendChat: () => { senderCalls++; return true; },
    deps: {afterFixedOutboxQueue: () => { throw new Error('INTERRUPTED_AFTER_QUEUE_COMMIT'); }}});
  assert.equal(first.status, 'fixed-and-verified');
  assert.equal(first.chatDelivered, false);
  assert.equal(first.chatState, 'unavailable');
  assert.equal(first.chatQueued, true);
  assert.equal(senderCalls, 0, 'a sender is never called before occurrence evidence commits');
  assert.deepEqual(ledger(s).fixes, {}, 'the injected interruption is between the durable queue and ledger writes');
  const pendingBeforeRecovery = Object.values(outbox(s).pending);
  assert.equal(pendingBeforeRecovery.length, 1);
  const original = pendingBeforeRecovery[0];
  assert.equal(original.occurrence, 1);
  assert.equal(original.fingerprint.length, 16);

  let retriedId;
  const retry = await repairFixture(s, {now: now + 1000, sendChat: (message, {sendId}) => {
    const row = outbox(s).pending[sendId];
    assert.ok(row, 'the original durable row is present before retry delivery');
    assert.equal(sendId, original.sendId);
    assert.equal(row.occurrence, 1);
    assert.equal(ledger(s).fixes[original.fingerprint].sendId, sendId);
    assert.equal(ledger(s).fixes[original.fingerprint].occurrences, 1);
    retriedId = sendId;
    return {acknowledged: true};
  }});
  assert.equal(retry.status, 'already-fixed');
  assert.equal(retry.chatRetried, 1);
  assert.equal(retry.chatPending, 0);
  assert.equal(retriedId, original.sendId);
  assert.equal(Object.keys(outbox(s).pending).length, 0);
  assert.equal(ledger(s).fixes[original.fingerprint].chatDelivered, true);
  assert.match(reportText(s), /OpenMausBot chat delivery: acknowledged/);

  rmSync(rules(s), {force: true});
  const recurrence = await repairFixture(s, {now: now + 2000, sendChat: (_message, {sendId}) => {
    assert.ok(outbox(s).pending[sendId]);
    assert.equal(ledger(s).fixes[original.fingerprint].occurrences, 2);
    return true;
  }});
  assert.equal(recurrence.occurrences, 2);
  assert.notEqual(recurrence.sendId, original.sendId);
  assert.match(recurrence.sendId, /-2$/);
});

test('a pending fixed row acknowledged during a later blocked run is committed to the ledger, so the next recurrence is occurrence 2', async () => {
  const s = sandbox();
  const now = Date.parse('2026-11-10T11:00:00.000Z');
  const first = await repairFixture(s, {now, sendChat: () => false});
  assert.equal(first.status, 'fixed-and-verified');
  assert.equal(first.chatState, 'CHAT_DELIVERY_PENDING');
  const fixedRow = Object.values(outbox(s).pending)[0];
  assert.equal(fixedRow.occurrence, 1);
  assert.notEqual(ledger(s).fixes[fixedRow.fingerprint].chatDelivered, true);

  // A user edit makes the next run approval-blocked; the sender acknowledges only the old FIXED row.
  writeFileSync(rules(s), 'user owned instructions\n');
  const blocked = await repairFixture(s, {now: now + 1000, sendChat: (_message, {sendId}) =>
    sendId === fixedRow.sendId ? {acknowledged: true} : false});
  assert.equal(blocked.status, 'approval-blocked');
  const pending = outbox(s).pending;
  assert.equal(pending[fixedRow.sendId], undefined, 'the acknowledged FIXED row left the outbox');
  assert.equal(Object.keys(pending).length, 1, 'the new blocked message stays pending');
  assert.equal(ledger(s).fixes[fixedRow.fingerprint].chatDelivered, true,
    'acknowledgement through the blocked path is committed to the ledger');

  rmSync(rules(s), {force: true});
  const recurrence = await repairFixture(s, {now: now + 2000, sendChat: () => true});
  assert.equal(recurrence.occurrences, 2);
  assert.match(recurrence.sendId, /-2$/);
  assert.notEqual(recurrence.sendId, fixedRow.sendId);
});

test('an orphaned fixed row (queued, ledger never committed) acknowledged by a blocked run still advances the occurrence', async () => {
  const s = sandbox();
  const now = Date.parse('2026-11-10T12:00:00.000Z');
  await repairFixture(s, {now, sendChat: () => true,
    deps: {afterFixedOutboxQueue: () => { throw new Error('INTERRUPTED_AFTER_QUEUE_COMMIT'); }}});
  assert.deepEqual(ledger(s).fixes, {});
  const orphan = Object.values(outbox(s).pending)[0];

  writeFileSync(rules(s), 'user owned instructions\n');
  const blocked = await repairFixture(s, {now: now + 1000, sendChat: (_m, {sendId}) =>
    sendId === orphan.sendId ? {acknowledged: true} : false});
  assert.equal(blocked.status, 'approval-blocked');
  assert.equal(outbox(s).pending[orphan.sendId], undefined);
  assert.equal(ledger(s).fixes[orphan.fingerprint].occurrences, 1);
  assert.equal(ledger(s).fixes[orphan.fingerprint].chatDelivered, true);

  rmSync(rules(s), {force: true});
  const recurrence = await repairFixture(s, {now: now + 2000, sendChat: () => true});
  assert.equal(recurrence.occurrences, 2);
  assert.match(recurrence.sendId, /-2$/);
});

test('a fixed repair does not send when the outbox path is unsafe', async () => {
  const s = sandbox();
  const maintenance = join(s.home, 'reports', 'maintenance');
  mkdirSync(maintenance, {recursive: true});
  const outboxPath = join(maintenance, '.outbox.json');
  mkdirSync(outboxPath);
  let sendCount = 0;
  const r = await repairFixture(s, {sendChat: () => { sendCount++; return true; }});
  assert.equal(r.status, 'fixed-and-verified');
  assert.equal(r.chatDelivered, false);
  assert.equal(r.chatState, 'unavailable');
  assert.equal(r.chatQueued, false);
  assert.equal(r.chatPending, 0);
  assert.equal(r.chatReason, 'OUTBOX_PATH_UNSAFE');
  assert.equal(sendCount, 0);
  assert.equal(lstatSync(outboxPath).isDirectory(), true);
  const fix = Object.values(ledger(s).fixes)[0];
  assert.equal(fix.occurrences, 1);
  assert.equal(fix.chatDelivered, false);
  assert.ok(fix.sendId);
  assert.match(reportText(s), /OpenMausBot chat delivery: not queued \(OUTBOX_PATH_UNSAFE\)/);
});

test('fixed report collisions preserve existing bytes and never point the notice or ledger at them', async () => {
  const s = sandbox();
  const now = Date.parse('2026-11-10T10:20:00.000Z');
  const fingerprint = sha(Buffer.from('OMB_SHARED_RULES_MISSING|absent')).slice(0, 16);
  const stamp = new Date(now).toISOString().replace(/[:.]/g, '-');
  const collision = join(s.home, 'reports', 'maintenance', `${stamp}-${fingerprint}.md`);
  mkdirSync(dirname(collision), {recursive: true});
  const foreignBytes = Buffer.from('pre-existing report must remain unchanged\n');
  writeFileSync(collision, foreignBytes);
  const messages = [];
  const r = await repairFixture(s, {now, sendChat: (message, {sendId}) => {
    messages.push(message);
    assert.ok(outbox(s).pending[sendId]);
    assert.equal(ledger(s).fixes[fingerprint].report, null);
    return true;
  }});
  assert.equal(r.status, 'fixed-and-verified');
  assert.equal(r.report, null);
  assert.equal(r.reportState, 'unavailable');
  assert.equal(r.reportReason, 'EEXIST');
  assert.equal(r.chatDelivered, true);
  assert.deepEqual(readFileSync(collision), foreignBytes);
  assert.equal(reports(s).length, 1);
  assert.equal(ledger(s).fixes[fingerprint].report, null);
  assert.equal(messages.length, 1);
  assert.match(messages[0], /Report: unavailable \(EEXIST\)$/);
  assert.equal(messages[0].includes(basename(collision)), false);
});

test('a throwing sender keeps the message pending with an attempt count', async () => {
  const s = sandbox();
  await repairFixture(s, {sendChat: () => { throw new Error('OMB_CHAT_UNREACHABLE'); }});
  await repairFixture(s, {sendChat: () => { throw new Error('OMB_CHAT_UNREACHABLE'); }});
  const entry = Object.values(outbox(s).pending)[0];
  assert.ok(entry, 'the message is still queued');
  assert.equal(entry.attempts >= 2, true);
  assert.match(entry.lastError, /OMB_CHAT_UNREACHABLE/);
});

test('a user-modified AGENTS.md is preserved and reported approval-blocked', async () => {
  const s = sandbox({withRules: true, rules: 'user owned instructions\n'});
  const before = readFileSync(rules(s), 'utf8');
  const r = await repairFixture(s);
  assert.equal(r.status, 'approval-blocked');
  assert.equal(r.reason, 'OWNED_FILE_MODIFIED_BY_USER');
  assert.equal(r.reportState, 'written');
  assert.equal(r.chatState, 'CHAT_DELIVERY_PENDING');
  assert.equal(readFileSync(rules(s), 'utf8'), before);
  assert.equal(reports(s).length, 1);
  assert.match(reportText(s), /Root cause: The shared rules were modified outside the receipt-owned template; user content was preserved\./);
  assert.doesNotMatch(reportText(s), /user owned instructions/);
  assert.equal(Object.keys(outbox(s).pending).length, 1);
});

test('a stale receipt over an identical file is repaired without touching user content', async () => {
  const s = sandbox({withRules: true, rules: TEMPLATE, withReceipt: true});
  const beforeRulesSha = sha(readFileSync(rules(s)));
  assert.equal(detect(paths(s)).defect, 'OMB_RULES_RECEIPT_DRIFT');
  const r = await repairFixture(s);
  assert.equal(r.status, 'fixed-and-verified');
  const report = reportText(s);
  assert.match(report, /Root cause: The shared rules match the current template, but the ownership receipt failed schema, target, or hash verification\./);
  assert.match(report, new RegExp(`- bots/AGENTS\\.md: present sha256=${beforeRulesSha} -> present sha256=${beforeRulesSha}`));
  assert.match(report, /- bots\/\.singularity-openmausbot-rules\.json: present sha256=[0-9a-f]{64} -> present sha256=[0-9a-f]{64}/);
  assert.equal(detect(paths(s)).defect, null);
});

test('failed verification restores the original bytes and says so only after readback', async () => {
  const s = sandbox({withRules: true, rules: TEMPLATE, withReceipt: true});
  const receipt = join(s.dataDir, 'bots', '.singularity-openmausbot-rules.json');
  const beforeReceipt = readFileSync(receipt, 'utf8');
  const r = await repairFixture(s, {
    deps: {verifyRules: () => { throw new Error('RULES_NOT_INSTALLED_OR_CHANGED'); }},
  });
  assert.equal(r.status, 'attempted-unverified');
  assert.equal(r.rollback, 'restored-and-verified');
  assert.equal(r.reason, 'RULES_NOT_INSTALLED_OR_CHANGED');
  assert.equal(readFileSync(receipt, 'utf8'), beforeReceipt);   // original state back
  assert.equal(r.reportState, 'written');
  assert.equal(reports(s).length, 1);
  assert.match(reportText(s), /Verdict: ROLLED_BACK/);
  assert.match(reportText(s), /Post-apply verification: FAILED/);
  assert.match(reportText(s), /Rollback: restored-and-verified/);
  assert.match(reportText(s), /post-rollback targets .*bots\/\.singularity-openmausbot-rules\.json=present sha256=[0-9a-f]{64}/);
  assert.equal(r.chatDelivered, false);
});

test('a failing restore is reported as rollback-failed, never as restored', async () => {
  const s = sandbox({withRules: true, rules: TEMPLATE, withReceipt: true});
  const r = await repairFixture(s, {
    deps: {verifyRules: () => { throw new Error('RULES_NOT_INSTALLED_OR_CHANGED'); },
      restoreWrite: () => { throw new Error('EACCES'); }},
  });
  assert.equal(r.status, 'attempted-unverified');
  assert.equal(r.rollback, 'rollback-skipped-or-failed:EACCES');
  assert.equal(r.reportState, 'written');
  assert.match(reportText(s), /Verdict: NOT_VERIFIED/);
  assert.match(reportText(s), /Rollback: rollback-skipped-or-failed:EACCES/);
  assert.equal(r.chatDelivered, false);
});

test('rollback leaves newer foreign target bytes intact and reports the observed state', async () => {
  const s = sandbox({withRules: true, rules: TEMPLATE, withReceipt: true});
  const externalRules = Buffer.from('newer user-owned rules after the repair write\n');
  const receiptPath = join(s.dataDir, 'bots', '.singularity-openmausbot-rules.json');
  const r = await repairFixture(s, {deps: {verifyRules: () => {
    const receipt = readFileSync(receiptPath, 'utf8');
    if (!receipt.includes(sha(Buffer.from(TEMPLATE)))) {
      throw new Error('RULES_NOT_INSTALLED_OR_CHANGED');
    }
    writeFileSync(rules(s), externalRules);
    throw new Error('RULES_NOT_INSTALLED_OR_CHANGED');
  }}});
  assert.equal(r.status, 'attempted-unverified');
  assert.equal(r.rollback, 'rollback-skipped-or-failed:UNKNOWN_TARGET_STATE_PRESERVED');
  assert.deepEqual(readFileSync(rules(s)), externalRules);
  assert.equal(r.reportState, 'written');
  assert.match(reportText(s), /Verdict: NOT_VERIFIED/);
  assert.match(reportText(s), /post-rollback targets .*bots\/AGENTS\.md=present sha256=[0-9a-f]{64}/);
  assert.match(reportText(s), /Operator action: inspect the target readback and rollback state before any live reload/);
});

test('failed verification with the original baseline intact reports no rollback write', async () => {
  const s = sandbox();                                   // bots dir, no rules, no receipt
  const r = await repairFixture(s, {
    deps: {installRules: () => {}, verifyRules: () => { throw new Error('RULES_NOT_INSTALLED_OR_CHANGED'); }},
  });
  assert.equal(r.status, 'attempted-unverified');
  assert.equal(r.rollback, 'restored-and-verified');
  assert.equal(r.reportState, 'written');
  assert.match(reportText(s), /Verdict: ROLLED_BACK/);
  assert.match(reportText(s), /Rollback: restored-and-verified/);
  assert.match(reportText(s), /post-rollback targets .*bots\/AGENTS\.md=absent/);
});

test('a concurrent run is refused by the exclusive lock instead of repairing twice', async () => {
  const s = sandbox();
  const dir = join(s.home, 'reports', 'maintenance');
  mkdirSync(dir, {recursive: true});
  writeFileSync(join(dir, '.lock'), JSON.stringify({pid: process.pid, at: new Date().toISOString()}));
  const sent = [];
  const r = await repairFixture(s, {sendChat: (m) => { sent.push(m); return true; }});
  assert.equal(r.status, 'busy');
  assert.equal(r.reason, 'MAINTENANCE_LOCK_HELD');
  assert.equal(existsSync(rules(s)), false);
  assert.equal(sent.length, 0);
  assert.equal(reports(s).length, 0);
});

test('a stale lock from a dead process is replaced and the repair proceeds', async () => {
  const s = sandbox();
  const dir = join(s.home, 'reports', 'maintenance');
  mkdirSync(dir, {recursive: true});
  writeFileSync(join(dir, '.lock'), JSON.stringify({pid: 999999, at: new Date(0).toISOString()}));
  const r = await repairFixture(s);
  assert.equal(r.status, 'fixed-and-verified');
  assert.equal(existsSync(join(dir, '.lock')), false);
});

test('an uninstalled OpenMausBot is not repaired', async () => {
  const s = sandbox();
  rmSync(join(s.dataDir, 'bots'), {recursive: true, force: true});
  const r = await repairFixture(s);
  assert.equal(r.status, 'unable-to-repair');
  assert.equal(r.changed.length, 0);
});

test('absolute locations are required', async () => {
  assert.throws(() => detect({home: './h', dataDir: '/d', workspace: '/w'}), /ABSOLUTE/);
});

test('the verified claim is split: files on disk versus the live bot and its gates', async () => {
  const s = sandbox();
  const r = await repairFixture(s);
  assert.equal(r.status, 'fixed-and-verified');
  assert.equal(r.onDiskVerified, true);
  assert.equal(r.loadedIntoActiveTurn, false);
  assert.equal(r.gateEnforcementVerified, false);
  assert.equal(r.reloadRequired, true);
  assert.match(String(r.operatorAction), /reload or restart/);
  const body = readFileSync(r.report, 'utf8');
  assert.match(body, /On-disk verification: verified/);
  assert.match(body, /Live gate enforcement: NOT VERIFIED/);
  assert.match(body, /Live bot loaded the rules: NOT VERIFIED/);
});

// --- production CLI boundary and occurrence identity ------------------------

function cliSandbox() {
  const fixture = createRepairFixtureHarness();
  const {root, dataDir} = fixture;
  const stage = join(root, 'stage', 'omb');
  mkdirSync(stage, {recursive: true});
  writeFileSync(join(stage, 'cli.js'), '');
  writeFileSync(join(dataDir, 'instance.json'), JSON.stringify({payload: stage, data_dir: dataDir,
    mode: 'headless-no-pair-task', task: 'pair_task_windows', port: 47123, pid: process.pid}));
  return {...fixture, stage};
}

function fakeVendor(state) {
  return (node, args, opts) => {
    const frames = String(opts.input || '').split('\n').filter(Boolean).map((line) => JSON.parse(line));
    const replies = [];
    for (const frame of frames) {
      if (frame.id === 1) {
        replies.push({jsonrpc: '2.0', id: 1,
          result: {protocolVersion: '2024-11-05', capabilities: {}, serverInfo: {name: 'fake'}}});
        continue;
      }
      if (frame.method !== 'tools/call') continue;
      const name = frame.params.name;
      state.calls.push(name);
      if (name === 'list_bots') {
        replies.push({jsonrpc: '2.0', id: frame.id,
          result: {structuredContent: {bots: [{id: 'bot-1', name: 'Singularity Maintainer'}]}}});
      } else if (name === 'send_bot_message') {
        state.sendIds.push(frame.params.arguments.send_id);
        replies.push({jsonrpc: '2.0', id: frame.id,
          result: {structuredContent: state.ack === false ? {} : {messageId: 'm-1'}}});
      } else {
        replies.push({jsonrpc: '2.0', id: frame.id, result: {structuredContent: {}}});
      }
    }
    return {status: 0, stdout: replies.map((r) => JSON.stringify(r)).join('\n') + '\n'};
  };
}


// Adapts the synchronous fake vendor to the async child-process shape the real
// chat sender spawns: each stdin line is answered on stdout, then EOF on kill.
function fakeChild(vendor) {
  return () => {
    const child = new EventEmitter();
    child.stdout = new PassThrough();
    child.stdin = new PassThrough();
    child.killed = false;
    let buf = '';
    child.stdin.on('data', (d) => {
      buf += d.toString();
      let i;
      while ((i = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, i); buf = buf.slice(i + 1);
        if (!line.trim()) continue;
        const out = vendor('node', [], {input: line + '\n'});
        if (out.stdout) child.stdout.write(out.stdout);
      }
    });
    child.kill = () => { child.killed = true; child.stdout.end(); setImmediate(() => child.emit('close')); };
    return child;
  };
}
test('the production CLI wires the reviewer adapter and vendor sender itself', async () => {
  const s = cliSandbox();
  const state = {calls: [], sendIds: []};
  const reviewAudit = [];
  const r = await s.runCli({spawnChild: fakeChild(fakeVendor(state)),
    reviewSpawn: fakeReviewSpawn({audit: reviewAudit})});
  assert.equal(r.status, 'fixed-and-verified');
  assert.equal(r.review.state, 'approved');
  assert.equal(reviewAudit.length, 1);
  assert.equal(reviewAudit[0].args.includes('--restricted'), false);
  assert.equal(reviewAudit[0].args.includes('--strict-mcp-config'), false);
  assert.equal(reviewAudit[0].args.includes('--no-session-persistence'), true);
  assert.equal(reviewAudit[0].args.includes('--setting-sources'), false);
  assert.equal(reviewAudit[0].args.includes('--settings'), false, 'existing user hooks remain enabled');
  assert.equal(r.chatDelivered, true);
  assert.equal(r.chatState, 'delivered');
  assert.ok(state.calls.includes('send_bot_message'), 'wired through the vendor MCP tools');
  assert.match(state.sendIds[0], /^singularity-maintainer-[0-9a-f]{16}-1$/);
  assert.equal(r.chatReason, undefined);
});

test('a recurrence sends a new id while the earlier pending message is retried, not replaced', async () => {
  const s = cliSandbox();
  const first = {calls: [], sendIds: [], ack: false};
  const r1 = await s.runCli({spawnChild: fakeChild(fakeVendor(first)), reviewSpawn: fakeReviewSpawn()});
  assert.equal(r1.chatState, 'CHAT_DELIVERY_PENDING');
  assert.match(r1.sendId, /-1$/);
  const box = JSON.parse(readFileSync(join(s.home, 'reports', 'maintenance', '.outbox.json'), 'utf8'));
  assert.deepEqual(Object.keys(box.pending), [r1.sendId]);

  rmSync(join(s.dataDir, 'bots', 'AGENTS.md'));
  const second = {calls: [], sendIds: []};
  const r2 = await s.runCli({spawnChild: fakeChild(fakeVendor(second)), reviewSpawn: fakeReviewSpawn()});
  assert.equal(r2.occurrences, 2);
  assert.match(r2.sendId, /-2$/);
  assert.notEqual(r2.sendId, r1.sendId);
  assert.ok(second.sendIds.includes(r1.sendId), 'the older pending occurrence is retried first');
  assert.ok(second.sendIds.includes(r2.sendId));
  const after = JSON.parse(readFileSync(join(s.home, 'reports', 'maintenance', '.outbox.json'), 'utf8'));
  assert.equal(Object.keys(after.pending).length, 0);
});

test('a corrupt outbox is quarantined as evidence instead of silently overwritten', async () => {
  const s = cliSandbox();
  const first = {calls: [], sendIds: [], ack: false};
  const r1 = await s.runCli({spawnChild: fakeChild(fakeVendor(first)), reviewSpawn: fakeReviewSpawn()});
  const dir = join(s.home, 'reports', 'maintenance');
  writeFileSync(join(dir, '.outbox.json'), '{"schema":1,"pending":{"truncated');
  rmSync(join(s.dataDir, 'bots', 'AGENTS.md'));
  const second = {calls: [], sendIds: []};
  const r2 = await s.runCli({spawnChild: fakeChild(fakeVendor(second)), reviewSpawn: fakeReviewSpawn()});
  const kept = readdirSync(dir).filter((f) => f.startsWith('.outbox.json.corrupt-'));
  assert.equal(kept.length, 1, 'the unreadable outbox is preserved');
  assert.match(readFileSync(join(dir, kept[0]), 'utf8'), /truncated/);
  assert.notEqual(r2.sendId, r1.sendId);
});

test('a corrupt ledger still yields a fresh sendId by salvaging the occurrence floor', async () => {
  const s = cliSandbox();
  const first = {calls: [], sendIds: [], ack: false};
  const r1 = await s.runCli({spawnChild: fakeChild(fakeVendor(first)), reviewSpawn: fakeReviewSpawn()});
  assert.match(r1.sendId, /-1$/);
  const dir = join(s.home, 'reports', 'maintenance');
  const good = readFileSync(join(dir, '.ledger.json'), 'utf8');
  writeFileSync(join(dir, '.ledger.json'), good.slice(0, good.length - 8));
  rmSync(join(s.dataDir, 'bots', 'AGENTS.md'));
  const second = {calls: [], sendIds: []};
  const r2 = await s.runCli({spawnChild: fakeChild(fakeVendor(second)), reviewSpawn: fakeReviewSpawn()});
  assert.match(r2.sendId, /-2$/, 'the sendId never repeats after ledger corruption');
  assert.equal(readdirSync(dir).filter((f) => f.startsWith('.ledger.json.corrupt-')).length, 1);
});

test('an unverifiable instance reports a bounded reason instead of claiming chat', async () => {
  const s = cliSandbox();
  rmSync(join(s.dataDir, 'instance.json'));
  const state = {calls: [], sendIds: []};
  const r = await s.runCli({spawnChild: fakeChild(fakeVendor(state)), reviewSpawn: fakeReviewSpawn()});
  assert.equal(r.status, 'fixed-and-verified');
  assert.equal(r.chatDelivered, false);
  assert.equal(r.chatReason, 'OMB_INSTANCE_RECORD_MISSING');
  assert.equal(state.calls.length, 0);
});
