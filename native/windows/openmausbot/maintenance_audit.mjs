#!/usr/bin/env node
/** Read-only maintenance diagnostics for the one Windows OpenMausBot Maintainer.
 * Reuses installed verifiers; no new state store, hooks, schedules or repairs.
 * Only returns bounded status codes, never paths, credentials or hook contents.
 *
 * Composition (all read-only):
 * - static inventory (agents, hooks, RepoQL plugin, Kanzo/OMB MCP presence)
 * - Windows Ghost execution applicability (retired, so no execution is attempted)
 * - OMB shared rules on disk
 * - memory profiles in plan mode (no credentials, no live calls)
 * - documentation reconciliation plan when a manifest is supplied
 * - Tencent recovery / dashboard: live probes are injected by the
 *   caller; without them the component is NOT_VERIFIED, never assumed healthy
 * - product-owned maintenance state: a lock left by a dead pid and pending chat
 *   are reported from the repair module's own files. Nothing is killed or edited.
 */
import {existsSync, readFileSync, lstatSync} from 'node:fs';
import {isAbsolute, resolve, join, dirname} from 'node:path';
import {fileURLToPath} from 'node:url';
import {spawnSync} from 'node:child_process';
import {homedir} from 'node:os';
import {inventory} from '../claude_complete_static_inventory.mjs';
import {verifyRules} from './install_shared_rules.mjs';

const CODE = /^[A-Z0-9_]{3,96}$/;
const bounded = (list) => [...new Set((list ?? []).filter((x) => typeof x === 'string' && CODE.test(x)))].slice(0, 30);
const codeOf = (error, fallback) => {
  const text = String(error?.message || error);
  const found = text.match(/[A-Z][A-Z0-9_]{2,95}/);
  return found ? found[0] : fallback;
};
const readJson = (file) => {
  try { return JSON.parse(readFileSync(file, 'utf8')); } catch { return null; }
};

function pidAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try { process.kill(pid, 0); return true; } catch (error) { return error?.code === 'EPERM'; }
}

/** The repair module's own lock/outbox are the only evidence used here. No
 *  process is signalled: a stuck run is reported, never killed. */
function maintenanceState(home, now = Date.now()) {
  const dir = join(home, 'reports', 'maintenance');
  const lockFile = join(dir, '.lock');
  const outboxFile = join(dir, '.outbox.json');
  const state = {lock: null, pendingChats: 0};
  if (existsSync(lockFile) && lstatSync(lockFile).isFile() && !lstatSync(lockFile).isSymbolicLink()) {
    const lock = readJson(lockFile);
    if (lock && Number.isInteger(lock.pid)) {
      const at = Date.parse(lock.at);
      const ageMs = Number.isFinite(at) ? Math.max(0, now - at) : null;
      const alive = pidAlive(lock.pid);
      const stale = ageMs === null || ageMs >= 30 * 60 * 1000;
      state.lock = {pid: lock.pid, alive, ageMs, stale,
        stuck: !alive || stale,
        // This process is the product's own maintenance run, not a user process.
        remediation: alive && !stale ? 'WAIT_FOR_CURRENT_RUN' : 'RELEASE_OWNED_MAINTENANCE_LOCK'};
    }
  }
  if (existsSync(outboxFile)) {
    const box = readJson(outboxFile);
    if (box && box.pending && typeof box.pending === 'object') state.pendingChats = Object.keys(box.pending).length;
  }
  return state;
}

function external(run, command, args) {
  try {
    return run(command, args, {encoding: 'utf8', timeout: 120000, windowsHide: true, shell: false,
      maxBuffer: 4 * 1024 * 1024});
  } catch (error) {
    return {error, status: null, stdout: '', stderr: ''};
  }
}
const failureCode = (result, fallback) => {
  const text = `${result?.stderr ?? ''}\n${result?.error?.message ?? ''}`;
  const found = text.match(/[A-Z][A-Z0-9_]{5,95}/);
  return found ? found[0] : fallback;
};

/** The existing read-only Kanzo board auditor, run where it can run. */
async function kanzoProbe({workspace, run = spawnSync, platform = process.platform}) {
  if (platform !== 'win32') return {status: 'NOT_VERIFIED', issues: ['WINDOWS_ONLY']};
  const script = join(workspace, 'native', 'windows', 'audit_kanzo_board.ps1');
  if (!existsSync(script)) return {status: 'NOT_VERIFIED', issues: ['KANZO_AUDIT_SCRIPT_MISSING']};
  const result = external(run, 'powershell.exe', ['-NoLogo', '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass',
    '-File', script, '-SourceRoot', workspace]);
  if (result?.status !== 0) return {status: 'NOT_VERIFIED', issues: [failureCode(result, 'KANZO_BOARD_AUDIT_FAILED')]};
  return {status: 'CONFIGURED', issues: []};
}

