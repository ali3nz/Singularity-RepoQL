// lib/run-health.mjs — ticket 164 Wave 5 (plan §19.9): ONE derived health
// summary per run, regenerated from authoritative Orchestra state (ledger,
// case state, worker lease, evidence manifest, GitHub projection status,
// learning status). OpenChamber and Pixel DISPLAY it; they never determine
// authority. Not separately authoritative — a pure derivation.
//
// Shape (plan §7.7):
// {
//   retrieval: "healthy" | "degraded" | "failed",
//   worker:    "active" | "waiting_external" | "waiting_gate" | "stalled" | "expired" | "complete" | "none",
//   gate:      "pending" | "accepted" | "blocked" | "not_required",
//   evidence:  "complete" | "incomplete" | "failed",
//   github:    "synced" | "pending" | "failed" | "not_required",
//   learning:  "captured" | "pending" | "not_required" | "failed",
//   generatedAt, runId
// }

import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

function readJson(p) {
  try { return JSON.parse(readFileSync(p, "utf8")); } catch { return null; }
}

// retrieval: healthy iff the RepoQL client probe path reported ok (or was not
// consulted); degraded iff a typed REPOQL_UNREACHABLE/ZERO_RESULTS note exists;
// failed iff the run recorded a retrieval failure blocking a gate.
function deriveRetrieval(state) {
  const notes = state?.retrievalNotes ?? state?.retrieval ?? null;
  if (notes === "failed") return "failed";
  if (notes === "degraded" || notes === "unreachable") return "degraded";
  return "healthy"; // ticket 164 Phase 9+: RepoQL is the active path
}

function deriveWorker(state, lease) {
  if (state?.runState === "COMPLETED") return "complete";
  const ls = lease?.state ?? state?.workerLeaseState ?? null;
  const allowed = ["active", "waiting_external", "waiting_gate", "stalled", "expired"];
  if (ls && allowed.includes(ls)) return ls;
  if (state?.runState) return "active";
  return "none";
}

function deriveGate(state) {
  const g = state?.gateState ?? state?.gate ?? null;
  if (g === "accepted" || g === "blocked" || g === "not_required") return g;
  if (state?.gatePending) return "pending";
  return "not_required";
}

function deriveEvidence(state, manifestPath) {
  const m = manifestPath && existsSync(manifestPath) ? readJson(manifestPath) : null;
  const claimed = (state?.criteriaResults ?? []).filter((c) => c?.ok === false).length;
  if (claimed > 0) return "failed";
  if (!m || !Array.isArray(m.entries) || m.entries.length === 0) {
    return (state?.evidenceComplete === true) ? "complete" : "incomplete";
  }
  const unhashed = m.entries.filter((e) => !e.sha256).length;
  return unhashed === 0 ? "complete" : "incomplete";
}

function deriveGithub(state, ghStatus) {
  const s = ghStatus ?? state?.githubStatus ?? null;
  if (s === "synced" || s === "pending" || s === "failed" || s === "not_required") return s;
  if (state?.githubIssue) return "synced";
  return "not_required";
}

function deriveLearning(state) {
  const l = state?.learningStatus ?? null;
  if (l === "captured" || l === "pending" || l === "not_required" || l === "failed") return l;
  if (state?.journalOutcomeAt) return "captured";
  if (state?.memory?.stagedRefs?.length || state?.memory?.staging) return "captured";
  return "not_required";
}

export function deriveRunHealth({ runId = null, runDir = null, state = null, lease = null, ghStatus = null } = {}) {
  let st = state;
  let manifestPath = null;
  if (!st && runDir) {
    st = readJson(join(runDir, "state.json")) ?? readJson(join(runDir, "case.json"));
    manifestPath = join(runDir, "evidence-manifest.json");
  }
  if (runDir && !manifestPath) manifestPath = join(runDir, "evidence-manifest.json");
  return {
    schema: 1,
    runId: runId ?? st?.runId ?? null,
    generatedAt: new Date().toISOString(),
    retrieval: deriveRetrieval(st ?? {}),
    worker: deriveWorker(st ?? {}, lease ?? {}),
    gate: deriveGate(st ?? {}),
    evidence: deriveEvidence(st ?? {}, manifestPath),
    github: deriveGithub(st ?? {}, ghStatus),
    learning: deriveLearning(st ?? {}),
  };
}

// Batch view for OpenChamber/Pixel: one summary per run dir, newest first.
export function deriveFleetHealth(runsRoot, { limit = 20 } = {}) {
  const { readdirSync, statSync } = require("node:fs");
  let dirs = [];
  try { dirs = readdirSync(runsRoot, { withFileTypes: true }).filter((d) => d.isDirectory()).map((d) => d.name); } catch { return []; }
  dirs.sort().reverse();
  const out = [];
  for (const d of dirs.slice(0, limit * 3)) {
    if (out.length >= limit) break;
    if (d === "consult" || d.startsWith("convreview")) continue;
    const full = join(runsRoot, d);
    try { if (!statSync(full).isDirectory()) continue; } catch { continue; }
    out.push(deriveRunHealth({ runId: d, runDir: full }));
  }
  return out;
}
