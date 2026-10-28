import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  chunkMarkdown,
  classifySource,
  ingestFile,
  loadLedger,
  rejectSensitive,
  retryPendingIngestion,
  searchDocs,
  statusReport,
  verifyFile,
  Blocked,
} from "./doc-ingest-node.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const FIXTURE = join(HERE, "..", "tests", "fixtures", "doc-ingest", "runbook.md");
const NOW = new Date("2026-10-28T00:00:00Z");

/** A MemoryCore stand-in with the same JSON contract the gateway returns. */
function fakeGateway() {
  const records = [];
  const calls = [];
  const state = { failAdds: false, hideRecords: false };
  const reply = (payload) => ({ ok: true, status: 200, text: async () => JSON.stringify(payload) });
  const fetchImpl = async (url, init) => {
    const body = JSON.parse(init.body);
    calls.push({ path: new URL(url).pathname, body });
    if (url.endsWith("/conversation/add")) {
      if (state.failAdds) return { ok: false, status: 500, text: async () => "{}" };
      for (const message of body.messages) records.push({ task_id: body.task_id, content: message.content });
      return reply({ code: 0, data: {} });
    }
    if (url.endsWith("/conversation/search")) {
      const hits = state.hideRecords ? [] : records.filter((r) => r.content.includes(body.query));
      return reply({ code: 0, data: { messages: hits.map((r) => ({ content: r.content })) } });
    }
    return { ok: false, status: 404, text: async () => "{}" };
  };
  return { fetchImpl, records, calls, state };
}

function sandbox() {
  const dir = mkdtempSync(join(tmpdir(), "doc-ingest-node-"));
  mkdirSync(join(dir, "docs"), { recursive: true });
  writeFileSync(join(dir, "memory.json"), JSON.stringify({ gatewayKey: "gw-test", serviceId: "svc", userKey: "usr", authPrefix: "Bearer " }));
  const env = {
    SINGULARITY_DOC_DATA: join(dir, "data"),
    MEMORY_SECRETS: join(dir, "memory.json"),
    DOC_INDEX_TEAM: "singularity-docs",
    DOC_INDEX_USER: "shared",
  };
  return {
    dir,
    root: dir,
    env,
    doc: (name, content) => {
      const p = join(dir, "docs", name);
      mkdirSync(dirname(p), { recursive: true });
      writeFileSync(p, content);
      return p;
    },
    cleanup: () => rmSync(dir, { recursive: true, force: true }),
  };
}

const baseOpts = (box, gateway, extra = {}) => ({
  root: box.root,
  env: box.env,
  fetchImpl: gateway.fetchImpl,
  now: () => NOW,
  sleep: async () => {},
  ...extra,
});

test("ingest → INDEXED, ledger evidence → VERIFIED, re-ingest → UNCHANGED (no extra write)", async () => {
  const box = sandbox();
  const gateway = fakeGateway();
  try {
    const doc = box.doc("runbook.md", readFileSync(FIXTURE, "utf8"));
    const first = await ingestFile(doc, baseOpts(box, gateway));
    assert.equal(first.status, "DOC_INGEST_INDEXED", JSON.stringify(first));
    assert.equal(first.file, "docs/runbook.md");
    assert.equal(first.doc_id.length, 8);
    assert.ok(first.chunks >= 1);

    const ledger = loadLedger(box.env);
    const key = Object.keys(ledger.docs)[0];
    const entry = ledger.docs[key];
    assert.match(key, /^[0-9a-f]{8}::docs\/runbook\.md$/);
    assert.equal(entry.active_rev, first.rev);
    assert.equal(entry.revs[first.rev].status, "DOC_INGEST_INDEXED");
    assert.ok(entry.revs[first.rev].verified_at);
    assert.equal(entry.revs[first.rev].task_ids.length, entry.revs[first.rev].chunks);
    assert.equal(entry.revs[first.rev].hashes.length, entry.revs[first.rev].chunks);

    const verified = verifyFile("docs/runbook.md", { root: box.root, env: box.env });
    assert.equal(verified.status, "DOC_INGEST_VERIFIED");
    assert.equal(verified.revision, first.rev);

    const addCount = gateway.calls.filter((c) => c.path.endsWith("/conversation/add")).length;
    const second = await ingestFile(doc, baseOpts(box, gateway));
    assert.equal(second.status, "DOC_INGEST_UNCHANGED");
    assert.equal(gateway.calls.filter((c) => c.path.endsWith("/conversation/add")).length, addCount);

    const rows = statusReport({ root: box.root, env: box.env, all: true });
    assert.equal(rows.length, 1);
    assert.equal(rows[0].status, "DOC_INGEST_INDEXED");
    assert.equal(rows[0].stale_source, false);
  } finally {
    box.cleanup();
  }
});

