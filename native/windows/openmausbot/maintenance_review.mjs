#!/usr/bin/env node
/** Narrow, read-only adapter from the owned repair path to Claude Code's
 * canonical singularity-code-reviewer subagent. No approval is accepted from
 * CLI arguments, caller text, or a parent-session final answer: the adapter
 * requires the actual Agent tool call and its matching tool_result in one
 * bounded, non-persistent stream-json invocation.
 */
import {spawn as nodeSpawn} from 'node:child_process';
import {existsSync, lstatSync, readFileSync} from 'node:fs';
import {createHash, randomUUID} from 'node:crypto';
import {dirname, isAbsolute, join, resolve} from 'node:path';
import {fileURLToPath} from 'node:url';
import {homedir} from 'node:os';

export const REVIEWER_NAME = 'singularity-code-reviewer';
export const REVIEW_REQUEST_SCHEMA = 'singularity-openmausbot-review-request/v1';
export const REVIEW_RECEIPT_SCHEMA = 'singularity-openmausbot-review-receipt/v1';
export const MAINTENANCE_REVIEW_REQUIREMENT =
  'Every nontrivial correction must pass an independent code review before it is applied to the active Windows installation. Use the existing Claude Code singularity-code-reviewer subagent. Supply the original requirement, failure evidence, exact proposed diff and relevant test results; obtain an explicit verdict against that exact diff. Only APPROVE may proceed. The Maintainer must repair evidence-backed defects while preserving user-modified content and existing ownership/security policy.';
export const MAINTENANCE_REPAIR_SCOPE =
  'Restore only the receipt-owned OpenMausBot shared rules and ownership receipt from the current product template. Preserve user-modified content and leave unrelated files and policy unchanged.';

const MAX_INPUT_BYTES = 128 * 1024;
const MAX_OUTPUT_BYTES = 1024 * 1024;
const MAX_STDERR_BYTES = 16 * 1024;
const REVIEW_TIMEOUT_MS = 120_000;
const TOOL_SET = ['Read', 'Grep', 'Glob'];
const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, '..', '..', '..');
const REVIEWER_PROFILE = join(REPO_ROOT, 'adapters', 'claude-code', 'agents', `${REVIEWER_NAME}.md`);

const sha = (value) => createHash('sha256').update(value).digest('hex');
const fail = (reason) => { throw new Error(reason); };

function exactText(bytes) {
  if (bytes === null) return null;
  if (!Buffer.isBuffer(bytes)) bytes = Buffer.from(bytes);
  const value = bytes.toString('utf8');
  if (!Buffer.from(value, 'utf8').equals(bytes)) fail('REVIEW_CONTENT_NOT_UTF8');
  return value;
}

function fileImage(path, bytes) {
  const text = exactText(bytes);
  return {
    path,
    exists: bytes !== null,
    sha256: bytes === null ? null : sha(bytes),
    text,
    base64: bytes === null ? null : bytes.toString('base64'),
  };
}

/** Build one canonical request from the exact before/after bytes. `files` is
 * limited to the two receipt-owned files used by maintenance_repair.mjs. */
