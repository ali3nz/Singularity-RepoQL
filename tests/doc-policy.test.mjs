import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, readFileSync, existsSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import {
  classifyFiles,
  evaluateAssessment,
  loadAssessment,
  writeAssessmentAtomic,
  baselinePath,
  sanitizeSession,
  scanDocCensus,
  observeWorkspace,
  autoIngestChangedDocs,
  collectEvidence,
  recordAutomaticLearningAssessment,
  main as cliMain,
} from "../scripts/doc-policy.mjs";

const sha8 = (s) => createHash("sha256").update(String(s)).digest("hex").slice(0, 8);

function scratch() {
  return mkdtempSync(join(tmpdir(), "doc-policy-test-"));
}

// Fabricate ledger evidence the verify CLI would derive from a real ingestion:
// root, rel, root-scoped identity, verified active revision, chunk accounting.
function plantLedgerEvidence(rootDir, rel, { withVerified = true, staleSource = false, extraStaleRev = false } = {}) {
  const absRoot = resolve(rootDir); // ledger root = the project root (discovery/ingest scope)
  const file = join(absRoot, rel);
  const text = (staleSource ? readFileSync(file, "utf8") + "\nchanged-but-unindexed\n" : readFileSync(file, "utf8"));
  const rootId = sha8(absRoot);
  const key = `${rootId}::${rel}`;
  const rev = activeRev(rootDir, rel, text);
  const rootIdShield = "root";
  const ledger = {
    version: 1,
    docs: {
      [key]: {
        root: absRoot, root_id: rootId, rel,
        doc_id: sha8(key), title: rel.split("/").pop(),
        active_rev: rev,
        revs: {
          [rev]: withVerified ? {
            status: "DOC_INGEST_INDEXED", verified_at: "2026-10-20T00:00:00Z",
            chunks: 1, task_ids: ["c1"], hashes: ["ch1"], ingested_at: "2026-10-20T00:00:00Z",
          } : { status: "DOC_INGEST_INDEXED", chunks: 1, task_ids: ["c1"], hashes: ["ch1"] },
          ...(extraStaleRev ? { aaaa2222: { status: "DOC_INGEST_FAILED", ingested_at: "2026-10-20T00:00:01Z", chunks: 1, task_ids: ["c2"], hashes: ["ch2"] } } : {}),
        },
      },
    },
  };
  mkdirSync(join(rootDir, "data", "doc-index"), { recursive: true });
  let existing = {};
  try { existing = JSON.parse(readFileSync(join(rootDir, "data", "doc-index", "ledger.json"), "utf8")); } catch { /* fresh */ }
  existing.docs = { ...(existing.docs || {}), ...ledger.docs };
  writeFileSync(join(rootDir, "data", "doc-index", "ledger.json"), JSON.stringify(existing, null, 2));
  return { key, rootId, rev };
}

function activeRev(rootDir, rel, text) {
  const absRoot = resolve(join(rootDir, "docs"));
  const rootId = sha8(absRoot);
  return sha8(text).slice(0, 8);
}

test("classification: code/config is material, docs/locks/generated are skipped", () => {
  const { material, skipped } = classifyFiles([
    "src/server.py", "src/app.mjs", "compose/compose.yml", ".github/workflows/ci.yml",
    "README.md", "docs/guide.md", "package-lock.json", "src/app.min.js",
    "notes.tmp", "src/app.js.bak", ".git/config", "SHA256SUMS",
  ]);
  assert.deepEqual(material, ["src/server.py", "src/app.mjs", "compose/compose.yml", ".github/workflows/ci.yml"]);
  assert.equal(skipped.length, 8);
});

test("no assessment recorded / DOC_BLOCKED behaves as before", () => {
  assert.match(evaluateAssessment({ files: ["a.py"] })[0], /no documentation assessment recorded/);
  const blocked = evaluateAssessment({ files: ["a.py"], docStatus: "DOC_BLOCKED", docReason: "docs system offline", captureStatus: "NO_LESSON" });
  assert.ok(blocked.some((f) => /BLOCKED/.test(f)));
});

