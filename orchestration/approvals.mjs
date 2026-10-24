// approvals.mjs — an approval is a signed claim by a named authority about a
// specific piece of evidence at a specific source revision. It is worthless
// once any of those bindings drift, and the coordinator can never mint one.

export const APPROVER_ROLES = Object.freeze(["reviewer", "operator"]);

export class ApprovalError extends Error {
  constructor(message) {
    super(message);
    this.name = "ApprovalError";
  }
}

/**
 * Create an approval. `evidenceHash` binds the exact reviewed evidence pack and
 * `revision` binds the reviewed source revision, so neither can be swapped
 * under the approval later.
 */
export function createApproval({
  approver,
  role,
  runId,
  stage,
  evidenceHash,
  revision,
  ttlMs = 60 * 60 * 1000,
  now = () => Date.now(),
  note = "",
}) {
  if (!APPROVER_ROLES.includes(role)) {
    throw new ApprovalError(`role '${role}' may not approve; approval belongs to ${APPROVER_ROLES.join(" or ")}`);
  }
  for (const [field, value] of Object.entries({ approver, runId, stage, evidenceHash, revision })) {
    if (!value) throw new ApprovalError(`approval requires ${field}`);
  }
  const at = now();
  return {
    approver,
    role,
    runId,
    stage,
    evidenceHash,
    revision,
    note,
    issuedAt: new Date(at).toISOString(),
    expiresAt: at + ttlMs,
  };
}

/**
 * Validate an approval against the state it claims to authorise.
 *
 * Rejections are returned with every reason found, not just the first, so an
 * operator sees that an approval is stale AND scoped to the wrong stage.
 */
export function validateApproval(
  approval,
  {
    runId,
    stage,
    evidenceHash,
    revision,
    now = () => Date.now(),
    implementerIds = [],
    coordinatorId = null,
  } = {},
) {
  const reasons = [];
  if (!approval || typeof approval !== "object") return { ok: false, reasons: ["approval is missing"] };

  if (!APPROVER_ROLES.includes(approval.role)) {
    reasons.push(`role '${approval.role ?? "none"}' may not approve`);
  }
  if (coordinatorId && approval.approver === coordinatorId) {
    reasons.push("the coordinator cannot approve its own run");
  }
  if (implementerIds.includes(approval.approver)) {
    reasons.push(`'${approval.approver}' implemented this work and cannot approve it`);
  }
  if (runId && approval.runId !== runId) reasons.push(`approval is for run ${approval.runId}, not ${runId}`);
  if (stage && approval.stage !== stage) reasons.push(`approval covers stage '${approval.stage}', not '${stage}'`);
  if (evidenceHash && approval.evidenceHash !== evidenceHash) {
    reasons.push("approval does not cover the current evidence pack");
  }
  if (revision && approval.revision !== revision) {
    reasons.push(`approval covers revision ${approval.revision}, not ${revision}`);
  }
  const at = now();
  if (!approval.expiresAt || approval.expiresAt <= at) {
    reasons.push("approval has expired");
  }
  if (!approval.issuedAt || Date.parse(approval.issuedAt) > at + 60_000) {
    reasons.push("approval is issued in the future");
  }
  return { ok: reasons.length === 0, reasons };
}

/** Convenience: throw instead of returning, for call sites that must not continue. */
export function requireApproval(approval, context) {
  const result = validateApproval(approval, context);
  if (!result.ok) throw new ApprovalError(result.reasons.join("; "));
  return approval;
}
