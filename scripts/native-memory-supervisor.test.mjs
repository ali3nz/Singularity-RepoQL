import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  SCHEMA,
  SupervisorError,
  applyKnowledgeLoopbackSource,
  assertKnowledgeLoopback,
  ensureSecret,
  isLoopbackHost,
  isPortFree,
  loadConfig,
  preparePlan,
  prepareStack,
  queryProcess,
  renderCoreConfig,
  renderPanelInstances,
  restartStack,
  startStack,
  statusStack,
  stopStack,
  transformCorePackage,
  validateConfig,
  verifyArchive,
} from "./native-memory-supervisor.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const FIXTURE = join(HERE, "..", "tests", "fixtures", "native-memory", "fake-service.mjs");
const FAST = { sleep: (ms) => new Promise((resolve) => setTimeout(resolve, Math.min(ms, 40))) };

function clone(value) {
  return JSON.parse(JSON.stringify(value));
}

function tempRoot() {
  return mkdtempSync(join(tmpdir(), "native-memory-sup-"));
}

async function freePort() {
  return new Promise((resolve, reject) => {
    const server = createServer();
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const port = server.address().port;
      server.close(() => resolve(port));
    });
  });
}

async function makeConfig(root, overrides = {}) {
  const corePort = overrides.corePort ?? (await freePort());
  const panelPort = overrides.panelPort ?? (await freePort());
  const components = {
    core: {
      kind: "core",
      cwd: root,
      command: [FIXTURE],
      port: corePort,
      healthPath: "/health",
      readyTimeoutMs: 8000,
      env: {
        FAKE_SERVICE_MODE: "ok",
        FAKE_STATE_FILE: join(root, "core-data.txt"),
      },
    },
    panel: {
      kind: "panel",
      cwd: root,
      command: [FIXTURE],
      port: panelPort,
      healthPath: "/",
      readyTimeoutMs: 8000,
      env: { FAKE_SERVICE_MODE: "ok" },
    },
  };
  if (overrides.panel === false) delete components.panel;
  if (overrides.corePatch) Object.assign(components.core, overrides.corePatch);
  return validateConfig({
    schema: SCHEMA,
    root,
    stateDir: join(root, "state"),
    logsDir: join(root, "logs"),
    node: process.execPath,
    npmCli: process.execPath,
    components,
    ...overrides.top,
  });
}

