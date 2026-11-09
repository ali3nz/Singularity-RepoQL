#!/usr/bin/env node
/** Active, bounded repair for the Singularity-owned OpenMausBot shared rules.
 *
 * Detection and the actual fix reuse `install_shared_rules.mjs` (the existing
 * owned installer/verifier): no second rules store, no scheduler, no polling.
 * The repair only restores a receipt-owned file; a user-modified AGENTS.md is
 * preserved and reported `approval-blocked`, never overwritten.
 *
 * Guarantees this module keeps, and their tests:
 * - Detection remains sensitive to genuine recurrences. Production blocks
 *   pre-existing targets until ownership, ACL and metadata can be preserved;
 *   only two absent targets can proceed through exclusive creation.
 *   Fixture recurrences exercise the full repair and reporting path.
 * - Chat is acknowledged, not assumed: an unacknowledged message is persisted in
 *   a durable outbox and retried on later runs. The `sendId` is stable across
 *   retries of one occurrence but changes for a genuine recurrence, so vendor
 *   de-duplication cannot swallow the second notification.
 * - The production CLI wires the real vendor sender itself (`ombChatSender`
 *   against the verified instance record); tests may inject one, production
 *   never leaves chat unreachable.
 * - Failed production creation can restore the reviewed absence of targets.
 *   Existing-file rollback is confined to capability-bound fixtures until full
 *   metadata preservation is supported.
 * - One exclusive lock spans detect -> repair -> report -> ledger, so concurrent
 *   runs or events cannot duplicate work.
 */
import {existsSync, mkdirSync, readFileSync, writeFileSync, copyFileSync, rmSync,
        openSync, closeSync, fsyncSync, renameSync, lstatSync, unlinkSync, readdirSync, mkdtempSync} from 'node:fs';
import {join, resolve, isAbsolute, dirname, parse, relative, sep, basename} from 'node:path';
import {createHash, randomUUID} from 'node:crypto';
import {fileURLToPath} from 'node:url';
import {homedir, tmpdir} from 'node:os';
import {planRules, installRules, verifyRules} from './install_shared_rules.mjs';
import {ombChatSender} from './omb_chat.mjs';
import {buildReviewRequest, reviewCandidate, reviewMatchesRequest, currentReviewerProfileHash,
        REVIEWER_NAME, REVIEW_REQUEST_SCHEMA, MAINTENANCE_REVIEW_REQUIREMENT,
        MAINTENANCE_REPAIR_SCOPE} from './maintenance_review.mjs';

const SCHEMA = 'singularity-windows-maintenance-repair/v1';
const RECEIPT = '.singularity-openmausbot-rules.json';
const LOCK_STALE_MS = 30 * 60 * 1000;
const fixtureCapabilities = new WeakMap();
const fail = (m) => { throw new Error(m); };
const sha = (x) => createHash('sha256').update(x).digest('hex');
const stamp = (now) => new Date(now).toISOString().replace(/[:.]/g, '-');
const short = (e) => String(e?.message || e).slice(0, 120);

function safeRulesFailureCode(error) {
  if (error?.message === 'RULES_NOT_INSTALLED_OR_CHANGED' || error?.message === 'RULES_RECEIPT_INVALID')
    return error.message;
  return 'RULES_VERIFICATION_FAILED';
}

function absPaths({home, dataDir, workspace}) {
  for (const [name, v] of Object.entries({home, dataDir, workspace})) {
    if (typeof v !== 'string' || !v || !isAbsolute(v)) fail(`${name.toUpperCase()}_MUST_BE_ABSOLUTE`);
  }
  return {home: resolve(home), dataDir: resolve(dataDir), workspace: resolve(workspace)};
}

function isWithin(root, target) {
  const rel = relative(root, target);
  return rel === '' || (!isAbsolute(rel) && rel !== '..' && !rel.startsWith(`..${sep}`));
}

function assertFixturePaths(paths, fixture) {
  const tempRoot = resolve(tmpdir());
  const root = resolve(fixture.root);
  if (root === tempRoot || !isWithin(tempRoot, root) || locationsOutsideRoot(paths, root) ||
      Object.keys(paths).some((name) => resolve(paths[name]) !== resolve(fixture.paths[name])))
    fail('FIXTURE_ROOT_NOT_ISOLATED');
  for (const location of [root, paths.home, paths.dataDir, paths.workspace]) {
    if (!isWithin(root, location)) fail('FIXTURE_ROOT_NOT_ISOLATED');
    for (let current = location; ; current = dirname(current)) {
      let info;
      try { info = lstatSync(current); } catch { fail('FIXTURE_PATH_UNAVAILABLE'); }
      if (info.isSymbolicLink() || !info.isDirectory()) fail('FIXTURE_REPARSE_PATH_REFUSED');
      if (current === tempRoot) break;
      if (!isWithin(tempRoot, current) || dirname(current) === current) fail('FIXTURE_ROOT_NOT_ISOLATED');
    }
  }
}

function locationsOutsideRoot(paths, root) {
  return [paths.home, paths.dataDir, paths.workspace].some((location) => !isWithin(root, location));
}

function layout(paths) {
  const reports = join(paths.home, 'reports', 'maintenance');
  return {
    home: paths.home,
    reports,
    ledger: join(reports, '.ledger.json'),
    outbox: join(reports, '.outbox.json'),
    lock: join(reports, '.lock'),
    backups: join(reports, '.backups'),
    stampFile: join(paths.dataDir, 'bots', RECEIPT),
    rules: join(paths.dataDir, 'bots', 'AGENTS.md'),
  };
}

function assertSafeReportDirectory(paths, l, create = false) {
  const expected = resolve(paths.home, 'reports', 'maintenance');
  if (resolve(l.reports) !== expected || relative(paths.home, l.reports) !== join('reports', 'maintenance'))
    fail('REPORT_PATH_INVALID');
  const root = parse(expected).root;
  let current = root;
  for (const segment of expected.slice(root.length).split(/[\\/]+/).filter(Boolean)) {
    current = join(current, segment);
    let info;
    try {
      info = lstatSync(current);
    } catch (error) {
      if (error?.code !== 'ENOENT') throw error;
      if (!create) fail('REPORT_PATH_UNAVAILABLE');
      try { mkdirSync(current, {mode: 0o700}); }
      catch (mkdirError) { if (mkdirError?.code !== 'EEXIST') throw mkdirError; }
      info = lstatSync(current);
    }
    if (info.isSymbolicLink() || !info.isDirectory()) fail('REPORT_PATH_UNSAFE');
  }
}

function assertSafeReportFile(paths, l, reportPath) {
  assertSafeReportDirectory(paths, l, false);
  if (resolve(dirname(reportPath)) !== resolve(l.reports)) fail('REPORT_PATH_INVALID');
  let info;
  try { info = lstatSync(reportPath); }
  catch (error) {
    if (error?.code === 'ENOENT') fail('REPORT_PATH_UNAVAILABLE');
    throw error;
  }
  if (info.isSymbolicLink() || !info.isFile()) fail('REPORT_PATH_UNSAFE');
}

function assertSafeOutbox(paths, l) {
  assertSafeReportDirectory(paths, l, false);
  if (resolve(l.outbox) !== resolve(l.reports, '.outbox.json')) fail('OUTBOX_PATH_INVALID');
  let info;
  try { info = lstatSync(l.outbox); }
  catch (error) {
    if (error?.code === 'ENOENT') return;
    throw error;
  }
  if (info.isSymbolicLink() || !info.isFile()) fail('OUTBOX_PATH_UNSAFE');
}

function readOutbox(paths, l) {
  assertSafeOutbox(paths, l);
  return readJson(l.outbox, (j) => j.schema === 1 && j.pending && typeof j.pending === 'object')
    ?? {schema: 1, pending: {}};
}

function writeOutbox(paths, l, box) {
  assertSafeOutbox(paths, l);
  atomicJson(l.outbox, box);
}

function updateReportNotification(paths, l, reportPath, state) {
  assertSafeReportFile(paths, l, reportPath);
  const before = readFileSync(reportPath);
  const marker = /^(- OpenMausBot chat delivery: |OpenMausBot chat delivery: ).*$/m;
  const body = before.toString('utf8');
  if (!marker.test(body)) fail('REPORT_NOTIFICATION_STATE_MISSING');
  const updated = body.replace(marker, (line) => `${line.startsWith('- ') ? '- ' : ''}OpenMausBot chat delivery: ${state}`);
  if (Buffer.byteLength(updated, 'utf8') > 8192) fail('REPORT_TOO_LARGE');
  const temporary = `${reportPath}.pending-${randomUUID()}`;
  let fd;
  try {
    fd = openSync(temporary, 'wx', 0o600);
    writeFileSync(fd, updated);
    fsyncSync(fd);
    closeSync(fd);
    fd = undefined;
    assertSafeReportFile(paths, l, reportPath);
    if (!readFileSync(reportPath).equals(before)) fail('REPORT_BASELINE_CHANGED');
    renameSync(temporary, reportPath);
  } catch (error) {
    if (fd !== undefined) { try { closeSync(fd); } catch {} }
    try { unlinkSync(temporary); } catch {}
    throw error;
  }
}

