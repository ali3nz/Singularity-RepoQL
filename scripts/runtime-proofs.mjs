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
import { fileURLToPath } from "node:url";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { timingSafeEqual } from "node:crypto";

const ADMIN_USER_TYPES = new Set(["system_admin", "admin", "root", "superadmin", "super_admin", "owner"]);
/** The memory stack's ADMINISTRATIVE key (memory/upstream/.admin-key), read in-process. Never printed. */
export function readAdministrativeKey(root) {
  try { return readFileSync(join(root, "memory", "upstream", ".admin-key"), "utf8").trim(); } catch { return ""; }
}

/**
 * True when CANDIDATE equals the ADMINISTRATIVE key. Compared in-process in
 * constant time; only the boolean leaves this function. An empty candidate or a
 * missing administrative key is never a match.
 */
export function isAdministrativeKey(candidate, adminKey) {
  const c = String(candidate || "").trim();
  const a = String(adminKey || "").trim();
  if (!c || !a) return false;
  const cb = Buffer.from(c, "utf8");
  const ab = Buffer.from(a, "utf8");
  return cb.length === ab.length && timingSafeEqual(cb, ab);
}

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
  if (ADMIN_USER_TYPES.has(t)) return { state: "ADMIN", scoped: false };
  if (t !== "business_user") return { state: "UNVERIFIED", scoped: false };
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
    if (!res.ok) return { ok: false, state: "AUTH_FAILED", detail: "the memory service rejected the authentication request" };
    payload = await res.json().catch(() => null);
  } catch (e) {
    return { ok: false, state: "UNREACHABLE", detail: `the memory service is not reachable: ${snippet(e?.message || e, 90)}` };
  }
  const valid = Boolean(payload?.code === 0 && payload?.data?.valid === true);
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
    if (!res.ok || !j || j.code !== 0 || !j.data || typeof j.data !== "object" || Array.isArray(j.data)) {
      return { ok: false, state: "WRONG_SCOPE", userType, userId,
        detail: "the memory service did not confirm access to the configured identity — check the key's user/team scope" };
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
/**
 * The controlled-fallback layer: mock upstreams + the REAL router code with
 * the TEST-ONLY injection knob. All assertions are on the router's own
 * sanitized /health telemetry (counters and names only — never keys).
 */
export async function runControlledFailoverProof({ root, mockPorts = null, overallTimeout = 120000 } = {}) {
  const http = await import("node:http");
  const { randomFillSync } = await import("node:crypto");
  const pickPort = () => (mockPorts && mockPorts.length ? mockPorts.pop() : 10000 + (randomFillSync(new Uint32Array(1))[0] % 45000));
  const mockServer = (tag, port) => new Promise((res_, rej_) => {
    const s = http.createServer((req, rsp) => {
      let _b = ""; req.on("data", (d) => { _b += d.length; });
      req.on("end", () => {
        const payload = JSON.stringify({ id: tag, choices: [{ message: { role: "assistant", content: tag } }] });
        rsp.writeHead(200, { "Content-Type": "application/json", "Content-Length": Buffer.byteLength(payload) });
        rsp.end(payload);
      });
    });
    s.on("error", rej_);
    s.listen(port, "127.0.0.1", () => res_(s));
  });

  // The router file is THIS module's sibling in the shipped scripts/ directory
  // (root may be a disposable fixture, not the product tree).
  const routerScript = fileURLToPath(new URL("./extraction-failover.mjs", import.meta.url));

  const portA = pickPort(), portB = pickPort();
  const [srvA, srvB] = await Promise.all([mockServer("A", portA), mockServer("B", portB)]);
  const secretsDir = mkdtempSync(join(tmpdir(), "sing-failover-secrets-"));
  writeFileSync(join(secretsDir, "groq-api-key"), "mock-key-A", "utf8");
  writeFileSync(join(secretsDir, "cohere-api-key"), "mock-key-B", "utf8");

  const children = [];
  const childErr = [];
  const routerChild = (port, inject) => {
    const c = spawn(process.execPath, [routerScript], {
      env: {
        ...process.env,
        EXTRACTION_FAILOVER_SECRETS_DIR: secretsDir,
        EXTRACTION_FAILOVER_GROQ_BASE: `http://127.0.0.1:${portA}/v1`,
        EXTRACTION_FAILOVER_COHERE_BASE: `http://127.0.0.1:${portB}/v1`,
        EXTRACTION_FAILOVER_PORT: String(port),
        EXTRACTION_FAILOVER_TIMEOUT_MS: "5000",
        // The quota ledger default (/data/…) is unwritable on CI runners; the
        // controlled proof needs the secondary hop usable, so the child gets
        // its own writable temp ledger (value-only path, never printed).
        COHERE_QUOTA_FILE: join(secretsDir, "cohere-quota-ledger.json"),
        ...(process.env.EXTRACTION_FAILOVER_SKIP ? {} : { EXTRACTION_FAILOVER_SKIP: "groq-20b" }),
        ...(inject ? { EXTRACTION_FAILOVER_INJECT: inject } : {}),
      },
      stdio: ["ignore", "pipe", "pipe"],
    });
    c.stdout.on("data", () => {});
    c.stderr?.on("data", (d) => { childErr.push(String(d).trim()); if (childErr.length > 12) childErr.shift(); });
    children.push(c);
    return c;
  };

  const post = async (port, body = { messages: [{ role: "user", content: "ping" }], max_tokens: 1, stream: false }, signal = AbortSignal.timeout(15000)) => {
    const r = await fetch(`http://127.0.0.1:${port}/chat/completions`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body), signal });
    return { status: r.status, j: await r.json().catch(() => null) };
  };
  const health = async (port) => {
    const r = await fetch(`http://127.0.0.1:${port}/health`, { signal: AbortSignal.timeout(5000) });
    return r.ok ? r.json().catch(() => null) : null;
  };
  const waitReady = async (c, port) => {
    const deadline = Date.now() + overallTimeout / 2;
    for (;;) {
      if (c.exitCode !== null) throw new Error(`the failover router (port ${port}) exited early (rc=${c.exitCode}): ${childErr.slice(-3).join(" | ")}`);
      const h = await health(port).catch(() => null);
      if (h && h.status === "ok") return h;
      if (Date.now() > deadline) throw new Error("the failover router did not become ready in time");
      await new Promise((r) => setTimeout(r, 120));
    }
  };

  try {
    // ── phase 1: UNDER INJECTION — the controlled primary failure ────────
    const portC = pickPort();
    const child1 = routerChild(portC, "groq-120b:503");
    const start1 = await waitReady(child1, portC);
    if ((start1.ladder || []).length < 2) throw new Error(`the ladder holds ${start1.ladder?.length || 0} provider(s) — two are required`);
    const h0 = await health(portC);
    const inj = await post(portC);
    const h1 = await health(portC);
    if (inj.status !== 200 || inj.j?.choices?.[0]?.message?.content !== "B")
      throw new Error(`the fallback did not serve the request (status ${inj.status}, content ${JSON.stringify(inj.j?.choices?.[0]?.message?.content || null)})`);
    if (h1.lastModel !== "cohere-a+") throw new Error(`the response was NOT served by the secondary (lastModel=${h1.lastModel})`);
    if (h1.failovers !== (h0.failovers || 0) + 1) throw new Error(`the fallback count moved by ${h1.failovers - (h0.failovers || 0)} — expected exactly 1`);
    if (h1.attempts !== (h0.attempts || 0) + 2) throw new Error(`attempts moved by ${h1.attempts - (h0.attempts || 0)} — expected exactly fail-then-succeed (2; a duplicate completion effect would appear here)`);
    const healthBlob = JSON.stringify(h1);
    if (healthBlob.includes("mock-key-A") || healthBlob.includes("mock-key-B")) throw new Error("provider keys leaked into the router telemetry");
    if (!h1.inject || !String(h1.inject).startsWith("groq-120b:")) throw new Error("the injection knob was not part of the controlled run");

    // ── phase 2: PERMANENT FAILURE — never retried, never masked ────────
    child1.kill("SIGKILL");
    const child2 = routerChild(portC, "groq-120b:401");
    const start2 = await waitReady(child2, portC);
    const perm = await post(portC);
    const h2 = await health(portC);
    if (perm.status !== 401) throw new Error(`a permanent 401 was NOT surfaced to the caller (status ${perm.status})`);
    if ((h2.failovers || 0) !== (start2.failovers || 0)) throw new Error("a permanent 401 was silently masked by fallback — auth failures must surface");
    if ((h2.attempts || 0) - (start2.attempts || 0) !== 1) throw new Error(`a permanent 401 was retried (attempt delta != 1)`);

    // ── phase 3: RESTART WITHOUT THE KNOB — selection survives, knob gone ─
    child2.kill("SIGKILL");
    const child3 = routerChild(portC, null);
    const start3 = await waitReady(child3, portC);
    if (start3.inject !== null) throw new Error(`the test injection knob is STILL active after the restart (${start3.inject}) — it must be removed after verification`);
    const clean = await post(portC);
    const h3 = await health(portC);
    if (clean.status !== 200 || h3.lastModel !== "groq-120b") throw new Error(`after the restart the PRIMARY did not serve again (status ${clean.status}, lastModel=${h3.lastModel})`);
    if ((h3.failovers || 0) !== (start3.failovers || 0)) throw new Error("a healthy primary-injected router produced a failover — bad selection");
    child3.kill("SIGKILL");

    return { ok: true, state: "VERIFIED",
      detail: `failover proven deterministically: both providers completed a real minimal request; the controlled primary failure (authorized test injection) failed over exactly once to the secondary (lastModel=cohere-a+), attempts moved by exactly 2 (no duplicate completion effects); a permanent 401 surfaced without retry; after a normal restart the knob was gone (inject=null) and the primary served again — routing is separate from the interactive coding lane` };
  } catch (e) {
    return { ok: false, state: "INCOMPLETE", detail: `the controlled fallback proof did not hold: ${String(e?.message || e).slice(0, 220)}` };
  } finally {
    for (const c of children) { try { c.kill("SIGKILL"); } catch {} }
    try { srvA.close(); } catch {}
    try { srvB.close(); } catch {}
  }
}

