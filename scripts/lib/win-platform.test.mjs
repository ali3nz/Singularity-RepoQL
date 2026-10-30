import test from "node:test";
import assert from "node:assert/strict";
import {
  claudeConfigDir,
  claudeExecutableCandidates,
  findBundledDesktopClaude,
  findClaudeExecutable,
  findRqlExecutable,
  isPathInside,
  isWindowsPlatform,
  resolveHome,
  splitPathValue,
  verifySecretFilePermissions,
  windowsCmdLauncher,
} from "./win-platform.mjs";

const WIN_HOME = "C:\\Users\\example";
const winEnv = { USERPROFILE: WIN_HOME, PATH: "C:\\Windows\\System32;C:\\Program Files\\Git\\cmd" };

test("resolveHome prefers USERPROFILE on Windows and HOME on POSIX", () => {
  assert.equal(resolveHome({ env: winEnv, platform: "win32" }), WIN_HOME);
  assert.equal(resolveHome({ env: { HOME: "/home/user" }, platform: "linux" }), "/home/user");
  assert.equal(resolveHome({ env: { HOME: "/home/user" }, platform: "darwin" }), "/home/user");
  assert.equal(
    resolveHome({ env: { USERPROFILE: WIN_HOME, HOME: "/mnt/c/Users/example" }, platform: "win32" }),
    WIN_HOME,
    "HOME is an emulation artefact on native Windows; it must not win",
  );
  assert.throws(() => resolveHome({ env: {}, platform: "win32", fallbackHome: "" }), /cannot resolve a home/);
});

test("claudeConfigDir is <home>\\.claude on Windows, never a POSIX path", () => {
  assert.equal(claudeConfigDir({ home: WIN_HOME, platform: "win32" }), "C:\\Users\\example\\.claude");
  assert.equal(claudeConfigDir({ home: "/home/user", platform: "linux" }), "/home/user/.claude");
});

test("PATH splitting uses the platform separator (; on Windows)", () => {
  assert.deepEqual(splitPathValue("C:\\a;C:\\b", "win32"), ["C:\\a", "C:\\b"]);
  assert.deepEqual(splitPathValue("/usr/bin:/bin", "linux"), ["/usr/bin", "/bin"]);
  assert.deepEqual(splitPathValue("/usr/bin:C:\\b", "win32"), ["/usr/bin:C:\\b"]);
});

test("claude candidates are ordered: env override, PATH, user-local-bin, desktop data", () => {
  const candidates = claudeExecutableCandidates({
    env: { ...winEnv, CLAUDE_CODE_PATH: "D:\\tools\\claude.exe", LOCALAPPDATA: "C:\\Users\\example\\AppData\\Local" },
    platform: "win32",
    home: WIN_HOME,
  });
  const kinds = candidates.map((c) => c.kind);
  assert.equal(candidates[0].kind, "env-override");
  assert.equal(candidates[0].path, "D:\\tools\\claude.exe");
  assert.equal(kinds.includes("path"), true);
  assert.deepEqual(candidates.find((c) => c.kind === "user-local-bin"), {
    path: "C:\\Users\\example\\.local\\bin\\claude.exe",
    kind: "user-local-bin",
    source: "USERPROFILE\\.local\\bin",
  });
  assert.equal(candidates.at(-1).kind, "desktop-bundled");
  assert.equal(candidates.at(-1).path, "C:\\Users\\example\\AppData\\Local\\Claude-Data");
});

test("findBundledDesktopClaude picks the newest bundled claude-code build", () => {
  const dataDir = "C:\\Users\\example\\AppData\\Local\\Claude-Data";
  const tree = {
    [dataDir]: [{ name: "claude_pzs8sxrjxfjjc" }, { name: "other" }],
    [`${dataDir}\\claude_pzs8sxrjxfjjc\\claude-code`]: [{ name: "2.1.309" }, { name: "2.1.400" }],
  };
  const base = `${dataDir}\\claude_pzs8sxrjxfjjc\\claude-code`;
  tree[`${base}\\2.1.309`] = [{ name: "9078b9c1d466" }];
  tree[`${base}\\2.1.400`] = [{ name: "aaaaaaaaaaaa" }];
  const exists = (p) => p === `${base}\\2.1.400\\aaaaaaaaaaaa\\claude.exe` || p === `${base}\\2.1.309\\9078b9c1d466\\claude.exe`;
  const readdir = (dir) => {
    if (!tree[dir]) throw new Error(`ENOENT ${dir}`);
    return tree[dir];
  };
  const found = findBundledDesktopClaude({ dataDir, platform: "win32", exists, readdir });
  assert.deepEqual(found, {
    path: `${base}\\2.1.400\\aaaaaaaaaaaa\\claude.exe`,
    kind: "desktop-bundled",
    version: "2.1.400",
    appId: "claude_pzs8sxrjxfjjc",
  });
  assert.equal(findBundledDesktopClaude({ dataDir: "C:\\nope", platform: "win32", exists: () => false, readdir: () => [] }), null);
});

