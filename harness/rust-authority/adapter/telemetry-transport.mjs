// Transport-only compatibility shim for Orchestra's native Rust observer.
// This module never selects models, grants authority or alters any workflow.
// Entirely opt-in; a delivery failure never blocks the caller.
export const ALLOWED_FIELDS = new Set([
  'kind','runId','sessionId','component','role','purpose','agent','mode','stage',
  'engine','model','provider','billingClass','attempt','success','failureClass','rc',
  'paid','visionUsed','freebucksUsed','durationMs','fallbackFrom','inputTokens',
  'cachedInputTokens','outputTokens','reasoningTokens','totalTokens','costUsd',
  'costSource','reviewVerdict','result','parentRunId',
]);

const IDENTIFIERS = new Set(['runId','sessionId','parentRunId']);
const COUNTERS = new Set(['attempt','freebucksUsed','durationMs','inputTokens',
  'cachedInputTokens','outputTokens','reasoningTokens','totalTokens']);
const BOOLEAN_FIELDS = new Set(['success','paid','visionUsed']);
const SAFE_ID = /^[a-zA-Z0-9_-]{1,128}$/;
const SAFE_LABEL = /^[a-zA-Z0-9_.:/#-]{1,128}$/;
const SAFE_KIND = /^[a-z][a-z0-9_]{0,63}$/;

export function cleanEvent(input) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) return null;
  const clean = {};
  for (const key of ALLOWED_FIELDS) {
    if (!Object.hasOwn(input,key)) continue;
    const value = input[key];
    if (IDENTIFIERS.has(key)) {
      if (typeof value === 'string' && SAFE_ID.test(value)) clean[key] = value;
    } else if (key === 'kind') {
      if (typeof value === 'string' && SAFE_KIND.test(value)) clean[key] = value;
    } else if (COUNTERS.has(key)) {
      if (Number.isSafeInteger(value) && value >= 0) clean[key] = value;
    } else if (key === 'rc') {
      if (Number.isSafeInteger(value)) clean[key] = value;
    } else if (key === 'costUsd') {
      if (typeof value === 'number' && Number.isFinite(value) && value >= 0) clean[key] = value;
    } else if (BOOLEAN_FIELDS.has(key)) {
      if (typeof value === 'boolean') clean[key] = value;
    } else if (typeof value === 'string' && SAFE_LABEL.test(value)) {
      clean[key] = value;
    }
  }
  if (!Object.hasOwn(clean, 'kind') && !Object.hasOwn(clean, 'engine')) return null;
  if (!Object.hasOwn(clean, 'kind')) clean.kind = 'model_invocation';
  const data = JSON.stringify(clean);
  if (Buffer.byteLength(data) > 2048) return null;
  return data;
}

export function createTelemetryTransport({
  endpoint = process.env.ORCHESTRA_RUST_OBSERVER_ENDPOINT,
  token = process.env.ORCHESTRA_OBSERVER_INGEST_TOKEN,
  fetchImpl = globalThis.fetch,
  maxInflight = 8,
  timeoutMs = 750,
} = {}) {
  // No ambient network access and no arbitrary host can receive telemetry.
  let enabled = false;
  if (endpoint && token && typeof fetchImpl === 'function') {
    try {
      const parsed = new URL(endpoint);
      enabled = parsed.protocol === 'http:' && ['127.0.0.1', '[::1]'].includes(parsed.hostname)
        && parsed.pathname === '/api/events' && !parsed.username && !parsed.password
        && !parsed.search && !parsed.hash;
    } catch { /* absent or invalid endpoint keeps collector disabled */ }
  }
  const metrics = {acceptedForDelivery:0, delivered:0, failed:0, dropped:0, inFlight:0};
  const limit = Number.isInteger(maxInflight) && maxInflight > 0 ? Math.min(maxInflight, 64) : 8;
  const waitMs = Number.isInteger(timeoutMs) && timeoutMs > 0 ? Math.min(timeoutMs, 5000) : 750;
  function emit(event) {
    if (!enabled) return false;
    const payload = cleanEvent(event);
    if (payload === null || metrics.inFlight >= limit) {
      metrics.dropped++;
      return false;
    }
    metrics.inFlight++;
    metrics.acceptedForDelivery++;
    // Do not await in a harness hook. Delivery is intentionally best-effort.
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), waitMs);
    timeout.unref?.();
    Promise.resolve().then(() => fetchImpl(endpoint, {
      method:'POST',
      headers:{'Content-Type':'application/json', Authorization:`Bearer ${token}`},
      body:payload,
      signal:controller.signal,
    })).then(response => {
      if (response?.status === 202) metrics.delivered++;
      else metrics.failed++;
    }).catch(() => {metrics.failed++;}).finally(() => {
      clearTimeout(timeout);
      metrics.inFlight--;
    });
    return true;
  }
  return {
    emit,
    status: () => Object.freeze({enabled, ...metrics}),
    // Test and graceful-shutdown utility only. Do not call from the hot path.
    flush: async () => {
      for (let i = 0; metrics.inFlight > 0 && i < 100; i++)
        await new Promise(resolve => setTimeout(resolve, Math.max(5, Math.ceil(waitMs / 50))));
      return metrics.inFlight === 0;
    },
  };
}
