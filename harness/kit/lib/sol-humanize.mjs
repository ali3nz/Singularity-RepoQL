// sol-humanize.mjs — V3.3 operator directive (2026-09-19): every prompt sent
// through the CatGPT gateway lands in the operator's real ChatGPT account.
// Mechanical strings ("Reply with exactly: SMOKE-OK") are obvious bot traffic.
// This module rewrites the HUMAN-FACING framing of Sol prompts to read like a
// person typed them — occasional contraction, casual opener, rare typo — while
// leaving every load-bearing byte untouched:
//   - JSON contract lines and shape examples (verdicts must stay parseable)
//   - fenced code blocks and inline JSON
//   - evidence packs (===== FILE ===== dumps) — everything after the evidence
//     header is verbatim
//   - verdict vocabulary (APPROVED / REMEDIATION_REQUIRED / QUALITY_AUDIT=...)
//   - file paths, engine ids, technical tokens
// Output-side contracts are NEVER relaxed: we humanize what the model READS,
// not what it must RETURN. SOL_RAW=1 bypasses humanization (debug only).
//
// Discretion rule that goes with this: do not spam the gateway with test
// calls. Use ORCH_TEST_BRIDGE_* fault injection for assertions; live checks
// are rare and phrased naturally.

// Lines that must never be altered (contract/structure/verdict material).
const PROTECTED_LINE =
  /(^\s*[{[]|^\s*```|"verdict"|"findings"|"fixed"|"rejected"|"issueId"|"severity"|"confidence"|"problem"|"evidence"|"recommendedFix"|"planSignoff"|"fixPlanSignoff"|"browserVerificationRequired"|Respond with|Your FINAL|No findings|BROWSER_VERIFICATION=|QUALITY_AUDIT=|FINAL_ACCEPTANCE=|REMEDIATION_REQUIRED|NEEDS_HUMAN_REVIEW|^\s*(IMPORTANT|NEVER|Do NOT|DO NOT|NOTE|GOTCHA)\b[:\-]?)/i;

// Headers that switch the rest of the prompt into verbatim evidence mode.
// (2026-09-19: IMPLEMENTATION EVIDENCE added — the final-acceptance pack from
// lib/evidence-pack.mjs rides behind this header and must ship byte-identical.)
const EVIDENCE_MODE =
  /^(#?\s*(FINAL EVIDENCE PACK|EVIDENCE PACK|IMPLEMENTATION EVIDENCE)|SCOPE:|DETERMINISTIC VALIDATION EVIDENCE|FINDINGS:|TASK:|IMAGES DETECTED)/;

// Words that must never receive a typo (technical tokens / verdict-adjacent).
const NEVER_TYPO = new Set([
  "json", "sol", "opencode", "freebuff", "controller", "verdict",
  "approve", "approved", "blocked", "review", "plan", "phase", "acceptance",
  "remediation", "browser", "telemetry", "watchdog", "supervisor", "quality",
  "read", "only", "bash", "tools", "file", "files", "code", "test", "tests",
  // V3.3.1: contract-adjacent literals — the model mirrors the tone of what
  // it reads and once typo'd the schema literal itself ("gatte", live), so
  // the words that appear inside the gate JSON example must never bend.
  "gate", "orchestration", "schema", "stage", "signoff", "signoffreason",
]);

// ---------------------------------------------------------------------------
// V3.3.4 DISCRETION SCRUB (2026-09-19, operator directive — hard requirement):
// prompts land in the operator's real chat account. Any mention of the
// automation mechanism (gateway names, ports, browser-automation stacks,
// prompt-rewriting) is a terms-of-service hazard. The scrub runs over the
// ENTIRE prompt — including fenced --open file content and evidence blocks —
// BEFORE the framing humanizer's verbatim protection applies, because these
// are surgical token replacements that cannot corrupt JSON structure. The
// humanizer then does its tone pass on top. Everything here is a backstop:
// authors must still write discreet briefs (the scrub is not a license).
const DISCRETION_SCRUB = [
  // longest/most-specific patterns first
  [/\bcatgpt[- ]?gateway\b/gi, "the service"],
  [/\bcatgpt\b/gi, "the service"],
  [/\bbrowser-emulated\s+chat\w*\b/gi, "the chat"],
  [/\bbrowser-emulat(?:ed|ion|ing)?\b/gi, "web-based"],
  [/\bopenai-compatible\b/gi, "standard-API"],
  [/\b(?:127\.0\.0\.1:)?8300(?:\/v1)?\b/g, "the API endpoint"],
  [/\b(?:patchright|playwright)\b/gi, "browser tooling"],
  [/\bnovnc\b/gi, "remote access"],
  [/\bsol-humaniz\w*/gi, "the rewording pass"],
  [/\bhumaniz(?:ed|er|ing|e)\b/gi, (m) => (/[Hh]umanizer/.test(m) ? "rewriter" : /[Hh]umanized/.test(m) ? "naturally worded" : "reword")],
  [/\bopenai-sol\b/gi, "the planner engine"],
  [/\bgpt-5\.6-sol\b/gi, "the model"],
  [/\bcatgpt\/headers\b/gi, "the credential file"],
  // ticket 319: \b does not split on "_" (word char), so identifiers like catgpt_gateway / catgpt_catgpt_browser_data
  // survived the rules above, tripped the bridge residual guard and hard-failed review gates (rc=1, 44 ms, no gateway call).
  // Catch-alls run LAST so the specific phrases above keep their wording.
  [/catgpt/gi, "the service"],
  [/openai[-_]sol/gi, "the planner engine"],
  [/(?:patchright|playwright)/gi, "browser tooling"],
];

export function scrubForDiscretion(text) {
  let s = String(text ?? "");
  for (const [re, to] of DISCRETION_SCRUB) s = s.replace(re, to);
  return s;
}

const DISCRETION_RESIDUAL = /catgpt|:8300|patchright|playwright|novnc|openai-compatible|browser-emulat|sol-humaniz|openai-sol|gpt-5\.6-sol/i;

function seededRandom(seed) {
  let s = seed >>> 0;
  return () => {
    s = (s * 1664525 + 1013904223) >>> 0;
    return s / 4294967296;
  };
}

// Inject one small human typo into an eligible word (duplicate or swap letters).
function maybeTypo(line, rand) {
  if (rand() > 0.28) return line; // most lines untouched
  const words = line.split(/\b/);
  const eligible = words
    .map((w, i) => ({ w, i }))
    .filter(({ w }) => /^[a-z]{4,9}$/.test(w) && !NEVER_TYPO.has(w));
  if (!eligible.length) return line;
  const { w, i } = eligible[Math.floor(rand() * eligible.length)];
  const pos = 1 + Math.floor(rand() * (w.length - 2));
  const kind = rand();
  let mutated;
  if (kind < 0.5) mutated = w.slice(0, pos) + w[pos] + w.slice(pos);            // doubled letter
  else if (w[pos + 1]) mutated = w.slice(0, pos) + w[pos + 1] + w[pos] + w.slice(pos + 2); // swapped letters
  else mutated = w;
  words[i] = mutated;
  return words.join("");
}

const OPENERS = ["hey — ", "ok, ", "quick one — ", "right, ", ""];

// Humanize one framing line: contractions, casual tone, rare imperfections.
function humanizeLine(line, rand, { isFirst }) {
  let s = line;
  s = s
    .replace(/\bYou are a\b/g, "you're a")
    .replace(/\bYou are an\b/g, "you're an")
    .replace(/\bYou are\b/g, "you're")
    .replace(/\bDo not\b/g, "don't")
    .replace(/\bIt is\b/g, "it's")
    .replace(/\bcannot\b/g, "can't")
    .replace(/\butilize\b/gi, "use")
    .replace(/\bPlease\b/g, "");
  if (isFirst && rand() < 0.45) {
    s = OPENERS[Math.floor(rand() * OPENERS.length)] + s.charAt(0).toLowerCase() + s.slice(1);
  } else if (rand() < 0.18) {
    s = s.charAt(0).toLowerCase() + s.slice(1);
  }
  // Raw dumps and inline source are not always fenced. Never manufacture
  // spelling errors in supplied text; casual framing does not require typos.
  return s;
}

// Main entry: returns the humanized prompt (protected regions byte-identical).
export function humanizeForSol(raw, { seed = Date.now() } = {}) {
  let text = scrubForDiscretion(String(raw ?? "")); // V3.3.4: always scrub first
  if (!text.trim()) return text;
  const rand = seededRandom(seed);
  const lines = text.split("\n");
  const out = [];
  let evidenceMode = false;
  let framingSeen = 0;
  // 2026-09-20 (live bug, Sol consult turn 6): fenced code blocks were only
  // protected at their ``` markers — the lines BETWEEN them were eligible for
  // the typo pass, which corrupted pasted source in evidence packs
  // ("function"->"functino", "--quad"->"--quaad"). The docstring above always
  // promised fenced blocks stay byte-identical; track fence state so it does.
  let inFence = false;
  for (const line of lines) {
    const fenceMark = /^\s*```/.test(line);
    if (fenceMark) inFence = !inFence;
    if (!evidenceMode && EVIDENCE_MODE.test(line)) evidenceMode = true;
    const protectedLine = evidenceMode || inFence || fenceMark || PROTECTED_LINE.test(line);
    if (protectedLine) { out.push(line); continue; }
    if (!line.trim()) { out.push(line); continue; }
    // Only known role/framing sentences are eligible for tone changes. Raw
    // source, base64, hashes and unfamiliar evidence must not be lowercased or
    // rewritten just because the author omitted a Markdown fence.
    if (!/^(?:You are\b|Do not\b|It is\b|Please\b)/.test(line)) {
      out.push(line); continue;
    }
    out.push(humanizeLine(line, rand, { isFirst: framingSeen === 0 }));
    framingSeen++;
  }
  return out.join("\n");
}

// CLI: bun sol-humanize.mjs <infile> [outfile]  (default: stdout)
if (import.meta.main) {
  const [, , infile, outfile] = process.argv;
  const { readFileSync, writeFileSync } = await import("node:fs");
  const humanized = humanizeForSol(readFileSync(infile, "utf8"));
  if (outfile) writeFileSync(outfile, humanized);
  else process.stdout.write(humanized);
}