test("findClaudeExecutable never invents a binary: PATH win, bundled fallback, honest null", () => {
  const bundled = "C:\\Users\\example\\AppData\\Local\\Claude-Data\\claude_x\\claude-code\\2.1.309\\h\\claude.exe";
  const tree = {
    "C:\\Users\\example\\AppData\\Local\\Claude-Data": [{ name: "claude_x" }],
    "C:\\Users\\example\\AppData\\Local\\Claude-Data\\claude_x\\claude-code": [{ name: "2.1.309" }],
    "C:\\Users\\example\\AppData\\Local\\Claude-Data\\claude_x\\claude-code\\2.1.309": [{ name: "h" }],
  };
  const readdir = (dir) => {
    if (!tree[dir]) throw new Error("ENOENT");
    return tree[dir];
  };

  const viaPath = findClaudeExecutable({
    env: { ...winEnv, LOCALAPPDATA: "C:\\Users\\example\\AppData\\Local" },
    platform: "win32",
    home: WIN_HOME,
    exists: (p) => p === "C:\\Program Files\\Git\\cmd\\claude.exe",
    readdir,
  });
  assert.deepEqual(viaPath, { path: "C:\\Program Files\\Git\\cmd\\claude.exe", kind: "path", source: "PATH" });

  const viaDesktop = findClaudeExecutable({
    env: { USERPROFILE: WIN_HOME, PATH: "", LOCALAPPDATA: "C:\\Users\\example\\AppData\\Local" },
    platform: "win32",
    home: WIN_HOME,
    exists: (p) => p === bundled,
    readdir,
  });
  assert.equal(viaDesktop.path, bundled);
  assert.equal(viaDesktop.kind, "desktop-bundled");

  assert.equal(findClaudeExecutable({
    env: { USERPROFILE: WIN_HOME, PATH: "", LOCALAPPDATA: "C:\\Users\\example\\AppData\\Local" },
    platform: "win32",
    home: WIN_HOME,
    exists: () => false,
    readdir: () => [],
  }), null);
});

test("findRqlExecutable checks PATH then the install dir, per platform", () => {
  assert.deepEqual(
    findRqlExecutable({ env: { PATH: "C:\\tools;D:\\bin" }, platform: "win32", home: WIN_HOME, exists: (p) => p === "D:\\bin\\rql.exe" }),
    { path: "D:\\bin\\rql.exe", kind: "path" },
  );
  assert.deepEqual(
    findRqlExecutable({ env: { PATH: "" }, platform: "linux", home: "/home/user", exists: (p) => p === "/home/user/.local/bin/rql" }),
    { path: "/home/user/.local/bin/rql", kind: "install-dir" },
  );
  assert.equal(findRqlExecutable({ env: { PATH: "" }, platform: "win32", home: WIN_HOME, exists: () => false }), null);
});

test("verifySecretFilePermissions is HONEST on win32 (no false 'enforced')", () => {
  const result = verifySecretFilePermissions("C:\\Users\\example\\.claude\\settings.json", { platform: "win32" });
  assert.equal(result.enforced, false);
  assert.equal(result.verified, false);
  assert.equal(result.mode, "windows-acl-unverified");
  assert.match(result.reason, /icacls/);
});

test("verifySecretFilePermissions proves 0600 on POSIX", () => {
  const stat = (mode) => () => ({ mode });
  const ok = verifySecretFilePermissions("/tmp/s.json", { platform: "linux", chmod: () => {}, stat: stat(0o100600) });
  assert.deepEqual(ok, { enforced: true, verified: true, mode: "0600" });
  const mismatch = verifySecretFilePermissions("/tmp/s.json", { platform: "linux", chmod: () => {}, stat: stat(0o100644) });
  assert.equal(mismatch.enforced, false);
  assert.equal(mismatch.verified, false);
  assert.equal(mismatch.mode, "mismatch");
  const denied = verifySecretFilePermissions("/tmp/s.json", {
    platform: "linux",
    chmod: () => { throw new Error("EPERM"); },
    stat: stat(0o100644),
  });
  assert.equal(denied.enforced, false);
});

test("isPathInside uses path arithmetic (siblings and separators are not containment)", () => {
  assert.equal(isPathInside("/opt/app", "/opt/app/sub/file", { platform: "linux" }), true);
  assert.equal(isPathInside("/opt/app", "/opt/app-evil/file", { platform: "linux" }), false);
  assert.equal(isPathInside("/opt/app", "/opt/app", { platform: "linux" }), false);
  assert.equal(isPathInside("/opt/app", "/etc/passwd", { platform: "linux" }), false);
  assert.equal(isPathInside("C:\\apps\\app", "C:\\apps\\app\\sub\\x", { platform: "win32" }), true);
  assert.equal(isPathInside("C:\\apps\\app", "C:\\apps\\app-evil\\x", { platform: "win32" }), false);
  assert.equal(isPathInside("C:\\Apps\\App", "c:\\apps\\app\\sub", { platform: "win32" }), true, "Windows is case-insensitive");
  assert.equal(isPathInside("C:\\apps\\app", "D:\\apps\\app\\x", { platform: "win32" }), false);
  assert.equal(isPathInside("", "/x", { platform: "linux" }), false);
});

test("windows .cmd launcher forwards argv verbatim to an absolute node", () => {
  const text = windowsCmdLauncher({ nodeExe: "C:\\Program Files\\nodejs\\node.exe" });
  assert.equal(text.includes("\r\n"), true, "Windows batch files need CRLF");
  assert.match(text, /^@echo off/);
  assert.match(text, /"C:\\Program Files\\nodejs\\node\.exe" "%~dp0ai-orchestra" %\*/);
  assert.match(text, /exit \/b %ERRORLEVEL%/);
  assert.equal(isWindowsPlatform("win32"), true);
  assert.equal(isWindowsPlatform("linux"), false);
});
