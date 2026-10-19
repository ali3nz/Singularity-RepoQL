#!/usr/bin/env node
// ghost-gateway.mjs — OpenAI-compatible /v1/chat/completions endpoint that
// executes each request as ONE turn of the Ghost agent on the OpenChamber
// (opencode) runtime.
//
// Binds to loopback (127.0.0.1:18003) by default so scheduled pipelines (such
// as ghost/dream.mjs) can run step-by-step reflection against the Ghost lane.
import { createServer } from "node:http";
import { spawn } from "node:child_process";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

const HOSTS = (process.env.GHOST_GATEWAY_HOSTS || "127.0.0.1").split(",").map((s) => s.trim()).filter(Boolean);
const PORT = Number(process.env.GHOST_GATEWAY_PORT || 18003);
const CTN = process.env.GHOST_CONTAINER || "singularity-openchamber";
const BIN = process.env.GHOST_OPENCODE_BIN || "opencode";
const AGENT = process.env.GHOST_AGENT || "ghost";
const MODEL = process.env.GHOST_MODEL || "";
const TURN_TIMEOUT_MS = Number(process.env.GHOST_TURN_TIMEOUT_MS || 900000);
const MAX_CONCURRENCY = Number(process.env.GHOST_GATEWAY_CONCURRENCY || 1);

let inflight = 0;
const queue = [];
const stats = { requests: 0, completed: 0, failed: 0, rejected: 0, startedAt: new Date().toISOString() };

function runTurn(label, prompt) {
  return new Promise((resolveTurn) => {
    const modelArgs = MODEL ? ["--model", MODEL] : [];
    const args = ["exec", "-i", CTN, BIN, "run", "--agent", AGENT, ...modelArgs, "--format", "json", "--title", label, prompt];
    const child = spawn("docker", args, { stdio: ["ignore", "pipe", "pipe"] });
    let out = "", err = "";
    const killer = setTimeout(() => { try { child.kill("SIGKILL"); } catch { /* gone */ } }, TURN_TIMEOUT_MS);
    child.stdout.on("data", (d) => { out += d; if (out.length > 8e6) out = out.slice(-4e6); });
    child.stderr.on("data", (d) => { err += d; if (err.length > 2e5) err = err.slice(-1e5); });
    child.on("close", (code) => {
      clearTimeout(killer);
      const texts = [];
      let usage = null, session = null;
      for (const line of out.split("\n")) {
        const t = line.trim();
        if (!t.startsWith("{")) continue;
        let j = null;
        try { j = JSON.parse(t); } catch { continue; }
        if (j.sessionID) session = j.sessionID;
        if (j.type === "text" && typeof j.part?.text === "string") texts.push(j.part.text);
        if (j.type === "step_finish" && j.part?.tokens) {
          const tk = j.part.tokens;
          usage = usage || { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 };
          usage.prompt_tokens += tk.input || 0;
          usage.completion_tokens += (tk.output || 0) + (tk.reasoning || 0);
          usage.total_tokens = usage.prompt_tokens + usage.completion_tokens;
        }
      }
      resolveTurn({ code, content: texts.join("\n").trim(), usage, session, err: err.slice(-500) });
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
    res.end(JSON.stringify({ ok: true, agent: AGENT, model: MODEL || "default", inflight, queued: queue.length, ...stats }));
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
  for (const host of HOSTS) {
    const srv = createServer(handler);
    srv.listen(PORT, host, () => console.log(`ghost-gateway listening on http://${host}:${PORT} (agent=${AGENT})`));
    srv.on("error", (e) => console.error(`listen ${host}:${PORT} failed: ${e.message}`));
  }
}
