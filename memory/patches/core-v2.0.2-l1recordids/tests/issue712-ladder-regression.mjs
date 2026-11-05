// ticket 712 — targeted fallback-ladder regression for src/adapters/standalone/llm-runner.ts.
// Runs fully offline with local mock OpenAI-compatible chat servers (no external network).
// Cases mandated at Sol gate 1 (2026-10-17T22-07-10-647-294748):
//   T1 successful primary extraction
//   T2 hanging primary -> per-attempt deadline -> successful fallback (failover warning)
//   T3 caller cancellation stays fatal (no failover, fast)
//   T4 overall ceiling expiry stays fatal when every attempt hangs
//   T5 all candidates fail -> last error surfaces (not a ReferenceError)
//   T6 failure with instanceId set reports the underlying error, no "usedModel" masking
// Exit 0 = all pass. Usage (inside the image): node --import tsx tests/issue712-ladder-regression.mjs
import http from "node:http";
import { once } from "node:events";
import { StandaloneLLMRunner } from "../src/adapters/standalone/llm-runner.ts";

const results = [];
function ok(name, cond, extra = "") {
  results.push({ name, pass: !!cond });
  console.log(`${cond ? "PASS" : "FAIL"}  ${name}${extra ? "  — " + extra : ""}`);
}

function chatResponse(text) {
  return JSON.stringify({
    id: "cmpl-1", object: "chat.completion", created: 0, model: "mock",
    choices: [{ index: 0, message: { role: "assistant", content: text }, finish_reason: "stop" }],
    usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
  });
}

async function startMock(mode) { // "ok" | "hang" | "err500"
  const hits = [];
  const srv = http.createServer((req, res) => {
    let b = ""; req.on("data", (c) => (b += c));
    req.on("end", () => {
      hits.push(req.url);
      if (mode === "hang") return; // accept, never respond
      if (mode === "err500") { // transient upstream failure, delayed
        setTimeout(() => {
          try { res.writeHead(500, { "content-type": "application/json" }); res.end('{"error":"upstream"}'); } catch { /* aborted */ }
        }, 400);
        return;
      }
      res.writeHead(200, { "content-type": "application/json" });
      res.end(chatResponse("MOCK_OK"));
    });
  });
  srv.listen(0, "127.0.0.1");
  await once(srv, "listening");
  return { port: srv.address().port, hits, close: () => new Promise((r) => { srv.closeAllConnections?.(); srv.close(r); }) };
}