export function buildReviewRequest({defect, files, context, nonce = randomUUID()}) {
  if (!['OMB_SHARED_RULES_MISSING', 'OMB_RULES_RECEIPT_DRIFT'].includes(defect)) fail('REVIEW_DEFECT_INVALID');
  if (!Array.isArray(files) || files.length < 1 || files.length > 2) fail('REVIEW_FILES_INVALID');
  if (typeof nonce !== 'string' || !/^[0-9a-f-]{36}$/i.test(nonce)) fail('REVIEW_NONCE_INVALID');
  const sorted = [...files].sort((a, b) => a.path.localeCompare(b.path));
  const images = sorted.map(({path, before, after}) => {
    if (typeof path !== 'string' || !path || isAbsolute(path) || path.includes('..') || path.includes('\\'))
      fail('REVIEW_PATH_INVALID');
    if (after === null) fail('REVIEW_AFTER_REQUIRED');
    const beforeBytes = before === null ? null : Buffer.from(before);
    const afterBytes = Buffer.from(after);
    return {path, before: fileImage(path, beforeBytes), after: fileImage(path, afterBytes)};
  });
  if (!context || typeof context !== 'object' || Array.isArray(context) ||
      context.requirement !== MAINTENANCE_REVIEW_REQUIREMENT || context.scope !== MAINTENANCE_REPAIR_SCOPE)
    fail('REVIEW_CONTEXT_REQUIRED');
  const evidence = context.evidence;
  if (!evidence || typeof evidence !== 'object' || Array.isArray(evidence) || evidence.defect !== defect ||
      !['absent', 'matching'].includes(evidence.detectorState) ||
      !['RULES_FILE_ABSENT', 'RULES_NOT_INSTALLED_OR_CHANGED', 'RULES_RECEIPT_INVALID', 'RULES_VERIFICATION_FAILED'].includes(evidence.causeCode) ||
      typeof evidence.rootCause !== 'string' || !evidence.rootCause || evidence.rootCause.length > 256 ||
      !/^[0-9a-f]{64}$/.test(evidence.desiredTemplateSha256) || !Array.isArray(evidence.beforeImages))
    fail('REVIEW_EVIDENCE_REQUIRED');
  const actualBeforeImages = images.map(({path, before}) => ({path, present: before.exists, sha256: before.sha256}));
  if (JSON.stringify(evidence.beforeImages) !== JSON.stringify(actualBeforeImages) ||
      evidence.desiredTemplateSha256 !== images.find(({path}) => path === 'bots/AGENTS.md')?.after.sha256)
    fail('REVIEW_EVIDENCE_MISMATCH');
  const checks = context.checks;
  if (!checks || typeof checks !== 'object' ||
      checks.detectionStatus !== 'FAILED_EXPECTED' || typeof checks.detectionResult !== 'string' ||
      checks.planRulesStatus !== 'PASSED' || checks.preApplyTests !== 'NOT_RUN' ||
      checks.postApplyVerification !== 'NOT_RUN') fail('REVIEW_CHECK_STATUS_REQUIRED');
  let contextText;
  try { contextText = JSON.stringify({requirement: context.requirement, scope: context.scope, evidence, checks}); }
  catch { fail('REVIEW_CONTEXT_INVALID'); }
  if (Buffer.byteLength(contextText, 'utf8') > 16 * 1024) fail('REVIEW_CONTEXT_TOO_LARGE');
  const beforeHash = sha(JSON.stringify(images.map(({path, before}) => ({path, before}))));
  const afterHash = sha(JSON.stringify(images.map(({path, after}) => ({path, after}))));
  const diffContent = JSON.stringify({schema: `${REVIEW_REQUEST_SCHEMA}/diff`, defect,
    context: {requirement: context.requirement, scope: context.scope, evidence, checks}, files: images});
  const diffHash = sha(diffContent);
  const payload = {schema: REVIEW_REQUEST_SCHEMA, nonce, reviewer: REVIEWER_NAME,
    defect, beforeHash, afterHash, diffHash, diffContent};
  const payloadText = JSON.stringify(payload);
  if (Buffer.byteLength(payloadText, 'utf8') > MAX_INPUT_BYTES) fail('REVIEW_INPUT_TOO_LARGE');
  return {...payload, payloadText};
}

function parseProfile(raw) {
  const match = /^---\r?\n([\s\S]*?)\r?\n---\r?\n([\s\S]*)$/.exec(raw);
  if (!match) fail('REVIEW_PROFILE_INVALID');
  const name = /^name:\s*(.+?)\s*$/m.exec(match[1])?.[1];
  const description = /^description:\s*(.+?)\s*$/m.exec(match[1])?.[1];
  const tools = /^tools:\s*(.+?)\s*$/m.exec(match[1])?.[1]?.split(',').map((tool) => tool.trim());
  if (name !== REVIEWER_NAME || !description || !tools ||
      tools.length !== TOOL_SET.length || tools.some((tool, i) => tool !== TOOL_SET[i]))
    fail('REVIEW_PROFILE_CAPABILITY_MISMATCH');
  return {name, description, tools, prompt: match[2].trim(), profileSha256: sha(raw)};
}

