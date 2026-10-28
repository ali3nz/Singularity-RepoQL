// engine-state.mjs — persistent per-engine availability state with a real
// inter-process lock (cursor design-review fix B: atomicWrite alone loses
// updates when coordinator + consult write concurrently).
// State file: runs/engine-state.json  Lock file: runs/ENGINE-STATE.lock
import { readFileSync, writeFileSync, renameSync, existsSync, mkdirSync, openSync, closeSync, rmSync, statSync } from "node:fs";
import { join, dirname } from "node:path";

// V3 (run 2026-09-18T03-07-04, runbook §29): schema 3 is ADDITIVE — every v2
// record stays valid and gains the new inventory fields via defaults below.
const SCHEMA_VERSION = 3;
const RETRY_BACKOFF_MS = [50, 150, 400, 900, 2000]; // ~3.5s total before giving up
const LOCK_STALE_MS = 10_000; // crashed writer leaves a lock; take it over

// V3 per-engine inventory fields (§29). billingClass: free | included |
// prepaid_window | premium_quota | metered | disabled. roles: V3 role-chain
// membership. A missing/undefined value means "not yet determined" — consumers
// must treat undefined as unknown, never as a capability claim.
const V3_DEFAULTS = {
  enabled: null,
  roles: [],
  billingClass: null,
  visionCapable: null,
  visionVerified: null,
  automatic_implementation: null,
  automatic_vision: null,
};

// Base shape every engine record has carried since v1 (kept for new records).
const BASE_DEFAULTS = {
  state: "available", retryAt: null, cooldownUntil: null,
  consecutiveTransientFailures: 0, lastSuccess: null, lastFailure: null,
};

// Migrate a whole loaded state doc to v3. Idempotent: safe to run on every
// load; writes nothing to disk (the next update() persists it). Bumps
// schemaVersion, stamps enabled=null on old records, backfills every missing
// v3 field, and preserves claude's hard-disabled shape untouched.
function migrateStateToV3(state) {
  if (!state || typeof state !== "object") return state;
  if (!state.engines || typeof state.engines !== "object") state.engines = {};
  for (const [name, eng] of Object.entries(state.engines)) {
    if (!eng || typeof eng !== "object") continue;
    if (eng.enabled === undefined) eng.enabled = null; // v2 record: enablement undetermined
    for (const [k, v] of Object.entries(V3_DEFAULTS)) {
      if (eng[k] === undefined) eng[k] = v;
    }
  }
  state.schemaVersion = SCHEMA_VERSION;
  return state;
}

// Phase-1 Claude-off (2026-09-18, run 2026-09-18T02-02-24): claude is
// hard-disabled at the state layer. These constants are authoritative for
// every EngineState consumer; config.json claudeDisabled.* is the
// operator-facing mirror (same values, camelCase there).
export const CLAUDE_DISABLED = Object.freeze({
  enabled: false,
  disabledReason: "subscription_retired_2026-09-20",
  billingClass: "disabled",
  automatic_routing: false,
  automatic_probe: false,
  billing_allowed: false,
});

// Rewrite any legacy claude entry to the disabled shape. Idempotent and
// deterministic: applied on EVERY load (before locking) so every instance
// converges even if an old writer or a stale file said otherwise. Never
// throws, never mutates non-claude engines.
function normalizeClaudeDisabled(state) {
  if (!state || typeof state !== "object") return state;
  if (!state.engines || typeof state.engines !== "object") state.engines = {};
  const prev = state.engines.claude;
  const disabled = {
    ...(prev && typeof prev === "object" ? prev : {}),
    ...CLAUDE_DISABLED,
    state: "disabled",
    retryAt: null,
    cooldownUntil: null,
    lastFailure: (prev && typeof prev === "object" && prev.lastFailure) || "2026-09-18T02:30:00Z",
    disabledReason: "subscription_retired_2026-09-20",
  };
  if (JSON.stringify(prev) !== JSON.stringify(disabled)) {
    state.engines.claude = disabled;
    if (!state.updatedAt) state.updatedAt = new Date().toISOString();
  }
  return state;
}

export class EngineState {
  constructor(runsDir) {
    this.file = join(runsDir, "engine-state.json");
    this.lockFile = this.file.replace(/\.json$/, "") + ".lock";
    mkdirSync(dirname(this.file), { recursive: true });
    this._state = this._load();
  }

  _load() {
    try {
      const raw = JSON.parse(readFileSync(this.file, "utf8"));
      // Load-migrate: any prior schema (v1/v2/…) is normalized to v3 in
      // memory; the next update() persists it. Corrupt/missing => fresh v3.
      return normalizeClaudeDisabled(migrateStateToV3(raw));
    } catch { /* missing/corrupt => fresh */ }
    return normalizeClaudeDisabled(migrateStateToV3({ schemaVersion: SCHEMA_VERSION, engines: {} }));
  }

