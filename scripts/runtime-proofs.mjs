// runtime-proofs.mjs — the FUNCTIONAL proof layer of the installation gate.
//
// The gate separates two very different things:
//
//   CONFIGURED    — a file, a key or a route is present (static fact)
//   FUNCTIONALLY VERIFIED — the product really works, proven by a real
//                            runtime path shipped with this repository
//
// Every probe in this module runs a REAL shipped path (the memory loop script,
// the RepoQL MCP server, the documentation ingestion pipeline, the provider
// failover router) and returns a verdict. A probe that cannot run is a
// FAIL-CLOSED MISSING — presence is never relabelled as proof, and a stub is
// never a product PASS.
//
// No probe prints, returns or logs key material.
import { spawn } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const ADMIN_USER_TYPES = new Set(["system_admin", "admin", "root", "superadmin", "super_admin", "owner"]);
const snippet = (s, n = 140) => String(s || "").replace(/\s+/g, " ").slice(0, n);

/** Run a command and collect its output (async: an in-process service must be able to answer). */
export function runCommand(cmd, args, { env = process.env, cwd = undefined, timeout = 60000, input = null } = {}) {
  return new Promise((resolve) => {
    let child;
    try {
      child = spawn(cmd, args, { cwd, env });
    } catch (e) {
      resolve({ code: -1, out: "", err: String(e?.message || e) });
      return;
    }
    let out = "", err = "";
    child.stdout?.on("data", (d) => { out += String(d); });
    child.stderr?.on("data", (d) => { err += String(d); });
    if (input !== null) { try { child.stdin.write(input); child.stdin.end(); } catch { /* closed */ } }
    const timer = setTimeout(() => { try { child.kill("SIGKILL"); } catch { /* gone */ } }, timeout);
    child.on("error", (e) => { clearTimeout(timer); resolve({ code: -1, out, err: err || String(e?.message || e) }); });
    child.on("close", (code) => { clearTimeout(timer); resolve({ code, out, err }); });
  });
}

/**
 * Classify an authenticated memory identity.
 * valid=false          → the key was rejected
 * an administrative type → the credential is administrative (never a scoped
 *                         runtime credential: it is refused, never downgraded)
 * an empty/unknown type → the semantics cannot be discriminated: UNVERIFIED
 * a known non-admin type → a scoped business identity
 */
export function classifyMemoryScope({ valid, userType } = {}) {
  if (!valid) return { state: "AUTH_FAILED", scoped: false };
  const t = String(userType || "").trim().toLowerCase();
  if (!t) return { state: "UNVERIFIED", scoped: false };
  if (ADMIN_USER_TYPES.has(t)) return { state: "ADMIN", scoped: false };
  return { state: "OK", scoped: true };
}

/** The identity the plugin's traffic uses (the memory.json identity block). */
export function memoryIdentity(cfg = {}) {
  const id = cfg.identity || {};
  return {
    team_id: id.team_id || cfg.team_id || cfg.ghostTeamId || "default",
    user_id: id.user_id || cfg.user_id || cfg.ghostUserId || "default",
    agent_id: id.agent_id || cfg.agent_id || cfg.ghostAgentId || "default",
  };
}

/**
 * LIVE memory authentication and scope classification for a plugin key.
 * The memory core answers POST /v3/meta/auth/verify with
 * { valid, user: { user_id, user_type } } — the user_type is the key-type
 * classification the release gate needs.
 */