/**
 * Provider failover, proven in TWO independent layers (§6):
 *
 *   1. LIVE CREDENTIALS — each configured provider gets a REAL one-token chat
 *      completion on its production endpoint. A credential that cannot
 *      complete a minimal request never counts as a fallback candidate; a
 *      rate-limited provider is reported INCOMPLETE (retry later), never
 *      relabelled as a pass.
 *   2. CONTROLLED FALLBACK — the REAL shipped router code runs (spawned
 *      in-process) against LOCAL mock upstreams, and the primary route is
 *      deterministically failed through the router's TEST-ONLY authorized
 *      injection knob (EXTRACTION_FAILOVER_INJECT, never set in production
 *      compose). The sequence then asserts:
 *        - the secondary ACTUALLY served the reply (/health lastModel);
 *        - the attempt sequence is EXACTLY primary-fail → secondary-served
 *          (one failed hop + one success — no duplicate completion effects);
 *        - a PERMANENT 401 is surfaced to the caller: never retried, never
 *          masked by fallback (attempts stay 1, failovers 0);
 *        - provider selection survives a NORMAL restart: relaunching the
 *          router without the knob rebuilds the ladder from the keys and the
 *          primary serves again — and /health reports inject=null, proving
 *          the test knob was REMOVED afterwards.
 *
 * No keys are ever printed; the mock layer never touches a real quota.
 */
