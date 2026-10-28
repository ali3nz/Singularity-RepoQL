// win-platform.mjs — native-Windows platform facts for the portable installer,
// hooks and launchers.
//
// Why this module exists: the product was written for POSIX (HOME, `which`,
// 0600 mode bits, `/`-relative containment checks). On native Windows those
// assumptions are not merely cosmetic — `HOME` is usually unset, `claude` is an
// `.exe` under %USERPROFILE%\.local\bin, the Desktop app bundles its own
// claude-code under %LOCALAPPDATA%\Claude-Data, and POSIX mode bits do not
// exist. Every rule here is a pure function of (platform, env, probes) so the
// SAME code is unit-testable on Linux and on Windows.
//
// Nothing in this module claims enforcement it cannot prove: POSIX mode bits
// are verified, NTFS ACLs are reported as UNENFORCED with the reason, and the
// installer wiring (docs/native-windows-wiring.patch) is where `icacls` checks
// would be added.
import { chmodSync, existsSync, readdirSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { posix as posixPath, win32 as winPath } from "node:path";

export const CLAUDE_DIRNAME = ".claude";
export const NODE_EXE_DEFAULT = "node.exe";

/** True when `platform` is native Windows (the only platform we branch for). */
export function isWindowsPlatform(platform = process.platform) {
  return String(platform) === "win32";
}

function pathFor(platform) {
  return isWindowsPlatform(platform) ? winPath : posixPath;
}

function normalizeFor(platform, p) {
  const impl = pathFor(platform);
  return isWindowsPlatform(platform) ? impl.normalize(String(p)) : impl.resolve(String(p));
}

function joinFor(platform, ...parts) {
  return pathFor(platform).join(...parts.filter((p) => p !== undefined && p !== null && p !== ""));
}

/**
 * Resolve the user's home directory for this platform.
 *
 * Windows: USERPROFILE first (PowerShell usually leaves HOME unset), then HOME,
 * then the OS account's home. POSIX: HOME first, then USERPROFILE, then the OS
 * home. Throws rather than silently returning "" — callers must not invent
 * `/root/.claude` or `C:\Windows\System32\.claude`.
 */
export function resolveHome({ env = process.env, platform = process.platform, fallbackHome } = {}) {
  const userProfile = String(env.USERPROFILE ?? "").trim();
  const homeEnv = String(env.HOME ?? "").trim();
  const order = isWindowsPlatform(platform) ? [userProfile, homeEnv] : [homeEnv, userProfile];
  for (const candidate of order) {
    if (candidate) return normalizeFor(platform, candidate);
  }
  const fallback = String(fallbackHome ?? homedir() ?? "").trim();
  if (fallback) return normalizeFor(platform, fallback);
  throw new Error("cannot resolve a home directory: neither USERPROFILE nor HOME is set");
}

/** The Claude Code configuration root: `<home>/.claude` on every platform. */
export function claudeConfigDir({ home, platform = process.platform } = {}) {
  const base = home || resolveHome({ platform });
  return joinFor(platform, base, CLAUDE_DIRNAME);
}

/** Split a PATH value with the platform's real separator (':' vs ';'). */
export function splitPathValue(value, platform = process.platform) {
  const sep = isWindowsPlatform(platform) ? ";" : ":";
  return String(value ?? "").split(sep).map((p) => p.trim()).filter(Boolean);
}

/**
 * Candidate locations for the Claude Code executable, in priority order.
 * Pure: no filesystem access, so tests can assert the ordering on any host.
 *
 * Kinds:
 *   env-override      CLAUDE_CODE_PATH / CLAUDE_PATH (operator's explicit choice)
 *   path              a `claude` executable on PATH
 *   user-local-bin    %USERPROFILE%\.local\bin\claude.exe (the standalone CLI)
 *   desktop-bundled   %LOCALAPPDATA%\Claude-Data (the Desktop app's own payload)
 */
export function claudeExecutableCandidates({ env = process.env, platform = process.platform, home, localAppData } = {}) {
  const win = isWindowsPlatform(platform);
  const out = [];
  for (const key of ["CLAUDE_CODE_PATH", "CLAUDE_PATH"]) {
    const value = String(env[key] ?? "").trim();
    if (value) out.push({ path: normalizeFor(platform, value), kind: "env-override", source: key });
  }
  const pathValue = env.PATH ?? env.Path ?? env.path ?? "";
  for (const dir of splitPathValue(pathValue, platform)) {
    if (win) {
      out.push({ path: joinFor(platform, dir, "claude.exe"), kind: "path", source: "PATH" });
      out.push({ path: joinFor(platform, dir, "claude.cmd"), kind: "path", source: "PATH" });
    } else {
      out.push({ path: joinFor(platform, dir, "claude"), kind: "path", source: "PATH" });
    }
  }
  const resolvedHome = home || resolveHome({ env, platform });
  out.push({
    path: win ? joinFor(platform, resolvedHome, ".local", "bin", "claude.exe") : joinFor(platform, resolvedHome, ".local", "bin", "claude"),
    kind: "user-local-bin",
    source: win ? "USERPROFILE\\.local\\bin" : "~/.local/bin",
  });
  const appData = localAppData ?? env.LOCALAPPDATA;
  if (win && appData) {
    out.push({ path: joinFor(platform, appData, "Claude-Data"), kind: "desktop-bundled", source: "LOCALAPPDATA\\Claude-Data" });
  }
  return out;
}

function safeReaddir(dir, readdir) {
  try {
    return readdir(dir, { withFileTypes: true });
  } catch {
    return [];
  }
}

function direntName(entry) {
  return typeof entry === "string" ? entry : String(entry?.name ?? "");
}

function compareVersionsDesc(a, b) {
  const pa = String(a).split(/[.-]/).map((x) => Number.parseInt(x, 10) || 0);
  const pb = String(b).split(/[.-]/).map((x) => Number.parseInt(x, 10) || 0);
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const d = (pb[i] || 0) - (pa[i] || 0);
    if (d) return d;
  }
  return String(b).localeCompare(String(a));
}

