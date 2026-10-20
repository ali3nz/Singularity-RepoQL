import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, rmSync, utimesSync, renameSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawn } from "node:child_process";
import {
  acquireDreamLock,
  releaseDreamLock,
  restoreNewerOwner,
  createOwnerRecord,
  linkUnsupported,
  DREAM_STEPS,
  dreamStepPrompts,
  parseMemoryEntries,
  applyMemoryEntries,
  assertOwnMemfs,
  cleanErr,
  runDream,
  makeLadderCallImpl,
} from "./dream.mjs";

test("DREAM_STEPS has the 6-step reflection pipeline", () => {
  assert.deepEqual(DREAM_STEPS, [
    "experiences",
    "related",
    "patterns",
    "evolution",
    "consolidate",
    "summary",
  ]);
  const prompts = dreamStepPrompts("ghost");
  assert.equal(prompts.length, 6);
  for (const p of prompts) {
    assert.ok(typeof p.prompt === "string" && p.prompt.length > 30);
  }
});

test("parseMemoryEntries parses valid JSON entries and filters out invalid files", () => {
  const raw = `{"entries":[
    {"file":"MEMORY.md","text":"2026-10-19 Prefer explicit readiness checks before declaring services up.","confidence":"high"},
    {"file":"../escape.md","text":"2026-10-19 Should be rejected by filename regex","confidence":"low"},
    {"file":"short.md","text":"too short","confidence":"low"}
  ]}`;
  const parsed = parseMemoryEntries(raw);
  assert.equal(parsed.length, 1);
  assert.equal(parsed[0].file, "MEMORY.md");
  assert.equal(parsed[0].confidence, "high");
});

