#!/usr/bin/env node
// ghost-gateway.mjs — OpenAI-compatible /v1/chat/completions endpoint that
// executes each request as ONE turn of the Ghost agent on the OpenChamber
// (opencode) runtime.
//
// Binds to loopback (127.0.0.1:18003) by default so scheduled pipelines (such
// as ghost/dream.mjs) can run step-by-step reflection against the Ghost lane.
//
// HOW TURNS RUN: the gateway shells out to `docker exec` for every turn, so it
// must run on the HOST (or in a container that itself has a docker CLI and
// socket — deliberately NOT granted by ghost.compose.yml). Two supported
// modes:
//   1. HOST process (recommended): run `node ghost/ghost-gateway.mjs` directly
//      (or via ghost/systemd/ghost-gateway.service); the compose gateway
//      service is retained without it.
//   2. DIND container: build an image with docker CLI + this repo mounted and
//      mount /var/run/docker.sock yourself — an explicit, documented act.
// The compose service therefore fails turns with a clear configuration error
// instead of crashing on a missing docker binary.
import { createServer } from "node:http";
import { spawn } from "node:child_process";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

const HOSTS = (process.env.GHOST_GATEWAY_HOSTS || "127.0.0.1").split(",").map((s) => s.trim()).filter(Boolean);
const PORT = Number(process.env.GHOST_GATEWAY_PORT || 18003);
// Backend selection: "openchamber" runs turns inside the OpenChamber container
// (docker exec + opencode); "claude-code" runs turns through the claude CLI on
// this host — REQUIRED for Variant 2 (Claude Code complete), which must work
// WITHOUT an OpenChamber installation. Both honor AGENT/MODEL/TURN_TIMEOUT.
const BACKEND = process.env.GHOST_BACKEND || "openchamber";
const CTN = process.env.GHOST_CONTAINER || "singularity-openchamber";
const CLAUDE_BIN = process.env.GHOST_CLAUDE_BIN || "claude";
const BIN = process.env.GHOST_OPENCODE_BIN || "opencode";
const AGENT = process.env.GHOST_AGENT || "ghost";
const MODEL = process.env.GHOST_MODEL || "";
const TURN_TIMEOUT_MS = Number(process.env.GHOST_TURN_TIMEOUT_MS || 900000);
const MAX_CONCURRENCY = Number(process.env.GHOST_GATEWAY_CONCURRENCY || 1);

let inflight = 0;
const queue = [];
const stats = { requests: 0, completed: 0, failed: 0, rejected: 0, startedAt: new Date().toISOString() };

// Execution-mode detection is done ONCE at startup: if the docker CLI is not
// available (as inside the plain ghost.compose.yml gateway container), the
// gateway stays up and answers /healthz with `execAvailable:false`, and every
// turn is rejected with a configuration error instead of crashing.
let EXEC_MODE = { dockerBin: process.env.GHOST_DOCKER_BIN || "docker", error: null };
function detectExecMode() {
  if (BACKEND === "claude-code") {
    // No docker dependency: probe the claude CLI once before serving turns.
    const probe = spawn(CLAUDE_BIN, ["--version"], { stdio: "ignore" });
    probe.on("error", (e) => {
      EXEC_MODE = { ...EXEC_MODE, error: `claude CLI not available for this process: ${e?.message || e}. Install Claude Code (docs/CLAUDE-CODE-SETUP.md) or point GHOST_CLAUDE_BIN at the binary.` };
      console.error("[ghost-gateway] " + EXEC_MODE.error);
    });
    probe.on("close", (code) => {
      if (code !== 0) {
        EXEC_MODE = { ...EXEC_MODE, error: `claude probe exited ${code} — turns will be rejected until the CLI works for this process.` };
        console.error("[ghost-gateway] " + EXEC_MODE.error);
      } else {
        console.log("[ghost-gateway] claude CLI available; turn execution enabled (backend=claude-code)");
      }
    });
    return;
  }
  const probe = spawn(process.env.GHOST_DOCKER_BIN || "docker", ["version", "--format", "{{.Server.Version}}"], { stdio: "ignore" });
  probe.on("error", (e) => {
    EXEC_MODE = { ...EXEC_MODE, error: `docker CLI not available for this process: ${e?.message || e}. Run the gateway on the host (ghost/systemd) or in a docker-CLI-enabled container; see ghost/README.md.` };
    console.error("[ghost-gateway] " + EXEC_MODE.error);
  });
  probe.on("close", (code) => {
    if (code !== 0) {
      EXEC_MODE = { ...EXEC_MODE, error: `docker probe exited ${code} — turns will be rejected until docker works for this process.` };
      console.error("[ghost-gateway] " + EXEC_MODE.error);
    } else {
      console.log("[ghost-gateway] docker exec available; turn execution enabled");
    }
  });
}