export function readCanonicalReviewerProfile() {
  try {
    if (!existsSync(REVIEWER_PROFILE) || lstatSync(REVIEWER_PROFILE).isSymbolicLink() ||
        !lstatSync(REVIEWER_PROFILE).isFile()) return {ok: false, reason: 'REVIEW_PROFILE_UNAVAILABLE'};
    const raw = readFileSync(REVIEWER_PROFILE, 'utf8');
    return {ok: true, profile: parseProfile(raw)};
  } catch (error) {
    return {ok: false, reason: error?.message === 'REVIEW_PROFILE_CAPABILITY_MISMATCH' ||
      error?.message === 'REVIEW_PROFILE_INVALID' ? error.message : 'REVIEW_PROFILE_UNAVAILABLE'};
  }
}

export function buildReviewerPrompt(request, profileSha256) {
  const exactPayload = JSON.stringify({
    schema: request.schema,
    nonce: request.nonce,
    reviewer: request.reviewer,
    defect: request.defect,
    beforeHash: request.beforeHash,
    afterHash: request.afterHash,
    diffHash: request.diffHash,
    reviewerProfileSha256: profileSha256,
    diffContent: request.diffContent,
  });
  return [
    'Review this exact proposed OpenMausBot maintenance repair using your canonical reviewer instructions.',
    'Use read-only source inspection only. Do not edit, execute, delegate, or approve from this prompt alone.',
    'Review the complete before/after content and hashes in the request payload below.',
    'Review the supplied original requirement, observed failure evidence, and check statuses. NOT_RUN means the check was not executed; never treat it as a pass.',
    'Return exactly one JSON object and no surrounding prose, using schema ' + REVIEW_RECEIPT_SCHEMA + '.',
    'The object must contain schema, nonce, reviewer, reviewerProfileSha256, beforeHash, afterHash, diffHash, decision, and findings.',
    'Set decision to APPROVE only when the repair is safe and correct with no blocking finding; otherwise set REJECT and list findings.',
    'Copy nonce, reviewerProfileSha256, beforeHash, afterHash, and diffHash exactly from the payload.',
    'REQUEST_JSON=' + exactPayload,
  ].join('\n');
}

function buildDispatcherPrompt(reviewerPrompt) {
  return [
    'You are a transient, read-only dispatcher. Call the Agent tool exactly once.',
    `Set subagent_type to ${JSON.stringify(REVIEWER_NAME)} and prompt to the exact JSON string value that follows.`,
    'Do not use another tool, change the prompt, summarize a verdict, or approve on your own.',
    'After the Agent tool returns, finish without adding an approval statement.',
    'AGENT_PROMPT_JSON=' + JSON.stringify(reviewerPrompt),
  ].join('\n');
}

function toolBlocks(events) {
  const calls = [];
  const results = [];
  for (const event of events) {
    const blocks = event?.message?.content ?? event?.content;
    if (!Array.isArray(blocks)) continue;
    for (const block of blocks) {
      if (block?.type === 'tool_use') calls.push(block);
      if (block?.type === 'tool_result') results.push(block);
    }
  }
  return {calls, results};
}

function resultText(block) {
  if (typeof block.content === 'string') return block.content;
  if (!Array.isArray(block.content) || block.content.length !== 1 ||
      block.content[0]?.type !== 'text' || typeof block.content[0]?.text !== 'string') return null;
  return block.content[0].text;
}

function parseReceipt(text, expected) {
  if (typeof text !== 'string') return {status: 'invalid', reason: 'REVIEW_RESULT_NOT_TEXT'};
  let value;
  try { value = JSON.parse(text.trim()); } catch { return {status: 'invalid', reason: 'REVIEW_RECEIPT_INVALID'}; }
  if (!value || typeof value !== 'object' || Array.isArray(value))
    return {status: 'invalid', reason: 'REVIEW_RECEIPT_INVALID'};
  if (value.schema !== REVIEW_RECEIPT_SCHEMA || value.reviewer !== REVIEWER_NAME)
    return {status: 'invalid', reason: 'REVIEW_RECEIPT_IDENTITY_MISMATCH'};
  if (value.nonce !== expected.nonce) return {status: 'invalid', reason: 'REVIEW_RECEIPT_STALE'};
  if (value.reviewerProfileSha256 !== expected.reviewerProfileSha256 ||
      value.beforeHash !== expected.beforeHash || value.afterHash !== expected.afterHash ||
      value.diffHash !== expected.diffHash)
    return {status: 'invalid', reason: 'REVIEW_RECEIPT_HASH_MISMATCH'};
  if (!Array.isArray(value.findings)) return {status: 'invalid', reason: 'REVIEW_FINDINGS_INVALID'};
  if (value.decision === 'REJECT') return {status: 'rejected', reason: 'REVIEWER_REJECTED', findings: value.findings};
  if (value.decision !== 'APPROVE' || value.findings.length !== 0)
    return {status: 'invalid', reason: 'REVIEW_APPROVAL_INVALID'};
  return {status: 'approved', approved: true, reviewer: REVIEWER_NAME,
    nonce: value.nonce, reviewerProfileSha256: value.reviewerProfileSha256,
    beforeHash: value.beforeHash, afterHash: value.afterHash, diffHash: value.diffHash,
    traceVerified: true, findings: []};
}

