import { verifiedRustCompat } from "./rust-compat-policy.mjs";
// gate-parser.mjs — parse and validate orchestration-gate-v2 JSON with a
// legacy text-marker fallback (migration compatibility; remove legacy after
// all bridges pass shadow tests).
export const GATE_SCHEMA = "orchestration-gate-v2";

const PLAN_VERDICTS = ["APPROVED", "NEEDS_DISCOVERY", "BLOCKED"];
// V3.3 §9: Sol's schema uses APPROVED|REMEDIATION_REQUIRED|NEEDS_HUMAN_REVIEW
// for review and ACCEPTED|ACCEPTED_WITH_NOTES|REMEDIATION_REQUIRED|
// NEEDS_HUMAN_REVIEW for final acceptance. Aliased onto the existing verdict
// vocabulary so gates/bounds/ledger stay uniform across engines.
const REVIEW_VERDICTS = ["APPROVED", "NEEDS_FIX", "NEEDS_EVIDENCE", "BLOCKED"];
// V3.4.0 (plan §11.6): REVIEW may dispose memory candidates with these typed
// verdicts. Kept in lockstep with lib/memory-learning.mjs REVIEW_DISPOSITIONS.
const MEMORY_DISPOSITIONS = ["verify", "amend", "reject", "duplicate", "case_only", "needs_operator", "supersede_existing"];
const REVIEW_VERDICT_ALIASES = {
  REMEDIATION_REQUIRED: "NEEDS_FIX",
  NEEDS_HUMAN_REVIEW: "BLOCKED",
  REQUEST_CHANGES: "NEEDS_FIX",
  request_changes: "NEEDS_FIX",
  approve: "APPROVED",
  approved: "APPROVED",
  ACCEPTED: "APPROVED",
  ACCEPTED_WITH_NOTES: "APPROVED",
};
const RISKS = ["LOW", "NORMAL", "HIGH", "CRITICAL"];

// V3.3.1 (2026-09-19): tolerate single-character slips on the schema literal.
// Live finding: Sol returned "orchestration-gatte-v2" — a one-insertion slip
// on the token that must be byte-perfect, while every substantive field of
// the gate was valid. Sol reads a deliberately human-toned prompt (operator
// discretion directive) through a browser bridge; a probabilistic model WILL
// occasionally bend a long literal. The schema field is a fixed literal with
// exactly one legitimate value, so a bounded fuzzy match there is unambiguous
// and safe. NEVER fuzzy-match verdict/stage/planSignoff — those are semantic.
const SCHEMA_FLAT = "orchestrationgatev2";
function schemaDistance(a, b) {
  // Levenshtein, two-row DP; inputs are short fixed strings.
  const m = a.length, n = b.length;
  let prev = Array.from({ length: n + 1 }, (_, j) => j);
  for (let i = 1; i <= m; i++) {
    const cur = [i];
    for (let j = 1; j <= n; j++) {
      cur[j] = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
    }
    prev = cur;
  }
  return prev[n];
}
function tolerateSchemaSlip(json) {
  if (!json || typeof json !== "object" || typeof json.schema !== "string") return json;
  const flat = json.schema.toLowerCase().replace(/[^a-z0-9]/g, "");
  if (flat === SCHEMA_FLAT) return json;
  if (flat.length >= SCHEMA_FLAT.length - 1 && flat.length <= SCHEMA_FLAT.length + 1 && schemaDistance(flat, SCHEMA_FLAT) <= 1) {
    return { ...json, schema: GATE_SCHEMA };
  }
  return json;
}

// V3.3.1 (2026-09-19, live-finding #3): models writing shell commands inside
// JSON strings emit shell-style escapes — `\(`, `\)`, `\!` — which are INVALID
// JSON escapes; JSON.parse rejects the ENTIRE gate because of one backslash
// in an example command (all four Sol plan calls on the night of 2026-09-18
// died this way). Repair by doubling any backslash whose successor is not a
// valid JSON escape start. Pair-consuming scan: `\\(` (a valid escaped
// backslash) is left untouched; `\u` is only honored with 4 hex digits.
// Context-free and bounded — valid content cannot be corrupted.
function repairInvalidEscapes(s) {
  const VALID = new Set(["\\", "/", '"', "b", "f", "n", "r", "t"]);
  const HEX = /[0-9a-fA-F]/;
  let out = "";
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (c !== "\\") { out += c; continue; }
    const n = s[i + 1];
    if (n === undefined) { out += "\\\\"; break; } // trailing backslash
    if (VALID.has(n)) { out += c + n; i++; continue; }
    if (n === "u" && HEX.test(s[i + 2] ?? "") && HEX.test(s[i + 3] ?? "") && HEX.test(s[i + 4] ?? "") && HEX.test(s[i + 5] ?? "")) {
      out += c + n; i += 4; continue; // \uXXXX — leave for JSON.parse to validate
    }
    out += "\\\\"; // invalid escape: double the backslash, keep the char
  }
  return out;
}

