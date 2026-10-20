// main-memory.mjs — the NORMAL Claude Code parent session's persistent memory.
//
// A specialised agent keeps its own MemoryCore identity through the memory
// hooks. The parent session gets persistent memory when its model requests are
// ROUTED THROUGH the Singularity memory proxy: the proxy captures the parent
// conversation, injects relevant prior context into new sessions, and keeps the
// ordinary Claude Code experience unchanged. This module is the pure, tested
// core of that configuration; scripts/install-claude-code.mjs drives it.
//
// Safety rules (docs/CLAUDE-CODE-SETUP.md §main-agent memory):
//   - Existing provider configuration (Anthropic/Bedrock/Vertex/third-party
//     gateway) is NEVER silently overwritten — overwrite needs the explicit
//     replaceProvider consent on top of enableMainMemory.
//   - Env overrides declared in settings and values we do not own are
//     preserved; only the values recorded in the install state are removable.
//   - The scoped business-user key never appears in logs, errors or argv. It
//     lives only in the user settings file (mode 0600) or an apiKeyHelper.

const MEMORY_ENV = ["ANTHROPIC_BASE_URL", "ANTHROPIC_AUTH_TOKEN", "ANTHROPIC_MODEL"];

// Endpoint resolution: explicit env override > upstream .env PROXY_PORT > 8096.
// "default" is the proxy's default client scope for Claude Code traffic.
export function resolveMainProxyUrl({ env = {}, upstreamEnvContent = null, home = null } = {}) {
  if (env.SINGULARITY_MAIN_AGENT_PROXY_URL) return String(env.SINGULARITY_MAIN_AGENT_PROXY_URL).replace(/\/$/, "");
  if (upstreamEnvContent) {
    const m = /^PROXY_PORT=(\d+)\s*$/m.exec(String(upstreamEnvContent));
    if (m && m[1]) return `http://127.0.0.1:${m[1]}/claude-code/default`;
  }
  return "http://127.0.0.1:8096/claude-code/default";
}

/** Parse the score of an existing settings.json for main-memory conflicts. */
export function detectProviderConflicts(settings, opts = {}) {
  const env = (settings && typeof settings.env === "object") ? settings.env : {};
  const conflicts = [];
  const ownedUrl = opts.baseUrl;
  if (env.ANTHROPIC_BASE_URL && ownedUrl && String(env.ANTHROPIC_BASE_URL).replace(/\/$/, "") !== String(ownedUrl).replace(/\/$/, ""))
    conflicts.push("ANTHROPIC_BASE_URL is set to another endpoint");
  if (env.ANTHROPIC_API_KEY !== undefined) conflicts.push("ANTHROPIC_API_KEY is set (existing Anthropic auth)");
  if (env.ANTHROPIC_BEDROCK_BASE_URL !== undefined || env.CLAUDE_CODE_USE_BEDROCK !== undefined)
    conflicts.push("Bedrock routing is configured");
  if (env.ANTHROPIC_VERTEX_BASE_URL !== undefined || env.CLAUDE_CODE_USE_VERTEX !== undefined)
    conflicts.push("Vertex routing is configured");
  if (env.CLAUDE_CODE_USE_FOUNDRY !== undefined)
    conflicts.push("Foundry routing is configured");
  if (typeof settings.apiKeyHelper === "string" && settings.apiKeyHelper.trim())
    conflicts.push("apiKeyHelper is configured");
  return conflicts;
}

/** True when settings already point the parent session at OUR proxy. */
export function isMainMemoryOwnConfig(settings, baseUrl) {
  const env = (settings && typeof settings.env === "object") ? settings.env : {};
  return Boolean(env.ANTHROPIC_BASE_URL &&
    String(env.ANTHROPIC_BASE_URL).replace(/\/$/, "") === String(baseUrl).replace(/\/$/, ""));
}

