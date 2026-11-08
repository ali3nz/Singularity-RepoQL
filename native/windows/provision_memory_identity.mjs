#!/usr/bin/env node
/**
 * Native Windows memory identity provisioning.
 *
 * Why this exists
 * ---------------
 * The Linux/docker memory stack provisions its metadata store on first start:
 * `memory/upstream/start-memory-core.sh` calls
 * `POST /v3/internal/meta/user/init-admin` with a generated key, which creates
 * the `system_admin` user, the default team and `default-agent-<username>`.
 * The native Windows lifecycle only generated `stack.json` and started the
 * supervisor, so a fresh install shipped a MemoryCore whose metadata database
 * held 0 users / 0 teams / 0 agents.
 *
 * Two independent failures followed from that gap:
 *   1. `MetadataService.ensureChatMemoryAsset()` looks the agent up in the
 *      metadata store and throws `agent_not_found`, so every
 *      `/v3/conversation/add` logged
 *      `ensureChatMemoryAsset failed (team=openchamber-agents agent=claude-code-main)`
 *      and the agent never got its `chat_memory` asset.
 *   2. No admin user meant the panel/API could not authenticate at all.
 *
 * What it does (idempotent)
 * -------------------------
 *   1. admin user — POST /v3/internal/meta/user/init-admin for the product's
 *      instance id with a key generated once and persisted at
 *      `<memoryRoot>/state/secrets/admin-user-key`
 *      (409 already_initialized -> reuse the persisted key).
 *   2. team + agents — the product identity names are literal ids
 *      (`team_id = openchamber-agents`, `agent_id = claude-code-main`), and the
 *      MemoryCore HTTP API always mints random ids (`agt-…`, `team-…`), so the
 *      rows are written directly into
 *      `metadata/tdai_metadata_<instance>/metadata.db` with INSERT OR IGNORE
 *      inside one transaction. Existing rows are never updated or deleted.
 *   3. identity map — writes `<memoryRoot>/state/identity-map.json` in the shape
 *      `scripts/setup-agent-profiles.mjs` and
 *      `adapters/claude-code/memory-hook.mjs` accept
 *      (`{ "agents": { "<role>": { team_id, user_id, agent_id } } }`), bound to
 *      the same user id the parent hook uses (`pilot-operator` by default) so a
 *      role and its Claude Code twin share one recall scope.
 *
 * The database is backed up next to itself before the first write.
 * Receipts contain no key material.
 *
 * Ownership conflicts
 * -------------------
 * A requested agent id that already exists under another team is never
 * updated, stolen or bound in the identity map. The map omits it, the receipt
 * records it under `database.conflicts` (plus top-level `conflicts` and
 * `provisioned`), and a real run writes the truthful map and then exits
 * nonzero with `MEMORY_IDENTITY_CONFLICT`. A dry run reports the same data and
 * exits zero.
 */
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync, copyFileSync, statSync, renameSync, rmSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomBytes } from 'node:crypto';

export const DEFAULT_TEAM = 'openchamber-agents';
/** Request identity used by the parent hook (`mainConversationIdentity`). */
export const DEFAULT_IDENTITY_USER = 'pilot-operator';
/** init-admin username, matching the docker stack's `MEMORY_CORE_ADMIN_USERNAME`. */
export const DEFAULT_ADMIN_USERNAME = 'admin';
export const DEFAULT_INSTANCE_ID = 'default';
/**
 * Product identities the shipped hook attributes: the parent Claude Code
 * session plus every delegated role in `adapters/claude-code/agent-map.mjs`
 * (surface "subagent"). Main-session roles carry no MemoryCore identity.
 */
export const DEFAULT_AGENTS = Object.freeze([
  'claude-code-main',
  'code-reviewer',
  'researcher-web',
  'thinker',
  'explore',
  'general',
  'board',
]);

const ADMIN_KEY_FILE = join('state', 'secrets', 'admin-user-key');
const CORE_BEARER_FILE = join('state', 'secrets', 'core-bearer');
const HOOK_CONFIG_FILE = 'memory-hook.json';

function fail(code, detail) {
  const err = new Error(detail ? `${code}: ${detail}` : code);
  err.code = code;
  throw err;
}

