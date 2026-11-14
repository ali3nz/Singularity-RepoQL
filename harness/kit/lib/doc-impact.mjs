import { spawnSync } from "node:child_process";
import { isDeepStrictEqual } from "node:util";
import { isAbsolute, win32 } from "node:path";

// Independent closeout policy switch, not a change to stage order or routing.
// Treat every native mismatch as a failed documentation-governance check.
const RUST_EVIDENCE_BIN = "SINGULARITY_RUST_EVIDENCE_POLICY_BIN";
function runNativeDocPolicy(command, payload) {
  const bin = process.env[RUST_EVIDENCE_BIN];
  if (!bin || bin.includes("\0") || (!isAbsolute(bin) && !win32.isAbsolute(bin))) {
    throw new Error("RUST_DOC_POLICY_INVALID_BINARY");
  }
  const input = JSON.stringify(payload);
  if (typeof input !== "string" || Buffer.byteLength(input,"utf8") > 256 * 1024) {
    throw new Error("RUST_DOC_POLICY_INPUT_LIMIT");
  }
  const run = spawnSync(bin,[command],{input,encoding:"utf8",shell:false,windowsHide:true,
    timeout:3500,maxBuffer:1024*1024});
  if (run.error || run.status !== 0) throw new Error("RUST_DOC_POLICY_EXECUTION_FAILED");
  try { const result = JSON.parse(run.stdout); if (result && typeof result === "object" && !Array.isArray(result)) return result; }
  catch { /* malformed native output is never a successful closeout */ }
  throw new Error("RUST_DOC_POLICY_INVALID_RESPONSE");
}

// doc-impact.mjs — V3.3.35 (ticket 085, plan D17). Small source-to-document
// impact map for the core components, consulted at closeout. `unmapped` is an
// unclassified state, NOT "no impact": a changed file that maps to nothing
// must be surfaced for human classification. A `no impact` disposition
// requires a reason string.

// map: glob-ish prefixes (matched against paths relative to the kit dir)
// -> hub documents that describe current state for that component.
const MAP = [
  { match: /^orchestrate\.mjs$/, docs: ["documentation/ai-orchestration.md", "documentation/orchestra-commands.md"] },
  { match: /^config\.json$/, docs: ["documentation/ai-orchestration.md"] },
  { match: /^lib\/engine-router\.mjs$/, docs: ["documentation/ai-orchestration.md", "documentation/orchestra-commands.md"] },
  { match: /^lib\/case-state\.mjs$/, docs: ["documentation/ai-orchestration.md"] },
  { match: /^lib\/case-store\.mjs$/, docs: ["documentation/ai-orchestration.md"] },
  { match: /^lib\/approval-artifact\.mjs$/, docs: ["documentation/ai-orchestration.md"] },
  { match: /^lib\/policy-identity\.mjs$/, docs: ["documentation/ai-orchestration.md"] },
  { match: /^lib\/payload-budget\.mjs$/, docs: ["documentation/ai-orchestration.md"] },
  // V3.4.3 ticket 094 (Sol FIX PLAN): the RepoQL plane is a doc-mapped component.
  { match: /^lib\/repoql-client\.mjs$/, docs: ["documentation/ai-orchestration.md", "documentation/tools/repoql-usage.md"] },
  { match: /^lib\/concept-capture\.mjs$/, docs: ["documentation/ai-orchestration.md", "documentation/tools/repoql-usage.md"] },
  { match: /^\.repoql\/concepts\//, docs: ["documentation/tools/repoql-usage.md"] },
  { match: /^lib\/plan-cache\.mjs$/, docs: ["documentation/ai-orchestration.md"] },
  { match: /^openai-sol-bridge\.sh$/, docs: ["documentation/services/catgpt_gateway.md", "documentation/ai-orchestration.md"] },
  { match: /^lib\/sol-humanize\.mjs$/, docs: ["documentation/services/catgpt_gateway.md"] },
  { match: /^lib\/nanny\.mjs$/, docs: ["documentation/ai-orchestration.md"] },
  { match: /^lib\/start-guard\.mjs$/, docs: ["documentation/ai-orchestration.md"] },
  { match: /^lib\/debrief\.mjs$/, docs: ["documentation/orchestra-lessons.md", "documentation/ai-orchestration.md"] },
  { match: /^prompts\//, docs: ["documentation/ai-orchestration.md"] },
];

// changedFiles: [{path, status}] — status add|modify|delete|rename.
// Returns { entries: [{path, docs, disposition}], unmapped: [paths] } where
// disposition for mapped files starts as "review-required" and callers record
// "no impact (reason)" or "updated <doc>" per doc during closeout.
function jsClassifyDocImpact(changedFiles) {
  const entries = [], unmapped = [];
  for (const f of changedFiles) {
    const rel = String(f.path ?? f).replace(/^work\/ai-orchestration\//, "");
    const hit = MAP.find((m) => m.match.test(rel));
    if (hit) entries.push({ path: rel, docs: hit.docs, disposition: "review-required" });
    else unmapped.push(rel);
  }
  return { entries, unmapped };
}

// Serialize the classification for the closeout receipt / hub update.
function jsRenderDocImpactReport(classification) {
  const lines = ["## Source-to-doc impact classification"];
  for (const e of classification.entries) {
    lines.push(`- ${e.path} -> ${e.docs.join(", ")} [${e.disposition}]`);
  }
  if (classification.unmapped.length) {
    lines.push(`- UNMAPPED (unclassified, NOT no-impact — human classification required): ${classification.unmapped.join(", ")}`);
  }
  if (!classification.entries.length && !classification.unmapped.length) lines.push("- (no changed files classified)");
  return lines.join("\n");
}

export function classifyDocImpact(changedFiles) {
  const reference = jsClassifyDocImpact(changedFiles);
  if (!process.env[RUST_EVIDENCE_BIN]) return reference;
  const actual = runNativeDocPolicy("doc-impact-stdin", {changedFiles});
  if (!isDeepStrictEqual(actual,reference)) throw new Error("RUST_DOC_POLICY_REFERENCE_MISMATCH");
  return actual;
}

export function renderDocImpactReport(classification) {
  const reference = jsRenderDocImpactReport(classification);
  if (!process.env[RUST_EVIDENCE_BIN]) return reference;
  const actual = runNativeDocPolicy("doc-render-stdin", {classification});
  if (typeof actual.report !== "string" || actual.report !== reference || Object.keys(actual).length !== 1) {
    throw new Error("RUST_DOC_POLICY_REFERENCE_MISMATCH");
  }
  return actual.report;
}