/**
 * Scan the Desktop app's data directory for its bundled claude-code payload:
 *   %LOCALAPPDATA%\Claude-Data\claude_<id>\claude-code\<version>\<hash>\claude.exe
 * Newest version wins, so a Desktop update is picked up without a config change.
 */
export function findBundledDesktopClaude({ dataDir, platform = process.platform, exists = existsSync, readdir = readdirSync } = {}) {
  if (!dataDir) return null;
  const dirs = safeReaddir(dataDir, readdir).filter((e) => direntName(e).startsWith("claude")).map(direntName);
  for (const id of dirs.sort()) {
    const codeRoot = joinFor(platform, dataDir, id, "claude-code");
    const versions = safeReaddir(codeRoot, readdir).map(direntName).sort(compareVersionsDesc);
    for (const version of versions) {
      const versionDir = joinFor(platform, codeRoot, version);
      const hashes = safeReaddir(versionDir, readdir).map(direntName).sort();
      for (const hash of hashes) {
        const exe = joinFor(platform, versionDir, hash, "claude.exe");
        if (exists(exe)) return { path: exe, kind: "desktop-bundled", version, appId: id };
      }
    }
  }
  return null;
}

/**
 * Find a runnable Claude Code executable.
 * Returns `{ path, kind, source?, version? }` or null. `null` is the honest
 * answer; callers must not fall back to a bare `claude` that may not exist.
 */
export function findClaudeExecutable({
  env = process.env,
  platform = process.platform,
  home,
  localAppData,
  exists = existsSync,
  readdir = readdirSync,
} = {}) {
  for (const candidate of claudeExecutableCandidates({ env, platform, home, localAppData })) {
    if (candidate.kind === "desktop-bundled" && isWindowsPlatform(platform)) {
      const bundled = findBundledDesktopClaude({ dataDir: candidate.path, platform, exists, readdir });
      if (bundled) return bundled;
      continue;
    }
    if (exists(candidate.path)) return candidate;
  }
  return null;
}