function writeBlockedReviewReport(paths, l, {now, defect, request, review, reason, context, backupState, currentEvidence}) {
  assertSafeReportDirectory(paths, l, false);
  const hash = (value) => typeof value === 'string' && /^[0-9a-f]{64}$/.test(value) ? value : 'unavailable';
  const safeCode = (value, fallback) => typeof value === 'string' && /^[A-Z0-9_]{1,80}$/.test(value) ? value : fallback;
  const safeReason = safeCode(reason, 'REVIEW_GATE_FAILED');
  const evidence = context?.evidence ?? {};
  const checks = context?.checks ?? {};
  const causeCode = safeCode(evidence.causeCode, 'CAUSE_UNAVAILABLE');
  const safeRootCauses = {
    RULES_DETECTION_FAILED: 'Owned rules detection failed before it could establish the target state; the detailed error was withheld.',
    RULES_FILE_ABSENT: 'The receipt-owned bots/AGENTS.md rules file is absent.',
    RULES_RECEIPT_INVALID: 'The shared rules match the current template, but the ownership receipt failed schema, target, or hash verification.',
    RULES_NOT_INSTALLED_OR_CHANGED: 'The shared rules match the current template, but the ownership receipt is absent or stale.',
    RULES_FILE_FOREIGN: 'The shared rules were modified outside the receipt-owned template; user content was preserved.',
    RULES_PATH_UNSAFE: 'The shared rules path is unsafe; no repair was attempted.',
  };
  const safeDefect = safeCode(evidence.defect ?? defect, 'DEFECT_UNAVAILABLE');
  const detectorStates = ['absent', 'foreign', 'unsafe', 'present', 'matching', 'unavailable'];
  const safeState = detectorStates.includes(evidence.detectorState) ? evidence.detectorState : 'unavailable';
  const safeReviewState = ['approved', 'rejected', 'stale', 'invalid', 'unavailable', 'not-run'].includes(review?.state)
    ? review.state : 'unavailable';
  const safeNonce = typeof request?.nonce === 'string' && /^[a-f0-9-]{1,36}$/i.test(request.nonce)
    ? request.nonce : 'not-created';
  const beforeSummary = Array.isArray(evidence.beforeImages) && evidence.beforeImages.length
    ? evidence.beforeImages.map((entry) => {
      const path = ['bots/AGENTS.md', `bots/${RECEIPT}`].includes(entry.path) ? entry.path : 'target-unavailable';
      return `${path}=${entry.present ? 'present' : 'absent'} sha256=${hash(entry.sha256)}`;
    }).join('; ')
    : 'before images unavailable';
  const safeBackup = typeof backupState === 'string' && backupState.startsWith('created and retained')
    ? 'created and retained' : typeof backupState === 'string' && backupState.startsWith('creation failed')
      ? 'creation failed; any partial backup retained' : 'not created or not applicable';
  const safeCurrentEvidence = typeof currentEvidence === 'string' && currentEvidence.length <= 512 &&
    /^[A-Za-z0-9._/=; -]*$/.test(currentEvidence) ? currentEvidence : 'not collected';
  const body = [
    '# Singularity Maintainer review gate',
    '',
    'Status: BLOCKED',
    `Timestamp UTC: ${new Date(now).toISOString()}`,
    'Product version and source revision: not collected by the bounded review gate',
    `Observed defect: ${safeDefect}`,
    `Root cause: ${safeRootCauses[causeCode] ?? 'not established; review evidence could not be captured.'}`,
    `Detection evidence: state ${safeState}; safe cause code ${causeCode}; owned target images ${beforeSummary}; desired template sha256 ${hash(evidence.desiredTemplateSha256)}`,
    `Relevant checks: defect detection ${safeCode(checks.detectionStatus, 'unavailable')}; planRules ${safeCode(checks.planRulesStatus, 'unavailable')}; pre-apply tests ${safeCode(checks.preApplyTests, 'NOT_RUN')}; post-apply verification ${safeCode(checks.postApplyVerification, 'NOT_RUN')}`,
    `Current target readback: ${safeCurrentEvidence}`,
    `Review gate: ${safeReviewState}; reason ${safeReason}; reviewer ${REVIEWER_NAME}`,
    `Proposed change identity (not approved): nonce ${safeNonce}; before ${hash(request?.beforeHash)}; after ${hash(request?.afterHash)}; diff ${hash(request?.diffHash)}`,
    `Backup state: ${safeBackup}`,
    'Modified project-owned repair files: none',
    'Targeted tests and postrepair validation: not run; blocked before repair mutation',
    'Independent postrepair readback: not applicable',
    'Rollback: not needed; no repair mutation occurred',
    'OpenMausBot chat delivery: awaiting acknowledgement',
    '',
  ].join('\n');
  if (Buffer.byteLength(body, 'utf8') > 8192) fail('REPORT_TOO_LARGE');
  const reportPath = join(l.reports, `${stamp(now)}-BLOCKED-${randomUUID()}.md`);
  const fd = openSync(reportPath, 'wx', 0o600);
  try { writeFileSync(fd, body); fsyncSync(fd); } finally { closeSync(fd); }
  return reportPath;
}

/** Classify the one owned defect class this module may repair. Read-only. */
export function detect(paths, deps = {}) {
  const plan = deps.planRules ?? planRules;
  const verify = deps.verifyRules ?? verifyRules;
  const p = absPaths(paths);
  let state;
  try {
    state = plan({dataDir: p.dataDir}).state;
  } catch (error) {
    const code = String(error?.message || error);
    if (/OPENMAUSBOT_DATA_DIR_NOT_INSTALLED|OPENMAUSBOT_BOTS_DIR_NOT_INSTALLED/.test(code)) {
      return {defect: null, reason: 'OMB_NOT_INSTALLED', owned: false, repairable: false};
    }
    if (/REPARSE_/.test(code)) return {defect: 'OMB_RULES_UNSAFE_PATH', owned: true, repairable: false,
      state: 'unsafe', causeCode: 'RULES_PATH_UNSAFE'};
    fail(`DETECTION_FAILED:${code}`);
  }
  if (state === 'foreign') {
    return {defect: 'OMB_SHARED_RULES_FOREIGN', owned: true, repairable: false, state,
      causeCode: 'RULES_FILE_FOREIGN'};
  }
  if (state === 'absent') {
    return {defect: 'OMB_SHARED_RULES_MISSING', owned: true, repairable: true, state,
      causeCode: 'RULES_FILE_ABSENT'};
  }
  // present and byte-identical to the template — the only possible defect left
  // is a missing or stale ownership receipt.
  try {
    verify({dataDir: p.dataDir});
    return {defect: null, reason: 'RULES_VERIFIED', owned: true, repairable: false, state};
  } catch (error) {
    return {defect: 'OMB_RULES_RECEIPT_DRIFT', owned: true, repairable: true, state,
      causeCode: safeRulesFailureCode(error)};
  }
}

/** Identity of the observed event: used for report naming and recurrence
 *  counting only. It deliberately does NOT gate repair — an identical-looking
 *  fingerprint can be a real recurrence after a verified fix. */
function fingerprint(paths, defect) {
  const l = layout(paths);
  let file = 'absent';
  try { if (existsSync(l.rules)) file = sha(readFileSync(l.rules)); } catch { file = 'unreadable'; }
  return sha(`${defect}|${file}`).slice(0, 16);
}

function readJson(file, shape, onCorrupt = null) {
  let raw;
  try { raw = readFileSync(file, 'utf8'); }
  catch { return null; /* absent or unreadable: a clean ledger/outbox never blocks a repair */ }
  try {
    const j = JSON.parse(raw);
    if (j && typeof j === 'object' && !Array.isArray(j) && shape(j)) return j;
  } catch { /* corrupt: fall through to quarantine */ }
  // Never silently overwrite unreadable state: keep it as evidence so pending
  // rows and occurrence history are not destroyed by the next atomic write.
  let salvaged = null;
  try { salvaged = onCorrupt ? onCorrupt(raw) : null; } catch { salvaged = null; }
  try { renameSync(file, `${file}.corrupt-${Date.now()}-${randomUUID().slice(0, 8)}`); } catch { /* best effort */ }
  return salvaged;
}

function atomicJson(file, value) {
  mkdirSync(dirname(file), {recursive: true, mode: 0o700});
  const tmp = `${file}.pending-${randomUUID()}`;
  const fd = openSync(tmp, 'wx', 0o600);
  try { writeFileSync(fd, JSON.stringify(value, null, 2) + '\n'); fsyncSync(fd); } finally { closeSync(fd); }
  renameSync(tmp, file);
}

/** Raw-text occurrence floor from a corrupt ledger so a later FIXED never reuses a sendId. */
function salvageLedger(raw) {
  const fixes = {};
  const re = /"([a-f0-9]{16})"\s*:\s*\{[^{}]*?"occurrences"\s*:\s*(\d{1,9})/g;
  for (const m of String(raw).matchAll(re)) {
    const n = Number(m[2]);
    if (n >= 1 && n > (fixes[m[1]]?.occurrences ?? 0)) fixes[m[1]] = {verified: true, occurrences: n, salvaged: true};
  }
  return {schema: 1, fixes};
}

const readLedger = (file) => readJson(file, (j) => j.schema === 1 && j.fixes && typeof j.fixes === 'object', salvageLedger)
  ?? {schema: 1, fixes: {}};

function fixedOutboxOccurrence(entry, key) {
  if (!entry || typeof entry !== 'object' || Array.isArray(entry)) return null;
  const fingerprint = entry.fingerprint;
  const occurrence = entry.occurrence;
  const sendId = entry.sendId;
  if (typeof fingerprint !== 'string' || !/^[a-f0-9]{16}$/.test(fingerprint) ||
      !Number.isSafeInteger(occurrence) || occurrence < 1 ||
      sendId !== `singularity-maintainer-${fingerprint}-${occurrence}` || key !== sendId) return null;
  return {fingerprint, occurrence, sendId, entry};
}

/** Recover a verified occurrence from a queue row if the process stopped after
 *  the outbox commit but before the matching ledger commit. The caller decides
 *  when to persist the merged ledger. A queued row exists only for an
 *  occurrence that was verified before queueing, so committing it from a
 *  blocked path is safe even though that path otherwise writes nothing. */
function recoverFixedOccurrenceEvidence(paths, l, ledger, now, onlyFingerprint = null) {
  const box = readOutbox(paths, l);
  const rows = Object.entries(box.pending).map(([key, entry]) => fixedOutboxOccurrence(entry, key))
    .filter((row) => row && (!onlyFingerprint || row.fingerprint === onlyFingerprint))
    .sort((a, b) => a.occurrence - b.occurrence);
  let changed = false;
  for (const {fingerprint, occurrence, sendId, entry} of rows) {
    const previous = ledger.fixes[fingerprint];
    const priorOccurrences = Number.isSafeInteger(previous?.occurrences) ? previous.occurrences : 0;
    if (occurrence <= priorOccurrences) continue;
    const createdAt = typeof entry.createdAt === 'string' && Number.isFinite(Date.parse(entry.createdAt))
      ? entry.createdAt : new Date(now).toISOString();
    const reportName = typeof entry.reportName === 'string' && basename(entry.reportName) === entry.reportName &&
      /^[A-Za-z0-9_.-]+\.md$/.test(entry.reportName) ? entry.reportName : null;
    const defect = typeof entry.defect === 'string' && /^OMB_[A-Z0-9_]{1,72}$/.test(entry.defect)
      ? entry.defect : previous?.defect ?? null;
    ledger.fixes[fingerprint] = {
      ...(previous ?? {}), verified: true, at: previous?.at ?? createdAt,
      defect, report: reportName ? join(l.reports, reportName) : previous?.report ?? null,
      chatDelivered: false, sendId, occurrences: occurrence,
      firstAt: previous?.firstAt ?? (typeof entry.firstAt === 'string' && Number.isFinite(Date.parse(entry.firstAt))
        ? entry.firstAt : createdAt),
      recurrence: occurrence > 1,
    };
    changed = true;
  }
  return changed;
}

async function persistFixedDelivery(paths, l, ledger, entry, at) {
  const occurrence = fixedOutboxOccurrence(entry, entry?.sendId);
  const record = occurrence ? ledger.fixes[occurrence.fingerprint] : null;
  if (occurrence && record?.sendId === occurrence.sendId) {
    record.chatDelivered = true;
    record.chatDeliveredAt = at;
    atomicJson(l.ledger, ledger);
  }
  // BLOCKED rows have no FIXED occurrence but their delivered report is still acknowledged.
  if (typeof entry?.reportName === 'string' && basename(entry.reportName) === entry.reportName &&
      /^[A-Za-z0-9_.-]+\.md$/.test(entry.reportName)) {
    try { updateReportNotification(paths, l, join(l.reports, entry.reportName), 'acknowledged'); }
    catch { /* Preserve the durable acknowledgement even if historical report state is unavailable. */ }
  }
}

function writeReceipt(file, target, hash, expectedBefore) {
  const tmp = `${file}.pending-${randomUUID()}`;
  let fd;
  try {
    fd = openSync(tmp, 'wx', 0o600);
    writeFileSync(fd, JSON.stringify({schema: 1, target, sha256: hash}) + '\n');
    fsyncSync(fd);
    closeSync(fd);
    fd = undefined;
    if (!sameBytes(readReviewFile(file), expectedBefore)) fail('REVIEW_BASELINE_CHANGED');
    renameSync(tmp, file);
  } catch (error) {
    if (fd !== undefined) { try { closeSync(fd); } catch {} }
    try { unlinkSync(tmp); } catch {}
    throw error;
  }
}

// -- exclusive lock -----------------------------------------------------------

function pidAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try { process.kill(pid, 0); return true; } catch (error) { return error?.code === 'EPERM'; }
}