const logs = [];
const logger = {
  info: (m) => logs.push(["info", String(m)]),
  warn: (m) => logs.push(["warn", String(m)]),
  error: (m) => logs.push(["error", String(m)]),
  debug: (m) => logs.push(["debug", String(m)]),
};
function mkRunner({ primaryPort, model = "mock-primary", timeoutMs }) {
  return new StandaloneLLMRunner({
    config: { baseUrl: `http://127.0.0.1:${primaryPort}/v1`, apiKey: "test-key", model, timeoutMs, maxTokens: 64 },
    logger,
  });
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// T1 — successful primary extraction (no fallbacks configured)
{
  delete process.env.TDAI_LLM_FALLBACK_MODELS;
  delete process.env.TDAI_LLM_FALLBACK_TARGETS;
  const m1 = await startMock("ok");
  const r = mkRunner({ primaryPort: m1.port, timeoutMs: 8000 });
  let text = "", err = null;
  try { text = await r.run({ taskId: "t1", systemPrompt: "s", prompt: "p" }); } catch (e) { err = e; }
  ok("T1 successful primary extraction", err === null && text === "MOCK_OK", `text=${JSON.stringify(text)} err=${err && err.message}`);
  await m1.close();
}

// T2 — hanging primary -> per-attempt deadline -> successful fallback
{
  delete process.env.TDAI_LLM_FALLBACK_MODELS;
  const hang = await startMock("hang");
  const good = await startMock("ok");
  process.env.TDAI_LLM_FALLBACK_TARGETS = `http://127.0.0.1:${good.port}/v1|-|mock-fallback`;
  const r = mkRunner({ primaryPort: hang.port, timeoutMs: 4000 }); // perAttempt = 2000ms
  const t0 = Date.now();
  let text = "", err = null;
  try { text = await r.run({ taskId: "t2", systemPrompt: "s", prompt: "p" }); } catch (e) { err = e; }
  const ms = Date.now() - t0;
  const warned = logs.some(([lvl, m]) => lvl === "warn" && m.includes("per-attempt timeout (upstream hung)") && m.includes("mock-fallback"));
  ok("T2 hang + successful fallback", err === null && text === "MOCK_OK" && warned && ms >= 1800 && ms < 3900,
    `ms=${ms} warned=${warned} goodHits=${good.hits.length} err=${err && err.message}`);
  await hang.close(); await good.close();
}

// T3 — caller cancellation stays fatal (no failover)
{
  const hang = await startMock("hang");
  const good = await startMock("ok");
  process.env.TDAI_LLM_FALLBACK_TARGETS = `http://127.0.0.1:${good.port}/v1|-|mock-fallback`;
  const r = mkRunner({ primaryPort: hang.port, timeoutMs: 15000 });
  const ac = new AbortController();
  setTimeout(() => ac.abort(), 300);
  const t0 = Date.now();
  let err = null;
  try { await r.run({ taskId: "t3", systemPrompt: "s", prompt: "p", abortSignal: ac.signal }); } catch (e) { err = e; }
  const ms = Date.now() - t0;
  ok("T3 caller cancellation fatal (no failover)", err !== null && ms < 1500 && good.hits.length === 0,
    `ms=${ms} goodHits=${good.hits.length} err=${err && (err.name + ": " + err.message)}`);
  await hang.close(); await good.close();
}

// T4 — overall ceiling expiry stays fatal when every attempt hangs
{
  const hang1 = await startMock("hang");
  const hang2 = await startMock("hang");
  process.env.TDAI_LLM_FALLBACK_TARGETS = `http://127.0.0.1:${hang2.port}/v1|-|mock-fallback2`;
  const r = mkRunner({ primaryPort: hang1.port, timeoutMs: 3000 }); // perAttempt = 1500ms
  const t0 = Date.now();
  let err = null;
  try { await r.run({ taskId: "t4", systemPrompt: "s", prompt: "p" }); } catch (e) { err = e; }
  const ms = Date.now() - t0;
  ok("T4 overall ceiling expiry fatal", err !== null && ms >= 2400 && ms < 8000 && !String(err.message).includes("usedModel"),
    `ms=${ms} err=${err && err.message}`);
  await hang1.close(); await hang2.close();
}

// T5 — all candidates fail -> last error surfaces
{
  process.env.TDAI_LLM_FALLBACK_TARGETS = "http://127.0.0.1:9/v1|-|mock-dead";
  const r = mkRunner({ primaryPort: 9, timeoutMs: 4000 });
  let err = null;
  try { await r.run({ taskId: "t5", systemPrompt: "s", prompt: "p" }); } catch (e) { err = e; }
  ok("T5 all candidates fail -> last error surfaces", err !== null && String(err.message).length > 0 && !String(err.message).includes("usedModel"),
    `err=${err && err.message}`);
}

// T6 — failure with instanceId set reports the underlying error (no ReferenceError masking)
{
  const hang = await startMock("hang");
  delete process.env.TDAI_LLM_FALLBACK_TARGETS;
  const r = mkRunner({ primaryPort: hang.port, timeoutMs: 1200 }); // perAttempt = 600ms
  let err = null;
  try { await r.run({ taskId: "t6", systemPrompt: "s", prompt: "p", instanceId: "test-instance" }); } catch (e) { err = e; }
  ok("T6 no ReferenceError masking (instanceId set)", err !== null && !String(err.message).includes("usedModel is not defined") && String(err.message).length > 0,
    `err=${err && err.message}`);
  await hang.close();
}

// T7 — behavioural guard: caller cancels while a transient-failing request is
// in flight -> fatal, fallback never reached, no failover warning.
{
  const flaky = await startMock("err500");
  const good = await startMock("ok");
  process.env.TDAI_LLM_FALLBACK_TARGETS = `http://127.0.0.1:${good.port}/v1|-|mock-fallback`;
  const r = mkRunner({ primaryPort: flaky.port, timeoutMs: 15000 });
  const ac = new AbortController();
  const mark = logs.length;
  setTimeout(() => ac.abort(), 120);
  let err = null;
  try { await r.run({ taskId: "t7", systemPrompt: "s", prompt: "p", abortSignal: ac.signal }); } catch (e) { err = e; }
  const warned = logs.slice(mark).some(([lvl, m]) => lvl === "warn" && m.includes("model failover"));
  ok("T7 cancellation during transient failure -> fatal, no failover", err !== null && good.hits.length === 0 && !warned,
    `goodHits=${good.hits.length} warned=${warned} err=${err && err.message}`);
  await flaky.close(); await good.close();
}

// T7b — source invariant guard (deterministic): the ladder catch must throw on
// cancellation BEFORE considering transients (gate-2 correction 22-45-54-822-300495).
{
  let src = "";
  try { src = (await import("node:fs")).readFileSync(new URL("../src/adapters/standalone/llm-runner.ts", import.meta.url), "utf8"); } catch (e) { /* fall back below */ }
  const hasGuard = src.includes("const cancelled = !!callerSignal?.aborted || timeoutSignal.aborted;") &&
    src.includes("if (cancelled || (!transient && !ownAttemptTimeout)) {");
  ok("T7b source invariant: cancelled-first precedence guard present", src === "" ? false : hasGuard, `len=${src.length}`);
}

const fails = results.filter((r) => !r.pass).length;
console.log(`\nISSUE-712-REGRESSION: ${results.length - fails} PASS / ${fails} FAIL`);
await sleep(50);
process.exit(fails === 0 ? 0 : 1);
