#!/usr/bin/env node
// ghost/chain.mjs — run a configured chain of steps, one at a time, under one lock.
//
// The live fleet runs its daily Ghost block as a chain rather than as N separate
// timers: one thread, one lock, every step in order, one log. This is the same
// mechanism with the steps supplied by configuration instead of compiled in, so
// no product install inherits another install's schedule, commands or prompts.
//
//   node ghost/chain.mjs --config=chain.example.json
//   node ghost/chain.mjs --config=chain.json --only=sweep,dream
//   node ghost/chain.mjs --config=chain.json --plan
//
// Config (all paths relative to the config file's directory):
//   {
//     "lock": "/tmp/singularity-ghost-chain.lock",
//     "logDir": "wake",
//     "noteFile": "wake/chain-{{date}}.md",
//     "steps": [
//       { "id": "sweep", "cmd": "node", "args": ["sweep/unified.mjs"],
//         "cwd": ".", "env": {}, "timeoutSeconds": 1800, "optional": false,
//         "okNote": "sweep ok", "failNote": "sweep failed" }
//     ]
//   }
//
// Exit: 0 every runnable step succeeded; 1 a required step failed or the chain
//       aborted; 2 usage/config error; 3 another chain holds the lock.
import { closeSync, mkdirSync, openSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { spawnSync } from "node:child_process";

const argv = process.argv.slice(2);
const flag = (name, fallback = "") => {
  const eq = argv.find((a) => a.startsWith(`--${name}=`));
  if (eq) return eq.slice(name.length + 3);
  const i = argv.indexOf(`--${name}`);
  return i >= 0 && argv[i + 1] !== undefined ? argv[i + 1] : fallback;
};
const has = (name) => argv.includes(`--${name}`);

function usage(message) {
  if (message) console.error(`chain: ${message}`);
  console.error("usage: node ghost/chain.mjs --config=<file.json> [--only=id,id] [--plan]");
  process.exit(2);
}

const configPath = resolve(flag("config"));
if (!flag("config")) usage("--config is required");

let config;
try {
  config = JSON.parse(readFileSync(configPath, "utf8"));
} catch (error) {
  usage(`cannot read config ${configPath}: ${error.message}`);
}
if (!Array.isArray(config.steps) || config.steps.length === 0) usage("config.steps must be a non-empty array");

const base = dirname(configPath);
const at = (p, fallback) => (p ? (isAbsolute(p) ? p : join(base, p)) : fallback);
const date = new Date().toISOString().slice(0, 10);
const render = (text) => String(text).replaceAll("{{date}}", date);

const only = flag("only").split(",").map((s) => s.trim()).filter(Boolean);
const steps = config.steps.filter((step) => only.length === 0 || only.includes(step.id));
if (steps.length === 0) usage(`no step matches --only=${only.join(",")}`);

const logDir = at(config.logDir, join(base, "wake"));
const lockPath = at(config.lock, join(base, "chain.lock"));
const notePath = config.noteFile ? at(render(config.noteFile)) : null;

if (has("plan")) {
  for (const step of steps) console.log(`${step.optional ? "optional" : "required"}  ${step.id}  ${step.cmd} ${(step.args || []).join(" ")}`);
  process.exit(0);
}

// One chain at a time: O_EXCL makes the lock itself the arbiter, so a second
// run exits immediately instead of interleaving steps with the first.
let lockFd;
try {
  lockFd = openSync(lockPath, "wx");
} catch (error) {
  if (error.code === "EEXIST") {
    console.error(`chain: ${lockPath} is held by another run; refusing to interleave`);
    process.exit(3);
  }
  throw error;
}
writeFileSync(lockFd, `${process.pid} ${new Date().toISOString()}\n`);
closeSync(lockFd);
mkdirSync(logDir, { recursive: true });
const release = () => { try { unlinkSync(lockPath); } catch { /* already gone */ } };
process.on("exit", release);
process.on("SIGINT", () => { release(); process.exit(130); });
process.on("SIGTERM", () => { release(); process.exit(143); });

const startedAt = new Date().toISOString();
const results = [];
let aborted = false;

for (const step of steps) {
  if (aborted) {
    results.push({ id: step.id, status: "skipped", reason: "an earlier required step failed" });
    continue;
  }
  const cwd = at(step.cwd, base);
  const started = Date.now();
  const res = spawnSync(step.cmd, step.args || [], {
    cwd,
    env: { ...process.env, ...(step.env || {}) },
    encoding: "utf8",
    timeout: (step.timeoutSeconds || 1800) * 1000,
    stdio: ["ignore", "pipe", "pipe"],
  });
  const elapsed = Date.now() - started;
  const timedOut = res.error && res.error.code === "ETIMEDOUT";
  const ok = !timedOut && res.status === 0;
  const entry = {
    id: step.id,
    status: ok ? "ok" : timedOut ? "timeout" : "failed",
    exitCode: res.status,
    ms: elapsed,
    stdoutTail: String(res.stdout || "").slice(-2000),
    stderrTail: String(res.stderr || "").slice(-2000),
  };
  results.push(entry);
  console.log(`chain: ${entry.status} ${step.id} (${elapsed} ms)`);
  if (!ok && !step.optional) aborted = true;
}

const failed = results.filter((r) => r.status === "failed" || r.status === "timeout");
const run = { date, startedAt, finishedAt: new Date().toISOString(), aborted, steps: results };
const logPath = join(logDir, `chain-${date}.json`);
writeFileSync(logPath, JSON.stringify(run, null, 2) + "\n");

if (notePath) {
  const lines = [failed.length === 0 && !aborted
    ? `OUTCOME: chain ${date} ok (${results.length} steps)`
    : `LESSON: chain ${date} ${aborted ? "ABORTED" : "FAILED"} — ${failed.map((f) => `${f.id}:${f.status}`).join(", ")}; see ${logPath}`];
  for (const step of steps) {
    const entry = results.find((r) => r.id === step.id);
    const note = entry && entry.status === "ok" ? step.okNote : step.failNote;
    if (note) lines.push(`- ${step.id}: ${note}`);
  }
  mkdirSync(dirname(notePath), { recursive: true });
  writeFileSync(notePath, lines.join("\n") + "\n", { flag: "a" });
}

process.exit(failed.length === 0 && !aborted ? 0 : 1);
