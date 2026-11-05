// Tests for native/windows/provision_memory_identity.mjs — no real MemoryCore is
// contacted: the admin call goes to a fake fetch and the identities are written
// into a throwaway SQLite database with the production meta_* schema subset.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, rmSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  DEFAULT_AGENTS,
  DEFAULT_TEAM,
  provisionMemoryIdentity,
  readLayout,
} from './provision_memory_identity.mjs';

const DDL = `
CREATE TABLE meta_users (
  user_id TEXT PRIMARY KEY, password TEXT, auth_provider TEXT, external_id TEXT, username TEXT,
  display_name TEXT, email TEXT, raw_profile_json TEXT, status TEXT, user_type TEXT,
  created_at TEXT, updated_at TEXT, metadata_json TEXT
);
CREATE TABLE meta_teams (
  team_id TEXT PRIMARY KEY, name TEXT, description TEXT, owner_user_id TEXT, status TEXT,
  created_at TEXT, updated_at TEXT, metadata_json TEXT
);
CREATE TABLE meta_team_members (
  id TEXT PRIMARY KEY, team_id TEXT, user_id TEXT, role TEXT, joined_at TEXT, status TEXT,
  UNIQUE(team_id, user_id)
);
CREATE TABLE meta_agents (
  agent_id TEXT PRIMARY KEY, team_id TEXT, owner_user_id TEXT, name TEXT, description TEXT,
  prompt TEXT, visibility TEXT, status TEXT, created_at TEXT, updated_at TEXT, metadata_json TEXT
);
`;

function fixture({ withAdmin = false, withKey = false, instance = 'default', serviceId = 'default' } = {}) {
  const root = mkdtempSync(join(tmpdir(), 'memory-identity-'));
  const baseDir = join(root, 'state', 'data', 'core');
  const metadataDir = join(baseDir, 'metadata', `tdai_metadata_${instance}`);
  mkdirSync(metadataDir, { recursive: true });
  const database = join(metadataDir, 'metadata.db');
  const db = new DatabaseSync(database);
  db.exec(DDL);
  if (withAdmin) {
    db.prepare(
      "INSERT INTO meta_users (user_id, status, user_type, created_at, updated_at) VALUES ('usr-admin','active','system_admin','2026-01-01T00:00:00.000Z','2026-01-01T00:00:00.000Z')",
    ).run();
  }
  db.close();

  writeFileSync(join(root, 'stack.json'), JSON.stringify({
    schema: 'native-memory-supervisor/v1',
    stateDir: join(root, 'state'),
    components: {
      core: {
        port: 18421,
      },
    },
  }));
  writeFileSync(join(root, 'memory-hook.json'), JSON.stringify({ serviceId }));
  mkdirSync(join(root, 'state', 'secrets'), { recursive: true });
  writeFileSync(join(root, 'state', 'secrets', 'core-bearer'), 'test-bearer\n', { mode: 0o600 });
  if (withKey) writeFileSync(join(root, 'state', 'secrets', 'admin-user-key'), 'sk-mem-existing\n', { mode: 0o600 });
  return { root, baseDir, database, cleanup: () => rmSync(root, { recursive: true, force: true }) };
}

function fakeFetch({ status = 200, userId = 'usr-admin' } = {}) {
  const calls = [];
  const impl = async (url, init) => {
    calls.push({ url, body: JSON.parse(init.body), headers: init.headers });
    const payload = status === 200
      ? { code: 0, message: 'ok', data: { user_id: userId, user_key: 'redacted' } }
      : { code: 409, message: 'already_initialized' };
    return { status, text: async () => JSON.stringify(payload) };
  };
  return { impl, calls };
}