/** True when this call owns the lock. A stale lock (dead pid, unreadable body,
 *  or older than LOCK_STALE_MS) is replaced once; a live lock is respected and
 *  the caller must not mutate anything. */
function acquireLock(l, now = Date.now(), pid = process.pid) {
  assertSafeReportDirectory({home: l.home}, l, true);
  const body = JSON.stringify({pid, at: new Date(now).toISOString()});
  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      const fd = openSync(l.lock, 'wx', 0o600);
      try { writeFileSync(fd, body); fsyncSync(fd); } finally { closeSync(fd); }
      return true;
    } catch (error) {
      if (error?.code !== 'EEXIST') throw error;
      const held = readJson(l.lock, (j) => typeof j.pid === 'number');
      const age = held ? now - Date.parse(held.at) : Infinity;
      if (held && pidAlive(held.pid) && Number.isFinite(age) && age >= 0 && age < LOCK_STALE_MS) return false;
      try { unlinkSync(l.lock); } catch { return false; }
    }
  }
  return false;
}

function releaseLock(l, pid = process.pid) {
  const held = readJson(l.lock, (j) => typeof j.pid === 'number');
  if (held && held.pid !== pid) return false; // never remove somebody else's lock
  try { unlinkSync(l.lock); return true; } catch { return false; }
}

// -- backup / restore ---------------------------------------------------------

function backup(l, now, deps = {}) {
  const dir = join(l.backups, stamp(now));
  const saved = [];
  if (!existsSync(l.rules) && !existsSync(l.stampFile)) return {dir: null, saved, digests: {}};
  mkdirSync(dir, {recursive: true, mode: 0o700});
  const digests = {};
  for (const [from, name] of [[l.rules, 'AGENTS.md'], [l.stampFile, RECEIPT]]) {
    if (existsSync(from) && lstatSync(from).isFile() && !lstatSync(from).isSymbolicLink()) {
      const backupPath = join(dir, name);
      copyFileSync(from, backupPath);
      saved.push(backupPath);
      digests[name] = sha(readFileSync(backupPath));
      deps.afterBackupCopy?.({source: from, backupPath, name});
    }
  }
  return {dir, saved, digests};
}

function reviewedImages(request) {
  if (!request || typeof request.diffContent !== 'string' || sha(request.diffContent) !== request.diffHash)
    fail('REVIEW_DIFF_SUMMARY_INVALID');
  let diff;
  try { diff = JSON.parse(request.diffContent); } catch { fail('REVIEW_DIFF_SUMMARY_INVALID'); }
  const expected = new Set(['bots/AGENTS.md', `bots/${RECEIPT}`]);
  if (diff?.schema !== `${REVIEW_REQUEST_SCHEMA}/diff` || !Array.isArray(diff.files) ||
      diff.files.length !== expected.size || diff.files.some(({path}) => !expected.has(path)) ||
      new Set(diff.files.map(({path}) => path)).size !== expected.size)
    fail('REVIEW_DIFF_SUMMARY_INVALID');
  return diff.files;
}

function imageBytes(image) {
  if (!image || typeof image.exists !== 'boolean') fail('REVIEW_DIFF_SUMMARY_INVALID');
  if (!image.exists) {
    if (image.sha256 !== null || image.base64 !== null) fail('REVIEW_DIFF_SUMMARY_INVALID');
    return null;
  }
  if (typeof image.base64 !== 'string' || !/^[0-9a-f]{64}$/.test(image.sha256)) fail('REVIEW_DIFF_SUMMARY_INVALID');
  const bytes = Buffer.from(image.base64, 'base64');
  if (bytes.toString('base64') !== image.base64 || sha(bytes) !== image.sha256) fail('REVIEW_DIFF_SUMMARY_INVALID');
  return bytes;
}

function reviewTarget(l, path) {
  if (path === 'bots/AGENTS.md') return {path: l.rules, backupName: 'AGENTS.md'};
  if (path === `bots/${RECEIPT}`) return {path: l.stampFile, backupName: RECEIPT};
  fail('REVIEW_DIFF_SUMMARY_INVALID');
}

function backupMatchesReviewedBefore(l, saved, request) {
  const images = reviewedImages(request);
  for (const entry of images) {
    const before = imageBytes(entry.before);
    const {backupName} = reviewTarget(l, entry.path);
    const path = saved.dir ? join(saved.dir, backupName) : null;
    if (before === null) {
      if (path && existsSync(path)) fail('BACKUP_BASELINE_MISMATCH');
      continue;
    }
    if (!path || !existsSync(path)) fail('BACKUP_BASELINE_MISMATCH');
    const info = lstatSync(path);
    if (info.isSymbolicLink() || !info.isFile() || !readFileSync(path).equals(before) ||
        saved.digests?.[backupName] !== sha(before))
      fail('BACKUP_BASELINE_MISMATCH');
  }
  return true;
}

function safeRollbackToReviewedBefore(l, saved, request, deps = {}) {
  let images;
  try { images = reviewedImages(request); }
  catch { return {restored: false, reason: 'REVIEWED_BASELINE_UNAVAILABLE'}; }
  try { backupMatchesReviewedBefore(l, saved, request); }
  catch { return {restored: false, reason: 'BACKUP_BASELINE_MISMATCH'}; }
  const states = images.map((entry) => ({...entry, beforeBytes: imageBytes(entry.before), afterBytes: imageBytes(entry.after),
    ...reviewTarget(l, entry.path)}));
  const currentBytes = (path) => readReviewFile(path);
  try {
    for (const entry of states) {
      const current = currentBytes(entry.path);
      if (!sameBytes(current, entry.beforeBytes) && !sameBytes(current, entry.afterBytes))
        return {restored: false, reason: 'UNKNOWN_TARGET_STATE_PRESERVED'};
    }
    const restored = [];
    for (const entry of states) {
      let current = currentBytes(entry.path);
      if (sameBytes(current, entry.beforeBytes)) continue;
      if (!sameBytes(current, entry.afterBytes)) return {restored: false, reason: 'UNKNOWN_TARGET_STATE_PRESERVED', restored};
      if (entry.beforeBytes === null) {
        const latest = currentBytes(entry.path);
        if (sameBytes(latest, entry.beforeBytes)) continue;
        if (!sameBytes(latest, entry.afterBytes)) return {restored: false, reason: 'UNKNOWN_TARGET_STATE_PRESERVED', restored};
        unlinkSync(entry.path);
      } else {
        const backupPath = join(saved.dir, entry.backupName);
        if (!existsSync(backupPath) || !readFileSync(backupPath).equals(entry.beforeBytes))
          return {restored: false, reason: 'BACKUP_BASELINE_MISMATCH', restored};
        const backupInfo = lstatSync(backupPath);
        const latest = currentBytes(entry.path);
        if (sameBytes(latest, entry.beforeBytes)) continue;
        if (!sameBytes(latest, entry.afterBytes)) return {restored: false, reason: 'UNKNOWN_TARGET_STATE_PRESERVED', restored};
        if (deps.restoreWrite) deps.restoreWrite(entry.path, entry.beforeBytes, backupInfo.mode & 0o777);
        else atomicRestoreReviewed(entry.path, entry.beforeBytes, backupInfo.mode & 0o777,
          entry.afterBytes, entry.beforeBytes);
      }
      current = currentBytes(entry.path);
      if (!sameBytes(current, entry.beforeBytes)) return {restored: false, reason: 'ROLLBACK_READBACK_MISMATCH', restored};
      restored.push(entry.path);
    }
    return {restored: true, reason: restored.length ? 'PRE_REPAIR_BASELINE_RESTORED' : 'ALREADY_AT_PRE_REPAIR_BASELINE', restored};
  } catch (error) {
    return {restored: false, reason: safeOperationCode(error, 'ROLLBACK_FAILED')};
  }
}

function atomicRestoreReviewed(target, beforeBytes, mode, expectedAfter, expectedBefore) {
  const temporary = `${target}.rollback-pending-${randomUUID()}`;
  let fd;
  try {
    fd = openSync(temporary, 'wx', mode || 0o600);
    writeFileSync(fd, beforeBytes);
    fsyncSync(fd);
    closeSync(fd);
    fd = undefined;
    const current = readReviewFile(target);
    if (sameBytes(current, expectedBefore)) { unlinkSync(temporary); return; }
    if (!sameBytes(current, expectedAfter)) {
      unlinkSync(temporary);
      fail('UNKNOWN_TARGET_STATE_PRESERVED');
    }
    renameSync(temporary, target);
  } catch (error) {
    if (fd !== undefined) { try { closeSync(fd); } catch {} }
    try { unlinkSync(temporary); } catch {}
    throw error;
  }
}

