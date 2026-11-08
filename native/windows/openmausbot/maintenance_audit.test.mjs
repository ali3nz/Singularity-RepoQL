import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync, mkdirSync, writeFileSync} from 'node:fs';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {audit, runAuditCli} from './maintenance_audit.mjs';

const base = {home: '/test/user', workspace: '/test/work', dataDir: '/test/omb'};
const configuredInventory = () => ({staticInstallationComplete: true, claudeConfiguration: {issues: []},
  officialRepoqlPlugin: {issues: []}, kanzoProjectMcp: {issues: []}, openMausBotProjectMcp: {issues: []}});
const allProbes = {memory: () => ({status: 'CONFIGURED'}), kanzo: () => ({status: 'CONFIGURED'}),
  tencent: () => ({status: 'CONFIGURED'}), ghost: () => ({status: 'CONFIGURED'}),
  dashboard: () => ({status: 'CONFIGURED'}),
  dashboardQueue: () => ({status: 'CONFIGURED'}), productRun: () => ({status: 'CONFIGURED'})};

function docManifest() {
  const root = mkdtempSync(join(tmpdir(), 'singularity-audit-'));
  mkdirSync(join(root, 'docs'), {recursive: true});
  writeFileSync(join(root, 'docs', 'pinned.md'),
    'Pinned test document used only for reconciliation planning.\nDOCPARITY-abcdefgh\n');
  return {root, manifest: {schema: 'singularity-claude-complete-reconciliation-manifest/v1',
    documents: [{file: 'docs/pinned.md', marker: 'DOCPARITY-abcdefgh'}]}};
}

test('read-only audit composes the verifiers and reports configuration only', async () => {
  const {root, manifest} = docManifest();
  const report = await audit({home: root, workspace: root, dataDir: join(root, 'omb'), manifest,
    checkInventory: configuredInventory, checkRules: () => ({verified: true}), probes: allProbes});
  assert.equal(report.mode, 'READ_ONLY');
  assert.equal(report.repairsAttempted, 0);
  assert.equal(report.ombChatDelivered, false);
  assert.equal(report.repairVerified, false);
  assert.equal(report.healthy, true);
  const byComponent = Object.fromEntries(report.checks.map((c) => [c.component, c]));
  assert.equal(byComponent['documentation-reconciliation'].status, 'CONFIGURED');
  assert.equal(byComponent['memorycore-profiles-capture-recall'].status, 'CONFIGURED');
  assert.equal(byComponent['maintenance-own-state'].status, 'CONFIGURED');
});

test('missing rule, inventory or live probe returns bounded codes, not details', async () => {
  const report = await audit({...base,
    checkInventory: () => { throw Error('secret token SHOULD_NOT_APPEAR'); },
    checkRules: () => { throw Error('private account path SHOULD_NOT_APPEAR'); }});
  assert.equal(report.healthy, false);
  assert.doesNotMatch(JSON.stringify(report), /SHOULD_NOT_APPEAR|secret token|private account/);
  const byComponent = Object.fromEntries(report.checks.map((c) => [c.component, c]));
  assert.equal(byComponent['claude-hooks-agents-repoql-kanzo'].status, 'NOT_VERIFIED');
  assert.equal(byComponent['openmausbot-shared-rules'].status, 'NOT_VERIFIED');
  // Live probers are NOT_VERIFIED without evidence, never assumed healthy.
  for (const component of ['kanzo-board', 'tencent-recovery', 'ghost-scheduling', 'dashboard-agents-control']) {
    assert.equal(byComponent[component].status, 'NOT_VERIFIED');
  }
  assert.equal(byComponent['documentation-reconciliation'].issues[0], 'DOC_MANIFEST_NOT_SHIPPED');
  assert.equal(byComponent['product-run-timing'].issues[0], 'NO_PRODUCT_RUN_TIMING_SOURCE');
  for (const check of report.checks) for (const issue of check.issues) assert.match(issue, /^[A-Z0-9_]{3,96}$/);
});

test('a failing live probe degrades to NOT_VERIFIED with its own code', async () => {
  const report = await audit({...base, checkInventory: configuredInventory,
    checkRules: () => ({verified: true}),
    probes: {...allProbes, tencent: () => { throw Error('TENCENT_LEDGER_UNREACHABLE'); }}});
  const tencent = report.checks.find((c) => c.component === 'tencent-recovery');
  assert.equal(tencent.status, 'NOT_VERIFIED');
  assert.deepEqual(tencent.issues, ['TENCENT_LEDGER_UNREACHABLE']);
});

