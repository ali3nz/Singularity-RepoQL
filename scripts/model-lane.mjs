// model-lane.mjs — the ONE canonical LLM model lane of the product.
//
// Every model call the product makes goes through the SAME registered proxy
// lane, and that lane is DERIVED from the canonical memory-stack
// configuration — never hardcoded:
//
//     <proxy base>/<registered lane>/<space id>/v1
//
// The lane segment and the space id are the ones the proxy actually serves
// (the same ones the Claude Code main-agent memory uses:
// adapters/claude-code/main-memory.mjs → /claude-code/default). A hardcoded
// lane the proxy does not register fails with a ROUTING error
// ("spaceId is required in the request path") that looks like a credential
// problem but is not — so the lane is derived, and it is validated against
// the live proxy before anything trusts it.
//
// The probe separates the four actionable cases the operator has to act on:
//   PATH_INVALID   — the route/space is not registered (routing, not auth)
//   AUTH_FAILED    — the key was rejected (401/403 or data.valid=false)
//   NO_MODELS      — the space authenticates but the upstream advertises no
//                     model for it (the provider has nothing registered)
//   NOT_FUNCTIONAL — the space authenticates but a real completion fails
//   OK             — a real completion round-trip succeeded
//
// The key is never printed, logged or returned: only the verdict and a
// redacted detail leave this module.
import { readFileSync } from "node:fs";
import { join } from "node:path";

/** The proxy lane the product registers with (and the proxy serves). */
export const MODEL_LANE = "claude-code";
/** The space id used when nothing else is configured (the memory service id). */
export const DEFAULT_SPACE_ID = "default";
/** The container alias of the proxy on the product network. */
export const PROXY_CONTAINER_HOST = "proxy";
/** The default proxy port (the memory stack's PROXY_PORT default). */
export const DEFAULT_PROXY_PORT = 8096;

/** The proxy port: explicit env > the memory stack's upstream .env > 8096. */
export function proxyPort({ env = {}, upstreamEnvContent = null } = {}) {
  const explicit = Number(env.SINGULARITY_PROXY_PORT || env.PROXY_PORT || 0);
  if (Number.isFinite(explicit) && explicit > 0) return explicit;
  const m = /^PROXY_PORT=(\d+)\s*$/m.exec(String(upstreamEnvContent || ""));
  return m && m[1] ? Number(m[1]) : DEFAULT_PROXY_PORT;
}

/** The memory stack's upstream .env content (PROXY_PORT lives there). */
export function readUpstreamEnvContent(root) {
  try { return readFileSync(join(root, "memory", "upstream", ".env"), "utf8"); } catch { return null; }
}

/**
 * The canonical model lane.
 * flavour: "host" (loopback, for host-side scripts) | "container" (the
 * product network alias `proxy`, for the Ghost dream daemon).
 */
export function resolveModelLane({ flavour = "host", env = {}, upstreamEnvContent = null } = {}) {
  const port = proxyPort({ env, upstreamEnvContent });
  const host = flavour === "container"
    ? (env.SINGULARITY_PROXY_HOST || PROXY_CONTAINER_HOST)
    : (env.SINGULARITY_PROXY_HOST || "127.0.0.1");
  const lane = String(env.SINGULARITY_MODEL_LANE || MODEL_LANE).replace(/^\/+|\/+$/g, "");
  const spaceId = String(env.SINGULARITY_MODEL_SPACE_ID || env.MEMORY_SERVICE_ID || DEFAULT_SPACE_ID).replace(/^\/+|\/+$/g, "");
  const base = `http://${host}:${port}`;
  const route = `${base}/${lane}/${spaceId}/v1`;
  return { base, port, host, lane, spaceId, route, gatewayUrl: route, flavour };
}

const authHeaders = (key, serviceId = "default") => ({
  "content-type": "application/json",
  "x-tdai-service-id": serviceId,
  "authorization": `Bearer ${key}`,
  "x-tdai-user-key": key,
});

const snippet = (s, n = 120) => String(s || "").replace(/\s+/g, " ").slice(0, n);

/**
 * Validate a model lane against the live proxy.
 * A lane is only OK when a REAL completion round-trip succeeds: a listed
 * model, a reachable proxy or a valid key alone never proves the lane works.
 */
