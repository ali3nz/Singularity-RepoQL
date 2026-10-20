// Unit tests for the Claude Code agent roster and identity map — static checks
// of the shipped definitions. Run: node --test adapters/claude-code/integration.test.mjs
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync, existsSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { AGENT_MAP, resolveSingularityAgent } from "./agent-map.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const AGENT_FILES = readdirSync(join(HERE, "agents")).filter((f) => f.endsWith(".md")).sort();

function parseFrontmatter(text) {
  const m = /^---\r?\n([\s\S]*?)\r?\n---/.exec(text);
  if (!m) return {};
  const fm = {};
  let key = null;
  for (const line of m[1].split(/\r?\n/)) {
    if (/^\s/.test(line) && key) { fm[key] += " " + line.trim(); continue; }
    const match = /^(\w[\w-]*):\s*(.*)$/.exec(line);
    if (match) { key = match[1]; fm[key] = match[2]; }
  }
  return fm;
}

test("every mapped agent has a definition file, and every file is mapped", () => {
  assert.deepEqual(AGENT_FILES, Object.keys(AGENT_MAP).map((n) => `${n}.md`).sort());
});

test("definitions use valid Claude Code frontmatter: namespaced name, description, known tools", () => {
  const VALID_TOOLS = new Set(["Read", "Grep", "Glob", "Bash", "Edit", "Write", "WebSearch", "WebFetch"]);
  for (const file of AGENT_FILES) {
    const text = readFileSync(join(HERE, "agents", file), "utf8");
    const fm = parseFrontmatter(text);
    assert.equal(fm.name, file.replace(/\.md$/, ""), `${file}: name frontmatter`);
    assert.match(fm.name, /^singularity-/, `${file}: namespaced name`);
    assert.ok((fm.description || "").length > 20, `${file}: description present`);
    assert.equal(fm.mode, undefined, `${file}: no OpenChamber 'mode' field leaked`);
    assert.equal(fm.permissions, undefined, `${file}: no OpenChamber 'permissions' field leaked`);
    assert.equal(fm.model, undefined, `${file}: model inherits the session (not pinned)`);
    if (fm.tools) {
      for (const t of fm.tools.split(",").map((s) => s.trim())) assert.ok(VALID_TOOLS.has(t), `${file}: tool ${t} valid`);
    }
    assert.ok(text.length > 300, `${file}: body present`);
  }
});

test("read/write boundaries are preserved per agent", () => {
  const toolsFor = (file) => parseFrontmatter(readFileSync(join(HERE, "agents", file), "utf8")).tools || "";
  // reviewer: read-only during the review (no Edit/Write)
  assert.equal(/Edit|Write/.test(toolsFor("singularity-code-reviewer.md")), false);
  // quality-fixer: file-scoped fixer, no shell at all
  assert.equal(/Bash/.test(toolsFor("singularity-quality-fixer.md")), false);
  assert.ok(law(readFileSync(join(HERE, "agents", "singularity-quality-fixer.md")), "ONLY inside your current working directory"));
  // explorer and researcher are read-only
  for (const f of ["singularity-explore.md", "singularity-researcher-web.md"]) {
    assert.equal(/Edit|Write|Bash/.test(toolsFor(f)), false, f);
  }
});

function law(text, phrase) { return text.includes(phrase); }

test("approval semantics survive conversion (code-reviewer: BLOCKING/NON-BLOCKING/APPROVE)", () => {
  const text = readFileSync(join(HERE, "agents", "singularity-code-reviewer.md"), "utf8");
  for (const phrase of ["BLOCKING", "NON-BLOCKING", "APPROVE"]) assert.ok(text.includes(phrase), phrase);
});

test("board keeps the eight seats and the ruling output blocks", () => {
  const text = readFileSync(join(HERE, "agents", "singularity-board.md"), "utf8");
  for (const seat of ["Financial Officer", "Tax Strategist", "Attorney", "Corporate Strategist", "Investment Advisor", "Real Estate Advisor", "Estate Planner", "Insurance & Risk Advisor"]) {
    assert.ok(text.includes(seat), seat);
  }
  for (const block of ["RULING", "PANEL POSITIONS", "DISSENTS", "ACTIONS"]) assert.ok(text.includes(block), block);
});

test("quality-fixer keeps its staged-file JSON reply contract", () => {
  const text = readFileSync(join(HERE, "agents", "singularity-quality-fixer.md"), "utf8");
  assert.ok(text.includes("REQUEST.md"));
  assert.ok(text.includes("JSON"));
});

test("identity map: every claude name maps to the role's MemoryCore identity (no duplicates, no ghost)", () => {
  const memoryIds = Object.values(AGENT_MAP).map((e) => e.memoryAgentId);
  assert.equal(new Set(memoryIds).size, memoryIds.length, "no two claude agents share one memory identity");
  for (const [claudeName, entry] of Object.entries(AGENT_MAP)) {
    assert.ok(existsSync(join(HERE, "../..", entry.sourceDef)), `${claudeName} maps to the real OpenChamber definition ${entry.sourceDef}`);
  }
  assert.equal(memoryIds.includes("ghost"), false, "Ghost keeps its own ghost-companion profile — never a second identity");
  const openchamberNames = readdirSync(join(HERE, "../../openchamber/agents")).map((f) => f.replace(/\.md$/, ""));
  for (const id of memoryIds) assert.ok(openchamberNames.includes(id), `memoryAgentId ${id} matches the OpenChamber roster`);
});

test("resolveSingularityAgent accepts only singularity-* names", () => {
  assert.equal(resolveSingularityAgent("singularity-thinker")?.memoryAgentId, "thinker");
  assert.equal(resolveSingularityAgent("Explore"), null, "built-in subagents are never captured/recalled");
  assert.equal(resolveSingularityAgent("general-purpose"), null);
  assert.equal(resolveSingularityAgent(undefined), null);
});

test("standalone is not shipped as a subagent (its guidance belongs to the main-agent config)", () => {
  assert.ok(!AGENT_FILES.includes("singularity-standalone.md"));
});
