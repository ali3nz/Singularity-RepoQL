// review-evidence.mjs — V3.3.8: focused evidence selection for phase reviews.
//
// Problem observed live (run 2026-09-19T04-38-42): the phase-1 reviewer twice
// returned NEEDS_EVIDENCE naming exactly WHICH evidence it still lacked — but
// the generic collector caps evidence at the file HEAD (4k tail cap), and the
// worker's full evidence file had the demanded content at the tail. The
// reviewer only ever saw Section A and the loop hard-stopped at
// REMEDIATION_EXHAUSTED with good work unreviewed.
//
// extractFindingsEvidence(reviewText, fullEvidenceText) — three layers:
//   1. STRUCTURAL parse of the gate JSON: findings[] + finalReason are the
//      MISSING pool; evidenceChecked[] is the REVIEWED pool (a negative inside
//      an evidenceChecked entry flips it back to missing). Findings entries may
//      be strings or objects (severity/findign/... ) — stringified properly.
//   2. EXPLICIT letters: "Sections B through F", "Sections B, C", "Section C".
//   3. TOPIC RANKING: real reviewers name TOPICS ("Tailscale Serve help",
//      "SecretRef, Telegram, group-policy") not letters. Keyword-overlap ranks
//      each evidence section; the best-matching sections ride along (bounded).
// Output is bounded (total ≤ 12k chars, per-section ≤ 5k).

const TOTAL_MAX = 12000;
const PER_SECTION = 5000;
const STOPWORDS = new Set(
  ("a an and are as at be been but by for from has have if in into is it its of on or " +
    "ourthat that the their them then there these this those to was were will with " +
    "evidence review reviewer excerpt excerpts section sections provide provided " +
    "shows show show— missing required specifically existing complete support " +
    "supported substantial materially unless reveal revealed work implementation " +
    "new phase raw additionally however which what when where why how all any").split(/\s+/)
);

function expandRange(a, b) {
  const out = [];
  for (let c = a.charCodeAt(0); c <= b.charCodeAt(0); c++) out.push(String.fromCharCode(c));
  return out;
}

// Findings entries can be strings OR objects ({severity, findign, evidence}).
function flatEntry(x) {
  if (typeof x === "string") return x;
  if (x && typeof x === "object") {
    return Object.values(x).filter((v) => typeof v === "string").join(" — ");
  }
  return "";
}