test('a fresh install gets the admin user, team, agents and identity map', async () => {
  const fx = fixture();
  try {
    const { impl, calls } = fakeFetch();
    const receipt = await provisionMemoryIdentity({ memoryRoot: fx.root, fetchImpl: impl, agents: ['claude-code-main', 'code-reviewer'] });

    assert.equal(calls.length, 1);
    assert.match(calls[0].url, /\/v3\/internal\/meta\/user\/init-admin$/);
    assert.equal(calls[0].body.username, 'admin');
    assert.match(calls[0].body.user_key, /^sk-mem-[A-Za-z0-9]{32}$/);
    assert.match(String(calls[0].headers.authorization), /^Bearer test-bearer$/);
    assert.equal(calls[0].headers['x-tdai-service-id'], 'default');

    assert.equal(receipt.instance_id, 'default');
    assert.equal(receipt.team_id, DEFAULT_TEAM);
    assert.equal(receipt.identity_user, 'pilot-operator');
    assert.equal(receipt.admin.user_id, 'usr-admin');
    assert.equal(receipt.admin.created, true);
    assert.equal(receipt.database.path, fx.database);
    assert.equal(receipt.database.team, 'created');
    assert.equal(receipt.database.members, 1);
    assert.deepEqual(receipt.database.agents, ['claude-code-main', 'code-reviewer']);
    assert.deepEqual(receipt.database.skipped, []);
    assert.deepEqual(receipt.database.conflicts, []);
    assert.equal(receipt.provisioned, true);
    assert.deepEqual(receipt.conflicts, []);
    assert.ok(receipt.database.backup.endsWith('.bak'));

    const db = new DatabaseSync(fx.database, { readOnly: true });
    const team = db.prepare('SELECT * FROM meta_teams WHERE team_id = ?').get(DEFAULT_TEAM);
    assert.equal(team.owner_user_id, 'usr-admin');
    assert.equal(team.status, 'active');
    const agents = db.prepare('SELECT agent_id, team_id, owner_user_id, status FROM meta_agents ORDER BY agent_id').all();
    assert.deepEqual(agents.map((a) => a.agent_id), ['claude-code-main', 'code-reviewer']);
    assert.ok(agents.every((a) => a.team_id === DEFAULT_TEAM && a.owner_user_id === 'usr-admin' && a.status === 'active'));
    assert.equal(db.prepare('SELECT COUNT(*) AS n FROM meta_team_members').get().n, 1);
    db.close();

    const map = JSON.parse(readFileSync(join(fx.root, 'state', 'identity-map.json'), 'utf8'));
    assert.deepEqual(map.agents['claude-code-main'], {
      team_id: DEFAULT_TEAM, user_id: 'pilot-operator', agent_id: 'claude-code-main',
    });
    assert.deepEqual(readdirSync(join(fx.root, 'state')).filter((name) => name.includes('.tmp-')), []);

    const keyFile = join(fx.root, 'state', 'secrets', 'admin-user-key');
    assert.ok(existsSync(keyFile));
    assert.match(readFileSync(keyFile, 'utf8'), /^sk-mem-[A-Za-z0-9]{32}$/);
  } finally { fx.cleanup(); }
});

test('a second run is idempotent and keeps the persisted admin key', async () => {
  const fx = fixture({ withAdmin: true, withKey: true });
  try {
    const { impl, calls } = fakeFetch({ status: 409 });
    const receipt = await provisionMemoryIdentity({ memoryRoot: fx.root, fetchImpl: impl, agents: ['claude-code-main'] });
    // The admin row and the key file both exist: no HTTP call is needed at all.
    assert.equal(calls.length, 0);
    assert.equal(receipt.admin.created, false);
    assert.equal(receipt.admin.user_id, 'usr-admin');

    // Seed one same-team row to prove a re-run treats it as already ours and
    // never rewrites the row.
    const db = new DatabaseSync(fx.database);
    db.prepare(
      "INSERT INTO meta_agents (agent_id, team_id, owner_user_id, name, visibility, status, created_at, updated_at, metadata_json) VALUES ('code-reviewer','openchamber-agents','usr-admin','code-reviewer','team','active','2026-01-01T00:00:00.000Z','2026-01-01T00:00:00.000Z','{}')",
    ).run();
    db.close();

    const again = await provisionMemoryIdentity({ memoryRoot: fx.root, fetchImpl: impl, agents: ['claude-code-main', 'code-reviewer'] });
    assert.deepEqual(again.database.agents, []);
    assert.deepEqual(again.database.skipped, ['claude-code-main', 'code-reviewer']);
    assert.deepEqual(again.database.conflicts, []);
    assert.equal(again.provisioned, true);
    assert.equal(again.database.team, 'existing');

    const check = new DatabaseSync(fx.database, { readOnly: true });
    assert.equal(check.prepare('SELECT COUNT(*) AS n FROM meta_agents').get().n, 2);
    const untouched = check.prepare('SELECT team_id, owner_user_id FROM meta_agents WHERE agent_id = ?').get('code-reviewer');
    assert.deepEqual({ ...untouched }, { team_id: 'openchamber-agents', owner_user_id: 'usr-admin' });
    check.close();

    const map = JSON.parse(readFileSync(join(fx.root, 'state', 'identity-map.json'), 'utf8'));
    assert.ok(map.agents['claude-code-main']);
    assert.ok(map.agents['code-reviewer']);
  } finally { fx.cleanup(); }
});

