// Differential parity suite: the Python ingestion helper and the Node engine
// must produce the same document identity, revision, chunk identifiers,
// requests, ledger records and statuses for the same controlled inputs.
//
//   Python CLI : scripts/memory-doc-ingest.py      (legacy/manual, Linux)
//   Node CLI   : scripts/doc-ingest-node.mjs       (native Windows + hooks)
//
// Both run as subprocesses against a local fake MemoryCore HTTP service, with
// separate temp ledgers and HOME/TMPDIR. Nothing outside the sandbox is read
// or written and no live gateway is contacted.
//
// On native Windows there is no python3, so the SAME Node scenarios are
// compared against `tests/fixtures/doc-ingest/parity/python-observations.json`
// — observations recorded from the real Python engine on Linux. The live
// comparison is skipped there explicitly (never silently).
//
// Deliberate, documented compatibility differences (asserted as such):
//   * transport error wording ("HTTP Error 500: ..." vs "HTTP 500"); status and
//     the "chunk write failed (<task>)" prefix are identical.
//   * a missing document's OS error text differs; both are DOC_INGEST_BLOCKED
//     with "cannot resolve document".
//   * argparse exits 2 on a usage error, this CLI 1; no ingestion state exists.
import test from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { createHash } from "node:crypto";
import {
  mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync, existsSync,
  symlinkSync, readdirSync, utimesSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { spawn, spawnSync } from "node:child_process";

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO = join(HERE, "..");
const PY_SCRIPT = join(REPO, "scripts", "memory-doc-ingest.py");
const NODE_SCRIPT = join(REPO, "scripts", "doc-ingest-node.mjs");
const FIXTURE_DOC = join(HERE, "fixtures", "doc-ingest", "runbook.md");
const FIXTURE = join(HERE, "fixtures", "doc-ingest", "parity", "python-observations.json");
const PYTHON = process.env.SINGULARITY_PARITY_PYTHON || "python3";

const PY_AVAILABLE = (() => {
  if (String(process.env.SINGULARITY_PARITY_PY || "1") === "0") return false;
  try {
    return spawnSync(PYTHON, ["-c", "print(1)"], { encoding: "utf8", timeout: 10_000, windowsHide: true }).status === 0;
  } catch {
    return false;
  }
})();

const ISO = /\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z/g;
const TS_KEYS = new Set(["ingested_at", "verified_at", "last_checked", "last_verified", "recorded_at"]);

// ── fake MemoryCore gateway ──────────────────────────────────────────────────

function startGateway() {
  const state = { records: [], calls: [], failAdds: false, addStatus: null, addReply: null, searchReply: null };
  const server = createServer((req, res) => {
    const chunks = [];
    req.on("data", (c) => chunks.push(c));
    req.on("end", () => {
      let body = {};
      try { body = JSON.parse(Buffer.concat(chunks).toString("utf8") || "{}"); } catch { /* invalid body */ }
      const send = (status, payload) => {
        res.writeHead(status, { "content-type": "application/json" });
        res.end(JSON.stringify(payload));
      };
      const keep = {};
      for (const key of ["authorization", "content-type", "x-tdai-service-id", "x-tdai-user-key"]) {
        if (req.headers[key] !== undefined) keep[key] = req.headers[key];
      }
      state.calls.push({ path: req.url, headers: keep, body });
      if (req.url === "/v3/conversation/add") {
        if (state.failAdds) return send(500, { code: 500, message: "fake gateway failure" });
        if (state.addStatus) return send(state.addStatus, { code: state.addStatus, message: "fake gateway auth failure" });
        if (state.addReply) return send(200, state.addReply);
        for (const message of body.messages || []) {
          state.records.push({ task_id: body.task_id, content: String(message.content || "") });
        }
        return send(200, { code: 0, data: {} });
      }
      if (req.url === "/v3/conversation/search") {
        if (state.searchReply) return send(200, state.searchReply);
        const query = String(body.query || "");
        const limit = Number(body.limit) || 5;
        const hits = state.records.filter((r) => r.content.includes(query)).slice(0, limit);
        return send(200, { code: 0, data: { messages: hits.map((r) => ({ content: r.content, task_id: r.task_id })) } });
      }
      return send(404, { code: 404, message: "not found" });
    });
  });
  return new Promise((done) => {
    server.listen(0, "127.0.0.1", () => {
      const { port } = server.address();
      done({
        state,
        url: `http://127.0.0.1:${port}`,
        reset() { state.records.length = 0; state.calls.length = 0; state.failAdds = false; state.addStatus = null; state.addReply = null; state.searchReply = null; },
        takeCalls() { return state.calls.splice(0, state.calls.length); },
        close() { return new Promise((closed) => server.close(closed)); },
      });
    });
  });
}

// ── sandboxes and process runners ────────────────────────────────────────────

function makeBox() {
  const dir = mkdtempSync(join(tmpdir(), "doc-parity-"));
  const root = join(dir, "workspace");
  mkdirSync(join(root, "docs"), { recursive: true });
  const memory = join(dir, "memory.json");
  writeFileSync(memory, JSON.stringify({ gatewayKey: "gw-test-only", serviceId: "svc-test", userKey: "usr-test", authPrefix: "Bearer " }));
  return {
    dir,
    root,
    memory,
    doc(name, content) {
      const p = join(root, "docs", name);
      mkdirSync(dirname(p), { recursive: true });
      writeFileSync(p, content);
      return p;
    },
    cleanup() { rmSync(dir, { recursive: true, force: true }); },
  };
}

function envFor(box, engine, gatewayUrl) {
  const env = { ...process.env };
  env.HOME = join(box.dir, `home-${engine}`);
  env.USERPROFILE = env.HOME;
  env.TMPDIR = join(box.dir, `tmp-${engine}`);
  env.TMP = env.TMPDIR;
  env.TEMP = env.TMPDIR;
  mkdirSync(env.HOME, { recursive: true });
  mkdirSync(env.TMPDIR, { recursive: true });
  env.MEMORY_SECRETS = box.memory;
  env.KNOWLEDGE_INDEX_BASE_URL = gatewayUrl;
  env.SINGULARITY_DOC_DATA = join(box.dir, `data-${engine}`);
  env.DOC_INDEX_TEAM = "singularity-docs";
  env.DOC_INDEX_USER = "shared";
  delete env.SINGULARITY_DOC_ROOTS;
  return env;
}

function parseJson(text) {
  const trimmed = String(text || "").trim();
  if (!trimmed) return null;
  try { return JSON.parse(trimmed); } catch { return null; }
}

// Asynchronous on purpose: the fake gateway runs in THIS process, so a
// synchronous spawn would block the event loop and every request would time
// out before the server could answer it.
function run(engine, box, gateway, args, extraEnv = {}) {
  const isPy = engine === "py";
  const env = { ...envFor(box, engine, gateway.url), ...extraEnv };
  return new Promise((done) => {
    const child = spawn(isPy ? PYTHON : process.execPath, [isPy ? PY_SCRIPT : NODE_SCRIPT, ...args], {
      cwd: box.root,
      env,
      windowsHide: true,
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (c) => { stdout += c; });
    child.stderr.on("data", (c) => { stderr += c; });
    const timer = setTimeout(() => child.kill(), 120_000);
    child.on("close", (code) => {
      clearTimeout(timer);
      done({ code, json: parseJson(stdout), stdout: String(stdout).trim(), stderr: String(stderr).trim() });
    });
  });
}

function spawnRun(engine, box, gateway, args, extraEnv = {}) {
  const isPy = engine === "py";
  return spawn(isPy ? PYTHON : process.execPath, [isPy ? PY_SCRIPT : NODE_SCRIPT, ...args], {
    cwd: box.root,
    env: { ...envFor(box, engine, gateway.url), ...extraEnv },
    windowsHide: true,
    stdio: ["ignore", "pipe", "pipe"],
  });
}

function ledgerOf(box, engine) {
  const p = join(box.dir, `data-${engine}`, "doc-index", "ledger.json");
  return existsSync(p) ? JSON.parse(readFileSync(p, "utf8")) : null;
}

function lockOf(box, engine) {
  return join(box.dir, `data-${engine}`, "doc-index", ".ledger.lock.d");
}

// ── normalisation (timestamps and sandbox paths are semantically irrelevant) ─

function normReason(value) {
  let text = String(value ?? "");
  if (text.startsWith("chunk write failed")) return "chunk write failed";
  if (text.startsWith("cannot read memory secrets")) return "cannot read memory secrets";
  if (text.startsWith("cannot resolve document")) return "cannot resolve document";
  return text;
}

/**
 * Root-scoped hashes are derived from the sandbox path, which necessarily
 * differs between the Python and Node runs, so replace them (and the doc ids /
 * task ids built from them) with placeholders. Revision and chunk hashes are
 * CONTENT hashes and are never replaced — those must match exactly.
 */
function idMap(box) {
  const rootId = createHash("sha256").update(String(box.root).replace(/\\/g, "/")).digest("hex").slice(0, 8);
  const map = new Map([[rootId, "<root-id>"]]);
  for (const engine of ["py", "node"]) {
    try {
      const ledger = ledgerOf(box, engine);
      for (const entry of Object.values(ledger?.docs || {})) {
        if (entry?.doc_id) map.set(entry.doc_id, "<doc-id>");
      }
    } catch { /* no ledger for this engine (yet) */ }
  }
  return [...map.entries()].sort((a, b) => b[0].length - a[0].length);
}

function normValue(value, box, key = "", ids = null) {
  ids = ids || idMap(box);
  if (Array.isArray(value)) return value.map((v) => normValue(v, box, key, ids));
  if (value && typeof value === "object") {
    const out = {};
    for (const k of Object.keys(value).sort()) {
      if (TS_KEYS.has(k) && typeof value[k] === "string") out[k] = "<ts>";
      else out[normString(k, box, "", ids)] = normValue(value[k], box, k, ids);
    }
    return out;
  }
  if (typeof value !== "string") return value;
  return normString(value, box, key, ids);
}

function normString(value, box, key, ids) {
  // The sandbox directory differs per engine; paths outside the authorised
  // root still carry it, so normalise the whole box before the root itself.
  const fwd = (p) => String(p).replace(/\\/g, "/");
  let text = String(value).split(box.dir).join("<box>");
  text = text.split(box.dir.replace(/\\/g, "\\\\")).join("<box>");
  text = text.split(fwd(box.dir)).join("<box>");
  text = text.split(box.root).join("<root>");
  text = text.split(box.root.replace(/\\/g, "\\\\")).join("<root>");
  text = text.split(fwd(box.root)).join("<root>");
  // The recorded fixture is portable across separators: sandbox paths become
  // forward-slash placeholders whether the run was Linux or native Windows.
  if (text.includes("<box>") || text.includes("<root>")) text = text.replace(/\\/g, "/");
  for (const [from, to] of ids) text = text.split(from).join(to);
  text = text.replace(ISO, "<ts>");
  if (key === "reason") text = normReason(text);
  return text;
}

function normOutput(out, box) {
  return normValue({ code: out.code, json: out.json, stderr: out.stderr }, box);
}

function normCalls(calls, box) {
  return normValue(calls.map((c) => ({ path: c.path, headers: c.headers, body: c.body })), box);
}

function scenario(box, engine, gateway, steps) {
  return normValue({ steps, ledger: ledgerOf(box, engine) }, box);
}

// ── scenarios ────────────────────────────────────────────────────────────────

const RUNBOOK = readFileSync(FIXTURE_DOC, "utf8");

async function coreSteps(box, engine, gateway) {
  const steps = {};
  const doc = box.doc("runbook.md", RUNBOOK);
  steps.ingest1 = normOutput(await run(engine, box, gateway, ["ingest", "--file", doc, "--root", box.root, "--session", "parity-session"]), box);
  if (process.env.SINGULARITY_PARITY_DEBUG) {
    const raw = ledgerOf(box, engine);
    console.error(`[parity ${engine}]`, JSON.stringify(steps.ingest1.json), JSON.stringify(Object.values(raw?.docs || {})[0]?.revs || {}));
  }
  steps.calls1 = normCalls(gateway.takeCalls(), box);
  steps.ledger1 = normValue(ledgerOf(box, engine), box);

  steps.ingest2 = normOutput(await run(engine, box, gateway, ["ingest", "--file", doc, "--root", box.root]), box);
  steps.calls2 = normCalls(gateway.takeCalls(), box);
  steps.ledger2 = normValue(ledgerOf(box, engine), box);

  steps.verify = normOutput(await run(engine, box, gateway, ["verify", "--file", "docs/runbook.md", "--root", box.root]), box);
  steps.status = normOutput(await run(engine, box, gateway, ["status", "--all", "--root", box.root]), box);
  steps.search = normOutput(await run(engine, box, gateway, ["search", "deploy runbook", "--root", box.root]), box);

  writeFileSync(doc, `${RUNBOOK}\n\n## Later revision\n\nA changed procedure for the pump.\n`);
  steps.ingest3 = normOutput(await run(engine, box, gateway, ["ingest", "--file", doc, "--root", box.root]), box);
  steps.calls3 = normCalls(gateway.takeCalls(), box);
  steps.ledger3 = normValue(ledgerOf(box, engine), box);
  steps.verify3 = normOutput(await run(engine, box, gateway, ["verify", "--file", "docs/runbook.md", "--root", box.root]), box);
  steps.status3 = normOutput(await run(engine, box, gateway, ["status", "--all", "--root", box.root]), box);
  steps.search3 = normOutput(await run(engine, box, gateway, ["search", "changed procedure", "--root", box.root]), box);
  steps.searchStale = normOutput(await run(engine, box, gateway, ["search", "deploy runbook", "--stale", "--root", box.root]), box);
  return steps;
}

async function failureSteps(box, engine, gateway) {
  const steps = {};
  const doc = box.doc("failing.md", "# Failing runbook\n\nA write that will be refused.\n");
  gateway.state.failAdds = true;
  steps.ingestFailed = normOutput(await run(engine, box, gateway, ["ingest", "--file", doc, "--root", box.root]), box);
  steps.callsFailed = normCalls(gateway.takeCalls(), box);
  steps.ledgerFailed = normValue(ledgerOf(box, engine), box);
  steps.verifyFailed = normOutput(await run(engine, box, gateway, ["verify", "--file", "docs/failing.md", "--root", box.root]), box);

  // A rejected credential (HTTP 401) is another retryable write failure, not a
  // success and not a reason to lose the document.
  const authDoc = box.doc("auth.md", "# Auth runbook\n\nA rejected write that must be retried.\n");
  gateway.state.addStatus = 401;
  steps.ingestAuthFailed = normOutput(await run(engine, box, gateway, ["ingest", "--file", authDoc, "--root", box.root]), box);
  steps.callsAuthFailed = normCalls(gateway.takeCalls(), box);
  steps.ledgerAuthFailed = normValue(ledgerOf(box, engine), box);

  gateway.state.failAdds = false;
  gateway.state.addStatus = null;
  steps.retry = normOutput(await run(engine, box, gateway, ["retry", "--all", "--root", box.root]), box);
  steps.callsRetry = normCalls(gateway.takeCalls(), box);
  steps.ledgerRetry = normValue(ledgerOf(box, engine), box);
  steps.verifyRetry = normOutput(await run(engine, box, gateway, ["verify", "--file", "docs/failing.md", "--root", box.root]), box);
  steps.verifyAuth = normOutput(await run(engine, box, gateway, ["verify", "--file", "docs/auth.md", "--root", box.root]), box);
  return steps;
}

async function appErrorSteps(box, engine, gateway) {
  const steps = {};
  const doc = box.doc("denied.md", "# Denied runbook\n\nApplication-level refusal.\n");
  gateway.state.addReply = { code: 401, message: "denied by policy" };
  steps.codeError = normOutput(await run(engine, box, gateway, ["ingest", "--file", doc, "--root", box.root]), box);
  steps.callsCode = normCalls(gateway.takeCalls(), box);
  gateway.state.addReply = { error: "denied by policy" };
  steps.errorField = normOutput(await run(engine, box, gateway, ["ingest", "--file", doc, "--root", box.root]), box);
  steps.callsError = normCalls(gateway.takeCalls(), box);
  return steps;
}

async function refusalSteps(box, engine, gateway) {
  const outside = join(box.dir, "outside", "outside.md");
  mkdirSync(dirname(outside), { recursive: true });
  writeFileSync(outside, "# Outside\n");
  const cases = {
    missing: join(box.root, "docs", "absent.md"),
    secretContent: box.doc("content.md", "# Secret\n\ntoken sk-abcdefghijk12345\n"),
    secretName: box.doc(".env.local", "# environment\n"),
    notMarkdown: box.doc("notes.txt", "plain text\n"),
    empty: box.doc("empty.md", ""),
    tooLarge: box.doc("large.md", `# Large\n\n${"x".repeat(200 * 1024)}\n`),
    unbalancedFence: box.doc("fence.md", "# Fence\n\n```\nunclosed\n"),
    assignment: box.doc("assign.md", "# Assign\n\npassword: hunter2hunter2\n"),
    outsideRoot: outside,
  };
  const steps = {};
  for (const [name, file] of Object.entries(cases)) {
    steps[name] = normOutput(await run(engine, box, gateway, ["ingest", "--file", file, "--root", box.root]), box);
  }
  steps.calls = normCalls(gateway.takeCalls(), box);
  return steps;
}

async function observeCore(engine) {
  const gateway = await startGateway();
  const box = makeBox();
  try {
    return scenario(box, engine, gateway, await coreSteps(box, engine, gateway));
  } finally {
    await gateway.close();
    box.cleanup();
  }
}

async function observeFailure(engine) {
  const gateway = await startGateway();
  const box = makeBox();
  try {
    return scenario(box, engine, gateway, await failureSteps(box, engine, gateway));
  } finally {
    await gateway.close();
    box.cleanup();
  }
}

async function observeAppError(engine) {
  const gateway = await startGateway();
  const box = makeBox();
  try {
    return scenario(box, engine, gateway, await appErrorSteps(box, engine, gateway));
  } finally {
    await gateway.close();
    box.cleanup();
  }
}

async function observeRefusals(engine) {
  const gateway = await startGateway();
  const box = makeBox();
  try {
    return scenario(box, engine, gateway, await refusalSteps(box, engine, gateway));
  } finally {
    await gateway.close();
    box.cleanup();
  }
}

// ── live differential comparison (Linux: python3 present) ────────────────────

test("differential: Python and Node agree on ingest, UNCHANGED, edit/supersede, verify, status and search", { timeout: 180_000 }, async (t) => {
  if (!PY_AVAILABLE) return t.skip("python3 unavailable — the native fixture comparison below covers the Node side");
  const py = await observeCore("py");
  const node = await observeCore("node");
  assert.deepEqual(node, py);
});

test("differential: hard HTTP failure is FAILED for both, and retry resolves it identically", { timeout: 180_000 }, async (t) => {
  if (!PY_AVAILABLE) return t.skip("python3 unavailable — native fixture comparison covers the Node side");
  assert.deepEqual(await observeFailure("node"), await observeFailure("py"));
});

test("differential: application-level error/code replies are never treated as success", { timeout: 180_000 }, async (t) => {
  if (!PY_AVAILABLE) return t.skip("python3 unavailable — native fixture comparison covers the Node side");
  assert.deepEqual(await observeAppError("node"), await observeAppError("py"));
});

test("differential: eligibility, secret, size, fence, allowlist and missing-file refusals match", { timeout: 180_000 }, async (t) => {
  if (!PY_AVAILABLE) return t.skip("python3 unavailable — native fixture comparison covers the Node side");
  assert.deepEqual(await observeRefusals("node"), await observeRefusals("py"));
});

test("differential: a symlink escaping the authorised root is refused by both engines", { timeout: 120_000 }, async (t) => {
  if (!PY_AVAILABLE) return t.skip("python3 unavailable");
  const gateway = await startGateway();
  const box = makeBox();
  try {
    const outside = join(box.dir, "outside", "linked.md");
    mkdirSync(dirname(outside), { recursive: true });
    writeFileSync(outside, "# Linked outside\n");
    const link = join(box.root, "docs", "link.md");
    try { symlinkSync(outside, link); } catch { return t.skip("symlink creation not permitted in this environment"); }
    const py = normOutput(await run("py", box, gateway, ["ingest", "--file", link, "--root", box.root]), box);
    const node = normOutput(await run("node", box, gateway, ["ingest", "--file", link, "--root", box.root]), box);
    assert.deepEqual(node, py);
    assert.equal(py.json.status, "DOC_INGEST_BLOCKED");
    assert.match(py.json.reason, /outside the documentation allowlist roots|symlink traversal/);
    assert.deepEqual(gateway.takeCalls(), []);
  } finally {
    await gateway.close();
    box.cleanup();
  }
});

// ── native-Windows fixture comparison (no python3 required) ──────────────────

test("native/fixture: Node reproduces the recorded Python observations", { timeout: 180_000 }, async () => {
  const recording = String(process.env.SINGULARITY_PARITY_RECORD || "") === "1" && PY_AVAILABLE;
  if (!recording && !existsSync(FIXTURE)) {
    assert.fail(`missing ${FIXTURE}; record it on Linux with SINGULARITY_PARITY_RECORD=1`);
  }
  const actual = {
    core: await observeCore("node"),
    failure: await observeFailure("node"),
    appError: await observeAppError("node"),
    refusals: await observeRefusals("node"),
  };
  let expected;
  if (recording) {
    // Recording mode regenerates the Python reference from a live Python run;
    // the assertion below still compares Node against it immediately.
    const py = {
      core: await observeCore("py"),
      failure: await observeFailure("py"),
      appError: await observeAppError("py"),
      refusals: await observeRefusals("py"),
    };
    mkdirSync(dirname(FIXTURE), { recursive: true });
    writeFileSync(FIXTURE, `${JSON.stringify(py, null, 2)}\n`);
    expected = py;
  } else {
    expected = JSON.parse(readFileSync(FIXTURE, "utf8"));
  }
  assert.deepEqual(actual, expected);
});

// ── cross-runtime ledger upgrade + locking ───────────────────────────────────

test("legacy upgrade: a real Python ledger remains readable and is upgraded without ID churn", { timeout: 180_000 }, async (t) => {
  if (!PY_AVAILABLE) return t.skip("python3 unavailable — the fixture readability test covers the Node side");
  const gateway = await startGateway();
  const box = makeBox();
  try {
    const doc = box.doc("legacy.md", "# Legacy runbook\n\nFirst Python revision.\n");
    assert.equal((await run("py", box, gateway, ["ingest", "--file", doc, "--root", box.root])).code, 0);
    writeFileSync(doc, "# Legacy runbook\n\nSecond Python revision.\n");
    assert.equal((await run("py", box, gateway, ["ingest", "--file", doc, "--root", box.root])).code, 0);
    const before = ledgerOf(box, "py");
    if (String(process.env.SINGULARITY_PARITY_RECORD || "") === "1") {
      // Record a REAL Python-produced ledger for the native readability test.
      mkdirSync(dirname(join(HERE, "fixtures", "doc-ingest", "parity", "python-ledger.json")), { recursive: true });
      writeFileSync(join(HERE, "fixtures", "doc-ingest", "parity", "python-ledger.json"), `${JSON.stringify(before, null, 2)}\n`);
    }
    const key = Object.keys(before.docs)[0];
    const entry = before.docs[key];
    const docId = entry.doc_id;
    const oldRevs = Object.keys(entry.revs).sort();
    const oldChunkIds = oldRevs.flatMap((r) => entry.revs[r].task_ids).sort();

    // Node shares the same ledger (same SINGULARITY_DOC_DATA) and reads it.
    gateway.takeCalls();
    const sharedData = { SINGULARITY_DOC_DATA: join(box.dir, "data-py") };
    const unchanged = await run("node", box, gateway, ["ingest", "--file", doc, "--root", box.root], sharedData);
    assert.equal(unchanged.json.status, "DOC_INGEST_UNCHANGED");
    assert.equal(gateway.takeCalls().filter((c) => c.path.endsWith("/conversation/add")).length, 0, "no chunk re-written");

    writeFileSync(doc, "# Legacy runbook\n\nThird revision written by Node.\n");
    const upgraded = await run("node", box, gateway, ["ingest", "--file", doc, "--root", box.root], sharedData);
    assert.equal(upgraded.json.status, "DOC_INGEST_INDEXED", JSON.stringify(upgraded.json));
    assert.equal(upgraded.json.doc_id, docId);
    const after = ledgerOf(box, "py");
    assert.deepEqual(Object.keys(after.docs), [key], "same root-scoped key, no duplicate document");
    assert.equal(after.docs[key].doc_id, docId);
    for (const rev of oldRevs) assert.deepEqual(after.docs[key].revs[rev].task_ids, before.docs[key].revs[rev].task_ids, `chunk ids for ${rev} preserved`);
    assert.deepEqual(oldChunkIds.every((id) => JSON.stringify(after).includes(id)), true);

    const verified = await run("py", box, gateway, ["verify", "--file", "docs/legacy.md", "--root", box.root]);
    assert.equal(verified.json.status, "DOC_INGEST_VERIFIED", "the Python helper accepts the Node-updated ledger");
    assert.equal(verified.json.revision, after.docs[key].active_rev);
  } finally {
    await gateway.close();
    box.cleanup();
  }
});

test("fixture readability: a real Python ledger parses and is preserved when Node adds another document", { timeout: 120_000 }, async () => {
  // Native Windows has no python3. This uses the real Python-produced ledger
  // recorded on Linux, at its recorded (Linux) root: Node must parse it and
  // leave every existing record byte-semantically intact while ingesting a
  // document in a different root. Same-root upgrade is proven live above.
  const gateway = await startGateway();
  const box = makeBox();
  try {
    const recorded = JSON.parse(readFileSync(join(HERE, "fixtures", "doc-ingest", "parity", "python-ledger.json"), "utf8"));
    const data = join(box.dir, "data-node");
    mkdirSync(join(data, "doc-index"), { recursive: true });
    writeFileSync(join(data, "doc-index", "ledger.json"), JSON.stringify(recorded, null, 2));
    const doc = box.doc("fresh.md", "# Fresh\n\nA new document in this workspace.\n");
    const res = await run("node", box, gateway, ["ingest", "--file", doc, "--root", box.root]);
    assert.equal(res.json.status, "DOC_INGEST_INDEXED", JSON.stringify(res.json));
    const ledger = ledgerOf(box, "node");
    for (const [key, entry] of Object.entries(recorded.docs)) {
      assert.deepEqual(ledger.docs[key], entry, `recorded Python entry ${key} is untouched`);
    }
    const rows = await run("node", box, gateway, ["status", "--all"]);
    assert.equal(rows.json.length, Object.keys(recorded.docs).length + 1);
  } finally {
    await gateway.close();
    box.cleanup();
  }
});

test("locking: a held lock directory blocks BOTH runtimes, and releasing it lets both finish", { timeout: 120_000 }, async (t) => {
  if (!PY_AVAILABLE) return t.skip("python3 unavailable — the Node-only contention test below still runs");
  const gateway = await startGateway();
  const box = makeBox();
  try {
    const docA = box.doc("a.md", "# A\n\nPython document.\n");
    const docB = box.doc("b.md", "# B\n\nNode document.\n");
    const lock = lockOf(box, "py");
    mkdirSync(lock, { recursive: true });
    const sharedData = { SINGULARITY_DOC_DATA: join(box.dir, "data-py") };
    const py = spawnRun("py", box, gateway, ["ingest", "--file", docA, "--root", box.root]);
    const node = spawnRun("node", box, gateway, ["ingest", "--file", docB, "--root", box.root], sharedData);
    await new Promise((done) => setTimeout(done, 900));
    assert.equal(py.exitCode, null, "python waits for the shared lock instead of writing");
    assert.equal(node.exitCode, null, "node waits for the shared lock instead of writing");
    assert.equal(existsSync(lock), true);
    rmSync(lock, { recursive: true, force: true });
    const codes = await Promise.all([exitOf(py), exitOf(node)]);
    assert.deepEqual(codes, [0, 0]);
    assert.equal(existsSync(lock), false, "lock cleaned up");
    const ledger = ledgerOf(box, "py");
    assert.equal(Object.keys(ledger.docs).length, 2, "both writes survived — no lost update");
  } finally {
    await gateway.close();
    box.cleanup();
  }
});

test("locking: two concurrent Node ingests serialise and both records survive", { timeout: 120_000 }, async () => {
  const gateway = await startGateway();
  const box = makeBox();
  try {
    const a = box.doc("a.md", "# A\n\nFirst.\n");
    const b = box.doc("b.md", "# B\n\nSecond.\n");
    const p1 = spawnRun("node", box, gateway, ["ingest", "--file", a, "--root", box.root]);
    const p2 = spawnRun("node", box, gateway, ["ingest", "--file", b, "--root", box.root]);
    assert.deepEqual(await Promise.all([exitOf(p1), exitOf(p2)]), [0, 0]);
    const ledger = ledgerOf(box, "node");
    assert.equal(Object.keys(ledger.docs).length, 2);
    assert.equal(existsSync(lockOf(box, "node")), false);
    assert.equal(readdirSync(join(box.dir, "data-node", "doc-index")).includes(".ledger.lock.d"), false);
  } finally {
    await gateway.close();
    box.cleanup();
  }
});

test("locking: a stale lock is reaped by both runtimes and never left behind after failure", { timeout: 120_000 }, async (t) => {
  const gateway = await startGateway();
  const box = makeBox();
  try {
    const doc = box.doc("stale.md", "# Stale\n\nLock recovery.\n");
    const lock = lockOf(box, "node");
    mkdirSync(lock, { recursive: true });
    const old = new Date(Date.now() - 10 * 60_000);
    utimesSync(lock, old, old);
    const res = await run("node", box, gateway, ["ingest", "--file", doc, "--root", box.root]);
    assert.equal(res.json.status, "DOC_INGEST_INDEXED", JSON.stringify(res.json));
    assert.equal(existsSync(lock), false);

    if (PY_AVAILABLE) {
      const lockPy = lockOf(box, "py");
      mkdirSync(lockPy, { recursive: true });
      utimesSync(lockPy, old, old);
      const py = await run("py", box, gateway, ["ingest", "--file", doc, "--root", box.root]);
      assert.equal(py.json.status, "DOC_INGEST_INDEXED", JSON.stringify(py.json));
      assert.equal(existsSync(lockPy), false);
    } else {
      t.diagnostic("python3 unavailable: Python stale-lock reaping not exercised here");
    }

    // A hard failure must release the lock too.
    const bad = box.doc("bad.md", "# Bad\n\nWill fail.\n");
    gateway.state.failAdds = true;
    const failed = await run("node", box, gateway, ["ingest", "--file", bad, "--root", box.root]);
    assert.equal(failed.json.status, "DOC_INGEST_FAILED");
    assert.equal(existsSync(lockOf(box, "node")), false);
  } finally {
    await gateway.close();
    box.cleanup();
  }
});

function exitOf(child) {
  return new Promise((done) => child.on("exit", (code) => done(code)));
}
