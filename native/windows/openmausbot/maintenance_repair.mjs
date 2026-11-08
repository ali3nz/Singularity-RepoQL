#!/usr/bin/env node
/** Active, bounded repair for the Singularity-owned OpenMausBot shared rules.
 *
 * Detection and the actual fix reuse `install_shared_rules.mjs` (the existing
 * owned installer/verifier): no second rules store, no scheduler, no polling.
 * The repair only restores a receipt-owned file; a user-modified AGENTS.md is
 * preserved and reported `approval-blocked`, never overwritten.
 *
 * Guarantees this module keeps, and their tests:
 * - A genuine recurrence is repaired again. The ledger fingerprints reports and
 *   counts recurrences; it never suppresses a repair for a defect that is
 *   present right now (only a currently healthy installation is `already-fixed`).
 * - Chat is acknowledged, not assumed: an unacknowledged message is persisted in
 *   a durable outbox and retried on later runs. The `sendId` is stable across
 *   retries of one occurrence but changes for a genuine recurrence, so vendor
 *   de-duplication cannot swallow the second notification.
 * - The production CLI wires the real vendor sender itself (`ombChatSender`
 *   against the verified instance record); tests may inject one, production
 *   never leaves chat unreachable.
 * - A failed verification restores the private backup and reads it back before
 *   claiming `restored-and-verified`; any doubt is `rollback-failed`.
 * - One exclusive lock spans detect -> repair -> report -> ledger, so concurrent
 *   runs or events cannot duplicate work.
 */
import {existsSync, mkdirSync, readFileSync, writeFileSync, copyFileSync, rmSync,
        openSync, closeSync, fsyncSync, renameSync, lstatSync, unlinkSync, readdirSync} from 'node:fs';
import {join, resolve, isAbsolute, dirname} from 'node:path';
import {createHash, randomUUID} from 'node:crypto';
import {fileURLToPath} from 'node:url';
import {homedir} from 'node:os';
import {spawnSync} from 'node:child_process';
import {planRules, installRules, verifyRules, rollbackRules} from './install_shared_rules.mjs';
import {ombChatSender} from './omb_chat.mjs';

const SCHEMA = 'singularity-windows-maintenance-repair/v1';
const RECEIPT = '.singularity-openmausbot-rules.json';
const LOCK_STALE_MS = 30 * 60 * 1000;
const fail = (m) => { throw new Error(m); };
const sha = (x) => createHash('sha256').update(x).digest('hex');
const stamp = (now) => new Date(now).toISOString().replace(/[:.]/g, '-');
const short = (e) => String(e?.message || e).slice(0, 120);

function absPaths({home, dataDir, workspace}) {
  for (const [name, v] of Object.entries({home, dataDir, workspace})) {
    if (typeof v !== 'string' || !v || !isAbsolute(v)) fail(`${name.toUpperCase()}_MUST_BE_ABSOLUTE`);
  }
  return {home: resolve(home), dataDir: resolve(dataDir), workspace: resolve(workspace)};
}

