// Read-only Freebuff session API status shared by the orchestration kit and bridge.
// Credentials are consumed in memory only and never included in output/logs.
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

const DEFAULT_TIME_ZONE = process.env.FREEBUFF_TIME_ZONE || "Pacific/Auckland";
const CACHE_TTL_MS = Math.max(5_000, Number(process.env.FREEBUFF_STATUS_CACHE_MS) || 60_000);
const REQUEST_TIMEOUT_MS = Math.max(1_000, Number(process.env.FREEBUFF_STATUS_TIMEOUT_MS) || 10_000);
let cachedStatus = null;
let cachedAt = 0;
let inFlight = null;

function readJson(path) {
  try { return JSON.parse(readFileSync(path, "utf8")); } catch { return null; }
}

const DEFAULT_API_BASE = "https://codebuff.com";
const APPROVED_DESKTOP_ORIGINS = new Set(["https://codebuff.com", "https://www.codebuff.com"]);

function approvedOrigin(value) {
  try {
    const origin = new URL(value).origin;
    return APPROVED_DESKTOP_ORIGINS.has(origin) ? origin : null;
  } catch {
    return null;
  }
}

function configuredApiBase() {
  const value = process.env.NEXT_PUBLIC_CODEBUFF_APP_URL || process.env.FREEBUFF_SESSION_API_BASE_URL;
  return value ? value.replace(/\/+$/, "") : null;
}

function tokenFromCredentials() {
  const configDir = process.env.FREEBUFF_CONFIG_DIR || join(homedir(), ".config", "manicode");
  const data = readJson(join(configDir, "credentials.json"));
  const token = data?.default?.authToken;
  return typeof token === "string" && token.trim() ? token : null;
}

function tokenFromDesktopState() {
  const candidates = [
    process.env.FREEBUFF_DESKTOP_STATE_PATH,
    join(homedir(), ".config", "freebuff-desktop", "state.json"),
    "/home/node/.config/freebuff-desktop/state.json",
    "/opt/harness-unset/freebuff/config/state.json",
  ].filter(Boolean);
  for (const path of [...new Set(candidates)]) {
    const data = readJson(path);
    if (!data) continue;
    const sessions = data.authSessions && typeof data.authSessions === "object" ? data.authSessions : {};
    const matches = Object.entries(sessions)
      .map(([key, value]) => ({ origin: approvedOrigin(key), token: value?.token }))
      .filter((entry) => entry.origin && typeof entry.token === "string" && entry.token.trim());
    const selected = matches.find((entry) => entry.origin === "https://www.codebuff.com") ?? matches[0];
    if (selected) return selected;
    const fallback = data.default?.authToken;
    if (typeof fallback === "string" && fallback.trim()) return { token: fallback, origin: DEFAULT_API_BASE };
  }
  return null;
}

function tokenAndBase() {
  const override = configuredApiBase();
  const credentialsToken = tokenFromCredentials();
  if (credentialsToken) return { token: credentialsToken, base: override ?? DEFAULT_API_BASE };
  const desktop = tokenFromDesktopState();
  if (desktop) return { token: desktop.token, base: override ?? desktop.origin ?? DEFAULT_API_BASE };
  return null;
}

