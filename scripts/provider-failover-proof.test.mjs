// Regression tests for the §6 failover acceptance:
//   1. the controlled-fallback proof runs against the REAL router code with
//      LOCAL mocks + the authorized injection knob and verifies every required
//      assertion (secondary serves, exact attempt sequence, permanent 401 not
//      retried, knob removed after restart);
//   2. the provider-file onboarding path: a validated OpenAI-compatible
//      provider pair in the secrets dir becomes a hop; an invalid one never
//      does.
// Run: node --test scripts/provider-failover-proof.test.mjs
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import http from "node:http";
import { runControlledFailoverProof } from "./runtime-proofs.mjs";

const ROOT = resolve(import.meta.dirname, "..");

test("controlled failover proof: every §6 assertion holds against the real router code", async () => {
  const r = await runControlledFailoverProof({ root: ROOT, overallTimeout: 90_000 });
  assert.equal(r.state, "VERIFIED", r.detail);
  assert.match(r.detail, /lastModel=cohere-a\+/);
  assert.match(r.detail, /exactly 2/);
  assert.match(r.detail, /inject=null/);
});

test("injection knob: retryable status fails over, permanent status surfaces and the knob is removed", async () => {
  // A dedicated secrets dir + two mock upstreams + a dedicated router child.
  const secrets = mkdtempSync(join(tmpdir(), "inject-knob-secrets-"));
  writeFileSync(join(secrets, "groq-api-key"), "k-a");
  writeFileSync(join(secrets, "cohere-api-key"), "k-b");
  const mk = (tag) => new Promise((res) => {
    const s = http.createServer((_q, r2) => {
      const p = JSON.stringify({ id: tag, choices: [{ message: { role: "assistant", content: tag } }] });
      r2.writeHead(200, { "Content-Length": Buffer.byteLength(p) });
      r2.end(p);
    });
    s.listen(0, "127.0.0.1", () => res({ s, port: s.address().port }));
  });
  const a = await mk("A"), b = await mk("B");
  const frePort = () => new Promise((res) => {
    const probe = http.createServer();
    probe.listen(0, "127.0.0.1", () => { const p = probe.address().port; probe.close(() => res(p)); });
  });
  const children = [];
  const spawnRouter = async (inject) => {
    const port = await frePort();
    const c = spawn(process.execPath, [join(ROOT, "scripts", "extraction-failover.mjs")], {
      env: {
        ...process.env,
        EXTRACTION_FAILOVER_SECRETS_DIR: secrets,
        EXTRACTION_FAILOVER_GROQ_BASE: `http://127.0.0.1:${a.port}/v1`,
        EXTRACTION_FAILOVER_COHERE_BASE: `http://127.0.0.1:${b.port}/v1`,
        EXTRACTION_FAILOVER_PORT: String(port),
        EXTRACTION_FAILOVER_TIMEOUT_MS: "3000",
        EXTRACTION_FAILOVER_SKIP: "groq-20b",
        ...(inject ? { EXTRACTION_FAILOVER_INJECT: inject } : {}),
      },
      stdio: ["ignore", "ignore", "ignore"],
    });
    children.push(c);
    for (let i = 0; i < 50; i++) {
      try {
        const h = await (await fetch(`http://127.0.0.1:${port}/health`)).json();
        if (h.status === "ok") return { port, h };
      } catch { /* not up yet */ }
      await new Promise((r) => setTimeout(r, 100));
    }
    throw new Error("router did not start");
  };
  try {
    let { port, h } = await spawnRouter("groq-120b:503");
    assert.equal(h.inject, "groq-120b:503", "the knob is visible in /health while active");
    for (let i = 0; i < 5; i++) {
      const r = await (await fetch(`http://127.0.0.1:${port}/chat/completions`, {
        method: "POST", headers: { "content-type": "application/json" },
        body: JSON.stringify({ messages: [{ role: "user", content: "x" }], max_tokens: 1 }),
      })).json();
      // count = 1: exactly the FIRST hop of the FIRST request is synthetic; from
      // then on the primary serves again (i === 0 → failed over to "B").
      assert.equal(r.choices[0].message.content, i === 0 ? "B" : "A");
    }

    children.at(-1).kill("SIGKILL");
    ({ port, h } = await spawnRouter("groq-120b:401"));
    const r = await fetch(`http://127.0.0.1:${port}/chat/completions`, {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ messages: [{ role: "user", content: "x" }], max_tokens: 1 }),
    });
    assert.equal(r.status, 401, "a permanent injected failure surfaces to the caller");
    h = await (await fetch(`http://127.0.0.1:${port}/health`)).json();
    assert.equal(h.failovers, 0, "the permanent failure is never masked by fallback");
    assert.equal(h.attempts, 1, "the permanent failure is never retried");

    children.at(-1).kill("SIGKILL");
    ({ port, h } = await spawnRouter(null));
    assert.equal(h.inject, null, "without the env the knob is provably inactive");
  } finally {
    for (const c of children) { try { c.kill("SIGKILL"); } catch { /* gone */ } }
    try { a.s.closeAllConnections?.(); await new Promise((r) => a.s.close(r)); } catch { /* gone */ }
    try { b.s.closeAllConnections?.(); await new Promise((r) => b.s.close(r)); } catch { /* gone */ }
    rmSync(secrets, { recursive: true, force: true });
  }
});

