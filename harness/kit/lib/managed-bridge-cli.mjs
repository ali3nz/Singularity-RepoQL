// managed-bridge-cli.mjs — V3.5.7 (ticket 230 follow-up, operator order 2026-10-02)
//
// CLI shim for opencode-managed-bridge.sh: runs ONE `opencode run` turn INSIDE
// the openchamber container (where the opencode-go subscription credential
// lives) through the proven lib/openchamber-managed-seat.mjs transport.
//
// Contract (matches the other kit bridges): prompt text arrives on STDIN,
// the model result is printed on STDOUT, and the process exit code carries the
// outcome. Subscription only — failover is the CALLER's decision (ticket 255:
// routing roles walk to the free tail on failure/out-of-credit).
// Optional OPENCODE_MANAGED_AGENT pins a container agent (e.g. the read-only
// fleet-reviewer) for display-only roles.
// Optional OPENCODE_MANAGED_SESSION/TITLE/CWD (ticket 268): narrator isolation — fresh ses_ ID, [orchestrator] title, /tmp/orch-narrator cwd.
//
// Optional vision: when ORCH_VISION_IMAGE points at a readable local file, the
// image is copied into the container (docker cp over ssh) and its container
// path is appended to the prompt so the model can read it from disk.

import { existsSync, readFileSync } from "node:fs";
import { basename } from "node:path";
import { spawn } from "node:child_process";
import { callManagedSeat, managedSeatExitCode } from "./openchamber-managed-seat.mjs";

const MODEL = process.argv[2] || "opencode-go/muse-spark-1.3-contributor#xhigh";
const TIMEOUT_SEC = Number(process.argv[3] || 900);
const SSH_HOST = process.env.OPENCODE_MANAGED_SSH_HOST || "controller";
const CONTAINER = process.env.OPENCHAMBER_CONTAINER || "openchamber";
const AGENT_RAW = String(process.env.OPENCODE_MANAGED_AGENT || "").trim();
const AGENT = /^[a-z0-9-]{1,40}$/i.test(AGENT_RAW) ? AGENT_RAW : null;
const SESSION_RAW = String(process.env.OPENCODE_MANAGED_SESSION || "").trim();
const SESSION = /^ses[\w-]{1,80}$/.test(SESSION_RAW) ? SESSION_RAW : null;
const TITLE_RAW = String(process.env.OPENCODE_MANAGED_TITLE || "").trim().slice(0, 100);
const TITLE = TITLE_RAW ? TITLE_RAW : null;
const CWD_RAW = String(process.env.OPENCODE_MANAGED_CWD || "").trim();
const CWD = (CWD_RAW && CWD_RAW.startsWith("/") && CWD_RAW.length < 200) ? CWD_RAW : null;
const CONTAINER_WS = "/home/openchamber/workspaces";

function copyIntoContainer(localPath) {
  return new Promise((resolve) => {
    const name = `vision-${Date.now()}-${basename(localPath).replace(/[^\w.-]/g, "_")}`;
    const dest = `${CONTAINER_WS}/${name}`;
    let child;
    try {
      child = spawn("ssh", [SSH_HOST, "docker", "cp", "-", `${CONTAINER}:${dest}`], { stdio: ["pipe", "ignore", "pipe"] });
    } catch (e) {
      resolve({ ok: false, why: String(e?.message ?? e) });
      return;
    }
    let err = "";
    child.stderr?.on("data", (d) => { err += d; });
    child.on("error", (e) => resolve({ ok: false, why: String(e?.message ?? e) }));
    child.on("close", (code) => resolve(code === 0 ? { ok: true, dest } : { ok: false, why: `docker cp rc=${code} ${err.slice(0, 200)}` }));
    try {
      child.stdin.write(readFileSync(localPath));
      child.stdin.end();
    } catch (e) {
      resolve({ ok: false, why: String(e?.message ?? e) });
    }
  });
}

let prompt = "";
process.stdin.setEncoding("utf8");
for await (const chunk of process.stdin) prompt += chunk;

const img = process.env.ORCH_VISION_IMAGE || process.env.OPENROUTER_IMAGE_FILE || "";
if (img && existsSync(img)) {
  const copied = await copyIntoContainer(img);
  if (copied.ok) {
    prompt += `\n\nAn image is available on disk at ${copied.dest} — read it with the read tool before answering.`;
  } else {
    process.stderr.write(`managed-bridge: vision image copy failed (${copied.why}); continuing text-only\n`);
  }
}

const r = await callManagedSeat(MODEL, prompt, { timeoutSec: TIMEOUT_SEC, sshHost: SSH_HOST, container: CONTAINER, agent: AGENT, sessionId: SESSION, title: TITLE, ...(CWD ? { cwd: CWD } : {}) });
process.stdout.write(String(r.output ?? ""));
process.exit(managedSeatExitCode(r));
