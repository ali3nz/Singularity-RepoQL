// lib/memory-orchestra/export-portability.mjs — MemOS gap-closure addendum
// (2026-10-23) directive §23 (memory portability + inspection). A portable
// VIEW over existing artifacts — never a corpus duplicate, never a new store
// ("preserve existing MemoryCore and RepoQL formats as authoritative").
// Manifest carries: schema version, scope, ownership, artifact list with
// sha256 integrity, cross-system references (skill→concept→evidence links),
// revision info. Export FAILS CLOSED when any listed artifact cannot be read
// (no partial-integrity pretence). Gated by portability flag (default OFF).
import { readFileSync, existsSync } from "node:fs";
import { createHash } from "node:crypto";
import { relative, isAbsolute } from "node:path";
import { flags, enabledWhen, PENDING_VALIDATION } from "./flags.mjs";

const MANIFEST_SCHEMA = 1;

function sha256File(p) {
  const buf = readFileSync(p);
  return createHash("sha256").update(buf).digest("hex");
}

// buildExportManifest — artifacts: [{ path, ref }, ...]; refs describe WHY the
// artifact is in the export (skill/draft/episode/ledger) and, when known, its
// identity in the other plane (MemoryCore id or RepoQL concept ref). Only
// EXISTING files may be listed; a reference to a missing file fails the build.
export function buildExportManifest({ artifacts = [], scope = {}, ownership = null, notes = null, workspacePrefix = "/opt/harness-unset/ai-orchestration/kit" } = {}) {
  const g = enabledWhen(flags(), "portability");
  if (!g.ok) return { ok: false, code: g.code, status: g.status };
  if (!Array.isArray(artifacts) || !artifacts.length) return { ok: false, code: "ARTIFACTS_REQUIRED" };
  const items = [];
  for (const a of artifacts.slice(0, 500)) {
    const p = String(a?.path ?? "");
    const ref = String(a?.ref ?? "unclassified");
    if (!existsSync(p)) return { ok: false, code: `ARTIFACT_MISSING:${p.slice(-80)}` };
    let sha = null;
    try {
      sha = sha256File(p);
    } catch {
      return { ok: false, code: `ARTIFACT_UNREADABLE:${p.slice(-80)}` }; // fail closed
    }
    items.push({
      path: workspacePrefix && p.startsWith(workspacePrefix) ? relative(workspacePrefix, p) : p,
      ref,
      plane: a?.plane ?? (String(ref).toLowerCase().includes("concept") ? "repoql" : "kit"),
      crossRefs: a?.crossRefs ?? null, // e.g. { memorycoreSkillId, repoqlConceptRef }
      revision: a?.revision ?? null,
      sha256: sha,
      bytes: existsSync(p) ? readFileSync(p).length : null,
    });
  }
  return {
    ok: true,
    manifest: {
      schemaVersion: MANIFEST_SCHEMA,
      createdAt: new Date().toISOString(),
      scope: {
        team: scope.team ?? null,
        agent: scope.agent ?? null,
        user: scope.user ?? null,
        caseRun: scope.caseRun ?? null,
      },
      ownership: ownership ?? { note: "unset — export refuses implicit ownership claims; caller must name the owning agent/system" },
      artifacts: items,
      integrity: { algorithm: "sha256", count: items.length },
      crossSystemLinks: items.filter((i) => i.crossRefs).map((i) => ({ artifact: i.path, refs: i.crossRefs })),
      status: PENDING_VALIDATION,
      notes: notes ? String(notes).slice(0, 300) : null,
    },
  };
}

// verifyManifest — recompute shas and check structure of a previously built
// manifest file (operator inspection path).
export function verifyManifest(manifestFile) {
  const g = enabledWhen(flags(), "portability");
  if (!g.ok) return { ok: false, code: g.code, status: g.status };
  let doc = null;
  try {
    doc = JSON.parse(readFileSync(manifestFile, "utf8"));
  } catch {
    return { ok: false, code: "MANIFEST_UNREADABLE" };
  }
  if (doc?.schemaVersion !== MANIFEST_SCHEMA) return { ok: false, code: "SCHEMA_VERSION_MISMATCH" };
  const results = [];
  let allMatch = true;
  for (const it of doc.artifacts ?? []) {
    let actual = null;
    try {
      actual = sha256File(it.path.startsWith("/") ? it.path : it.path); // relative resolution is the caller's CWD discipline; recorded in results
    } catch {
      actual = null;
    }
    const match = actual != null && actual === it.sha256;
    if (!match) allMatch = false;
    results.push({ path: it.path, match, actualSha: actual === it.sha256 ? "match" : actual });
  }
  return { ok: allMatch, checked: results.length, results, note: allMatch ? "integrity verified" : "integrity FAILURE (files changed or unreadable since manifest build)" };
}
