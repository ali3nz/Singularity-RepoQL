// lib/memory-orchestra/client-l23.mjs — MemOS gap-closure addendum
// (2026-10-23) directive §4. L2 (scenario files) and L3 (core persona) READ
// capability.
//
// Two backends, selected by ORCH_MC_L23_BACKEND (default "routes" = adapter OFF):
//   "routes"   — POST the panel/data-plane candidate routes (:8125). This is the
//                original behaviour and stays the fallback (Sol 2026-10-24: C is
//                retained until the artifact backend is proven).
//   "artifact" — read the MemoryCore-generated Markdown artifacts directly.
//   "auto"     — try routes first; only a typed L2L3_ROUTE_NOT_SUPPORTED falls
//                back to the artifact backend.
//
// Artifact backend (Sol design ruling 2026-10-24, consult
// 2026-10-23T21-16-32-857-79355 — "CONFIRMED / conditional approval for B"):
// the deployed MemoryCore v2.0.2 generates L2 scene blocks and an L3 persona but
// exposes NO retrieval route for them (checked against the running panel bundle
// and the core gateway route table). The generated files are plain Markdown in
// the profile tree; reading them is NOT a storage write and NOT a private SQL
// connection, which is exactly what addendum §6 forbids. Conditions carried
// from the ruling:
//   * read-only, bounded, scope-mapped from validated team/agent identity;
//   * traversal / encoded components / symlinks / non-regular files rejected;
//   * provenance (mtime, sha256 of the bytes read, retrievedAt) on every result;
//   * freshness is UNVERIFIED unless a deployment age policy is configured —
//     an mtime is not proof that MemoryCore re-evaluated the underlying facts;
//   * authority is ADVISORY: artifact content is untrusted retrieved data, it
//     never overrides source documents, operator instructions or live facts;
//   * labelled source "memorycore-generated-artifact", never a vendor API
//     response, and the layout is documented as an unsupported dependency.
//
// L2 WRITE (scenarioWrite) is additionally gated by the l23Write flag and is
// intended for cross-run durable policy/quarantine state owned by the
// induction pipeline (P4) — never for raw transcript writes. The artifact
// backend is READ-ONLY: writes always go through the route path.