/** `sk-mem-` + 32 base62 chars, the shape `metadata/utils/user-key.ts` accepts. */
export function generateUserKey() {
  const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
  const bytes = randomBytes(48);
  let out = '';
  for (const b of bytes) {
    if (out.length === 32) break;
    // The key only needs to be unguessable; the byte space is far larger than
    // 32 characters, so a plain modulo is not a meaningful bias here.
    out += alphabet[b % alphabet.length];
  }
  return `sk-mem-${out}`;
}

function loadSqlite() {
  // `node:sqlite` ships with the bundled Node 22.23 / 24 runtimes.
  // eslint-disable-next-line no-undef
  const mod = process.getBuiltinModule ? process.getBuiltinModule('node:sqlite') : null;
  if (!mod?.DatabaseSync) fail('NODE_SQLITE_UNAVAILABLE', 'this Node build has no node:sqlite');
  return mod;
}

/**
 * Instance ids are joined into the metadata path, so only a plain path segment
 * is accepted. This keeps a crafted memory-hook.json from reading or writing
 * outside `<baseDir>/metadata`.
 */
function assertInstanceId(value) {
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(value) || value.includes('..')) {
    fail('INSTANCE_ID_INVALID', value);
  }
  return value;
}

/**
 * Resolve the core port, the instance database and the secret files from the
 * live memory root. `memory-hook.json` pins the instance id the product uses;
 * `default` is the fallback and the only instance the installer creates.
 */
export function readLayout(memoryRoot) {
  const root = resolve(memoryRoot);
  const stackPath = join(root, 'stack.json');
  if (!existsSync(stackPath)) fail('STACK_CONFIG_MISSING', stackPath);
  const stack = JSON.parse(readFileSync(stackPath, 'utf8'));
  const core = stack?.components?.core;
  if (!core) fail('STACK_CORE_COMPONENT_MISSING', stackPath);
  const port = Number(core.port);
  if (!Number.isInteger(port) || port < 1 || port > 65535) fail('STACK_CORE_PORT_INVALID', String(core.port));
  // `native-memory-supervisor.mjs` forces `data.baseDir = <stateDir>/data/core`
  // when it writes the core config, so stack.json itself carries only stateDir.
  const stateDir = stack?.stateDir ? resolve(stack.stateDir) : join(root, 'state');
  const baseDir = core?.coreConfig?.data?.baseDir || join(stateDir, 'data', 'core');

  let instanceId = DEFAULT_INSTANCE_ID;
  const hookPath = join(root, HOOK_CONFIG_FILE);
  let hook = null;
  if (existsSync(hookPath)) {
    try { hook = JSON.parse(readFileSync(hookPath, 'utf8')); } catch { /* an unreadable hook config keeps the default instance */ }
  }
  // Deliberately outside the parse catch: an unsafe id must reject, not fall
  // back to `default` and silently provision the wrong database.
  if (typeof hook?.serviceId === 'string' && hook.serviceId.trim()) {
    instanceId = assertInstanceId(hook.serviceId.trim());
  }

  const metadataRoot = join(baseDir, 'metadata');
  const database = join(metadataRoot, `tdai_metadata_${instanceId}`, 'metadata.db');
  // A fresh store has no database file yet: the core creates it when the
  // internal init-admin call provisions the first system_admin user. Presence
  // is therefore verified after that call, not before it.
  // A fresh store has no metadata directory at all yet; init-admin creates it.
  const otherDatabases = (existsSync(metadataRoot) ? readdirSync(metadataRoot, { withFileTypes: true }) : [])
    .filter((entry) => entry.isDirectory())
    .map((entry) => join(metadataRoot, entry.name, 'metadata.db'))
    .filter((path) => existsSync(path) && path !== database);

  return {
    root,
    port,
    baseDir,
    instanceId,
    metadataRoot,
    database,
    otherDatabases,
    adminKeyFile: join(root, ADMIN_KEY_FILE),
    coreBearerFile: join(root, CORE_BEARER_FILE),
    identityMapFile: join(root, 'state', 'identity-map.json'),
  };
}

function readSecret(path, code) {
  if (!existsSync(path)) fail(code, path);
  const value = readFileSync(path, 'utf8').trim();
  if (!value) fail(code, path);
  return value;
}

