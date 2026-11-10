import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { doctor } from "../scripts/doctor.mjs";
import { CANDIDATE_SCHEMA } from "../scripts/selflearn-candidates.mjs";

const scratch = () => mkdtempSync(join(tmpdir(), "doctor-selflearn-"));

test("doctor: native status honors an explicitly injected documentation ledger without PATH", async () => {
  const dir = scratch();
  const ledgerRoot = join(dir, "injected-doc-data");
  try {
    mkdirSync(join(ledgerRoot, "doc-index"), {recursive: true});
    writeFileSync(join(ledgerRoot, "doc-index", "ledger.json"), JSON.stringify({version: 1, docs: {
      "docs/probe.md": {revs: {}, active_rev: null},
    }}));
    const sections = await doctor({env: {
      SINGULARITY_REPO_ROOT: dir,
      PATH: '',
      SINGULARITY_DOC_DATA: ledgerRoot,
      SINGULARITY_CLAUDE_CODE_STATE: join(dir, "no-install.json"),
      SINGULARITY_ORDINARY_SESSION_EVIDENCE: join(dir, "no-evidence.json"),
    }, fetchImpl: async () => {throw new Error("offline test");}});
    const row = sections.find(section => section.name === "doc-ingestion");
    assert.equal(row.state, "INCOMPLETE");
    assert.match(row.detail, /pending 1/);
  } finally {rmSync(dir, {recursive: true, force: true});}
});

test("doctor: default native ledger follows the selected project and malformed data is degraded", async () => {
  const dir = scratch();
  try {
    const ledger = join(dir, 'data/doc-index/ledger.json');
    mkdirSync(join(dir, 'data/doc-index'), {recursive: true});
    writeFileSync(ledger, JSON.stringify({version: 1, docs: {'docs/probe.md': {revs: {}, active_rev: null}}}));
    const options = {env: {PATH: '', SINGULARITY_REPO_ROOT: dir,
      SINGULARITY_CLAUDE_CODE_STATE: join(dir, 'no-install.json'),
      SINGULARITY_ORDINARY_SESSION_EVIDENCE: join(dir, 'no-evidence.json')},
    fetchImpl: async () => {throw new Error('offline test');}};
    let row = (await doctor(options)).find(section => section.name === 'doc-ingestion');
    assert.equal(row.state, 'INCOMPLETE');
    assert.match(row.detail, /pending 1/);
    writeFileSync(ledger, '{malformed');
    row = (await doctor(options)).find(section => section.name === 'doc-ingestion');
    assert.equal(row.state, 'DEGRADED');
  } finally {rmSync(dir, {recursive: true, force: true});}
});

function plantPromoted(dir) {
  const pending = join(dir, "data", "selflearn", "pending");
  mkdirSync(pending, { recursive: true });
  const now = new Date().toISOString();
  writeFileSync(join(pending, "abc12345.json"), JSON.stringify({
    schema: CANDIDATE_SCHEMA,
    id: "abc12345",
    session: "s1",
    scope: { project: dir, agent: "agent" },
    files: ["src/a.py"],
    state: "PROMOTED",
    createdAt: now,
    updatedAt: now,
    resolvedAt: now,
    promotion: { reference: "InitBeforeQuery", promotedAt: now },
  }));
}

test("doctor: the selflearn row reads THIS project's store, and refuses receiptless legacy promotion", async () => {
  const dir = scratch();
  try {
    plantPromoted(dir);
    const sections = await doctor({
      env: {
        SINGULARITY_REPO_ROOT: dir,
        SINGULARITY_CLAUDE_CODE_STATE: join(dir, "no-install.json"),
        SINGULARITY_ORDINARY_SESSION_EVIDENCE: join(dir, "no-evidence.json"),
      },
      fetchImpl: async () => { throw new Error("offline test"); },
    });
    const row = sections.find((s) => s.name === "selflearn");
    assert.ok(row, "doctor always reports a selflearn row");
    assert.equal(row.state, "INCOMPLETE");
    assert.equal(row.root, dir, "the reported store is the project root the hooks write to");
    assert.match(row.detail, /promoted 0/);
    assert.match(row.detail, /awaiting verification 1/);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("doctor: an empty store is NOT_CONFIGURED, never VERIFIED", async () => {
  const dir = scratch();
  try {
    const sections = await doctor({
      env: {
        SINGULARITY_REPO_ROOT: dir,
        SINGULARITY_CLAUDE_CODE_STATE: join(dir, "no-install.json"),
        SINGULARITY_ORDINARY_SESSION_EVIDENCE: join(dir, "no-evidence.json"),
      },
      fetchImpl: async () => { throw new Error("offline test"); },
    });
    const row = sections.find((s) => s.name === "selflearn");
    assert.equal(row.state, "NOT_CONFIGURED");
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
