// lib/memory-orchestra/corrections.mjs — MemOS gap-closure addendum
// (2026-10-23) directive §18 (closed-loop decision repair / explicit feedback).
// A correction is a STRUCTURED artifact — never a silent memory edit and never
// an automatic global rule ("do not turn a single correction into an
// unrestricted global rule").
//
// Kinds: personal-preference | technical | one-off | reusable | policy.
// Scope discipline is mechanical: only `policy` (operator- and gate-approved
// later through the EXISTING concept capture path) can ever claim broad
// applicability; `appliesTo` names concrete subject/tool/service/host tokens,
// and `doesNotApplyTo` records the negative space the operator named.
// All provenance: correction records reference the original decision context
// (run/case ids + evidence locator) — no provenance ⇒ refuse to persist
// (validation requires anchored provenance, same law as
// lib/memory-candidate-v2.mjs).
// CHURNS through the EXISTING gates: a correction never directly mutates
// memory/skills — it emits.proposeMemoryUpdates / proposeSkillUpdates markers
// that go through lib/memory-lineage.mjs invalidation and lib/skill-publish
// changes respectively (recorded as lineage- pending events; no direct write).
// Gated by flags.decisionRepair (default OFF) for persistence; pure validation
// functions stay ungated (tests may use them).
import { writeFileSync, appendFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { flags, enabledWhen, PENDING_VALIDATION } from "./flags.mjs";

export const CORRECTION_KINDS = new Set(["personal-preference", "technical", "one-off", "reusable", "policy"]);
export const KIND_APPLY_CEILING = { "personal-preference": 1, technical: 4, "one-off": 1, reusable: 6, policy: 12 };

// Validate + normalize. Deterministic; throws ONLY on schema violations the
// operator-level tooling can catch pre-write (this is a validation primitive,
// not a runtime ingestion sink).
export function validateCorrection(raw) {
  const kind = String(raw?.kind ?? "");
  if (!CORRECTION_KINDS.has(kind)) throw new Error(`correction.kind not in enum: ${kind}`);
  const what = String(raw?.what ?? "").trim();
  if (!what || what.length < 4) throw new Error("correction.what required (the specific error identified)");
  const correctedApproach = String(raw?.correctedApproach ?? "").trim();
  if (!correctedApproach) throw new Error("correction.correctedApproach required (the corrected approach)");

  const appliesTo = listFields(raw?.appliesTo);
  if (!appliesTo.length) throw new Error("correction.appliesTo required — a correction with NO scope is exactly what this artifact exists to prevent; name subject/tool/service/host tokens");
  const doesNotApplyTo = listFields(raw?.doesNotApplyTo ?? []);

  const ceiling = KIND_APPLY_CEILING[kind];
  if (appliesTo.length > ceiling) {
    throw new Error(`correction.appliesTo exceeded kind ceiling (${kind} allow ≤${ceiling} scoped targets; broader claims need the policy/gate path, not this record)`);
  }
  const prov = raw?.evidence ?? null;
  if (!prov || (!prov.runDirReference && !prov.caseId && !prov.locator)) {
    throw new Error("correction.evidence required (decision context anchor: run/case/locator)");
  }
  if (kind === "policy") {
    // Policy claims can ONLY come from the operator/gate pipeline; this module
    // records them but refuses to auto-broadcast (approval boundary unchanged).
    return { ...normalized({ kind, what, correctedApproach, appliesTo, doesNotApplyTo, prov }), broadcastOk: false, gateRequired: true, status: PENDING_VALIDATION };
  }
  return normalized({ kind, what, correctedApproach, appliesTo, doesNotApplyTo, prov });
}
function listFields(v) {
  const arr = Array.isArray(v) ? v : v != null ? [v] : [];
  return arr.map((x) => String(x ?? "").trim().slice(0, 90)).filter(Boolean);
}
function normalized({ kind, what, correctedApproach, appliesTo, doesNotApplyTo, prov, raw }) {
  return {
    schema: "correction.v1",
    kind,
    what: what.slice(0, 300),
    correctedApproach: correctedApproach.slice(0, 400),
    appliesTo,
    doesNotApplyTo,
    relatedMemory: Array.isArray(raw?.relatedMemory) ? raw.relatedMemory : [],
    relatedSkills: Array.isArray(raw?.relatedSkills) ? raw.relatedSkills : [],
    evidence: { runIdReference: prov.runDirReference ?? null, caseId: prov.caseId ?? null, locator: prov.locator ?? null, observedAt: prov.observedAt ?? new Date().toISOString() },
    recordedAt: new Date().toISOString(),
    // Lifecycle: a correction is born ACTIVE-NARROW and ages into the two
    // terminal paths through existing gates (skill update verified, concept
    // captured via capture_gate); nothing here approves anything.
    broadcastOk: kind === "policy" ? false : undefined,
    gateRequired: kind === "policy" ? true : undefined,
    nonzeroStatus: kind === "policy" ? PENDING_VALIDATION : undefined,
    lifecycle: "active-narrow",
    proposeMemoryUpdates: [], // filled ONLY by the touching flows that exist (lineage invalidation, doc-impact); never fabricated inline
    proposeSkillUpdates: [],
  };
}

// Persist: runs-tree JSONL (house pattern). Gated by decisionRepair.
export function recordCorrection(correction, { stateDir = "/opt/harness-unset/ai-orchestration/kit/runs/_corrections" } = {}) {
  const gate = enabledWhen(flags(), "decisionRepair");
  if (!gate.ok) return { ok: false, code: gate.code, status: gate.status };
  if (!correction?.schema) return { ok: false, code: "INVALID_RECORD" };
  try {
    const f = join(stateDir, "corrections.jsonl");
    appendFileSync(f, `${JSON.stringify(correction)}\n`, "utf8");
    return { ok: true, file: f, note: "recorded; memory/skill updates flow ONLY through existing lineage/publication gates" };
  } catch (err) {
    return { ok: false, code: `RECORD_THROW:${String(err?.name ?? err).slice(0, 20)}` };
  }
}

// Executor for the decision-repair retrieval entry (directive §16): on repeated
// failure, produce ADVISORY guidance from prior verified failures + successful
// repairs + approved procedures. Advisory-only by construction: output is
// plain text with a hard prefix, and the caller is responsible for never
// executing anything from it.
export function advisoryRepairPayload({ errorSignature, priorFailed, priorRepairs, procedures, correctionHints = [] } = {}) {
  const lines = [
    "ADVISORY ONLY — do not execute automatically; commands/repairs below require the normal human/gate authorization flow.",
    `repeated error signature: ${String(errorSignature ?? "").slice(0, 160)}`,
  ];
  for (const r of (priorFailed ?? []).slice(0, 3)) {
    lines.push(`AVOID (verified failure ${r.runId ?? "?"}): ${String(r.outcomeRep ?? r.body ?? "").slice(0, 180)}`);
  }
  for (const r of (priorRepairs ?? []).slice(0, 3)) {
    lines.push(`PRIOR REPAIR (verified success ${r.runId ?? "?"}): ${String(r.actionRep ?? r.body ?? "").slice(0, 180)}`);
  }
  for (const p of (procedures ?? []).slice(0, 2)) {
    lines.push(`PROCEDURE (${p.channel ?? "procedure"}): ${String(p.body ?? "").slice(0, 220)}`);
  }
  for (const h of correctionHints.slice(0, 2)) {
    lines.push(`CORRECTION on record: ${String(h.what ?? "").slice(0, 180)} (applies: ${(h.appliesTo ?? []).join(", ")})`);
  }
  return lines.join("\n");
}