function splitSections(body) {
  // Headers like "## SECTION A — ...", "### Section c:", "# Section 3 ...".
  const marks = [];
  for (const m of body.matchAll(/(^|\n)#{1,4}\s*Section\s+([A-Za-z0-9])\b[^\n]*/gi)) {
    marks.push({ label: m[2].toUpperCase(), start: m.index + m[1].length, header: m[0].trim() });
  }
  if (!marks.length) return [];
  marks.sort((a, b) => a.start - b.start);
  const secs = [];
  for (let i = 0; i < marks.length; i++) {
    const end = i + 1 < marks.length ? marks[i + 1].start : Math.min(body.length, marks[i].start + 20000);
    secs.push({ label: marks[i].label, start: marks[i].start, chunk: body.slice(marks[i].start, end).trim() });
  }
  return secs;
}

function keywordsOf(text) {
  const out = new Set();
  for (const w of String(text).toLowerCase().match(/[a-z][a-z0-9_.-]{2,}/g) ?? []) {
    const k = w.replace(/[^a-z0-9_.-]/g, "");
    if (k.length >= 4 && !STOPWORDS.has(k)) out.add(k);
  }
  return out;
}

export function extractFindingsEvidence(reviewText, fullEvidenceText) {
  const src = String(reviewText ?? "");
  const body = String(fullEvidenceText ?? "");
  if (!src || !body) return "";

  let missingText = "";
  let reviewedText = "";
  let topicText = "";
  try {
    const gate = JSON.parse(src);
    const findings = Array.isArray(gate.findings) ? gate.findings.map(flatEntry) : [];
    missingText = [...findings, gate.finalReason ?? ""].join("\n");
    const ec = Array.isArray(gate.evidenceChecked) ? gate.evidenceChecked.map(flatEntry) : [];
    reviewedText = ec.join("\n");
    // finalReason that carries the demand list outranks findings' positive-sighting vocabulary.
    topicText = typeof gate.finalReason === "string" && gate.finalReason.length > 40 ? gate.finalReason : missingText;
  } catch {
    missingText = src; // legacy free-text review: everything is missing-pool
    topicText = src;
  }

  const NEG =
    /(not\s+present|does\s+not\s+include|cannot\s+be\s+independently|cannot\s+verify|missing|not\s+included|is\s+not\s+included|provide\s+the|requires?\s+the|insufficient|supplied\s+excerpt\s+stops)/i;

  const missing = new Set();
  const reviewed = new Set();

  // Findings/finalReason are demands by definition.
  for (const m of missingText.matchAll(/\bSection ([A-Z])\b/g)) missing.add(m[1]);
  // evidenceChecked = "what I saw", unless the entry itself is negative.
  for (const m of reviewedText.matchAll(/\bSection ([A-Z])\b/g)) {
    const window = reviewedText.slice(Math.max(0, m.index - 60), m.index + 160);
    if (NEG.test(window)) missing.add(m[1]);
    else reviewed.add(m[1]);
  }
  // Explicit ranges/lists inside the missing pool.
  for (const m of missingText.matchAll(/Sections?\s+([A-Z])\s*(?:through|-|–|to)\s*([A-Z])\b/g)) {
    for (const s of expandRange(m[1], m[2])) missing.add(s);
  }
  for (const m of missingText.matchAll(/Sections?\s+([A-Z](?:\s*,\s*[A-Z])*(?:\s*,?\s*and\s+[A-Z])?)\b/g)) {
    for (const s of m[1].match(/[A-Z]/g) ?? []) missing.add(s);
  }
  for (const s of reviewed) missing.delete(s);

  const secs = splitSections(body);
  // Header-less evidence files (the worker's `--- G1. ---` style packs): treat
  // the whole body as one pseudo-section so the topic layer can still rank and
  // ride it in — otherwise these files produce zero enrichment and the review
  // loop re-asks for content that was already captured.
  if (!secs.length) {
    if (body.trim()) secs.push({ label: "FULL", chunk: body.slice(0, Math.min(body.length, TOTAL_MAX)) });
    else return "";
  }

  const chosen = []; // {label, chunk}
  for (const label of [...missing].sort()) {
    const sec = secs.find((s) => s.label === label);
    if (sec) chosen.push({ label, chunk: sec.chunk });
  }

  // Topic layer: if the reviewer named no letters (or letters resolved to
  // nothing), rank sections by keyword overlap with the demand text. The
  // demand keywords come from finalReason when it carries the demand list
  // (the live review did); findings' positive-sighting vocabulary would
  // otherwise flood the ranking and re-select sections the reviewer already
  // confirmed seeing.
  if (!chosen.length) {
    const kws = keywordsOf(topicText);
    if (kws.size) {
      const scored = secs
        .map((s) => {
          const low = s.chunk.toLowerCase();
          let hits = 0;
          for (const k of kws) if (low.includes(k)) hits++;
          return { label: s.label, chunk: s.chunk, hits };
        })
        .filter((s) => s.hits >= 3)
        .sort((a, b) => b.hits - a.hits || a.label.localeCompare(b.label))
        .slice(0, 4);
      for (const s of scored) chosen.push({ label: s.label, chunk: s.chunk, hits: s.hits });
    }
  }

  if (!chosen.length) return "";

  const parts = [];
  let total = 0;
  for (const c of chosen) {
    let chunk = c.chunk;
    if (chunk.length > PER_SECTION) chunk = chunk.slice(0, PER_SECTION) + "\n… (truncated)";
    if (total + chunk.length > TOTAL_MAX) chunk = chunk.slice(0, Math.max(0, TOTAL_MAX - total));
    if (!chunk) break;
    total += chunk.length;
    const why = c.hits != null ? `topic match (${c.hits} keywords from the review's demands)` : "named as missing by the review";
    parts.push(`### Section ${c.label} (${why})\n${chunk}`);
    if (total >= TOTAL_MAX) break;
  }
  return parts.length
    ? `\n# REVIEW-REQUESTED EVIDENCE (raw content the prior review could not see)\n\n${parts.join("\n\n")}\n`
    : "";
}
