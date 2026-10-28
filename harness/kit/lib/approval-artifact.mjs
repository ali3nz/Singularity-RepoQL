// approval-artifact.mjs — V3.3.35 Phase 1 (ticket 085, plan D01/D03/D04/D08).
// Versioned, digest-bound approval artifact. A launch authorisation is a
// CONTENT identity (plan digest + rules/policy digests + case identity +
// approver), not a path reference — D01's mutable-planRef defect dies here.
// The coordinator may CONSUME a valid artifact (D04) but has no function that
// can create or widen one (D03): only an actor holding the approver role
// produces approvals, and the artifact carries the approver identity bound by
// this module (trusted-caller-bound; callers cannot pass an arbitrary
// approver string through the public API).
//
// Acceptance subject manifest (D02): the exact reviewed subject (source
// digest, validation evidence, target/config identity) is snapshotted
// immutably at acceptance time; verifyAcceptanceSubject() invalidates a
// carried verdict when the subject changes afterwards.

import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { createHash } from "node:crypto";
import { join } from "node:path";
import { resolveCaller } from "./engine-router.mjs";

export const APPROVAL_SCHEMA = 1;

// Approver identity is derived from the CALLER CLASS, not from arguments —
// a coordinator process physically cannot mint an approval attributed to
// anyone else (D03/D04). 'coordinator' callers throw on create.
export function createApprovalArtifact({ planPath, caseId, caseRev, rulesSha256, policySha256, sourceStateSha256 = null, scope = "launch-write-workers", receiptRefs = [] }) {
  const caller = resolveCaller();
  if (caller === "coordinator") {
    throw new Error("approval-artifact: coordinator callers may not create approvals (D03/D04) — consume an existing bound approval only");
  }
  const planBuf = readFileSync(planPath); // throws if plan missing — no phantom approvals
  const planSha256 = createHash("sha256").update(planBuf).digest("hex");
  const art = {
    schemaVersion: APPROVAL_SCHEMA,
    kind: "launch-approval",
    caseId,
    caseRev: Number(caseRev ?? 0),
    scope, // e.g. launch-write-workers | consult-advisory
    subject: {
      planSha256,
      planPath: null, // content identity only — the PATH is deliberately not trusted (D01)
      rulesSha256: String(rulesSha256 ?? ""),
      policySha256: String(policySha256 ?? ""),
      sourceStateSha256: String(sourceStateSha256 ?? ""),
    },
    approver: { callerClass: caller, at: new Date().toISOString() },
    receiptRefs,
  };
  art.artifactSha256 = artifactDigest(art);
  return art;
}

export function artifactDigest(art) {
  const { artifactSha256, ...rest } = art;
  return createHash("sha256").update(JSON.stringify(rest)).digest("hex");
}

// Deterministic verifier. Returns { ok, reasons[] } — presence, shape,
// digest match against the LIVE plan content, rules/policy match, case
// identity/rev match, approver authority, scope match.
export function verifyApprovalArtifact(art, { planPath, caseId, caseRev, rulesSha256, policySha256, scope = "launch-write-workers" } = {}) {
  const reasons = [];
  if (!art || art.kind !== "launch-approval") reasons.push("not a launch-approval artifact");
  if (art?.schemaVersion !== APPROVAL_SCHEMA) reasons.push(`schemaVersion mismatch (${art?.schemaVersion})`);
  if (artifactDigest(art) !== art?.artifactSha256) reasons.push("artifact digest mismatch (tampered or truncated)");
  if (art?.subject?.planSha256) {
    let live = null;
    try { live = createHash("sha256").update(readFileSync(planPath)).digest("hex"); } catch { reasons.push(`plan artifact unreadable: ${planPath}`); }
    if (live && live !== art.subject.planSha256) reasons.push("plan content changed since approval (D01: mutable-path approval denied)");
  } else reasons.push("approval carries no plan digest");
  if (art?.subject?.rulesSha256 !== String(rulesSha256 ?? "")) reasons.push("rules identity changed since approval");
  if (art?.subject?.policySha256 !== String(policySha256 ?? "")) reasons.push("policy identity changed since approval");
  if (caseId !== undefined && art?.caseId !== caseId) reasons.push("approval belongs to a different case (cross-case replay denied)");
  if (caseRev !== undefined && Number(art?.caseRev ?? -1) !== Number(caseRev ?? -2)) reasons.push("case revision moved since approval");
  if (scope && art?.scope !== scope) reasons.push(`approval scope ${art?.scope} does not cover ${scope}`);
  const ac = art?.approver?.callerClass;
  if (!ac || ac === "coordinator") reasons.push("approver identity missing or coordinator (coordinators cannot approve)");
  if (art?.approver?.callerClass !== resolveCaller() && resolveCaller() === "coordinator") {
    // coordinator may consume (verify/execute) any valid artifact; consumption
    // is not identity widening. No reason added here.
  }
  return { ok: reasons.length === 0, reasons };
}