export async function probeMemoryIdentity({ config, baseUrl, fetchImpl = globalThis.fetch, timeoutMs = 8000 } = {}) {
  if (!config) return { ok: false, state: "NO_CREDENTIALS", detail: "no memory configuration found" };
  const key = config.userKey || "";
  const base = String(baseUrl || config.baseUrl || "").replace(/\/+$/, "");
  if (!base) return { ok: false, state: "NO_CREDENTIALS", detail: "the memory configuration has no base URL" };
  if (!key) return { ok: false, state: "NO_CREDENTIALS", detail: "the memory configuration has no scoped user key" };
  const headers = {
    "content-type": "application/json",
    "x-tdai-service-id": config.serviceId || "default",
    "authorization": `${config.authPrefix || "Bearer "}${config.gatewayKey || key}`,
    "x-tdai-user-key": key,
  };
  let payload;
  try {
    const res = await fetchImpl(`${base}/v3/meta/auth/verify`, {
      method: "POST", headers, body: JSON.stringify({ user_key: key }),
      signal: AbortSignal.timeout(timeoutMs),
    });
    payload = await res.json().catch(() => null);
  } catch (e) {
    return { ok: false, state: "UNREACHABLE", detail: `the memory service is not reachable: ${snippet(e?.message || e, 90)}` };
  }
  const valid = Boolean(payload && payload.data && payload.data.valid === true);
  const userType = payload?.data?.user?.user_type || "";
  const userId = payload?.data?.user?.user_id || "";
  const cls = classifyMemoryScope({ valid, userType });
  if (cls.state === "AUTH_FAILED") {
    return { ok: false, state: "AUTH_FAILED", detail: "the memory service rejected the key (auth/verify data.valid=false)" };
  }
  if (cls.state === "ADMIN") {
    return { ok: false, state: "ADMIN", userType, userId,
      detail: "the configured key is an ADMINISTRATIVE credential (auth/verify reports an administrative user type) — a scoped business-user key is mandatory for the release gate" };
  }
  if (cls.state === "UNVERIFIED") {
    return { ok: false, state: "UNVERIFIED", userType, userId,
      detail: "the key authenticates but its scope cannot be discriminated (no user type) — UNVERIFIED, never relabelled as a scoped identity" };
  }
  // A scoped key must also be able to act in the identity the plugin uses.
  const id = memoryIdentity(config);
  try {
    const res = await fetchImpl(`${base}/v3/conversation/count`, {
      method: "POST", headers, body: JSON.stringify(id),
      signal: AbortSignal.timeout(timeoutMs),
    });
    const j = await res.json().catch(() => null);
    if (j && j.code !== 0) {
      return { ok: false, state: "WRONG_SCOPE", userType, userId,
        detail: `the scoped key cannot act in the configured identity (count code ${j.code}) — the key belongs to a different user/team scope` };
    }
  } catch (e) {
    return { ok: false, state: "UNREACHABLE", userType, userId,
      detail: `the memory service did not answer the identity probe: ${snippet(e?.message || e, 90)}` };
  }
  return { ok: true, state: "OK", userType, userId, scope: id,
    detail: `the key authenticates as a scoped non-administrative user (auth/verify valid=true, user type "${userType}")` };
}

/**
 * The real memory loop: capture → later-session retrieval → knowledge
 * propose/promote/index/search. This is the shipped end-to-end path
 * (tests/validate-memory-loop.sh) run against the TARGET's own credentials.
 */
export async function probeMemoryLoop({ root, memoryConfigPath, memoryBaseUrl, timeout = 240000 } = {}) {
  if (!memoryConfigPath || !existsSync(memoryConfigPath)) {
    return { ok: false, state: "MISSING", detail: "the target has no provisioned memory configuration" };
  }
  const script = join(root, "tests", "validate-memory-loop.sh");
  if (!existsSync(script)) return { ok: false, state: "MISSING", detail: "the shipped memory-loop validation script is missing" };
  const env = { ...process.env, MEMORY_SECRETS: memoryConfigPath };
  if (memoryBaseUrl) env.MEMORY_BASE_URL = memoryBaseUrl;
  const r = await runCommand("bash", [script], { cwd: root, env, timeout });
  const out = `${r.out}\n${r.err}`;
  if (r.code === 0 && /LOOP OK/.test(out)) {
    // The shipped loop is an API-level proof: capture, search and knowledge
    // promotion through the memory service. It does NOT prove an automatic
    // capture from a live Claude Code/OpenChamber conversation or a recall in a
    // NEW normal session — the script itself lists that as a manual step. Those
    // are reported separately as MISSING (see verifyRuntimeProofs).
    return { ok: true, state: "VERIFIED_API", detail: "the shipped memory loop proved API-level capture, search and knowledge promotion against the target's own credentials (normal-session capture and new-session recall are NOT proven by this probe)" };
  }
  const fail = out.split("\n").filter((l) => /FAIL|Error|error|not searchable/i.test(l)).slice(-2).join(" | ");
  return { ok: false, state: "INCOMPLETE", detail: `the memory loop did not complete (rc=${r.code})${fail ? `: ${snippet(fail, 160)}` : ""}` };
}

/**
 * A REAL RepoQL MCP tool call over stdio. The client is STATEFUL: it waits for
 * each JSON-RPC reply before the next request (a one-shot stdin pipe closes
 * before the server answers and proves nothing). The sequence is:
 *   initialize → notifications/initialized → tools/list → tools/call
 * The tools/call is a READ-ONLY `query` (SELECT 1) — it never mutates the
 * index, never captures and never imports. The verdict requires a successful
 * tool result (no isError) for that call. A missing binary, a silent server or
 * a tool error is a fail-closed MISSING — a stand-in never passes.
 */
