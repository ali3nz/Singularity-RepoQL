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
export function classifyDocImpact(changedFiles) {
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
export function renderDocImpactReport(classification) {
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