/** Accept approval only from the tool_result paired to the one exact Agent call.
 * The final dispatcher text is intentionally ignored. */
export function parseReviewerTrace(raw, expected) {
  if (typeof raw !== 'string' || Buffer.byteLength(raw, 'utf8') > MAX_OUTPUT_BYTES)
    return {status: 'invalid', reason: 'REVIEW_TRACE_INVALID'};
  let events;
  try {
    const lines = raw.split(/\r?\n/).filter((line) => line.trim());
    if (!lines.length) return {status: 'invalid', reason: 'REVIEW_TRACE_EMPTY'};
    events = lines.map((line) => JSON.parse(line));
  } catch { return {status: 'invalid', reason: 'REVIEW_TRACE_MALFORMED'}; }
  const {calls, results} = toolBlocks(events);
  if (calls.length !== 1 || calls[0].name !== 'Agent')
    return {status: 'invalid', reason: 'REVIEW_AGENT_CALL_MISSING_OR_EXTRA'};
  const call = calls[0];
  if (!call.id || call.input?.subagent_type !== REVIEWER_NAME || call.input?.prompt !== expected.prompt)
    return {status: 'invalid', reason: 'REVIEW_AGENT_CALL_MISMATCH'};
  if (results.length !== 1 || results[0].tool_use_id !== call.id)
    return {status: 'invalid', reason: 'REVIEW_TOOL_RESULT_MISMATCH'};
  if (results[0].is_error === true) return {status: 'unavailable', reason: 'REVIEW_AGENT_TOOL_ERROR'};
  const terminal = events.filter((event) => event?.type === 'result');
  if (terminal.length !== 1 || terminal[0].subtype !== 'success' || terminal[0].is_error !== false)
    return {status: 'unavailable', reason: 'REVIEW_CLI_INCOMPLETE'};
  return parseReceipt(resultText(results[0]), expected);
}

function defaultCliPath() {
  const profile = process.env.USERPROFILE;
  const userHome = typeof profile === 'string' && profile ? profile : homedir();
  return join(userHome, '.local', 'bin', 'claude.exe');
}

function runBounded({command, args, input, cwd, env, spawnImpl, timeoutMs}) {
  return new Promise((resolveResult) => {
    let child;
    let settled = false;
    let timedOut = false;
    let overflow = false;
    let stdoutBytes = 0;
    let stderrBytes = 0;
    const stdout = [];
    const stderr = [];
    const finish = (result) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolveResult(result);
    };
    const kill = () => { try { child?.kill(); } catch {} };
    let timer;
    try {
      child = spawnImpl(command, args, {cwd, env, shell: false, windowsHide: true,
        stdio: ['pipe', 'pipe', 'pipe']});
    } catch {
      finish({ok: false, reason: 'REVIEW_CLI_START_FAILED'});
      return;
    }
    timer = setTimeout(() => {
      timedOut = true;
      kill();
      setTimeout(() => finish({ok: false, reason: 'REVIEW_TIMEOUT'}), 1000).unref?.();
    }, timeoutMs);
    timer.unref?.();
    child.stdout?.on('data', (chunk) => {
      const bytes = Buffer.from(chunk);
      stdoutBytes += bytes.length;
      if (stdoutBytes > MAX_OUTPUT_BYTES) { overflow = true; kill(); return; }
      stdout.push(bytes);
    });
    child.stderr?.on('data', (chunk) => {
      const bytes = Buffer.from(chunk);
      stderrBytes += bytes.length;
      if (stderrBytes <= MAX_STDERR_BYTES) stderr.push(bytes);
      if (stderrBytes > MAX_STDERR_BYTES) { overflow = true; kill(); }
    });
    child.on('error', (error) => finish({ok: false,
      reason: error?.code === 'ENOENT' ? 'REVIEW_CLI_UNAVAILABLE' : 'REVIEW_CLI_START_FAILED'}));
    child.on('close', (code) => {
      if (timedOut) return finish({ok: false, reason: 'REVIEW_TIMEOUT'});
      if (overflow) return finish({ok: false, reason: 'REVIEW_OUTPUT_LIMIT'});
      if (code !== 0) return finish({ok: false, reason: 'REVIEW_CLI_UNAVAILABLE'});
      finish({ok: true, stdout: Buffer.concat(stdout).toString('utf8')});
    });
    if (!child.stdin) { kill(); finish({ok: false, reason: 'REVIEW_CLI_STDIN_UNAVAILABLE'}); return; }
    child.stdin.end(input, 'utf8');
  });
}