test('a stuck product-owned lock and pending chat are detected, never killed', async () => {
  const root = mkdtempSync(join(tmpdir(), 'singularity-audit-lock-'));
  const dir = join(root, 'reports', 'maintenance');
  mkdirSync(dir, {recursive: true});
  writeFileSync(join(dir, '.lock'), JSON.stringify({pid: 2147483646, at: new Date(0).toISOString()}));
  writeFileSync(join(dir, '.outbox.json'), JSON.stringify({schema: 1, pending: {
    a: {sendId: 'a'}, b: {sendId: 'b'}}}));
  const report = await audit({home: root, workspace: root, dataDir: join(root, 'omb'),
    checkInventory: configuredInventory, checkRules: () => ({verified: true}), probes: allProbes});
  const own = report.checks.find((c) => c.component === 'maintenance-own-state');
  assert.equal(own.status, 'NEEDS_ATTENTION');
  assert.deepEqual(own.issues, ['MAINTENANCE_LOCK_STUCK', 'MAINTENANCE_CHAT_PENDING']);
  assert.equal(own.pendingChats, 2);
  assert.equal(report.stuckMaintenance.stuck, true);
  assert.equal(report.stuckMaintenance.remediation, 'RELEASE_OWNED_MAINTENANCE_LOCK');
  assert.equal(report.healthy, false);
});

test('this process holding a fresh lock is busy, not stuck', async () => {
  const root = mkdtempSync(join(tmpdir(), 'singularity-audit-live-'));
  const dir = join(root, 'reports', 'maintenance');
  mkdirSync(dir, {recursive: true});
  writeFileSync(join(dir, '.lock'), JSON.stringify({pid: process.pid, at: new Date().toISOString()}));
  const report = await audit({home: root, workspace: root, dataDir: join(root, 'omb'),
    checkInventory: configuredInventory, checkRules: () => ({verified: true}), probes: allProbes});
  const own = report.checks.find((c) => c.component === 'maintenance-own-state');
  assert.equal(own.status, 'CONFIGURED');
  assert.equal(report.stuckMaintenance.stuck, false);
  assert.equal(report.stuckMaintenance.remediation, 'WAIT_FOR_CURRENT_RUN');
});

test('the scheduled audit executes the existing read-only CLIs by default', async () => {
  const root = mkdtempSync(join(tmpdir(), 'singularity-audit-cli-'));
  mkdirSync(join(root, 'native', 'windows'), {recursive: true});
  writeFileSync(join(root, 'native', 'windows', 'audit_kanzo_board.ps1'), '');
  writeFileSync(join(root, 'native', 'windows', 'claude_complete_dashboard_host.py'), '');
  const calls = [];
  const run = (command, args) => {
    calls.push([command, ...args].join(' '));
    if (command === 'powershell.exe') return {status: 0, stdout: '{"tasks":3}', stderr: ''};
    if (args.includes('--live')) return {status: 0, stdout: JSON.stringify({searchSeparationObserved: true, issues: []}), stderr: ''};
    if (args.includes('--mode')) return {status: 0, stdout: '', stderr: ''};
    return {status: 1, stdout: '', stderr: 'UNEXPECTED' };
  };
  const report = await audit({home: root, workspace: root, dataDir: join(root, 'omb'), platform: 'win32', run,
    checkInventory: configuredInventory, checkRules: () => ({verified: true}),
    probes: {memory: () => ({status: 'CONFIGURED'}), env: {probeFile: '/p.json', memoryConfig: '/m.json'},
      rqlExe: '/rql.exe', dashboardStateDir: '/state'}});
  const byComponent = Object.fromEntries(report.checks.map((c) => [c.component, c]));
  assert.equal(byComponent['kanzo-board'].status, 'CONFIGURED');
  assert.equal(byComponent['ghost-scheduling'].status, 'CONFIGURED');
  assert.equal(byComponent['dashboard-agents-control'].status, 'CONFIGURED');
  assert.equal(byComponent['tencent-recovery'].status, 'NOT_VERIFIED');
  assert.deepEqual(byComponent['tencent-recovery'].issues, ['TENCENT_RECOVERY_MUTATING_ONLY']);
  assert.ok(calls.some((c) => c.includes('audit_kanzo_board.ps1') && c.includes('-SourceRoot')));
  assert.ok(calls.some((c) => c.includes('--live') && c.includes('--probe-file')));
  assert.ok(calls.some((c) => c.includes('--mode check')));
});

