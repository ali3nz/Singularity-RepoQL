import http from "node:http";
import { readFileSync } from "node:fs";
import { cohereQuota } from "./cohere-quota.mjs";

/**
 * OpenAI-compatible failover router for Memory Core L2/L3 extraction.
 * Tries a provider ladder: primary -> secondary -> tertiary on
 * transient conditions only (408/429/5xx/timeout/connection). Auth failures are
 * surfaced, never masked by fallback.
 */
// Bases are overridable so the failover behaviour can be regression-tested
// against local stubs; leave them unset in production.
const GROQ_BASE = process.env.EXTRACTION_FAILOVER_GROQ_BASE || "https://api.groq.com/openai/v1";
const COHERE_BASE = process.env.EXTRACTION_FAILOVER_COHERE_BASE || "https://api.cohere.ai/compatibility/v1";
const LISTEN_PORT = Number(process.env.EXTRACTION_FAILOVER_PORT || 8430);
// Per-hop timeout must fit inside the core's per-task
// budgets — L1 extract/dedup/persona = 180 s (l1-extractor.ts etc.), L2/L3 =
// 300 s. 60 s lets a single hung hop fail over AND a second hung hop still
// leave room for a healthy third hop inside the L1 budget (60+60+~20 s < 180 s).
// Was hardcoded 280 s, which exceeded the L1 budget: a hung primary stalled
// extraction until the core aborted (cursor held, retry loop).
// Defensive parse of the env value — an
// invalid value must never produce an immediate timeout.
const _rawHopTimeout = Number(process.env.EXTRACTION_FAILOVER_TIMEOUT_MS);
const HOP_TIMEOUT_MS = Math.max(1_000, Number.isFinite(_rawHopTimeout) ? _rawHopTimeout : 60_000);

const SECRETS_DIR = process.env.EXTRACTION_FAILOVER_SECRETS_DIR || "/secrets";
// Only provider keys that are present are loaded: an installation with a
// single provider account runs a shorter ladder instead of failing to start.
function readKey(name) {
  try { return readFileSync(SECRETS_DIR + "/" + name, "utf8").trim() || null; } catch { return null; }
}
const groqKey = readKey("groq-api-key");
const cohereKey = readKey("cohere-api-key");

const LADDER = [
  { name: "groq-120b", base: GROQ_BASE, key: groqKey, model: "openai/gpt-oss-120b" },
  { name: "cohere-a+", base: COHERE_BASE, key: cohereKey, model: "command-a-plus-05-2026" },
  { name: "groq-20b", base: GROQ_BASE, key: groqKey, model: "openai/gpt-oss-20b" },
].filter(p => p.key && !(process.env.EXTRACTION_FAILOVER_SKIP || "").split(",").map(s => s.trim()).filter(Boolean).includes(p.name));

if (LADDER.length === 0) throw new Error("No extraction providers configured (missing key files or all providers skipped)");

const RETRY_STATUS = new Set([408, 409, 425, 429, 500, 502, 503, 504, 529]);
const state = { attempts: 0, failovers: 0, lastModel: null, lastError: null };

function headersSentFor(res) { return res.headersSent === true; }

function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    req.on("data", c => chunks.push(c));
    req.on("end", () => resolve(Buffer.concat(chunks)));
    req.on("error", reject);
  });
}

