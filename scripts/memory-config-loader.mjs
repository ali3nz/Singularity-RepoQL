// Shared bounded MemoryCore config loader. No provider calls or credentials
// printed here. Kept in CORE so lean native Windows installs never depend on
// any retired agent surface to provision a Claude Code identity.
import {readFileSync} from 'node:fs';
import {resolve} from 'node:path';
import { guardedMemorycoreV3Read, nativeReaderEnabled, nativeWriterEnabled, requestNativeMemorycoreWriter } from './native-memorycore-reader.mjs';

export function loadMemoryConfig(env = process.env) {
  const cfgPath = env.SINGULARITY_MEMORY_CONFIG
    || resolve(process.cwd(), "data/opencode/config/product-secrets/memory.json");
  let fileCfg = {};
  try { fileCfg = JSON.parse(readFileSync(cfgPath, "utf8")) || {}; } catch { fileCfg = {}; }
  const baseUrl = env.SINGULARITY_MEMORY_URL
    || fileCfg.hostBaseUrl
    || (typeof fileCfg.baseUrl === "string" && !fileCfg.baseUrl.includes("memory-core:") ? fileCfg.baseUrl : "")
    || "http://127.0.0.1:8420";
  const authPrefix = fileCfg.authPrefix || "Bearer ";
  const gatewayKey = fileCfg.gatewayKey || fileCfg.userKey || "";
  const userKey = fileCfg.userKey || gatewayKey;
  const serviceId = fileCfg.serviceId || "default";
  const identity = {
    team_id: env.SINGULARITY_MEMORY_TEAM || fileCfg.identity?.team_id || "",
    user_id: env.SINGULARITY_MEMORY_USER || fileCfg.identity?.user_id || "",
    agent_id: env.SINGULARITY_MEMORY_AGENT || fileCfg.identity?.agent_id || "",
  };
  return { baseUrl: baseUrl.replace(/\/+$/, ""), authPrefix, gatewayKey, userKey, serviceId, identity, configFile: cfgPath };
}


export async function callMemoryCore(path, body, cfg = loadMemoryConfig(), fetchImpl = globalThis.fetch) {
  const nativeRead = nativeReaderEnabled() && [
    '/v3/conversation/search', '/v3/atomic/search',
    '/v3/conversation/query', '/v3/atomic/query',
    '/v3/conversation/count', '/v3/atomic/count',
  ].includes(path);
  if (nativeRead) {
    let base;
    try { base = new URL(cfg.baseUrl); } catch { throw new Error('NATIVE_MEMORYCORE_NON_LOCAL_ORIGIN'); }
    if (base.protocol !== 'http:' || base.hostname !== '127.0.0.1' || !base.port ||
        base.username || base.password || base.pathname !== '/' || base.search || base.hash) {
      throw new Error('NATIVE_MEMORYCORE_NON_LOCAL_ORIGIN');
    }
  }
  if (!cfg.gatewayKey && !cfg.userKey) return { error: "no-service-key" };
  if (nativeWriterEnabled() && path === '/v3/conversation/add') {
    // The Rust writer must use exactly the same local configuration as this
    // caller. No secret is sent through the subprocess request or arguments.
    const local = loadMemoryConfig({ ...process.env, SINGULARITY_MEMORY_CONFIG: cfg.configFile });
    if (!cfg.configFile || ![
      'baseUrl', 'authPrefix', 'gatewayKey', 'userKey', 'serviceId',
    ].every(k => cfg[k] === local[k])) throw new Error('NATIVE_MEMORYCORE_CONFIG_DIVERGENCE');
    let origin;
    try { origin = new URL(cfg.baseUrl); } catch { throw new Error('NATIVE_MEMORYCORE_NON_LOCAL_ORIGIN'); }
    if (origin.protocol !== 'http:' || origin.hostname !== '127.0.0.1' || !origin.port ||
        origin.username || origin.password || origin.pathname !== '/' || origin.search || origin.hash) {
      throw new Error('NATIVE_MEMORYCORE_NON_LOCAL_ORIGIN');
    }
    // Exactly one write through Rust. The higher-level hook performs
    // query-before-write and readback. On an uncertain delivery, no retry.
    return requestNativeMemorycoreWriter(path, body, cfg.configFile);
  }
  const headers = {
    "content-type": "application/json",
    "x-tdai-service-id": cfg.serviceId,
    authorization: `${cfg.authPrefix}${cfg.gatewayKey || cfg.userKey}`,
  };
  if (cfg.userKey) headers["x-tdai-user-key"] = cfg.userKey;
  const res = await fetchImpl(`${cfg.baseUrl}${path}`, {
    method: "POST",
    redirect: "error", // never forward user/service keys to a redirect target
    headers,
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(20000),
  });
  if (res.ok === false) throw new Error(`MemoryCore HTTP ${res.status}`);
  const text = await res.text();
  let j = null;
  try { j = JSON.parse(text); } catch { /* raw */ }
  const out = j ?? { error: "bad-response", status: res.status, raw: text.slice(0, 200) };
  return guardedMemorycoreV3Read(path, body, out, cfg.configFile);
}