/** The existing dashboard launcher's read-only `--mode check` preflight. */
async function dashboardProbe({workspace, run = spawnSync, platform = process.platform, probes = {}}) {
  if (platform !== 'win32') return {status: 'NOT_VERIFIED', issues: ['WINDOWS_ONLY']};
  const rqlExe = probes.rqlExe ?? process.env.SINGULARITY_RQL_EXE;
  const stateDir = probes.dashboardStateDir ?? process.env.SINGULARITY_DASHBOARD_STATE;
  if (!rqlExe || !stateDir) return {status: 'NOT_VERIFIED', issues: ['DASHBOARD_CHECK_INPUTS_MISSING']};
  const host = join(workspace, 'native', 'windows', 'claude_complete_dashboard_host.py');
  if (!existsSync(host)) return {status: 'NOT_VERIFIED', issues: ['DASHBOARD_HOST_SCRIPT_MISSING']};
  const python = probes.python ?? process.env.SINGULARITY_PYTHON ?? (platform === 'win32' ? 'python' : 'python3');
  const result = external(run, python,
    [host, '--mode', 'check', '--source-root', workspace, '--rql-exe', rqlExe,
      '--workspace', workspace, '--state-dir', stateDir]);
  if (result?.error?.code === 'ENOENT') return {status: 'NOT_VERIFIED', issues: ['DASHBOARD_PYTHON_NOT_AVAILABLE']};
  if (result?.status !== 0) return {status: 'NOT_VERIFIED', issues: [failureCode(result, 'DASHBOARD_CHECK_FAILED')]};
  return {status: 'CONFIGURED', issues: []};
}

/** The doc-ingest ledger the product's own hook writes (`scripts/doc-ingest-node.mjs`).
 *  Read-only: no ingest, no lock, no network. Only counts are returned. */
async function docQueueProbe({workspace, probes = {}}) {
  const dataDir = probes.docDataDir ?? process.env.SINGULARITY_DOC_DATA ?? join(workspace, 'data');
  const {loadLedger} = await import('../../../scripts/doc-ingest-node.mjs');
  const ledger = loadLedger({SINGULARITY_DOC_DATA: dataDir});
  const docs = Object.values(ledger.docs ?? {});
  if (!docs.length) return {status: 'NOT_VERIFIED', issues: ['DOC_LEDGER_EMPTY'], detail: {documents: 0, pending: 0, blocked: 0}};
  let pending = 0;
  let blocked = 0;
  for (const entry of docs) {
    const rev = entry && entry.active_rev ? entry.revs?.[entry.active_rev] : null;
    const status = rev?.status;
    if (!status || status === 'DOC_INGEST_PENDING' || status === 'DOC_INGEST_FAILED') pending++;
    else if (status === 'DOC_INGEST_BLOCKED') blocked++;
  }
  const issues = [];
  if (pending) issues.push('DOC_INGEST_PENDING_DOCUMENTS');
  if (blocked) issues.push('DOC_INGEST_BLOCKED_DOCUMENTS');
  return {status: issues.length ? 'NEEDS_ATTENTION' : 'CONFIGURED', issues,
    detail: {documents: docs.length, pending, blocked}};
}

async function runExternal(component, fallback, probe) {
  try {
    const result = await probe();
    return {status: ['CONFIGURED', 'NEEDS_ATTENTION', 'NOT_VERIFIED'].includes(result?.status)
      ? result.status : 'NOT_VERIFIED', issues: bounded(result?.issues)};
  } catch (error) {
    return {status: 'NOT_VERIFIED', issues: [codeOf(error, fallback)]};
  }
}

async function runProbe(probe, fallback) {
  if (typeof probe !== 'function') return {status: 'NOT_VERIFIED', issues: [fallback]};
  try {
    const result = await probe();
    const status = ['CONFIGURED', 'NEEDS_ATTENTION', 'NOT_VERIFIED'].includes(result?.status)
      ? result.status : 'NOT_VERIFIED';
    return {status, issues: bounded(result?.issues)};
  } catch (error) {
    return {status: 'NOT_VERIFIED', issues: [codeOf(error, fallback)]};
  }
}