/** Locate an `rql` binary the same way (PATH, then the documented install dir). */
export function findRqlExecutable({ env = process.env, platform = process.platform, home, exists = existsSync } = {}) {
  const win = isWindowsPlatform(platform);
  const names = win ? ["rql.exe", "rql.cmd"] : ["rql"];
  for (const dir of splitPathValue(env.PATH ?? env.Path ?? "", platform)) {
    for (const name of names) {
      const candidate = joinFor(platform, dir, name);
      if (exists(candidate)) return { path: candidate, kind: "path" };
    }
  }
  const resolvedHome = home || resolveHome({ env, platform });
  const local = win
    ? joinFor(platform, env.LOCALAPPDATA || resolvedHome, "Singularity", "bin", "rql.exe")
    : joinFor(platform, resolvedHome, ".local", "bin", "rql");
  if (exists(local)) return { path: local, kind: "install-dir" };
  return null;
}

/**
 * Verify that a credential-bearing file is actually protected.
 *
 * POSIX: apply 0600 and prove it with stat. Windows: mode bits do not exist, so
 * this returns enforced:false / verified:false with the ACTIONABLE reason — the
 * old installer returned `{ enforced: true, mode: "n/a (windows)" }`, which
 * claimed protection it had never checked. NTFS ACL verification (icacls) lives
 * in the installer wiring, not here.
 */
export function verifySecretFilePermissions(path, { platform = process.platform, chmod, stat } = {}) {
  if (isWindowsPlatform(platform)) {
    return {
      enforced: false,
      verified: false,
      mode: "windows-acl-unverified",
      reason: `POSIX mode bits do not exist on Windows; NTFS ACLs for ${path} are not verified by this helper (the installer wiring must run icacls)`,
    };
  }
  const chmodImpl = chmod || chmodSync;
  const statImpl = stat || statSync;
  let enforced = false;
  try {
    chmodImpl(path, 0o600);
    enforced = true;
  } catch {
    /* fall through to verification */
  }
  try {
    const ok = (statImpl(path).mode & 0o777) === 0o600;
    return { enforced: enforced && ok, verified: ok, mode: ok ? "0600" : "mismatch" };
  } catch {
    return { enforced, verified: false, mode: "unverified" };
  }
}

/**
 * Containment by path arithmetic, never by string prefix.
 *
 * `child.startsWith(`${parent}/`)` is wrong twice: it misses `\` separators
 * (Windows) and it matches siblings such as `/opt/app-evil` for parent
 * `/opt/app`. path.relative answers the real question on the target platform.
 */
export function isPathInside(parent, child, { platform = process.platform } = {}) {
  if (!parent || !child) return false;
  const impl = pathFor(platform);
  const win = isWindowsPlatform(platform);
  let p = normalizeFor(platform, parent);
  let c = normalizeFor(platform, child);
  if (win) {
    // Same rule Windows itself applies: case-insensitive, and a trailing
    // separator must not change the answer.
    p = p.replace(/[\\/]+$/, "").toLowerCase();
    c = c.replace(/[\\/]+$/, "").toLowerCase();
  }
  let rel = impl.relative(p, c);
  if (win) rel = rel.toLowerCase();
  if (rel === "") return false; // the root itself is not "inside" itself
  if (impl.isAbsolute(rel)) return false;
  return !(rel === ".." || rel.startsWith(`..${impl.sep}`) || rel.startsWith("../"));
}

/**
 * Template for a Windows launcher beside `bin/ai-orchestra`.
 *
 * Claude Code and PowerShell users get no shebang, no `node` on PATH, and no
 * POSIX shell; a `.cmd` that forwards to an absolute node keeps the engine's
 * argv contract untouched (`%*` is passed through verbatim).
 */
export function windowsCmdLauncher({ nodeExe = NODE_EXE_DEFAULT, entryRelative = "ai-orchestra", label = "ai-orchestra" } = {}) {
  return [
    "@echo off",
    "setlocal",
    `rem ${label} — Windows launcher. Runs the same engine with the caller's arguments.`,
    `rem node: ${nodeExe}`,
    `"${nodeExe}" "%~dp0${entryRelative}" %*`,
    "exit /b %ERRORLEVEL%",
    "",
  ].join("\r\n");
}