async function postJson(baseUrl, path, body, headers, fetchImpl) {
  const res = await fetchImpl(`${baseUrl}${path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...headers },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(20000),
  });
  const text = await res.text();
  let json = null;
  try { json = JSON.parse(text); } catch { /* non-JSON error body */ }
  return { status: res.status, json, text };
}

/** Read the system_admin user id straight from a metadata database. */
export function readSystemAdminId(database) {
  const { DatabaseSync } = loadSqlite();
  let handle;
  try {
    handle = new DatabaseSync(database, { readOnly: true });
    const row = handle
      .prepare("SELECT user_id FROM meta_users WHERE user_type = 'system_admin' AND status = 'active' ORDER BY created_at LIMIT 1")
      .get();
    return row?.user_id ?? null;
  } catch {
    return null;
  } finally {
    try { handle?.close(); } catch { /* already closed */ }
  }
}

/**
 * Step 1 — admin user, mirroring `start-memory-core.sh`.
 * Returns `{ user_id, created, key_file }` without exposing the key.
 */
export async function ensureAdminUser({
  layout,
  username = DEFAULT_ADMIN_USERNAME,
  dryRun = false,
  fetchImpl = globalThis.fetch,
  log = () => {},
}) {
  const existingAdmin = readSystemAdminId(layout.database);
  if (dryRun) {
    return { user_id: existingAdmin, created: false, key_file: layout.adminKeyFile };
  }
  if (existingAdmin && existsSync(layout.adminKeyFile)) {
    log(`admin user already initialized (${username})`);
    return { user_id: existingAdmin, created: false, key_file: layout.adminKeyFile };
  }

  const coreBearer = readSecret(layout.coreBearerFile, 'CORE_BEARER_MISSING');
  const headers = { authorization: `Bearer ${coreBearer}`, 'x-tdai-service-id': layout.instanceId };
  let key = existsSync(layout.adminKeyFile) ? readFileSync(layout.adminKeyFile, 'utf8').trim() : '';
  if (!key) key = generateUserKey();

  const baseUrl = `http://127.0.0.1:${layout.port}`;
  const res = await postJson(baseUrl, '/v3/internal/meta/user/init-admin', { username, user_key: key }, headers, fetchImpl);

  if (res.status === 200) {
    mkdirSync(dirname(layout.adminKeyFile), { recursive: true });
    writeFileSync(layout.adminKeyFile, key, { mode: 0o600 });
    const userId = res.json?.data?.user_id;
    if (!userId) fail('INIT_ADMIN_RESPONSE_INVALID', res.text.slice(0, 200));
    log(`admin user created (${username})`);
    return { user_id: userId, created: true, key_file: layout.adminKeyFile };
  }

  if (res.status === 409) {
    if (!existsSync(layout.adminKeyFile)) {
      fail(
        'ADMIN_KEY_UNRECOVERABLE',
        'the metadata store already has users but state/secrets/admin-user-key is missing; ' +
        'the user key cannot be recovered (purge the memory state or create a new admin key)',
      );
    }
    const userId = readSystemAdminId(layout.database);
    if (!userId) fail('ADMIN_USER_LOOKUP_FAILED', 'no system_admin row found');
    log(`admin user already initialized (${username})`);
    return { user_id: userId, created: false, key_file: layout.adminKeyFile };
  }

  fail('INIT_ADMIN_FAILED', `HTTP ${res.status} ${res.text.slice(0, 200)}`);
}

/**
 * Step 2 — team + agent rows with the literal ids the product uses.
 * `INSERT OR IGNORE` semantics keep re-runs and pre-existing rows untouched.
 */
export function ensureIdentities({ database, teamId, ownerUserId, agents, dryRun = false }) {
  const { DatabaseSync } = loadSqlite();
  const now = new Date().toISOString();
  const handle = new DatabaseSync(database, dryRun ? { readOnly: true } : {});
  const result = { team: 'existing', members: 0, agents: [], skipped: [], conflicts: [] };
  try {
    if (!dryRun) {
      handle.exec('PRAGMA busy_timeout = 10000');
      handle.exec('BEGIN IMMEDIATE');
    }
    try {
      const teamRow = handle.prepare('SELECT team_id FROM meta_teams WHERE team_id = ?').get(teamId);
      if (teamRow) {
        result.team = 'existing';
      } else if (dryRun) {
        result.team = 'would_create';
      } else {
        handle.prepare(
          'INSERT INTO meta_teams (team_id, name, description, owner_user_id, status, created_at, updated_at, metadata_json) ' +
          "VALUES (?, ?, ?, ?, 'active', ?, ?, '{}')",
        ).run(teamId, teamId, 'Singularity native product identities', ownerUserId, now, now);
        result.team = 'created';
      }

      const member = handle
        .prepare('SELECT id FROM meta_team_members WHERE team_id = ? AND user_id = ?')
        .get(teamId, ownerUserId);
      if (!member && !dryRun) {
        handle.prepare(
          'INSERT INTO meta_team_members (id, team_id, user_id, role, joined_at, status) ' +
          "VALUES (?, ?, ?, 'admin', ?, 'active')",
        ).run(`mbr-${randomBytes(8).toString('hex')}`, teamId, ownerUserId, now);
        result.members = 1;
      }

      const existing = handle.prepare('SELECT agent_id, team_id, owner_user_id FROM meta_agents WHERE agent_id = ?');
      const insert = handle.prepare(
        'INSERT INTO meta_agents (agent_id, team_id, owner_user_id, name, description, prompt, visibility, status, created_at, updated_at, metadata_json) ' +
        "VALUES (?, ?, ?, ?, ?, '', 'team', 'active', ?, ?, ?)",
      );
      for (const agentId of agents) {
        const row = existing.get(agentId);
        if (row) {
          if (row.team_id === teamId) {
            result.skipped.push(agentId);
          } else {
            result.conflicts.push({
              agent_id: agentId,
              team_id: row.team_id ?? null,
              owner_user_id: row.owner_user_id ?? null,
            });
          }
          continue;
        }
        if (!dryRun) {
          insert.run(
            agentId,
            teamId,
            ownerUserId,
            agentId,
            `Singularity native agent ${agentId}`,
            now,
            now,
            '{"provisioned_by":"native-windows"}',
          );
        }
        result.agents.push(agentId);
      }
      if (!dryRun) handle.exec('COMMIT');
    } catch (err) {
      if (!dryRun) { try { handle.exec('ROLLBACK'); } catch { /* transaction already closed */ } }
      throw err;
    }
  } finally {
    try { handle.close(); } catch { /* already closed */ }
  }
  return result;
}

function backupDatabase(database) {
  const backup = `${database}.pre-provision-${Date.now()}.bak`;
  copyFileSync(database, backup);
  return { backup, size: statSync(backup).size };
}

/** Write the identity map consumed by setup-agent-profiles.mjs / memory-hook.mjs. */
export function writeIdentityMap({ file, teamId, userId, agents, dryRun = false }) {
  const map = { version: 1, team_id: teamId, user_id: userId, agents: {} };
  for (const agentId of agents) {
    map.agents[agentId] = { team_id: teamId, user_id: userId, agent_id: agentId };
  }
  if (!dryRun) {
    mkdirSync(dirname(file), { recursive: true });
    const temp = `${file}.tmp-${process.pid}`;
    try {
      writeFileSync(temp, JSON.stringify(map, null, 2) + '\n', { mode: 0o600 });
      renameSync(temp, file);
    } catch (err) {
      try { rmSync(temp, { force: true }); } catch { /* best-effort temp cleanup */ }
      throw err;
    }
  }
  return { file, agents: agents.length };
}

/**
 * Full provisioning run. Returns a receipt with no key material.
 * `dryRun` performs every read and skips every write.
 */
export async function provisionMemoryIdentity({
  memoryRoot,
  teamId = DEFAULT_TEAM,
  identityUser = DEFAULT_IDENTITY_USER,
  adminUsername = DEFAULT_ADMIN_USERNAME,
  agents = DEFAULT_AGENTS,
  dryRun = false,
  fetchImpl = globalThis.fetch,
  log = () => {},
  now = () => new Date().toISOString(),
} = {}) {
  if (!memoryRoot) fail('MEMORY_ROOT_REQUIRED');
  const layout = readLayout(memoryRoot);

  const receipt = {
    schema: 'singularity-native-memory-identity/v1',
    generated_at: now(),
    instance_id: layout.instanceId,
    team_id: teamId,
    identity_user: identityUser,
    admin_username: adminUsername,
    dry_run: dryRun,
    admin: null,
    database: null,
    identity_map: null,
    other_databases: layout.otherDatabases,
  };

  receipt.admin = await ensureAdminUser({ layout, username: adminUsername, dryRun, fetchImpl, log });
  if (!receipt.admin.user_id) {
    if (!dryRun) fail('ADMIN_USER_MISSING', 'no system_admin user after init-admin');
  }
  if (!dryRun && !existsSync(layout.database)) fail('METADATA_DATABASE_MISSING', layout.database);

  const entry = {};
  if (!dryRun) entry.backup = backupDatabase(layout.database).backup;
  const result = ensureIdentities({
    database: layout.database,
    teamId,
    ownerUserId: receipt.admin.user_id,
    agents,
    dryRun,
  });
  receipt.database = { path: layout.database, ...entry, ...result };

  const conflicted = new Set(result.conflicts.map((conflict) => conflict.agent_id));
  const mappedAgents = agents.filter((agentId) => !conflicted.has(agentId));
  receipt.provisioned = result.conflicts.length === 0;
  receipt.conflicts = result.conflicts;

  receipt.identity_map = writeIdentityMap({
    file: layout.identityMapFile,
    teamId,
    userId: identityUser,
    agents: mappedAgents,
    dryRun,
  });
  if (!dryRun && result.conflicts.length > 0) {
    const detail = result.conflicts
      .map((conflict) => `${conflict.agent_id}@${conflict.team_id ?? 'unknown-team'}`)
      .join(', ');
    const err = new Error(`MEMORY_IDENTITY_CONFLICT: ${detail}`);
    err.code = 'MEMORY_IDENTITY_CONFLICT';
    err.receipt = receipt;
    throw err;
  }
  return receipt;
}

// ---------------------------------------------------------------- CLI

function parseArgs(argv) {
  const args = {
    memoryRoot: '',
    teamId: DEFAULT_TEAM,
    identityUser: DEFAULT_IDENTITY_USER,
    adminUsername: DEFAULT_ADMIN_USERNAME,
    agents: null,
    dryRun: false,
    json: false,
  };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--memory-root') args.memoryRoot = argv[++i] ?? '';
    else if (arg === '--team') args.teamId = argv[++i] ?? DEFAULT_TEAM;
    else if (arg === '--identity-user') args.identityUser = argv[++i] ?? DEFAULT_IDENTITY_USER;
    else if (arg === '--admin-user') args.adminUsername = argv[++i] ?? DEFAULT_ADMIN_USERNAME;
    else if (arg === '--agents') args.agents = String(argv[++i] ?? '').split(',').map((s) => s.trim()).filter(Boolean);
    else if (arg === '--dry-run') args.dryRun = true;
    else if (arg === '--json') args.json = true;
    else fail('UNKNOWN_ARGUMENT', arg);
  }
  return args;
}

const invokedDirectly = process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (invokedDirectly) {
  const args = parseArgs(process.argv.slice(2));
  provisionMemoryIdentity({
    memoryRoot: args.memoryRoot,
    teamId: args.teamId,
    identityUser: args.identityUser,
    adminUsername: args.adminUsername,
    agents: args.agents ?? DEFAULT_AGENTS,
    dryRun: args.dryRun,
    log: (line) => { if (!args.json) process.stderr.write(`memory-identity: ${line}\n`); },
  }).then((receipt) => {
    process.stdout.write(`${JSON.stringify(receipt)}\n`);
  }).catch((err) => {
    // A conflict still reports the receipt (map excluded, provisioned=false)
    // before the nonzero exit so callers never see a success claim for it.
    if (err?.receipt) {
      try { process.stdout.write(`${JSON.stringify(err.receipt)}\n`); } catch { /* best-effort receipt */ }
    }
    process.stderr.write(`memory-identity: ${err?.code || 'FAILED'}: ${err?.message || err}\n`);
    process.exitCode = 1;
  });
}