function runTurn(label, prompt) {
  return new Promise((resolveTurn) => {
    let killer = null;
    const finish = (r) => { if (killer !== null) { try { clearTimeout(killer); } catch { /* already cleared */ } killer = null; } resolveTurn(r); };
    if (EXEC_MODE.error) {
      finish({ code: 127, content: "", usage: null, session: null, err: EXEC_MODE.error });
      return;
    }
    // Backend dispatch: openchamber -> docker exec (opencode agent runtime);
    // claude-code -> the claude CLI in non-interactive print mode on this host.
    const isClaudeBackend = BACKEND === "claude-code";
    const dockerCmd = process.env.GHOST_DOCKER_BIN || "docker";
    let bin, args;
    if (isClaudeBackend) {
      bin = CLAUDE_BIN;
      // `claude -p "<prompt>" --output-format json` prints one JSON object
      // containing { result, usage }. Ghost reflection turns are tool-less by
      // policy: tools are denied via --allowedTools "" (no permission grants).
      args = ["-p", prompt, "--output-format", "json",
        ...(MODEL ? ["--model", MODEL] : []), "--allowedTools", ""];
    } else {
      const modelArgs = MODEL ? ["--model", MODEL] : [];
      bin = dockerCmd;
      args = ["exec", "-i", CTN, BIN, "run", "--agent", AGENT, ...modelArgs, "--format", "json", "--title", label, prompt];
    }
    let child;
    try {
      // Read the backend binary per turn: tests (and podman-style migrations)
      // may swap it between turns via GHOST_DOCKER_BIN / GHOST_CLAUDE_BIN.
      child = spawn(bin, args, { stdio: ["ignore", "pipe", "pipe"] });
    } catch (error) {
      finish({ code: 127, content: "", usage: null, session: null, err: `spawn ${bin} failed: ${error?.message || error}` });
      return;
    }
    killer = setTimeout(() => { try { child.kill("SIGKILL"); } catch { /* gone */ } }, TURN_TIMEOUT_MS);
    let out = "", err = "";
    child.stdout.on("data", (d) => { out += d; if (out.length > 8e6) out = out.slice(-4e6); });
    child.stderr.on("data", (d) => { err += d; if (err.length > 2e5) err = err.slice(-1e5); });
    // A spawn failure (ENOENT: no docker CLI) must reject the turn, never
    // crash the gateway process via an unhandled "error" event. The turn is
    // resolved with a failure; drain() records it exactly once.
    child.on("error", (spawnError) => {
      EXEC_MODE.error = `${bin} exec unavailable: ${spawnError?.message || spawnError}`;
      finish({ code: 127, content: "", usage: null, session: null, err: EXEC_MODE.error });
    });
    child.on("close", (code) => {
      const texts = [];
      let usage = null, session = null;
      for (const line of out.split("\n")) {
        const t = line.trim();
        if (!t.startsWith("{")) continue;
        let j = null;
        try { j = JSON.parse(t); } catch { continue; }
        if (j.sessionID) session = j.sessionID;
        if (j.type === "result" && j.subtype === "success" && typeof j.result === "string") {
          // claude-code backend: one result object with the turn text and usage.
          texts.push(j.result);
          if (j.usage && (j.usage.input_tokens != null || j.usage.output_tokens != null)) {
            usage = usage || { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 };
            usage.prompt_tokens += j.usage.input_tokens || 0;
            usage.completion_tokens += j.usage.output_tokens || 0;
            usage.total_tokens = usage.prompt_tokens + usage.completion_tokens;
          }
          continue;
        }
        if (j.type === "text" && typeof j.part?.text === "string") texts.push(j.part.text);
        if (j.type === "step_finish" && j.part?.tokens) {
          const tk = j.part.tokens;
          usage = usage || { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 };
          usage.prompt_tokens += tk.input || 0;
          usage.completion_tokens += (tk.output || 0) + (tk.reasoning || 0);
          usage.total_tokens = usage.prompt_tokens + usage.completion_tokens;
        }
      }
      finish({ code, content: texts.join("\n").trim(), usage, session, err: err.slice(-500) });
    });
  });
}

