// Regression tests for scripts/acceptance-ordinary-session.mjs (§5 round).
// The harness must fail CLOSED: absent environment → INCOMPLETE, fabricated
// or hand-builder evidence → rejected, and no path may report a pass without
// the live memory service corroborating the tag.
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  EVKIND, EVVERSION, STAGES,
  evidenceVerdict, verifyEvidenceLive, record,
} from "./acceptance-ordinary-session.mjs";

const uuid = () => `84e0f0d4-1c0a-4e2a-9b7e-${Math.random().toString(16).slice(2, 14).padEnd(12, "0").slice(0, 12)}`;

function completeEvidence(over = {}) {
  return {
    kind: EVKIND, version: EVVERSION, runtime: "claude-code",
    tag: "SING-ORD-" + "ab12cd34",
    startedAt: new Date().toISOString(),
    completedAt: new Date().toISOString(),
    distinctSessions: true,
    sessions: [{ id: uuid(), role: "capture" }, { id: uuid(), role: "recall" }],
    stages: STAGES.map((s) => ({ stage: s, state: "VERIFIED", detail: "" })),
    cleanupScope: ["both disposable workspaces removed"],
    ...over,
  };
}

test("stage record shape is strict and non-claiming", () => {
  const r = record("PERSISTED", true, "searchable");
  assert.equal(r.state, "VERIFIED");
  assert.equal(record("PERSISTED", false, "not found").state, "FAILED");
});

test("static verdict rejects missing stages, shared ids, non-UUID ids and key-shaped material", () => {
  assert.equal(evidenceVerdict(completeEvidence()).state, "VERIFIED", "a schema-complete file passes the STATIC layer (live layer decides the pass)");
  const noStage = completeEvidence();
  noStage.stages = noStage.stages.filter((s) => s.stage !== "PERSISTED");
  assert.match(evidenceVerdict(noStage).detail, /PERSISTED/);
  const shared = completeEvidence();
  shared.sessions = [{ id: shared.sessions[0].id }, { id: shared.sessions[0].id }];
  shared.distinctSessions = false;
  assert.match(evidenceVerdict(shared).detail, /DISTINCT/);
  const junk = completeEvidence();
  junk.sessions = [{ id: "aa" }, { id: "bb" }];
  assert.match(evidenceVerdict(junk).detail, /UUID/);
  const keyed = completeEvidence();
  keyed.stages.push({ stage: "EXTRA", state: "VERIFIED", detail: "sk-abcdef123456= leaked" });
  assert.match(evidenceVerdict(keyed).detail, /key-shaped/);
});

test("the LIVE layer can never pass without the real memory service", async () => {
  const none = await verifyEvidenceLive(completeEvidence(), { env: { SINGULARITY_MEMORY_CONFIG: "/nonexistent.json" } });
  assert.equal(none.state, "INCOMPLETE");
  assert.equal(none.ok, false);
});

test("a stale or timestamp-impossible evidence is rejected", () => {
  const old = completeEvidence({ startedAt: new Date(Date.now() - 30 * 24 * 3600 * 1000).toISOString() });
  assert.match(evidenceVerdict(old).detail, /stale|timestamps/);
  const reversed = completeEvidence({ completedAt: new Date(Date.now() - 3600 * 1000).toISOString() });
  assert.match(evidenceVerdict(reversed).detail, /timestamps/);
});
