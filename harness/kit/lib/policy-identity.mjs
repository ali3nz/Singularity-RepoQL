// policy-identity.mjs — V3.3.35 (ticket 085, plan D08). Minimal pinned policy
// identity: an immutable snapshot digest of the effective policy projection
// (canonical rules file + kit config) recorded into every approval artifact
// and gate caseState. Revocation overlay is an EXPLICIT operator-owned file
// (policy-revocations.json in the kit dir) — a listed artifactSha256 is
// revoked; revocation never happens by silent policy migration.

import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { createHash } from "node:crypto";
import { join } from "node:path";

// Deterministic digest over the pinned policy inputs. Order is fixed; a file
// that cannot be read contributes "unreadable" (visible change => new id).
export function policyIdentity({ rulesPath, configPath, extraFiles = [] }) {
  const h = createHash("sha256");
  for (const p of [rulesPath, configPath, ...extraFiles]) {
    let d = "unreadable";
    try { d = createHash("sha256").update(readFileSync(p)).digest("hex"); } catch { /* stays */ }
    h.update(`${p}:${d}\n`);
  }
  return h.digest("hex");
}

// Operator revocation overlay: kit dir / policy-revocations.json
// { "revoked": [ { artifactSha256, reason, at } ] } — hand-maintained, never
// auto-written. verify functions treat a revoked artifact as denied.
export function loadRevocations(kitDir) {
  try {
    const j = JSON.parse(readFileSync(join(kitDir, "policy-revocations.json"), "utf8"));
    return Array.isArray(j.revoked) ? j.revoked : [];
  } catch { return []; }
}

export function isRevoked(artifactSha256, kitDir) {
  return loadRevocations(kitDir).some((r) => r.artifactSha256 === artifactSha256);
}

export function revokeArtifact(kitDir, artifactSha256, reason) {
  // Convenience for the OPERATOR; agents must not call this in normal flow.
  const p = join(kitDir, "policy-revocations.json");
  const cur = existsSync(p) ? JSON.parse(readFileSync(p, "utf8")) : { revoked: [] };
  cur.revoked = Array.isArray(cur.revoked) ? cur.revoked : [];
  if (!cur.revoked.some((r) => r.artifactSha256 === artifactSha256)) {
    cur.revoked.push({ artifactSha256, reason: String(reason ?? ""), at: new Date().toISOString() });
    writeFileSync(p, JSON.stringify(cur, null, 2) + "\n");
  }
  return loadRevocations(kitDir);
}
