// Portability and synthetic-fixture integration test for the dashboard projection.
//
// It proves what can be proven without a fleet: the exported tree contains no
// private host/path/identity, the defaults are loopback + capability token, the
// Python modules compile, and a freshly started server serves the static UI,
// enforces auth and same-origin mutations, reports unconfigured panels
// truthfully, and blocks Kanzo's /mcp surface. It does NOT prove a real RepoQL
// host, a real panel deployment or browser rendering.
import test from "node:test";
import assert from "node:assert/strict";
import { spawn, execFileSync } from "node:child_process";
import { createServer, request as httpRequest } from "node:http";
import {
  readFileSync, readdirSync, statSync, mkdtempSync, mkdirSync, writeFileSync,
  chmodSync, rmSync, existsSync,
} from "node:fs";
import { join, dirname, relative, sep } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const DASH = join(ROOT, "dashboard");
const PYTHON = process.env.PYTHON || "python3";

function walk(dir, out = []) {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) walk(full, out);
    else out.push(full);
  }
  return out;
}

function pythonAvailable() {
  try {
    execFileSync(PYTHON, ["--version"], { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
}

function request(port, path, { method = "GET", token, headers = {} } = {}) {
  return new Promise((resolve, reject) => {
    const req = httpRequest(
      { host: "127.0.0.1", port, path, method, headers: { ...(token ? { Authorization: `Bearer ${token}` } : {}), ...headers } },
      (res) => {
        let body = "";
        res.setEncoding("utf8");
        res.on("data", (chunk) => (body += chunk));
        res.on("end", () => resolve({ status: res.statusCode, headers: res.headers, body }));
      },
    );
    req.on("error", reject);
    req.end();
  });
}

async function freePort() {
  return new Promise((resolve, reject) => {
    const server = createServer();
    server.on("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const { port } = server.address();
      server.close(() => resolve(port));
    });
  });
}

async function waitFor(fn, timeoutMs = 15000, interval = 150) {
  const deadline = Date.now() + timeoutMs;
  let lastError;
  while (Date.now() < deadline) {
    try {
      const value = await fn();
      if (value) return value;
    } catch (error) {
      lastError = error;
    }
    await new Promise((r) => setTimeout(r, interval));
  }
  throw lastError || new Error("timed out");
}

test("dashboard tree ships the current static surface", () => {
  for (const rel of [
    "server.py", "repoql_bridge.py", "access.py", "native_panel_proxy.py",
    "repoql_native_auth.py", "tencent_panel_proxy.py", "office_bridge.py",
    "ghost_bridge.py", "harness_api.py", "harness_telemetry.py", "harness_rust.py",
    "repoql_connectors.py", "static/index.html", "static/app.js", "static/app.css",
    "static/navigation_ui.js", "static/ghost/index.html",
    "config.example.json", ".env.example", "docker-compose.yml",
    "PROVENANCE.md", "THIRD-PARTY-NOTICES.md",
  ]) {
    assert.ok(existsSync(join(DASH, rel)), `missing dashboard/${rel}`);
  }
  const app = readFileSync(join(DASH, "static/app.js"), "utf8");
  // Consolidated navigation requested for the live look.
  assert.match(app, /Diagnostics/);
  assert.match(app, /Indexing/);
  // Repositories moved under Indexing in the live UI.
  assert.match(app, /Repositories/);
});

test("shipped tree contains no fleet-private host, path or identity", () => {
  const forbidden = [
    /\/home\/[^/\s"'`]+\//i,
    /risingflow\.com/i,
    /\bcontroller\b/i,
    /172\.20\./,
    /192\.168\./,
    /e0e3feca/i,
    /31b0fabf/i,
    /ben@risingflow/i,
    /@gmail\.com/i,
    /\/var\/lib\/ghost-status/i,
    /\/run\/ghost-control/i,
  ];
  const offenders = [];
  for (const file of walk(DASH)) {
    const text = readFileSync(file, "utf8");
    for (const pattern of forbidden) {
      if (pattern.test(text)) offenders.push(`${relative(ROOT, file)} :: ${pattern}`);
    }
  }
  assert.deepEqual(offenders, [], `private identifiers found:\n${offenders.join("\n")}`);
});

test("no runtime data directories are shipped", () => {
  const banned = new Set(["data", "state", "workspaces", "backups", "evidence", "upstream"]);
  const found = walk(DASH)
    .map((file) => relative(DASH, file).split(sep)[0])
    .filter((name) => banned.has(name));
  assert.deepEqual(found, []);
});

test("config template is loopback and synthetic", () => {
  const config = JSON.parse(readFileSync(join(DASH, "config.example.json"), "utf8"));
  assert.equal(config.bind, "127.0.0.1");
  assert.ok(Array.isArray(config.allow_peers) && config.allow_peers.length > 0);
  for (const peer of config.allow_peers) {
    assert.match(peer, /^(127\.0\.0\.1|::1)$/);
  }
  assert.match(config.workspace, /^\/srv\/singularity\/workspace$/);
  assert.equal(config.access.team_domain, "");
  assert.equal(config.access.aud, "");
  const env = readFileSync(join(DASH, ".env.example"), "utf8");
  for (const key of [
    "SINGULARITY_WORKSPACE", "SINGULARITY_RQL_BIN", "SINGULARITY_STATE_DIR",
    "SINGULARITY_BIND", "SINGULARITY_PORT", "SINGULARITY_ALLOW_PEERS",
    "SINGULARITY_KANZO_PORT", "SINGULARITY_TENCENT_OWNER_KEY_FILE",
  ]) {
    assert.match(env, new RegExp(`^${key}=`, "m"), `missing ${key} in .env.example`);
  }
  assert.match(env, /^SINGULARITY_BIND=127\.0\.0\.1$/m);
});

test("compose template has caps, loopback publish and no bundle services", () => {
  const compose = readFileSync(join(DASH, "docker-compose.yml"), "utf8");
  assert.match(compose, /mem_limit:\s*512m/);
  assert.match(compose, /cpus:\s*1\.0/);
  assert.match(compose, /pids_limit:\s*256/);
  assert.match(compose, /restart:\s*unless-stopped/);
  assert.match(compose, /max-size:\s*"10m"/);
  assert.match(compose, /"127\.0\.0\.1:18100:18100"/);
  assert.match(compose, /read_only:\s*true/);
  assert.match(compose, /no-new-privileges:true/);
  assert.doesNotMatch(compose, /privileged:\s*true/);
  assert.doesNotMatch(compose, /image:\s*.*(repoql|openchamber|kanzo)/i);
});

test("python modules compile without writing bytecode into the tree", (t) => {
  if (!pythonAvailable()) return t.skip("python3 not available");
  const modules = walk(DASH).filter((file) => file.endsWith(".py"));
  assert.ok(modules.length >= 19);
  const script = [
    "import pathlib,sys",
    `root=pathlib.Path(${JSON.stringify(DASH)})`,
    "for p in root.rglob('*.py'):",
    "    compile(p.read_text(encoding='utf-8'), str(p), 'exec')",
    "print('ok')",
  ].join("\n");
  const out = execFileSync(PYTHON, ["-c", script], {
    env: { ...process.env, PYTHONDONTWRITEBYTECODE: "1" },
    encoding: "utf8",
  });
  assert.match(out, /ok/);
  assert.deepEqual(walk(DASH).filter((file) => file.includes(`${sep}__pycache__${sep}`)), []);
});

test("synthetic fixture: auth, static surface, truthful panels, Kanzo /mcp block", async (t) => {
  if (!pythonAvailable()) return t.skip("python3 not available");
  const work = mkdtempSync(join(tmpdir(), "singularity-dashboard-"));
  const stateDir = join(work, "runtime");
  const workspace = join(work, "workspace");
  mkdirSync(workspace, { recursive: true });
  // Synthetic RepoQL CLI: answers the bridge shape without a real host.
  const fakeRql = join(work, "rql");
  writeFileSync(fakeRql, [
    "#!/usr/bin/env python3",
    "import json,sys",
    "args=' '.join(sys.argv[1:])",
    "if 'host status' in args:",
    "    print(json.dumps({'verdict':'ok','phase':'idle','pid':0,'uptime_seconds':0,'engine_status':{}}))",
    "elif 'import list' in args:",
    "    print(json.dumps({'imports':[]}))",
    "elif 'query' in args:",
    "    print(json.dumps({'rows':[]}))",
    "else:",
    "    print(json.dumps({'ok':True}))",
  ].join("\n"), { mode: 0o755 });
  chmodSync(fakeRql, 0o755);

  const kanzoPort = await freePort();
  const kanzo = createServer((req, res) => {
    if (req.url === "/api/ping") { res.writeHead(200, { "Content-Type": "text/plain" }); res.end("kanzo"); }
    else { res.writeHead(404, { "Content-Type": "text/plain" }); res.end("not found"); }
  });
  await new Promise((resolve) => kanzo.listen(kanzoPort, "127.0.0.1", resolve));

  const port = await freePort();
  const env = {
    ...process.env,
    PYTHONDONTWRITEBYTECODE: "1",
    SINGULARITY_WORKSPACE: workspace,
    SINGULARITY_RQL_BIN: fakeRql,
    SINGULARITY_STATE_DIR: stateDir,
    SINGULARITY_BIND: "127.0.0.1",
    SINGULARITY_PORT: String(port),
    SINGULARITY_KANZO_HOST: "127.0.0.1",
    SINGULARITY_KANZO_PORT: String(kanzoPort),
    SINGULARITY_ALLOW_PEERS: "127.0.0.1/32,::1/128",
  };
  for (const key of ["SINGULARITY_TENCENT_OWNER_KEY_FILE", "SINGULARITY_GHOST_SNAPSHOT",
    "SINGULARITY_GHOST_CONTROL_SOCKET", "SINGULARITY_ACCESS_TEAM", "SINGULARITY_ACCESS_AUD"]) {
    delete env[key];
  }
  const child = spawn(PYTHON, [join(DASH, "server.py"), "serve"], { cwd: ROOT, env, stdio: ["ignore", "pipe", "pipe"] });
  let stderr = "";
  child.stderr.on("data", (chunk) => (stderr += chunk));
  try {
    const token = await waitFor(() => {
      const file = join(stateDir, "token");
      return existsSync(file) ? readFileSync(file, "utf8").trim() : null;
    });
    assert.ok(token.length >= 32, "capability token must be generated");
    if (process.platform !== "win32") {
      const mode = statSync(join(stateDir, "token")).mode & 0o777;
      assert.equal(mode & 0o077, 0, `token mode ${mode.toString(8)} is too open`);
    }
    const health = await waitFor(async () => {
      const res = await request(port, "/api/health", { token });
      return res.status === 200 ? res : null;
    });
    const payload = JSON.parse(health.body);
    assert.equal(payload.ok, true);
    assert.equal(payload.peers.length >= 1, true);

    const anonymous = await request(port, "/api/health");
    assert.equal(anonymous.status, 401);
    const staticRoot = await request(port, "/");
    assert.equal(staticRoot.status, 200);
    assert.match(staticRoot.body, /<html/i);

    const panels = JSON.parse((await request(port, "/api/embed/panels", { token })).body);
    assert.equal(panels.tencent.configured, false, "Tencent must not claim readiness without a key");
    assert.equal(panels.repoql.configured, false, "native RepoQL must not claim readiness without an issuer");

    const ghost = await request(port, "/api/ghost/status", { token });
    assert.equal(ghost.status, 503);
    assert.equal(JSON.parse(ghost.body).collector, "unconfigured");

    const crossOrigin = await request(port, "/api/repos/import", {
      method: "POST", token,
      headers: { "Content-Type": "application/json", "X-Requested-With": "repoql-dashboard", Origin: "http://evil.example" },
    });
    assert.equal(crossOrigin.status, 403);
    const missingHeader = await request(port, "/api/repos/import", {
      method: "POST", token, headers: { "Content-Type": "application/json" },
    });
    assert.equal(missingHeader.status, 403);

    const handshake = await request(port, "/api/embed/kanzo/handshake", { token });
    assert.equal(handshake.status, 200);
    const setCookie = handshake.headers["set-cookie"]?.[0] || "";
    assert.match(setCookie, /HttpOnly/i);
    assert.match(setCookie, /SameSite=Strict/i);
    assert.match(setCookie, /Path=\/embed\/kanzo\//);
    const cookie = setCookie.split(";")[0];
    const mcp = await request(port, "/embed/kanzo/mcp", {
      headers: { Cookie: cookie, Origin: `http://127.0.0.1:${port}`, Host: `127.0.0.1:${port}` },
    });
    assert.equal(mcp.status, 403);
    assert.equal(JSON.parse(mcp.body).error, "kanzo_mcp_is_local_only");
  } finally {
    child.kill("SIGTERM");
    await new Promise((resolve) => kanzo.close(resolve));
    if (child.exitCode === null) {
      await Promise.race([
        new Promise((resolve) => child.once("exit", resolve)),
        new Promise((resolve) => setTimeout(resolve, 3000)),
      ]);
    }
    rmSync(work, { recursive: true, force: true });
  }
});
