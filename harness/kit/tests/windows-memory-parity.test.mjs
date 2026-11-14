// Windows Singularity memory parity for Dockerhost fleet#1219.
// The RepoQL concept API uses repository-root-relative file:/// addresses,
// not physical drive-letter paths. No host path normalization is performed here.
import test from "node:test";
import assert from "node:assert/strict";
import { createPlannerExecutors } from "../lib/memory-orchestra/executors.mjs";
import { createBuildContextPack } from "../lib/context-pack.mjs";

const oneFile = "file:///harness/kit/lib/memory-orchestra/executors.mjs";
const namedConcept = "concept:///rule/MemorycoreCaptureAdmissionGates.md";

function harness(applicability) {
  const calls = { addresses: [], searches: [] };
  const repoql = {
    async conceptApplicability({ scope }) {
      calls.addresses.push(scope);
      return applicability;
    },
    async query({ q, scope }) {
      calls.searches.push({ q, scope });
      return { ok: true, results: [{ uri: namedConcept, headline: "Admission gates", score: 0.85 }] };
    },
  };
  const ex = createPlannerExecutors({ repoql });
  const fetch = (affectedPaths, query = "admission gate") =>
    ex.repoql.concepts({ query, scope: { affectedPaths }, topK: 4 });
  return { fetch, calls };
}

test("one file retains its exact RepoQL file URI", async () => {
  const h = harness({ ok: true, status: "CONCEPTS_APPLICABLE", results: [{ uri: namedConcept }] });
  const r = await h.fetch([oneFile]);
  assert.equal(r.ok, true);
  assert.deepEqual(h.calls.addresses, [oneFile]);
  assert.equal(r.results[0].verification, "concept-applicability");
  assert.equal(h.calls.searches.length, 0);
});

test("a repository-root URI including Windows-looking segments is not rewritten", async () => {
  const uri = "file:///C:/workspace/src/config.mjs";
  const h = harness({ ok: true, status: "CONCEPTS_APPLICABLE", results: [] });
  await h.fetch([uri]);
  assert.deepEqual(h.calls.addresses, [uri]);
});

test("multiple target files retain the existing parent directory semantics", async () => {
  const h = harness({ ok: true, status: "CONCEPTS_APPLICABLE", results: [] });
  await h.fetch(["file:///harness/kit/lib/a.mjs", "file:///harness/kit/lib/b.mjs"]);
  assert.deepEqual(h.calls.addresses, ["file:///harness/kit/lib/"]);
});

test("semantic retrieval is used only for a provable local registry dead end", async () => {
  const h = harness({
    ok: true, status: "ZERO_RESULTS", mode: "local",
    evidence: { scopeRegistryVersion: null }, results: [],
  });
  const r = await h.fetch([oneFile]);
  assert.equal(r.ok, true);
  assert.equal(r.applicabilityFallback, "semantic");
  assert.equal(r.applicabilityStatus, "ZERO_RESULTS");
  assert.equal(r.results[0].verification, "concept-gate");
  assert.deepEqual(h.calls.searches, [{ q: "admission gate", scope: "concepts" }]);
});

test("a healthy zero-result applicability lookup does not widen retrieval", async () => {
  const h = harness({
    ok: true, status: "ZERO_RESULTS", mode: "local",
    evidence: { scopeRegistryVersion: "v1" }, results: [],
  });
  const r = await h.fetch([oneFile]);
  assert.deepEqual(r.results, []);
  assert.equal(h.calls.searches.length, 0);
});

test("failed applicability fails typed and does not widen retrieval", async () => {
  const h = harness({ ok: false, code: "SCOPE_NOT_FOUND", results: [] });
  const r = await h.fetch([oneFile]);
  assert.equal(r.ok, false);
  assert.equal(r.code, "SCOPE_NOT_FOUND");
  assert.equal(h.calls.searches.length, 0);
});

test("missing query in dead-end fallback uses the target URI", async () => {
  const h = harness({
    ok: true, status: "ZERO_RESULTS", mode: "local",
    evidence: { scopeRegistryVersion: null }, results: [],
  });
  await h.fetch([oneFile], "");
  assert.equal(h.calls.searches[0].q, oneFile);
});

test("TURN_START with planner/fusion/ledger enabled never throws ReferenceError", async () => {
  const saved = Object.fromEntries(["ORCH_MORCH_PLANNER", "ORCH_MORCH_FUSION", "ORCH_MORCH_LEDGER", "ORCH_MORCH_DISABLE"].map(k => [k, process.env[k]]));
  process.env.ORCH_MORCH_PLANNER = "ENABLED";
  process.env.ORCH_MORCH_FUSION = "ENABLED";
  process.env.ORCH_MORCH_LEDGER = "ENABLED";
  process.env.ORCH_MORCH_DISABLE = "0";
  try {
    const make = createBuildContextPack({ repoqlPrimary: false });
    const result = await make({ stage: "PLAN", mandatory: { task: "dry run" } });
    assert.ok(result.manifest.memoryOrchestra);
    assert.doesNotMatch(String(result.manifest.memoryOrchestra.code ?? ""), /ReferenceError/);
    assert.ok(result.pack.includes("dry run"));
  } finally {
    for (const [key, value] of Object.entries(saved)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
});