test("provider onboarding: a valid provider pair becomes a hop, an invalid one never does", async () => {
  const secrets = mkdtempSync(join(tmpdir(), "onboard-provider-"));
  writeFileSync(join(secrets, "groq-api-key"), "k-a");
  writeFileSync(join(secrets, "cohere-api-key"), "k-b");
  writeFileSync(join(secrets, "nvidia-api-key"), "k-c");
  writeFileSync(join(secrets, "nvidia-api-provider.json"),
    JSON.stringify({ name: "nvidia-test", base: "https://integrate.api.nvidNOCLOUD.com/v1".replace("NOCLOUD", ""), model: "m1" }));
  // an invalid one: plain http base is refused
  writeFileSync(join(secrets, "insecure-api-key"), "k-d");
  writeFileSync(join(secrets, "insecure-api-provider.json"),
    JSON.stringify({ name: "insecure", base: "http://example.invalid/v1", model: "m2" }));
  writeFileSync(join(secrets, "unblessed-api-key"), "k-e"); // no provider file at all
  const mk = () => new Promise((res) => {
    const s = http.createServer((_q, r2) => {
      const p = JSON.stringify({ choices: [{ message: { content: "ok" } }] });
      r2.writeHead(200, { "Content-Length": Buffer.byteLength(p) });
      r2.end(p);
    });
    s.listen(0, "127.0.0.1", () => res({ s, port: s.address().port }));
  });
  const up = await mk();
  const c = spawn(process.execPath, [join(ROOT, "scripts", "extraction-failover.mjs")], {
    env: {
      ...process.env,
      EXTRACTION_FAILOVER_SECRETS_DIR: secrets,
      EXTRACTION_FAILOVER_GROQ_BASE: `http://127.0.0.1:${up.port}/v1`,
      EXTRACTION_FAILOVER_COHERE_BASE: `http://127.0.0.1:${up.port}/v1`,
      EXTRACTION_FAILOVER_PORT: "0",
      EXTRACTION_FAILOVER_SKIP: "groq-20b,cohere-a+",
    },
    stdio: ["ignore", "pipe", "ignore"],
  });
  try {
    let ready = "";
    await new Promise((res, rej) => {
      const t = setTimeout(() => rej(new Error("router did not report READY")), 10_000);
      c.stdout.on("data", (d) => {
        ready += String(d);
        if (ready.includes("EXTRACTION_FAILOVER_READY")) { clearTimeout(t); res(); }
      });
      c.on("close", (code) => { if (code) { clearTimeout(t); rej(new Error("router exited " + code)); } });
    });
    // on port 0 the real port is not printed; the READY line lists the ladder
    assert.match(ready, /\bnvidia-test\b/, "the onboarded provider is a hop");
    assert.doesNotMatch(ready, /\binsecure\b/, "a plain-http provider base is refused");
    assert.doesNotMatch(ready, /\bunblessed\b/, "a key without a provider definition file is not a hop");
  } finally {
    c.kill("SIGKILL");
    try { up.s.closeAllConnections?.(); await new Promise((r) => up.s.close(r)); } catch { /* gone */ }
    rmSync(secrets, { recursive: true, force: true });
  }
});