function sameBytes(left, right) {
  if (left === null || right === null) return left === right;
  return Buffer.isBuffer(left) && Buffer.isBuffer(right) && left.equals(right);
}

function safeOperationCode(error, fallback) {
  if (typeof error?.code === 'string' && /^[A-Z0-9_]{1,80}$/.test(error.code)) return error.code;
  if (typeof error?.message === 'string' && /^[A-Z0-9_]{1,80}$/.test(error.message)) return error.message;
  return fallback;
}

// -- chat delivery with a durable outbox --------------------------------------

/**
 * Deliver one message and return true only on an explicit acknowledgement.
 * `sendChat(message, {sendId})` where sendId is stable for the event, so a
 * retry of the same fix is de-duplicated by the vendor instead of posted twice.
 */
async function deliver(sendChat, entry) {
  if (typeof sendChat !== 'function') return {delivered: false, reason: 'no-chat-adapter'};
  try {
    const ack = await sendChat(entry.message, {sendId: entry.sendId});
    const delivered = ack === true || (ack && typeof ack === 'object' && ack.acknowledged === true);
    return delivered ? {delivered: true} : {delivered: false, reason: 'not-acknowledged'};
  } catch (error) {
    return {delivered: false, reason: short(error)};
  }
}

/** Retry every pending message. Delivered entries are removed from the outbox
 *  and returned so the caller can update the ledger. */
async function flushOutbox(paths, l, sendChat, now, {onDelivered} = {}) {
  const box = readOutbox(paths, l);
  const delivered = [];
  const keys = Object.keys(box.pending);
  for (const key of keys) {
    const entry = box.pending[key];
    const result = await deliver(sendChat, entry);
    if (result.delivered) {
      const at = new Date(now).toISOString();
      // Any flush may acknowledge an older FIXED row. Without a caller-supplied
      // persister, record the occurrence and send ID from the current ledger so
      // a later genuine recurrence cannot reuse the acknowledged ID.
      // A queued row whose ledger commit never landed is recovered from the row first.
      const persist = onDelivered ?? ((row, when) => {
        const fresh = readLedger(l.ledger);
        const occ = fixedOutboxOccurrence(row, row?.sendId);
        if (occ && recoverFixedOccurrenceEvidence(paths, l, fresh, now, occ.fingerprint)) atomicJson(l.ledger, fresh);
        return persistFixedDelivery(paths, l, fresh, row, when);
      });
      try { await persist(entry, at); }
      catch (error) {
        entry.attempts = (entry.attempts ?? 0) + 1;
        entry.lastAttemptAt = at;
        entry.lastError = safeOperationCode(error, 'DELIVERY_ACK_PERSIST_FAILED');
        continue;
      }
      delivered.push({key, sendId: entry.sendId, at});
      delete box.pending[key];
      continue;
    }
    entry.attempts = (entry.attempts ?? 0) + 1;
    entry.lastAttemptAt = new Date(now).toISOString();
    entry.lastError = result.reason;
  }
  let writeError = null;
  if (delivered.length || keys.length) {
    try { writeOutbox(paths, l, box); }
    catch (error) { writeError = safeOperationCode(error, 'OUTBOX_WRITE_FAILED'); }
  }
  let persistedPending = null;
  try { persistedPending = Object.keys(readOutbox(paths, l).pending); } catch {}
  return {delivered, pending: Object.keys(box.pending), persistedPending, writeError};
}

function notificationSendId(reportPath) {
  return sha(Buffer.from(reportPath ? basename(reportPath) : randomUUID())).slice(0, 16);
}

function notificationMessage({verdict, defect, reason, reportPath, reportReason}) {
  const code = (value, fallback) => typeof value === 'string' && /^[A-Z0-9_]{1,80}$/.test(value) ? value : fallback;
  const allowedVerdicts = ['BLOCKED', 'NOT_VERIFIED', 'ROLLED_BACK'];
  const safeVerdict = allowedVerdicts.includes(verdict) ? verdict : 'BLOCKED';
  const report = reportPath ? `reports/maintenance/${basename(reportPath)}`
    : `unavailable (${code(reportReason, 'REPORT_WRITE_FAILED')})`;
  return `Singularity Maintainer: ${safeVerdict} ${code(defect, 'MAINTENANCE_ATTEMPT')}; cause ${code(reason, 'CAUSE_UNAVAILABLE')}. Report: ${report}.`;
}

/** Persist a bounded outcome notification before sending it. If storage is
 *  unsafe, no pending state is claimed; the lock-acquisition failure may use a
 *  direct sanitized notice because there is no safe report/outbox location. */
async function reportAndNotify(paths, l, {now, sendChat, verdict, defect, reason,
  writeReport, directOnUnsafeReport = false, sendId: requestedSendId, messageBuilder,
  entryMetadata, queueCurrent = true, beforeSend, onDelivered, collectDeliveredIds = false}) {
  let reportPath = null;
  let reportState = 'unavailable';
  let reportReason = 'REPORT_WRITE_FAILED';
  try {
    assertSafeReportDirectory(paths, l, false);
    reportPath = writeReport();
    reportState = 'written';
    reportReason = null;
  } catch (error) {
    reportReason = safeOperationCode(error, 'REPORT_WRITE_FAILED');
  }

  const sendId = requestedSendId ?? notificationSendId(reportPath);
  const message = typeof messageBuilder === 'function'
    ? messageBuilder({reportPath, reportReason})
    : notificationMessage({verdict, defect, reason, reportPath, reportReason});
  let box;
  try {
    box = readOutbox(paths, l);
    if (queueCurrent) {
      if (!box.pending[sendId]) {
        const metadata = typeof entryMetadata === 'function'
          ? entryMetadata({reportPath, reportReason}) : entryMetadata;
        box.pending[sendId] = {sendId, message, attempts: 0,
          ...(metadata && typeof metadata === 'object' && !Array.isArray(metadata) ? metadata : {})};
      }
      writeOutbox(paths, l, box);
    }
  } catch (error) {
    const outboxReason = safeOperationCode(error, 'OUTBOX_PATH_UNAVAILABLE');
    let occurrenceError = null;
    try { await beforeSend?.({reportPath, reportReason, sendId, message, queued: false}); }
    catch (persistError) { occurrenceError = safeOperationCode(persistError, 'OCCURRENCE_PERSIST_FAILED'); }
    if (directOnUnsafeReport && reportReason === 'REPORT_PATH_UNSAFE' && outboxReason === 'REPORT_PATH_UNSAFE') {
      const attempt = await deliver(sendChat, {message, sendId});
      return {report: null, reportState: 'unavailable', reportReason,
        chatDelivered: attempt.delivered, chatState: attempt.delivered ? 'delivered' : 'not-delivered',
        chatPending: 0, chatQueued: false, sendId};
    }
    if (reportPath) {
      try { updateReportNotification(paths, l, reportPath, `not queued (${outboxReason})`); }
      catch (updateError) {
        reportState = 'unavailable';
        reportReason = safeOperationCode(updateError, 'REPORT_UPDATE_FAILED');
      }
    }
    return {report: reportPath, reportState, ...(reportReason ? {reportReason} : {}),
      chatDelivered: false, chatState: 'unavailable', chatPending: 0, chatQueued: false, sendId,
      chatReason: occurrenceError ?? outboxReason};
  }

  let occurrenceError = null;
  try { await beforeSend?.({reportPath, reportReason, sendId, message, queued: queueCurrent}); }
  catch (error) { occurrenceError = safeOperationCode(error, 'OCCURRENCE_PERSIST_FAILED'); }
  if (occurrenceError) {
    if (reportPath) {
      try { updateReportNotification(paths, l, reportPath, 'pending; durably queued; occurrence evidence unavailable'); }
      catch (error) { reportState = 'unavailable'; reportReason = safeOperationCode(error, 'REPORT_UPDATE_FAILED'); }
    }
    return {report: reportPath, reportState, ...(reportReason ? {reportReason} : {}),
      chatDelivered: false, chatState: 'unavailable', chatPending: Object.keys(box.pending).length,
      chatQueued: queueCurrent, sendId, chatReason: occurrenceError};
  }

  const flushed = await flushOutbox(paths, l, sendChat, now, {onDelivered});
  const chatDelivered = flushed.delivered.some((entry) => entry.sendId === sendId);
  const queuedStillPending = (flushed.persistedPending ?? flushed.pending).includes(sendId);
  const chatState = !queueCurrent && typeof sendChat !== 'function' ? 'not-configured'
    : chatDelivered ? 'delivered'
    : queuedStillPending ? 'CHAT_DELIVERY_PENDING'
      : flushed.writeError ? 'unavailable' : 'CHAT_DELIVERY_PENDING';
  if (reportPath) {
    const reportStateText = !queueCurrent && typeof sendChat !== 'function' ? 'not configured'
      : chatDelivered
      ? (flushed.writeError ? 'acknowledged; outbox cleanup unavailable' : 'acknowledged')
      : queuedStillPending ? 'pending; durably queued for retry'
        : flushed.writeError ? 'delivery state unavailable after queued send'
          : 'delivery acknowledgement unavailable';
    try { updateReportNotification(paths, l, reportPath, reportStateText); }
    catch (error) {
      reportState = 'unavailable';
      reportReason = safeOperationCode(error, 'REPORT_UPDATE_FAILED');
    }
  }
  const result = {report: reportPath, reportState, ...(reportReason ? {reportReason} : {}),
    chatDelivered, chatState, chatPending: flushed.persistedPending?.length ?? flushed.pending.length,
    chatQueued: queueCurrent, sendId, chatRetried: flushed.delivered.length,
    ...(flushed.writeError ? {chatReason: flushed.writeError} : {})};
  if (collectDeliveredIds) result.chatDeliveredSendIds = flushed.delivered.map((entry) => entry.sendId);
  return result;
}