export async function audit({home, workspace, dataDir, manifest = null, now = Date.now(),
  checkInventory = inventory, checkRules = verifyRules, probes = {},
  run = spawnSync, platform = process.platform} = {}) {
  if (!home || !workspace || !dataDir || ![home, workspace, dataDir].every(isAbsolute))
    throw Error('ABSOLUTE_PATHS_REQUIRED');
  const result = {schema: 'singularity-windows-maintenance-audit/v1', mode: 'READ_ONLY',
    checks: [], repairsAttempted: 0, repairVerified: false, ombChatDelivered: false,
    stuckMaintenance: null};
  const push = (component, status, issues = [], extra = {}) =>
    result.checks.push({component, status, issues: bounded(issues), ...extra});

  try {
    const c = checkInventory({home, workspace});
    push('claude-hooks-agents-repoql-kanzo',
      c.staticInstallationComplete === true ? 'CONFIGURED' : 'NEEDS_ATTENTION',
      [...(c.claudeConfiguration?.issues ?? []), ...(c.officialRepoqlPlugin?.issues ?? []),
        ...(c.kanzoProjectMcp?.issues ?? []), ...(c.openMausBotProjectMcp?.issues ?? [])]);
  } catch { push('claude-hooks-agents-repoql-kanzo', 'NOT_VERIFIED', ['INVENTORY_CHECK_FAILED']); }

  // Ghost is retired from the Windows product; absence is the intended state.
  // This records applicability only and never executes or reinstalls Ghost.
  push('windows-ghost-execution', 'NOT_APPLICABLE', ['WINDOWS_GHOST_RETIRED']);

  try {
    const r = checkRules({dataDir});
    push('openmausbot-shared-rules', r.verified === true ? 'CONFIGURED' : 'NEEDS_ATTENTION',
      r.verified === true ? [] : ['RULES_NOT_VERIFIED']);
  } catch { push('openmausbot-shared-rules', 'NOT_VERIFIED', ['OMB_RULES_NOT_VERIFIED']); }

  // Memory profiles: the existing verifier in plan mode. The identity map is
  // read through the product's own loader (AGENT_PROFILE_IDENTITY_MAP), so the
  // check is genuinely executed; a missing map is a configuration gap, not an
  // absent code path.
  if (typeof probes.memory === 'function') {
    const {status, issues} = await runProbe(probes.memory, 'MEMORY_PROFILE_CHECK_FAILED');
    push('memorycore-profiles-capture-recall', status, issues);
  } else {
    try {
      const {assessDelegatedProfiles} = await import('../claude_complete_memory_profiles.mjs');
      const {loadIdentityMap} = await import('../../../scripts/setup-agent-profiles.mjs');
      const mapPath = probes.identityMapPath ?? process.env.AGENT_PROFILE_IDENTITY_MAP;
      if (!mapPath) throw new Error('IDENTITY_MAP_NOT_PROVIDED');
      const receipt = await assessDelegatedProfiles({mode: 'plan', map: loadIdentityMap(mapPath)});
      const issues = bounded(receipt?.issues);
      const status = issues.includes('LIVE_MEMORYCORE_READBACK_REQUIRED') ? 'NOT_VERIFIED'
        : issues.length ? 'NEEDS_ATTENTION' : 'CONFIGURED';
      push('memorycore-profiles-capture-recall', status, issues);
    } catch (error) {
      push('memorycore-profiles-capture-recall', 'NOT_VERIFIED', [codeOf(error, 'MEMORY_PROFILE_CHECK_FAILED')]);
    }
  }

  // Documentation lifecycle: reconciliation planning is local and read-only.
  if (manifest && typeof manifest === 'object') {
    try {
      const {planReconciliation} = await import('../claude_complete_doc_reconciliation.mjs');
      const documents = planReconciliation(workspace, manifest);
      push('documentation-reconciliation', 'CONFIGURED', [], {documents: documents.length});
    } catch (error) {
      push('documentation-reconciliation', 'NEEDS_ATTENTION', [codeOf(error, 'DOC_RECONCILIATION_INVALID')]);
    }
  } else {
    push('documentation-reconciliation', 'NOT_VERIFIED', ['DOC_MANIFEST_NOT_SHIPPED']);
  }

  // The default audit executes the existing bounded read-only CLIs itself, so
  // the scheduled sweep probes what this machine can actually run. A prober that
  // needs a private config or an unbuilt artefact reports that exact reason.
  const probeOrDefault = async (component, fallback, run) => {
    const probe = probes[component] ?? probes[component.split('-')[0]];
    const {status, issues} = typeof probe === 'function'
      ? await runProbe(probe, fallback) : await runExternal(component, fallback, run);
    push(component, status, issues);
  };

  await probeOrDefault('kanzo-board', 'KANZO_BOARD_AUDIT_NOT_BUILT', () => kanzoProbe({workspace, run, platform}));
  await probeOrDefault('tencent-recovery', 'TENCENT_RECOVERY_MUTATING_ONLY', () => ({
    status: 'NOT_VERIFIED',
    issues: ['TENCENT_RECOVERY_MUTATING_ONLY'],
  }));
  await probeOrDefault('dashboard-agents-control', 'DASHBOARD_CHECK_INPUTS_MISSING', () => dashboardProbe({workspace, run, probes, platform}));

  // Ingestion backlog: the product's own doc-ingest ledger is a plain read-only
  // JSON file, so the scheduled audit reads it directly. No dashboard runtime,
  // network call, lock or ingest is needed, and only counts are reported.
  try {
    const queueProbe = probes.docQueue ?? probes.dashboardQueue;
    if (typeof queueProbe === 'function') {
      const {status, issues} = await runProbe(queueProbe, 'DOC_QUEUE_CHECK_FAILED');
      push('doc-ingestion-queue', status, issues);
    } else {
      const {status, issues, detail} = await docQueueProbe({workspace, probes});
      push('doc-ingestion-queue', status, issues, detail);
    }
  } catch (error) {
    push('doc-ingestion-queue', 'NOT_VERIFIED', [codeOf(error, 'DOC_QUEUE_CHECK_FAILED')]);
  }
  push('product-run-timing', probes.productRun ? (await runProbe(probes.productRun, 'PRODUCT_RUN_CHECK_FAILED')).status : 'NOT_VERIFIED',
    probes.productRun ? (await runProbe(probes.productRun, 'PRODUCT_RUN_CHECK_FAILED')).issues : ['NO_PRODUCT_RUN_TIMING_SOURCE']);

  // Product-owned maintenance state: detect a stuck run and pending chat from
  // the repair module's own receipt/lock evidence only.
  const maintenance = maintenanceState(home, now);
  result.stuckMaintenance = maintenance.lock;
  const maintenanceIssues = [];
  if (maintenance.lock?.stuck) maintenanceIssues.push('MAINTENANCE_LOCK_STUCK');
  if (maintenance.pendingChats > 0) maintenanceIssues.push('MAINTENANCE_CHAT_PENDING');
  push('maintenance-own-state',
    maintenanceIssues.length ? 'NEEDS_ATTENTION' : 'CONFIGURED',
    maintenanceIssues,
    {pendingChats: maintenance.pendingChats, lock: maintenance.lock});

  result.healthy = result.checks.every((c) => c.status === 'CONFIGURED' ||
    (c.component === 'windows-ghost-execution' && c.status === 'NOT_APPLICABLE' &&
      c.issues.length === 1 && c.issues[0] === 'WINDOWS_GHOST_RETIRED'));
  return result;
}

