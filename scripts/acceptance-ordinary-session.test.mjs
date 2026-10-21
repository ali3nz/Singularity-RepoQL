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

const ses = (n) => `ses_${"abcdef123456".slice(0, 8)}${n}`;

function completeOpenchamberEvidence(over = {}) {
  return {
    kind: EVKIND, version: EVVERSION, runtime: "openchamber", option: 3,
    tag: "SING-ORD-" + "ef56ab90",
    startedAt: new Date().toISOString(),
    completedAt: new Date().toISOString(),
    distinctSessions: true,
    sessions: [{ id: ses("a"), role: "capture", eventObserved: true }, { id: ses("b"), role: "recall", eventObserved: true }],
    stages: STAGES.map((s) => ({ stage: s, state: "VERIFIED", detail: "" })),
    memoryScope: { serviceId: "openchamber", teamId: "project-abcdef0123456789", agentId: "build", userId: "pilot-operator" },
    cleanupScope: ["the disposable workspace was removed"],
    ...over,
  };
}

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

test("options never share acceptance evidence across runtimes (§4 binding)", () => {
  // A Claude Code file can NEVER satisfy the OpenChamber gate.
  const oc = evidenceVerdict(completeOpenchamberEvidence(), { expectRuntime: "openchamber", expectOption: 3 });
  assert.equal(oc.state, "VERIFIED");
  const ccGate = evidenceVerdict(completeOpenchamberEvidence(), { expectRuntime: "claude-code" });
  assert.equal(ccGate.ok, false);
  assert.match(ccGate.detail, /openchamber.*claude-code|claude-code.*own driver/s);
  const ocGate = evidenceVerdict(completeEvidence(), { expectRuntime: "openchamber" });
  assert.equal(ocGate.ok, false);
  assert.match(ocGate.detail, /claude-code/);
});

test("option 3 evidence can never satisfy an option 4 gate", () => {
  const gate = evidenceVerdict(completeOpenchamberEvidence({ option: 3 }), { expectRuntime: "openchamber", expectOption: 4 });
  assert.equal(gate.ok, false);
  assert.match(gate.detail, /option 3.*option 4|never share/s);
  assert.equal(evidenceVerdict(completeOpenchamberEvidence({ option: 4 }), { expectRuntime: "openchamber", expectOption: 4 }).state, "VERIFIED");
});

test("OpenChamber evidence must record observed native events and its memory scope", () => {
  const noEvents = completeOpenchamberEvidence({ sessions: [{ id: ses("a"), role: "capture" }, { id: ses("b"), role: "recall" }] });
  assert.match(evidenceVerdict(noEvents, { expectRuntime: "openchamber", expectOption: null }).detail, /observed native lifecycle events|record the observed/);
  const noScope = completeOpenchamberEvidence({ memoryScope: null });
  assert.match(evidenceVerdict(noScope, { expectRuntime: "openchamber" }).detail, /memory scope/);
  // non-ses_ ids are not OpenChamber-native ids
  const foreignIds = completeOpenchamberEvidence({ sessions: [{ id: uuid(), role: "capture", eventObserved: true }, { id: uuid(), role: "recall", eventObserved: true }] });
  assert.match(evidenceVerdict(foreignIds, { expectRuntime: "openchamber" }).detail, /OpenChamber/);
});

test("legacy version-1 evidence stays valid ONLY for the default claude-code gate", () => {
  const legacy = completeEvidence();
  legacy.version = 1;
  assert.equal(evidenceVerdict(legacy).ok, true);
  const ocGate = evidenceVerdict(legacy, { expectRuntime: "openchamber" });
  assert.equal(ocGate.ok, false);
  assert.match(ocGate.detail, /harness "claude-code"/);
});

test("the live layer binds the openchamber memory scope to the live target, never the package default", async () => {
  const e = completeOpenchamberEvidence();
  const r = await verifyEvidenceLive(e, { env: { SINGULARITY_MEMORY_CONFIG: "/nonexistent.json" } });
  assert.equal(r.ok, false);
  assert.equal(r.state, "INCOMPLETE");
});