function reviewedDiffSummary(request) {
  if (!request || typeof request.diffContent !== 'string' || sha(request.diffContent) !== request.diffHash)
    fail('REVIEW_DIFF_SUMMARY_INVALID');
  let diff;
  try { diff = JSON.parse(request.diffContent); } catch { fail('REVIEW_DIFF_SUMMARY_INVALID'); }
  const expectedPaths = new Set(['bots/AGENTS.md', `bots/${RECEIPT}`]);
  if (diff?.schema !== `${REVIEW_REQUEST_SCHEMA}/diff` || !Array.isArray(diff.files) ||
      diff.files.length !== expectedPaths.size || diff.files.some(({path}) => !expectedPaths.has(path)) ||
      new Set(diff.files.map(({path}) => path)).size !== expectedPaths.size)
    fail('REVIEW_DIFF_SUMMARY_INVALID');
  const imageState = (image) => {
    if (!image || typeof image.exists !== 'boolean' ||
        (image.exists && !/^[0-9a-f]{64}$/.test(image.sha256)) || (!image.exists && image.sha256 !== null))
      fail('REVIEW_DIFF_SUMMARY_INVALID');
    return image.exists ? `present sha256=${image.sha256}` : 'absent';
  };
  return diff.files.map(({path, before, after}) =>
    `- ${path}: ${imageState(before)} -> ${imageState(after)}`).join('\n');
}

function reportBody({now, paths, defect, evidence, rootCause, modified, validation, readback,
  rollback, verdict, live, review, context, diffSummary, postApplyVerification, backupState}) {
  const hash = (value) => typeof value === 'string' && /^[0-9a-f]{64}$/.test(value) ? value : 'unavailable';
  const targetLabels = new Map([
    [resolve(paths.dataDir, 'bots', 'AGENTS.md'), 'bots/AGENTS.md'],
    [resolve(paths.dataDir, 'bots', RECEIPT), `bots/${RECEIPT}`],
  ]);
  const modifiedLabels = [...new Set(modified.map((path) => targetLabels.get(resolve(path))).filter(Boolean))];
  const safeRollback = typeof rollback === 'string' && /^backup .+ retained$/.test(rollback)
    ? 'backup retained' : rollback;
  const beforeImages = context.evidence.beforeImages.map(({path, present, sha256}) =>
    `${path}=${present ? 'present' : 'absent'} sha256=${hash(sha256)}`).join('; ');
  const appliedLabel = verdict === 'FIXED'
    ? '- Approved and applied diff summary (relative paths; file contents omitted):'
    : '- Approved diff summary (relative paths; file contents omitted; application is reported below):';
  const operatorAction = verdict === 'FIXED'
    ? (live.reloadRequired ? 'restart or reload the running OpenMausBot bot before these rules apply to live turns' : 'none')
    : (rollback === 'restored-and-verified'
      ? 'none; the reviewed baseline was restored or remained intact'
      : 'inspect the target readback and rollback state before any live reload');
  return [
    '# Singularity Maintainer — repair report',
    '',
    `- Timestamp: ${new Date(now).toISOString()}`,
    `- Product: Singularity RepoQL Windows — OpenMausBot shared rules (${SCHEMA})`,
    `- Observed symptom: ${defect}`,
    `- Owner: Singularity installation (receipt-owned \`bots/AGENTS.md\`)`,
    `- Evidence: ${evidence}`,
    `- Root cause: ${rootCause}`,
    `- Detector evidence: state ${context.evidence.detectorState}; safe cause code ${context.evidence.causeCode}; desired template sha256 ${hash(context.evidence.desiredTemplateSha256)}`,
    `- Detection result: ${context.checks.detectionResult}`,
    `- Before images: ${beforeImages}`,
    `- Review requirement: ${context.requirement}`,
    `- Independent review: ${review.reviewer} APPROVE; nonce ${review.nonce}; before ${review.beforeHash}; after ${review.afterHash}; diff ${review.diffHash}`,
    appliedLabel,
    diffSummary,
    `- Backup: ${typeof backupState === 'string' && backupState.startsWith('created and retained') ? 'created and retained' : backupState ?? 'not created'}`,
    `- Modified paths: ${modifiedLabels.length ? modifiedLabels.join(', ') : 'none'}`,
    `- Review-plan checks: ${context.checks.planRulesStatus}; pre-apply test suite ${context.checks.preApplyTests}`,
    `- Post-apply verification: ${postApplyVerification}; ${validation}; ${readback}`,
    '- Additional automated tests: NOT_RUN by the runtime repair path.',
    `- On-disk verification: ${verdict === 'FIXED' ? 'verified' : 'not verified'}`,
    `- Live bot loaded the rules: ${live.loadedIntoActiveTurn ? 'reported by verifier' : 'NOT VERIFIED'}`,
    `- Live gate enforcement: ${live.gateEnforcementVerified ? 'reported by verifier' : 'NOT VERIFIED'}`,
    `- Operator action: ${operatorAction}`,
    `- Rollback: ${safeRollback}`,
    `- Verdict: ${verdict}`,
    '- OpenMausBot chat delivery: awaiting acknowledgement',
    '',
    '## Status record',
    `- Recorded at: ${new Date(now).toISOString()}`,
    `- Outcome: ${verdict}; on-disk verification ${verdict === 'FIXED' ? 'passed' : 'not established'}`,
    `- Repair write paths observed: ${modifiedLabels.length ? modifiedLabels.join(', ') : 'none'}`,
    `- Rollback/readback: ${safeRollback}; ${readback}`,
    '',
  ].join('\n');
}

function targetStateEvidence(l, request) {
  const changedPaths = [];
  const summary = [];
  for (const entry of reviewedImages(request)) {
    const before = imageBytes(entry.before);
    const target = reviewTarget(l, entry.path);
    let current;
    try { current = readReviewFile(target.path); }
    catch (error) {
      changedPaths.push(target.path);
      summary.push(`${entry.path}=unavailable (${safeOperationCode(error, 'TARGET_READBACK_FAILED')})`);
      continue;
    }
    if (!sameBytes(current, before)) changedPaths.push(target.path);
    summary.push(`${entry.path}=${current === null ? 'absent' : `present sha256=${sha(current)}`}`);
  }
  return {changedPaths, summary: summary.join('; ')};
}

function writeAttemptReport(paths, l, details) {
  assertSafeReportDirectory(paths, l, false);
  const body = reportBody(details);
  if (Buffer.byteLength(body, 'utf8') > 8192) fail('REPORT_TOO_LARGE');
  const reportPath = join(l.reports, `${stamp(details.now)}-${details.fingerprint}-ATTEMPT-${randomUUID()}.md`);
  const fd = openSync(reportPath, 'wx', 0o600);
  try { writeFileSync(fd, body); fsyncSync(fd); } finally { closeSync(fd); }
  return reportPath;
}

function writeFixedReport(paths, l, details) {
  assertSafeReportDirectory(paths, l, false);
  const body = reportBody(details);
  if (Buffer.byteLength(body, 'utf8') > 8192) fail('REPORT_TOO_LARGE');
  const reportPath = join(l.reports, `${stamp(details.now)}-${details.fingerprint}.md`);
  const fd = openSync(reportPath, 'wx', 0o600);
  try { writeFileSync(fd, body); fsyncSync(fd); } finally { closeSync(fd); }
  return reportPath;
}

function readReviewFile(path) {
  let info;
  try { info = lstatSync(path); }
  catch (error) {
    if (error?.code === 'ENOENT') return null;
    throw error;
  }
  if (info.isSymbolicLink() || !info.isFile()) fail('REVIEW_BASELINE_UNSAFE');
  return readFileSync(path);
}

function reviewContext(d, p, beforeRules, beforeReceipt) {
  let rootCause;
  if (d.defect === 'OMB_SHARED_RULES_MISSING') {
    rootCause = 'The receipt-owned bots/AGENTS.md rules file is absent.';
  } else if (beforeReceipt === null) {
    rootCause = 'The shared rules match the current template, but the ownership receipt is absent.';
  } else if (d.causeCode === 'RULES_RECEIPT_INVALID') {
    rootCause = 'The shared rules match the current template, but the ownership receipt failed schema, target, or hash verification.';
  } else if (d.causeCode === 'RULES_NOT_INSTALLED_OR_CHANGED') {
    rootCause = 'The shared rules match the current template, but verification found the ownership receipt absent or stale.';
  } else {
    rootCause = 'The shared rules match the current template, but receipt verification failed; the specific cause was not safely identified.';
  }
  const beforeImages = [
    {path: 'bots/AGENTS.md', bytes: beforeRules},
    {path: `bots/${RECEIPT}`, bytes: beforeReceipt},
  ].sort((a, b) => a.path.localeCompare(b.path)).map(({path, bytes}) => ({
    path, present: bytes !== null, sha256: bytes === null ? null : sha(bytes),
  }));
  return {
    requirement: MAINTENANCE_REVIEW_REQUIREMENT,
    scope: MAINTENANCE_REPAIR_SCOPE,
    evidence: {defect: d.defect, detectorState: d.state, causeCode: d.causeCode,
      rootCause, desiredTemplateSha256: p.sha256, beforeImages},
    checks: {detectionStatus: 'FAILED_EXPECTED',
      detectionResult: `detect() observed ${d.defect} at state ${d.state} with safe cause code ${d.causeCode}.`,
      planRulesStatus: 'PASSED',
      preApplyTests: 'NOT_RUN',
      postApplyVerification: 'NOT_RUN'},
  };
}

function fallbackReviewContext(d) {
  const causeCode = d.causeCode ?? (d.state === 'foreign' ? 'RULES_FILE_FOREIGN'
    : d.state === 'unsafe' ? 'RULES_PATH_UNSAFE' : 'RULES_VERIFICATION_FAILED');
  const rootCause = d.state === 'foreign'
    ? 'The shared rules were modified outside the receipt-owned template; user content was preserved.'
    : d.state === 'unsafe'
      ? 'The shared rules path is unsafe; no repair was attempted.'
      : d.defect === 'OMB_SHARED_RULES_MISSING'
        ? 'The receipt-owned bots/AGENTS.md rules file is absent; exact before images could not be captured.'
        : 'The detector found receipt verification drift; exact before images and the specific cause could not be captured.';
  return {
    requirement: MAINTENANCE_REVIEW_REQUIREMENT,
    scope: MAINTENANCE_REPAIR_SCOPE,
    evidence: {defect: d.defect, detectorState: d.state, causeCode,
      rootCause,
      desiredTemplateSha256: 'unavailable', beforeImages: []},
    checks: {detectionStatus: 'FAILED_EXPECTED',
      detectionResult: `detect() observed ${d.defect}; review baseline capture was unavailable.`,
      planRulesStatus: 'NOT_RUN', preApplyTests: 'NOT_RUN', postApplyVerification: 'NOT_RUN'},
  };
}

/** Capture the exact candidate the existing installer will write. This is
 *  read-only and runs before backups, outbox retries, reports, or repair writes. */
