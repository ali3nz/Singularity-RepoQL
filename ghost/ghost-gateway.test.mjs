import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createServer } from "node:http";

// ghost-gateway executes turns by shelling out to a docker CLI. These tests
// stub that CLI so the synthetic-turn path runs everywhere (CI included):
// the gateway/turn plumbing, json parsing, usage accounting and HTTP mapping
// are exercised end-to-end against a fake docker executable. A live check with
// the real docker CLI belongs to deployment acceptance, not unit CI.
//
// The stub is a Node script named "exec" (the first argument the gateway
// passes) plus a "version" script for the startup probe. Setting
// GHOST_DOCKER_BIN to process.execPath and running the test with the stub
// directory as cwd makes the gateway spawn `node exec ...` / `node version ...`
// on every platform. No POSIX shell or executable bit is required, so the same
// fixture is meaningful on native Windows.
function stubScript(body, exitCode) {
  const dir = mkdtempSync(join(tmpdir(), "ghost-gw-"));
  const output = [
    JSON.stringify({ type: "text", part: { text: body } }),
    JSON.stringify({ type: "step_finish", part: { tokens: { input: 3, output: 5, reasoning: 0 } } }),
    "",
  ].join("\n");
  writeFileSync(join(dir, "exec"), `process.stdout.write(${JSON.stringify(output)}); process.exit(${exitCode});\n`);
  writeFileSync(join(dir, "version"), "process.exit(0);\n");
  return { dir, bin: process.execPath };
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
  const previousCwd = process.cwd();
  const previousBin = process.env.GHOST_DOCKER_BIN;
  process.env.GHOST_DOCKER_BIN = stub.bin;
  process.chdir(stub.dir);
  try {
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
    }
  } finally {
    process.chdir(previousCwd);
    if (previousBin === undefined) delete process.env.GHOST_DOCKER_BIN;
    else process.env.GHOST_DOCKER_BIN = previousBin;
    rmSync(stub.dir, { recursive: true, force: true });
  }
});

test("docker exec failure maps to a 502 with the turn stderr, never a crash", async () => {
  const stub = stubScript("", 3);
  const previousCwd = process.cwd();
  const previousBin = process.env.GHOST_DOCKER_BIN;
  process.env.GHOST_DOCKER_BIN = stub.bin;
  process.chdir(stub.dir);
  try {
    const mod = await import(new URL("./ghost-gateway.mjs?v=2", import.meta.url).href);
    const { srv, port } = await listen(mod.handler);
    try {
      const res = await post(port, { messages: [{ role: "user", content: "failing turn" }] });
      assert.equal(res.status, 502);
      const err = await res.json();
      assert.match(err.error.message, /rc=3/);
    } finally {
      srv.close();
    }
  } finally {
    process.chdir(previousCwd);
    if (previousBin === undefined) delete process.env.GHOST_DOCKER_BIN;
    else process.env.GHOST_DOCKER_BIN = previousBin;
    rmSync(stub.dir, { recursive: true, force: true });
  }
});

test("a completed gateway turn is persisted where the dream cycle reads experiences", async () => {
  const stub = stubScript("persisted ghost answer", 0);
  const agentDir = mkdtempSync(join(tmpdir(), "ghost-conv-"));
  const previous = {
    bin: process.env.GHOST_DOCKER_BIN,
    dir: process.env.GHOST_CONVERSATIONS_DIR,
    cwd: process.cwd(),
  };
  process.env.GHOST_DOCKER_BIN = stub.bin;
  process.env.GHOST_CONVERSATIONS_DIR = join(agentDir, "conversations");
  process.chdir(stub.dir);
  try {
    const mod = await import(new URL("./ghost-gateway.mjs?v=4", import.meta.url).href);
    const { collectRecentConversations } = await import(new URL("./dream.mjs", import.meta.url).href);
    const { srv, port } = await listen(mod.handler);
    try {
      const res = await post(port, { user: "conv-roundtrip", messages: [{ role: "user", content: "remember the Thursday maintenance window" }] });
      assert.equal(res.status, 200);
      const lines = readFileSync(join(agentDir, "conversations", "conv-roundtrip", "messages.jsonl"), "utf8")
        .trim().split("\n").map((l) => JSON.parse(l));
      assert.deepEqual(lines.map((l) => l.message.role), ["user", "assistant"]);
      assert.equal(lines[0].message.content, "remember the Thursday maintenance window");
      assert.equal(lines[1].message.content, "persisted ghost answer");
      // Round trip through the consumer: the dream cycle must actually see it.
      const excerpt = collectRecentConversations(agentDir);
      assert.match(excerpt, /remember the Thursday maintenance window/);
      assert.match(excerpt, /persisted ghost answer/);
    } finally {
      srv.close();
    }
  } finally {
    process.chdir(previous.cwd);
    if (previous.bin === undefined) delete process.env.GHOST_DOCKER_BIN;
    else process.env.GHOST_DOCKER_BIN = previous.bin;
    if (previous.dir === undefined) delete process.env.GHOST_CONVERSATIONS_DIR;
    else process.env.GHOST_CONVERSATIONS_DIR = previous.dir;
    rmSync(stub.dir, { recursive: true, force: true });
    rmSync(agentDir, { recursive: true, force: true });
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