  // ---- locking -------------------------------------------------------
  _acquireLock() {
    const t0 = Date.now();
    let attempt = 0;
    for (;;) {
      try {
        const fd = openSync(this.lockFile, process.platform === "win32" ? "wx" : "wx");
        closeSync(fd);
        try { writeFileSync(this.lockFile, String(process.pid)); } catch { /* best effort */ }
        return;
      } catch (e) {
        // Lock exists: stale takeover or backoff retry.
        try {
          const age = Date.now() - (existsSync(this.lockFile) ? statSync(this.lockFile).mtimeMs : 0);
          if (age > LOCK_STALE_MS) { try { rmSync(this.lockFile); } catch { /* race, retry */ } continue; }
        } catch { /* fall through to backoff */ }
        if (Date.now() - t0 > 8000) {
          // last resort: steal after 8s total wait
          try { rmSync(this.lockFile); } catch { /* ignore */ }
          continue;
        }
        const wait = RETRY_BACKOFF_MS[Math.min(attempt++, RETRY_BACKOFF_MS.length - 1)];
        Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, wait);
      }
    }
  }

  _releaseLock() { try { rmSync(this.lockFile); } catch { /* ignore */ } }

  // Mutate engine state under the lock; cb receives a plain object copy.
  // Phase-1 Claude-off: claude is a frozen-disabled engine — every mutator
  // targeting it is a no-op that returns the disabled shape, so no code path
  // (quota/auth/transient/success) can ever re-enable it in state.
  update(engine, fn) {
    if (engine === "claude") return this.get("claude");
    this._acquireLock();
    try {
      const cur = this._load();
      const eng = cur.engines[engine] ?? { ...BASE_DEFAULTS, ...V3_DEFAULTS };
      const next = fn({ ...eng }) ?? eng;
      cur.engines[engine] = next;
      cur.updatedAt = new Date().toISOString();
      const tmp = this.file + ".tmp-" + process.pid;
      writeFileSync(tmp, JSON.stringify(cur, null, 2) + "\n");
      renameSync(tmp, this.file);
      this._state = cur;
      return next;
    } finally {
      this._releaseLock();
    }
  }

  get(engine) {
    if (engine === "claude") {
      // Phase-1 Claude-off: never surface a healthy default for claude.
      const stored = this._state.engines.claude;
      return stored && typeof stored === "object"
        ? { ...CLAUDE_DISABLED, ...stored, state: "disabled", disabledReason: "subscription_retired_2026-09-20" }
        : { state: "disabled", retryAt: null, cooldownUntil: null, consecutiveTransientFailures: 0, lastSuccess: null, lastFailure: null, ...CLAUDE_DISABLED };
    }
    return this._state.engines[engine] ?? { ...BASE_DEFAULTS, ...V3_DEFAULTS };
  }

  available(engine) {
    if (engine === "claude") return false; // Phase-1 Claude-off: fail-closed, never auto-selectable
    const e = this.get(engine);
    // V3.2 §5.6: an explicit enabled=false wins over EVERYTHING except the
    // claude hard-disable above. Previously only state/cooldown/quota were
    // consulted, so an operator-disabled engine with state=available was
    // still selectable. This is the switch used to disable free models,
    // Supervisor/Watchdog/quality models, or any engine temporarily.
    if (e.enabled === false) return false;
    const now = Date.now();
    if (e.cooldownUntil && now < Date.parse(e.cooldownUntil)) return false;
    if (e.cooldownUntil && now >= Date.parse(e.cooldownUntil)) {
      // cooldown expired — lazily clear
      this.update(engine, (x) => ({ ...x, cooldownUntil: null, state: "available" }));
      return true;
    }
    if (e.state === "exhausted" && e.retryAt) {
      if (now >= Date.parse(e.retryAt)) {
        this.update(engine, (x) => ({ ...x, state: "available", retryAt: null }));
        return true;
      }
      return false;
    }
    return e.state !== "disabled" && e.state !== "exhausted";
  }

  markSuccess(engine) {
    return this.update(engine, (x) => ({
      ...x, state: "available", retryAt: null, cooldownUntil: null,
      consecutiveTransientFailures: 0, lastSuccess: new Date().toISOString(),
    }));
  }

  markQuotaExhausted(engine, resetAt = null) {
    // Unknown reset: retry in 30 min (probe); known: at reset + 1 min buffer.
    const retry = resetAt ? parseLooseTime(resetAt) : Date.now() + 30 * 60_000;
    return this.update(engine, (x) => ({
      ...x, state: "exhausted", retryAt: new Date(retry).toISOString(),
      cooldownUntil: null, lastFailure: new Date().toISOString(),
    }));
  }

  markAuthFailure(engine) {
    return this.update(engine, (x) => ({ ...x, state: "disabled", lastFailure: new Date().toISOString() }));
  }

  markProviderDown(engine) {
    return this.update(engine, (x) => ({
      ...x, state: "cooldown", cooldownUntil: new Date(Date.now() + 30 * 60_000).toISOString(),
      lastFailure: new Date().toISOString(),
    }));
  }

  markTransient(engine) {
    return this.update(engine, (x) => {
      const n = (x.consecutiveTransientFailures ?? 0) + 1;
      const breaker = n >= 2 ? new Date(Date.now() + 10 * 60_000).toISOString() : null;
      return { ...x, consecutiveTransientFailures: n, cooldownUntil: breaker, lastFailure: new Date().toISOString() };
    });
  }

  markPrivacySkip(engine) {
    return this.update(engine, (x) => ({ ...x, lastFailure: new Date().toISOString() })); // health unchanged
  }

  snapshot() { return JSON.parse(JSON.stringify(this._state)); }
}

function parseLooseTime(s) {
  if (!s) return Date.now() + 30 * 60_000;
  const t = Date.parse(s);
  if (!Number.isNaN(t)) return t + 60_000;
  const m = s.match(/(\d{1,2}):(\d{2})\s*(AM|PM)/i);
  if (m) {
    let h = parseInt(m[1], 10) % 12;
    if (m[3].toUpperCase() === "PM") h += 12;
    const d = new Date();
    d.setHours(h, parseInt(m[2], 10), 0, 0);
    if (d.getTime() <= Date.now()) d.setDate(d.getDate() + 1); // assume tomorrow
    return d.getTime();
  }
  return Date.now() + 30 * 60_000;
}