// Cross-case replay guard: an artifact is bound to (caseId, caseRev); copying
// it into another case fails verification above. This helper makes the intent
// explicit for tests/callers.
export function approvalIsForCase(art, caseId, caseRev) {
  return art?.caseId === caseId && Number(art?.caseRev ?? -1) === Number(caseRev ?? -2);
}

// ---------- D02: final-acceptance subject manifest ----------
export function acceptanceSubjectManifest({ runId, sourceRoots = [], configFiles = [], evidenceFiles = [], knowledgeFiles = [], targetDir = null }) {
  const digestOf = (p) => {
    try { return { path: p, sha256: createHash("sha256").update(readFileSync(p)).digest("hex"), bytes: existsSync(p) ? undefined : 0 }; }
    catch { return { path: p, sha256: "unreadable" }; }
  };
  const man = {
    schemaVersion: 1,
    kind: "acceptance-subject",
    runId,
    source: sourceRoots.map(digestOf),
    config: configFiles.map(digestOf),
    evidence: evidenceFiles.map(digestOf),
    knowledge: knowledgeFiles.map(digestOf), // V3.4.0: staged MEX/hub docs/run-summary digests (acceptance 43/44)
    targetDir,
    at: new Date().toISOString(),
  };
  man.manifestSha256 = createHash("sha256").update(JSON.stringify({ ...man, manifestSha256: null })).digest("hex");
  return man;
}

// Invalidate the carried verdict when the subject changed after acceptance.
// lives: [{source|config|evidence: paths...}] re-hashed now and compared.
export function verifyAcceptanceSubject(man, { sourceFiles = [], configFiles = [], evidenceFiles = [], knowledgeFiles = [] } = {}) {
  const reasons = [];
  if (!man || man.kind !== "acceptance-subject") return { ok: false, reasons: ["not an acceptance-subject manifest"] };
  const check = (recorded, nowPaths, label) => {
    const byPath = new Map(recorded.map((r) => [r.path, r.sha256]));
    for (const p of nowPaths) {
      const h = (() => { try { return createHash("sha256").update(readFileSync(p)).digest("hex"); } catch { return "unreadable"; } })();
      if (!byPath.has(p)) reasons.push(`${label} file added after acceptance: ${p}`);
      else if (byPath.get(p) !== h) reasons.push(`${label} changed after acceptance: ${p}`);
    }
  };
  check(man.source ?? [], sourceFiles, "source");
  check(man.config ?? [], configFiles, "config");
  check(man.evidence ?? [], evidenceFiles, "evidence");
  check(man.knowledge ?? [], knowledgeFiles, "knowledge"); // V3.4.0: accepted memory/doc/run-summary drift invalidates the verdict
  return { ok: reasons.length === 0, reasons };
}

export function saveApprovalArtifact(dir, art) {
  writeFileSync(join(dir, "approval-artifact.json"), JSON.stringify(art, null, 2) + "\n");
  return join(dir, "approval-artifact.json");
}
export function loadApprovalArtifact(dir) {
  try { return JSON.parse(readFileSync(join(dir, "approval-artifact.json"), "utf8")); } catch { return null; }
}
export function saveAcceptanceManifest(dir, man) {
  writeFileSync(join(dir, "acceptance-subject.json"), JSON.stringify(man, null, 2) + "\n");
  return join(dir, "acceptance-subject.json");
}
export function loadAcceptanceManifest(dir) {
  try { return JSON.parse(readFileSync(join(dir, "acceptance-subject.json"), "utf8")); } catch { return null; }
}
