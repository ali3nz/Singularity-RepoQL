// lib/kit-paths.mjs — portable path + capability resolution for the exported harness.
//
// The engine is the single authority for run state; it must not be the authority
// for WHERE a host keeps its directories. Every path literal that used to name a
// fleet host (kit bind mount, workspace root, hub docs, RepoQL binary/cwd,
// OpenChamber chats + database, HA config) now resolves from ONE declarative
// table, `harness.config.json`, plus documented environment overrides.
//
// Contract (frozen by tests/harness-paths.test.mjs):
//   * nothing here throws: an unmapped or unavailable feature resolves to
//     null / { available: false } and callers degrade honestly;
//   * `toContainerPath` / `toHostPath` are the ONLY translation functions;
//     they are identity when a mapping entry has no host side;
//   * `runsDir` is the engine's own state root — never a caller-supplied
//     directory, so a portable-harness run id can never collide with another
//     harness's state.
import { existsSync, readFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

export const KIT_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");

// Minimal in-file defaults: the kit must still import cleanly when the harness
// config is absent (a bare `node harness/kit/orchestrate.mjs help` from a copy).
const DEFAULT_CONFIG = {
  schemaVersion: 1,
  profile: "portable-harness",
  mapping: { table: [] },
  features: {
    repoql: { enabled: false, bin: null, cwd: null, hostId: "portable-harness", scopes: { concepts: "concept:///**" } },
    openchamberWatch: { enabled: false, sshHost: null, chatsRoot: null, opencodeDb: null, haConfig: null },
    hubDocs: { dir: null },
  },
  rustAuthority: { mode: "dormant", protocolVersion: 1, binary: null, socket: null },
};

export function findHarnessConfig(startDir = KIT_ROOT) {
  const explicit = String(process.env.HARNESS_CONFIG ?? "").trim();
  if (explicit && existsSync(explicit)) return explicit;
  let dir = startDir;
  for (let depth = 0; depth < 6; depth++) {
    const candidate = join(dir, "harness.config.json");
    if (existsSync(candidate)) return candidate;
    const parent = dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return null;
}

function readConfig() {
  const path = findHarnessConfig();
  if (!path) return { path: null, config: DEFAULT_CONFIG };
  try {
    const parsed = JSON.parse(readFileSync(path, "utf8"));
    return { path, config: { ...DEFAULT_CONFIG, ...parsed } };
  } catch {
    return { path, config: DEFAULT_CONFIG };
  }
}

const LOADED = readConfig();
export const HARNESS_CONFIG_PATH = LOADED.path;
export const HARNESS_CONFIG = LOADED.config;

function hasBinary(name) {
  if (!/^[A-Za-z0-9._-]+$/.test(String(name ?? ""))) return false;
  try {
    const r = spawnSync("sh", ["-c", `command -v ${name}`], { encoding: "utf8", timeout: 4000 });
    return r.status === 0 && Boolean(String(r.stdout ?? "").trim());
  } catch {
    return false;
  }
}

function resolveEntry(entry, env) {
  const id = String(entry?.id ?? "");
  const container = typeof entry?.container === "string" ? entry.container : null;
  const fromEnv = entry?.hostEnv ? String(env[entry.hostEnv] ?? "").trim() : "";
  const host = fromEnv || (typeof entry?.hostDefault === "string" && entry.hostDefault.trim() ? entry.hostDefault.trim() : null);
  return { id, container, host, hostEnv: entry?.hostEnv ?? null };
}

/**
 * Resolve the harness path environment. Pure with respect to its inputs so the
 * tests can assert resolved values without touching the real machine.
 */
export function resolvePathEnvironment(env = process.env, config = HARNESS_CONFIG) {
  const table = Array.isArray(config?.mapping?.table) ? config.mapping.table : [];
  const entries = table.map((e) => resolveEntry(e, env));
  const byId = Object.fromEntries(entries.filter((e) => e.id).map((e) => [e.id, e]));
  const mapped = entries.filter((e) => e.host && e.container);

  const toContainerPath = (p) => {
    const s = String(p ?? "");
    for (const e of mapped) {
      if (s === e.host) return e.container;
      if (s.startsWith(e.host.endsWith("/") ? e.host : `${e.host}/`)) {
        return `${e.container.replace(/\/$/, "")}/${s.slice(e.host.replace(/\/$/, "").length + 1)}`;
      }
    }
    return s;
  };

  const toHostPath = (p) => {
    const s = String(p ?? "");
    for (const e of mapped) {
      if (s === e.container) return e.host;
      if (s.startsWith(`${e.container.replace(/\/$/, "")}/`)) {
        return `${e.host.replace(/\/$/, "")}/${s.slice(e.container.replace(/\/$/, "").length + 1)}`;
      }
    }
    return s;
  };

  const features = config?.features ?? {};
  const repoqlCfg = features.repoql ?? {};
  const watch = features.openchamberWatch ?? {};
  const consultFetch = features.consultFetch ?? {};
  const repoqlBin = String(env.REPOQL_BIN ?? repoqlCfg.bin ?? "").trim() || null;
  const repoqlCwd = String(env.REPOQL_CWD ?? repoqlCfg.cwd ?? "").trim() || null;

  const sshHost = String(watch.sshHost ?? "").trim() || null;
  const chatsRoot = String(watch.chatsRoot ?? "").trim() || null;
  const opencodeDb = String(watch.opencodeDb ?? "").trim() || null;
  const haConfig = String(watch.haConfig ?? "").trim() || null;
  // Optional read-only SSH host for --open files that are not present locally.
  // null = no remote fetch (the brief reports the file unreadable; never guesses a host).
  const consultFetchHost = String(env.CONSULT_FETCH_HOST ?? consultFetch.sshHost ?? "").trim() || null;
  const hasSsh = hasBinary("ssh");
  const hasPython = hasBinary("python3");
  const watchEnabled = watch.enabled === true && Boolean(sshHost && chatsRoot && opencodeDb);

  const externalState = String(env.ORCH_STATE_DIR ?? "").trim();

  return {
    configPath: HARNESS_CONFIG_PATH,
    config,
    kitRoot: KIT_ROOT,
    // The engine owns its state root: <kit home>/runs (orchestrate.mjs resolves it
    // from its own directory). ORCH_STATE_DIR belongs to a DIFFERENT harness lane
    // and is never read as this engine's state root — see validateStateDir().
    runsDir: join(KIT_ROOT, "runs"),
    externalStateDir: externalState || null,
    entries: byId,
    kitHostRoot: byId.kit?.host ?? null,
    workspaceHost: byId.workspace?.host ?? "",
    consultFetchHost,
    hubDocsDir: String(env.HARNESS_HOST_DOCS ?? "").trim() || byId.hubDocs?.host || String(features.hubDocs?.dir ?? "").trim() || null,
    toContainerPath,
    toHostPath,
    repoql: {
      enabled: repoqlCfg.enabled === true,
      bin: repoqlBin,
      cwd: repoqlCwd,
      hostId: String(env.REPOQL_HOST_ID ?? repoqlCfg.hostId ?? "portable-harness"),
      scopes: { ...(repoqlCfg.scopes ?? {}) },
    },
    repoqlCwdCandidate: repoqlCwd,
    parityScopes: { ...(repoqlCfg.scopes ?? {}) },
    /** Command that answers "is the RepoQL host reachable", or null when the harness has no configured path to it. */
    repoqlStatusProbe() {
      if (!repoqlBin) return null;
      const exists = isAbsolute(repoqlBin) ? existsSync(repoqlBin) : hasBinary(repoqlBin);
      if (!exists) return null;
      return { cmd: repoqlBin, args: ["host", "status"], cwd: repoqlCwd ?? undefined };
    },
    openchamber: {
      enabled: watch.enabled === true,
      available: watchEnabled && hasSsh && hasPython,
      sshHost,
      chatsRoot,
      opencodeDb,
      haConfig,
      unavailableReason: !watch.enabled
        ? "openchamber-watch is not configured for this harness"
        : !sshHost || !chatsRoot || !opencodeDb
          ? "OpenChamber mapping incomplete (sshHost/chatsRoot/opencodeDb)"
          : !hasSsh
            ? "ssh client not found on this host"
            : !hasPython
              ? "python3 not found on this host"
              : null,
    },
    capabilities: { ssh: hasSsh, python3: hasPython, rql: Boolean(repoqlBin && hasBinary(repoqlBin)) },
    /**
     * The engine owns <kit home>/runs. A caller-supplied ORCH_STATE_DIR is a
     * separate harness lane's state root: it must exist outside this engine home
     * so the two lanes can never share a run id.
     */
    validateStateDir(dir = externalState) {
      const target = String(dir ?? "").trim();
      if (!target) return { ok: true };
      const abs = resolve(target);
      const kit = resolve(KIT_ROOT);
      if (abs === kit || abs.startsWith(`${kit}/`)) {
        return { ok: false, code: "STATE_DIR_INSIDE_KIT", detail: `ORCH_STATE_DIR ${abs} is inside the engine home ${kit}; run ids from different harnesses must not overlap` };
      }
      return { ok: true };
    },
  };
}

export const HARNESS_PATHS = resolvePathEnvironment();

/** Container->host translation used by the consult/attach path normalisation. */
export function toContainerPath(p) {
  return HARNESS_PATHS.toContainerPath(p);
}

/** Host->container translation used by the session-consult pointer writer. */
export function toHostPath(p, { kitRoot = KIT_ROOT, hostRoot = HARNESS_PATHS.kitHostRoot } = {}) {
  if (!hostRoot) return String(p ?? "");
  const s = String(p ?? "");
  if (s === kitRoot) return hostRoot;
  if (s.startsWith(`${kitRoot}/`)) return join(hostRoot, s.slice(kitRoot.length + 1));
  return s;
}