function layout(paths) {
  const reports = join(paths.home, 'reports', 'maintenance');
  return {
    reports,
    ledger: join(reports, '.ledger.json'),
    outbox: join(reports, '.outbox.json'),
    lock: join(reports, '.lock'),
    backups: join(reports, '.backups'),
    stampFile: join(paths.dataDir, 'bots', RECEIPT),
    rules: join(paths.dataDir, 'bots', 'AGENTS.md'),
  };
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
    if (/REPARSE_/.test(code)) return {defect: 'OMB_RULES_UNSAFE_PATH', owned: true, repairable: false, state: 'unsafe'};
    fail(`DETECTION_FAILED:${code}`);
  }
  if (state === 'foreign') {
    return {defect: 'OMB_SHARED_RULES_FOREIGN', owned: true, repairable: false, state};
  }
  if (state === 'absent') {
    return {defect: 'OMB_SHARED_RULES_MISSING', owned: true, repairable: true, state};
  }
  // present and byte-identical to the template — the only possible defect left
  // is a missing or stale ownership receipt.
  try {
    verify({dataDir: p.dataDir});
    return {defect: null, reason: 'RULES_VERIFIED', owned: true, repairable: false, state};
  } catch {
    return {defect: 'OMB_RULES_RECEIPT_DRIFT', owned: true, repairable: true, state};
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

function readJson(file, shape) {
  try {
    const j = JSON.parse(readFileSync(file, 'utf8'));
    if (j && typeof j === 'object' && !Array.isArray(j) && shape(j)) return j;
  } catch { /* absent or corrupt: a clean ledger/outbox never blocks a repair */ }
  return null;
}

function atomicJson(file, value) {
  mkdirSync(dirname(file), {recursive: true, mode: 0o700});
  const tmp = `${file}.pending-${randomUUID()}`;
  const fd = openSync(tmp, 'wx', 0o600);
  try { writeFileSync(fd, JSON.stringify(value, null, 2) + '\n'); fsyncSync(fd); } finally { closeSync(fd); }
  renameSync(tmp, file);
}

const readLedger = (file) => readJson(file, (j) => j.schema === 1 && j.fixes && typeof j.fixes === 'object')
  ?? {schema: 1, fixes: {}};
const readOutbox = (file) => readJson(file, (j) => j.schema === 1 && j.pending && typeof j.pending === 'object')
  ?? {schema: 1, pending: {}};

function writeReceipt(file, target, hash) {
  const tmp = `${file}.pending-${randomUUID()}`;
  const fd = openSync(tmp, 'wx', 0o600);
  try { writeFileSync(fd, JSON.stringify({schema: 1, target, sha256: hash}) + '\n'); fsyncSync(fd); } finally { closeSync(fd); }
  renameSync(tmp, file);
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
  mkdirSync(l.reports, {recursive: true, mode: 0o700});
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

function backup(l, now) {
  const dir = join(l.backups, stamp(now));
  const saved = [];
  if (!existsSync(l.rules) && !existsSync(l.stampFile)) return {dir: null, saved, digests: {}};
  mkdirSync(dir, {recursive: true, mode: 0o700});
  const digests = {};
  for (const [from, name] of [[l.rules, 'AGENTS.md'], [l.stampFile, RECEIPT]]) {
    if (existsSync(from) && lstatSync(from).isFile() && !lstatSync(from).isSymbolicLink()) {
      copyFileSync(from, join(dir, name));
      saved.push(join(dir, name));
      digests[name] = sha(readFileSync(from));
    }
  }
  return {dir, saved, digests};
}

/** Restore the backup and READ IT BACK. `restored` is true only when every file
 *  the backup held is present again with the same bytes. */
function restore(l, savedDir, deps = {}) {
  const copy = deps.copyFile ?? copyFileSync;
  if (!savedDir) return {restored: false, reason: 'no-backup'};
  try {
    const restored = [];
    for (const [name, to] of [['AGENTS.md', l.rules], [RECEIPT, l.stampFile]]) {
      const from = join(savedDir, name);
      if (!existsSync(from) || !lstatSync(from).isFile()) {
        // A file the backup does not hold did not exist before the repair.
        if (existsSync(to)) rmSync(to, {force: true});
        continue;
      }
      copy(from, to);
      const want = sha(readFileSync(from));
      if (!existsSync(to) || sha(readFileSync(to)) !== want) {
        return {restored: false, reason: `restore-readback-mismatch:${name}`};
      }
      restored.push(to);
    }
    return {restored: true, restored};
  } catch (error) {
    return {restored: false, reason: short(error)};
  }
}

// -- chat delivery with a durable outbox --------------------------------------

/**
 * Deliver one message and return true only on an explicit acknowledgement.
 * `sendChat(message, {sendId})` where sendId is stable for the event, so a
 * retry of the same fix is de-duplicated by the vendor instead of posted twice.
 */
function deliver(sendChat, entry) {
  if (typeof sendChat !== 'function') return {delivered: false, reason: 'no-chat-adapter'};
  try {
    const ack = sendChat(entry.message, {sendId: entry.sendId});
    const delivered = ack === true || (ack && typeof ack === 'object' && ack.acknowledged === true);
    return delivered ? {delivered: true} : {delivered: false, reason: 'not-acknowledged'};
  } catch (error) {
    return {delivered: false, reason: short(error)};
  }
}

/** Retry every pending message. Delivered entries are removed from the outbox
 *  and returned so the caller can update the ledger. */
function flushOutbox(l, sendChat, now) {
  const box = readOutbox(l.outbox);
  const delivered = [];
  const keys = Object.keys(box.pending);
  for (const key of keys) {
    const entry = box.pending[key];
    const result = deliver(sendChat, entry);
    if (result.delivered) {
      delivered.push({key, sendId: entry.sendId, at: new Date(now).toISOString()});
      delete box.pending[key];
      continue;
    }
    entry.attempts = (entry.attempts ?? 0) + 1;
    entry.lastAttemptAt = new Date(now).toISOString();
    entry.lastError = result.reason;
  }
  if (delivered.length || keys.length) atomicJson(l.outbox, box);
  return {delivered, pending: Object.keys(box.pending)};
}

function reportBody({now, paths, defect, evidence, rootCause, modified, validation, readback, rollback, verdict, live}) {
  return [
    '# Singularity Maintainer — repair report',
    '',
    `- Timestamp: ${new Date(now).toISOString()}`,
    `- Product: Singularity RepoQL Windows — OpenMausBot shared rules (${SCHEMA})`,
    `- Workspace: ${paths.workspace}`,
    `- Observed symptom: ${defect}`,
    `- Owner: Singularity installation (receipt-owned \`bots/AGENTS.md\`)`,
    `- Evidence: ${evidence}`,
    `- Root cause: ${rootCause}`,
    `- Modified paths: ${modified.length ? modified.join(', ') : 'none'}`,
    `- Validation: ${validation}`,
    `- Post-fix readback: ${readback}`,
    `- On-disk verification: ${verdict === 'FIXED' ? 'verified' : 'not verified'}`,
    `- Live bot loaded the rules: ${live.loadedIntoActiveTurn ? 'reported by verifier' : 'NOT VERIFIED'}`,
    `- Live gate enforcement: ${live.gateEnforcementVerified ? 'reported by verifier' : 'NOT VERIFIED'}`,
    `- Operator action: ${live.reloadRequired ? 'restart or reload the running OpenMausBot bot before these rules apply to live turns' : 'none'}`,
    `- Rollback: ${rollback}`,
    `- Verdict: ${verdict}`,
    '',
  ].join('\n');
}

/**
 * Repair the owned rules defect, if one exists.
 * deps lets tests inject the installer/verifier, the chat sender and a failing
 * copy; production passes nothing and therefore uses the real owned helpers.
 */
export function repair(pathsIn, opts = {}) {
  const {allowFixture = false, deps = {}, sendChat = null, now = Date.now()} = opts;
  if (process.platform !== 'win32' && !allowFixture) fail('WINDOWS_ONLY_MUTATION');
  const paths = absPaths(pathsIn);
  const l = layout(paths);
  if (!acquireLock(l, now)) {
    return {schema: SCHEMA, status: 'busy', defect: null, changed: [], report: null,
      chatDelivered: false, reason: 'MAINTENANCE_LOCK_HELD'};
  }
  try {
    // A previous unacknowledged message is retried first, whatever the current defect is.
    const flushed = flushOutbox(l, sendChat, now);
    const d = detect(paths, deps);
    if (!d.defect) {
      const ledger = readLedger(l.ledger);
      for (const hit of flushed.delivered) {
        for (const entry of Object.values(ledger.fixes)) {
          if (entry.sendId === hit.sendId) { entry.chatDelivered = true; entry.chatDeliveredAt = hit.at; }
        }
      }
      if (flushed.delivered.length) atomicJson(l.ledger, ledger);
      return {schema: SCHEMA, status: d.repairable === false && d.reason === 'OMB_NOT_INSTALLED' ? 'unable-to-repair' : 'already-fixed',
        defect: null, reason: d.reason, duplicate: d.reason === 'RULES_VERIFIED', changed: [], report: null,
        chatDelivered: false, chatRetried: flushed.delivered.length, chatPending: flushed.pending.length};
    }

    if (!d.repairable) {
      return {schema: SCHEMA, status: 'approval-blocked', defect: d.defect, duplicate: false, changed: [],
        report: null, chatDelivered: false, reason: 'OWNED_FILE_MODIFIED_BY_USER',
        chatRetried: flushed.delivered.length, chatPending: flushed.pending.length};
    }

    const fp = fingerprint(paths, d.defect);
    const ledger = readLedger(l.ledger);
    const record = ledger.fixes[fp];
    const saved = backup(l, now);
    const modified = [];
    const install = deps.installRules ?? installRules;
    const verify = deps.verifyRules ?? verifyRules;
    const plan = deps.planRules ?? planRules;
    const rootCause = d.defect === 'OMB_SHARED_RULES_MISSING'
      ? 'receipt-owned rules file absent'
      : 'ownership receipt missing or stale for a byte-identical rules file';

    try {
      if (d.defect === 'OMB_RULES_RECEIPT_DRIFT') {
        const p = plan({dataDir: paths.dataDir});
        writeReceipt(l.stampFile, p.target, p.sha256);
        modified.push(l.stampFile);
      } else {
        try {
          install({dataDir: paths.dataDir}, allowFixture);
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
          rmSync(l.stampFile, {force: true});
          install({dataDir: paths.dataDir}, allowFixture);
        }
        modified.push(l.rules, l.stampFile);
      }
    } catch (error) {
      return {schema: SCHEMA, status: 'attempted-unverified', defect: d.defect, changed: modified, report: null,
        chatDelivered: false, reason: short(error), chatRetried: flushed.delivered.length, chatPending: flushed.pending.length};
    }

    let verified = false;
    let readback = 'not-run';
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
      readback = `verification failed: ${short(error).slice(0, 80)}`;
    }

    let rollbackState = 'not-needed';
    if (!verified) {
      try {
        if (d.defect === 'OMB_SHARED_RULES_MISSING') (deps.rollbackRules ?? rollbackRules)({dataDir: paths.dataDir}, allowFixture);
      } catch { /* the owned rollback is best effort; the backup readback below decides */ }
      const restored = restore(l, saved.dir, deps);
      rollbackState = restored.restored ? 'restored-and-verified' : `rollback-failed:${restored.reason}`;
      return {schema: SCHEMA, status: 'attempted-unverified', defect: d.defect, changed: modified, report: null,
        chatDelivered: false, rollback: rollbackState, readback, reason: restored.reason,
        chatRetried: flushed.delivered.length, chatPending: flushed.pending.length};
    }

    mkdirSync(l.reports, {recursive: true, mode: 0o700});
    const reportPath = join(l.reports, `${stamp(now)}-${fp}.md`);
    writeFileSync(reportPath, reportBody({
      now, paths, defect: d.defect,
      evidence: `plan state '${d.state}'; fingerprint ${fp}; occurrence ${(record?.occurrences ?? 0) + 1}`,
      rootCause,
      modified,
      validation: 'install_shared_rules.verifyRules() returned verified:true',
      readback,
      rollback: `backup ${saved.dir ?? 'none'} retained`,
      verdict: 'FIXED',
      live: {loadedIntoActiveTurn, gateEnforcementVerified,
        reloadRequired: !loadedIntoActiveTurn},
    }), {mode: 0o600});

    // One id per genuine occurrence, stable across retries of that occurrence:
    // the counter only advances when a fix is verified, so a retry before
    // verification reuses the id while a real recurrence gets a new one.
    const occurrences = (record?.occurrences ?? 0) + 1;
    const sendId = `singularity-maintainer-${fp}-${occurrences}`;
    const message = `Singularity Maintainer: FIXED ${d.defect} (occurrence ${occurrences}). Verified: ${readback}. Report: reports/maintenance/${reportPath.split('/').pop()}`;
    let chatDelivered = false;
    let chatState = 'not-configured';
    if (typeof sendChat === 'function') {
      const attempt = deliver(sendChat, {message, sendId});
      chatDelivered = attempt.delivered;
      chatState = chatDelivered ? 'delivered' : 'CHAT_DELIVERY_PENDING';
      const box = readOutbox(l.outbox);
      if (chatDelivered) {
        if (box.pending[sendId]) { delete box.pending[sendId]; atomicJson(l.outbox, box); }
      } else {
        // Keyed by sendId, not by fingerprint: two occurrences of the same
        // defect must both stay pending instead of overwriting each other.
        box.pending[sendId] = {message, sendId, fingerprint: fp, occurrence: occurrences,
          createdAt: new Date(now).toISOString(), attempts: 1,
          lastAttemptAt: new Date(now).toISOString(), lastError: attempt.reason};
        atomicJson(l.outbox, box);
      }
    }
    ledger.fixes[fp] = {
      verified: true, at: new Date(now).toISOString(), defect: d.defect, report: reportPath,
      chatDelivered, sendId, occurrences,
      firstAt: record?.firstAt ?? new Date(now).toISOString(),
      recurrence: Boolean(record?.verified),
    };
    atomicJson(l.ledger, ledger);

    const pending = readOutbox(l.outbox).pending;
    return {schema: SCHEMA, status: 'fixed-and-verified', defect: d.defect, duplicate: false, changed: modified,
      report: reportPath, chatDelivered, chatState, sendId, rollback: 'backup-retained', readback,
      // Exact split: the files are verified; the live bot and its gates are not.
      onDiskVerified: true, loadedIntoActiveTurn, gateEnforcementVerified,
      reloadRequired: !loadedIntoActiveTurn,
      operatorAction: loadedIntoActiveTurn ? null : 'reload or restart the running OpenMausBot bot before the repaired rules apply',
      recurrence: occurrences > 1, occurrences,
      chatRetried: flushed.delivered.length, chatPending: Object.keys(pending).length};
  } finally {
    releaseLock(l);
  }
}

function parseArgs(argv) {
  const o = {};
  for (let i = 0; i < argv.length; i++) {
    const f = argv[i];
    if (f === '--apply') { o.apply = true; continue; }
    if (f === '--fixture') { o.allowFixture = true; continue; }
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
export function chatSenderForInstance(rcRoot, {run = spawnSync} = {}) {
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
    return {sendChat: ombChatSender({cli, port: instance.port, run}), reason: null};
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
export function runCli(argv, {run = spawnSync, platform = process.platform} = {}) {
  const a = parseArgs(argv);
  if (platform !== 'win32' && !a.allowFixture) fail('WINDOWS_ONLY_MUTATION');
  const rcRoot = a['--rc-root'] ?? (a['--data-dir'] ? resolve(a['--data-dir'], '..', '..') : null);
  const paths = {
    home: a['--home'] ?? homedir(),
    dataDir: a['--data-dir'] ?? (rcRoot ? join(rcRoot, 'state', 'omb') : null),
    workspace: a['--workspace'] ?? (rcRoot ? resolve(rcRoot, '..') : null),
  };
  if (!a.apply) return {schema: SCHEMA, mode: 'READ_ONLY', ...detect(paths)};
  let sendChat = null;
  let chatReason = 'RC_ROOT_NOT_DETERMINED';
  if (rcRoot) ({sendChat, reason: chatReason} = chatSenderForInstance(rcRoot, {run}));
  const out = repair(paths, {allowFixture: a.allowFixture, sendChat});
  if (!sendChat) out.chatReason = chatReason;
  return out;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const out = runCli(process.argv.slice(2));
    process.stdout.write(JSON.stringify(out) + '\n');
    if (out.status && out.status !== 'fixed-and-verified' && out.status !== 'already-fixed') process.exitCode = 1;
  } catch (error) {
    process.stderr.write(`SINGULARITY_MAINTENANCE_REPAIR_REFUSED: ${short(error)}\n`);
    process.exitCode = 2;
  }
}
