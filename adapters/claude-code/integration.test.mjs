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
const read = (name) => readFileSync(join(HERE, "agents", `${name}.md`), "utf8");

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
  const VALID_TOOLS = new Set(["Read", "Grep", "Glob", "Bash", "Edit", "Write", "WebSearch", "WebFetch", "Agent"]);
  for (const file of AGENT_FILES) {
    const text = readFileSync(join(HERE, "agents", file), "utf8");
    const fm = parseFrontmatter(text);
    assert.equal(fm.name, file.replace(/\.md$/, ""), `${file}: name frontmatter`);
    assert.match(fm.name, /^singularity-/, `${file}: namespaced name`);
    assert.ok((fm.description || "").length > 20, `${file}: description present`);
    assert.equal(fm.mode, undefined, `${file}: no OpenChamber 'mode' field leaked`);
    assert.equal(fm.permissions, undefined, `${file}: no OpenChamber 'permissions' field leaked`);
    // Only the code reviewer is pinned (operator decision: haiku, high effort).
    const pinned = file === "singularity-code-reviewer.md" ? "haiku" : undefined;
    assert.equal(fm.model, pinned, `${file}: model pinning`);
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
  // explorer is read-only
  for (const f of ["singularity-explore.md"]) {
    assert.equal(/Edit|Write|Bash/.test(toolsFor(f)), false, f);
  }
  // non-implementing main surfaces cannot write files through their own tools
  for (const name of ["singularity-duel-coordinator", "singularity-quad-coordinator"]) {
    assert.equal(/Edit|Write/.test(toolsFor(`${name}.md`)), false, `${name}: coordinator may not write`);
    assert.match(toolsFor(`${name}.md`), /Agent/, `${name}: must be able to dispatch`);
  }
  // full-surface roles can implement directly and can delegate
  for (const name of ["singularity-super", "singularity-duo"]) {
    assert.match(toolsFor(`${name}.md`), /Edit, Write/, `${name}: full execution surface`);
    assert.match(toolsFor(`${name}.md`), /Agent/, `${name}: delegation available`);
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

test("identity map: every delegation target maps to one unique MemoryCore identity; main surfaces map to none", () => {
  const ids = Object.values(AGENT_MAP).map((e) => e.memoryAgentId).filter((x) => x !== null);
  assert.equal(new Set(ids).size, ids.length, "no two claude agents share one memory identity");
  for (const [claudeName, entry] of Object.entries(AGENT_MAP)) {
    assert.equal(entry.sourceDef, `adapters/claude-code/agents/${claudeName}.md`);
    assert.ok(existsSync(join(HERE, "..", "..", entry.sourceDef)), `${claudeName} maps to a shipped definition`);
    assert.ok(["subagent", "main"].includes(entry.surface), `${claudeName}: known surface`);
    if (entry.surface === "main") assert.equal(entry.memoryAgentId, null, `${claudeName}: main surfaces have no duplicate identity`);
    else assert.equal(entry.memoryAgentId, claudeName.slice("singularity-".length), `${claudeName}: delegated identity`);
  }
  assert.equal(ids.includes("ghost"), false, "Ghost keeps its own ghost-companion profile — never a second identity");
});

test("resolveSingularityAgent accepts only delegation targets with a singularity-* name", () => {
  assert.equal(resolveSingularityAgent("singularity-thinker")?.memoryAgentId, "thinker");
  assert.equal(resolveSingularityAgent("singularity-fleet-reviewer"), null);
  assert.equal(resolveSingularityAgent("singularity-quality-fixer"), null);
  assert.equal(resolveSingularityAgent("singularity-super"), null, "main-session surfaces have no subagent identity");
  assert.equal(resolveSingularityAgent("singularity-ghost"), null);
  assert.equal(resolveSingularityAgent("Explore"), null, "built-in subagents are never captured/recalled");
  assert.equal(resolveSingularityAgent("general-purpose"), null);
  assert.equal(resolveSingularityAgent(undefined), null);
});

test("retained Claude Code definitions have the expected main and delegated surfaces", () => {
  const roles = (surface) => Object.entries(AGENT_MAP)
    .filter(([, entry]) => entry.surface === surface)
    .map(([name]) => name.slice("singularity-".length))
    .sort();
  const RETIRED = Object.freeze(["quality-fixer", "fleet-reviewer", "researcher-web", "orchestrator", "solo-coordinator", "standalone", "free-mode", "ghost"]);
  for (const retired of RETIRED) {
    assert.equal(Object.keys(AGENT_MAP).includes(`singularity-${retired}`), false, `${retired} is retired`);
    assert.equal(AGENT_FILES.includes(`singularity-${retired}.md`), false, `${retired} definition is not shipped`);
  }
  assert.deepEqual(roles("subagent"), ["board", "code-reviewer", "explore", "general", "thinker"]);
  assert.deepEqual(roles("main"), ["duel-coordinator", "duo", "quad-coordinator", "super"]);
});

test("every main-surface definition states its launch form and refuses delegated authority", () => {
  for (const [claudeName, entry] of Object.entries(AGENT_MAP)) {
    if (entry.surface !== "main") continue;
    const text = read(claudeName);
    assert.ok(text.includes(`claude --agent ${claudeName}`), `${claudeName}: launch form documented`);
    assert.match(text, /do not (?:hold|claim)/i, `${claudeName}: delegated instance must refuse session authority`);
  }
});

test("super ships as a main-session surface, not as a delegation twin", () => {
  assert.equal(AGENT_MAP["singularity-super"]?.surface, "main");
  assert.equal(AGENT_MAP["singularity-super"]?.memoryAgentId, null);
  assert.ok(AGENT_FILES.includes("singularity-super.md"));
});

test("roster scope: nine retained Claude Code roles only", () => {
  assert.equal(Object.keys(AGENT_MAP).length, 9);
  assert.equal(AGENT_FILES.length, 9);
  for (const name of [...AGENT_FILES, ...Object.keys(AGENT_MAP)]) {
    assert.doesNotMatch(name, /pentest|redamon/i, `${name}: pentest roles are out of scope`);
  }
  for (const file of AGENT_FILES) {
    assert.doesNotMatch(readFileSync(join(HERE, "agents", file), "utf8"), /pentest|redamon/i, `${file}: no pentest references`);
  }
});
