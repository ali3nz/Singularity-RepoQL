#!/usr/bin/env node
// ghost-memory.mjs — Ghost's bounded MemoryCore CLI interface.
//
// Reads credentials from data/opencode/config/product-secrets/memory.json (or
// SINGULARITY_MEMORY_CONFIG) so no secret appears on argv or in logs.
//
// Usage:
//   node ghost/ghost-memory.mjs recall "<query>" [--layer L1|L0] [--limit 5]
//   node ghost/ghost-memory.mjs remember --role user|assistant --text "..." [--session ghost-runtime-YYYY-MM-DD] [--ts ISO]
//   node ghost/ghost-memory.mjs core [--max-chars 6000]
//   node ghost/ghost-memory.mjs stats
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

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
    headers,
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(20000),
  });
  const text = await res.text();
  let j = null;
  try { j = JSON.parse(text); } catch { /* raw */ }
  return j ?? { error: "bad-response", status: res.status, raw: text.slice(0, 200) };
}

const clip = (s, n) => { s = String(s ?? ""); return s.length > n ? s.slice(0, n) + "…" : s; };

export async function runGhostMemoryCli(argv = process.argv.slice(2), opts = {}) {
  const cfg = opts.cfg || loadGhostMemoryConfig(opts.env);
  const fetchImpl = opts.fetchImpl || globalThis.fetch;
  const cmd = argv[0];
  const flag = (name, dflt) => {
    const eq = argv.find((a) => a.startsWith(`--${name}=`));
    if (eq) return eq.slice(name.length + 3);
    const i = argv.indexOf(`--${name}`);
    return i >= 0 && argv[i + 1] !== undefined ? argv[i + 1] : dflt;
  };
  const positional = argv.slice(1).filter((a, i) => !a.startsWith("--") && !(i > 0 && argv[i] && String(argv[i]).startsWith("--") && !String(argv[i]).includes("=")));
  const defaultSession = (opts.env || process.env).GHOST_MC_SESSION || `ghost-runtime-${new Date().toISOString().slice(0, 10)}`;

  if (cmd === "recall") {
    const query = flag("query") || positional.join(" ").trim();
    if (!query) return { exitCode: 2, output: { error: "usage: ghost-memory recall \"<query>\" [--layer L1|L0] [--limit 5]" } };
    const layer = String(flag("layer", "L1")).toUpperCase();
    const limit = Math.min(Number(flag("limit", 5)) || 5, 20);
    const ep = layer === "L0" ? "/v3/conversation/search" : "/v3/atomic/search";
    const r = await callMemoryCore(ep, { ...cfg.identity, query, limit }, cfg, fetchImpl);
    if (r.error || (r.code !== undefined && r.code !== 0)) {
      return { exitCode: 1, output: { error: r.error || r.message || "recall-failed", code: r.code } };
    }
    const items = (r.data?.messages || r.data?.atoms || r.data?.items || []).map((m) => ({
      id: m.id,
      score: m.score ? Math.round(m.score * 1000) / 1000 : undefined,
      session: m.session_id,
      ts: m.timestamp || m.recorded_at,
      text: clip(m.content ?? m.body, 600),
    }));
    return { exitCode: 0, output: { layer, query, count: items.length, items } };
  }

  if (cmd === "remember") {
    const role = String(flag("role", "user"));
    const text = flag("text") || positional.join(" ").trim();
    const session = flag("session", defaultSession);
    const ts = flag("ts") || new Date().toISOString();
    if (!text) return { exitCode: 2, output: { error: "usage: ghost-memory remember --role user|assistant --text \"...\"" } };
    if (!["user", "assistant"].includes(role)) return { exitCode: 2, output: { error: "role must be user|assistant" } };
    const taskId = `${session}-${Date.now().toString(36)}`;
    const r = await callMemoryCore("/v3/conversation/add", {
      ...cfg.identity,
      session_id: session,
      task_id: taskId,
      messages: [{ role, content: text.slice(0, 8000), recorded_at: ts }],
    }, cfg, fetchImpl);
    const ok = r.code === 0;
    return {
      exitCode: ok ? 0 : 1,
      output: { ok, code: r.code, message: r.message || r.error, session, accepted: r.data?.accepted_ids?.length ?? (ok ? 1 : 0) },
    };
  }

  if (cmd === "core") {
    const max = Number(flag("max-chars", 6000)) || 6000;
    const r = await callMemoryCore("/v3/core/read", { ...cfg.identity }, cfg, fetchImpl);
    const content = r.data?.content || "";
    return {
      exitCode: r.code === 0 ? 0 : 1,
      output: { ok: r.code === 0, chars: content.length, version: r.data?.version, content: clip(content, max) },
    };
  }

  if (cmd === "stats") {
    const [l0, l1] = await Promise.all([
      callMemoryCore("/v3/conversation/count", cfg.identity, cfg, fetchImpl),
      callMemoryCore("/v3/atomic/count", cfg.identity, cfg, fetchImpl),
    ]);
    return {
      exitCode: 0,
      output: { identity: cfg.identity, l0_messages: l0.data?.total ?? 0, l1_atomic: l1.data?.total ?? 0 },
    };
  }

  return {
    exitCode: cmd ? 2 : 0,
    output: {
      usage: [
        "ghost-memory recall \"<query>\" [--layer L1|L0] [--limit 5]",
        "ghost-memory remember --role user|assistant --text \"...\" [--session ghost-runtime-YYYY-MM-DD] [--ts ISO]",
        "ghost-memory core [--max-chars 6000]",
        "ghost-memory stats",
      ],
    },
  };
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const res = await runGhostMemoryCli();
  process.stdout.write(JSON.stringify(res.output, null, 2) + "\n");
  process.exit(res.exitCode);
}
