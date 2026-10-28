// lib/no-change.mjs — ticket 164 Wave 5 (plan §19.5): deterministic no-change
// fast path. If a phase produced no changed file, no changed state, no failed
// criterion, and no unresolved material finding, record NO_CHANGE and skip the
// normal implementation review; the evidence manifest records why. Also:
// accepted evidence reuse — when evidence hash + source revision + config
// revision + criterion are all unchanged, previously accepted validation
// evidence is reused without another model call.

import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";

const sha = (s) => createHash("sha256").update(s).digest("hex");

export function evaluateNoChange({ changedFiles = [], changedState = false, failedCriteria = 0, unresolvedMaterialFindings = 0 } = {}) {
  const noChange = changedFiles.length === 0 && !changedState && failedCriteria === 0 && unresolvedMaterialFindings === 0;
  return {
    noChange,
    record: noChange
      ? {
          verdict: "NO_CHANGE",
          why: "no changed file, no changed state, no failed criterion, no unresolved material finding — implementation review skipped per plan §19.5",
          at: new Date().toISOString(),
        }
      : null,
  };
}

// Reusable-acceptance check: ALL four must be unchanged to reuse prior
// accepted evidence (plan §19.5); any mismatch forces a fresh validation.
export function canReuseAcceptedEvidence({ priorEvidenceHash, priorSourceRevision, priorConfigRevision, priorCriterion, currentEvidenceHash, currentSourceRevision, currentConfigRevision, currentCriterion }) {
  const same =
    priorEvidenceHash === currentEvidenceHash &&
    priorSourceRevision === currentSourceRevision &&
    priorConfigRevision === currentConfigRevision &&
    priorCriterion === currentCriterion;
  return { reusable: same, why: same ? "evidence hash, source revision, config revision, and criterion all unchanged — accepted evidence reused (§19.5)" : "one or more of evidence/source/config/criterion changed — fresh validation required" };
}

export function hashEvidenceText(text) { return sha(String(text)); }

export function loadReusableCache(runDir) {
  const p = join(runDir, "accepted-evidence-cache.json");
  try { return existsSync(p) ? JSON.parse(readFileSync(p, "utf8")) : { schema: 1, entries: [] }; } catch { return { schema: 1, entries: [] }; }
}
