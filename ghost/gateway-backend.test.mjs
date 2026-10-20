import test from "node:test";
import assert from "node:assert/strict";
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createServer } from "node:http";

// Variant 2 (Claude Code complete) requires Ghost WITHOUT an OpenChamber
// installation. The gateway therefore supports GHOST_BACKEND=claude-code:
// turns run through the claude CLI on the host and docker is never touched.
// BACKEND/PORT are bound at module import time, so the test imports the
// module through a cache-busting query URL after setting its env — the
// gateway then re-reads its own constants fresh.

async function post(port, payload) {
  return fetch(`http://127.0.0.1:${port}/v1/chat/completions`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload),
  });
}

test("claude-code backend serves turns via the claude CLI and parses result JSON", { skip: process.platform === "win32" }, async () => {
  const dir = mkdtempSync(join(tmpdir(), "ghost-backend-"));
  try {
    const stub = join(dir, "claude");
    // Emit claude's non-interactive JSON: { type:"result", result, usage }.
    // Record argv so the invocation policy is asserted, never guessed.
    writeFileSync(stub, `#!/bin/sh
printf '%s\\n' "$*" >> "${join(dir, "argv.log")}"
cat <<'JSON'
{"type":"result","subtype":"success","result":"claude-code backend synthetic answer","usage":{"input_tokens":7,"output_tokens":11}}
JSON
`);
    chmodSync(stub, 0o700);

    process.env.GHOST_BACKEND = "claude-code";
    process.env.GHOST_CLAUDE_BIN = stub;
    process.env.GHOST_GATEWAY_HOSTS = "127.0.0.1";
    const mod = await import(new URL("./ghost-gateway.mjs?backend=claude-code", import.meta.url).href);
    const srv = createServer(mod.handler);
    const port = await new Promise((res) => srv.listen(0, "127.0.0.1", () => res(srv.address().port)));
    try {
      const health = await (await fetch(`http://127.0.0.1:${port}/healthz`)).json();
      assert.equal(health.backend, "claude-code", "healthz reports the selected backend");

      const res = await post(port, { messages: [{ role: "user", content: "ghost reflection turn" }] });
      assert.equal(res.status, 200, "turn succeeds through the claude CLI");
      const done = await res.json();
      assert.equal(done.choices[0].message.content, "claude-code backend synthetic answer");
      assert.equal(done.usage.total_tokens, 18); // 7 input + 11 output
      // Tool-less reflection policy: the CLI runs with a deny-all toolkit and
      // no permission bypass.
      const argvLog = readFileSync(join(dir, "argv.log"), "utf8");
      // `$*` joins the argv with spaces, so the empty deny-all arg appears as
      // "--allowedTools <EOL>" — match the flag and its term position.
      assert.match(argvLog, /--allowedTools \n\r?|^--allowedTools $| --allowedTools $/m, "deny-all toolkit passed");
      assert.doesNotMatch(argvLog, /--dangerously-skip-permissions/);
      assert.match(argvLog, /-p /, "non-interactive print mode");
    } finally {
      srv.close();
      // The imported module (cached for this process) still points at the
      // stub binary; unset so later tests that import fresh copies are clean.
    }
  } finally {
    delete process.env.GHOST_BACKEND;
    delete process.env.GHOST_CLAUDE_BIN;
    rmSync(dir, { recursive: true, force: true });
  }
});