// V3.3.1 (2026-09-19, live-finding #4): unescaped double quotes INSIDE string
// values — e.g. a plan step embedding test \"$(tail -n 1 f)\" — terminate the
// string early and kill the whole JSON. Repair (strict parse having already
// failed): walk with string-context tracking; a quote inside a string is a
// CLOSER only when followed (after whitespace) by a structural char
// (, } ] : or end) — otherwise it is escaped in place. Best-effort and
// bounded: it runs only after the strict parse failed, so valid gates are
// untouched, and ambiguous cases still fail closed (return null upstream).
function repairUnescapedQuotes(s) {
  const isStruct = (c) => c === "," || c === "}" || c === "]" || c === ":";
  let out = "";
  let inStr = false;
  let lastSig = ""; // last significant char outside strings
  const stack = []; // open-bracket context: '{' or '[' — an opener after ',' is a
                    // VALUE in arrays, a KEY in objects; the stack disambiguates.
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (inStr) {
      if (c === "\\") { out += c + (s[i + 1] ?? ""); i++; continue; } // respect existing escapes
      if (c === '"') {
        let j = i + 1;
        while (j < s.length && /\s/.test(s[j])) j++;
        if (j >= s.length || isStruct(s[j])) { inStr = false; out += c; continue; } // real closer
        out += '\\"'; continue; // quote inside the value: escape it
      }
      out += c;
      continue;
    }
    if (c === '"') {
      // Opening: a VALUE gets the in-string repair treatment (embedded quotes
      // escaped); a KEY is consumed verbatim. Context: after ':' or inside an
      // array (opener '[' or a ',' whose innermost open bracket is '[').
      const top = stack[stack.length - 1];
      const opensValue = lastSig === ":" || lastSig === "[" || (lastSig === "," && top === "[");
      if (opensValue) { inStr = true; out += c; continue; }
      // Consume the key string without repair (skip to its closer).
      let j = i + 1;
      while (j < s.length && s[j] !== '"') { if (s[j] === "\\") j++; j++; }
      out += s.slice(i, j + 1); // includes the opening quote — do NOT write c first
      i = j;
      continue;
    }
    if (c === "{" || c === "[") stack.push(c);
    else if (c === "}" || c === "]") stack.pop();
    if (!/\s/.test(c)) lastSig = c;
    out += c;
  }
  return out;
}

// V3.3.1 (2026-09-19, live-finding #5): models mirroring the humanized tone
// occasionally typo CANONICAL KEY names — "setp" and "phaess" were both
// observed live in an otherwise-valid APPROVED gate. Only exact-match aliases
// on known structural keys are remapped; unknown keys pass through; semantic
// VALUES (verdict/risk/signoff) are never touched by this map.
const KEY_ALIASES = Object.freeze({ setp: "step", phaess: "phases" });
function normalizeGateKeys(json) {
  if (!json || typeof json !== "object" || Array.isArray(json)) return json;
  const fixKeys = (o) => {
    if (!o || typeof o !== "object" || Array.isArray(o)) return o;
    const out = {};
    for (const [k, v] of Object.entries(o)) out[KEY_ALIASES[k] ?? k] = v;
    return out;
  };
  const j = fixKeys(json);
  for (const arrKey of ["plan", "phases", "discoveryRequests", "fixPlan", "findings"]) {
    if (Array.isArray(j[arrKey])) j[arrKey] = j[arrKey].map(fixKeys);
  }
  return j;
}

// V3.3.1: exported for diagnostics/tests — the repair path is best-effort and
// must be observable when it fails.
export { repairInvalidEscapes, repairUnescapedQuotes, normalizeGateKeys };