test('a foreign-team agent id is a reported conflict excluded from the identity map', async () => {
  const fx = fixture({ withAdmin: true, withKey: true });
  try {
    const { impl } = fakeFetch({ status: 409 });
    const db = new DatabaseSync(fx.database);
    db.prepare(
      "INSERT INTO meta_agents (agent_id, team_id, owner_user_id, name, visibility, status, created_at, updated_at, metadata_json) VALUES ('code-reviewer','fleet-team','usr-other','code-reviewer','team','active','2026-01-01T00:00:00.000Z','2026-01-01T00:00:00.000Z','{}')",
    ).run();
    db.close();

    let receipt = null;
    await assert.rejects(
      provisionMemoryIdentity({ memoryRoot: fx.root, fetchImpl: impl, agents: ['claude-code-main', 'code-reviewer'] }),
      (err) => {
        assert.equal(err.code, 'MEMORY_IDENTITY_CONFLICT');
        assert.match(err.message, /code-reviewer@fleet-team/);
        receipt = err.receipt;
        return true;
      },
    );
    assert.equal(receipt.provisioned, false);
    assert.deepEqual(receipt.conflicts, [
      { agent_id: 'code-reviewer', team_id: 'fleet-team', owner_user_id: 'usr-other' },
    ]);
    assert.deepEqual(receipt.database.conflicts, receipt.conflicts);
    assert.deepEqual(receipt.database.agents, ['claude-code-main']);
    assert.deepEqual(receipt.database.skipped, []);

    const map = JSON.parse(readFileSync(join(fx.root, 'state', 'identity-map.json'), 'utf8'));
    assert.ok(map.agents['claude-code-main'], 'the owned agent must still be mapped');
    assert.equal(map.agents['code-reviewer'], undefined, 'a foreign agent id must not be mapped as ours');

    const check = new DatabaseSync(fx.database, { readOnly: true });
    const untouched = check.prepare('SELECT team_id, owner_user_id FROM meta_agents WHERE agent_id = ?').get('code-reviewer');
    assert.deepEqual({ ...untouched }, { team_id: 'fleet-team', owner_user_id: 'usr-other' });
    assert.equal(check.prepare("SELECT COUNT(*) AS n FROM meta_agents WHERE agent_id = 'claude-code-main'").get().n, 1);
    check.close();

    assert.deepEqual(readdirSync(join(fx.root, 'state')).filter((name) => name.includes('.tmp-')), []);
  } finally { fx.cleanup(); }
});

test('an initialized store without the persisted key fails loudly instead of minting a second key', async () => {
  const fx = fixture({ withAdmin: true, withKey: false });
  try {
    const { impl } = fakeFetch({ status: 409 });
    await assert.rejects(
      provisionMemoryIdentity({ memoryRoot: fx.root, fetchImpl: impl, agents: ['claude-code-main'] }),
      /ADMIN_KEY_UNRECOVERABLE/,
    );
  } finally { fx.cleanup(); }
});

test('--dry-run writes nothing', async () => {
  const fx = fixture({ withAdmin: true, withKey: true });
  try {
    const { impl, calls } = fakeFetch({ status: 409 });
    const receipt = await provisionMemoryIdentity({ memoryRoot: fx.root, fetchImpl: impl, agents: ['claude-code-main'], dryRun: true });
    assert.equal(calls.length, 0);
    assert.equal(receipt.dry_run, true);
    assert.equal(receipt.database.team, 'would_create');
    assert.deepEqual(receipt.database.agents, ['claude-code-main']);
    assert.equal(existsSync(join(fx.root, 'state', 'identity-map.json')), false);
    const db = new DatabaseSync(fx.database, { readOnly: true });
    assert.equal(db.prepare('SELECT COUNT(*) AS n FROM meta_agents').get().n, 0);
    assert.equal(db.prepare('SELECT COUNT(*) AS n FROM meta_teams').get().n, 0);
    db.close();
  } finally { fx.cleanup(); }
});

test('the layout follows memory-hook.json to the instance database', () => {
  const fx = fixture({ instance: 'singularity', serviceId: 'singularity' });
  try {
    // A second instance directory in the same data root is reported, never touched.
    mkdirSync(join(fx.baseDir, 'metadata', 'tdai_metadata_default'), { recursive: true });
    const otherDb = join(fx.baseDir, 'metadata', 'tdai_metadata_default', 'metadata.db');
    writeFileSync(otherDb, '');
    const layout = readLayout(fx.root);
    assert.equal(layout.port, 18421);
    assert.equal(layout.instanceId, 'singularity');
    assert.equal(layout.database, fx.database);
    assert.deepEqual(layout.otherDatabases, [otherDb]);
    assert.equal(layout.adminKeyFile, join(fx.root, 'state', 'secrets', 'admin-user-key'));
  } finally { fx.cleanup(); }
});

test('readLayout rejects a serviceId that could escape the metadata root', () => {
  for (const serviceId of ['../escape', 'a/b', 'a\\b']) {
    const fx = fixture({ serviceId });
    try {
      assert.throws(
        () => readLayout(fx.root),
        (err) => err.code === 'INSTANCE_ID_INVALID',
        `serviceId ${serviceId} must be rejected`,
      );
    } finally { fx.cleanup(); }
  }
});

test('the default roster covers the parent session and every delegated role', () => {
  assert.ok(DEFAULT_AGENTS.includes('claude-code-main'));
  for (const role of ['code-reviewer', 'quality-fixer', 'researcher-web', 'thinker', 'explore', 'general', 'board', 'fleet-reviewer']) {
    assert.ok(DEFAULT_AGENTS.includes(role), `${role} must be provisioned`);
  }
  assert.equal(DEFAULT_AGENTS.length, 9);
});
