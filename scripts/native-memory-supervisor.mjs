#!/usr/bin/env node
// native-memory-supervisor.mjs — one authority for the native-Windows memory
// stack (MemoryCore, MemoryPanel, MemoryKnowledge).
//
// Why this exists: the fleet memory stack normally runs in Docker. On the
// native Windows host there is no Docker/WSL dependency allowed, so the same
// upstream Node entrypoints are staged, built and supervised here. This module
// owns the whole lifecycle so there is never a second, competing way to start
// or stop those processes:
//
//   prepare  stage pinned upstream source, apply the documented dependency
//            transform, install locally and build
//   start    bind loopback ports, start children, wait for health, persist an
//            ownership manifest
//   status   re-verify PID ownership and health from that manifest
//   stop     terminate only processes whose exe + start time still match
//   restart  stop then start
//
// Safety rules encoded here (not just documented):
//   * every listener is loopback; a non-loopback host is a config error
//   * a port owned by a foreign process is reported, never killed
//   * a child is stopped only after its PID, executable and start time match
//     the manifest; a recycled or foreign PID is refused
//   * the bearer token is generated locally, written with owner-only ACL on
//     Windows and never printed or placed in a command line
//   * all HOME/USERPROFILE/XDG/TEMP/state/log paths are isolated per stack
//
// The module is deliberately dependency-free (Node 22 built-ins only) and
// exports its helpers so the tests can drive fake services and fault cases.