import { readFileSync, readdirSync, lstatSync } from "node:fs";
import { createHash } from "node:crypto";
import { join, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { flags, enabledWhen, PENDING_VALIDATION } from "./flags.mjs";

const HUB_BASE = process.env.MEMORYCORE_HUB_URL ?? "http://127.0.0.1:8125";
const KEY_FILE = process.env.MEMORYCORE_KEY_FILE ?? "/opt/harness-unset/tencent-memory-hub/.agents-read-key";
const SERVICE_ID = process.env.MEMORYCORE_SERVICE_ID ?? "default";
const DEFAULT_TIMEOUT_MS = positiveInt(process.env.MEMORYCORE_TIMEOUT_MS, 6000);
function positiveInt(v, d) {
  const n = Number(v);
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : d;
}

// Candidate route sets, tried in order. Each carries the app-path we believe
// the panel/data-plane exposes; an order that 404s everywhere yields the typed
// NOT_SUPPORTED verdict rather than a guess (this is the PENDING_VALIDATION
// boundary the operator validation directive will exercise).
const L2_READ_ROUTES = [
  { path: "/api/v1/scenario/read", bodyStyle: "reader" },
  { path: "/api/v1/scenario/ls", bodyStyle: "reader" }, // list-first fallback (names)
];
const L2_WRITE_ROUTES = [{ path: "/api/v1/scenario/write", bodyStyle: "writer" }];
const L3_READ_ROUTES = [{ path: "/api/v1/core/read", bodyStyle: "reader" }];

// Artifact backend configuration. The profile tree is a bind mount of the
// memorycore volume (/data/tdai-memory); reading the generated Markdown from it
// needs no elevated privileges and no container access.
const PROFILES_DIR = process.env.ORCH_MC_PROFILES_DIR
  ?? "/opt/harness-unset/tencent-memory/data/profiles";
const ARTIFACT_BACKEND_STATUS = "ACTIVE_ARTIFACT_BACKEND";
const ARTIFACT_SOURCE = "memorycore-generated-artifact";
const ARTIFACT_MAX_BYTES = positiveInt(process.env.ORCH_MC_L23_MAX_BYTES, 24000);
const ARTIFACT_MAX_AGE_HOURS = (() => {
  const n = Number(process.env.ORCH_MC_L23_MAX_AGE_HOURS);
  return Number.isFinite(n) && n > 0 ? n : null;
})();
// Scope components are used to build a directory name, so they are whitelisted
// (no separators, no '%' that could re-encode a separator, no dots-only names).
const SCOPE_PART = /^[A-Za-z0-9_-]{1,64}$/;
const SCENE_FILE = /^[A-Za-z0-9][A-Za-z0-9._ -]{0,117}\.md$/;

// Backend selection: env wins, then the kit config's memoryOrchestra.l23Backend
// (so activation is a one-key config edit with a one-key rollback, the same
// discipline as the flags), then the safe default "routes".
let CONFIG_BACKEND = null;
function configBackend() {
  if (CONFIG_BACKEND !== null) return CONFIG_BACKEND;
  try {
    const p = fileURLToPath(new URL("../../config.json", import.meta.url));
    const j = JSON.parse(readFileSync(p, "utf8"));
    const v = String(j?.memoryOrchestra?.l23Backend ?? "").trim().toLowerCase();
    CONFIG_BACKEND = v === "artifact" || v === "auto" ? v : "";
  } catch { CONFIG_BACKEND = ""; }
  return CONFIG_BACKEND;
}

function backendMode() {
  const env = String(process.env.ORCH_MC_L23_BACKEND ?? "").trim().toLowerCase();
  if (env === "artifact" || env === "auto" || env === "routes") return env;
  return configBackend() || "routes";
}

function readKey() {
  const t = readFileSync(KEY_FILE, "utf8").trim();
  const last = t.split(/\r?\n/).pop().trim();
  if (!last) throw new Error("empty key file");
  return last;
}

// Scope directory: MemoryCore's own encoding (team%3A<team>%7Cagent%3A<agent>).
export function artifactScopeDir(scope, profilesDir = PROFILES_DIR) {
  for (const k of ["team", "agent"]) {
    if (!scope || typeof scope[k] !== "string" || !SCOPE_PART.test(scope[k])) {
      return { ok: false, code: k === "team" ? "SCOPE_TEAM_REQUIRED" : "SCOPE_AGENT_REQUIRED" };
    }
  }
  return { ok: true, dir: join(profilesDir, `team%3A${scope.team}%7Cagent%3A${scope.agent}`) };
}

// Read one artifact: containment, regular-file (no symlink), size bound, digest.
function readArtifact(dir, relPath, { maxBytes = ARTIFACT_MAX_BYTES, now = Date.now(), maxAgeHours = ARTIFACT_MAX_AGE_HOURS } = {}) {
  const root = resolve(dir);
  const abs = resolve(root, relPath);
  if (abs !== root && !abs.startsWith(root + sep)) return { ok: false, code: "ARTIFACT_INVALID", detail: "path escapes the scope directory" };
  let st;
  try { st = lstatSync(abs); } catch { return { ok: false, code: "ARTIFACT_ABSENT" }; }
  if (st.isSymbolicLink()) return { ok: false, code: "ARTIFACT_INVALID", detail: "symlink refused" };
  if (!st.isFile()) return { ok: false, code: "ARTIFACT_INVALID", detail: "not a regular file" };
  if (st.size > maxBytes) return { ok: false, code: "ARTIFACT_INVALID", detail: `oversized (${st.size} > ${maxBytes})` };
  if (maxAgeHours && now - st.mtimeMs > maxAgeHours * 3600_000) {
    return { ok: false, code: "ARTIFACT_STALE", detail: `mtime older than ${maxAgeHours}h` };
  }
  let buf;
  try { buf = readFileSync(abs); } catch (e) {
    return { ok: false, code: (e?.code === "EACCES" || e?.code === "EPERM") ? "ADAPTER_UNAVAILABLE" : "ARTIFACT_INVALID", detail: String(e?.code ?? "").slice(0, 40) };
  }
  // Re-check the size on the bytes actually read (concurrent replacement).
  if (buf.length > maxBytes) return { ok: false, code: "ARTIFACT_INVALID", detail: `oversized after read (${buf.length} > ${maxBytes})` };
  return {
    ok: true,
    content: buf.toString("utf8"),
    bytes: buf.length,
    provenance: {
      mtime: new Date(st.mtimeMs).toISOString(),
      sha256: createHash("sha256").update(buf).digest("hex"),
      retrievedAt: new Date(now).toISOString(),
      bytes: buf.length,
    },
    freshness: "UNVERIFIED",
  };
}

function artifactEnvelope({ tier, scope, file, read }) {
  return {
    ok: true,
    code: "OK",
    status: ARTIFACT_BACKEND_STATUS,
    tier,
    source: ARTIFACT_SOURCE,
    backend: "memorycore_artifact_readonly",
    authority: "ADVISORY",
    scope: { team: scope.team, agent: scope.agent },
    file,
    content: read.content,
    freshness: read.freshness,
    provenance: read.provenance,
    note: "read-only MemoryCore artifact (undocumented v2.0.2 layout); advisory context only",
  };
}

export function createMemorycoreL23Client(opts = {}) {
  const postImpl = typeof opts.post === "function" ? opts.post : null;
  const profilesDir = opts.profilesDir ?? PROFILES_DIR;
  const now = typeof opts.now === "function" ? opts.now : () => Date.now();
  const maxAgeHours = opts.maxAgeHours === undefined ? ARTIFACT_MAX_AGE_HOURS : opts.maxAgeHours;
  const maxBytes = opts.maxBytes ?? ARTIFACT_MAX_BYTES;
  const mode = opts.backend ?? backendMode();

  async function post(path, body) {
    if (postImpl) return postImpl(path, body);
    const ctl = new AbortController();
    const timer = setTimeout(() => ctl.abort(), DEFAULT_TIMEOUT_MS);
    try {
      const res = await fetch(HUB_BASE + path, {
        method: "POST",
        headers: { "Content-Type": "application/json", "x-tdai-user-key": readKey(), "x-tdai-service-id": SERVICE_ID },
        body: JSON.stringify(body),
        signal: ctl.signal,
      });
      let json = null;
      try {
        json = await res.json();
      } catch {
        json = null;
      }
      return { status: res.status, json };
    } catch (err) {
      const reason = String(err?.cause?.code ?? err?.name ?? err).slice(0, 40);
      return { status: 0, json: null, netReason: reason };
    } finally {
      clearTimeout(timer);
    }
  }

  function scopeGuard(scope) {
    if (!scope || typeof scope !== "object") return { ok: false, code: "SCOPE_REQUIRED" };
    if (!scope.team) return { ok: false, code: "SCOPE_TEAM_REQUIRED" };
    if (!scope.agent) return { ok: false, code: "SCOPE_AGENT_REQUIRED" };
    if (!scope.user) return { ok: false, code: "SCOPE_USER_REQUIRED" };
    return { ok: true };
  }

  async function tryRoutes(routes, body) {
    for (const r of routes) {
      const res = await post(r.path, body);
      if (res.netReason) return { ok: false, code: `NETWORK:${res.netReason}`, http: 0 };
      if (res.status === 404) continue; // route absent in this panel build
      if (res.status === 401 || res.status === 403) return { ok: false, code: "AUTH_FAILED", http: res.status };
      // Non-2xx is a typed failure — reject unsuccessful HTTP statuses (Sol
      // close-out HOLD-4: previously any status with a JSON envelope slipped
      // through as success).
      if (res.status < 200 || res.status >= 300) return { ok: false, code: "REQUEST_FAILED", http: res.status };
      if (res.json == null || typeof res.json !== "object") return { ok: false, code: "PARSE_FAILED", http: res.status };
      if (typeof res.json.code === "number" && res.json.code !== 0) {
        // Unknown-route encoded as non-zero code: still typed failure, never fabricated.
        return { ok: false, code: `CORE:${res.json.code}`, http: res.status };
      }
      return { ok: true, http: res.status, json: res.json, route: r.path };
    }
    return { ok: false, code: "L2L3_ROUTE_NOT_SUPPORTED", pendingValidation: PENDING_VALIDATION, http: 404 };
  }

  function normalizedItem(it) {
    return {
      id: String(it?.id ?? it?.name ?? ""),
      title: String(it?.title ?? it?.name ?? "").slice(0, 200),
      body: String(it?.content ?? it?.body ?? ""),
      tags: Array.isArray(it?.tags) ? it.tags : [],
      updated_at: it?.updated_at ?? it?.updated_at_ms ?? null,
      version: Number.isFinite(Number(it?.version)) ? Number(it.version) : null,
      scope: { team: it?.team_id ?? null, agent: it?.agent_id ?? null, user: it?.user_id ?? null },
    };
  }

  // --- artifact backend (read-only) -----------------------------------------
  function artifactScenarioList({ scope, limit = 50 } = {}) {
    const sd = artifactScopeDir(scope, profilesDir);
    if (!sd.ok) return sd;
    const dir = join(sd.dir, "scene_blocks");
    let names = [];
    try { names = readdirSync(dir).filter((n) => SCENE_FILE.test(n)).sort(); } catch { return { ok: false, code: "ARTIFACT_ABSENT" }; }
    const files = names.slice(0, positiveInt(limit, 50)).map((n) => {
      try {
        const st = lstatSync(join(dir, n));
        return { name: n, size: st.size, updated_at: new Date(st.mtimeMs).toISOString() };
      } catch { return { name: n, size: null, updated_at: null }; }
    });
    return {
      ok: true, code: "OK", status: ARTIFACT_BACKEND_STATUS, tier: "L2",
      source: ARTIFACT_SOURCE, backend: "memorycore_artifact_readonly", authority: "ADVISORY",
      scope: { team: scope.team, agent: scope.agent }, files, freshness: "UNVERIFIED",
      provenance: { retrievedAt: new Date(now()).toISOString() },
    };
  }

  function artifactScenarioRead({ scope, file } = {}) {
    const sd = artifactScopeDir(scope, profilesDir);
    if (!sd.ok) return sd;
    if (!file) return { ok: false, code: "SCENARIO_FILE_REQUIRED" };
    const name = String(file);
    if (name.includes("/") || name.includes("\\") || name.includes("..") || !SCENE_FILE.test(name)) {
      return { ok: false, code: "ARTIFACT_INVALID", detail: "unsafe scene name" };
    }
    const read = readArtifact(join(sd.dir, "scene_blocks"), name, { maxBytes, now: now(), maxAgeHours });
    if (!read.ok) return read;
    return artifactEnvelope({ tier: "L2", scope, file: name, read });
  }

  function artifactCoreRead({ scope } = {}) {
    const sd = artifactScopeDir(scope, profilesDir);
    if (!sd.ok) return sd;
    const read = readArtifact(sd.dir, "persona.md", { maxBytes, now: now(), maxAgeHours });
    if (!read.ok) return read;
    const env = artifactEnvelope({ tier: "L3", scope, file: "persona.md", read });
    env.profile = [{
      id: "persona", title: "persona.md", body: read.content,
      tags: [], updated_at: read.provenance.mtime, version: null,
      scope: { team: scope.team, agent: scope.agent, user: null },
    }];
    return env;
  }

  // Route attempt first (unless the artifact backend is forced); the artifact
  // backend is only a fallback for the TYPED "route absent" verdict.
  async function routeThenArtifact(routesFn, artifactFn, forced) {
    if (forced) return artifactFn();
    const r = await routesFn();
    if (mode === "auto" && !r.ok && r.code === "L2L3_ROUTE_NOT_SUPPORTED") return artifactFn();
    if (mode === "routes" && !r.ok && r.code === "L2L3_ROUTE_NOT_SUPPORTED" && opts.artifactFallbackWhenRoutesAbsent) return artifactFn();
    return r;
  }

  // --- L2 scenario ------------------------------------------------------------
  async function scenarioList({ scope, session = null, limit = 50 } = {}) {
    const g = scopeGuard(scope);
    if (!g.ok) return g;
    const gate = enabledWhen(flags(), "l23Read");
    if (!gate.ok) return { ok: false, code: gate.code, status: gate.status };
    return routeThenArtifact(
      async () => {
        const r = await tryRoutes(L2_READ_ROUTES, { team_id: scope.team, agent_id: scope.agent, user_id: scope.user, session_id: session ?? undefined, pagination: { limit: positiveInt(limit, 50) } });
        if (!r.ok) return r;
        const raw = r.json?.data?.items ?? r.json?.data ?? [];
        if (!Array.isArray(raw)) return { ok: false, code: "SCENARIO_SCHEMA_INVALID", http: r.http };
        return { ok: true, route: r.route, files: raw.slice(0, positiveInt(limit, 50)).map((x) => ({ name: String(x?.name ?? x), size: Number(x?.size) || null, updated_at: x?.updated_at ?? null })) };
      },
      () => artifactScenarioList({ scope, limit }),
      mode === "artifact",
    );
  }

  async function scenarioRead({ scope, file, session = null } = {}) {
    const g = scopeGuard(scope);
    if (!g.ok) return g;
    const gate = enabledWhen(flags(), "l23Read");
    if (!gate.ok) return { ok: false, code: gate.code, status: gate.status };
    if (!file) return { ok: false, code: "SCENARIO_FILE_REQUIRED" };
    return routeThenArtifact(
      async () => {
        const routes = [
          { path: "/api/v1/scenario/read", bodyStyle: "reader" },
          { path: "/api/v1/scenario/get", bodyStyle: "reader" },
        ];
        const r = await tryRoutes(routes, { team_id: scope.team, agent_id: scope.agent, user_id: scope.user, session_id: session ?? undefined, name: String(file).slice(0, 200) });
        if (!r.ok) return r;
        const content = r.json?.data?.content ?? r.json?.data?.body;
        if (typeof content !== "string") return { ok: false, code: "SCENARIO_SCHEMA_INVALID", http: r.http };
        return { ok: true, route: r.route, file: String(file), content };
      },
      () => artifactScenarioRead({ scope, file }),
      mode === "artifact",
    );
  }

  async function scenarioWrite({ scope, file, content, session = null } = {}) {
    const g = scopeGuard(scope);
    if (!g.ok) return g;
    const gate = enabledWhen(flags(), "l23Write");
    if (!gate.ok) return { ok: false, code: gate.code, status: gate.status };
    if (!file || typeof content !== "string") return { ok: false, code: "SCENARIO_WRITE_FIELDS_REQUIRED" };
    // Bounded write: addendum cap (induction pipeline owns durable artifacts;
    // raw callers should not exceed planned scenario budgets). The artifact
    // backend is READ-ONLY, so writes always use the route path.
    if (Buffer.byteLength(content, "utf8") > 16000) return { ok: false, code: "SCENARIO_WRITE_TOO_LARGE" };
    const r = await tryRoutes(L2_WRITE_ROUTES, { team_id: scope.team, agent_id: scope.agent, user_id: scope.user, session_id: session ?? undefined, name: String(file).slice(0, 200), content });
    if (!r.ok) return r;
    return { ok: true, route: r.route, file: String(file), version: Number(r.json?.data?.version) || null };
  }

  // --- L3 core persona (READ-ONLY; profile edits are NOT this module's job) ----
  async function coreRead({ scope, session = null } = {}) {
    const g = scopeGuard(scope);
    if (!g.ok) return g;
    const gate = enabledWhen(flags(), "l23Read");
    if (!gate.ok) return { ok: false, code: gate.code, status: gate.status };
    return routeThenArtifact(
      async () => {
        const r = await tryRoutes(L3_READ_ROUTES, { team_id: scope.team, agent_id: scope.agent, user_id: scope.user, session_id: session ?? undefined });
        if (!r.ok) return r;
        const raw = r.json?.data?.items ?? r.json?.data?.profile;
        // Invalid schema is a typed failure, never a silently-empty success
        // (Sol close-out HOLD-4: an empty profile must not masquerade as data).
        if (!Array.isArray(raw)) return { ok: false, code: "L3_SCHEMA_INVALID", http: r.http };
        const items = raw.map(normalizedItem);
        return { ok: true, route: r.route, profile: items };
      },
      () => artifactCoreRead({ scope }),
      mode === "artifact",
    );
  }

  return { mode: "l23", backend: mode, scenarioList, scenarioRead, scenarioWrite, coreRead };
}