test("DOC_UPDATED without ledger evidence cannot pass (evidence is mandatory)", () => {
  const out = evaluateAssessment({ files: ["a.py"], docStatus: "DOC_UPDATED", docs: [], captureStatus: "CAPTURED" });
  assert.ok(out.some((f) => /requires at least one created\/updated documentation file/.test(f)));
  const dir = scratch();
  try {
    writeFileSync(join(dir, "r.md"), "# Runbook\n");
    const noEvidence = evaluateAssessment({
      files: ["a.py"], docStatus: "DOC_UPDATED", docs: [join(dir, "r.md")], ingestion: ["DOC_INGEST_INDEXED"], captureStatus: "CAPTURED",
    }, {});
    assert.ok(noEvidence.some((f) => /ingestion evidence was not checked/.test(f)));
    const pendingEvidence = evaluateAssessment({
      files: ["a.py"], docStatus: "DOC_UPDATED", docs: [join(dir, "r.md")], ingestion: ["DOC_INGEST_INDEXED"], captureStatus: "CAPTURED",
    }, { evidence: { [join(dir, "r.md")]: { status: "DOC_INGEST_NOT_VERIFIED", reason: "no ledger record" } } });
    assert.ok(pendingEvidence.some((f) => /NOT verified for.*no ledger record/.test(f.replace(/\s+/g, " ")) || /NOT verified/.test(f)));
    const fabricated = evaluateAssessment({
      files: ["a.py"], docStatus: "DOC_UPDATED", docs: [join(dir, "r.md")], ingestion: ["DOC_INGEST_INDEXED"], captureStatus: "CAPTURED",
    }, { evidence: { [join(dir, "r.md")]: { status: "DOC_INGEST_VERIFIED" } } });
    assert.deepEqual(fabricated, []);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("fabricated DOC_INGEST_INDEXED claim is refused; contradiction is surfaced", () => {
  const dir = scratch();
  try {
    writeFileSync(join(dir, "r.md"), "# Runbook\n");
    const ev = { [join(dir, "r.md")]: { status: "DOC_INGEST_NOT_VERIFIED", reason: "incomplete chunk records" } };
    const claimedIndexed = evaluateAssessment({
      files: ["a.py"], docStatus: "DOC_UPDATED", docs: [join(dir, "r.md")], ingestion: ["DOC_INGEST_INDEXED"], captureStatus: "CAPTURED",
    }, { evidence: ev });
    assert.ok(claimedIndexed.some((f) => /NOT verified for .*incomplete chunk records/.test(f.replace(/\s+/g, " "))));
    const contradiction = evaluateAssessment({
      files: ["a.py"], docStatus: "DOC_UPDATED", docs: [join(dir, "r.md")], ingestion: ["DOC_INGEST_PENDING"], captureStatus: "CAPTURED",
    }, { evidence: { [join(dir, "r.md")]: { status: "DOC_INGEST_VERIFIED" } } });
    assert.ok(contradiction.some((f) => /contradicts the verified ledger evidence/.test(f)));
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("DOC_NOT_REQUIRED: valid for trivia, refused for material changes, vague reason refused", () => {
  assert.deepEqual(evaluateAssessment({
    files: ["README.md"], docStatus: "DOC_NOT_REQUIRED", docReason: "typo fix only", captureStatus: "NO_LESSON",
  }), []);
  assert.ok(evaluateAssessment({
    files: ["a.py"], docStatus: "DOC_NOT_REQUIRED", docReason: "small change", captureStatus: "NO_LESSON",
  }).some((f) => /DOC_NOT_REQUIRED refused/.test(f)));
  assert.ok(evaluateAssessment({
    files: ["README.md"], docStatus: "DOC_NOT_REQUIRED", docReason: "", captureStatus: "NO_LESSON",
  }).some((f) => /needs a concise, specific reason/.test(f)));
});

function execCliCapture() {
  const calls = [];
  return { calls };
}

test("CLI end-to-end: evidence-backed DOC_UPDATED closes; stale/fabricated/pending refuse via real verify", async () => {
  const dir = scratch();
  const capture = { lines: [] };
  const origLog = console.log;
  const origCwd = process.cwd();
  try {
    console.log = (...a) => { capture.lines.push(a.join(" ")); };
    process.chdir(dir);
    mkdirSync("sources", { recursive: true });
    mkdirSync("docs", { recursive: true });
    writeFileSync("main.py", "print('synthetic')\n");
    writeFileSync("docs/runbook.md", "# Synthetic runbook\nsteps: one.\n");

    // 1) uningested claim fabricating DOC_INGEST_INDEXED -> refusal via verify
    let rc = await cliMain(["assess", "--session", "f1", "--files", "main.py",
      "--doc-status", "DOC_UPDATED", "--docs", "docs/runbook.md",
      "--ingest-status", "DOC_INGEST_INDEXED", "--capture-status", "CAPTURED"]);
    assert.equal(rc, 1);
    const first = JSON.parse(capture.lines[capture.lines.length - 1]);
    assert.equal(first.complete, false);
    assert.ok(first.findings.some((f) => /NOT verified for .*no ledger record/.test(f.replace(/\s+/g, " "))), first.findings);

    // 2) plant verified ledger evidence with the REAL current hash -> closes
    plantLedgerEvidence(dir, "docs/runbook.md");
    rc = await cliMain(["assess", "--session", "f1", "--files", "main.py",
      "--doc-status", "DOC_UPDATED", "--docs", "docs/runbook.md",
      "--ingest-status", "DOC_INGEST_INDEXED", "--capture-status", "CAPTURED"]);
    assert.equal(rc, 0, capture.lines[capture.lines.length - 1]);
    rc = await cliMain(["check", "--session", "f1"]);
    assert.equal(rc, 0);

    // 3) source changed afterwards -> evidence goes stale -> refusal
    writeFileSync("docs/runbook.md", "# Synthetic runbook\nsteps: one two.\n");
    rc = await cliMain(["check", "--session", "f1"]);
    assert.equal(rc, 1);
    const stale = JSON.parse(capture.lines[capture.lines.length - 1]);
    assert.ok(stale.findings.some((f) => /NOT verified for .*never indexed successfully|stale/.test(f.replace(/\s+/g, " "))), stale.findings);

    // fourth session: fabricated HASH-style claim with ledger missing verified_at
    // (record present but unverified) is still refused.
    plantLedgerEvidence(dir, "docs/runbook.md", { withVerified: false, staleSource: false });
    rc = await cliMain(["assess", "--session", "f2", "--files", "main.py",
      "--doc-status", "DOC_UPDATED", "--docs", "docs/runbook.md",
      "--ingest-status", "DOC_INGEST_INDEXED", "--capture-status", "CAPTURED"]);
    assert.equal(rc, 1);
    const unverified = JSON.parse(capture.lines[capture.lines.length - 1]);
    assert.ok(unverified.findings.some((f) => /NOT verified/.test(f)), unverified.findings);
  } finally {
    console.log = origLog;
    process.chdir(origCwd);
    rmSync(dir, { recursive: true, force: true });
  }
});

test("project-root scope mismatch refuses closure evidence", async () => {
  const wA = scratch();
  const wB = scratch();
  const capture = { lines: [] };
  const origLog = console.log;
  const origCwd = process.cwd();
  try {
    console.log = (...a) => { capture.lines.push(a.join(" ")); };
    process.chdir(wB);
    mkdirSync("docs", { recursive: true });
    writeFileSync("main.py", "x=1\n");
    // the doc identity belongs to workspace A (ledger planted there)
    mkdirSync(join(wA, "docs"), { recursive: true });
    writeFileSync(join(wA, "main.py"), "x=1\n");
    writeFileSync(join(wA, "docs", "runbook.md"), "# runbook ONLY ingested in workspace A\n");
    plantLedgerEvidence(wA, "docs/runbook.md");
    // evidence check with --project-root wB: recorded root is wA -> wrong workspace refusal
    const rc = await cliMain(["assess", "--session", "s-root", "--files", "main.py",
      "--doc-status", "DOC_UPDATED", "--docs", "docs/runbook.md",
      "--ingest-status", "DOC_INGEST_INDEXED", "--capture-status", "CAPTURED", "--project-root", wB]);
    assert.equal(rc, 1);
    const last = JSON.parse(capture.lines[capture.lines.length - 1]);
    assert.ok(last.findings.some((f) => /NOT verified|no ledger record|different workspace/.test(f.replace(/\s+/g, " "))), last.findings);
  } finally {
    console.log = origLog;
    process.chdir(origCwd);
    rmSync(wA, { recursive: true, force: true });
    rmSync(wB, { recursive: true, force: true });
  }
});

test("assessment records remain atomic and isolated per sanitized session", () => {
  const dir = scratch();
  try {
    const rec = { files: ["x.py"], docStatus: "DOC_BLOCKED", captureStatus: "NO_LESSON" };
    const p1 = writeAssessmentAtomic("we/ird:session", dir, rec);
    const p2 = writeAssessmentAtomic("ok-session", dir, rec);
    assert.ok(p1.includes("we_ird_session.json"));
    assert.ok(p2.includes("ok-session.json"));
    assert.equal(sanitizeSession("../../x"), "______x");
    assert.match(readFileSync(p1, "utf8"), /files/);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("discovery: eligible docs censused, baseline diff, doc-only + code-less updates still ingested", async () => {
  const dir = scratch();
  const ingested = [];
  const execFake = (file, args, opts, cb) => {
    if (args[1] === "ingest") {
      ingested.push(args.slice(0, 5).join(" "));
      cb(null, JSON.stringify({ status: "DOC_INGEST_INDEXED", file: "docs/new-note.md", chunks: 1 }), "");
      return;
    }
    if (args[1] === "verify") { cb(null, JSON.stringify({ status: "DOC_INGEST_NOT_VERIFIED", reason: "stub" }), ""); return; }
    cb(new Error("not a git repo"), "", ""); // git status fallback: unobservable
  };
  const doc = join(dir, "docs", "nested", "some note.md");
  mkdirSync(join(dir, "docs", "nested"), { recursive: true });
  writeFileSync(doc, "# space in name\n");
  writeFileSync(doc.replace(".md", ".env.hidden"), "secretly not valid md\n");
  const c = scanDocCensus(dir);
  assert.ok(c.has(resolve(doc)), "eligible md is censused");
  assert.ok(![...c.keys()].some((k) => k.endsWith(".env.hidden")), "secret-named files are never censused");

  // Baseline-less first pass records the census it will diff against (it must
  // not swallow the whole pre-existing docs tree into memory on install),
  // so the FIRST pass ingests nothing and says so honestly.
  const bootstrap = await autoIngestChangedDocs(dir, "sc1", { execImpl: execFake });
  assert.equal(bootstrap.ingested, 0, "baseline-less pass establishes the baseline, no mass ingestion");
  assert.ok(existsSync(baselinePath("sc1", dir)), "baseline recorded on disk");

  // A doc changed AFTER the baseline (the normal authoring flow) is discovered.
  const res = await autoIngestChangedDocs(dir, "sc1", { execImpl: execFake });
  // (nothing changed since the bootstrap pass)
  assert.equal(res.ingested, 0);
  writeFileSync(doc, "# space in name\n freshly authored body\n");
  const res3 = await autoIngestChangedDocs(dir, "sc1", { execImpl: execFake });
  assert.ok(res3.changedDocs.some((d) => d.rel.endsWith("some note.md")), "post-baseline new/changed doc discovered");
  assert.ok(res3.results.some((r) => r.status === "DOC_INGEST_INDEXED"));
  // one discovery pass runs exactly one ingest for this doc
  assert.ok(ingested.length === 1, ingested);
  assert.match(ingested[0], /ingest --file .* --/);

  // docs-only update (md classified non-material) is still detected & ingested
  const before = ingested.length;
  writeFileSync(doc, "# space in name\nupdated body again\n");
  const res2 = await autoIngestChangedDocs(dir, "sc1", { execImpl: execFake });
  assert.ok(res2.changedDocs.some((d) => d.rel.endsWith("some note.md")), "doc-only update is detected");
  assert.equal(ingested.length, before + 1);

  rmSync(dir, { recursive: true, force: true });
});

test("baseline recovery: unresolved ingestion keeps the change visible; resolved pass refreshes", async () => {
  const dir = scratch();
  mkdirSync(join(dir, "docs"), { recursive: true });
  // Deliberately different sizes: the refreshed baseline is asserted by its
  // recorded file-snapshot state, not by wall-clock timestamps (two records
  // written within the same millisecond would produce equal `created`).
  const oldBody = "# keep\nbody\n";
  writeFileSync(join(dir, "docs", "keep.md"), oldBody);
  const noop = (file, args, opts, cb) => {
    if (args[1] === "ingest") { cb(null, JSON.stringify({ status: "DOC_INGEST_INDEXED", file: "docs/keep.md" }), ""); return; }
    cb(new Error("no git"), "", "");
  };
  // Bootstrap baseline.
  await autoIngestChangedDocs(dir, "rec", { execImpl: noop });
  const rec1 = JSON.parse(readFileSync(baselinePath("rec", dir), "utf8"));
  const keepKey = Object.keys(rec1.files).find((k) => k.replace(/\\/g, "/").endsWith("docs/keep.md"));
  assert.ok(keepKey, "baseline snapshots the ingested doc");
  assert.equal(rec1.files[keepKey].size, Buffer.byteLength(oldBody), "snapshot reflects the bootstrap content");

  // Author a change; ingestion FAILS (gateway down). Baseline must NOT refresh,
  // so the change stays discoverable on the next check.
  writeFileSync(join(dir, "docs", "keep.md"), oldBody + "now unverified addition\n");
  const failImpl = (file, args, opts, cb) => {
    if (args[1] === "ingest") { cb(null, JSON.stringify({ status: "DOC_INGEST_PENDING", reason: "not searchable" }), ""); return; }
    cb(new Error("no git"), "", "");
  };
  const pass1 = await autoIngestChangedDocs(dir, "rec", { execImpl: failImpl });
  assert.equal(pass1.results[0].status, "DOC_INGEST_PENDING");
  const rec2 = JSON.parse(readFileSync(baselinePath("rec", dir), "utf8"));
  assert.deepEqual(rec2, rec1, "baseline record must be byte-identical while ingestion is unresolved");

  // Next check re-discovers the SAME change and now resolves it; baseline refreshes.
  const pass2 = await autoIngestChangedDocs(dir, "rec", { execImpl: noop });
  assert.ok(pass2.changedDocs.some((d) => d.rel.endsWith("keep.md")), "unchanged ingestion target is re-discovered");
  assert.equal(pass2.results[0].status, "DOC_INGEST_INDEXED");
  const rec3 = JSON.parse(readFileSync(baselinePath("rec", dir), "utf8"));
  assert.equal(rec3.files[keepKey].size, statSync(join(dir, "docs", "keep.md")).size,
    "baseline snapshot refreshes to the RESOLVED content (deterministic state assertion)");
  assert.notEqual(rec3.files[keepKey].size, rec1.files[keepKey].size,
    "the refreshed snapshot describes the changed body, not the original");

  rmSync(dir, { recursive: true, force: true });
});

test("observed material changes exclude pre-existing dirty files", async () => {
  const dir = scratch();
  const execFake = (file, args, opts, cb) => {
    if (args[0] === "status") cb(null, " M pre-existing.py\0", "");
    else cb(null, "", "");
  };
  const obs = await observeWorkspace(dir, "mb", { execImpl: execFake });
  assert.deepEqual(obs.newDirty, [], "baseline matches the present dirty set -> nothing attributed");
  const { material } = classifyFiles(obs.newDirty || []);
  assert.equal(material.length, 0);
  rmSync(dir, { recursive: true, force: true });
});

test("CLI end-to-end refuses material DOC_NOT_REQUIRED; check on unknown session refuses", async () => {
  const dir = scratch();
  const capture = { lines: [] };
  const origLog = console.log;
  const origCwd = process.cwd();
  try {
    console.log = (...a) => { capture.lines.push(a.join(" ")); };
    process.chdir(dir);
    let rc = await cliMain(["assess", "--session", "m1", "--files", "a.py", "--doc-status", "DOC_NOT_REQUIRED", "--reason", "small change", "--capture-status", "CAPTURED"]);
    assert.equal(rc, 1);
    rc = await cliMain(["check", "--session", "unknown-session"]);
    assert.equal(rc, 1);
    assert.match(JSON.parse(capture.lines[capture.lines.length - 1]).findings[0], /no assessment for this session/);
  } finally {
    console.log = origLog;
    process.chdir(origCwd);
    rmSync(dir, { recursive: true, force: true });
  }
});

// ── §7 automatic durable-learning assessment + §8 idempotent concurrency ──
test("§7 automatic assessment: CAPTURED only from verified ingestion evidence, never auto-approved", async () => {
  const dir = scratch();
  try {
    const env = { SINGULARITY_REPO_ROOT: dir };
    const rec = await recordAutomaticLearningAssessment("la1", dir, { env, results: [{ file: "docs/r.md", status: "DOC_INGEST_VERIFIED" }], observable: true, newDirty: ["docs/r.md"] });
    assert.equal(rec.status, "CAPTURED");
    const stored = loadAssessment("la1", dir);
    assert.equal(stored.captureStatus, "CAPTURED");
    assert.equal(stored.ingestion[0], "DOC_INGEST_VERIFIED", "CAPTURED is evidence-derived, not a claim");
    assert.equal(stored.automatic, true, "the record honestly marks its automatic origin");
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("§7 automatic assessment: NO_LESSON when nothing material was observed", async () => {
  const dir = scratch();
  try {
    const rec = await recordAutomaticLearningAssessment("la2", dir, { env: { SINGULARITY_REPO_ROOT: dir }, results: [], observable: true, newDirty: [] });
    assert.equal(rec.status, "NO_LESSON");
    assert.match(rec.detail, /nothing material/);
    const stored = loadAssessment("la2", dir);
    assert.equal(stored.captureStatus, "NO_LESSON");
    assert.equal(stored.docStatus, "DOC_NOT_REQUIRED");
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("§7 automatic assessment: material work without an agent token is DEFERRED, never lost", async () => {
  const dir = scratch();
  try {
    const rec = await recordAutomaticLearningAssessment("la3", dir, { env: { SINGULARITY_REPO_ROOT: dir }, results: [], observable: true, newDirty: ["src/a.py"] });
    assert.equal(rec.status, "DEFERRED");
    const stored = loadAssessment("la3", dir);
    assert.equal(stored.captureStatus, "DEFERRED");
    assert.match(stored.deferredPending, /data\/selflearn\/pending/);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("§7/§8 an agent-claimed assessment is NEVER overwritten, and repeats are idempotent", async () => {
  const dir = scratch();
  try {
    writeAssessmentAtomic("la4", dir, { files: ["a.py"], docStatus: "DOC_UPDATED", docs: ["docs/r.md"], ingestion: ["DOC_INGEST_INDEXED"], captureStatus: "CAPTURED" });
    const before = loadAssessment("la4", dir);
    const rec = await recordAutomaticLearningAssessment("la4", dir, { env: { SINGULARITY_REPO_ROOT: dir }, results: [{ file: "docs/r.md", status: "DOC_INGEST_VERIFIED" }], observable: true });
    assert.equal(rec.status, "CAPTURED");
    assert.equal(rec.assessment, null, "no second write happened");
    const after = loadAssessment("la4", dir);
    assert.deepEqual(after, before, "the agent-claimed record is byte-identical after the automatic pass");
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("§8 two simultaneous evaluations on two sessions produce one authoritative record per session", async () => {
  const dir = scratch();
  const jobs = [];
  try {
    for (let i = 0; i < 2; i++) {
      for (let k = 0; k < 8; k++) { // repeated triggered passes, as concurrent hooks can fire twice
        jobs.push(recordAutomaticLearningAssessment(`conc${i}`, dir, { env: { SINGULARITY_REPO_ROOT: dir }, results: [{ file: `docs/s${i}.md`, status: "DOC_INGEST_VERIFIED" }], observable: true, newDirty: [`docs/s${i}.md`] }));
      }
    }
    const all = await Promise.all(jobs);
    for (let i = 0; i < 2; i++) {
      const recs = all.filter((r) => r.status === "CAPTURED"); // same disposition every time
      assert.ok(recs.length >= 8, "every concurrent pass resolves to the same verified disposition");
      const stored = loadAssessment(`conc${i}`, dir);
      assert.equal(stored.captureStatus, "CAPTURED");
      assert.ok(stored.files.includes(`docs/s${i}.md`), `session conc${i} owns its own authoritative record`);
    }
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("§7 autoIngestChangedDocs carries the automatic learning disposition in its result", async () => {
  const dir = scratch();
  const origCwd = process.cwd();
  try {
    writeFileSync(join(dir, "README.md"), "# scratch project doc\n");
    process.chdir(dir);
    const r = await autoIngestChangedDocs(dir, "la7");
    assert.ok(r.learning, "the pass reports its learning disposition");
    assert.equal(r.learning.status, "NO_LESSON", "nothing changed in a fresh checkout → honest NO_LESSON, not silence");
  } finally {
    process.chdir(origCwd);
    rmSync(dir, { recursive: true, force: true });
  }
});
