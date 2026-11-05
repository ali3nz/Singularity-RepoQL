// lib/memory-orchestra/worldmodel.mjs — MemOS gap-closure addendum
// (2026-10-23) directive §15 (cross-task world-model induction). NOT a profile:
// environmental truth = operational environments, service dependencies,
// recurring failure mechanisms, constraints. Derivation sources: MULTIPLE
// policy drafts (policy-induction output) + verified incidents (steps rows)
// + authoritative RepoQL evidence (injected). No world-model database: drafts
// live in the runs tree with a file-backed cooldown kv; promotion is the
// existing RepoQL capture path (concept-conflict-gate) ONLY.
// Gated by worldModel flag (default OFF).
import { appendFileSync, readFileSync, writeFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { flags, enabledWhen, PENDING_VALIDATION } from "./flags.mjs";

const KV_FILE = "worldmodel-cooldown.json"; // one object, small; last-write-wins
const COOLDOWN_MS = 20 * 60 * 1000; // per-domain draft cooldown

function normDomain(v) {
  return String(v ?? "").trim().toLowerCase().replace(/[^a-z0-9:-]+/g, "-").slice(0, 48) || "unknown-domain";
}

// Bucket key: from candidate policies' signature domain token (first tag).
export function bucketOf(policyDraft) {
  const sig = String(policyDraft?.signature ?? "");
  return normDomain(sig.split("|")[0]);
}

// Draft one world-model cluster: policy drafts in one bucket + verified
// incident rows + injected RepoQL evidence digests. Dependencies/failure
// mechanisms are occurrence-counted over DISTINCT sources (occurrence counts
// from the same episode are capped upstream; here we only count rows given).
export function draftWorldModel({ policyDrafts = [], incidentRows = [], repoqlEvidence = [], domain = "auto" } = {}) {
  const g = enabledWhen(flags(), "worldModel");
  if (!g.ok) return { ok: false, code: g.code, status: g.status };
  if (!policyDrafts.length && !incidentRows.length) return { ok: false, code: "NO_DERIVATION_SOURCES" };
  const bucket = domain === "auto" && policyDrafts.length ? bucketOf(policyDrafts[0]) : normDomain(domain);
  const deps = new Map();
  const failures = new Map();
  for (const pd of policyDrafts.slice(0, 40)) {
    for (const tag of String(pd?.signature ?? "").split("|")) {
      if (tag && tag !== "untagged") deps.set(`dependency:${tag}`, (deps.get(`dependency:${tag}`) ?? 0) + 1);
    }
  }
  for (const ir of incidentRows.slice(0, 40)) {
    const sig = String(ir?.errorSignature ?? ir?.signature ?? "").slice(0, 80);
    if (!sig) continue;
    failures.set(sig, (failures.get(sig) ?? 0) + 1);
  }
  const hasAuthority = (Array.isArray(repoqlEvidence) ? repoqlEvidence : []).some((e) => e?.locator && e.locator !== "none supplied");
  return {
    ok: true,
    draft: {
      schema: "world-model-draft.v1",
      domain: bucket,
      supportingSourceCount: policyDrafts.length + incidentRows.length,
      dependencies: [...deps.entries()].sort((a, b) => b[1] - a[1]).slice(0, 12).map(([key, occurrences]) => ({ key, occurrences })),
      failureMechanisms: [...failures.entries()].sort((a, b) => b[1] - a[1]).slice(0, 12).map(([signature, occurrences]) => ({ signature, occurrences })),
      constraints: (repoqlEvidence ?? []).slice(0, 6).map((e) => ({ locator: String(e.locator).slice(0, 160), claim: String(e.claim ?? "").slice(0, 200) })),
      credibility: {
        policyCount: policyDrafts.length,
        incidentCount: incidentRows.length,
        authorityAnchored: hasAuthority,
        confidence: hasAuthority ? "grounded-with-authority" : "grounded-experiential-only",
      },
      conflicts: hasAuthority
        ? []
        : [{ kind: "missing-authority", resolution: "the RepoQL capture gate will refuse until an authoritative anchor is attached (RepoQL technical authority preserved; this draft is advisory only and does NOT reach the store)" }],
      status: "DRAFT", // existing gated concept capture is the ONLY promotion path
      approvalStatus: PENDING_VALIDATION,
      recordedAt: new Date().toISOString(),
    },
  };
}

// Cooldown gate (file-backed kv; design §2).
export function cooldownGate(stateDir, draft) {
  const f = join(stateDir, KV_FILE);
  let kv = {};
  try {
    if (existsSync(f)) kv = JSON.parse(readFileSync(f, "utf8"));
  } catch {
    kv = {};
  }
  const key = normDomain(draft?.domain);
  const now = Date.now();
  const last = Number(kv[key] ?? 0);
  if (now - last < COOLDOWN_MS) return { ok: false, code: "COOLDOWN", key, remainingMs: COOLDOWN_MS - (now - last) };
  kv[key] = now;
  try {
    writeFileSync(f, JSON.stringify(kv), "utf8");
    return { ok: true, key };
  } catch {
    // cooldown bookkeeping failing must not block the draft pipeline in this
    // single-writer phase, but it must be VISIBLE: typed degraded result.
    return { ok: true, key, degraded: true, note: "cooldown persistence failed; next gate may re-allow early" };
  }
}

export { PENDING_VALIDATION };