test("a changed document becomes a new revision with a supersession tombstone", async () => {
  const box = sandbox();
  const gateway = fakeGateway();
  try {
    const doc = box.doc("runbook.md", "# Runbook\n\nFirst revision.\n");
    const first = await ingestFile(doc, baseOpts(box, gateway));
    assert.equal(first.status, "DOC_INGEST_INDEXED");

    writeFileSync(doc, "# Runbook\n\nSecond revision with new steps.\n");
    const second = await ingestFile(doc, baseOpts(box, gateway));
    assert.equal(second.status, "DOC_INGEST_INDEXED");
    assert.notEqual(second.rev, first.rev);
    assert.equal(second.superseded, "written");
    assert.equal(
      gateway.calls.some((c) => c.path.endsWith("/conversation/add") && c.body.messages?.[0]?.content.includes(`[docs-superseded:${first.doc_id}:${first.rev}->${second.rev}]`)),
      true,
    );

    const old = verifyFile("docs/runbook.md", { root: box.root, env: box.env });
    assert.equal(old.status, "DOC_INGEST_VERIFIED");
    assert.equal(old.revision, second.rev);
  } finally {
    box.cleanup();
  }
});

test("unverified retrieval is PENDING (not claimed), then retry resolves it to INDEXED", async () => {
  const box = sandbox();
  const gateway = fakeGateway();
  try {
    const doc = box.doc("runbook.md", "# Runbook\n\nContent that will be persisted.\n");
    gateway.state.hideRecords = true; // writes work, retrieval never finds the marker
    const pending = await ingestFile(doc, baseOpts(box, gateway, { verifyTimeoutMs: 0, verifyPollMs: 0 }));
    assert.equal(pending.status, "DOC_INGEST_PENDING");
    assert.match(pending.reason, /not yet searchable/);
    assert.equal(verifyFile("docs/runbook.md", { root: box.root, env: box.env }).status, "DOC_INGEST_NOT_VERIFIED");

    const rows = statusReport({ root: box.root, env: box.env, all: true });
    assert.equal(rows[0].status, "DOC_INGEST_PENDING");

    gateway.state.hideRecords = false;
    const results = await retryPendingIngestion(box.root, baseOpts(box, gateway));
    assert.equal(results.length, 1);
    assert.equal(results[0].status, "DOC_INGEST_INDEXED");
    assert.equal(verifyFile("docs/runbook.md", { root: box.root, env: box.env }).status, "DOC_INGEST_VERIFIED");
  } finally {
    box.cleanup();
  }
});

test("a hard write failure is FAILED, never INDEXED", async () => {
  const box = sandbox();
  const gateway = fakeGateway();
  try {
    const doc = box.doc("runbook.md", "# Runbook\n\nWill fail to write.\n");
    gateway.state.failAdds = true;
    const failed = await ingestFile(doc, baseOpts(box, gateway));
    assert.equal(failed.status, "DOC_INGEST_FAILED");
    assert.match(failed.reason, /chunk write failed/);
    assert.equal(verifyFile("docs/runbook.md", { root: box.root, env: box.env }).status, "DOC_INGEST_NOT_VERIFIED");
  } finally {
    box.cleanup();
  }
});

test("missing memory secrets refuse honestly instead of claiming success", async () => {
  const box = sandbox();
  try {
    const doc = box.doc("runbook.md", "# Runbook\n\nNo gateway config here.\n");
    const result = await ingestFile(doc, { root: box.root, env: { ...box.env, MEMORY_SECRETS: join(box.dir, "absent.json") } });
    assert.equal(result.status, "DOC_INGEST_BLOCKED");
    assert.match(result.reason, /cannot read memory secrets/);
  } finally {
    box.cleanup();
  }
});

test("chunking respects fences, keeps every line, and refuses unbounded growth", () => {
  const chunks = chunkMarkdown("## A\n" + "x".repeat(8000) + "\n## B\ny\n");
  assert.ok(chunks.length >= 2);
  // A single source line longer than the cap wraps (never truncates); only such
  // a chunk may exceed the cap, exactly as the Python engine behaves.
  const joined = chunks.join("\n");
  assert.equal(joined.includes("## B"), true);
  assert.equal(joined.replace(/\n/g, "").includes("x".repeat(100)), true, "long line content is preserved, not truncated");

  const fenced = chunkMarkdown("## A\n" + "a\n".repeat(4000) + "```\n## not a heading\n```\n");
  assert.equal(fenced.length, 1, "a heading inside a fence never splits the chunk");

  assert.equal(chunkMarkdown("# one\n").length, 1, "small documents are a single chunk");
  const tooMany = Array.from({ length: 100 }, (_, i) => `## H${i}\n${"z".repeat(5000)}\n`).join("");
  assert.throws(() => chunkMarkdown(tooMany), /max 64/);
});