export function tryParseGateV2(text, stage) {
  if (!text || typeof text !== "string") return null;
  // strip optional markdown fences
  let t = text.trim();
  const fence = t.match(/```(?:json)?\s*([\s\S]*?)```/);
  if (fence) t = fence[1].trim();
  // find first { ... last }
  const a = t.indexOf("{"), b = t.lastIndexOf("}");
  if (a === -1 || b <= a) return null;
  let json = null;
  const slice0 = t.slice(a, b + 1);
  // V3.3.1: strict parse first; then bounded best-effort repairs, ordered
  // least-invasive first. Any successful parse stops the chain; ambiguous
  // garbage still returns null (fail closed).
  for (const cand of [slice0, repairInvalidEscapes(slice0), repairUnescapedQuotes(slice0), repairInvalidEscapes(repairUnescapedQuotes(slice0))]) {
    try { json = JSON.parse(cand); break; } catch { /* next candidate */ }
  }
  if (!json || typeof json !== "object") return null;
  json = normalizeGateKeys(tolerateSchemaSlip(json)); // V3.3.1: schema-slip + key-slip normalization
  if (json.schema !== GATE_SCHEMA || json.stage !== stage) return null;
  return validateGateV2(json, stage);
}

// V3.3.7 (2026-09-19): diagnosable parse failures. tryParseGateV2 returns a
// bare null; this wrapper answers WHY a full-size response failed, so a
// healthy-but-unparseable Sol answer can be classified from the attempts
// log instead of being misread as "empty response".
export function explainParseFailure(text, stage) {
  if (!text || typeof text !== "string") return "no output text";
  const t = text.trim();
  if (!t) return "empty output after trim";
  const a = t.indexOf("{"), b = t.lastIndexOf("}");
  if (a === -1 || b <= a) {
    return `no JSON object found (${t.length} chars; first 120: ${t.slice(0, 120).replace(/\s+/g, " ")})`;
  }
  const slice0 = t.slice(a, b + 1);
  const cands = [slice0, repairInvalidEscapes(slice0), repairUnescapedQuotes(slice0), repairInvalidEscapes(repairUnescapedQuotes(slice0))];
  let lastErr = null;
  for (const cand of cands) {
    try { JSON.parse(cand); return "JSON parses but failed schema/stage/verdict validation"; }
    catch (e) { lastErr = e; }
  }
  const msg = String(lastErr?.message ?? "unknown JSON error");
  const pos = msg.match(/position (\d+)/);
  const at = pos ? ` …context: ${JSON.stringify(slice0.slice(Math.max(0, parseInt(pos[1], 10) - 60), parseInt(pos[1], 10) + 60))}` : "";
  return `invalid JSON after all repairs: ${msg.slice(0, 160)}${at.slice(0, 200)}`;
}