function makeReviewPlan(paths, l, d, planRulesFn) {
  const p = planRulesFn({dataDir: paths.dataDir});
  if (resolve(p.target) !== resolve(l.rules) || !Buffer.isBuffer(p.bytes) ||
      typeof p.sha256 !== 'string' || sha(p.bytes) !== p.sha256) fail('REVIEW_PLAN_MISMATCH');
  const beforeRules = readReviewFile(l.rules);
  const beforeReceipt = readReviewFile(l.stampFile);
  if (d.defect === 'OMB_SHARED_RULES_MISSING' && beforeRules !== null) fail('REVIEW_BASELINE_CHANGED');
  if (d.defect === 'OMB_RULES_RECEIPT_DRIFT' && beforeRules === null) fail('REVIEW_BASELINE_CHANGED');
  const afterRules = d.defect === 'OMB_SHARED_RULES_MISSING' ? p.bytes : beforeRules;
  const afterReceipt = Buffer.from(JSON.stringify({schema: 1, target: p.target, sha256: p.sha256}) + '\n');
  const context = reviewContext(d, p, beforeRules, beforeReceipt);
  const request = buildReviewRequest({defect: d.defect, context, files: [
    {path: 'bots/AGENTS.md', before: beforeRules, after: afterRules},
    {path: `bots/${RECEIPT}`, before: beforeReceipt, after: afterReceipt},
  ]});
  return {plan: p, request, context, diffSummary: reviewedDiffSummary(request)};
}

function reviewFailure(review, request) {
  const base = {schema: SCHEMA, defect: request.defect, changed: [], report: null,
    chatDelivered: false, review: {reviewer: REVIEWER_NAME,
      state: review?.reason === 'REVIEW_METADATA_PRESERVATION_UNSUPPORTED' ? 'not-run' : 'unavailable',
      nonce: request.nonce, beforeHash: request.beforeHash, afterHash: request.afterHash,
      diffHash: request.diffHash}};
  if (review?.status === 'rejected') {
    return {...base, status: 'review-rejected', reason: review.reason ?? 'REVIEWER_REJECTED',
      review: {...base.review, state: 'rejected'}};
  }
  if (review?.reason === 'REVIEW_RECEIPT_STALE' || review?.reason === 'REVIEW_PROFILE_CHANGED_DURING_REVIEW') {
    return {...base, status: 'review-stale', reason: review.reason,
      review: {...base.review, state: 'stale'}};
  }
  if (review?.reason === 'REVIEW_BASELINE_CHANGED' || review?.reason === 'REVIEW_BASELINE_UNAVAILABLE') {
    return {...base, status: 'review-stale', reason: review.reason,
      review: {...base.review, state: 'stale'}};
  }
  if (review?.status === 'invalid') {
    return {...base, status: 'review-invalid', reason: review.reason ?? 'REVIEW_RECEIPT_INVALID',
      review: {...base.review, state: 'invalid'}};
  }
  return {...base, status: 'review-unavailable', reason: review?.reason ?? 'REVIEW_NOT_APPROVED'};
}

/**
 * Repair the owned rules defect, if one exists.
 * deps lets tests inject the installer/verifier, the chat sender and a failing
 * copy; production passes nothing and therefore uses the real owned helpers.
 */