export function probeRepoqlMcp({ rqlPath, cwd = process.cwd(), timeout = 30000, execIn = null, spawnImpl = spawn } = {}) {
  if (!rqlPath || (!execIn && !existsSync(rqlPath))) {
    return Promise.resolve({ ok: false, state: "MISSING", detail: "no RepoQL binary is available for the target (the MCP server cannot be called)" });
  }
  const argv = execIn ? ["exec", "-i", execIn, rqlPath, "mcp"] : ["mcp"];
  const bin = execIn ? "docker" : rqlPath;
  return new Promise((resolve) => {
    let child;
    try {
      child = spawnImpl(bin, argv, { cwd, env: process.env, stdio: ["pipe", "pipe", "pipe"] });
    } catch (e) {
      resolve({ ok: false, state: "MISSING", detail: `the RepoQL MCP server could not start: ${snippet(e?.message || e, 90)}` });
      return;
    }
    let buf = "", stderr = "", done = false;
    const waiters = new Map();
    const finish = (verdict) => {
      if (done) return;
      done = true;
      clearTimeout(deadline);
      try { child.stdin.end(); } catch { /* closed */ }
      try { child.kill("SIGKILL"); } catch { /* gone */ }
      resolve(verdict);
    };
    const deadline = setTimeout(() => finish({ ok: false, state: "INCOMPLETE", detail: `the RepoQL MCP server did not answer within ${Math.round(timeout / 1000)} s` }), timeout);
    child.stdout?.on("data", (d) => {
      buf += String(d);
      let i;
      while ((i = buf.indexOf("\n")) >= 0) {
        const line = buf.slice(0, i).trim();
        buf = buf.slice(i + 1);
        if (!line) continue;
        let j = null;
        try { j = JSON.parse(line); } catch { continue; } // a non-JSON log line
        if (j && j.id !== undefined && waiters.has(j.id)) { waiters.get(j.id)(j); waiters.delete(j.id); }
      }
    });
    child.stderr?.on("data", (d) => { stderr += String(d); });
    child.on("error", (e) => finish({ ok: false, state: "MISSING", detail: `the RepoQL MCP server could not start: ${snippet(e?.message || e, 90)}` }));
    child.on("close", () => finish({ ok: false, state: "INCOMPLETE", detail: `the RepoQL MCP server exited before the call completed${stderr.trim() ? `: ${snippet(stderr, 120)}` : ""}` }));
    const request = (req) => new Promise((ok, fail) => {
      waiters.set(req.id, ok);
      try { child.stdin.write(JSON.stringify(req) + "\n"); } catch (e) { fail(e); }
    });
    (async () => {
      const init = await request({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2024-11-05", capabilities: {}, clientInfo: { name: "singularity-gate", version: "1" } } });
      if (!init || !init.result) return finish({ ok: false, state: "INCOMPLETE", detail: "the RepoQL MCP server rejected the initialize handshake" });
      child.stdin.write(JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" }) + "\n");
      const list = await request({ jsonrpc: "2.0", id: 2, method: "tools/list", params: {} });
      const tools = (list && list.result && list.result.tools) || [];
      if (!tools.some((t) => t && t.name === "query")) {
        return finish({ ok: false, state: "INCOMPLETE", detail: "the RepoQL MCP server does not expose the read-only query tool" });
      }
      const call = await request({ jsonrpc: "2.0", id: 3, method: "tools/call", params: { name: "query", arguments: { sql: "SELECT 1 AS gate_probe" } } });
      if (!call || !call.result) return finish({ ok: false, state: "INCOMPLETE", detail: "the RepoQL query tool call returned no result" });
      if (call.result.isError) return finish({ ok: false, state: "INCOMPLETE", detail: "the RepoQL query tool call reported an error" });
      return finish({ ok: true, state: "VERIFIED", detail: `a real RepoQL MCP tools/call succeeded (initialize, tools/list with ${tools.length} tools, read-only query)` });
    })().catch((e) => finish({ ok: false, state: "INCOMPLETE", detail: `the RepoQL MCP call failed: ${snippet(e?.message || e, 100)}` }));
  });
}

/**
 * Documentation assessment + verified ingestion: the shipped ingestion
 * pipeline ingests a probe document and reports its own verification state.
 * Only DOC_INGEST_INDEXED (persisted AND verified searchable) is a proof.
 */
export async function probeDocIngestion({ root, memoryConfigPath, memoryBaseUrl, timeout = 120000 } = {}) {
  if (!memoryConfigPath || !existsSync(memoryConfigPath)) {
    return { ok: false, state: "MISSING", detail: "the target has no provisioned memory configuration" };
  }
  const script = join(root, "scripts", "memory-doc-ingest.py");
  if (!existsSync(script)) return { ok: false, state: "MISSING", detail: "the shipped documentation ingestion pipeline is missing" };
  const dir = mkdtempSync(join(tmpdir(), "singularity-docprobe-"));
  const doc = join(dir, "gate-probe.md");
  writeFileSync(doc, `# Gate probe document\n\nThis document proves the automatic documentation assessment and verified ingestion path of the Singularity installation (${new Date().toISOString()}).\n`, "utf8");
  const env = { ...process.env, MEMORY_SECRETS: memoryConfigPath, KNOWLEDGE_INDEX_BASE_URL: memoryBaseUrl || undefined };
  const r = await runCommand("python3", [script, "ingest", "--file", doc, "--root", dir], { cwd: root, env, timeout });
  const out = `${r.out}\n${r.err}`;
  if (r.code === 0 && /DOC_INGEST_INDEXED/.test(out)) {
    return { ok: true, state: "VERIFIED", detail: "the shipped documentation pipeline ingested a document and reported it indexed and verified searchable" };
  }
  if (r.code === 0 && /DOC_INGEST_UNCHANGED/.test(out)) {
    return { ok: true, state: "VERIFIED", detail: "the shipped documentation pipeline confirmed the active revision is already verified searchable" };
  }
  const status = (out.match(/DOC_INGEST_[A-Z]+/) || ["no status"])[0];
  return { ok: false, state: "INCOMPLETE", detail: `the documentation ingestion did not reach a verified state (${status}, rc=${r.code})` };
}

/**
 * Two usable providers + controlled fallback: the shipped extraction
 * failover router. Two provider credentials must be configured AND the
 * router must answer a real request, otherwise the capability stays
 * MISSING (a configured-but-unproven ladder is never a pass).
 */
export async function probeProviderFailover({ root, timeout = 60000, fetchImpl = globalThis.fetch, routerUrl = null } = {}) {
  const secrets = join(root, "secrets");
  const providers = ["groq", "cohere"].filter((p) => {
    for (const suffix of ["-api-key", "-api-key.txt"]) {
      if (existsSync(join(secrets, `${p}${suffix}`))) return true;
    }
    return false;
  });
  if (providers.length < 2) {
    return { ok: false, state: "MISSING",
      detail: `only ${providers.length} provider credential(s) configured (${providers.join(", ") || "none"}) — TWO working providers with a controlled fallback are mandatory (secrets/groq-api-key, secrets/cohere-api-key)` };
  }
  const port = Number(process.env.EXTRACTION_FAILOVER_PORT || 8430);
  const base = String(routerUrl || process.env.EXTRACTION_FAILOVER_URL || `http://127.0.0.1:${port}`).replace(/\/+$/, "");
  const start = `docker compose -f compose/extraction-failover.compose.yml up -d`;

  // 1. the RUNNING router must hold two providers in its ladder. /health alone
  //    only shows that the process is up; the ladder shows what it can use.
  let health = null;
  try {
    const res = await fetchImpl(`${base}/health`, { signal: AbortSignal.timeout(4000) });
    health = res.ok ? await res.json().catch(() => null) : null;
  } catch { health = null; }
  if (!health || health.status !== "ok") {
    return { ok: false, state: "INCOMPLETE", detail: `${providers.length} provider credentials are configured but the failover router is not answering /health — start it (${start}) so the controlled fallback can be proven` };
  }
  const ladder = Array.isArray(health.ladder) ? health.ladder : [];
  if (ladder.length < 2) {
    return { ok: false, state: "INCOMPLETE", detail: `the failover router runs ${ladder.length} provider(s) in its ladder — two are required for a controlled fallback` };
  }

  // 2. a REAL completion through the router (the same path extraction uses).
  //    A router that is up but cannot complete a request is never a pass.
  let reply = null;
  try {
    const res = await fetchImpl(`${base}/chat/completions`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ messages: [{ role: "user", content: "ping" }], max_tokens: 1, stream: false }),
      signal: AbortSignal.timeout(timeout),
    });
    reply = res.ok ? await res.json().catch(() => null) : null;
  } catch { reply = null; }
  if (!reply || !Array.isArray(reply.choices)) {
    return { ok: false, state: "INCOMPLETE", detail: `the failover router (${ladder.length} providers in its ladder) answered /health but no real completion came back through it` };
  }
  return { ok: true, state: "VERIFIED", detail: `the failover router completed a real request through ${ladder.length} providers in its ladder (ladder: ${ladder.join(", ")}). The switch from one provider to the next is proven by scripts/extraction-failover.test.mjs, not by this live probe` };
}
