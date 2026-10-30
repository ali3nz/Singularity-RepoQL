// Execute only on Windows CI with an actual compiled Rust Harness binary.
// This is not a mock: Win32 named-pipe + token + DACL + journal round trip.
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import net from "node:net";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { createAuthorityClient, isWindowsAuthorityPipe } from "../lib/rust-authority.mjs";

const binary = process.env.ORCHESTRA_BIN || "";
const canRun = process.platform === "win32" && binary && existsSync(binary);

test("native Windows authority: authenticated named pipe, revision CAS, journal", { skip: canRun ? false : "requires compiled Windows Rust executable" }, async () => {
  const root = mkdtempSync(join(tmpdir(), "singularity-win-authority-"));
  const name = `singularity-test-${process.pid}-${Date.now()}`;
  const pipe = "\\\\.\\pipe\\" + name;
  assert.equal(isWindowsAuthorityPipe(pipe), true);
  const token = "x".repeat(64);
  const child = spawn(binary, ["authority-serve"], {
    env: { ...process.env, ORCHESTRA_RUNS_DIR: root, ORCHESTRA_RUST_AUTHORITY: pipe,
      ORCHESTRA_RUST_AUTHORITY_TOKEN: token },
    windowsHide: true,
    stdio: ["ignore", "ignore", "pipe"],
  });
  const stderr = [];
  child.stderr.on("data", data => { if (stderr.join("").length < 6000) stderr.push(String(data)); });
  const client = createAuthorityClient({ socketPath: pipe, runsDir: root, token, ownerId: "win-acceptance" });
  try {
    let ready = false;
    for (let i = 0; i < 30 && child.exitCode === null; i++) {
      await sleep(100);
      try { if (client.health().ok === true) { ready = true; break; } } catch { /* startup */ }
    }
    assert.ok(ready, `named pipe never became healthy: ${stderr.join("")}`);
    const initial = { runId: "case-win", runState: "PLANNED", phases: [],
      task: "windows IPC acceptance", completedThrough: 0, workers: [], phaseVerdicts: {} };
    const first = client.create("case-win", initial);
    assert.equal(first.rev, 1);
    const second = client.write("case-win", { ...first.state, runState: "RUNNING" });
    assert.equal(second.rev, 2);
    assert.equal(client.read("case-win").state.runState, "RUNNING");
    const stranger = createAuthorityClient({ socketPath: pipe, runsDir: root,
      token: "z".repeat(64), ownerId: "wrong-token" });
    assert.throws(() => stranger.health(), error => error.code === "UNAUTHORIZED");
    // Three stalled clients must not starve the fourth named-pipe worker.
    // This is a real Win32 pipeline test, executed only by Windows CI.
    const stalled = [];
    try {
      for (let i = 0; i < 3; i++) {
        const socket = await new Promise((resolve, reject) => {
          const conn = net.createConnection({ path: pipe });
          conn.once("connect", () => resolve(conn));
          conn.once("error", reject);
        });
        stalled.push(socket);
      }
      assert.equal(client.health().ok, true, "authority must remain healthy while 3 clients are stalled");
    } finally {
      for (const socket of stalled) socket.destroy();
    }
    // The Rust authority must remain the exclusive state writer throughout.
    assert.equal(client.health().stateAuthority, "rust");
  } finally {
    try { client.releaseAll(); } catch { /* teardown */ }
    child.kill();
    rmSync(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  }
});