function parseTraceOptions(request, profile) {
  const reviewerPrompt = buildReviewerPrompt(request, profile.profileSha256);
  const prompt = buildDispatcherPrompt(reviewerPrompt);
  const agentDefinitions = JSON.stringify({
    [REVIEWER_NAME]: {description: profile.description, prompt: profile.prompt, tools: profile.tools},
  });
  const expected = {...request, reviewerProfileSha256: profile.profileSha256, prompt: reviewerPrompt};
  return {prompt, agentDefinitions, expected};
}

function validateCliPath(path, platform) {
  if (platform !== 'win32' || typeof path !== 'string' || !isAbsolute(path)) return false;
  try { return lstatSync(path).isFile() && !lstatSync(path).isSymbolicLink(); } catch { return false; }
}

export async function reviewCandidate(request, options = {}) {
  const {platform = process.platform, claudeExe = defaultCliPath(), spawnImpl = nodeSpawn,
    timeoutMs = REVIEW_TIMEOUT_MS} = options;
  const loaded = readCanonicalReviewerProfile();
  if (!loaded.ok) return {status: 'unavailable', reason: loaded.reason};
  if (!validateCliPath(claudeExe, platform)) return {status: 'unavailable', reason: 'REVIEW_CLI_UNAVAILABLE'};
  const {prompt, agentDefinitions, expected} = parseTraceOptions(request, loaded.profile);
  if (Buffer.byteLength(prompt, 'utf8') > MAX_INPUT_BYTES) return {status: 'unavailable', reason: 'REVIEW_INPUT_TOO_LARGE'};
  const args = [
    '--print', '--input-format', 'text', '--output-format', 'stream-json', '--verbose',
    '--forward-subagent-text', '--no-session-persistence',
    '--permission-mode', 'dontAsk',
    '--tools', 'Agent', '--allowedTools', `Agent(${REVIEWER_NAME})`, '--agents', agentDefinitions,
  ];
  const run = await runBounded({command: claudeExe, args, input: prompt, cwd: REPO_ROOT,
    env: process.env, spawnImpl, timeoutMs});
  if (!run.ok) return {status: 'unavailable', reason: run.reason};
  const profileAfter = readCanonicalReviewerProfile();
  if (!profileAfter.ok || profileAfter.profile.profileSha256 !== loaded.profile.profileSha256)
    return {status: 'invalid', reason: 'REVIEW_PROFILE_CHANGED_DURING_REVIEW'};
  return parseReviewerTrace(run.stdout, expected);
}

export function reviewMatchesRequest(result, request) {
  return result?.status === 'approved' && result.approved === true && result.traceVerified === true &&
    result.reviewer === REVIEWER_NAME && result.nonce === request.nonce &&
    result.beforeHash === request.beforeHash && result.afterHash === request.afterHash &&
    result.diffHash === request.diffHash && typeof result.reviewerProfileSha256 === 'string';
}

export function currentReviewerProfileHash() {
  const loaded = readCanonicalReviewerProfile();
  return loaded.ok ? loaded.profile.profileSha256 : null;
}