export async function probeProviderFailover({ root, timeout = 60000, fetchImpl = globalThis.fetch, routerUrl = null, mockPorts = null } = {}) {
  const secrets = join(root, "secrets");
  const readSecret = (p) => {
    for (const s of [p, `${p}.txt`]) { if (existsSync(s)) { const v = readFileSync(s, "utf8").trim(); if (v) return v; } }
    return "";
  };
  const accounts = [];
  for (const [name, base, model] of [
    ["groq", "https://api.groq.com/openai/v1", "openai/gpt-oss-20b"],
    ["cohere", "https://api.cohere.ai/compatibility/v1", "command-a-03-2025"],
  ]) {
    const key = readSecret(join(secrets, `${name}-api-key`));
    if (key) accounts.push({ name, base, key, model });
  }
  if (accounts.length < 2) {
    return { ok: false, state: "MISSING",
      detail: `only ${accounts.length} provider credential(s) configured (${accounts.map(a => a.name).join(", ") || "none"}) — TWO working providers with a controlled fallback are mandatory (secrets/groq-api-key, secrets/cohere-api-key)` };
  }

  // ── layer 1: both credentials complete a REAL minimal request ────────────
  const live = [];
  for (const a of accounts) {
    let verdict;
    try {
      // The model name is REQUIRED by the OpenAI-compatible wire (Groq rejects an
      // anonymous completion with HTTP 400 'model missing') — a credential probe
      // without one proves nothing.
      const res = await fetchImpl(`${a.base}/chat/completions`, {
        method: "POST",
        headers: { "content-type": "application/json", authorization: `Bearer ${a.key}` },
        body: JSON.stringify({ model: a.model, messages: [{ role: "user", content: "ping" }], max_tokens: 1, stream: false }),
        signal: AbortSignal.timeout(timeout),
      });
      const j = await res.json().catch(() => null);
      if (res.status >= 200 && res.status < 300 && Array.isArray(j?.choices)) verdict = { ok: true };
      else if (res.status === 429) verdict = { ok: false, why: "RATE_LIMITED" };
      else if (res.status === 401 || res.status === 403) verdict = { ok: false, why: `rejected with HTTP ${res.status} (check the credential)` };
      else verdict = { ok: false, why: `HTTP ${res.status}${j?.error?.message ? `: ${String(j.error.message).slice(0, 100)}` : ""}` };
    } catch (e) {
      verdict = { ok: false, why: `unreachable: ${String(e?.message || e).slice(0, 100)}` };
    }
    live.push({ name: a.name, ...verdict });
  }
  const dead = live.filter((l) => !l.ok);
  if (dead.length) {
    return { ok: false, state: "INCOMPLETE",
      detail: `provider credentials do not both complete a minimal real request — ${dead.map(d => `${d.name}: ${d.why}`).join("; ")} (a rate-limited provider is retry-later, never a silent skip)` };
  }

  // ── layer 2: the controlled fallback against the REAL router code ────────
  let base;
  try { base = await runControlledFailoverProof({ root, mockPorts }); }
  catch (e) {
    return { ok: false, state: "INCOMPLETE", detail: `the controlled fallback layer could not run: ${String(e?.message || e).slice(0, 160)}` };
  }
  if (base.ok) {
    // best-effort: the PRODUCTION router (compose) must never carry the test knob
    const port = Number(process.env.EXTRACTION_FAILOVER_PORT || 8430);
    const prod = String(routerUrl || process.env.EXTRACTION_FAILOVER_URL || `http://127.0.0.1:${port}`).replace(/\/+$/, "");
    try {
      const res = await fetchImpl(`${prod}/health`, { signal: AbortSignal.timeout(3000) });
      const h = res.ok ? await res.json().catch(() => null) : null;
      if (h && h.status === "ok" && h.inject) {
        return { ok: false, state: "INCOMPLETE", detail: `the production failover router still carries the TEST injection knob (${h.inject}) — recreate it without EXTRACTION_FAILOVER_INJECT before accepting this capability` };
      }
      if (h && h.status === "ok" && Array.isArray(h.ladder) && h.ladder.length < 2) {
        return { ok: false, state: "INCOMPLETE", detail: `the production failover router runs ${h.ladder.length} provider(s) in its ladder (${h.ladder.join(", ")}) — TWO are required for a controlled fallback` };
      }
    } catch { /* not running: the compose router is optional; the proof layer stands */ }
  }
  return base;
}
