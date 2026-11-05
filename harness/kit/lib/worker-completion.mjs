// lib/worker-completion.mjs — ticket 164 Wave-1 foundation (plan §7.5, §19.6).
// Workers return machine-readable completion info BEFORE narrative prose; the
// coordinator consumes THESE fields. A prose "done" never overrides a failed
// criterion, missing evidence, or a known blocking defect.
//
// Worker status files carry a fenced ```json block:
//   ```json
//   { "workerCompletion": { "status": "complete", "changedFiles": [...],
//       "criteriaResults": [...], "tests": [...], "runtimeEvidence": [...],
//       "deviations": [...], "knownIssues": [...], "rollbackPoint": "sha" } }
//   ```
// The narrative summary is advisory; this record is authoritative.
// No new transport — same fenced-block convention as extractMemoryCandidates.

export const COMPLETION_STATUSES = ["complete", "partial", "failed", "blocked"];
export const REQUIRED_FIELDS = [
  "status", "changedFiles", "criteriaResults", "tests",
  "runtimeEvidence", "deviations", "knownIssues", "rollbackPoint",
];

// Parse all fenced json blocks in one status text and return the first valid
// workerCompletion record (or null). Never throws.
export function parseWorkerCompletion(statusText) {
  const m = String(statusText ?? "").match(/```json\s*\n([\s\S]*?)```/);
  if (!m) return null;
  try {
    const raw = JSON.parse(m[1]);
    const rec = raw?.workerCompletion ?? null;
    return rec && typeof rec === "object" ? rec : null;
  } catch { return null; }
}

// Extract the completion record from a set of worker status texts.
// Returns { found, completion, fromIndex, problems }.
export function extractWorkerCompletion(statusTexts) {
  const texts = Array.isArray(statusTexts) ? statusTexts : [statusTexts];
  for (let i = 0; i < texts.length; i++) {
    const rec = parseWorkerCompletion(texts[i]);
    if (rec) {
      const problems = validateWorkerCompletion(rec);
      return { found: true, completion: rec, fromIndex: i, problems };
    }
  }
  return { found: false, completion: null, fromIndex: -1, problems: ["no workerCompletion block in any status text"] };
}

// Validate required fields + value shapes. Problems are gate-relevant facts,
// not exceptions: a record missing fields is INCOMPLETE evidence of completion.
export function validateWorkerCompletion(rec) {
  const problems = [];
  if (!rec || typeof rec !== "object") return ["record not an object"];
  for (const f of REQUIRED_FIELDS) {
    if (rec[f] === undefined) problems.push(`missing required field: ${f}`);
  }
  if (rec.status !== undefined && !COMPLETION_STATUSES.includes(rec.status)) {
    problems.push(`status must be one of ${COMPLETION_STATUSES.join("|")}`);
  }
  if (rec.changedFiles !== undefined && !Array.isArray(rec.changedFiles)) problems.push("changedFiles must be an array");
  if (rec.criteriaResults !== undefined) {
    if (!Array.isArray(rec.criteriaResults)) problems.push("criteriaResults must be an array");
    else {
      for (const c of rec.criteriaResults) {
        if (c && c.pass === false) { /* failed criterion — valid record, surfaced by gate */ }
        else if (c && typeof c !== "object") problems.push("criteriaResults entries must be objects");
      }
    }
  }
  if (rec.deviations !== undefined && !Array.isArray(rec.deviations)) problems.push("deviations must be an array");
  return problems;
}

// Authoritative completion decision (plan §19.6): coordinator progression
// consumes this, not prose. Narrative NEVER overrides:
//  - a failed criterion (pass === false)
//  - a missing/invalid record (problems.length > 0)
//  - a blocking known issue
//  - status !== "complete"
export function completionGateDecision({ found, completion, problems }) {
  if (!found) return { allow: false, reason: "NO_COMPLETION_RECORD", advisory: "prose-only completion claims do not pass" };
  if (problems.length) return { allow: false, reason: "INVALID_COMPLETION_RECORD", detail: problems.join("; ") };
  if (completion.status !== "complete") return { allow: false, reason: `STATUS_${String(completion.status).toUpperCase()}` };
  const failed = (completion.criteriaResults ?? []).filter((c) => c && c.pass === false);
  if (failed.length) return { allow: false, reason: "FAILED_CRITERIA", detail: failed.map((c) => c.criterionId ?? "?").join(",") };
  const blocking = (completion.knownIssues ?? []).filter((k) => /block/i.test(String(k)));
  if (blocking.length) return { allow: false, reason: "BLOCKING_KNOWN_ISSUE", detail: blocking.join("; ").slice(0, 160) };
  return { allow: true, reason: "OK" };
}