export function validateGateV2(g, stage) {
  // V3.3 §9: alias Sol's verdict vocabulary onto the canonical one BEFORE
  // validation, so REMEDIATION_REQUIRED etc. parse as first-class verdicts.
  if (stage !== "plan" && typeof g.verdict === "string" && REVIEW_VERDICT_ALIASES[g.verdict]) {
    g = { ...g, verdict: REVIEW_VERDICT_ALIASES[g.verdict] };
  }
  const verdicts = stage === "plan" ? PLAN_VERDICTS : REVIEW_VERDICTS;
  const err = (m) => ({ valid: false, error: m, gate: g });
  if (!verdicts.includes(g.verdict)) return err(`verdict ${g.verdict} not in ${verdicts}`);
  if (stage === "plan") {
    if (!RISKS.includes(g.risk)) return err(`risk ${g.risk} invalid`);
    if (g.verdict === "APPROVED" && g.planSignoff !== "APPROVED") {
      return err("verdict APPROVED requires planSignoff APPROVED");
    }
    if (g.verdict !== "APPROVED" && g.planSignoff === "APPROVED") {
      return err(`verdict ${g.verdict} must have planSignoff NOT_APPROVED`);
    }
    if (g.verdict === "APPROVED" && !Array.isArray(g.plan) || (g.verdict === "APPROVED" && g.plan.length === 0)) {
      return err("APPROVED plan requires non-empty plan[]");
    }
    if (g.verdict === "NEEDS_DISCOVERY" && (!Array.isArray(g.discoveryRequests) || g.discoveryRequests.length === 0)) {
      return err("NEEDS_DISCOVERY requires discoveryRequests[]");
    }
  }
  if (stage === "review") {
    // V3.4.0 (ticket 088, plan §11.6): optional memoryDispositions[] — the
    // reviewer's verdicts on implementation-proposed memory candidates.
    // Shape-only validation: candidateId MCdddd, disposition in enum.
    if (g.memoryDispositions != null) {
      if (!Array.isArray(g.memoryDispositions)) return err("memoryDispositions must be an array");
      for (const d of g.memoryDispositions) {
        if (!d || typeof d !== "object") return err("memoryDispositions entries must be objects");
        if (!/^MC\d{4}$/.test(String(d.candidateId ?? ""))) return err(`memoryDispositions candidateId invalid: ${d.candidateId}`);
        if (!MEMORY_DISPOSITIONS.includes(d.disposition)) return err(`memoryDispositions disposition invalid: ${d.disposition}`);
      }
    }
    if (g.verdict === "APPROVED" && g.fixPlanSignoff !== "NOT_REQUIRED") {
      return err("verdict APPROVED requires fixPlanSignoff NOT_REQUIRED");
    }
    if (g.verdict === "NEEDS_FIX") {
      if (g.fixPlanSignoff !== "APPROVED") return err("NEEDS_FIX requires fixPlanSignoff APPROVED (signed fix plan in same response)");
      if (!Array.isArray(g.fixPlan) || g.fixPlan.length === 0) return err("NEEDS_FIX requires non-empty fixPlan[]");
    }
    if (g.verdict === "NEEDS_EVIDENCE" && g.fixPlanSignoff === "APPROVED") {
      return err("NEEDS_EVIDENCE must not carry an approved fix plan");
    }
  }
  return { valid: true, gate: g };
}

// Legacy text-marker parsing (current kit's format). Kept for migration only.
export function tryParseLegacyGate(text, stage) {
  if (!text) return null;
  const t = String(text);
  const verdict = t.match(/VERDICT:?\s*[`*_'"\s]*\**\s*(APPROVED|NEEDS_WORK|NEEDS_EVIDENCE|CONFIRMED|CONTRADICTED|UNCERTAIN)/i)?.[1]?.toUpperCase();
  if (!verdict) return null;
  if (stage === "plan") {
    const approved = verdict === "APPROVED" || verdict === "CONFIRMED";
    return {
      valid: approved ? undefined : true, // legacy needs no strict invariants
      compatibilityMode: true,
      schema: "legacy",
      stage,
      verdict: approved ? "APPROVED" : verdict === "NEEDS_WORK" ? "NEEDS_DISCOVERY" : "BLOCKED",
      legacyText: t,
    };
  }
  const approved = verdict === "APPROVED" || verdict === "CONFIRMED";
  return {
    compatibilityMode: true,
    schema: "legacy",
    stage,
    verdict: approved ? "APPROVED" : verdict === "NEEDS_WORK" ? "NEEDS_FIX" : verdict === "NEEDS_EVIDENCE" ? "NEEDS_EVIDENCE" : "BLOCKED",
    legacyText: t,
  };
}

// Main entry: gate-v2 first, legacy fallback. Throws on invalid with no fallback.
export function parseGate(text, stage) {
  const v2 = tryParseGateV2(text, stage);
  if (v2) {
    const reference = { ...v2, compatibilityMode: false };
    // The native parser may supply a V2 gate only after exact comparison.
    // Legacy compatibility markers retain their original JavaScript shape.
    return verifiedRustCompat("gate.parse", { text, stage }, reference);
  }
  const legacy = tryParseLegacyGate(text, stage);
  if (legacy) return legacy;
  const e = new Error(`invalid gate response for stage=${stage}`);
  e.rc = 47;
  throw e;
}

export function writesAllowed(planGate) {
  return !!(planGate && planGate.verdict === "APPROVED" && planGate.planSignoff === "APPROVED");
}

export function fixAllowed(reviewGate) {
  return !!(reviewGate && reviewGate.verdict === "NEEDS_FIX" && reviewGate.fixPlanSignoff === "APPROVED");
}