test("sensitive content and secret-like names are refused before any write", () => {
  assert.throws(() => rejectSensitive("token sk-abcdefghijk12345", "a.md"), /sensitive content detected/);
  assert.throws(() => rejectSensitive("password: hunter2hunter2", "a.md"), /sensitive assignment detected/);
  assert.throws(() => rejectSensitive("```\nunclosed", "a.md"), /unbalanced code fences/);
  assert.doesNotThrow(() => rejectSensitive("ordinary runbook text", "a.md"));

  const box = sandbox();
  try {
    const secret = box.doc(".env.md", "# secrets\nvalue\n");
    assert.throws(() => classifySource(secret, [box.root]), /secret-like filename refused/);
    const notMd = box.doc("notes.txt", "text\n");
    assert.throws(() => classifySource(notMd, [box.root]), /only \.md documentation is eligible/);
    const empty = box.doc("empty.md", "");
    assert.throws(() => classifySource(empty, [box.root]), /document is empty/);
    const outsideRoot = mkdtempSync(join(tmpdir(), "doc-ingest-outside-"));
    try {
      const outside = join(outsideRoot, "outside.md");
      writeFileSync(outside, "# Outside\n");
      assert.throws(() => classifySource(outside, [box.root]), /outside the documentation allowlist roots/);
    } finally {
      rmSync(outsideRoot, { recursive: true, force: true });
    }
  } finally {
    box.cleanup();
  }
});

test("document identity is root-scoped: same relative path in two roots never collapses", async () => {
  const box = sandbox();
  const gateway = fakeGateway();
  const secondRoot = mkdtempSync(join(tmpdir(), "doc-ingest-root2-"));
  try {
    const doc = box.doc("runbook.md", "# Runbook\n\nShared relative path.\n");
    mkdirSync(join(secondRoot, "docs"), { recursive: true });
    const secondDoc = join(secondRoot, "docs", "runbook.md");
    writeFileSync(secondDoc, "# Runbook\n\nShared relative path.\n");

    await ingestFile(doc, baseOpts(box, gateway));
    await ingestFile(secondDoc, { ...baseOpts(box, gateway), root: secondRoot });
    const ledger = loadLedger(box.env);
    const keys = Object.keys(ledger.docs).sort();
    assert.equal(keys.length, 2);
    assert.deepEqual(keys.map((k) => k.split("::")[1]), ["docs/runbook.md", "docs/runbook.md"]);
    assert.notEqual(keys[0].split("::")[0], keys[1].split("::")[0]);

    assert.equal(verifyFile("docs/runbook.md", { root: box.root, env: box.env }).status, "DOC_INGEST_VERIFIED");
    const ambiguous = verifyFile("docs/runbook.md", { env: box.env });
    assert.equal(ambiguous.status, "DOC_INGEST_NOT_VERIFIED");
    assert.match(ambiguous.reason, /ambiguous|different workspace root/);
  } finally {
    rmSync(secondRoot, { recursive: true, force: true });
    box.cleanup();
  }
});

test("search returns only ledger-current revisions, never tombstones", async () => {
  const box = sandbox();
  const gateway = fakeGateway();
  try {
    const doc = box.doc("runbook.md", "# Runbook\n\nCurrent guidance.\n");
    await ingestFile(doc, baseOpts(box, gateway));
    const items = await searchDocs("Current guidance", { root: box.root, env: box.env, fetchImpl: gateway.fetchImpl });
    assert.equal(items.length, 1);
    assert.equal(items[0].source, "docs/runbook.md");
    assert.match(items[0].content, /\[doc-ref:docs\/runbook\.md#[0-9a-f]{8}/);
    assert.equal(items[0].content.includes("docs-superseded:"), false);
  } finally {
    box.cleanup();
  }
});

test("the hook path has no Python or subprocess dependency left", () => {
  const engine = readFileSync(join(HERE, "doc-ingest-node.mjs"), "utf8");
  const hook = readFileSync(join(HERE, "..", "adapters", "claude-code", "doc-hook.mjs"), "utf8");
  for (const [name, text] of [["doc-ingest-node.mjs", engine], ["doc-hook.mjs", hook]]) {
    assert.equal(/python3?/i.test(text.replace(/\/\/.*$/gm, "")), false, `${name} must not invoke a Python runtime`);
    assert.equal(text.includes("node:child_process"), false, `${name} must not spawn a subprocess`);
  }
});
