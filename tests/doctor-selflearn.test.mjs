import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { doctor } from "../scripts/doctor.mjs";
import { CANDIDATE_SCHEMA } from "../scripts/selflearn-candidates.mjs";

const scratch = () => mkdtempSync(join(tmpdir(), "doctor-selflearn-"));

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

test("doctor: the selflearn row reads THIS project's store, so a promoted lesson is VERIFIED", async () => {
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
    assert.equal(row.state, "VERIFIED");
    assert.equal(row.root, dir, "the reported store is the project root the hooks write to");
    assert.match(row.detail, /promoted 1/);
    assert.match(row.detail, /InitBeforeQuery/);
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
