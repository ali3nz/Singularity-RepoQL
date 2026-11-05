// lib/evidence-manifest.mjs — ticket 164 Wave-1 foundation (plan §7.4, §19.1).
// The manifest is the authoritative INDEX over evidence files produced by a
// run — never a second evidence store: raw artifacts stay under
// runs/<runId>/evidence/ and the manifest points at them and hashes them.
//
// Contract (phase0-schemas.json → evidenceManifest):
//   location: runs/<runId>/evidence-manifest.json
//   updates: ATOMIC (write temp + rename) and serialized per-process.
//   entry kinds: diff|command-output|test-output|runtime-event|
//                config-snapshot|log|screenshot-reference|external-reference
//
// Never throws on read of a missing manifest (create-from-empty is normal);
// write failures are returned as { ok:false } — callers decide (gates fail,
// advisory callers log). No new storage layer: plain JSON file.
import { createHash } from "node:crypto";
import { readFileSync, writeFileSync, renameSync, mkdirSync, existsSync } from "node:fs";
import { dirname, join } from "node:path";

export const EVIDENCE_KINDS = [
  "diff", "command-output", "test-output", "runtime-event",
  "config-snapshot", "log", "screenshot-reference", "external-reference",
];

export const MANIFEST_SCHEMA_VERSION = 1;

function sha256Of(buf) { return createHash("sha256").update(buf).digest("hex"); }

function validateEntry(e) {
  const problems = [];
  if (!e || typeof e !== "object") return ["entry not an object"];
  if (!e.evidenceId) problems.push("evidenceId required");
  if (!EVIDENCE_KINDS.includes(e.kind)) problems.push(`kind must be one of ${EVIDENCE_KINDS.join("|")}`);
  if (!e.path) problems.push("path required (relative to runs/<runId>/)");
  if (e.path && String(e.path).includes("..")) problems.push("path must not traverse (..)");
  if (!e.createdAt) problems.push("createdAt required");
  return problems;
}

// Open (or create) the manifest for a run directory. Never throws.
export function openEvidenceManifest(runDir, { runId = null, caseId = null, baselineRevision = null, planRevision = null, currentPhase = null } = {}) {
  const manifestPath = join(runDir, "evidence-manifest.json");
  let state = null;
  if (existsSync(manifestPath)) {
    try {
      state = JSON.parse(readFileSync(manifestPath, "utf8"));
    } catch (e) {
      return { ok: false, code: "MANIFEST_CORRUPT", detail: String(e?.message ?? e).slice(0, 160), manifestPath };
    }
  }
  if (!state) {
    state = {
      schemaVersion: MANIFEST_SCHEMA_VERSION,
      runId: runId ?? (runDir ? runDir.split("/").filter(Boolean).pop() : null),
      caseId, baselineRevision, planRevision, currentPhase,
      entries: [],
    };
  }
  let revision = typeof state.revision === "number" ? state.revision : 0;

  return {
    ok: true,
    manifestPath,
    get revision() { return revision; },

    // Register one evidence artifact: hashes the file, appends the entry,
    // atomically rewrites the manifest. Returns { ok, entry, revision }.
    register(entry, { fileBase = runDir } = {}) {
      const problems = validateEntry(entry);
      if (problems.length) return { ok: false, code: "INVALID_ENTRY", detail: problems.join("; ") };
      if (state.entries.some((x) => x.evidenceId === entry.evidenceId)) {
        return { ok: false, code: "DUPLICATE_EVIDENCE_ID", detail: entry.evidenceId };
      }
      const abs = String(entry.path).startsWith("/") ? entry.path : join(fileBase, entry.path);
      if (!existsSync(abs)) return { ok: false, code: "EVIDENCE_FILE_MISSING", detail: entry.path };
      let sha256;
      try { sha256 = sha256Of(readFileSync(abs)); } catch (e) { return { ok: false, code: "HASH_FAILED", detail: String(e?.message ?? e).slice(0, 120) }; }
      const record = { exitCode: null, sourceRevision: null, rerunnable: false, acceptedAt: null, acceptedBy: null, criterionId: null, command: null, phase: null, ...entry, sha256 };
      state.entries.push(record);
      const write = this.flush();
      if (!write.ok) { state.entries.pop(); return write; }
      return { ok: true, entry: record, revision };
    },

    // Mark an entry accepted (gate accepted it). Idempotent per entry.
    accept(evidenceId, { acceptedBy = "coordinator" } = {}) {
      const ent = state.entries.find((x) => x.evidenceId === evidenceId);
      if (!ent) return { ok: false, code: "EVIDENCE_ID_UNKNOWN", detail: evidenceId };
      ent.acceptedAt = new Date().toISOString();
      ent.acceptedBy = acceptedBy;
      const write = this.flush();
      return write.ok ? { ok: true, entry: ent, revision } : write;
    },

    // ATOMIC flush: temp file + rename in the same directory. Bumps revision.
    flush() {
      revision += 1;
      state.revision = revision;
      try {
        mkdirSync(dirname(manifestPath), { recursive: true });
        const tmp = `${manifestPath}.tmp-${process.pid}-${Date.now()}`;
        writeFileSync(tmp, JSON.stringify(state, null, 1));
        renameSync(tmp, manifestPath);
        return { ok: true, revision };
      } catch (e) {
        revision -= 1;
        return { ok: false, code: "MANIFEST_WRITE_FAILED", detail: String(e?.message ?? e).slice(0, 160) };
      }
    },

    // Read-only views (gate prompts consume these; §19.2)
    entriesFor(phase = null) {
      return phase ? state.entries.filter((e) => e.phase === phase) : [...state.entries];
    },
    unaccepted() { return state.entries.filter((e) => !e.acceptedAt); },
    summary() {
      return {
        revision, total: state.entries.length,
        accepted: state.entries.filter((e) => e.acceptedAt).length,
        kinds: state.entries.reduce((m, e) => ({ ...m, [e.kind]: (m[e.kind] ?? 0) + 1 }), {}),
      };
    },
    raw() { return state; },
  };
}
