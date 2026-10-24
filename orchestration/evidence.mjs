// evidence.mjs — an evidence pack is the unit a stage transition is allowed to
// rest on. It records WHAT was observed, by WHICH producer, at which source
// revision, and a hash of the exact bytes. A transition that cites evidence is
// only valid while that evidence still verifies.
import { createHash } from "node:crypto";
import fs from "node:fs";

const KINDS = new Set([
  "plan",
  "diff",
  "test-output",
  "static-check",
  "review-verdict",
  "approval",
  "log",
  "note",
  "deployment",
]);

export function sha256Bytes(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
}

export function sha256Text(text) {
  return sha256Bytes(Buffer.from(String(text), "utf8"));
}

/**
 * Build one evidence entry. `content` may be a string or a Buffer; `file`
 * records where it came from (never copied into the pack, only hashed).
 */
export function evidenceEntry({ kind, producer, content, file = null, revision = null, meta = {} }) {
  if (!KINDS.has(kind)) throw new Error(`unknown evidence kind: ${kind}`);
  if (!producer) throw new Error("evidence requires a producer identity");
  const body = Buffer.isBuffer(content) ? content : Buffer.from(String(content), "utf8");
  if (body.length === 0) throw new Error("evidence must not be empty");
  return {
    kind,
    producer,
    revision,
    file,
    bytes: body.length,
    sha256: sha256Bytes(body),
    meta,
    capturedAt: new Date().toISOString(),
  };
}

export function evidenceFromFile({ kind, producer, file, revision = null, meta = {} }) {
  const body = fs.readFileSync(file);
  return evidenceEntry({ kind, producer, content: body, file, revision, meta });
}

/** Stable pack hash: independent of ordering and capture timestamps. */
export function packHash(entries) {
  const canonical = entries
    .map((e) => [e.kind, e.producer, e.revision ?? "", e.sha256, String(e.bytes)].join("\u0000"))
    .sort()
    .join("\u0001");
  return sha256Text(canonical);
}

/**
 * The hash an approval is bound to. Approval entries are excluded, otherwise
 * recording an approval would change the hash it claims to cover and no
 * approval could ever validate against its own pack.
 */
export function reviewedPackHash(entries) {
  return packHash((entries ?? []).filter((e) => e.kind !== "approval"));
}

/**
 * Verify a pack against a live filesystem. An entry with a `file` must still
 * hash to the recorded digest; entries without one are self-attesting and only
 * checked structurally. Inline evidence is not re-derivable by definition, so
 * "verifies" here means "the file-backed entries are unchanged".
 */
export function verifyPack(entries) {
  const problems = [];
  for (const entry of entries) {
    for (const field of ["kind", "producer", "sha256", "bytes"]) {
      if (entry[field] === undefined || entry[field] === null || entry[field] === "") {
        problems.push(`entry missing ${field} (${entry.kind ?? "?"})`);
      }
    }
    if (!entry.file) continue;
    let body;
    try {
      body = fs.readFileSync(entry.file);
    } catch (err) {
      problems.push(`cannot read ${entry.file}: ${err.code}`);
      continue;
    }
    if (sha256Bytes(body) !== entry.sha256) problems.push(`content changed: ${entry.file}`);
    else if (body.length !== entry.bytes) problems.push(`size changed: ${entry.file}`);
  }
  return { ok: problems.length === 0, problems };
}

export function hasKind(entries, kind) {
  return entries.some((e) => e.kind === kind);
}