function parse(argv) {
  const o = {};
  for (let i = 0; i < argv.length; i++) {
    const f = argv[i];
    if (!['--home', '--workspace', '--data-dir', '--manifest'].includes(f) || !argv[i + 1] ||
        argv[i + 1].startsWith('--') || o[f]) throw Error('INVALID_ARGS');
    o[f] = argv[++i];
  }
  return {home: o['--home'], workspace: o['--workspace'], dataDir: o['--data-dir'], manifestFile: o['--manifest']};
}

/**
 * The audit CLI body. `--home` defaults to the running user's home and
 * `--workspace` to the instance root above `--data-dir`, so the scheduled
 * command never dies on ABSOLUTE_PATHS_REQUIRED before any check runs.
 */
export async function runAuditCli(argv, {run = spawnSync, platform = process.platform,
  checkInventory = inventory, checkRules = verifyRules, probes = {}} = {}) {
  if (platform !== 'win32') throw Error('WINDOWS_ONLY');
  const a = parse(argv);
  const dataDir = a.dataDir;
  if (!dataDir) throw Error('DATA_DIR_REQUIRED');
  const workspace = a.workspace ?? resolve(dataDir, '..', '..');
  const home = a.home ?? homedir();
  let manifest = null;
  if (a.manifestFile) {
    const {loadManifest} = await import('../claude_complete_doc_reconciliation.mjs');
    manifest = loadManifest(a.manifestFile);
  }
  return audit({home, workspace, dataDir, manifest, checkInventory, checkRules, probes, run, platform});
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  runAuditCli(process.argv.slice(2)).then((r) => {
    process.stdout.write(JSON.stringify(r) + '\n');
    process.exitCode = r.healthy ? 0 : 1;
  }).catch((e) => {
    process.stderr.write('SINGULARITY_MAINTENANCE_AUDIT_REFUSED: ' + String(e?.message || e).slice(0, 120) + '\n');
    process.exitCode = 2;
  });
}
