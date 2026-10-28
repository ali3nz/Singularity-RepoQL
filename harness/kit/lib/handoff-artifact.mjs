// lib/handoff-artifact.mjs — V3.4.0 Phase 2 (ticket 088, plan §8).
// Deterministic handoff.json projection per active case. It is a PROJECTION:
// authoritative fields are copied from case.json/state, agents can never write
// it back to authority (plan §8 rules + acceptance 13). Regenerated on every
// lifecycle transition via regenerateHandoff().
import { createHash } from "node:crypto";
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";

function sha16(s) { return createHash("sha256").update(String(s ?? "")).digest("hex").slice(0, 16); }

// Pure projection builder. state: the run's state.json snapshot (or null);
// cs: parsed case.json (or null). Deterministic: same inputs -> same bytes.
export function buildHandoff({ runNumber = null, caseId = null, caseRev = null, title = null, state = null, cs = null, memory = null, operatorQuery = null, extras = {} } = {}) {
  const st = state ?? {};
  const cas = cs ?? {};
  const handoff = {
    schema: 1,
    runNumber,
    caseId: caseId ?? st.runId ?? cas.caseId ?? null,
    caseRev,
    title,
    phaseCompleted: st.completedThrough != null ? st.completedThrough : (cas.completedThrough ?? null),
    nextPhase: st.currentPhase ?? cas.currentPhase ?? null,
    runState: st.runState ?? cas.runState ?? null,
    objective: cas.objective ?? cas.task ?? st.task ?? null,
    approvedPlanDigest: cas.approvedPlanDigest ?? st.approvedPlanDigest ?? null,
    policyDigest: cas.policyDigest ?? st.policyDigest ?? null,
    changedFiles: (st.changedFiles ?? cas.changedFiles ?? []).slice(0, 200),
    tests: (st.tests ?? cas.tests ?? []).slice(0, 100),
    verifiedFacts: (st.verifiedFacts ?? cas.verifiedFacts ?? []).slice(0, 100),
    openFindings: (st.findings ?? cas.findings ?? []).slice(0, 100),
    knownResiduals: (st.knownResiduals ?? cas.knownResiduals ?? []).slice(0, 100),
    memoryCandidateIds: memory?.candidateIds ?? [],
    durableMemoryRefs: memory?.durableRefs ?? [],
    operatorQuery,
    doNotAssume: (st.doNotAssume ?? cas.doNotAssume ?? []).slice(0, 50),
    nextAction: st.nextAction ?? cas.nextAction ?? null,
    generatedAt: new Date().toISOString(),
  };
  Object.assign(handoff, extras);
  // Digest over the content EXCLUDING generatedAt so equal content -> equal digest.
  const { generatedAt, ...digestBody } = handoff;
  handoff.handoffDigest = sha16(JSON.stringify(digestBody));
  return handoff;
}

// Regenerate + write handoff.json for a run dir. Returns { handoff, digest, path }.
export function regenerateHandoff(runDir, inputs) {
  const handoff = buildHandoff(inputs);
  mkdirSync(runDir, { recursive: true });
  const path = join(runDir, "handoff.json");
  writeFileSync(path, JSON.stringify(handoff, null, 2) + "\n");
  return { handoff, digest: handoff.handoffDigest, path };
}

export function readHandoff(runDir) {
  try { return JSON.parse(readFileSync(join(runDir, "handoff.json"), "utf8")); }
  catch { return null; }
}
