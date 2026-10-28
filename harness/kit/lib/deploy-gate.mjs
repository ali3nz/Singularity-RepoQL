// deploy-gate.mjs — V3.5.3 (ticket 188, plan §108 P0, WP-A). ORCHESTRATION-LAYER
// deployment gate. Sol verdict (consult 2026-09-30T02-27-18-965-68297):
// openchamber-safe-restart STAYS the runtime idle primitive — this module does
// NOT reimplement idle waiting; it wraps the flow around it:
//
//   validate intent → confirm resource lease → wait idle (safe-restart --check
//   semantics) → RECOMPUTE current identity (rules/config/source sha) →
//   compare vs intent (DEPLOY_POLICY/CONFIG/SOURCE/ARTIFACT_CHANGED) →
//   revalidate generation + owner → invoke safe-restart IMMEDIATELY → capture
//   deployed-artifact evidence.
//
// Force semantics (plan §27): --force skips the IDLE WAIT ONLY — never
// identity comparison, never supersession/generation, never owner checks.
// Explicit --override-identity requires reason + timestamp + audit event.
//
// Rollback (plan §99): every call site wires behind kit config
// deployGate.enabled — flag false keeps legacy direct safe-restart working
// (with a deprecation warning) WITHOUT removing this module.

import { spawnSync } from "node:child_process";
import { mkdirSync, readFileSync, writeFileSync, appendFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import * as rl from "./resource-lease.mjs";
import * as di from "./deployment-intent.mjs";

const RUNS_DIR = join(dirname(fileURLToPath(import.meta.url)), "..", "runs");
const AUDIT_LOG = join(RUNS_DIR, "deploy-gate-audit.jsonl");

// Read the kill-switch. Config lives at the kit root; env override wins so a
// stuck gate can always be disabled without a config edit. Default OFF until
// Sol S1 declares enforcement canonical (plan §99: no new subsystem authority).
export function isDeployGateEnabled({ config, configPath, env = process.env } = {}) {
  if (env.ORCH_DEPLOY_GATE === "0") return false;
  if (env.ORCH_DEPLOY_GATE === "1") return true;
  let cfg = config;
  if (cfg == null && configPath) {
    try { cfg = JSON.parse(readFileSync(configPath, "utf8")); } catch { cfg = null; }
  }
  return cfg?.deployGate?.enabled === true;
}

// Legacy bypass helper for call sites: returns the deprecation warning record
// that direct safe-restart invocation paths must log when they skip this gate.
export function legacyBypassWarning({ caseId, resourceId, at } = {}) {
  return {
    warning: "DEPRECATION: direct safe-restart bypasses deploy-gate; wire through lib/deploy-gate.mjs before Sol S1 (ticket 188).",
    caseId: caseId ?? null, resourceId: resourceId ?? null, at: at ?? new Date().toISOString(),
  };
}

function appendAudit(event) {
  try {
    mkdirSync(RUNS_DIR, { recursive: true });
    appendFileSync(AUDIT_LOG, JSON.stringify(event) + "\n");
    return true;
  } catch { return false; }
}
async function requiredAudit(auditFn, event) {
  try { return (await auditFn(event)) === true; }
  catch { return false; }
}

export function auditLogPath() { return AUDIT_LOG; }

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// safe-restart --check probe: exit 0 = idle, nonzero = busy. Callers may
// inject checkIdle (tests) or safeRestart (tests / different primitive).
async function waitUntilIdle({ resourceId, caseId, checkIdle, idlePollMs, idleTimeoutMs, onCycle }) {
  const deadline = Date.now() + idleTimeoutMs;
  let cycles = 0;
  while (true) {
    const r = checkIdle({ resourceId, caseId });
    if (r.ok) return { ok: true, cycles };
    cycles++;
    if (onCycle) onCycle(cycles, r);
    if (Date.now() >= deadline) {
      return { ok: false, reason: "idle-timeout", cycles, detail: r.detail ?? null };
    }
    await sleep(idlePollMs);
  }
}

// The gate. Deterministic, typed, fail-closed at every step.
//   intentId       — queued intent (queueDeploymentIntent) to execute
//   caseId         — MUST equal intent.caseId (owner binding)
//   checkIdle      — ({resourceId,caseId}) => {ok, detail?} (safe-restart --check semantics)
//   safeRestart    — async ({resourceId, caseId, intent}) => ({ok, ...evidence}); omitted => real spawn is refused (determinism)
//   identityInputs — {sourcePath, configPath, policyPath, artifactIdentity} recomputed AFTER idle wait
//   overrideIdentity — {reason} REQUIRED shape to bypass identity comparison (audited); never bypasses generation/owner
//   force          — true skips the idle wait ONLY
export async function runDeployGate({
  intentId, caseId,
  checkIdle = null,
  safeRestart = null,
  identityInputs = {},
  idlePollMs = 2_000, idleTimeoutMs = 7_200_000,
  force = false, overrideIdentity = null,
  statePath, leaseStatePath, audit = appendAudit,
}) {
  const startedAt = new Date().toISOString();
  const finish = (result) => {
    try {
      const pending = audit({ event: "deploy-gate-finished", intentId, caseId, startedAt, finishedAt: new Date().toISOString(), ...result });
      if (pending && typeof pending.catch === "function") pending.catch(() => {});
    } catch { /* finish telemetry is best-effort; safety decisions are not */ }
    return result;
  };
  const storeFailure = (stage, error, extra = {}) => finish({
    ok: false,
    reasons: ["STATE_STORE_UNAVAILABLE"],
    error: error?.code ?? error?.message ?? String(error),
    stage,
    ...extra,
  });

  // -- 1. intent validation --------------------------------------------------
  let intent;
  try { intent = di.loadIntent(intentId, { statePath }); }
  catch (error) { return storeFailure("intent-load", error); }
  if (!intent) return finish({ ok: false, reasons: [di.DEPLOY_REASON_CODES.IDENTITY_UNAVAILABLE], error: "absent-intent" });
  if (!caseId || intent.caseId !== caseId) {
    return finish({ ok: false, reasons: [di.DEPLOY_REASON_CODES.OWNER_MISMATCH], error: "caseId-does-not-own-intent" });
  }
  if (intent.status === di.INTENT_STATUS.REFUSED || intent.status === di.INTENT_STATUS.SUPERSEDED) {
    return finish({ ok: false, reasons: [intent.status === di.INTENT_STATUS.SUPERSEDED ? di.DEPLOY_REASON_CODES.STALE_GENERATION : "INTENT_REFUSED"], error: `intent-status-${intent.status}` });
  }
  if (intent.status !== di.INTENT_STATUS.QUEUED && intent.status !== di.INTENT_STATUS.APPROVED) {
    return finish({ ok: false, reasons: ["INTENT_STATUS_INVALID"], error: `intent-status-${intent.status}` });
  }
  if (!di.hasDeploymentIdentityPins(intent)) {
    return finish({
      ok: false,
      reasons: [di.DEPLOY_REASON_CODES.IDENTITY_UNAVAILABLE],
      missing: ["sourceSha256", "configSha256", "policySha256", "artifactIdentity"],
      stage: "intent-identity",
    });
  }
  if (typeof safeRestart !== "function") {
    return finish({ ok: false, reasons: ["SAFE_RESTART_REFUSED_NO_PRIMITIVE"], error: "safeRestart callback not provided (real spawn is refused by design)" });
  }
  if (!force && typeof checkIdle !== "function") {
    return finish({ ok: false, reasons: ["SAFE_RESTART_REFUSED_NO_IDLE_PROBE"], error: "checkIdle probe is required unless --force skips the idle wait" });
  }

  // -- 2. resource lease (INVARIANT B store is SEPARATE from the intent store) --
  let lease;
  try { lease = rl.acquireResourceLease({ resourceId: intent.resourceId, caseId, statePath: leaseStatePath }); }
  catch (error) { return storeFailure("resource-lease", error); }
  if (!lease.ok) {
    return finish({ ok: false, reasons: ["RESOURCE_LEASE_CONFLICT"], error: lease.reason, holder: lease.holder ?? null });
  }
  try {
    // -- 3. Atomically validate generation/owner and enter EXECUTING -----------
    let execution;
    try { execution = di.claimIntentForExecution(intentId, { caseId, statePath }); }
    catch (error) { return storeFailure("pre-wait-claim", error); }
    if (!execution.ok) {
      const reason = execution.reason === di.DEPLOY_REASON_CODES.STALE_GENERATION
        ? di.DEPLOY_REASON_CODES.STALE_GENERATION
        : execution.reason === di.DEPLOY_REASON_CODES.OWNER_MISMATCH
          ? di.DEPLOY_REASON_CODES.OWNER_MISMATCH
          : "INTENT_STATE_TRANSITION_REFUSED";
      return finish({ ok: false, reasons: [reason], error: execution.reason, stage: "pre-wait" });
    }
    intent = execution.intent;

    // -- 4. idle wait (safe-restart --check semantics) ------------------------
    let idle;
    if (force) {
      idle = { ok: true, forced: true, cycles: 0 }; // --force skips the IDLE WAIT ONLY
    } else {
      idle = await waitUntilIdle({ resourceId: intent.resourceId, caseId, checkIdle, idlePollMs, idleTimeoutMs });
      if (!idle.ok) return finish({ ok: false, reasons: ["IDLE_TIMEOUT"], error: "idle-timeout", stage: "idle-wait" });
    }

    // -- 5. Final generation/owner reservation under the same store mutex -----
    // This is the invocation linearization point: a newer queue either commits
    // before it (and this intent refuses) or after it (ordered after invocation).
    let invocation;
    try { invocation = di.claimIntentForInvocation(intentId, { caseId, statePath }); }
    catch (error) { return storeFailure("pre-invocation-claim", error); }
    if (!invocation.ok) {
      const reason = invocation.reason === di.DEPLOY_REASON_CODES.STALE_GENERATION
        ? di.DEPLOY_REASON_CODES.STALE_GENERATION
        : invocation.reason === di.DEPLOY_REASON_CODES.OWNER_MISMATCH
          ? di.DEPLOY_REASON_CODES.OWNER_MISMATCH
          : "INTENT_STATE_TRANSITION_REFUSED";
      return finish({ ok: false, reasons: [reason], error: invocation.reason, stage: "pre-invocation" });
    }
    intent = invocation.intent;

    // -- 6. Recompute identity after the wait and invocation reservation -------
    const cur = di.computeDeploymentIdentity({ ...identityInputs });
    if (!cur.ok) return finish({ ok: false, reasons: [cur.reason], missing: cur.missing, stage: "post-wait-identity" });
    const cmp = di.compareIntentIdentities(intent, cur);
    let identityOverridden = false;
    if (!cmp.ok) {
      const over = normalizeOverride(overrideIdentity);
      if (!over) return finish({ ok: false, reasons: cmp.reasons, missing: cmp.missing, stage: "post-wait-compare" });
      const audited = await requiredAudit(audit, { event: "deploy-gate-identity-override", intentId, caseId, reason: over.reason, at: over.at, reasons: cmp.reasons });
      if (!audited) {
        return finish({ ok: false, reasons: ["DEPLOY_OVERRIDE_AUDIT_FAILED"], stage: "identity-override-audit", error: "required override audit event was not persisted" });
      }
      identityOverridden = true;
    }

    // -- 7. Invoke the primitive IMMEDIATELY (no further awaits before this) --
    const exec = await safeRestart({ resourceId: intent.resourceId, caseId, intent });
    if (!exec?.ok) {
      return finish({ ok: false, reasons: ["SAFE_RESTART_FAILED"], error: exec?.error ?? "safe-restart failed", stage: "invoke" });
    }

    // -- 8. deployed-artifact evidence ----------------------------------------
    const evidence = {
      intentId, resourceId: intent.resourceId, caseId,
      deployedAt: new Date().toISOString(),
      generation: intent.generation,
      identityAtDeploy: cur.identity,
      artifactIdentityAtDeploy: cur.artifactIdentity,
      sourceSha256: intent.sourceSha256, configSha256: intent.configSha256, policySha256: intent.policySha256,
      execEvidence: exec.evidence ?? null,
      forced: !!force,
      identityOverridden,
    };
    let deployed;
    try { deployed = di.markIntentStatus(intentId, di.INTENT_STATUS.DEPLOYED, { note: exec.evidence ?? null, statePath }); }
    catch (error) {
      return storeFailure("post-invocation-status", error, {
        invocationCompleted: true,
        evidence,
        runtimeAction: { ok: true, evidence: exec.evidence ?? null },
      });
    }
    if (!deployed.ok) {
      return finish({
        ok: false,
        reasons: ["INTENT_STATE_TRANSITION_REFUSED"],
        error: deployed.reason,
        stage: "post-invocation-status",
        invocationCompleted: true,
        evidence,
        runtimeAction: { ok: true, evidence: exec.evidence ?? null },
      });
    }
    audit({ event: "deployed-artifact", ...evidence });
    return finish({ ok: true, evidence, forced: !!force, identityOverridden });
  } finally {
    rl.releaseResourceLease(intent.resourceId, { caseId, statePath: leaseStatePath });
  }
}

function normalizeOverride(overrideIdentity) {
  if (!overrideIdentity || typeof overrideIdentity !== "object") return null;
  const reason = typeof overrideIdentity.reason === "string" ? overrideIdentity.reason.trim() : "";
  if (!reason) return null; // reason is REQUIRED — no silent override
  return { reason, at: overrideIdentity.at ?? new Date().toISOString() };
}
