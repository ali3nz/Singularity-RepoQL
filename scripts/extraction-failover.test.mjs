import { test, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import http from "node:http";

// Regression coverage for the extraction-failover router's transport bounds:
//   1. the hop deadline spans response HEADERS **and body** (a provider that
//      stalls mid-body is cut, not held open forever);
//   2. oversized request bodies are rejected with 413;
//   3. healthy providers stream through.
// One module instance + one stub upstream shared by all cases: the router
// config is read once at import, so env and ports stay fixed for the file and
// the stub server switches behaviour per case instead.

const SECRETS = mkdtempSync(join(tmpdir(), "extract-failover-"));
writeFileSync(join(SECRETS, "groq-api-key"), "test-key\n");
writeFileSync(join(SECRETS, "cohere-api-key"), "test-key\n");
process.env.EXTRACTION_FAILOVER_SECRETS_DIR = SECRETS;
process.env.EXTRACTION_FAILOVER_TIMEOUT_MS = "1500";
// Port collision on a shared host must not fail the suite: probe a free
// ephemeral port once, then bind the router to it.
const routerPort = await new Promise((resolve) => {
  const probe = http.createServer();
  probe.listen(0, "127.0.0.1", () => {
    const p = probe.address().port;
    probe.close(() => resolve(p));
  });
});
process.env.EXTRACTION_FAILOVER_PORT = String(routerPort);
process.env.EXTRACTION_FAILOVER_MAX_BODY_BYTES = String(4 * 1024);
process.env.EXTRACTION_FAILOVER_SKIP = "cohere-a+,groq-20b";

const MODE = { behaviour: "complete" };

const upstream = await new Promise((resolve) => {
  const srv = http.createServer((_req, res) => {
    if (MODE.behaviour === "fail") {
      res.writeHead(503, { "Content-Type": "application/json" });
      res.end('{"error":{"message":"upstream down"}}');
      return;
    }
    if (MODE.behaviour === "stall") {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.write('{"choices":[{"message":{"content":"par');
      const t = setTimeout(() => { try { res.end('tial"}}'); } catch { /* gone */ } }, 30_000);
      t.unref?.();
      res.on("close", () => clearTimeout(t));
      return;
    }
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end('{"choices":[{"message":{"content":"synthetic extraction answer"}}]}');
  });
  srv.listen(0, "127.0.0.1", () => resolve({ srv, url: `http://127.0.0.1:${srv.address().port}/v1` }));
});
process.env.EXTRACTION_FAILOVER_GROQ_BASE = upstream.url;

const mod = await import(new URL("./extraction-failover.mjs", import.meta.url).href);
// Deliberately awaited at top level: the router config is read at import and
// the server binds during import, so every test below trusts this ready state.
let readyState = "unknown";
try {
  const h = await (await fetch(`http://127.0.0.1:${routerPort}/health`)).json();
  readyState = JSON.stringify(h);
} catch (e) { readyState = "health-failed: " + (e?.cause?.code || e?.message || e); }
console.warn("router top-level health:", readyState);
async function ready() {
  let lastErr = "";
  for (let i = 0; i < 50; i++) {
    try {
      const j = await (await fetch(`http://127.0.0.1:${routerPort}/health`)).json();
      if (j.status === "ok") return;
      lastErr = JSON.stringify(j);
    } catch (e) { lastErr = String(e?.message || e); }
    await new Promise((r) => setTimeout(r, 100));
  }
  throw new Error("router did not become ready: " + lastErr);
}

function post(body) {
  return fetch(`http://127.0.0.1:${routerPort}/chat/completions`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: typeof body === "string" ? body : JSON.stringify(body),
  });
}

test("healthy provider is proxied through end-to-end", async () => {
  await ready();
  MODE.behaviour = "complete";
  const res = await post({ messages: [{ role: "user", content: "happy path" }] });
  assert.equal(res.status, 200);
  const doc = await res.json();
  assert.equal(doc.choices[0].message.content, "synthetic extraction answer");
});

test("oversized request bodies are rejected with 413 before any provider call", async () => {
  await ready();
  MODE.behaviour = "fail"; // would surface as 503/502 rather than 413 if the router didn't reject first
  const res = await post(JSON.stringify({ messages: [{ role: "user", content: "x".repeat(16 * 1024) }] }));
  assert.equal(res.status, 413);
  const err = await res.json();
  assert.match(err.error.message, /exceeds/);
});

test("hop deadline aborts a provider that stalls in the response body", async () => {
  await ready();
  MODE.behaviour = "stall";
  const started = Date.now();
  let completed = false;
  await Promise.race([
    (async () => {
      const res = await post({ messages: [{ role: "user", content: "trigger the stalled body" }] });
      assert.equal(res.status, 200); // headers are already forwarded
      await assert.rejects(res.text()); // body read is cut by the hop deadline
      completed = true;
    })(),
    new Promise((_, reject) => setTimeout(() => reject(new Error("router held the stalled body open for 8s")), 8000)),
  ]);
  assert.ok(completed, "router did not terminate the stalled stream");
  assert.ok(Date.now() - started < 8000);
});

test("provider failure before headers maps to the upstream status", async () => {
  await ready();
  MODE.behaviour = "fail";
  const res = await post({ messages: [{ role: "user", content: "last provider fails" }] });
  assert.equal(res.status, 503);
});

// Teardown AFTER the tests: open server handles (and their lingering client
// sockets) keep the node --test event loop alive forever, so destroy them
// explicitly once the tests are done.
after(async () => {
  for (const srv of [mod.server, upstream.srv]) {
    if (!srv) continue;
    try { srv.closeAllConnections?.(); } catch { /* gone */ }
    await new Promise((r) => srv.close(r)).catch(() => {});
  }
  try { rmSync(SECRETS, { recursive: true, force: true }); } catch { /* gone */ }
});