import { spawn as spawnChild, execFileSync } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import {
  chmodSync,
  closeSync,
  cpSync,
  existsSync,
  mkdirSync,
  openSync,
  readFileSync,
  readlinkSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { request } from "node:http";
import { createServer } from "node:net";
import { platform as osPlatform, userInfo } from "node:os";
import { basename, dirname, isAbsolute, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

export const SCHEMA = "native-memory-supervisor/v1";
export const MANIFEST_NAME = "supervisor.json";

export class SupervisorError extends Error {
  constructor(message, code = "SUPERVISOR") {
    super(message);
    this.name = "SupervisorError";
    this.code = code;
  }
}

const LOOPBACK_HOSTS = new Set(["127.0.0.1", "::1", "localhost"]);

export function isLoopbackHost(host) {
  return LOOPBACK_HOSTS.has(String(host ?? "").toLowerCase());
}

function requireString(value, label) {
  if (typeof value !== "string" || value.trim() === "") {
    throw new SupervisorError(`${label} must be a non-empty string`, "CONFIG");
  }
  return value;
}

function requireAbsolute(value, label) {
  const text = requireString(value, label);
  if (!isAbsolute(text)) throw new SupervisorError(`${label} must be an absolute path: ${text}`, "CONFIG");
  return text;
}

/**
 * Expand `${root}`, `${stateDir}`, `${secret}` and `${port:name}` placeholders
 * in a config value. Values are only produced from the already-validated
 * config, never from the environment, so a config cannot smuggle another
 * component's secret into a log path.
 */
export function expandTemplate(value, context) {
  if (typeof value !== "string") return value;
  return value.replace(/\$\{([a-zA-Z0-9:_-]+)\}/g, (match, key) => {
    if (key === "root") return context.root;
    if (key === "stateDir") return context.stateDir;
    if (key === "secret") return context.secret;
    if (key.startsWith("port:")) {
      const name = key.slice(5);
      const component = context.components?.[name];
      if (!component) throw new SupervisorError(`unknown component in template: ${name}`, "CONFIG");
      return String(component.port);
    }
    throw new SupervisorError(`unknown config placeholder: ${match}`, "CONFIG");
  });
}

/**
 * Validate and normalize a stack config.
 *
 * No filesystem checks happen here: `validateConfig` is pure so a malformed
 * config is rejected before any process or state directory is touched.
 */
export function validateConfig(raw) {
  if (!raw || typeof raw !== "object") throw new SupervisorError("config must be a JSON object", "CONFIG");
  if (raw.schema !== SCHEMA) {
    throw new SupervisorError(`config.schema must be ${SCHEMA}`, "CONFIG");
  }
  const root = requireAbsolute(raw.root, "config.root");
  const stateDir = requireAbsolute(raw.stateDir ?? join(root, "scratch", "native-stack"), "config.stateDir");
  const logsDir = requireAbsolute(raw.logsDir ?? join(root, "logs", "native-stack"), "config.logsDir");
  const nodeExe = requireAbsolute(raw.node, "config.node");
  const npmCli = raw.npmCli ? requireAbsolute(raw.npmCli, "config.npmCli") : null;
  const npmCli11 = raw.npmCli11 ? requireAbsolute(raw.npmCli11, "config.npmCli11") : null;
  const sourceRoot = raw.sourceRoot ? requireAbsolute(raw.sourceRoot, "config.sourceRoot") : null;
  const buildRoot = raw.buildRoot ? requireAbsolute(raw.buildRoot, "config.buildRoot") : null;
  const componentsRaw = raw.components;
  if (!componentsRaw || typeof componentsRaw !== "object" || Array.isArray(componentsRaw)) {
    throw new SupervisorError("config.components must be an object", "CONFIG");
  }
  const components = {};
  const ports = new Map();
  for (const [name, entry] of Object.entries(componentsRaw)) {
    if (!/^[a-z][a-z0-9-]*$/.test(name)) {
      throw new SupervisorError(`component name is invalid: ${name}`, "CONFIG");
    }
    if (!entry || typeof entry !== "object") throw new SupervisorError(`component ${name} must be an object`, "CONFIG");
    const kind = requireString(entry.kind, `${name}.kind`);
    if (!["core", "panel", "knowledge", "gateway", "fake"].includes(kind)) {
      throw new SupervisorError(`${name}.kind is unsupported: ${kind}`, "CONFIG");
    }
    const host = requireString(entry.host ?? "127.0.0.1", `${name}.host`);
    if (!isLoopbackHost(host)) {
      throw new SupervisorError(`${name}.host must be loopback (127.0.0.1/::1/localhost), got ${host}`, "CONFIG");
    }
    const port = Number(entry.port);
    if (!Number.isInteger(port) || port < 1 || port > 65535) {
      throw new SupervisorError(`${name}.port must be an integer 1..65535`, "CONFIG");
    }
    if (ports.has(port)) {
      throw new SupervisorError(`${name}.port ${port} is already used by ${ports.get(port)}`, "CONFIG");
    }
    ports.set(port, name);
    const command = entry.command;
    if (!Array.isArray(command) || command.length === 0 || command.some((part) => typeof part !== "string")) {
      throw new SupervisorError(`${name}.command must be a non-empty string array`, "CONFIG");
    }
    const healthPath = requireString(entry.healthPath ?? "/health", `${name}.healthPath`);
    if (!healthPath.startsWith("/")) throw new SupervisorError(`${name}.healthPath must start with /`, "CONFIG");
    const cwd = requireAbsolute(entry.cwd, `${name}.cwd`);
    const env = entry.env ?? {};
    if (!env || typeof env !== "object" || Array.isArray(env)) {
      throw new SupervisorError(`${name}.env must be an object`, "CONFIG");
    }
    for (const [key, value] of Object.entries(env)) {
      if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(key)) {
        throw new SupervisorError(`${name}.env has an invalid variable name: ${key}`, "CONFIG");
      }
      if (typeof value !== "string" && typeof value !== "number") {
        throw new SupervisorError(`${name}.env.${key} must be a string`, "CONFIG");
      }
    }
    components[name] = {
      name,
      kind,
      host,
      port,
      command,
      cwd,
      healthPath,
      env,
      readyTimeoutMs: Number(entry.readyTimeoutMs ?? 120_000),
      stopTimeoutMs: Number(entry.stopTimeoutMs ?? 10_000),
      coreConfig: entry.coreConfig ?? null,
      upstream: entry.upstream ?? null,
      llmKeyFile: entry.llmKeyFile ? requireAbsolute(entry.llmKeyFile, `${name}.llmKeyFile`) : null,
    };
  }
  if (!components.core) throw new SupervisorError("config.components.core is required", "CONFIG");
  if (!Number.isFinite(components.core.readyTimeoutMs) || components.core.readyTimeoutMs <= 0) {
    throw new SupervisorError("core.readyTimeoutMs must be a positive number", "CONFIG");
  }
  return {
    schema: SCHEMA,
    root,
    stateDir,
    logsDir,
    node: nodeExe,
    npmCli,
    npmCli11,
    sourceRoot,
    buildRoot,
    pinnedCommit: raw.pinnedCommit ?? null,
    archive: raw.archive ? requireAbsolute(raw.archive, "config.archive") : null,
    archiveSha256: raw.archiveSha256 ?? null,
    patchFile: raw.patchFile ? requireAbsolute(raw.patchFile, "config.patchFile") : null,
    components,
    order: Array.isArray(raw.order) && raw.order.length ? raw.order : Object.keys(components),
  };
}

export function loadConfig(path) {
  let text;
  try {
    text = readFileSync(path, "utf8");
  } catch (error) {
    throw new SupervisorError(`cannot read config ${path}: ${error.message}`, "CONFIG");
  }
  let raw;
  try {
    // PowerShell 5.1's utf8 writer adds a BOM; it is not content.
    raw = JSON.parse(text.replace(/^\uFEFF/, ""));
  } catch (error) {
    throw new SupervisorError(`config is not valid JSON: ${error.message}`, "CONFIG");
  }
  return validateConfig(raw);
}

/** The token file is the only secret the stack needs in this scratch profile. */
export function secretPath(config) {
  return join(config.stateDir, "secrets", "core-bearer");
}

export function redact(text, secrets = []) {
  let out = String(text ?? "");
  for (const secret of secrets) {
    if (secret && secret.length >= 8) out = out.split(secret).join("[REDACTED]");
  }
  return out;
}

/**
 * Read an existing secret or create one. Creation is fail-closed: if the
 * platform cannot restrict the file to the current user, the file is removed
 * and the start aborts instead of running with a world-readable bearer token.
 */
export function ensureSecret(path, { createSecret = () => randomBytes(32).toString("base64url"), acl = restrictFileAcl } = {}) {
  if (existsSync(path)) {
    const value = readFileSync(path, "utf8").trim();
    if (!value) throw new SupervisorError(`secret file is empty: ${path}`, "SECRET");
    acl.verify(path);
    return value;
  }
  mkdirSync(dirname(path), { recursive: true });
  const value = createSecret();
  writeFileSync(path, `${value}\n`, { encoding: "utf8", mode: 0o600 });
  try {
    acl.restrict(path);
    acl.verify(path);
  } catch (error) {
    rmSync(path, { force: true });
    throw new SupervisorError(`refusing to use a secret file that cannot be restricted: ${error.message}`, "ACL");
  }
  return value;
}

/** Resolve the effective environment for one component, isolated per stack. */
export function buildComponentEnv(component, config, token) {
  const home = join(config.stateDir, "home");
  const tmp = join(config.stateDir, "tmp");
  const base = {
    HOME: home,
    USERPROFILE: home,
    XDG_CONFIG_HOME: join(home, ".config"),
    XDG_DATA_HOME: join(home, ".local", "share"),
    XDG_CACHE_HOME: join(home, ".cache"),
    XDG_STATE_HOME: join(home, ".local", "state"),
    TMP: tmp,
    TEMP: tmp,
    TMPDIR: tmp,
  };
  const env = { ...process.env, ...base };
  for (const key of Object.keys(env)) {
    if (key.startsWith("TDAI_") || key.startsWith("PANEL_") || key.startsWith("KNOWLEDGE_") || key.startsWith("EXTRACTION_FAILOVER_")) {
      delete env[key];
    }
  }
  env.NODE_ENV = "production";
  if (component.kind === "core") {
    env.TDAI_GATEWAY_HOST = component.host;
    env.TDAI_GATEWAY_PORT = String(component.port);
    env.TDAI_DATA_DIR = join(config.stateDir, "data", "core");
    env.TDAI_GATEWAY_CONFIG = join(config.stateDir, "core", "tdai-gateway.yaml");
    env.TDAI_GATEWAY_API_KEY = token;
    env.TDAI_LLM_API_KEY = token;
    env.TDAI_LLM_BASE_URL = "http://127.0.0.1:9/v1";
    env.TDAI_LLM_MODEL = "native-test-model";
    if (component.llmKeyFile) {
      let llmKey;
      try { llmKey = readFileSync(component.llmKeyFile, "utf8").trim(); }
      catch (error) { throw new SupervisorError(`cannot read core llmKeyFile: ${error.message}`, "CONFIG"); }
      if (!llmKey) throw new SupervisorError("core llmKeyFile is empty", "CONFIG");
      env.TDAI_LLM_API_KEY = llmKey;
    }
    env.HOST = component.host;
    env.PORT = String(component.port);
  } else if (component.kind === "gateway") {
    env.HOST = component.host;
    env.PORT = String(component.port);
    env.EXTRACTION_FAILOVER_PORT = String(component.port);
    env.EXTRACTION_FAILOVER_BIND = component.host;
    env.EXTRACTION_FAILOVER_SECRETS_DIR = join(config.stateDir, "secrets");
    env.EXTRACTION_FAILOVER_REQUIRE_AUTH = "1";
    env.EXTRACTION_FAILOVER_TIMEOUT_MS = "60000";
  } else if (component.kind === "panel") {
    env.HOST = component.host;
    env.PORT = String(component.port);
    env.METADATA_INSTANCES_CONFIG = join(config.stateDir, "panel", "metadata-instances.json");
    env.UI_DIST_DIR = join(component.cwd, "web", "dist");
    env.PANEL_AUTH_MODE = "user_key";
    env.PANEL_AUTH_IDENTITY_STORE_PATH = join(config.stateDir, "data", "panel-auth-identities.json");
    env.TDAI_AGENT_TEMPLATE_DIR = join(config.stateDir, "data", "agent-templates");
    env.KNOWLEDGE_LLM_BINDING_SYNC = "false";
    env.KNOWLEDGE_SERVICE_URL = `http://127.0.0.1:${config.components.knowledge?.port ?? 8421}`;
    env.KNOWLEDGE_AUTH_TOKEN = token;
    env.LOG_LEVEL = "info";
  } else if (component.kind === "knowledge") {
    env.HOST = component.host;
    env.PORT = String(component.port);
    env.KNOWLEDGE_DATA_DIR = join(config.stateDir, "data", "knowledge");
    env.KNOWLEDGE_DB_PATH = join(config.stateDir, "data", "knowledge", "knowledge.db");
    env.KNOWLEDGE_SERVICE_KEY = token;
    env.LOG_LEVEL = "info";
  }
  for (const [key, value] of Object.entries(component.env)) {
    env[key] = expandTemplate(String(value), {
      root: config.root,
      stateDir: config.stateDir,
      secret: token,
      components: config.components,
    });
  }
  return env;
}

/** Minimal known-good standalone core config for a scratch loopback stack. */
export function renderCoreConfig(component, config) {
  const defaults = {
    deployMode: "standalone",
    stateBackend: "local",
    llm: {
      baseUrl: "http://127.0.0.1:9/v1",
      apiKey: "${TDAI_LLM_API_KEY}",
      model: "native-test-model",
    },
    memory: {
      capture: { enabled: false },
      extraction: { enabled: false },
      pipeline: { everyNConversations: 5 },
      recall: { enabled: true, maxResults: 5, scoreThreshold: 0.3, strategy: "hybrid", timeoutMs: 5000 },
      embedding: { provider: "none" },
      bm25: { enabled: true, language: "zh" },
    },
  };
  const merged = deepMerge(defaults, component.coreConfig ?? {});
  merged.server = { ...(merged.server ?? {}), host: component.host, port: component.port };
  merged.data = { ...(merged.data ?? {}), baseDir: join(config.stateDir, "data", "core") };
  return `${toYaml(merged)}\n`;
}

const YAML_BARE = /^[A-Za-z0-9_.\/-]+$/;

function toYaml(value, indent = 0) {
  const pad = " ".repeat(indent);
  if (Array.isArray(value)) {
    return value
      .map((item) => `${pad}- ${typeof item === "object" && item !== null ? toYaml(item, indent + 2).trimStart() : yamlScalar(item)}`)
      .join("\n");
  }
  if (value && typeof value === "object") {
    return Object.entries(value)
      .map(([key, item]) => {
        if (item && typeof item === "object") {
          return `${pad}${key}:\n${toYaml(item, indent + 2)}`;
        }
        return `${pad}${key}: ${yamlScalar(item)}`;
      })
      .join("\n");
  }
  return `${pad}${yamlScalar(value)}`;
}

function yamlScalar(value) {
  if (typeof value === "number" || typeof value === "boolean") return String(value);
  const text = String(value);
  if (text === "") return '""';
  if (YAML_BARE.test(text) || /^\$\{[A-Z0-9_]+\}$/.test(text)) return text;
  return JSON.stringify(text);
}

function deepMerge(base, extra) {
  const out = { ...base };
  for (const [key, value] of Object.entries(extra ?? {})) {
    if (value && typeof value === "object" && !Array.isArray(value) && out[key] && typeof out[key] === "object") {
      out[key] = deepMerge(out[key], value);
    } else {
      out[key] = value;
    }
  }
  return out;
}

/** Metadata instances file consumed by MemoryPanel; the token stays in state. */
export function renderPanelInstances(config, token) {
  const core = config.components.core;
  return `${JSON.stringify(
    {
      instances: [
        {
          id: "default",
          name: "Native scratch",
          gateway_endpoint: `http://127.0.0.1:${core.port}`,
          api_key: token,
        },
      ],
    },
    null,
    2,
  )}\n`;
}

export function writeGeneratedFiles(config, token) {
  const coreDir = join(config.stateDir, "core");
  mkdirSync(coreDir, { recursive: true });
  const coreConfig = renderCoreConfig(config.components.core, config);
  writeFileSync(join(coreDir, "tdai-gateway.yaml"), coreConfig, { encoding: "utf8" });
  if (config.components.panel) {
    const panelDir = join(config.stateDir, "panel");
    mkdirSync(panelDir, { recursive: true });
    const instancesPath = join(panelDir, "metadata-instances.json");
    writeFileSync(instancesPath, renderPanelInstances(config, token), { encoding: "utf8" });
    restrictFileAcl.restrict(instancesPath);
    restrictFileAcl.verify(instancesPath);
  }
}

/** Cross-platform owner-only file restriction. On Windows mode bits are not
 * enforcement, so `icacls` is used and checked; failure is an error, never a
 * silent "0600 was requested" claim. */
export function createFileAcl({ platform = osPlatform(), execFile = execFileSync, env = process.env } = {}) {
  if (platform !== "win32") {
    return {
      restrict(path) {
        chmodSync(path, 0o600);
      },
      verify(path) {
        const mode = statSync(path).mode & 0o777;
        if ((mode & 0o077) !== 0) {
          throw new SupervisorError(`POSIX mode ${mode.toString(8)} allows group/other access`, "ACL");
        }
      },
    };
  }
  let user = env.USERNAME || env.USER;
  if (!user) {
    try { user = userInfo().username; } catch { user = null; }
  }
  if (!user) {
    return {
      restrict() {
        throw new SupervisorError("cannot restrict ACL: USERNAME is not set", "ACL");
      },
      verify() {
        throw new SupervisorError("cannot verify ACL: USERNAME is not set", "ACL");
      },
    };
  }
  const aclText = (path) =>
    execFile("icacls.exe", [path], { encoding: "utf8", windowsHide: true });
  return {
    restrict(path) {
      execFile(
        "icacls.exe",
        [path, "/inheritance:r", "/grant:r", `${user}:F`, "/grant:r", "SYSTEM:F", "/grant:r", "Administrators:F"],
        { encoding: "utf8", windowsHide: true },
      );
    },
    verify(path) {
      const text = aclText(path);
      const broad = /\b(Everyone|BUILTIN\\Users|Authenticated Users|Users)\s*:/i.test(text);
      if (broad) throw new SupervisorError(`ACL still grants a broad principal: ${text.trim()}`, "ACL");
      if (!text.toLowerCase().includes(String(user).toLowerCase())) {
        throw new SupervisorError(`ACL does not name the owner ${user}`, "ACL");
      }
    },
  };
}

export const restrictFileAcl = createFileAcl();

export function commandSignature(component) {
  return createHash("sha256").update(JSON.stringify([component.command, component.cwd])).digest("hex").slice(0, 16);
}

function tailFile(path, lines = 20) {
  try {
    return readFileSync(path, "utf8").trimEnd().split(/\r?\n/).slice(-lines).join("\n");
  } catch {
    return "";
  }
}

/** Windows start time + exe path, read natively through PowerShell. */
export function queryProcessWindows(pid, { execFile = execFileSync } = {}) {
  const script = [
    `$p = Get-CimInstance Win32_Process -Filter "ProcessId = ${Number(pid)}"`,
    "if ($p) { [pscustomobject]@{ pid = $p.ProcessId; exe = $p.ExecutablePath; created = $p.CreationDate.ToUniversalTime().ToString('o'); cmd = $p.CommandLine } | ConvertTo-Json -Compress }",
  ].join("; ");
  const out = execFile("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", script], {
    encoding: "utf8",
    windowsHide: true,
  }).trim();
  if (!out) return null;
  const parsed = JSON.parse(out.split(/\r?\n/).filter(Boolean).at(-1));
  return { pid: Number(parsed.pid), exe: parsed.exe ?? null, startedAt: parsed.created ?? null, cmd: parsed.cmd ?? null };
}

/** POSIX fallback, used by tests on Linux. The kernel reports start time in
 * clock ticks since boot; convert it to an ISO instant so it can be compared
 * with the manifest the same way Windows' CreationDate is. */
export function queryProcessPosix(pid, { bootTimeSeconds } = {}) {
  try {
    const stat = readFileSync(`/proc/${pid}/stat`, "utf8");
    const fields = stat.slice(stat.lastIndexOf(")") + 2).split(" ");
    const ticks = Number(fields[19]);
    const boot = bootTimeSeconds ?? readBootTimeSeconds();
    const startedAt = new Date((boot + ticks / 100) * 1000).toISOString();
    const exe = readlinkSync(`/proc/${pid}/exe`);
    return { pid, exe, startedAt, cmd: null };
  } catch {
    return null;
  }
}

function readBootTimeSeconds() {
  const line = readFileSync("/proc/stat", "utf8")
    .split("\n")
    .find((entry) => entry.startsWith("btime "));
  if (!line) throw new Error("cannot read btime from /proc/stat");
  return Number(line.split(" ")[1]);
}

export function queryProcess(pid, { platform = osPlatform(), execFile = execFileSync } = {}) {
  return platform === "win32" ? queryProcessWindows(pid, { execFile }) : queryProcessPosix(pid);
}

function sameInstant(a, b, toleranceMs = 0) {
  const ta = Date.parse(a);
  const tb = Date.parse(b);
  if (!Number.isFinite(ta) || !Number.isFinite(tb)) return a === b;
  return Math.abs(ta - tb) <= toleranceMs;
}

/**
 * Verify that `pid` is still the exact process recorded in the manifest.
 * Returns `{ ok, reason }`; any doubt is `ok: false` so callers never kill.
 */
export function verifyOwnership(record, { query = queryProcess } = {}) {
  if (!record || !Number.isInteger(record.pid) || record.pid <= 0) {
    return { ok: false, reason: "manifest entry has no valid pid" };
  }
  let live;
  try {
    live = query(record.pid);
  } catch (error) {
    return { ok: false, reason: `process query failed: ${error.message}` };
  }
  if (!live) return { ok: false, absent: true, reason: "process is not running" };
  // Never infer ownership from PID alone: inaccessible CIM/proc metadata must
  // fail closed rather than authorizing SIGTERM of an unrelated process.
  if (!record.exe || !record.startedAt || !live.exe || !live.startedAt) {
    return { ok: false, reason: "process executable/start-time identity unavailable" };
  }
  if (!samePath(record.exe, live.exe)) {
    return { ok: false, reason: `executable changed (${live.exe})` };
  }
  if (!sameInstant(record.startedAt, live.startedAt)) {
    return { ok: false, reason: `start time changed (${live.startedAt})` };
  }
  return { ok: true };
}

function samePath(a, b) {
  const left = String(a);
  const right = String(b);
  if (/^[A-Za-z]:[\\/]/.test(left) || /^[A-Za-z]:[\\/]/.test(right)) {
    return left.replaceAll("/", "\\").toLowerCase() === right.replaceAll("/", "\\").toLowerCase();
  }
  return resolve(left) === resolve(right);
}

export async function isPortFree(port, host = "127.0.0.1") {
  return new Promise((resolvePromise) => {
    const server = createServer();
    server.once("error", (error) => resolvePromise({ free: false, code: error.code ?? "ERROR" }));
    server.listen({ port, host, exclusive: true }, () => {
      server.close(() => resolvePromise({ free: true }));
    });
  });
}

export async function checkHealth({ host = "127.0.0.1", port, path = "/health", timeoutMs = 2000 } = {}) {
  return new Promise((resolvePromise) => {
    const req = request({ host, port, path, method: "GET", timeout: timeoutMs }, (res) => {
      res.resume();
      resolvePromise(res.statusCode >= 200 && res.statusCode < 400);
    });
    req.on("timeout", () => {
      req.destroy();
      resolvePromise(false);
    });
    req.on("error", () => resolvePromise(false));
    req.end();
  });
}

async function waitForProcessRecord(pid, query, sleep) {
  for (let attempt = 0; attempt < 25; attempt++) {
    const record = query(pid);
    if (record) return record;
    await sleep(40);
  }
  return null;
}

async function waitForHealth(component, child, logPath, { health = checkHealth, sleep = (ms) => new Promise((r) => setTimeout(r, ms)) } = {}) {
  const deadline = Date.now() + component.readyTimeoutMs;
  while (Date.now() < deadline) {
    if (child.exitCode !== null || child.signalCode) {
      return { ok: false, reason: `exited with ${child.exitCode ?? child.signalCode}`, log: tailFile(logPath) };
    }
    if (await health({ host: component.host, port: component.port, path: component.healthPath })) {
      return { ok: true };
    }
    await sleep(300);
  }
  return { ok: false, reason: `health check timed out after ${component.readyTimeoutMs}ms`, log: tailFile(logPath) };
}

export function readManifest(config) {
  const path = join(config.stateDir, MANIFEST_NAME);
  if (!existsSync(path)) return null;
  const parsed = JSON.parse(readFileSync(path, "utf8"));
  if (parsed.schema !== SCHEMA || !Array.isArray(parsed.processes)) {
    throw new SupervisorError(`manifest is not a ${SCHEMA} manifest: ${path}`, "MANIFEST");
  }
  return parsed;
}

export function writeManifest(config, manifest) {
  mkdirSync(config.stateDir, { recursive: true });
  const path = join(config.stateDir, MANIFEST_NAME);
  const tmp = `${path}.tmp`;
  writeFileSync(tmp, `${JSON.stringify(manifest, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
  renameSync(tmp, path);
  return path;
}

export function buildManifest(config, processes) {
  return {
    schema: SCHEMA,
    createdAt: new Date().toISOString(),
    stateDir: config.stateDir,
    node: config.node,
    processes,
  };
}

function spawnComponent(component, config, env, { spawn = spawnChild } = {}) {
  const logDir = join(config.logsDir, component.name);
  mkdirSync(logDir, { recursive: true });
  const outPath = join(logDir, "stdout.log");
  const errPath = join(logDir, "stderr.log");
  const outFd = openSync(outPath, "a");
  const errFd = openSync(errPath, "a");
  let child;
  try {
    child = spawn(config.node, component.command, {
      cwd: component.cwd,
      env,
      stdio: ["ignore", outFd, errFd],
      windowsHide: true,
      // A real service must outlive the launcher's console/SSH session. On
      // Windows only a detached child gets its own process group; with
      // detached:false the child dies when the launching console closes.
      detached: true,
    });
  } finally {
    closeSync(outFd);
    closeSync(errFd);
  }
  // A supervisor is a launcher, not a shell: once the child is recorded the
  // start command must be able to exit while the child keeps serving. Without
  // unref the parent event loop waits on the child forever.
  child.unref();
  return { child, outPath, errPath };
}

async function startOnce(config, token, deps) {
  const { spawn = spawnChild, query = queryProcess, health = checkHealth, sleep = (ms) => new Promise((r) => setTimeout(r, ms)) } = deps;
  for (const name of config.order) {
    const component = config.components[name];
    if (!component) throw new SupervisorError(`config.order names unknown component ${name}`, "CONFIG");
    const port = await isPortFree(component.port, component.host);
    if (!port.free) {
      throw new SupervisorError(
        `port ${component.port} (${name}) is already in use (${port.code}); refusing to start and never killing the existing listener`,
        "PORT",
      );
    }
    if (!existsSync(component.cwd)) {
      throw new SupervisorError(`${name}.cwd does not exist: ${component.cwd}`, "PREPARE");
    }
    if (component.kind === "knowledge") {
      const distPath = join(component.cwd, "dist", "server.mjs");
      if (!existsSync(distPath)) {
        throw new SupervisorError(`${name} is not built: missing ${distPath}`, "PREPARE");
      }
      assertKnowledgeLoopback(readFileSync(distPath, "utf8"));
    }
  }
  writeGeneratedFiles(config, token);
  const started = [];
  try {
    for (const name of config.order) {
      const component = config.components[name];
      const env = buildComponentEnv(component, config, token);
      let launched;
      try {
        launched = spawnComponent(component, config, env, { spawn });
      } catch (error) {
        throw new SupervisorError(`failed to spawn ${name}: ${error.message}`, "SPAWN");
      }
      const live = await waitForProcessRecord(launched.child.pid, query, sleep);
      const record = {
        name,
        pid: launched.child.pid,
        exe: live?.exe ?? config.node,
        startedAt: live?.startedAt ?? new Date().toISOString(),
        commandHash: commandSignature(component),
        host: component.host,
        port: component.port,
        healthPath: component.healthPath,
        log: launched.outPath,
        errLog: launched.errPath,
        cwd: component.cwd,
      };
      started.push(record);
      const ready = await waitForHealth(component, launched.child, launched.outPath, { health, sleep });
      if (!ready.ok) {
        const errTail = tailFile(launched.errPath);
        throw new SupervisorError(
          `${name} failed to become healthy: ${ready.reason}\n${redact(`${ready.log}\n${errTail}`, [token])}`,
          "HEALTH",
        );
      }
    }
  } catch (error) {
    await stopProcesses(started, { query, sleep });
    throw error;
  }
  const manifest = buildManifest(config, started);
  try {
    writeManifest(config, manifest);
  } catch (error) {
    // Starting a service without a durable ownership manifest makes it
    // unmanageable and risks killing a recycled PID on a later restart.
    await stopProcesses(started, { query, sleep });
    throw error;
  }
  return manifest;
}

async function stopProcesses(processes, { query = queryProcess, sleep = (ms) => new Promise((r) => setTimeout(r, ms)) } = {}) {
  const results = [];
  for (const record of processes) {
    const ownership = verifyOwnership(record, { query });
    if (!ownership.ok) {
      // An absent process is already stopped; only a live mismatch is refused.
      results.push({ name: record.name, pid: record.pid, stopped: Boolean(ownership.absent), ...(ownership.absent ? {} : { reason: ownership.reason }) });
      continue;
    }
    try {
      process.kill(record.pid, "SIGTERM");
    } catch (error) {
      if (error.code !== "ESRCH") {
        results.push({ name: record.name, pid: record.pid, stopped: false, reason: error.message });
        continue;
      }
    }
    let gone = false;
    const deadline = Date.now() + 10_000;
    while (Date.now() < deadline) {
      if (!query(record.pid)) {
        gone = true;
        break;
      }
      await sleep(200);
    }
    if (!gone) {
      // Re-verify before the hard kill: a recycled PID must not be hit.
      const again = verifyOwnership(record, { query });
      if (!again.ok) {
        results.push({ name: record.name, pid: record.pid, stopped: false, reason: `refusing SIGKILL: ${again.reason}` });
        continue;
      }
      try {
        process.kill(record.pid, "SIGKILL");
      } catch (error) {
        if (error.code !== "ESRCH") {
          results.push({ name: record.name, pid: record.pid, stopped: false, reason: error.message });
          continue;
        }
      }
      const hardDeadline = Date.now() + 5000;
      while (Date.now() < hardDeadline) {
        if (!query(record.pid)) {
          gone = true;
          break;
        }
        await sleep(200);
      }
    }
    results.push({ name: record.name, pid: record.pid, stopped: gone, ...(gone ? {} : { reason: "still running after SIGKILL" }) });
  }
  return results;
}

export async function startStack(config, deps = {}) {
  if (readManifest(config)) {
    throw new SupervisorError(`a stack manifest already exists at ${join(config.stateDir, MANIFEST_NAME)}; stop it first`, "MANIFEST");
  }
  mkdirSync(config.stateDir, { recursive: true });
  mkdirSync(config.logsDir, { recursive: true });
  mkdirSync(join(config.stateDir, "tmp"), { recursive: true });
  mkdirSync(join(config.stateDir, "home"), { recursive: true });
  const token = ensureSecret(secretPath(config), deps);
  return startOnce(config, token, deps);
}

export async function statusStack(config, deps = {}) {
  const manifest = readManifest(config);
  if (!manifest) {
    return { ok: false, code: "NO_MANIFEST", processes: [] };
  }
  const { query = queryProcess, health = checkHealth } = deps;
  const processes = [];
  for (const record of manifest.processes) {
    const ownership = verifyOwnership(record, { query });
    const healthy = ownership.ok ? await health({ host: record.host, port: record.port, path: record.healthPath }) : false;
    processes.push({
      name: record.name,
      pid: record.pid,
      port: record.port,
      ownership: ownership.ok ? "verified" : ownership.reason,
      health: healthy ? "ok" : "unhealthy",
    });
  }
  const ok = processes.length > 0 && processes.every((p) => p.ownership === "verified" && p.health === "ok");
  return { ok, code: ok ? "RUNNING" : "DEGRADED", processes };
}

export async function stopStack(config, deps = {}) {
  const manifest = readManifest(config);
  if (!manifest) return { ok: true, code: "NOT_RUNNING", processes: [] };
  const results = await stopProcesses(manifest.processes, deps);
  const ok = results.every((r) => r.stopped);
  if (ok) {
    rmSync(join(config.stateDir, MANIFEST_NAME), { force: true });
  }
  return { ok, code: ok ? "STOPPED" : "STOP_INCOMPLETE", processes: results };
}

export async function restartStack(config, deps = {}) {
  const stopped = await stopStack(config, deps);
  if (!stopped.ok) return { ok: false, code: "STOP_INCOMPLETE", stop: stopped };
  const manifest = await startStack(config, deps);
  return { ok: true, code: "RESTARTED", manifest };
}

/**
 * Long-lived supervisor entrypoint used as a single Rust-supervisor component.
 * It owns the core+panel children and stays in the foreground so the parent's
 * Job Object is the outer containment boundary. A healthy existing manifest is
 * never adopted blindly: it is stopped with PID ownership checks first, which
 * also clears a stale manifest left by a hard task termination.
 */
export async function serveStack(config, deps = {}) {
  if (readManifest(config)) {
    const stopped = await stopStack(config, deps);
    if (!stopped.ok) {
      throw new SupervisorError(`refusing to serve over an unverified existing stack: ${stopped.code}`, "MANIFEST");
    }
  }
  await startStack(config, deps);
  const status = await statusStack(config, deps);
  if (!status.ok) {
    await stopStack(config, deps);
    throw new SupervisorError("memory stack did not pass post-start ownership and health verification", "HEALTH");
  }
  return { ok: true, code: "SERVING", processes: status.processes };
}

/** Pure plan used by `prepare --dry-run` and the tests. */
export function preparePlan(config) {
  const plan = [];
  for (const name of config.order) {
    const component = config.components[name];
    if (component.kind === "fake") continue;
    const buildDir = join(config.buildRoot ?? join(config.root, "build"), name);
    const sourceDir = join(config.sourceRoot ?? join(config.root, "source"), nameLabel(component.kind));
    const steps = [];
    if (component.kind === "core") {
      steps.push("stage", "apply-patch", "transform-package", "npm-install", "esbuild-install");
    } else {
      steps.push("stage", "npm-install", "npm-build");
      if (component.kind === "knowledge") steps.push("loopback-transform");
      if (component.kind === "panel") steps.push("web-npm-install", "web-npm-build");
    }
    plan.push({ name, kind: component.kind, sourceDir, buildDir, steps });
  }
  return plan;
}

function nameLabel(kind) {
  if (kind === "core") return "MemoryCore";
  if (kind === "panel") return "MemoryPanel";
  if (kind === "knowledge") return "MemoryKnowledge";
  return kind;
}

export function verifyArchive(config) {
  if (!config.archive) return { ok: true, skipped: "no archive configured" };
  if (!existsSync(config.archive)) throw new SupervisorError(`archive not found: ${config.archive}`, "PROVENANCE");
  const digest = createHash("sha256").update(readFileSync(config.archive)).digest("hex");
  if (!config.archiveSha256) {
    throw new SupervisorError("config.archiveSha256 is required when config.archive is set", "PROVENANCE");
  }
  if (digest !== config.archiveSha256.toLowerCase()) {
    throw new SupervisorError(`archive sha256 mismatch: expected ${config.archiveSha256}, got ${digest}`, "PROVENANCE");
  }
  if (config.pinnedCommit && !basename(config.archive).includes(config.pinnedCommit.slice(0, 7))) {
    throw new SupervisorError(`archive name does not name the pinned commit ${config.pinnedCommit}`, "PROVENANCE");
  }
  return { ok: true, sha256: digest };
}

/**
 * MemoryKnowledge's upstream server calls @hono/node-server `serve({ fetch,
 * port })` with no hostname, which binds 0.0.0.0. A native loopback stack must
 * never expose that listener. This transform is one added option and is
 * applied to the STAGED copy only; the vendored source tree is untouched.
 * `assertKnowledgeLoopback` below refuses to start a build that lacks it, so a
 * stale/prebuilt bundle cannot silently defeat the guarantee.
 */
export function applyKnowledgeLoopbackSource(sourceText) {
  if (/hostname:\s*process\.env\.HOST/.test(sourceText)) return sourceText;
  const pattern = /serve\(\{\s*fetch:\s*app\.fetch,\s*port:\s*config\.port\s*\}/;
  if (!pattern.test(sourceText)) {
    throw new SupervisorError("knowledge loopback transform did not match upstream src/server.ts (upstream changed?)", "PROVENANCE");
  }
  return sourceText.replace(
    pattern,
    'serve({ fetch: app.fetch, port: config.port, hostname: process.env.HOST ?? "127.0.0.1" }',
  );
}

export function assertKnowledgeLoopback(distText) {
  if (!/hostname:\s*process\.env\.HOST\s*\?\?\s*["']127\.0\.0\.1["']/.test(distText)) {
    throw new SupervisorError(
      "MemoryKnowledge build does not force a loopback hostname; refusing to start a listener that would bind 0.0.0.0",
      "KNOWLEDGE_BIND",
    );
  }
}

/** Upstream's private/optional peer chain is not installable on this host.
 * The transform is deliberately tiny and documented: drop `peerDependencies`
 * and alias the Jimp config-typescript peer that npm otherwise tries to
 * resolve. It never changes runtime code. */
export function transformCorePackage(raw) {
  const pkg = JSON.parse(raw);
  delete pkg.peerDependencies;
  pkg.overrides = { ...(pkg.overrides ?? {}), "@jimp/config-typescript": "npm:dotenv@latest" };
  return `${JSON.stringify(pkg, null, 2)}\n`;
}

export async function prepareStack(config, { clean = false, dryRun = false, exec = runCommand, log = () => {} } = {}) {
  const plan = preparePlan(config);
  verifyArchive(config);
  if (dryRun) return { ok: true, dryRun: true, plan };
  if (!config.sourceRoot) throw new SupervisorError("config.sourceRoot is required for prepare", "CONFIG");
  if (!config.buildRoot) throw new SupervisorError("config.buildRoot is required for prepare", "CONFIG");
  if (!config.npmCli) throw new SupervisorError("config.npmCli is required for prepare", "CONFIG");
  const done = [];
  for (const step of plan) {
    if (clean && existsSync(step.buildDir)) rmSync(step.buildDir, { recursive: true, force: true });
    if (!existsSync(step.sourceDir)) {
      throw new SupervisorError(`source missing for ${step.name}: ${step.sourceDir}`, "PREPARE");
    }
    copyTree(step.sourceDir, step.buildDir);
    log(`${step.name}: staged ${step.sourceDir} -> ${step.buildDir}`);
    if (step.kind === "core") {
      if (config.patchFile) {
        exec("C:\\Program Files\\Git\\usr\\bin\\patch.exe", ["-p1", "-E", "--batch", "--forward", "-i", config.patchFile], { cwd: step.buildDir });
        log(`${step.name}: applied ${config.patchFile}`);
      }
      const pkgPath = join(step.buildDir, "package.json");
      writeFileSync(pkgPath, transformCorePackage(readFileSync(pkgPath, "utf8")));
      log(`${step.name}: applied documented package transform`);
      exec(config.node, [config.npmCli, "install", "--omit=dev", "--omit=optional", "--ignore-scripts", "--legacy-peer-deps", "--no-audit", "--no-fund"], { cwd: step.buildDir });
      exec(config.node, [config.npmCli, "install", "--no-save", "--ignore-scripts", "--no-audit", "--no-fund", "esbuild"], { cwd: step.buildDir });
    } else if (step.kind === "knowledge") {
      const serverPath = join(step.buildDir, "src", "server.ts");
      writeFileSync(serverPath, applyKnowledgeLoopbackSource(readFileSync(serverPath, "utf8")));
      log(`${step.name}: applied documented loopback-host transform`);
      const npm = config.npmCli11 ?? config.npmCli;
      exec(config.node, [npm, "install", "--no-audit", "--no-fund"], { cwd: step.buildDir });
      exec(config.node, [npm, "run", "build"], { cwd: step.buildDir });
      assertKnowledgeLoopback(readFileSync(join(step.buildDir, "dist", "server.mjs"), "utf8"));
    } else if (step.kind === "panel") {
      exec(config.node, [config.npmCli, "install", "--no-audit", "--no-fund"], { cwd: step.buildDir });
      exec(config.node, [config.npmCli, "run", "build"], { cwd: step.buildDir });
      const web = join(step.buildDir, "web");
      exec(config.node, [config.npmCli, "install", "--no-audit", "--no-fund"], { cwd: web });
      exec(config.node, [config.npmCli, "run", "build"], { cwd: web });
    }
    done.push(step);
  }
  return { ok: true, plan: done };
}

function copyTree(source, target) {
  cpSync(source, target, { recursive: true, force: true });
}

export function runCommand(command, args, options = {}) {
  execFileSync(command, args, { stdio: "inherit", windowsHide: true, ...options });
}

const CLI_VERBS = new Set(["prepare", "start", "status", "stop", "restart", "serve"]);

export function parseCli(argv = process.argv.slice(2)) {
  const verb = argv[0];
  if (!CLI_VERBS.has(verb)) {
    throw new SupervisorError(`usage: native-memory-supervisor.mjs <${[...CLI_VERBS].join("|")}> --config <path> [--json] [--dry-run] [--clean]`, "USAGE");
  }
  let configPath = null;
  let json = false;
  let dryRun = false;
  let clean = false;
  for (let i = 1; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "--config") configPath = argv[++i];
    else if (arg === "--json") json = true;
    else if (arg === "--dry-run") dryRun = true;
    else if (arg === "--clean") clean = true;
    else throw new SupervisorError(`unknown argument: ${arg}`, "USAGE");
  }
  if (!configPath) throw new SupervisorError("--config is required", "USAGE");
  if (dryRun && verb !== "prepare") {
    throw new SupervisorError("--dry-run is supported only for prepare; refusing to execute the requested operation", "USAGE");
  }
  if (clean && verb !== "prepare") {
    throw new SupervisorError("--clean is supported only for prepare", "USAGE");
  }
  return { verb, configPath, json, dryRun, clean };
}

async function main(argv) {
  const args = parseCli(argv);
  const config = loadConfig(args.configPath);
  let result;
  if (args.verb === "prepare") {
    result = await prepareStack(config, { clean: args.clean, dryRun: args.dryRun, log: (line) => console.error(line) });
  } else if (args.verb === "start") {
    result = await startStack(config);
  } else if (args.verb === "status") {
    result = await statusStack(config);
  } else if (args.verb === "stop") {
    result = await stopStack(config);
  } else if (args.verb === "serve") {
    result = await serveStack(config);
    const output = args.json ? JSON.stringify(result, null, 2) : humanSummary(args.verb, result);
    process.stdout.write(`${output}\n`);
    await new Promise((resolve) => {
      let stopping = false;
      let checking = false;
      const shutdown = async () => {
        if (stopping) return;
        stopping = true;
        clearInterval(timer);
        try { await stopStack(config); } finally { resolve(); }
      };
      const timer = setInterval(async () => {
        if (stopping || checking) return;
        checking = true;
        try {
          const status = await statusStack(config);
          if (!status.ok) {
            process.stderr.write(`memory stack degraded: ${status.code}\n`);
            clearInterval(timer);
            await stopStack(config);
            process.exit(1);
          }
        } catch (error) {
          process.stderr.write(`memory stack status failed: ${error.message}\n`);
          clearInterval(timer);
          try { await stopStack(config); } finally { process.exit(1); }
        } finally {
          checking = false;
        }
      }, 15000);
      process.on("SIGTERM", () => { void shutdown(); });
      process.on("SIGINT", () => { void shutdown(); });
    });
    return;
  } else {
    result = await restartStack(config);
  }
  const output = args.json ? JSON.stringify(result, null, 2) : humanSummary(args.verb, result);
  process.stdout.write(`${output}\n`);
  if (result.ok === false) process.exitCode = 1;
}

function humanSummary(verb, result) {
  if (verb === "prepare") {
    return result.plan.map((step) => `${step.name} [${step.steps.join(", ")}]`).join("\n");
  }
  if (result.processes) {
    const lines = result.processes.map(
      (p) => `${p.name} pid=${p.pid ?? "-"} port=${p.port ?? "-"} ownership=${p.ownership ?? "-"} health=${p.health ?? "-"}${p.reason ? ` reason=${p.reason}` : ""}`,
    );
    return [`${verb}: ${result.code}`, ...lines].join("\n");
  }
  return `${verb}: ${result.code}`;
}

const invokedDirectly = process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (invokedDirectly) {
  main().catch((error) => {
    process.stderr.write(`${error.name === "SupervisorError" ? error.message : error.stack}\n`);
    process.exitCode = 1;
  });
}