function drain() {
  while (inflight < MAX_CONCURRENCY && queue.length) {
    const job = queue.shift();
    inflight++;
    runTurn(job.label, job.prompt)
      .then((r) => {
        if (r.code === 0 && r.content) {
          stats.completed++;
          job.res.json(200, {
            id: `chatcmpl-ghost-${Date.now().toString(36)}`,
            object: "chat.completion",
            created: Math.floor(Date.now() / 1000),
            model: `ghost/${MODEL || "default"}`,
            choices: [{ index: 0, message: { role: "assistant", content: r.content }, finish_reason: "stop" }],
            usage: r.usage || { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 },
            served: { model: "ghost-lane", route: "opencode-agent", session: r.session, agent: AGENT },
          });
        } else {
          stats.failed++;
          job.res.json(502, { error: { type: "GATEWAY_HTTP_ERROR", message: `ghost turn failed (rc=${r.code}): ${r.err || "empty content"}` } });
        }
      })
      .catch((e) => {
        stats.failed++;
        job.res.json(502, { error: { type: "GATEWAY_HTTP_ERROR", message: String(e.message || e) } });
      })
      .finally(() => { inflight--; drain(); });
  }
}

function body(req) {
  return new Promise((resolveBody) => {
    let s = "";
    req.on("data", (d) => { s += d; if (s.length > 4e6) s = s.slice(-2e6); });
    req.on("end", () => { try { resolveBody(JSON.parse(s || "{}")); } catch { resolveBody(null); } });
  });
}

export const handler = async (req, res) => {
  const url = new URL(req.url, "http://localhost");
  if (url.pathname === "/healthz") {
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ ok: true, backend: BACKEND, execAvailable: !EXEC_MODE.error, agent: AGENT, model: MODEL || "default", inflight, queued: queue.length, ...stats }));
    return;
  }
  if (url.pathname === "/v1/models" || url.pathname === "/models") {
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ object: "list", data: [{ id: `ghost/${MODEL || "default"}`, object: "model", owned_by: "ghost-lane", agent: AGENT }] }));
    return;
  }
  if (url.pathname !== "/v1/chat/completions" && url.pathname !== "/chat/completions") {
    res.writeHead(404, { "content-type": "application/json" });
    res.end(JSON.stringify({ error: { type: "not_found", message: "POST /v1/chat/completions" } }));
    return;
  }
  const b = await body(req);
  const messages = Array.isArray(b?.messages) ? b.messages : [];
  if (!messages.length) {
    res.writeHead(400, { "content-type": "application/json" });
    res.end(JSON.stringify({ error: { type: "GATEWAY_HTTP_ERROR", message: "no messages" } }));
    return;
  }
  const sys = messages.filter((m) => m.role === "system").map((m) => String(m.content || "")).join("\n\n");
  const rest = messages.filter((m) => m.role !== "system").map((m) => String(m.content || "")).join("\n\n");
  const label = process.env.GHOST_JOB_LABEL || (b?.model ? String(b.model).slice(0, 40) : "ghost-job");
  const prompt = (sys ? `[system]\n${sys}\n\n[task]\n` : "") + rest;
  stats.requests++;
  if (queue.length > 50) {
    stats.rejected++;
    res.writeHead(429, { "content-type": "application/json" });
    res.end(JSON.stringify({ error: { type: "GATEWAY_HTTP_ERROR", message: "queue full" } }));
    return;
  }
  queue.push({
    label: `ghost-job-${label}`,
    prompt,
    res: {
      json: (code, obj) => {
        res.writeHead(code, { "content-type": "application/json" });
        res.end(JSON.stringify(obj));
      },
    },
  });
  drain();
};

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  detectExecMode();
  for (const host of HOSTS) {
    const srv = createServer(handler);
    srv.listen(PORT, host, () => console.log(`ghost-gateway listening on http://${host}:${PORT} (agent=${AGENT})`));
    srv.on("error", (e) => console.error(`listen ${host}:${PORT} failed: ${e.message}`));
  }
}