export async function probeModelLane({ gatewayUrl, key, serviceId = "default", fetchImpl = globalThis.fetch, timeoutMs = 15000, model = null }) {
  if (!gatewayUrl) return { ok: false, state: "PATH_INVALID", detail: "no model lane configured" };
  if (!key) return { ok: false, state: "NO_CREDENTIALS", detail: "no scoped key available for the model lane" };
  const base = String(gatewayUrl).replace(/\/+$/, "");
  const headers = authHeaders(key, serviceId);

  // 1. the models route: routing and auth, before any model call
  let models = [];
  try {
    const res = await fetchImpl(`${base}/models`, { headers, signal: AbortSignal.timeout(timeoutMs) });
    if (res.status === 400 || res.status === 404) {
      const t = snippet(await res.text().catch(() => ""), 100);
      if (/spaceId is required/i.test(t)) {
        return { ok: false, state: "PATH_INVALID", models: 0,
          detail: `the proxy rejected the ROUTE (spaceId is required in the request path) — the space id "${base}" is not registered for this lane; set SINGULARITY_MODEL_SPACE_ID to a registered business space` };
      }
      return { ok: false, state: "PATH_INVALID", models: 0, detail: `the proxy rejected the route (HTTP ${res.status}): ${t}` };
    }
    if (res.status === 401 || res.status === 403) {
      return { ok: false, state: "AUTH_FAILED", models: 0, detail: `the proxy rejected the key (HTTP ${res.status})` };
    }
    if (!res.ok) {
      return { ok: false, state: "UNREACHABLE", models: 0, detail: `the proxy models route answered HTTP ${res.status}` };
    }
    const raw = await res.text().catch(() => "");
    let j = null;
    try { j = JSON.parse(raw); } catch { j = null; }
    models = Array.isArray(j?.data) ? j.data : [];
  } catch (e) {
    return { ok: false, state: "UNREACHABLE", models: 0, detail: `the proxy models route is not reachable: ${snippet(e?.message || e, 90)}` };
  }

  // 2. the functional proof: a real completion through the lane
  const wanted = model || (models[0] && (models[0].id || models[0].name)) || "singularity-lane-probe";
  let res;
  try {
    res = await fetchImpl(`${base}/chat/completions`, {
      method: "POST", headers,
      body: JSON.stringify({ model: wanted, messages: [{ role: "user", content: "ping" }], max_tokens: 1, stream: false }),
      signal: AbortSignal.timeout(timeoutMs),
    });
  } catch (e) {
    return { ok: false, state: "UNREACHABLE", models: models.length,
      detail: `the lane authenticated but a completion failed to reach the provider: ${snippet(e?.message || e, 90)}` };
  }
  if (res.status === 401 || res.status === 403) {
    return { ok: false, state: "AUTH_FAILED", models: models.length, detail: `the proxy rejected the key (HTTP ${res.status})` };
  }
  const text = snippet(await res.text().catch(() => ""), 160);
  if (res.ok) {
    let choices = null;
    try { choices = JSON.parse(text)?.choices; } catch { choices = null; }
    if (!Array.isArray(choices)) {
      return { ok: false, state: "NOT_FUNCTIONAL", models: models.length,
        detail: `the lane answered HTTP ${res.status} without a completion payload` };
    }
    return { ok: true, state: "OK", models: models.length,
      detail: `a real completion succeeded through the lane (model "${wanted}")${models.length ? "" : "; the upstream advertises no model list"}` };
  }
  if (res.status === 404 || res.status === 400) {
    return { ok: false, state: "NO_MODELS", models: models.length,
      detail: `the lane authenticated but the provider has no working model for it (HTTP ${res.status}): ${text} — register/load a model for this space` };
  }
  return { ok: false, state: "NOT_FUNCTIONAL", models: models.length,
    detail: `the lane authenticated but the completion failed (HTTP ${res.status}): ${text}` };
}

/** The actionable operator hint for every non-OK lane state. */
export function modelLaneAdvice(state) {
  switch (state) {
    case "PATH_INVALID":
      return "the lane route is not registered on the proxy — set SINGULARITY_MODEL_SPACE_ID to a registered business space id (and keep the lane segment the proxy serves)";
    case "AUTH_FAILED":
      return "the scoped key was rejected — create/refresh the scoped MemoryCore user key and pass it with --memory-user-key";
    case "NO_CREDENTIALS":
      return "no scoped key is configured for the lane — create a dedicated business-user key and pass it with --memory-user-key";
    case "NO_MODELS":
      return "the space authenticates but the provider has no model registered for it — load/register a model for that space in the provider";
    case "NOT_FUNCTIONAL":
      return "the lane authenticates but a real completion fails — check the provider endpoint, model name and quota for this space";
    case "UNREACHABLE":
      return "the proxy lane is not reachable — start the memory stack (scripts/start-memory-stack.sh) and check the proxy port";
    default:
      return "the model lane is not verified";
  }
}