async function repairWithCapability(pathsIn, opts = {}, fixtureCapability = null) {
  const fixture = fixtureCapability ? fixtureCapabilities.get(fixtureCapability) : null;
  if (fixtureCapability && !fixture) fail('FIXTURE_CAPABILITY_INVALID');
  const {deps = {}, sendChat = null, now = Date.now()} = opts;
  if (Object.hasOwn(opts, 'allowFixture')) fail('FIXTURE_MODE_NOT_PUBLIC');
  if (!deps || typeof deps !== 'object' || Array.isArray(deps)) fail('REPAIR_DEPENDENCIES_INVALID');
  if (!fixture && Object.keys(deps).length) fail('PRODUCTION_DEPENDENCY_INJECTION_REFUSED');
  if (process.platform !== 'win32' && !fixture) fail('WINDOWS_ONLY_MUTATION');
  const paths = absPaths(pathsIn);
  if (fixture) assertFixturePaths(paths, fixture);
  const l = layout(paths);
  let lockAcquired;
  try { lockAcquired = acquireLock(l, now); }
  catch (error) {
    const reason = safeOperationCode(error, 'REPORT_PATH_UNSAFE');
    const notice = await reportAndNotify(paths, l, {now, sendChat, verdict: 'BLOCKED',
      defect: 'MAINTENANCE_CHECK', reason, directOnUnsafeReport: true,
      writeReport: () => { throw error; }});
    return {schema: SCHEMA, status: 'unable-to-repair', defect: null, changed: [], reason, ...notice};
  }
  if (!lockAcquired) {
    return {schema: SCHEMA, status: 'busy', defect: null, changed: [], report: null,
      chatDelivered: false, reason: 'MAINTENANCE_LOCK_HELD'};
  }
  try {
    let d;
    try { d = detect(paths, deps); }
    catch {
      const defect = 'OMB_RULES_DETECTION_FAILED';
      const reason = 'DETECTION_FAILED';
      const request = {defect, nonce: null, beforeHash: null, afterHash: null, diffHash: null};
      const context = {
        requirement: MAINTENANCE_REVIEW_REQUIREMENT,
        scope: MAINTENANCE_REPAIR_SCOPE,
        evidence: {defect, detectorState: 'unavailable', causeCode: 'RULES_DETECTION_FAILED',
          desiredTemplateSha256: 'unavailable', beforeImages: []},
        checks: {detectionStatus: 'FAILED', detectionResult: 'Owned rules detection failed; detailed error withheld.',
          planRulesStatus: 'NOT_RUN', preApplyTests: 'NOT_RUN', postApplyVerification: 'NOT_RUN'},
      };
      const blocked = {schema: SCHEMA, status: 'unable-to-repair', defect, changed: [], reason,
        review: {reviewer: REVIEWER_NAME, state: 'not-run'}};
      const notification = await reportAndNotify(paths, l, {now, sendChat, verdict: 'BLOCKED', defect, reason,
        writeReport: () => writeBlockedReviewReport(paths, l, {now, defect, request,
          review: blocked.review, reason, context})});
      return {...blocked, ...notification};
    }
    const blockReview = async (reviewResult, request, context = fallbackReviewContext(d), backupState = null, currentEvidence = null) => {
      const blocked = reviewFailure(reviewResult, request);
      const notification = await reportAndNotify(paths, l, {now, sendChat, verdict: 'BLOCKED',
        defect: d.defect, reason: blocked.reason,
        writeReport: () => writeBlockedReviewReport(paths, l, {now, defect: d.defect,
          request, review: blocked.review, reason: blocked.reason, context, backupState, currentEvidence})
      });
      return {...blocked, ...notification};
    };
    if (!d.defect) {
      // Retrying a pending notification is not a repair and needs no source review.
      let flushed = {delivered: [], pending: [], writeError: null};
      const ledger = readLedger(l.ledger);
      let recoveryError = null;
      try {
        if (recoverFixedOccurrenceEvidence(paths, l, ledger, now)) atomicJson(l.ledger, ledger);
      } catch (error) { recoveryError = safeOperationCode(error, 'OCCURRENCE_RECOVERY_FAILED'); }
      try {
        const delivered = (entry, at) => persistFixedDelivery(paths, l, ledger, entry, at);
        flushed = await flushOutbox(paths, l, sendChat, now, {onDelivered: delivered});
      }
      catch (error) { flushed.writeError = safeOperationCode(error, 'OUTBOX_PATH_UNAVAILABLE'); }
      flushed.writeError ??= recoveryError;
      for (const hit of flushed.delivered) {
        for (const entry of Object.values(ledger.fixes)) {
          if (entry.sendId === hit.sendId) { entry.chatDelivered = true; entry.chatDeliveredAt = hit.at; }
        }
      }
      if (flushed.delivered.length) {
        try { atomicJson(l.ledger, ledger); }
        catch (error) { flushed.writeError ??= safeOperationCode(error, 'LEDGER_WRITE_FAILED'); }
      }
      return {schema: SCHEMA, status: d.repairable === false && d.reason === 'OMB_NOT_INSTALLED' ? 'unable-to-repair' : 'already-fixed',
        defect: null, reason: d.reason, duplicate: d.reason === 'RULES_VERIFIED', changed: [], report: null,
        chatDelivered: false, chatRetried: flushed.delivered.length,
        chatPending: flushed.persistedPending?.length ?? flushed.pending.length,
        ...(flushed.writeError ? {chatReason: flushed.writeError} : {})};
    }

    if (!d.repairable) {
      const reason = d.state === 'unsafe' ? 'RULES_PATH_UNSAFE' : 'OWNED_FILE_MODIFIED_BY_USER';
      const request = {defect: d.defect, nonce: null, beforeHash: null, afterHash: null, diffHash: null};
      const blocked = {schema: SCHEMA, status: 'approval-blocked', defect: d.defect,
        duplicate: false, changed: [], reason, review: {reviewer: REVIEWER_NAME, state: 'not-run'}};
      const notification = await reportAndNotify(paths, l, {now, sendChat, verdict: 'BLOCKED',
        defect: d.defect, reason,
        writeReport: () => writeBlockedReviewReport(paths, l, {now, defect: d.defect, request,
          review: blocked.review, reason, context: fallbackReviewContext(d)})});
      return {...blocked, ...notification};
    }

    const plan = deps.planRules ?? planRules;
    let reviewPlan;
    try {
      reviewPlan = makeReviewPlan(paths, l, d, plan);
    } catch (error) {
      const request = {defect: d.defect, nonce: randomUUID(), beforeHash: null, afterHash: null, diffHash: null};
      return await blockReview({status: 'unavailable', reason: error?.message?.startsWith('REVIEW_')
        ? error.message : 'REVIEW_INPUT_UNAVAILABLE'}, request);
    }

    // Existing targets require full ownership, ACL and metadata preservation.
    // Until that adapter exists, production permits only exclusive creation
    // when both reviewed targets were absent. Fixture rollback stays confined
    // to its factory-created temporary tree.
    if (!fixture && reviewedImages(reviewPlan.request).some(({before}) => before.exists))
      return await blockReview({status: 'unavailable', reason: 'REVIEW_METADATA_PRESERVATION_UNSUPPORTED'},
        reviewPlan.request, reviewPlan.context);

    // Fixture tests may substitute only the subprocess boundary. The same
    // adapter, canonical profile, stream trace checks and receipt validation
    // still run; the production CLI never accepts a caller-supplied verdict.
    let review;
    try {
      const reviewOptions = fixture ? deps.reviewOptions : undefined;
      review = await reviewCandidate(reviewPlan.request, reviewOptions);
    } catch {
      review = {status: 'unavailable', reason: 'REVIEW_EXECUTION_FAILED'};
    }
    if (!reviewMatchesRequest(review, reviewPlan.request))
      return await blockReview(review, reviewPlan.request, reviewPlan.context);

    const baselineIsCurrent = () => {
      const current = detect(paths, deps);
      if (current.defect !== d.defect || current.repairable !== true) return false;
      const currentPlan = makeReviewPlan(paths, l, current, plan);
      return currentPlan.request.beforeHash === reviewPlan.request.beforeHash &&
        currentPlan.request.afterHash === reviewPlan.request.afterHash &&
        currentPlan.request.diffHash === reviewPlan.request.diffHash &&
        currentPlan.request.diffContent === reviewPlan.request.diffContent &&
        currentReviewerProfileHash() === review.reviewerProfileSha256;
    };

    // Re-read immediately after the reviewer returns. Any drift invalidates
    // its receipt before retries, backups, reports or repair files are written.
    try {
      if (!baselineIsCurrent()) return await blockReview({status: 'invalid', reason: 'REVIEW_BASELINE_CHANGED'}, reviewPlan.request, reviewPlan.context);
    } catch {
      return await blockReview({status: 'invalid', reason: 'REVIEW_BASELINE_UNAVAILABLE'}, reviewPlan.request, reviewPlan.context);
    }

    const fp = fingerprint(paths, d.defect);
    const ledger = readLedger(l.ledger);
    try { recoverFixedOccurrenceEvidence(paths, l, ledger, now); } catch { /* safe recovery is best-effort until the approved fix is verified */ }
    const record = ledger.fixes[fp];
    // A second read immediately before the first repair write protects the
    // reviewed baseline from changes during fingerprint/ledger reads.
    try {
      if (!baselineIsCurrent()) return await blockReview({status: 'invalid', reason: 'REVIEW_BASELINE_CHANGED'}, reviewPlan.request, reviewPlan.context);
    } catch {
      return await blockReview({status: 'invalid', reason: 'REVIEW_BASELINE_UNAVAILABLE'}, reviewPlan.request, reviewPlan.context);
    }
    const rootCause = reviewPlan.context.evidence.rootCause;
    const attemptOutcome = async ({reason, validation, postApplyVerification, rollback, verdict,
      modifiedPaths = [], readback}) => {
      const notification = await reportAndNotify(paths, l, {now, sendChat, verdict,
        defect: d.defect, reason,
        writeReport: () => writeAttemptReport(paths, l, {
          now, fingerprint: fp, paths, defect: d.defect,
          evidence: `plan state '${d.state}'; fingerprint ${fp}; occurrence ${(record?.occurrences ?? 0) + 1}`,
          rootCause, modified: modifiedPaths, validation, readback, rollback, verdict, review,
          context: reviewPlan.context, diffSummary: reviewPlan.diffSummary, postApplyVerification,
          backupState,
          live: {loadedIntoActiveTurn: false, gateEnforcementVerified: false, reloadRequired: true},
        })});
      return {schema: SCHEMA, status: 'attempted-unverified', defect: d.defect,
        changed: modifiedPaths, verdict, rollback, readback, reason, ...notification};
    };
    let saved;
    let backupState = 'not created';
    try {
      saved = backup(l, now, fixture ? deps : {});
      backupState = saved.dir ? `created and retained at ${saved.dir}` : 'no pre-existing target files; no backup file required';
      backupMatchesReviewedBefore(l, saved, reviewPlan.request);
    } catch (error) {
      const reason = safeOperationCode(error, 'BACKUP_FAILED');
      backupState = `creation failed (${reason}); any partial backup retained`;
      const state = targetStateEvidence(l, reviewPlan.request);
      return await attemptOutcome({reason, validation: `backup failed (${reason}); repair mutation NOT_RUN`,
        postApplyVerification: 'NOT_RUN', rollback: 'not needed; no repair mutation occurred',
        verdict: 'NOT_VERIFIED', modifiedPaths: [], readback: state.summary});
    }

    const verifyReviewedBaseline = async () => {
      try {
        if (!baselineIsCurrent()) {
          const state = targetStateEvidence(l, reviewPlan.request);
          return await blockReview({status: 'invalid', reason: 'REVIEW_BASELINE_CHANGED'}, reviewPlan.request,
            reviewPlan.context, backupState, state.summary);
        }
      } catch {
        const state = targetStateEvidence(l, reviewPlan.request);
        return await blockReview({status: 'invalid', reason: 'REVIEW_BASELINE_UNAVAILABLE'}, reviewPlan.request,
          reviewPlan.context, backupState, state.summary);
      }
      return null;
    };

    // Recheck after the backup copy and before any repair write. The test-only
    // hook exercises the same boundary while paths are confined to a fixture.
    try { deps.afterBackup?.({dir: saved.dir}); }
    catch (error) {
      const reason = safeOperationCode(error, 'BACKUP_RECHECK_FAILED');
      const state = targetStateEvidence(l, reviewPlan.request);
      return await attemptOutcome({reason, validation: `post-backup recheck failed (${reason}); repair mutation NOT_RUN`,
        postApplyVerification: 'NOT_RUN', rollback: 'not needed; no repair mutation occurred',
        verdict: 'NOT_VERIFIED', modifiedPaths: [], readback: state.summary});
    }
    try { backupMatchesReviewedBefore(l, saved, reviewPlan.request); }
    catch {
      const state = targetStateEvidence(l, reviewPlan.request);
      return await blockReview({status: 'invalid', reason: 'BACKUP_BASELINE_MISMATCH'}, reviewPlan.request,
        reviewPlan.context, backupState, state.summary);
    }
    const postBackupBlock = await verifyReviewedBaseline();
    if (postBackupBlock) return postBackupBlock;

    const modified = [];
    const install = deps.installRules ?? installRules;
    const verify = deps.verifyRules ?? verifyRules;
    const finalWriteBlock = async () => verifyReviewedBaseline();

    try {
      if (d.defect === 'OMB_RULES_RECEIPT_DRIFT') {
        const p = plan({dataDir: paths.dataDir});
        deps.beforeReceiptWrite?.();
        const blocked = await finalWriteBlock();
        if (blocked) return blocked;
        const reviewedReceipt = reviewedImages(reviewPlan.request)
          .find(({path}) => path === `bots/${RECEIPT}`);
        writeReceipt(l.stampFile, p.target, p.sha256, imageBytes(reviewedReceipt.before));
        modified.push(l.stampFile);
      } else {
        deps.beforeRulesInstall?.();
        const blocked = await finalWriteBlock();
        if (blocked) return blocked;
        try {
          install({dataDir: paths.dataDir}, Boolean(fixture));
        } catch (error) {
          // A recurrence after a verified fix leaves the previous receipt behind.
          // The owned installer refuses that ambiguous state; remove the stale
          // receipt ONLY when it still names this owned target, then retry once.
          if (!/OLD_RECEIPT_WITHOUT_RULES/.test(short(error))) throw error;
          const p = plan({dataDir: paths.dataDir});
          const prev = readJson(l.stampFile, (j) => typeof j.target === 'string' && typeof j.sha256 === 'string');
          const owned = prev && resolve(prev.target) === resolve(p.target) && existsSync(l.stampFile) &&
            lstatSync(l.stampFile).isFile() && !lstatSync(l.stampFile).isSymbolicLink();
          if (!owned) throw error;
          const blocked = await finalWriteBlock();
          if (blocked) return blocked;
          rmSync(l.stampFile, {force: true});
          install({dataDir: paths.dataDir}, Boolean(fixture));
        }
        modified.push(l.rules, l.stampFile);
      }
    } catch (error) {
      const reason = safeOperationCode(error, 'REPAIR_WRITE_FAILED');
      const beforeRollback = targetStateEvidence(l, reviewPlan.request);
      const restored = safeRollbackToReviewedBefore(l, saved, reviewPlan.request, deps);
      const afterRollback = targetStateEvidence(l, reviewPlan.request);
      const rollbackState = restored.restored ? 'restored-and-verified' : `rollback-skipped-or-failed:${restored.reason}`;
      return await attemptOutcome({reason, validation: `repair write failed (${reason}); post-apply verifier NOT_RUN`,
        postApplyVerification: 'NOT_RUN', rollback: rollbackState,
        verdict: restored.restored ? 'ROLLED_BACK' : 'NOT_VERIFIED',
        modifiedPaths: beforeRollback.changedPaths, readback: `post-rollback targets ${afterRollback.summary}`});
    }

    let verified = false;
    let readback = 'not-run';
    let verificationFailure = 'RULES_NOT_VERIFIED';
    // verifyRules() proves the files on disk. It cannot prove the running bot
    // loaded them or that its gates now enforce them, so those stay separate.
    let loadedIntoActiveTurn = false;
    let gateEnforcementVerified = false;
    try {
      const v = verify({dataDir: paths.dataDir});
      verified = v.verified === true;
      loadedIntoActiveTurn = v.loadedIntoActiveTurn === true;
      gateEnforcementVerified = v.gateEnforcementVerified === true;
      readback = verified
        ? `rules sha256 ${v.sha256.slice(0, 16)}…, receipt valid (on disk only; live bot load ${loadedIntoActiveTurn ? 'reported' : 'not verified'})`
        : 'verifier returned no verification';
    } catch (error) {
      verificationFailure = safeOperationCode(error, 'RULES_VERIFICATION_FAILED');
      readback = `verifyRules() failed (${verificationFailure})`;
    }

    if (!verified) {
      const beforeRollback = targetStateEvidence(l, reviewPlan.request);
      const restored = safeRollbackToReviewedBefore(l, saved, reviewPlan.request, deps);
      const afterRollback = targetStateEvidence(l, reviewPlan.request);
      const rollbackState = restored.restored ? 'restored-and-verified' : `rollback-skipped-or-failed:${restored.reason}`;
      const verifierResult = readback;
      return await attemptOutcome({reason: verificationFailure, validation: `verifyRules() returned verified:${verified}`,
        postApplyVerification: 'FAILED', rollback: rollbackState,
        verdict: restored.restored ? 'ROLLED_BACK' : 'NOT_VERIFIED',
        modifiedPaths: beforeRollback.changedPaths,
        readback: `${verifierResult}; post-rollback targets ${afterRollback.summary}`});
    }

    // One id per verified occurrence. Queue it before any sender call, then
    // durably commit its occurrence to the ledger before allowing delivery.
    const occurrences = (record?.occurrences ?? 0) + 1;
    const sendId = `singularity-maintainer-${fp}-${occurrences}`;
    const fixedAt = new Date(now).toISOString();
    const fixedRecord = {
      verified: true, at: fixedAt, defect: d.defect, report: null,
      chatDelivered: false, sendId, occurrences,
      firstAt: record?.firstAt ?? fixedAt,
      recurrence: Boolean(record?.verified),
    };
    const notification = await reportAndNotify(paths, l, {now, sendChat, verdict: 'FIXED', defect: d.defect,
      reason: 'VERIFIED', sendId, queueCurrent: typeof sendChat === 'function', collectDeliveredIds: true,
      writeReport: () => writeFixedReport(paths, l, {
        now, fingerprint: fp, paths, defect: d.defect,
        evidence: `plan state '${d.state}'; fingerprint ${fp}; occurrence ${occurrences}`,
        rootCause, modified, validation: `verifyRules() returned verified:${verified}`,
        readback, rollback: `backup ${saved.dir ?? 'none'} retained`, verdict: 'FIXED', review,
        context: reviewPlan.context, diffSummary: reviewPlan.diffSummary,
        postApplyVerification: verified ? 'PASSED' : 'FAILED', backupState,
        live: {loadedIntoActiveTurn, gateEnforcementVerified,
          reloadRequired: !loadedIntoActiveTurn},
      }),
      messageBuilder: ({reportPath, reportReason}) => {
        const report = reportPath ? `reports/maintenance/${basename(reportPath)}`
          : `unavailable (${safeOperationCode({code: reportReason}, 'REPORT_WRITE_FAILED')})`;
        return `Singularity Maintainer: FIXED ${d.defect} (occurrence ${occurrences}). Verified: ${readback}. Report: ${report}`;
      },
      entryMetadata: ({reportPath}) => ({fingerprint: fp, occurrence: occurrences,
        createdAt: fixedAt, firstAt: fixedRecord.firstAt, defect: d.defect,
        reportName: reportPath ? basename(reportPath) : null}),
      beforeSend: ({reportPath, queued}) => {
        if (queued) deps.afterFixedOutboxQueue?.({sendId, fingerprint: fp, occurrence: occurrences});
        fixedRecord.report = reportPath;
        ledger.fixes[fp] = fixedRecord;
        atomicJson(l.ledger, ledger);
      },
      onDelivered: (entry, at) => persistFixedDelivery(paths, l, ledger, entry, at),
    });
    const {chatDeliveredSendIds = [], ...delivery} = notification;
    const chatDelivered = delivery.chatDelivered === true;
    const chatState = delivery.chatState;
    const chatReason = delivery.chatReason;
    return {schema: SCHEMA, status: 'fixed-and-verified', defect: d.defect, duplicate: false, changed: modified,
      ...delivery, report: delivery.report, chatDelivered, chatState, sendId, rollback: 'backup-retained', readback,
      review: {reviewer: review.reviewer, state: 'approved', nonce: review.nonce,
        reviewerProfileSha256: review.reviewerProfileSha256, beforeHash: review.beforeHash,
        afterHash: review.afterHash, diffHash: review.diffHash, traceVerified: true},
      // Exact split: the files are verified; the live bot and its gates are not.
      onDiskVerified: true, loadedIntoActiveTurn, gateEnforcementVerified,
      reloadRequired: !loadedIntoActiveTurn,
      operatorAction: loadedIntoActiveTurn ? null : 'reload or restart the running OpenMausBot bot before the repaired rules apply',
      recurrence: occurrences > 1, occurrences,
      chatRetried: chatDeliveredSendIds.filter((deliveredId) => deliveredId !== sendId).length,
      chatPending: delivery.chatPending,
      ...(chatReason ? {chatReason} : {})};
  } finally {
    releaseLock(l);
  }
}