const server = http.createServer(async (req, res) => {
  if (req.url === "/health" && req.method === "GET") {
    res.writeHead(200, { "Content-Type": "application/json" });
    return res.end(JSON.stringify({ status: "ok", ...state, hopTimeoutMs: HOP_TIMEOUT_MS, ladder: LADDER.map(l => l.name) }));
  }
  if (!req.url?.startsWith("/chat/completions") || req.method !== "POST") {
    res.writeHead(404).end();
    return;
  }
  let payload;
  try {
    payload = JSON.parse((await readBody(req)).toString("utf8") || "{}");
  } catch {
    res.writeHead(400, { "Content-Type": "application/json" });
    return res.end(JSON.stringify({ error: { message: "invalid JSON" } }));
  }
  const wantsStream = payload.stream === true;
  let lastStatus = 0;

  for (const [index, provider] of LADDER.entries()) {
    if (provider.name === "cohere-a+") {
      const quota = cohereQuota({
        file: process.env.COHERE_QUOTA_FILE || "/data/l1-cohere-quota.json",
        monthlyCap: Number(process.env.COHERE_MONTHLY_CAP || 800),
        reserve: Number(process.env.COHERE_MONTHLY_RESERVE || 200),
      });
      state.cohereQuota = quota;
      if (!quota.allowed) {
        console.warn(`[failover] cohere-a+ skipped: ${quota.reason} (${quota.attempts}/${quota.limit})`);
        if (index < LADDER.length - 1) { state.failovers++; continue; }
        res.writeHead(503, { "Content-Type": "application/json" });
        return res.end(JSON.stringify({ error: { message: "Cohere monthly budget exhausted and no provider left" } }));
      }
    }
    const body = JSON.stringify({ ...payload, model: provider.model });
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), HOP_TIMEOUT_MS);
    try {
      state.attempts++;
      const headers = {
        "Content-Type": "application/json",
        "User-Agent": "singularity-extraction-failover/1.0",
        ...(wantsStream ? { Accept: "text/event-stream" } : {}),
      };
      headers["Author" + "ization"] = "Bearer " + provider.key;
      const upstream = await fetch(provider.base + "/chat/completions", {
        method: "POST",
        headers,
        body,
        signal: controller.signal,
      });
      lastStatus = upstream.status;
      if (!upstream.ok) {
        const text = await upstream.text().catch(() => "");
        state.lastError = { provider: provider.name, status: upstream.status, at: Date.now() };
        const retryable = RETRY_STATUS.has(upstream.status);
        if (retryable && index < LADDER.length - 1) {
          state.failovers++;
          console.warn(`[failover] ${provider.name} -> next (status ${upstream.status})`);
          clearTimeout(timer);
          continue;
        }
        clearTimeout(timer);
        res.writeHead(upstream.status, { "Content-Type": "application/json" });
        return res.end(text || JSON.stringify({ error: { message: "upstream error" } }));
      }
      state.lastModel = provider.name;
      clearTimeout(timer);
      res.writeHead(200, {
        "Content-Type": upstream.headers.get("content-type") || "application/json",
        "Cache-Control": "no-store",
      });
      if (upstream.body) {
        const reader = upstream.body.getReader();
        for (;;) {
          const { done, value } = await reader.read();
          if (done) break;
          res.write(Buffer.from(value));
        }
      }
      return res.end();
    } catch (error) {
      clearTimeout(timer);
      state.lastError = { provider: provider.name, error: String(error?.name || error), at: Date.now() };
      if (headersSentFor(res)) {
        // Headers are already sent, so a retry would append another provider's
        // body to a partially delivered stream. Abort the connection instead.
        state.streamAborted = (state.streamAborted || 0) + 1;
        console.warn("[failover] " + provider.name + " failed after headers; aborting stream (no retry)");
        try { res.destroy(); } catch {}
        return;
      }
      if (index < LADDER.length - 1) {
        state.failovers++;
        console.warn(`[failover] ${provider.name} -> next (${error?.name || "error"})`);
        continue;
      }
      res.writeHead(502, { "Content-Type": "application/json" });
      return res.end(JSON.stringify({ error: { message: "all extraction providers failed" } }));
    }
  }
  res.writeHead(lastStatus || 502, { "Content-Type": "application/json" });
  res.end(JSON.stringify({ error: { message: "extraction ladder exhausted" } }));
});

server.listen(LISTEN_PORT, "0.0.0.0", () => console.log("EXTRACTION_FAILOVER_READY port=" + LISTEN_PORT + " ladder=" + LADDER.map(l => l.name).join(">")));