test('the Ghost probe reuses the memory config Configure recorded, without printing it', async () => {
  const root = mkdtempSync(join(tmpdir(), 'singularity-audit-ghost-'));
  mkdirSync(join(root, 'native', 'windows'), {recursive: true});
  mkdirSync(join(root, '.claude'), {recursive: true});
  writeFileSync(join(root, 'native', 'windows', 'audit_kanzo_board.ps1'), '');
  writeFileSync(join(root, '.claude', 'settings.json'), JSON.stringify({
    env: {SINGULARITY_MEMORY_CONFIG: '/private/memory.json'}}));
  const calls = [];
  const run = (command, args) => {
    calls.push([command, ...args].join(' '));
    if (args.includes('--live')) return {status: 0, stdout: JSON.stringify({searchSeparationObserved: true, issues: []}), stderr: ''};
    return {status: 1, stdout: '', stderr: 'UNEXPECTED'};
  };
  const report = await audit({home: root, workspace: root, dataDir: join(root, 'omb'), platform: 'win32', run,
    checkInventory: configuredInventory, checkRules: () => ({verified: true}),
    probes: {memory: () => ({status: 'CONFIGURED'}), env: {probeFile: '/probe.json'}}});
  const ghost = report.checks.find((c) => c.component === 'ghost-scheduling');
  assert.equal(ghost.status, 'CONFIGURED');
  assert.ok(calls.some((c) => c.includes('--memory-config /private/memory.json')));
  assert.doesNotMatch(JSON.stringify(report), /memory\.json/);
});

test('doc ingestion backlog is read from the product ledger as counts only', async () => {
  const root = mkdtempSync(join(tmpdir(), 'singularity-audit-queue-'));
  mkdirSync(join(root, 'data', 'doc-index'), {recursive: true});
  writeFileSync(join(root, 'data', 'doc-index', 'ledger.json'), JSON.stringify({version: 1, docs: {
    a: {rel: 'docs/a.md', active_rev: 'r1', revs: {r1: {status: 'DOC_INGEST_PENDING'}}},
    b: {rel: 'docs/b.md', active_rev: 'r1', revs: {r1: {status: 'DOC_INGEST_VERIFIED'}}},
  }}));
  const probe = (probes) => audit({home: root, workspace: root, dataDir: join(root, 'omb'),
    checkInventory: configuredInventory, checkRules: () => ({verified: true}), probes});
  const report = await probe({memory: () => ({status: 'CONFIGURED'})});
  const queue = report.checks.find((c) => c.component === 'doc-ingestion-queue');
  assert.equal(queue.status, 'NEEDS_ATTENTION');
  assert.deepEqual(queue.issues, ['DOC_INGEST_PENDING_DOCUMENTS']);
  assert.equal(queue.documents, 2);
  assert.equal(queue.pending, 1);
  assert.doesNotMatch(JSON.stringify(report), /docs\/a\.md/);

  writeFileSync(join(root, 'data', 'doc-index', 'ledger.json'), '{not json');
  const broken = await probe({memory: () => ({status: 'CONFIGURED'})});
  const corrupt = broken.checks.find((c) => c.component === 'doc-ingestion-queue');
  assert.equal(corrupt.status, 'NOT_VERIFIED');
  assert.deepEqual(corrupt.issues, ['DOC_LEDGER_CORRUPT']);
});

test('validates absolute locations', async () => {
  await assert.rejects(() => audit({...base, home: './relative'}), /ABSOLUTE/);
});

test('the CLI derives home and workspace instead of dying before the first check', async () => {
  const root = mkdtempSync(join(tmpdir(), 'singularity-audit-argv-'));
  const dataDir = join(root, 'state', 'omb');
  mkdirSync(dataDir, {recursive: true});
  const report = await runAuditCli(['--data-dir', dataDir], {platform: 'win32',
    checkInventory: configuredInventory, checkRules: () => ({verified: true}), probes: allProbes});
  assert.equal(report.schema, 'singularity-windows-maintenance-audit/v1');
  assert.ok(report.checks.length >= 8);
  // workspace came from the instance root above the data dir
  assert.ok(report.checks.some((c) => c.component === 'documentation-reconciliation'));
});

test('the CLI still refuses without a data dir', async () => {
  await assert.rejects(() => runAuditCli([], {platform: 'win32'}), /DATA_DIR_REQUIRED/);
  await assert.rejects(() => runAuditCli(['--data-dir', '/x'], {platform: 'linux'}), /WINDOWS_ONLY/);
});
