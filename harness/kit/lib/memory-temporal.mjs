// lib/memory-temporal.mjs — bi-temporal validity (hub ticket 191, Sol Gate 1
// consult 2026-10-01T01-44-22). The two timelines (Atlas §31-33):
//   valid time  — when the fact was true in the represented world
//   record time — when this system knew / recorded the fact
// They answer different questions and are NEVER conflated, never synthesized:
// an absent timestamp is meaningful information ("unknown"), and inventing one
// is a falsification of the record (Sol Gate-1 correction 3: recordedAt must
// not be derived from git birth time or verified.date — those are different
// events).
//
// Semantics are THREE-VALUED (Sol correction 5): every filter returns
//   MATCH | NO_MATCH | UNKNOWN_TEMPORAL_METADATA
// and UNKNOWN is never silently treated as a match or a no-match. Current
// truth keeps legacy-compatible behaviour (unknown metadata never makes
// current knowledge disappear); historical/belief queries are strict: they
// require the relevant timestamp to be KNOWN and honestly report UNKNOWN
// otherwise. Rejected / superseded / expired stay separate by construction:
//   rejected   — tombstone (lib/memory-tombstone.mjs)
//   superseded — validTo set at a known replacement boundary (still was true)
//   expired    — TTL staleness (verification freshness, not falsehood)
// (intentionally NO kit imports: this module is a leaf — memory-candidate-v2
// imports it for candidate-side temporal validation, so any import back into
// the conflict-gate plane would create a cycle)

export const TEMPORAL_VERDICT = Object.freeze({
  MATCH: "MATCH",
  NO_MATCH: "NO_MATCH",
  UNKNOWN: "UNKNOWN_TEMPORAL_METADATA",
  REQUIRES_KNOWN_VALID_FROM: "UNKNOWN_TEMPORAL_METADATA_REQUIRES_KNOWN_VALID_FROM",
  REQUIRES_KNOWN_RECORDED_AT: "UNKNOWN_TEMPORAL_METADATA_REQUIRES_KNOWN_RECORDED_AT",
});

const parseIso = (s) => {
  const t = Date.parse(s);
  return Number.isNaN(t) ? null : t;
};

