import { test } from "node:test";
import assert from "node:assert/strict";
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createServer } from "node:http";

// ghost-gateway executes turns by shelling out to a docker CLI. These tests
// stub that CLI so the synthetic-turn path runs everywhere (CI included):
// the gateway/turn plumbing, json parsing, usage accounting and HTTP mapping
// are exercised end-to-end against a fake `docker exec`. A live check with
// the real docker CLI belongs to deployment acceptance, not unit CI.

function stubScript(body, exitCode) {
  const dir = mkdtempSync(join(tmpdir(), "ghost-gw-"));
  const file = join(dir, "docker");
  writeFileSync(file, `#!/bin/sh\ncat > /dev/null\ncat <<'JSON'\n{"type":"text","part":{"text":"${body}"}}\n{"type":"step_finish","part":{"tokens":{"input":3,"output":5,"reasoning":0}}}\nJSON\nexit ${exitCode}\n`);
  chmodSync(file, 0o700);
  return { dir, file };
}

function listen(handler) {
  return new Promise((resolve) => {
    const srv = createServer(handler);
    srv.listen(0, "127.0.0.1", () => resolve({ srv, port: srv.address().port }));
  });
}

async function post(port, payload) {
  return fetch(`http://127.0.0.1:${port}/v1/chat/completions`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload),
  });
}

test("synthetic turn executes through a stubbed docker exec and returns the agent answer", async () => {
  const stub = stubScript("synthetic ghost answer", 0);
  process.env.GHOST_DOCKER_BIN = stub.file;
  const mod = await import(new URL("./ghost-gateway.mjs", import.meta.url).href);
  const { srv, port } = await listen(mod.handler);
  try {
    const health = await (await fetch(`http://127.0.0.1:${port}/healthz`)).json();
    assert.equal(health.ok, true);
    const res = await post(port, { messages: [{ role: "user", content: "echo a synthetic turn" }] });
    assert.equal(res.status, 200);
    const done = await res.json();
    assert.equal(done.choices[0].message.content, "synthetic ghost answer");
    assert.equal(done.usage.total_tokens, 8); // 3 input + 5 output
    assert.equal(done.served.agent, "ghost");
  } finally {
    srv.close();
    rmSync(stub.dir, { recursive: true, force: true });
  }
});

test("docker exec failure maps to a 502 with the turn stderr, never a crash", async () => {
  const stub = stubScript("", 3);
  process.env.GHOST_DOCKER_BIN = stub.file;
  const mod = await import(new URL("./ghost-gateway.mjs?v=2", import.meta.url).href);
  const { srv, port } = await listen(mod.handler);
  try {
    const res = await post(port, { messages: [{ role: "user", content: "failing turn" }] });
    assert.equal(res.status, 502);
    const err = await res.json();
    assert.match(err.error.message, /rc=3/);
  } finally {
    srv.close();
    rmSync(stub.dir, { recursive: true, force: true });
  }
});

test("missing docker CLI rejects the turn with a configuration error", async () => {
  process.env.GHOST_DOCKER_BIN = join(tmpdir(), "definitely-not-docker");
  const mod = await import(new URL("./ghost-gateway.mjs?v=3", import.meta.url).href);
  const { srv, port } = await listen(mod.handler);
  try {
    const res = await post(port, { messages: [{ role: "user", content: "no docker here" }] });
    assert.equal(res.status, 502);
    const err = await res.json();
    assert.match(err.error.message, /docker exec unavailable|docker CLI not available/);
  } finally {
    srv.close();
  }
});