/**
 * Merge (or refuse) main-agent proxy routing into a settings object.
 * opts: { baseUrl, token (NEVER logged), model, replaceProvider }
 * Returns { settings, changed, mode, reasons } with mode one of
 *   "merged" | "verified-existing" | "refused-conflict" | "unchanged".
 */
export function ensureMainMemoryIntegration(input, opts) {
  const { baseUrl, token, model, replaceProvider = false } = opts;
  if (!baseUrl) throw new Error("ensureMainMemoryIntegration requires baseUrl");
  const settings = structuredClone(input) || {};
  settings.env = (settings.env && typeof settings.env === "object") ? settings.env : {};

  if (isMainMemoryOwnConfig(settings, baseUrl)) {
    let touched = false;
    if (token && !settings.env.ANTHROPIC_AUTH_TOKEN) { settings.env.ANTHROPIC_AUTH_TOKEN = token; touched = true; }
    if (model && !settings.env.ANTHROPIC_MODEL) { settings.env.ANTHROPIC_MODEL = model; touched = true; }
    return { settings, changed: touched, mode: "verified-existing", reasons: [] };
  }

  const conflicts = detectProviderConflicts(settings, { baseUrl });
  if (conflicts.length && !replaceProvider) {
    return { settings, changed: false, mode: "refused-conflict",
      reasons: [...conflicts, "explicit --replace-provider consent required to change provider routing"] };
  }

  let changed = false;
  if (settings.env.ANTHROPIC_BASE_URL !== baseUrl) { settings.env.ANTHROPIC_BASE_URL = baseUrl; changed = true; }
  if (token && settings.env.ANTHROPIC_AUTH_TOKEN !== token) { settings.env.ANTHROPIC_AUTH_TOKEN = token; changed = true; }
  if (model && settings.env.ANTHROPIC_MODEL !== model) { settings.env.ANTHROPIC_MODEL = model; changed = true; }
  return { settings, changed, mode: conflicts.length ? "merged-over-replace-consent" : "merged", reasons: conflicts };
}

/** Values restore-able at uninstall: only keys that still hold what we wrote. */
export function mainMemoryOwnedEnv(record, settings) {
  const written = (record && record.mainMemory && record.mainMemory.envWritten) || {};
  const env = (settings && typeof settings.env === "object") ? settings.env : {};
  const owned = {};
  for (const k of MEMORY_ENV) {
    if (written[k] !== undefined && env[k] === written[k]) owned[k] = written[k];
  }
  return owned;
}

export function removeMainMemoryIntegration(settings, record, prev = {}) {
  const s = structuredClone(settings) || {};
  const env = (s.env && typeof s.env === "object") ? s.env : {};
  const changedKeys = [];
  for (const k of MEMORY_ENV) {
    if (env[k] === undefined) continue;
    const ours = mainMemoryOwnedEnv(record, s)[k] !== undefined;
    if (!ours) continue; // not the value we wrote (user changed it): never touch
    if (prev[k] !== undefined && prev[k] !== "") env[k] = prev[k]; // restore previous value
    else delete env[k];
    changedKeys.push(k);
  }
  return { settings: s, changedKeys };
}

/**
 * Classify the effective main-memory state from observed settings WITHOUT
 * live calls. result: { CONFIGURED | VERIFIED-PROBE | DISABLED | DEGRADED |
 * CONFLICTED } — the caller upgrades CONFIGURED to VERIFIED only after a
 * successful authenticated probe against the proxy.
 */
export function classifyMainMemoryState(settings, baseUrl, probe = null) {
  const env = (settings && typeof settings.env === "object") ? settings.env : {};
  const conflicts = detectProviderConflicts(settings, { baseUrl });
  const ours = isMainMemoryOwnConfig(settings, baseUrl);
  if (ours && conflicts.length) return { state: "CONFLICTED", detail: `${ours ? "our endpoint is set but overridden elsewhere" : "other routing present"}: ${conflicts.join("; ")}` };
  if (!ours) {
    return { state: env.ANTHROPIC_BASE_URL ? "CONFLICTED" : "DISABLED", detail: conflicts.join("; ") };
  }
  if (probe === null) return { state: "CONFIGURED", detail: "settings point at the Singularity proxy; run with --probe for VERIFIED" };
  if (probe.ok) return { state: "VERIFIED", detail: `authenticated proxy probe ok (${probe.detail})` };
  if (probe.authRejected) return { state: "DEGRADED", detail: `proxy reachable but auth failed (${probe.detail})` };
  return { state: "DEGRADED", detail: `proxy not reachable (${probe.detail})` };
}

