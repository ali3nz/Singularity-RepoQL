// routing.mjs — orchestration-level model routing.
//
// This is NOT the MemoryCore extraction router (scripts/extraction-failover.mjs
// owns that). This layer decides which model serves an orchestration ROLE
// (coordinator, worker, reviewer) under a mode's provider policy.
//
// Hard rule: when the policy is "free", a route is usable only if it is
// declared free AND its zero pricing was verified. There is no fallback to a
// paid route — if nothing qualifies, the call fails closed so a test can never
// spend money silently.

export class FreeRouteUnavailable extends Error {
  constructor(detail) {
    super(`no verified free route available: ${detail}`);
    this.name = "FreeRouteUnavailable";
  }
}

export class RouteNotAllowed extends Error {
  constructor(detail) {
    super(detail);
    this.name = "RouteNotAllowed";
  }
}

export const RETRYABLE = new Set(["rate_limit", "timeout", "transient", "overloaded", "network"]);
export const TERMINAL = new Set(["auth", "invalid_request", "configuration", "content_policy", "not_found"]);

/**
 * Normalise a route declaration. `pricing` records the observed input/output
 * cost per million tokens; a free route must carry zeroes and a verification
 * timestamp, because "the name says free" is not evidence.
 */
export function normaliseRoute(route) {
  if (!route.id || !route.provider || !route.model) {
    throw new RouteNotAllowed("a route needs id, provider and model");
  }
  const pricing = route.pricing ?? null;
  const cost = route.cost ?? (pricing && pricing.input === 0 && pricing.output === 0 ? "free" : "paid");
  const verifiedFree = Boolean(route.verifiedFree) && cost === "free" && pricing?.input === 0 && pricing?.output === 0;
  return {
    id: route.id,
    provider: route.provider,
    model: route.model,
    roles: Array.isArray(route.roles) && route.roles.length ? route.roles : ["coordinator", "worker", "reviewer"],
    cost,
    pricing,
    verifiedFree,
    verifiedAt: route.verifiedAt ?? null,
    evidence: route.evidence ?? null,
    order: Number.isFinite(route.order) ? route.order : 100,
  };
}

/** Routes usable for a role under a provider policy, best first. */
export function eligibleRoutes({ role, policy = "any", registry = [], pinnedId = null }) {
  const routes = registry.map(normaliseRoute).filter((r) => r.roles.includes(role));
  const allowed = policy === "free" ? routes.filter((r) => r.verifiedFree) : routes;
  if (pinnedId) {
    const pinned = allowed.find((r) => r.id === pinnedId);
    if (!pinned) {
      throw new RouteNotAllowed(
        policy === "free"
          ? `pinned route '${pinnedId}' is not a verified free route for role ${role}`
          : `pinned route '${pinnedId}' is not registered for role ${role}`,
      );
    }
    return [pinned];
  }
  return allowed.sort((a, b) => a.order - b.order || a.id.localeCompare(b.id));
}

export function selectRoute(options) {
  const allowed = eligibleRoutes(options);
  if (!allowed.length) {
    throw new FreeRouteUnavailable(`role ${options.role}, policy ${options.policy ?? "any"}`);
  }
  return allowed[0];
}

export function classifyError(err) {
  const kind = String(err?.kind ?? err?.code ?? "").toLowerCase();
  if (RETRYABLE.has(kind)) return { retryable: true, kind };
  if (TERMINAL.has(kind)) return { retryable: false, kind };
  const status = Number(err?.status ?? 0);
  if (status === 429 || status === 408 || status >= 500) return { retryable: true, kind: kind || `http_${status}` };
  if (status >= 400) return { retryable: false, kind: kind || `http_${status}` };
  return { retryable: false, kind: kind || "unknown" };
}

/**
 * Invoke a role through an injected transport.
 *
 * `transport(route, request)` is provided by the caller: the CLI uses a real
 * HTTP transport; tests use a deterministic fake. This module never opens a
 * socket itself, which keeps the routing contract testable without a model call.
 *
 * Returns a structured outcome; a paid route is never silently substituted.
 */
export async function invokeRole({
  role,
  policy = "any",
  registry = [],
  pinnedId = null,
  request = {},
  transport,
  maxAttempts = 2,
  now = () => Date.now(),
  sleep = async () => {},
  telemetry = null,
}) {
  if (typeof transport !== "function") throw new RouteNotAllowed("a transport function is required");
  const startedAt = now();
  const attempts = [];
  let route;
  try {
    route = selectRoute({ role, policy, registry, pinnedId });
  } catch (err) {
    return {
      ok: false,
      role,
      policy,
      routeId: null,
      attempts,
      error: { kind: "no_route", message: err.message },
      classification: { retryable: false, kind: "no_route" },
      telemetry: { costUsd: 0, promptTokens: 0, completionTokens: 0, totalTokens: 0, elapsedMs: 0, calls: 0 },
    };
  }

  let lastError = null;
  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    try {
      const result = await transport(route, request);
      const usage = result?.usage ?? {};
      const outcome = {
        ok: true,
        role,
        policy,
        routeId: route.id,
        provider: route.provider,
        model: route.model,
        attempts,
        attemptsUsed: attempt,
        result,
        telemetry: {
          costUsd: route.verifiedFree ? 0 : Number(usage.costUsd ?? 0),
          promptTokens: Number(usage.promptTokens ?? 0),
          completionTokens: Number(usage.completionTokens ?? 0),
          totalTokens: Number(usage.promptTokens ?? 0) + Number(usage.completionTokens ?? 0),
          elapsedMs: now() - startedAt,
          calls: attempt,
        },
      };
      attempts.push({ attempt, ok: true });
      if (telemetry) telemetry.push({ ...outcome.telemetry, role, routeId: route.id, model: route.model });
      return outcome;
    } catch (err) {
      const classification = classifyError(err);
      attempts.push({ attempt, ok: false, kind: classification.kind, message: err?.message ?? String(err) });
      lastError = err;
      if (!classification.retryable) {
        return {
          ok: false,
          role,
          policy,
          routeId: route.id,
          provider: route.provider,
          model: route.model,
          attempts,
          error: { kind: classification.kind, message: err?.message ?? String(err) },
          classification,
          telemetry: { costUsd: route.verifiedFree ? 0 : Number(err?.usage?.costUsd ?? 0), promptTokens: 0, completionTokens: 0, totalTokens: 0, elapsedMs: now() - startedAt, calls: attempt },
        };
      }
      if (attempt < maxAttempts) await sleep(100 * attempt);
    }
  }
  const classification = classifyError(lastError);
  return {
    ok: false,
    role,
    policy,
    routeId: route.id,
    provider: route.provider,
    model: route.model,
    attempts,
    error: { kind: classification.kind, message: lastError?.message ?? "exhausted attempts" },
    classification,
    telemetry: { costUsd: route.verifiedFree ? 0 : 0, promptTokens: 0, completionTokens: 0, totalTokens: 0, elapsedMs: now() - startedAt, calls: maxAttempts },
  };
}

/**
 * Assert that a whole routing plan is free-only safe. Used by the CLI before a
 * run starts, so an operator learns about a paid-only role before any work.
 */
export function assertFreeOnlySafe({ registry, roles, pinned = {} }) {
  const problems = [];
  for (const role of roles) {
    try {
      const routes = eligibleRoutes({ role, policy: "free", registry, pinnedId: pinned[role] ?? null });
      if (!routes.length) problems.push(`${role}: no verified free route`);
    } catch (err) {
      problems.push(`${role}: ${err.message}`);
    }
  }
  if (problems.length) throw new FreeRouteUnavailable(problems.join("; "));
  return true;
}
