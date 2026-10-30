// Shared bounded MemoryCore config loader. No provider calls or credentials
// printed here. Kept in CORE so lean native Windows installs never depend on
// Ghost just to provision an ordinary agent identity.
import {readFileSync} from 'node:fs';
import {resolve} from 'node:path';

export function loadGhostMemoryConfig(env = process.env) {
  const cfgPath = env.SINGULARITY_MEMORY_CONFIG
    || resolve(process.cwd(), "data/opencode/config/product-secrets/memory.json");
  let fileCfg = {};
  try { fileCfg = JSON.parse(readFileSync(cfgPath, "utf8")) || {}; } catch { fileCfg = {}; }
  const baseUrl = env.GHOST_MC_URL
    || fileCfg.hostBaseUrl
    || (typeof fileCfg.baseUrl === "string" && !fileCfg.baseUrl.includes("memory-core:") ? fileCfg.baseUrl : "")
    || "http://127.0.0.1:8420";
  const authPrefix = fileCfg.authPrefix || "Bearer ";
  const gatewayKey = env.GHOST_MC_SERVICE_KEY || fileCfg.gatewayKey || fileCfg.userKey || "";
  const userKey = env.GHOST_MC_USER_KEY || fileCfg.userKey || gatewayKey;
  const serviceId = env.GHOST_MC_SERVICE_ID || fileCfg.serviceId || "default";
  const identity = {
    team_id: env.GHOST_MC_TEAM || fileCfg.ghostTeamId || "ghost-companion",
    user_id: env.GHOST_MC_USER || fileCfg.ghostUserId || "pilot-operator",
    agent_id: env.GHOST_MC_AGENT || fileCfg.ghostAgentId || "ghost",
  };
  return { baseUrl: baseUrl.replace(/\/+$/, ""), authPrefix, gatewayKey, userKey, serviceId, identity };
}


export async function callMemoryCore(path, body, cfg = loadGhostMemoryConfig(), fetchImpl = globalThis.fetch) {
  if (!cfg.gatewayKey && !cfg.userKey) return { error: "no-service-key" };
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
  return j ?? { error: "bad-response", status: res.status, raw: text.slice(0, 200) };
}