function cleanup(root, config) {
  try {
    if (config) {
      const manifestPath = join(config.stateDir, "supervisor.json");
      if (existsSync(manifestPath)) {
        const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
        for (const record of manifest.processes) {
          if (record.pid === process.pid) continue;
          try {
            process.kill(record.pid, "SIGKILL");
          } catch {
            /* already gone */
          }
        }
      }
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

test("loopback hosts and config validation fail closed", () => {
  const abs = (name) => (process.platform === "win32" ? `C:\\${name}` : `/${name}`);
  assert.equal(isLoopbackHost("127.0.0.1"), true);
  assert.equal(isLoopbackHost("::1"), true);
  assert.equal(isLoopbackHost("0.0.0.0"), false);
  assert.throws(
    () =>
      validateConfig({
        schema: SCHEMA,
        root: abs("stack"),
        node: abs("node.exe"),
        components: {
          core: { kind: "core", cwd: abs("core"), command: ["x"], port: 1, host: "0.0.0.0" },
        },
      }),
    /loopback/,
  );
  assert.throws(
    () =>
      validateConfig({
        schema: SCHEMA,
        root: abs("stack"),
        node: abs("node.exe"),
        components: {
          core: { kind: "core", cwd: abs("core"), command: ["x"], port: 18420 },
          panel: { kind: "panel", cwd: abs("panel"), command: ["x"], port: 18420 },
        },
      }),
    /already used/,
  );
  assert.throws(() => validateConfig({ schema: "wrong" }), /schema/);
});

test("loadConfig reports malformed JSON as a config error", () => {
  const root = tempRoot();
  try {
    const path = join(root, "stack.json");
    writeFileSync(path, "{not json");
    assert.throws(() => loadConfig(path), (error) => error instanceof SupervisorError && error.code === "CONFIG");
    writeFileSync(path, JSON.stringify({ schema: SCHEMA }));
    assert.throws(() => loadConfig(path), /root/);
    writeFileSync(path, `\uFEFF${JSON.stringify({ schema: SCHEMA })}`);
    assert.throws(() => loadConfig(path), /root/, "a UTF-8 BOM must not be reported as invalid JSON");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("generated core config and panel metadata stay on loopback", async () => {
  const root = tempRoot();
  try {
    const config = await makeConfig(root);
    const yaml = renderCoreConfig(config.components.core, config);
    assert.match(yaml, /host: 127\.0\.0\.1/);
    assert.match(yaml, new RegExp(`port: ${config.components.core.port}`));
    assert.match(yaml, /embedding:\n\s+provider: none/);
    const panel = JSON.parse(renderPanelInstances(config, "test-token-value"));
    assert.equal(panel.instances[0].gateway_endpoint, `http://127.0.0.1:${config.components.core.port}`);
    assert.equal(panel.instances[0].api_key, "test-token-value");
  } finally {
    cleanup(root);
  }
});

test("start, status, stop and restart use real child processes and preserve data", async () => {
  const root = tempRoot();
  let config;
  try {
    config = await makeConfig(root);
    const manifest = await startStack(config, FAST);
    assert.equal(manifest.processes.length, 2);
    assert.ok(manifest.processes.every((p) => Number.isInteger(p.pid) && p.pid > 0));
    assert.ok(manifest.processes.every((p) => queryProcess(p.pid)));

    const status = await statusStack(config, FAST);
    assert.equal(status.ok, true);
    assert.equal(status.code, "RUNNING");
    assert.deepEqual(status.processes.map((p) => p.ownership), ["verified", "verified"]);

    const dataFile = join(root, "core-data.txt");
    const before = readFileSync(dataFile, "utf8").trim().split("\n").filter(Boolean).length;
    assert.equal(before, 1);

    const restarted = await restartStack(config, FAST);
    assert.equal(restarted.ok, true);
    const after = readFileSync(dataFile, "utf8").trim().split("\n").filter(Boolean).length;
    assert.ok(after > before, "restart must not delete existing state");
    assert.match(readFileSync(dataFile, "utf8"), /^start /m);

    const stopped = await stopStack(config, FAST);
    assert.equal(stopped.ok, true);
    assert.equal(stopped.code, "STOPPED");
    assert.equal(existsSync(join(config.stateDir, "supervisor.json")), false);
    for (const record of restarted.manifest.processes) {
      assert.equal(queryProcess(record.pid), null);
    }
  } finally {
    cleanup(root, config);
  }
});

test("a foreign listener owns the port and is never killed", async () => {
  const root = tempRoot();
  const port = await freePort();
  const foreign = createServer((socket) => socket.end("foreign"));
  await new Promise((resolve, reject) => {
    foreign.once("error", reject);
    foreign.listen(port, "127.0.0.1", resolve);
  });
  let config;
  try {
    config = await makeConfig(root, { corePort: port });
    await assert.rejects(() => startStack(config, FAST), /already in use/);
    assert.equal(foreign.listening, true);
    assert.equal(existsSync(join(config.stateDir, "supervisor.json")), false);
  } finally {
    await new Promise((resolve) => foreign.close(resolve));
    cleanup(root, config);
  }
});

test("a failed health check rolls back already started children", async () => {
  const root = tempRoot();
  let config;
  try {
    config = await makeConfig(root, {
      panel: false,
      corePatch: { readyTimeoutMs: 1200, env: { FAKE_SERVICE_MODE: "never-healthy" } },
    });
    await assert.rejects(() => startStack(config, FAST), /failed to become healthy/);
    assert.equal(existsSync(join(config.stateDir, "supervisor.json")), false);
    assert.equal((await isPortFree(config.components.core.port)).free, true);
  } finally {
    cleanup(root, config);
  }
});

test("a child that exits early reports its log and does not leave a manifest", async () => {
  const root = tempRoot();
  let config;
  try {
    config = await makeConfig(root, {
      panel: false,
      corePatch: { env: { FAKE_SERVICE_MODE: "exit" } },
    });
    await assert.rejects(() => startStack(config, FAST), /failed to become healthy|exited/);
    assert.equal(existsSync(join(config.stateDir, "supervisor.json")), false);
  } finally {
    cleanup(root, config);
  }
});

test("stop refuses a recycled/tampered PID instead of killing it", async () => {
  const root = tempRoot();
  let config;
  try {
    config = await makeConfig(root, { panel: false });
    const manifest = await startStack(config, FAST);
    const manifestPath = join(config.stateDir, "supervisor.json");
    const original = readFileSync(manifestPath, "utf8");
    const tampered = JSON.parse(original);
    tampered.processes[0].startedAt = "2000-01-01T00:00:00.000Z";
    writeFileSync(manifestPath, JSON.stringify(tampered));
    const result = await stopStack(config, FAST);
    assert.equal(result.ok, false);
    assert.equal(result.processes[0].stopped, false);
    assert.match(result.processes[0].reason, /start time changed/);
    assert.ok(queryProcess(manifest.processes[0].pid), "the real child must still be running");
    writeFileSync(manifestPath, original);
    const stopped = await stopStack(config, FAST);
    assert.equal(stopped.ok, true);
  } finally {
    cleanup(root, config);
  }
});

test("stop never kills the supervisor's own PID from a forged manifest", async () => {
  const root = tempRoot();
  let config;
  try {
    config = await makeConfig(root, { panel: false });
    mkdirSync(config.stateDir, { recursive: true });
    writeFileSync(
      join(config.stateDir, "supervisor.json"),
      JSON.stringify({
        schema: SCHEMA,
        createdAt: new Date().toISOString(),
        stateDir: config.stateDir,
        processes: [
          {
            name: "core",
            pid: process.pid,
            exe: process.execPath,
            startedAt: "2000-01-01T00:00:00.000Z",
            host: "127.0.0.1",
            port: 1,
            healthPath: "/health",
          },
        ],
      }),
    );
    const result = await stopStack(config, FAST);
    assert.equal(result.ok, false);
    assert.match(result.processes[0].reason, /start time changed/);
    assert.doesNotThrow(() => process.kill(process.pid, 0));
    rmSync(join(config.stateDir, "supervisor.json"), { force: true });
  } finally {
    cleanup(root, config);
  }
});

test("secret files are owner-only and stable across starts", async () => {
  const root = tempRoot();
  try {
    const path = join(root, "secrets", "core-bearer");
    const first = ensureSecret(path);
    const second = ensureSecret(path);
    assert.equal(first, second);
    assert.equal(readFileSync(path, "utf8").trim(), first);
    const status = await statusStack(await makeConfig(root), FAST);
    assert.equal(JSON.stringify(status).includes(first), false, "status must never print the bearer token");
    if (process.platform !== "win32") {
      const mode = (await import("node:fs")).statSync(path).mode & 0o777;
      assert.equal(mode, 0o600);
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("ensureSecret deletes the file when the ACL cannot be restricted", () => {
  const root = tempRoot();
  try {
    const path = join(root, "secrets", "core-bearer");
    const acl = {
      restrict() {
        throw new Error("icacls denied");
      },
      verify() {},
    };
    assert.throws(() => ensureSecret(path, { acl }), /cannot be restricted/);
    assert.equal(existsSync(path), false);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("health failure output redacts the bearer token", async () => {
  const root = tempRoot();
  let config;
  try {
    config = await makeConfig(root, {
      panel: false,
      corePatch: { env: { FAKE_SERVICE_MODE: "leak" } },
    });
    const token = ensureSecret(join(config.stateDir, "secrets", "core-bearer"));
    let message = "";
    try {
      await startStack(config, FAST);
    } catch (error) {
      message = error.message;
    }
    assert.ok(message.length > 0);
    assert.equal(message.includes(token), false);
    assert.match(message, /\[REDACTED\]/);
  } finally {
    cleanup(root, config);
  }
});

test("archive provenance and the core package transform are explicit", () => {
  const root = tempRoot();
  try {
    const archive = join(root, "TencentDB-Agent-Memory-99a1a2c.tar.gz");
    writeFileSync(archive, "not a real archive");
    const digest = createHash("sha256").update(readFileSync(archive)).digest("hex");
    const base = {
      archive,
      archiveSha256: digest,
      pinnedCommit: "99a1a2c251741658917e3fa700bf8e337ad15a5f",
    };
    assert.equal(verifyArchive(base).sha256, digest);
    assert.throws(() => verifyArchive({ ...base, archiveSha256: "0".repeat(64) }), /sha256 mismatch/);
    assert.throws(() => verifyArchive({ ...base, pinnedCommit: "deadbeef" }), /pinned commit/);
    const transformed = JSON.parse(
      transformCorePackage(
        JSON.stringify({ name: "core", peerDependencies: { optional: "1" }, dependencies: { keep: "1" } }),
      ),
    );
    assert.equal(transformed.peerDependencies, undefined);
    assert.equal(transformed.dependencies.keep, "1");
    assert.equal(transformed.overrides["@jimp/config-typescript"], "npm:dotenv@latest");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("knowledge loopback transform is exact, idempotent and checked in the build", () => {
  const upstream = 'const server = serve({ fetch: app.fetch, port: config.port }, (info) => {';
  const transformed = applyKnowledgeLoopbackSource(upstream);
  assert.match(transformed, /hostname: process\.env\.HOST \?\? "127\.0\.0\.1"/);
  assert.equal(applyKnowledgeLoopbackSource(transformed), transformed);
  assert.throws(() => applyKnowledgeLoopbackSource("serve({ port: 1 })"), /did not match/);
  assert.doesNotThrow(() => assertKnowledgeLoopback('serve({ hostname: process.env.HOST ?? "127.0.0.1" })'));
  assert.throws(() => assertKnowledgeLoopback("serve({ port: 1 })"), /0\.0\.0\.0/);
});

test("prepare dry-run plans core, panel and knowledge without touching disk", async () => {
  const root = tempRoot();
  try {
    const config = await makeConfig(root);
    const plan = preparePlan(config);
    assert.deepEqual(plan.map((p) => p.name), ["core", "panel"]);
    assert.deepEqual(plan[0].steps, ["stage", "apply-patch", "transform-package", "npm-install", "esbuild-install"]);
    const result = await prepareStack(config, { dryRun: true });
    assert.equal(result.dryRun, true);
    assert.equal(result.plan.length, 2);
  } finally {
    cleanup(root);
  }
});