test("assertOwnMemfs blocks path traversal and sibling references", () => {
  const tmp = mkdtempSync(join(tmpdir(), "ghost-memfs-"));
  try {
    assert.equal(assertOwnMemfs(tmp, ["MEMORY.md", "persona.md"], "explorer"), true);
    assert.throws(() => assertOwnMemfs(tmp, ["../outside.md"], "explorer"), /DREAM_ESCAPE/);
    assert.throws(() => assertOwnMemfs(tmp, ["explorer-notes.md"], "explorer"), /DREAM_CROSS_AGENT/);
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});

test("cleanErr redacts bearer tokens and sk- keys", () => {
  const dirty = "Failed with Authorization=Bearer secret_token_1234567890 and key sk-abcdef1234567890";
  const cleaned = cleanErr(dirty);
  assert.ok(!cleaned.includes("secret_token_1234567890"));
  assert.ok(!cleaned.includes("sk-abcdef1234567890"));
  assert.ok(cleaned.includes("<redacted>"));
});

test("model ladder advances on retryable failure and records hops", async () => {
  const state = {};
  let modelCalls = [];
  const fakeFetch = async (url, opts = {}) => {
    const body = JSON.parse(opts.body);
    modelCalls.push(body.model);
    if (body.model === "primary-broken") {
      return { ok: false, status: 429, text: async () => "rate limited" };
    }
    return { ok: true, status: 200, json: async () => ({ choices: [{ message: { content: "Ladder fallback reflection output, long enough for the length threshold." } }] }) };
  };
  const call = makeLadderCallImpl(["primary-broken", "fallback-ok"], {
    gatewayUrl: "http://127.0.0.1:1/v1", key: "", state, deadlineMs: null, fetchImpl: fakeFetch,
  });
  const out = await call([{ role: "user", content: "dream step" }], 500);
  assert.match(out, /Ladder fallback/);
  assert.deepEqual(state.models_used, ["primary-broken", "fallback-ok"]);
  assert.equal(state.fallback_attempts, 1, "one recorded hop");
  await call([{ role: "user", content: "dream step 2" }], 500);
  assert.deepEqual(modelCalls, ["primary-broken", "fallback-ok", "fallback-ok"], "sticky fallback: no re-sending to the broken primary within one call chain");

  // Non-retryable failure (e.g. 401) goes straight through as an error.
  const state2 = {};
  const call2 = makeLadderCallImpl(["a", "b"], {
    gatewayUrl: "http://127.0.0.1:1/v1", key: "", state: state2, deadlineMs: null,
    fetchImpl: async () => ({ ok: false, status: 401, text: async () => "denied" }),
  });
  await assert.rejects(() => call2([{ role: "user", content: "x" }], 500), /401/);
  assert.equal(state2.fallback_attempts, 0, "auth failures are not retried across providers");

  // Deadline enforcement: below DREAM_MIN_CALL_MS the call is refused.
  const state3 = {};
  const call3 = makeLadderCallImpl(["a"], {
    gatewayUrl: "http://127.0.0.1:1/v1", key: "", state: state3, deadlineMs: Date.now() + 100,
    fetchImpl: async () => { throw new Error("should not be called"); },
  });
  await assert.rejects(() => call3([{ role: "user", content: "x" }], 500), /deadline/);
});

test("runDream executes all 6 steps with mock callImpl and commits consolidated memory", async () => {
  const tmp = mkdtempSync(join(tmpdir(), "ghost-dream-run-"));
  try {
    const memDir = join(tmp, "memory");
    mkdirSync(memDir, { recursive: true });
    writeFileSync(join(memDir, "persona.md"), "# Persona — Ghost\nPersistent companion.", "utf8");
    writeFileSync(join(memDir, "MEMORY.md"), "# Ghost Long-Term Reflections\n", "utf8");

    let callIdx = 0;
    const mockCall = async (_messages, _maxTokens) => {
      callIdx++;
      if (callIdx === 5) {
        return JSON.stringify({
          entries: [
            {
              file: "MEMORY.md",
              text: "2026-10-19 Verified that checkpointed dream cycles commit cleanly to local git memory.",
              confidence: "high",
            },
          ],
        });
      }
      return `Step ${callIdx} reflection output with enough characters to pass the length threshold.`;
    };

    const res = await runDream({
      agentId: "ghost",
      agentDir: tmp,
      force: true,
      fresh: true,
      callImpl: mockCall,
      now: () => new Date("2026-10-19T12:00:00Z"),
    });

    assert.equal(res.status, "complete");
    assert.equal(callIdx, 6);
    assert.ok(existsSync(res.journal));
    const memContent = readFileSync(join(memDir, "MEMORY.md"), "utf8");
    assert.ok(memContent.includes("checkpointed dream cycles commit cleanly"));
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});

test("dream lock is exclusive and releases on the owning handle only", () => {
  const tmp = mkdtempSync(join(tmpdir(), "dream-lock-"));
  const agentDir = join(tmp, "data", "ghost");
  try {
    const h1 = acquireDreamLock(agentDir);
    assert.equal(h1.acquired, true);
    const lockPath = h1.path;
    assert.ok(existsSync(lockPath), "lock file must exist while held");
    const h2 = acquireDreamLock(agentDir);
    assert.equal(h2.acquired, false);
    assert.equal(h2.busy, true);
    assert.ok(existsSync(lockPath), "a busy contender must not remove the owner's lock");
    releaseDreamLock(h1);
    assert.ok(!existsSync(lockPath), "release removes the owner's lock");
    const h3 = acquireDreamLock(agentDir);
    assert.equal(h3.acquired, true, "lock is reacquirable after release");
    releaseDreamLock(h3);
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});

test("stale lock takeover: a dead owner and an expired mtime are reclaimed", () => {
  const tmp = mkdtempSync(join(tmpdir(), "dream-lock-stale-"));
  const agentDir = join(tmp, "data", "ghost");
  const lockPath = join(agentDir, "dreams", ".dream.lock");
  try {
    mkdirSync(join(agentDir, "dreams"), { recursive: true });

    // 1. the recorded owner is dead -> the lock is taken over
    writeFileSync(lockPath, JSON.stringify({ pid: 999999, createdAt: new Date().toISOString() }), { mode: 0o600 });
    const h1 = acquireDreamLock(agentDir);
    assert.equal(h1.acquired, true, "a lock whose owner is dead is taken over");
    assert.equal(JSON.parse(readFileSync(lockPath, "utf8")).pid, process.pid, "the new owner is recorded");
    releaseDreamLock(h1);

    // 2. the lock file is older than the stale window -> taken over
    writeFileSync(lockPath, JSON.stringify({ pid: process.pid, createdAt: new Date().toISOString() }), { mode: 0o600 });
    const old = new Date(Date.now() - 60 * 60 * 1000);
    utimesSync(lockPath, old, old);
    const h2 = acquireDreamLock(agentDir, { staleMs: 1000 });
    assert.equal(h2.acquired, true, "an expired lock is taken over");
    releaseDreamLock(h2);
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});

test("a live owner is never displaced and a busy contender preserves the owner record", () => {
  const tmp = mkdtempSync(join(tmpdir(), "dream-lock-live-"));
  const agentDir = join(tmp, "data", "ghost");
  try {
    const h1 = acquireDreamLock(agentDir);
    assert.equal(h1.acquired, true);
    const before = readFileSync(h1.path, "utf8");
    const h2 = acquireDreamLock(agentDir, { staleMs: 1000 });
    assert.equal(h2.acquired, false, "a fresh lock of a live owner is not taken over");
    assert.equal(h2.busy, true);
    assert.equal(readFileSync(h1.path, "utf8"), before, "the owner's record is preserved byte for byte");
    releaseDreamLock(h1);
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});

test("a newer owner that appears during a takeover is restored, never destroyed", () => {
  const tmp = mkdtempSync(join(tmpdir(), "dream-lock-restore-"));
  const agentDir = join(tmp, "data", "ghost");
  const lockPath = join(agentDir, "dreams", ".dream.lock");
  try {
    mkdirSync(join(agentDir, "dreams"), { recursive: true });
    writeFileSync(lockPath, JSON.stringify({ pid: 4242 }), { mode: 0o600 });
    const taken = `${lockPath}.take-test`;
    renameSync(lockPath, taken);
    // a NEWER owner wrote its record while the stale one was being judged
    writeFileSync(taken, JSON.stringify({ pid: 9999 }), { mode: 0o600 });
    restoreNewerOwner(taken, lockPath);
    assert.ok(existsSync(lockPath), "the newer owner's lock is back in place");
    assert.equal(JSON.parse(readFileSync(lockPath, "utf8")).pid, 9999, "the newer owner's record is intact");
    assert.ok(!existsSync(taken), "the renamed copy is cleaned up");
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});

test("two concurrent dream processes: exactly one acquires the lock", async () => {
  const tmp = mkdtempSync(join(tmpdir(), "dream-lock-race-"));
  const agentDir = join(tmp, "data", "ghost");
  try {
    mkdirSync(join(agentDir, "dreams"), { recursive: true });
    const mod = new URL("./dream.mjs", import.meta.url).pathname;
    const runner = `import(${JSON.stringify(mod)}).then((m) => {
      const h = m.acquireDreamLock(${JSON.stringify(agentDir)});
      if (h.acquired) { console.log("WON"); setTimeout(() => { m.releaseDreamLock(h); process.exit(0); }, 500); }
      else { console.log("BUSY"); process.exit(0); }
    });`;
    const run = () => new Promise((res) => {
      const c = spawn(process.execPath, ["-e", runner]);
      let out = "";
      c.stdout.on("data", (d) => { out += String(d); });
      c.on("close", () => res(out));
    });
    const outs = await Promise.all([run(), run()]);
    const wins = outs.filter((o) => o.includes("WON")).length;
    assert.equal(wins, 1, `exactly one process may hold the dream lock (got ${wins}: ${outs.join("|")})`);
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});

test("journal outcomes: only a completed consolidation ends the day", async () => {
  const tmp = mkdtempSync(join(tmpdir(), "ghost-dream-outcome-"));
  const today = "2026-10-20";
  try {
    const memDir = join(tmp, "memory");
    mkdirSync(memDir, { recursive: true });
    writeFileSync(join(memDir, "persona.md"), "# Persona — Ghost\nPersistent companion.", "utf8");
    writeFileSync(join(memDir, "MEMORY.md"), "# Ghost Long-Term Reflections\n", "utf8");
    mkdirSync(join(tmp, "dreams"), { recursive: true });

    // an UNKNOWN outcome never ends the day
    writeFileSync(join(tmp, "dreams", `${today}.md`), `# Dream ${today} (ghost) — checkpointed\n\n- outcome: capped\n`, "utf8");
    let calls = 0;
    const res = await runDream({
      agentId: "ghost", agentDir: tmp, fresh: false,
      callImpl: async () => { calls++; return "Step output with enough characters to pass the length threshold."; },
      now: () => new Date("2026-10-20T12:00:00Z"),
    });
    assert.notEqual(res.status, "not-due", "an unknown outcome never blocks the day's dream");
    assert.ok(calls > 0, "the dream actually ran");

    // a COMPLETED consolidation ends the day and is not duplicated
    const completeDir = join(tmp, "complete", "dreams");
    mkdirSync(completeDir, { recursive: true });
    writeFileSync(join(completeDir, `${today}.md`), `# Dream ${today} (ghost) — complete\n\n- outcome: complete\n`, "utf8");
    const agentDir2 = join(tmp, "complete");
    mkdirSync(join(agentDir2, "memory"), { recursive: true });
    writeFileSync(join(agentDir2, "memory", "persona.md"), "# Persona\n", "utf8");
    writeFileSync(join(agentDir2, "memory", "MEMORY.md"), "# Memory\n", "utf8");
    let calls2 = 0;
    const res2 = await runDream({
      agentId: "ghost", agentDir: agentDir2, fresh: false,
      callImpl: async () => { calls2++; return "Step output with enough characters to pass the length threshold."; },
      now: () => new Date("2026-10-20T12:00:00Z"),
    });
    assert.equal(res2.status, "not-due", "a completed consolidation ends the day");
    assert.equal(calls2, 0, "a completed day runs no model call");
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});

// ── N-h: the lock must work on filesystems without hard links ────────────────

test("a filesystem without hard links falls back to an exclusive owner record (N-h)", () => {
  const dir = mkdtempSync(join(tmpdir(), "dream-lock-nolink-"));
  const path = join(dir, ".dream.lock");
  const record = JSON.stringify({ pid: process.pid, createdAt: new Date().toISOString(), token: "t1" });

  // a WSL /mnt/c drive answers EPERM/ENOTSUP/EXDEV for link()
  for (const code of ["EPERM", "ENOTSUP", "EXDEV"]) {
    const r = createOwnerRecord(path, record, {
      link: () => { const e = new Error("link failed"); e.code = code; throw e; },
    });
    assert.equal(r.created, true, `${code}: the fallback must create the record`);
    assert.equal(r.mode, "exclusive");
    rmSync(path, { force: true });
  }
  rmSync(dir, { recursive: true, force: true });
});

test("the fallback writes the owner record in place and never overwrites a live owner (N-h)", () => {
  const dir = mkdtempSync(join(tmpdir(), "dream-lock-fallback-"));
  const path = join(dir, ".dream.lock");
  const record = JSON.stringify({ pid: 4242, createdAt: new Date().toISOString(), token: "owner-1" });
  const failLink = () => { const e = new Error("no links"); e.code = "EPERM"; throw e; };

  const first = createOwnerRecord(path, record, { link: failLink });
  assert.equal(first.created, true);
  const onDisk = JSON.parse(readFileSync(path, "utf8"));
  assert.equal(onDisk.pid, 4242);
  assert.equal(onDisk.token, "owner-1");

  // a contender: the record exists → no takeover, and the record is intact
  const second = createOwnerRecord(path, JSON.stringify({ pid: 1, token: "other" }), { link: failLink });
  assert.equal(second.created, false, "a live owner is never displaced");
  assert.equal(JSON.parse(readFileSync(path, "utf8")).token, "owner-1");
  rmSync(dir, { recursive: true, force: true });
});

test("a filesystem that cannot create the record at all fails with an actionable error (N-h)", () => {
  const dir = mkdtempSync(join(tmpdir(), "dream-lock-nocreate-"));
  const path = join(dir, ".dream.lock");
  const boom = (code) => () => { const e = new Error(code); e.code = code; throw e; };
  assert.throws(() => createOwnerRecord(path, "{}", {
    link: boom("EPERM"),
    open: boom("EPERM"),
  }), /EPERM/);
  rmSync(dir, { recursive: true, force: true });
});

test("a LIVE owner with a fresh record is never displaced (N-h)", () => {
  // The owner is this very process: its pid is alive, so the lock is busy.
  // (A dead pid is a legitimate stale takeover and is covered by the
  // stale-lock tests above — it must not be used to exercise "live owner".)
  const dir = mkdtempSync(join(tmpdir(), "dream-lock-live-"));
  mkdirSync(join(dir, "dreams"), { recursive: true });
  const path = join(dir, "dreams", ".dream.lock"); // the real lock location
  const now = Date.now();
  writeFileSync(path, JSON.stringify({ pid: process.pid, createdAt: new Date(now).toISOString(), token: "live" }));
  utimesSync(path, now / 1000, now / 1000);
  const lock = acquireDreamLock(dir, { nowMs: now });
  assert.equal(lock.acquired, false, "a live owner is never displaced");
  assert.equal(JSON.parse(readFileSync(path, "utf8")).token, "live", "the live owner record is preserved");
  rmSync(dir, { recursive: true, force: true });
});

test("an empty owner record inside the write grace is never taken over (N-h)", () => {
  // A record that is still being written (empty, fresh mtime) must be treated
  // as an owner in progress: a contender waits and does not take it over.
  const dir = mkdtempSync(join(tmpdir(), "dream-lock-grace-"));
  mkdirSync(join(dir, "dreams"), { recursive: true });
  const path = join(dir, "dreams", ".dream.lock"); // the real lock location
  writeFileSync(path, "");
  const now = Date.now();
  utimesSync(path, now / 1000, now / 1000);
  const lock = acquireDreamLock(dir, { nowMs: now });
  assert.equal(lock.acquired, false, "an empty record inside the write grace is never taken over");
  rmSync(dir, { recursive: true, force: true });
});

test("the lock-unsupported error codes are classified correctly (N-h)", () => {
  for (const code of ["EPERM", "ENOTSUP", "EXDEV", "EMLINK", "ENOSYS", "EOPNOTSUPP"]) {
    assert.equal(linkUnsupported({ code }), true, code);
  }
  for (const code of ["EEXIST", "ENOENT", "EACCES"]) {
    assert.equal(linkUnsupported({ code }), false, code);
  }
});
