// lib/memory-impact.mjs — V3.4.0 Phase 11 (plan §13). Maps changed scope to
// potentially related durable knowledge (MEX entities + past lessons) so
// REVIEW can check staleness before verdict. Deterministic matching only —
// it surfaces candidates for human/review judgment, never rewrites knowledge.
import { readFileSync, existsSync, readdirSync } from "node:fs";
import { join } from "node:path";

// tokens from a changed file path + optional subsystem hint
function scopeTokens(changedFiles = [], subsystemHint = null) {
  const toks = new Set();
  for (const f of changedFiles) {
    const base = String(f ?? "").split("/").filter(Boolean);
    for (const part of base) {
      const t = part.replace(/\.[a-z]+$/i, "").toLowerCase();
      if (t.length >= 4 && !["index", "test", "tests", "node_modules", "lib", "src"].includes(t)) toks.add(t);
    }
  }
  if (subsystemHint) String(subsystemHint).toLowerCase().split(/[^a-z0-9]+/).filter((t) => t.length >= 4).forEach((t) => toks.add(t));
  return [...toks];
}

// Enumerate knowledge-surface markdown files — read-only.
// Ticket 164 Phase 4 (plan §11): the knowledge walk now covers the CANONICAL
// memory surfaces (hub docs + journal) instead of only the legacy .mex tree.
// Kept name + signature for backward compatibility; the caller in
// orchestrate.mjs passes the hub documentation root.
export function mexKnowledgeFiles(mexDir) {
  const out = [];
  const walk = (dir, depth) => {
    if (depth > 4) return;
    let ents = [];
    try { ents = readdirSync(dir, { withFileTypes: true }); } catch { return; }
    for (const e of ents) {
      const p = join(dir, e.name);
      if (e.isDirectory()) walk(p, depth + 1);
      else if (e.name.endsWith(".md") || e.name.endsWith(".jsonl")) out.push(p);
    }
  };
  walk(mexDir, 0);
  return out;
}

// Score each knowledge file against the changed scope. Returns ranked
// candidates with the matched tokens as evidence (deterministic, auditable).
export function computeMemoryImpact({ changedFiles = [], subsystemHint = null, mexDir = null, knowledgeFiles = null, minScore = 1 }) {
  const toks = scopeTokens(changedFiles, subsystemHint);
  if (!toks.length) return { tokens: [], impacted: [] };
  const files = knowledgeFiles ?? (mexDir ? mexKnowledgeFiles(mexDir) : []);
  const impacted = [];
  for (const f of files) {
    let text = "";
    try { text = existsSync(f) ? readFileSync(f, "utf8") : ""; } catch { continue; }
    const hay = (f + " " + text).toLowerCase();
    const matched = toks.filter((t) => hay.includes(t));
    const score = matched.length;
    if (score >= minScore) {
      impacted.push({ file: f, score, matchedTokens: matched.slice(0, 8), staleRisk: score >= 3 ? "high" : (score === 2 ? "medium" : "low") });
    }
  }
  impacted.sort((a, b) => b.score - a.score || a.file.localeCompare(b.file));
  return { tokens: toks, impacted: impacted.slice(0, 12) };
}

// Review-facing summary block (goes into the REVIEW payload when non-empty).
export function memoryImpactBlock(impact) {
  if (!impact?.impacted?.length) return "";
  const lines = impact.impacted.slice(0, 6).map((i) => `- ${i.file} (score ${i.score}, ${i.staleRisk} staleness risk; matched: ${i.matchedTokens.join(", ")})`);
  return `MEMORY IMPACT — durable knowledge possibly affected by this change; verify staleness before verdict:\n${lines.join("\n")}`;
}
