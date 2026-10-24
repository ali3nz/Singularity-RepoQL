// state.mjs — durable, corruption-aware state for an orchestrated run.
//
// Design notes that matter:
//   * A MISSING file is a cold start. An UNREADABLE, malformed or non-object
//     file is a StateCorruptError: the store never replaces bytes it could not
//     parse, because doing so silently destroys run identity and history.
//   * Writes are atomic: temp file in the same directory, fsync, rename. A crash
//     leaves either the old file or the new one, never a half-written one.
//   * Cross-process mutual exclusion is a lock DIRECTORY (mkdir is atomic on
//     every filesystem we ship on). Stale locks are reclaimed only when their
//     recorded pid is gone AND the lock is older than the stale window.
import { createHash, randomBytes } from "node:crypto";
import fs from "node:fs";
import path from "node:path";

export class StateCorruptError extends Error {
  constructor(file, detail) {
    super(`${file} is not usable (${detail}); refusing to overwrite it`);
    this.name = "StateCorruptError";
    this.file = file;
  }
}

export class LeaseTimeoutError extends Error {
  constructor(lockDir, waitedMs) {
    super(`lock ${lockDir} was not released within ${waitedMs}ms`);
    this.name = "LeaseTimeoutError";
  }
}

const STALE_LOCK_MS = 5 * 60 * 1000;

export function readJson(file) {
  let raw;
  try {
    raw = fs.readFileSync(file, "utf8");
  } catch (err) {
    if (err.code === "ENOENT") return null;
    throw new StateCorruptError(file, `unreadable: ${err.code}`);
  }
  if (!raw.trim()) throw new StateCorruptError(file, "empty file");
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new StateCorruptError(file, "not valid JSON");
  }
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new StateCorruptError(file, "not a JSON object");
  }
  return parsed;
}

export function writeJsonAtomic(file, value) {
  const dir = path.dirname(file);
  fs.mkdirSync(dir, { recursive: true });
  const tmp = path.join(dir, `.${path.basename(file)}.${process.pid}.${Date.now()}.tmp`);
  const body = JSON.stringify(value, null, 2) + "\n";
  let fd;
  try {
    fd = fs.openSync(tmp, "w", 0o600);
    fs.writeFileSync(fd, body);
    fs.fsyncSync(fd);
  } finally {
    if (fd !== undefined) fs.closeSync(fd);
  }
  fs.renameSync(tmp, file);
  return file;
}

function pidAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return err.code === "EPERM";
  }
}

function sleepMs(ms) {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    try {
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, Math.min(25, end - Date.now()));
    } catch {
      break;
    }
  }
}

/** Acquire an exclusive lock directory; returns a release function. */
export function acquireLock(lockDir, { timeoutMs = 5000, now = Date.now } = {}) {
  const started = now();
  fs.mkdirSync(path.dirname(lockDir), { recursive: true });
  for (;;) {
    try {
      fs.mkdirSync(lockDir);
      fs.writeFileSync(path.join(lockDir, "owner"), `${process.pid}\n`);
      let released = false;
      return () => {
        if (released) return;
        released = true;
        fs.rmSync(lockDir, { recursive: true, force: true });
      };
    } catch (err) {
      if (err.code !== "EEXIST") throw err;
      let ownerPid = null;
      let ageMs = 0;
      try {
        ownerPid = Number.parseInt(fs.readFileSync(path.join(lockDir, "owner"), "utf8").trim(), 10);
        ageMs = now() - fs.statSync(lockDir).mtimeMs;
      } catch {
        /* lock vanished or is mid-creation */
      }
      if (ownerPid && !pidAlive(ownerPid) && ageMs > 1000) {
        fs.rmSync(lockDir, { recursive: true, force: true });
        continue;
      }
      if (ageMs > STALE_LOCK_MS && !ownerPid) {
        fs.rmSync(lockDir, { recursive: true, force: true });
        continue;
      }
      if (now() - started > timeoutMs) throw new LeaseTimeoutError(lockDir, timeoutMs);
      sleepMs(25);
    }
  }
}

/** Run `fn` while holding the lock for `name`. */
export function withLock(dir, name, fn, opts) {
  const release = acquireLock(path.join(dir, `${name}.lock`), opts);
  try {
    return fn();
  } finally {
    release();
  }
}

export function newId(prefix) {
  const stamp = new Date().toISOString().replace(/[-:.TZ]/g, "").slice(0, 14);
  return `${prefix}-${stamp}-${randomBytes(4).toString("hex")}`;
}

export function hashValue(value) {
  const body = typeof value === "string" ? value : JSON.stringify(value, Object.keys(value ?? {}).sort());
  return createHash("sha256").update(body).digest("hex");
}

/**
 * A run store rooted at one directory.
 *
 * Layout: <dir>/runs.json is the registry, <dir>/runs/<id>.json is one run,
 * <dir>/leases.json holds resource leases, and <dir>/*.lock guards writes.
 */
export function openStore(dir) {
  const registryPath = path.join(dir, "runs.json");
  const runsDir = path.join(dir, "runs");

  function readRegistry() {
    const data = readJson(registryPath);
    if (!data) return { version: 1, cases: {}, runs: [] };
    if (!Array.isArray(data.runs)) throw new StateCorruptError(registryPath, "runs is not an array");
    if (!data.cases || typeof data.cases !== "object") data.cases = {};
    return data;
  }

  function runPath(id) {
    return path.join(runsDir, `${id}.json`);
  }

  return {
    dir,
    registryPath,
    runPath,
    readRegistry,
    writeRegistry(registry) {
      return writeJsonAtomic(registryPath, registry);
    },
    readRun(id) {
      return readJson(runPath(id));
    },
    writeRun(run) {
      return writeJsonAtomic(runPath(run.id), run);
    },
    listRuns() {
      const { runs } = readRegistry();
      return runs.slice().sort((a, b) => (a.createdAt < b.createdAt ? 1 : -1));
    },
    lock(name, fn, opts) {
      return withLock(dir, name, fn, opts);
    },
  };
}