export async function repair(pathsIn, opts = {}) {
  const plainRecord = opts && typeof opts === 'object' && !Array.isArray(opts) &&
    (Object.getPrototypeOf(opts) === Object.prototype || Object.getPrototypeOf(opts) === null);
  if (!plainRecord || Reflect.ownKeys(opts).length)
    fail('PRODUCTION_DEPENDENCY_INJECTION_REFUSED');
  return repairWithCapability(pathsIn, {}, null);
}

function parseArgs(argv) {
  const o = {};
  for (let i = 0; i < argv.length; i++) {
    const f = argv[i];
    if (f === '--apply') { o.apply = true; continue; }
    if (!['--home', '--data-dir', '--workspace', '--rc-root'].includes(f) || !argv[i + 1] || argv[i + 1].startsWith('--') || o[f]) fail('USAGE');
    o[f] = argv[++i];
  }
  return o;
}

/**
 * Build the real vendor chat sender from the instance the provisioning path
 * already wrote. Read-only: the record, the payload/data dir relationship and
 * the port are validated; nothing is started, created or repaired here.
 */
export function chatSenderForInstance(rcRoot, {spawnChild} = {}) {
  try {
    if (typeof rcRoot !== 'string' || !isAbsolute(rcRoot)) return {sendChat: null, reason: 'RC_ROOT_MUST_BE_ABSOLUTE'};
    const stage = join(rcRoot, 'stage', 'omb');
    const data = join(rcRoot, 'state', 'omb');
    const record = join(data, 'instance.json');
    if (!existsSync(record) || lstatSync(record).isSymbolicLink() || !lstatSync(record).isFile())
      return {sendChat: null, reason: 'OMB_INSTANCE_RECORD_MISSING'};
    const instance = JSON.parse(readFileSync(record, 'utf8'));
    if (instance?.payload !== stage || instance?.data_dir !== data)
      return {sendChat: null, reason: 'OMB_INSTANCE_NOT_OWNED'};
    if (instance?.mode !== 'headless-no-pair-task') return {sendChat: null, reason: 'OMB_INSTANCE_NOT_HEADLESS'};
    if (!Number.isInteger(instance?.port) || instance.port < 1024 || instance.port > 65534)
      return {sendChat: null, reason: 'OMB_INSTANCE_PORT_INVALID'};
    const cli = join(stage, 'cli.js');
    if (!existsSync(cli) || lstatSync(cli).isSymbolicLink() || !lstatSync(cli).isFile())
      return {sendChat: null, reason: 'OMB_CHAT_CLI_MISSING'};
    return {sendChat: ombChatSender({cli, port: instance.port, ...(spawnChild ? {spawnChild} : {})}), reason: null};
  } catch (error) {
    return {sendChat: null, reason: short(error)};
  }
}

/**
 * The CLI body, exported so the production entry point and its boundary test
 * run exactly the same code. `--rc-root` (or the default derived from
 * `--data-dir`) enables chat; when the instance cannot be verified the repair
 * still runs but reports `chatReason` instead of silently claiming delivery.
 */
async function runCliWithCapability(argv, options = {}, fixtureCapability = null) {
  const fixture = fixtureCapability ? fixtureCapabilities.get(fixtureCapability) : null;
  if (fixtureCapability && !fixture) fail('FIXTURE_CAPABILITY_INVALID');
  const {spawnChild, reviewSpawn, platform = process.platform} = options;
  if (!fixture && Object.keys(options).length) fail('PRODUCTION_DEPENDENCY_INJECTION_REFUSED');
  const a = parseArgs(argv);
  if (platform !== 'win32' && !fixture) fail('WINDOWS_ONLY_MUTATION');
  const rcRoot = a['--rc-root'] ?? (a['--data-dir'] ? resolve(a['--data-dir'], '..', '..') : null);
  const paths = {
    home: a['--home'] ?? homedir(),
    dataDir: a['--data-dir'] ?? (rcRoot ? join(rcRoot, 'state', 'omb') : null),
    workspace: a['--workspace'] ?? (rcRoot ? resolve(rcRoot, '..') : null),
  };
  if (fixture) assertFixturePaths(absPaths(paths), fixture);
  if (!a.apply) return {schema: SCHEMA, mode: 'READ_ONLY', ...detect(paths)};
  let sendChat = null;
  let chatReason = 'RC_ROOT_NOT_DETERMINED';
  if (rcRoot) ({sendChat, reason: chatReason} = chatSenderForInstance(rcRoot, {spawnChild}));
  const deps = fixture && reviewSpawn ? {reviewOptions: {
    platform: 'win32', claudeExe: process.execPath, spawnImpl: reviewSpawn,
  }} : {};
  const out = await repairWithCapability(paths, {sendChat, deps}, fixtureCapability);
  if (!sendChat) out.chatReason = chatReason;
  return out;
}

export async function runCli(argv, options = {}) {
  const plainRecord = options && typeof options === 'object' && !Array.isArray(options) &&
    (Object.getPrototypeOf(options) === Object.prototype || Object.getPrototypeOf(options) === null);
  if (!plainRecord || Reflect.ownKeys(options).length)
    fail('PRODUCTION_DEPENDENCY_INJECTION_REFUSED');
  return runCliWithCapability(argv, {}, null);
}

/**
 * Test-only boundary: create a new temporary tree here and return closures
 * bound to it. No caller-supplied path can receive fixture review or gate
 * injection through these closures.
 */
export function createRepairFixtureHarness() {
  const root = mkdtempSync(join(tmpdir(), 'singularity-maintenance-fixture-'));
  const paths = Object.freeze({home: join(root, 'home'), dataDir: join(root, 'state', 'omb'), workspace: root});
  for (const dir of [paths.home, paths.dataDir, join(paths.dataDir, 'bots')]) mkdirSync(dir, {recursive: true});
  const capability = Object.freeze({});
  const fixture = Object.freeze({root, paths});
  fixtureCapabilities.set(capability, fixture);
  const cliArgs = ['--apply', '--home', paths.home, '--data-dir', paths.dataDir, '--workspace', paths.workspace];
  return Object.freeze({
    root, home: paths.home, dataDir: paths.dataDir, workspace: paths.workspace, paths,
    repair: (opts = {}) => repairWithCapability(paths, opts, capability),
    runCli: (options = {}) => runCliWithCapability(cliArgs, {...options, platform: 'win32'}, capability),
  });
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const out = await runCli(process.argv.slice(2));
    process.stdout.write(JSON.stringify(out) + '\n');
    if (out.status && out.status !== 'fixed-and-verified' && out.status !== 'already-fixed') process.exitCode = 1;
  } catch (error) {
    process.stderr.write(`SINGULARITY_MAINTENANCE_REPAIR_REFUSED: ${short(error)}\n`);
    process.exitCode = 2;
  }
}