// Extract optional temporal metadata from a capsule body (frontmatter
// validFrom / validTo / recordedAt, one-line values like the rest of the
// YAML-lite frontmatter). Absent = unknown.
export function extractTemporal(capsuleBody) {
  const raw = String(capsuleBody ?? "");
  const grab = (key) => {
    const m = raw.match(new RegExp(`^${key}:\\s*(.+)$`, "m"));
    if (!m) return null;
    const v = m[1].trim().replace(/^["']|["']$/g, "");
    return v === "" ? null : v;
  };
  const validFromRaw = grab("validFrom");
  const validToRaw = grab("validTo");
  const recordedAtRaw = grab("recordedAt");
  if (validFromRaw == null && validToRaw == null && recordedAtRaw == null) {
    return { validFrom: null, validTo: null, recordedAt: null, unknown: true };
  }
  const bad = [];
  const validFrom = validFromRaw == null ? null : parseIso(validFromRaw);
  const validTo = validToRaw == null ? null : parseIso(validToRaw);
  const recordedAt = recordedAtRaw == null ? null : parseIso(recordedAtRaw);
  if (validFromRaw != null && validFrom == null) bad.push("validFrom");
  if (validToRaw != null && validTo == null) bad.push("validTo");
  if (recordedAtRaw != null && recordedAt == null) bad.push("recordedAt");
  if (bad.length) throw new Error(`memory-temporal: ${bad.join(", ")} present but not valid ISO in capsule frontmatter`);
  return { validFrom, validTo, recordedAt, unknown: false };
}

// Normalize one optional candidate timestamp: null/absent stays null (unknown);
// a present-but-invalid value is a hard error (fail closed on malformed data —
// never silently reinterpret it, never synthesize a replacement).
export function normalizeOptionalTimestamp(value, label = "timestamp") {
  if (value == null || value === "") return null;
  const t = parseIso(value);
  if (t == null) throw new Error(`memory-temporal: ${label} present but not a valid ISO timestamp: ${String(value).slice(0, 40)}`);
  return new Date(t).toISOString();
}

function isoOrNull(value, label) {
  if (value == null || value === "") return null;
  const t = parseIso(value);
  if (t == null) throw new Error(`memory-temporal: candidate ${label} present but not ISO: ${String(value).slice(0, 40)}`);
  return new Date(t).toISOString();
}

// ---- candidate-level temporal pass-through -----------------------------------
// Optional validFrom/validTo/recordedAt on memory-candidate-v2 records. The
// candidate keeps whatever it carries: missing stays missing (no synthesis).
// Validation is limited to the Sol Gate-1 invariants: valid ISO when present,
// validFrom <= validTo when both present.
export function candidateTemporal(cand) {
  const out = {
    validFrom: isoOrNull(cand?.validFrom, "validFrom"),
    validTo: isoOrNull(cand?.validTo, "validTo"),
    recordedAt: isoOrNull(cand?.recordedAt, "recordedAt"),
  };
  if (out.validFrom && out.validTo && out.validFrom > out.validTo) {
    throw new Error("memory-temporal: candidate validFrom <= validTo required when both present");
  }
  return out;
}

// Ticket 776 fix (P0 §3.3 sibling correctness): timestamps may arrive as epoch
// numbers (extractTemporal) OR ISO strings (candidateTemporal upserts) — every
// filter NORMALISES before comparing. Never compare number vs ISO string
// (that comparison is always false/NaN and would fail-open known-past facts).
function toEpoch(v) {
  if (v == null) return null;
  if (typeof v === "number" && Number.isFinite(v)) return v;
  return parseIso(String(v));
}
function normalizeTemporalShape(t) {
  if (!t) return t;
  return {
    validFrom: toEpoch(t.validFrom),
    validTo: toEpoch(t.validTo),
    recordedAt: toEpoch(t.recordedAt),
    unknown: !!t.unknown,
  };
}
// ---- the three-valued filters -------------------------------------------------
// currentTruth: legacy-compatible (Sol: unknown metadata must not make current
// knowledge disappear). Excludes only KNOWN past validity (validTo <= now) and
// KNOWN future validity (validFrom > now). Tombstone/TTL exclusion is the
// callers' job — separate concerns.
export function currentTruth({ capsuleBody = null, temporal = null, now = new Date() } = {}) {
  const t = normalizeTemporalShape(temporal ?? (capsuleBody != null ? extractTemporal(capsuleBody) : null));
  if (!t || t.unknown) return TEMPORAL_VERDICT.MATCH;
  const n = now.getTime();
  if (t.validTo != null && n >= t.validTo) return TEMPORAL_VERDICT.NO_MATCH;
  if (t.validFrom != null && n < t.validFrom) return TEMPORAL_VERDICT.NO_MATCH;
  return TEMPORAL_VERDICT.MATCH;
}

// historicalTruth(asOf): was the fact true at asOf? STRICT — requires a KNOWN
// validFrom; without it the honest answer is UNKNOWN, never claimed support.
export function historicalTruth({ capsuleBody = null, temporal = null, asOf } = {}) {
  const t = normalizeTemporalShape(temporal ?? (capsuleBody != null ? extractTemporal(capsuleBody) : null));
  if (!t || t.unknown) return TEMPORAL_VERDICT.UNKNOWN;
  if (t.validFrom == null) return TEMPORAL_VERDICT.REQUIRES_KNOWN_VALID_FROM;
  const a = toEpoch(asOf);
  if (a == null) throw new Error("memory-temporal: historicalTruth requires a known asOf (ISO)");
  if (t.validFrom > a) return TEMPORAL_VERDICT.NO_MATCH;
  if (t.validTo != null && a >= t.validTo) return TEMPORAL_VERDICT.NO_MATCH;
  return TEMPORAL_VERDICT.MATCH;
}

// beliefTruth(asOf): what the system RECORDED as of a time — requires a KNOWN
// recordedAt (never git birth time, never verified.date).
export function beliefTruth({ capsuleBody = null, temporal = null, asOf } = {}) {
  const t = normalizeTemporalShape(temporal ?? (capsuleBody != null ? extractTemporal(capsuleBody) : null));
  if (!t || t.unknown) return TEMPORAL_VERDICT.UNKNOWN;
  if (t.recordedAt == null) return TEMPORAL_VERDICT.REQUIRES_KNOWN_RECORDED_AT;
  const a = toEpoch(asOf);
  if (a == null) throw new Error("memory-temporal: beliefTruth requires a known asOf (ISO)");
  return t.recordedAt <= a ? TEMPORAL_VERDICT.MATCH : TEMPORAL_VERDICT.NO_MATCH;
}

// ---- interval helper (temporal supersession, plan §37/§38) --------------------
// A changed fact is NOT a rejected fact. When a replacement value has a known
// validFrom, the previous capsule's validTo MAY be set to that boundary — only
// when the boundary is actually known, only by REVIEW, never by machinery.
// This helper lets the review side PREVIEW that edit; it never writes.
export function supersessionBoundary({ previousTemporal, replacementValidFrom }) {
  if (!previousTemporal || previousTemporal.unknown) {
    return { applicable: false, validTo: null, reason: "previous capsule has no temporal metadata (unknown stays unknown)" };
  }
  if (replacementValidFrom == null) {
    return { applicable: true, validTo: null, reason: "replacement validFrom unknown — leave previous validTo unset (still was true; not rejected)" };
  }
  const rf = parseIso(replacementValidFrom);
  if (rf == null) throw new Error("supersessionBoundary: replacementValidFrom present but not ISO");
  return { applicable: true, validTo: new Date(rf).toISOString(), reason: "set previous validTo to the known replacement boundary (review action; not machinery)" };
}