function numberOrNull(value) {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function emptyFreebucks() {
  return {
    available: false, balance: null, dailyLimit: null, dailySpent: null,
    dailyRemaining: null, dailyResetAt: null, resetTimeZone: null,
    hoursUntilReset: null, walletBalance: null, monthlyBonus: null,
    nextBonusAt: null, planId: null,
  };
}

function unavailable(error, accountAuthenticated = null, sessionStatus = null, httpStatus = null) {
  return {
    source: "freebuff", accountAuthenticated, sessionStatus,
    freebucks: emptyFreebucks(), error, httpStatus,
    refreshedAt: new Date().toISOString(), cached: false,
  };
}

function normalizeResetAt(value) {
  if (typeof value === "number" && Number.isFinite(value)) {
    const ms = value < 1e12 ? value * 1000 : value;
    return Number.isFinite(new Date(ms).getTime()) ? new Date(ms).toISOString() : null;
  }
  if (typeof value !== "string") return null;
  const ms = Date.parse(value);
  return Number.isFinite(ms) ? new Date(ms).toISOString() : null;
}

async function fetchStatus() {
  const auth = tokenAndBase();
  if (!auth) return unavailable("credentials_missing", false);

  const url = auth.base + "/api/v1/freebuff/session";
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
  let response;
  try {
    response = await fetch(url, {
      method: "GET",
      headers: {
        Authorization: "Bearer " + auth.token,
        Accept: "application/json",
        "x-fb-timezone": DEFAULT_TIME_ZONE,
      },
      signal: controller.signal,
    });
  } catch {
    return unavailable("request_failed", null);
  } finally {
    clearTimeout(timer);
  }

  if (response.status === 401) return unavailable("unauthorized", false, null, 401);
  if (response.status === 403) return unavailable("forbidden", null, null, 403);
  let payload = null;
  try { payload = await response.json(); } catch { /* response bodies are never surfaced */ }
  const sessionStatus = typeof payload?.status === "string" ? payload.status : null;
  if (!response.ok && response.status !== 404) {
    return unavailable(`http_${response.status}`, null, sessionStatus, response.status);
  }

  const raw = payload?.freebucks;
  if (raw === null || raw === undefined || typeof raw !== "object" || Array.isArray(raw)) {
    return unavailable(raw === null ? "freebucks_null" : "freebucks_missing", true, sessionStatus, response.status);
  }
  const daily = raw.daily && typeof raw.daily === "object" ? raw.daily : {};
  const wallet = raw.wallet && typeof raw.wallet === "object" ? raw.wallet : {};
  const resetAt = normalizeResetAt(daily.resetAt);
  const resetMs = resetAt ? Date.parse(resetAt) : NaN;
  const hours = Number.isFinite(resetMs) ? Math.max(0, (resetMs - Date.now()) / 3_600_000) : null;
  return {
    source: "freebuff", accountAuthenticated: true, sessionStatus,
    freebucks: {
      available: true,
      balance: numberOrNull(raw.balance),
      dailyLimit: numberOrNull(daily.limit),
      dailySpent: numberOrNull(daily.spent),
      dailyRemaining: numberOrNull(daily.remaining),
      dailyResetAt: resetAt,
      resetTimeZone: typeof daily.resetTimeZone === "string" ? daily.resetTimeZone : DEFAULT_TIME_ZONE,
      hoursUntilReset: hours === null ? null : Number(hours.toFixed(2)),
      walletBalance: numberOrNull(wallet.balance),
      monthlyBonus: numberOrNull(wallet.monthlyBonus),
      nextBonusAt: normalizeResetAt(wallet.nextBonusAt),
      planId: typeof raw.planId === "string" ? raw.planId : null,
    },
    error: null, httpStatus: response.status,
    refreshedAt: new Date().toISOString(), cached: false,
  };
}

export async function getFreebucksStatus({ refresh = false } = {}) {
  const ageMs = Date.now() - cachedAt;
  if (!refresh && cachedStatus && ageMs < CACHE_TTL_MS) {
    return { ...cachedStatus, cached: true, ageSeconds: Math.floor(ageMs / 1000) };
  }
  if (inFlight) return inFlight;
  inFlight = fetchStatus().then((status) => {
    // Missing/null meter data replaces the cache with UNKNOWN; an old balance
    // is never represented as current after a failed refresh.
    cachedStatus = status;
    cachedAt = Date.now();
    return status;
  }).catch(() => {
    const status = unavailable("status_unavailable", null);
    cachedStatus = status;
    cachedAt = Date.now();
    return status;
  }).finally(() => { inFlight = null; });
  return inFlight;
}

export function formatFreebucksStatus(status) {
  const meter = status?.freebucks;
  const freshness = status?.cached ? `cached ${status.ageSeconds ?? 0}s` : "live";
  if (!meter?.available) {
    const reason = typeof status?.error === "string" ? status.error : "unknown";
    return `Freebucks left: unknown (${reason}) · next reset in unknown · ${freshness}`;
  }
  const amount = (value) => value == null ? "unknown" : String(value);
  const reset = meter.hoursUntilReset == null ? "unknown" : `~${meter.hoursUntilReset.toFixed(1)}h`;
  return `Freebucks left: ${amount(meter.balance)} (daily ${amount(meter.dailyRemaining)} + wallet ${amount(meter.walletBalance)}) · next reset in ${reset} (${meter.resetTimeZone ?? DEFAULT_TIME_ZONE}) · ${freshness}`;
}