/**
 * Bounded authenticated probe of the Singularity memory proxy (vendored
 * tdai-proxy): (1) GET <root>/health proves reachability; (2) a minimal
 * authenticated POST <root>/v1/messages (max_tokens=1, Anthropic protocol per
 * the vendored proxy contract) proves the scoped key authorises. Never prints
 * or returns the token. Only for `status --probe`; install-time checks stay
 * offline so a fresh non-interactive install cannot hang on an unreachable host.
 */
export async function probeMainProxy(baseUrl, token, fetchImpl = globalThis.fetch, timeoutMs = 5000) {
  let root;
  try { root = String(baseUrl).replace(/\/$/, ""); }
  catch { return { ok: false, detail: "unparseable proxy URL" }; }
  // The vendored proxy requires the spaceId (serviceId, e.g. /claude-code/default)
  // in the request path for auth — the POST must go to the FULL base URL,
  // never a stripped root. Health reachability is still checked at the root.
  const hasPath = root.replace(/^https?:\/\//, "").includes("/");
  const messagesUrl = (hasPath ? root : root + "/claude-code/default") + "/v1/messages";
  try {
    const health = await fetchImpl(normalizeToRoot(root) + "/health", { signal: AbortSignal.timeout(timeoutMs) });
    if (!health.ok) {
      const t = (await health.text().catch(() => "")).slice(0, 80);
      return { ok: false, authRejected: health.status === 401 || health.status === 403, detail: `proxy health HTTP ${health.status}: ${t}` };
    }
    if (!token) return { ok: false, authRejected: true, detail: "proxy reachable (health ok) but no scoped key available for the authenticated check" };
    const res = await fetchImpl(messagesUrl, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}`, "x-api-key": token, "anthropic-version": "2023-06-01" },
      body: JSON.stringify({ model: "singularity-status-probe", max_tokens: 1, messages: [{ role: "user", content: "ping" }] }),
      signal: AbortSignal.timeout(timeoutMs * 3),
    });
    const snippet = (await res.text().catch(() => "")).slice(0, 100);
    if (res.status === 401 || res.status === 403) return { ok: false, authRejected: true, detail: `auth rejected: HTTP ${res.status} ${snippet}` };
    // 404 with an "Invalid model identifier" body means auth PASSED and upstream
    // reached model resolution — good enough proof of a working scoped key.
    if (res.status === 404) {
      const authOk = /invalid model identifier/i.test(snippet);
      return authOk
        ? { ok: true, authRejected: false, detail: "auth accepted (probe model unknown to upstream, 404)" }
        : { ok: false, authRejected: false, detail: `proxy reachable; /v1/messages probe returned 404 (unexpected upstream contract): ${snippet}` };
    }
    if (res.ok) return { ok: true, authRejected: false, detail: `authenticated POST ok (HTTP ${res.status})` };
    // 4xx/5xx after auth: the key was accepted far enough to reach upstream handling
    return { ok: true, authRejected: false, detail: `auth accepted; upstream answered HTTP ${res.status}` };
  } catch (e) {
    return { ok: false, authRejected: false, detail: String(e?.message || e).slice(0, 140) };
  }
}

/** http://host:P/claude-code/default -> http://host:P  (probe needs the root for /health). */
function normalizeToRoot(baseUrl) {
  return String(baseUrl).replace(/\/claude-code\/[^/]*\/?$/, "");
}
