// Guards the portable agent + skill bundle: the roster, the skill manifest, the
// orchestration vocabulary, and the absence of private infrastructure, engine and
// entitlement dependencies inside shipped agent and skill text.
//
// Run: node --test tests/portable-agent-bundle.test.mjs
//
// Scope note: the private-reference scan covers the *shipped agent surface*
// (openchamber/agents, openchamber/skills, adapters/claude-code/agents), the
// public policy files (AGENTS.md, openchamber/AGENTS.md), the catalogue
// (docs/AGENTS-SKILLS.md) and the feedback templates (repoql-feedback/). It does
// not scan the whole tree: historical planning documents are a different cleanup,
// and a repo-wide guard here would report pre-existing hits as this bundle's fault.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync, existsSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { AGENT_MAP } from "../adapters/claude-code/agent-map.mjs";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const AGENTS_DIR = join(ROOT, "openchamber", "agents");
const SKILLS_DIR = join(ROOT, "openchamber", "skills");
const ADAPTER_DIR = join(ROOT, "adapters", "claude-code", "agents");
const MODES_FILE = join(ROOT, "orchestration", "modes.mjs");

// --- the contract this bundle is required to satisfy ------------------------

// The nine Windows roles, with the mode each must ship as. Linux also needs
// the optional Ghost profile used by its companion runtime. The two
// pentesting roles are absent on purpose: this repository has no red-team or
// offensive-security agent, and adding one is a product decision, not drift.
const EXPECTED_ROSTER = Object.freeze({
  primary: [
    "duel-coordinator",
    "duo",
    "quad-coordinator",
    "super",
  ],
  subagent: [
    "board",
    "code-reviewer",
    "explore",
    "general",
    "thinker",
  ],
});

// The four coordination-family roles. They are the reason the bundle carries
// orchestration at all, so losing one is a regression even when the count holds.
const ORCHESTRATION_ROLES = Object.freeze([
  "duel-coordinator",
  "duo",
  "quad-coordinator",
  "super",
]);

const EXPECTED_SKILLS = Object.freeze([
  "board",
  "claude-office-visual",
  "consult-dispatch",
  "handoff",
  "hub-doc-update",
  "implementation-review",
  "issue-closeout",
  "mcp-builder",
  "retro",
  "statusline-builder",
]);

// Private shapes that must never ship inside an agent or skill definition.
// Deliberately narrow and high-signal: a broad pattern here would force wording
// contortions in perfectly portable prose. Coordination vocabulary that IS
// allowed (a generic work tracker, a chat channel between agents) is not listed.
const FORBIDDEN_IN_SHIPPED_TEXT = Object.freeze([
  { name: "personal home path", re: /\/home\/[A-Za-z0-9._-]+\/(?:docker|work|projects)\b/ },
  { name: "host-mounted volume", re: /\/mnt\/(?:backups|newdata|hub)\b/ },
  { name: "private host name", re: /\b(?:controller|webserver|proxmox)\b/i },
  { name: "private engine or broker", re: /\b(?:catgpt|openai-sol|ai-orchestra)\b/i },
  { name: "private MCP tool surface", re: /\b(?:fleet_ssh|orchestra_coordinator)\b/ },
  { name: "private broker verb", re: /\bsession-(?:consult|launch|reuse|state)\b/ },
  { name: "model entitlement", re: /\b(?:muse-spark|gpt-6|freebuff|freebucks)\b/i },
  { name: "unqualified ticket id", re: /\b[Ii]ssues?\s+#?\s*\d{2,4}\b/ },
  { name: "unqualified run id", re: /\brun\d{2,4}\b/ },
]);

// --- helpers ---------------------------------------------------------------

function parseFrontmatter(text) {
  const m = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?/.exec(text);
  if (!m) return { fm: {}, body: text, raw: "" };
  const fm = {};
  let key = null;
  for (const line of m[1].split(/\r?\n/)) {
    if (/^\s+\S/.test(line) && key) {
      fm[key] = `${fm[key]} ${line.trim()}`.trim();
      continue;
    }
    const kv = /^([A-Za-z][\w-]*):\s*(.*)$/.exec(line);
    if (kv) {
      key = kv[1];
      fm[key] = kv[2];
    }
  }
  return { fm, body: text.slice(m[0].length), raw: m[0] };
}

const read = (p) => readFileSync(p, "utf8");
const agentFiles = () => readdirSync(AGENTS_DIR).filter((f) => f.endsWith(".md")).sort();
const skillDirs = () => readdirSync(SKILLS_DIR, { withFileTypes: true }).filter((d) => d.isDirectory()).map((d) => d.name).sort();
const agentText = (name) => read(join(AGENTS_DIR, `${name}.md`));
const skillText = (name) => read(join(SKILLS_DIR, name, "SKILL.md"));

function modeNames() {
  const src = read(MODES_FILE);
  const m = /export const MODE_NAMES = Object\.freeze\(\[([^\]]*)\]\)/.exec(src);
  assert.ok(m, "orchestration/modes.mjs must export MODE_NAMES");
  return m[1].split(",").map((s) => s.trim().replace(/^["']|["']$/g, "")).filter(Boolean);
}

// Every file whose text ships as part of this bundle's surface.
function shippedTextFiles() {
  const files = [];
  for (const f of agentFiles()) files.push(join(AGENTS_DIR, f));
  for (const d of skillDirs()) files.push(join(SKILLS_DIR, d, "SKILL.md"));
  for (const f of readdirSync(ADAPTER_DIR).filter((f) => f.endsWith(".md"))) files.push(join(ADAPTER_DIR, f));
  files.push(join(ROOT, "AGENTS.md"), join(ROOT, "openchamber", "AGENTS.md"));
  files.push(join(ROOT, "docs", "AGENTS-SKILLS.md"));
  files.push(join(ROOT, "repoql-feedback", "README.md"), join(ROOT, "repoql-feedback", "TEMPLATE.md"));
  return files.filter(existsSync);
}

// --- roster ----------------------------------------------------------------

test("the shared roster preserves the nine Windows roles and the Linux Ghost profile", () => {
  const expected = [...EXPECTED_ROSTER.primary, ...EXPECTED_ROSTER.subagent].sort();
  assert.equal(expected.length, 9, "the contract itself must name 9 roles");
  assert.deepEqual(agentFiles().map((f) => f.replace(/\.md$/, "")), [...expected, "ghost"].sort());
  assert.equal(parseFrontmatter(agentText("ghost")).fm.mode, "primary");
  assert.equal(Object.hasOwn(AGENT_MAP, "singularity-ghost"), false,
    "the Linux Ghost profile must not reintroduce a Windows Claude Code agent");

  for (const name of EXPECTED_ROSTER.primary) {
    const { fm } = parseFrontmatter(agentText(name));
    assert.equal(fm.mode, "primary", `${name}.md must ship as a primary agent`);
  }
  for (const name of EXPECTED_ROSTER.subagent) {
    const { fm } = parseFrontmatter(agentText(name));
    assert.equal(fm.mode, "subagent", `${name}.md must ship as a subagent`);
  }
});

test("the four coordination roles are all present", () => {
  const shipped = new Set(agentFiles().map((f) => f.replace(/\.md$/, "")));
  assert.equal(ORCHESTRATION_ROLES.length, 4);
  for (const role of ORCHESTRATION_ROLES) assert.ok(shipped.has(role), `coordination role ${role} must ship`);
});

test("no pentesting or offensive-security agent ships", () => {
  const names = agentFiles().map((f) => f.replace(/\.md$/, ""));
  assert.deepEqual(names.filter((n) => /pentest|redam|red-team|exploit/i.test(n)), []);
  for (const f of agentFiles()) {
    const { fm } = parseFrontmatter(read(join(AGENTS_DIR, f)));
    assert.equal(/pentest|redam/i.test(fm.description || ""), false, `${f}: description must not advertise pentesting`);
  }
});

// --- agent definition shape ------------------------------------------------

test("agent frontmatter stays native and free of entitlements", () => {
  for (const file of agentFiles()) {
    const text = read(join(AGENTS_DIR, file));
    const { fm, body } = parseFrontmatter(text);

    assert.match(text, /^---\r?\n/, `${file}: must open with a YAML frontmatter block`);
    assert.ok((fm.description || "").length >= 40, `${file}: needs a real description`);
    assert.ok(["primary", "subagent"].includes(fm.mode), `${file}: mode must be primary or subagent`);

    // A model or variant line is a deployment entitlement, not a role: the roster
    // must run on whatever the installation routes, including free-only.
    assert.equal(fm.model, undefined, `${file}: must not pin a model`);
    assert.equal(fm.variant, undefined, `${file}: must not pin a variant`);

    // Permissions, when declared at all, may only be the full-access wildcard.
    // Anything narrower or oddly shaped is a privilege claim this bundle cannot
    // verify in a foreign installation.
    if (fm.permissions !== undefined) {
      const allowed = /^\s+-\s+action:\s*"\*"\s*\n\s+resource:\s*"\*"\s*\n\s+effect:\s*allow\s*$/m;
      assert.ok(allowed.test(text), `${file}: permissions must be the "*" / "*" / allow wildcard`);
    }

    // A completeness floor, not a target: the tersest shipped contract (`explore`,
    // a read-only agent that answers one question) is ~330 characters. Below this
    // the file has a header and a title but no role in it.
    assert.ok(body.trim().length > 300, `${file}: body must carry the role, not a hollow template`);
  }
});

test("coordinator roles drive the shipped engine and never a private broker", () => {
  const known = modeNames();
  const engineRoles = ["duel-coordinator", "quad-coordinator", "super"];

  for (const role of engineRoles) {
    const text = agentText(role);
    assert.ok(text.includes("scripts/orch-run"), `${role}: must name the shipped engine`);

    // Every `--mode` a definition suggests must be a mode the engine really has,
    // so a definition cannot invent a seat plan.
    for (const m of text.matchAll(/--mode\s+([a-z_]+)/g)) {
      assert.ok(known.includes(m[1]), `${role}: "--mode ${m[1]}" is not in MODE_NAMES (${known.join(", ")})`);
    }
  }

  // The two seat-plan coordinators that must not own the reviewer seat say so.
  for (const role of ["duel-coordinator", "quad-coordinator"]) {
    assert.match(agentText(role), /reviewer seat/i, `${role}: must name the reviewer seat's authority`);
    assert.match(agentText(role), /never implement|do not implement|not the implementation/i, `${role}: must state that it does not implement`);
  }
});

test("consultation is opt-in everywhere it is mentioned", () => {
  // An implicit consult is a spend and a dependency. Each surface that mentions a
  // consultant must gate it on the operator asking or on a configured endpoint.
  assert.match(agentText("super"), /only when the operator asks/i);
  assert.match(skillText("consult-dispatch"), /if no consultant is configured/i);
  assert.match(skillText("consult-dispatch"), /never substitute/i);
});

// --- skills ----------------------------------------------------------------

test("skill manifest is exactly the ten shipped skills", () => {
  assert.equal(EXPECTED_SKILLS.length, 10);
  assert.deepEqual(skillDirs(), [...EXPECTED_SKILLS].sort());
  for (const name of EXPECTED_SKILLS) {
    const file = join(SKILLS_DIR, name, "SKILL.md");
    assert.ok(existsSync(file), `${name}: SKILL.md must exist`);
    const { fm, body } = parseFrontmatter(read(file));
    assert.ok((fm.name || "").length >= 3, `${name}: needs a frontmatter name`);
    assert.ok((fm.description || "").length >= 40, `${name}: needs a description that routes to it`);
    assert.ok(body.trim().length > 500, `${name}: must carry the workflow, not a pointer stub`);
  }
});

test("skills that need an outside component declare it and fail closed", () => {
  for (const name of ["consult-dispatch", "issue-closeout", "statusline-builder"]) {
    const text = skillText(name);
    assert.match(text, /prerequisite/i, `${name}: must state its prerequisite`);
    assert.match(text, /(?:do\s+not|never)\s+invent/i, `${name}: must refuse to invent the missing component`);
  }
});

// --- private references -----------------------------------------------------

test("no private infrastructure, engine or entitlement reference ships in the bundle text", () => {
  const offenders = [];
  for (const file of shippedTextFiles()) {
    const text = read(file);
    for (const { name, re } of FORBIDDEN_IN_SHIPPED_TEXT) {
      const m = re.exec(text);
      if (m) offenders.push(`${file.replace(`${ROOT}/`, "")}: ${name} (${JSON.stringify(m[0])})`);
    }
  }
  assert.deepEqual(offenders, [], `private references found:\n  ${offenders.join("\n  ")}`);
});

test("the private-reference guard does not ban legitimate coordination vocabulary", () => {
  // Positive control: these words are part of ordinary agent coordination and a
  // guard that flags them would push agents back to private phrasing.
  const legitimate = [
    "Kanzo work item work#12",
    "agentchat send general",
    "run the code-reviewer before completion",
    "issue-closeout records the real outcome",
    "scripts/orch-run status",
  ].join("\n");
  for (const { name, re } of FORBIDDEN_IN_SHIPPED_TEXT) {
    assert.equal(re.test(legitimate), false, `guard "${name}" must not match legitimate coordination text`);
  }
});

// --- Claude Code adapter ----------------------------------------------------

test("the Claude Code adapter mirrors the portable roster, each role on its declared surface", () => {
  const adapterFiles = readdirSync(ADAPTER_DIR).filter((f) => f.endsWith(".md")).sort();
  assert.deepEqual(adapterFiles, Object.keys(AGENT_MAP).map((n) => `${n}.md`).sort());

  // Claude Code has no per-definition "main session only" flag: every file under
  // agents/ is also reachable through the Agent tool. The adapter therefore ships
  // primary roles as main-session surfaces and preserves their authority in the
  // body (they refuse session authority when reached as a subagent) rather than
  // pretending the file is unreachable. A subagent role must not pose as a session.
  const names = [];
  for (const [claudeName, entry] of Object.entries(AGENT_MAP)) {
    const source = join(ROOT, entry.sourceDef);
    assert.ok(existsSync(source), `${claudeName} maps to a real definition (${entry.sourceDef})`);
    const { fm: srcFm } = parseFrontmatter(read(source));
    assert.equal(entry.surface, srcFm.mode === "primary" ? "main" : "subagent",
      `${claudeName}: surface must mirror ${entry.sourceDef}'s mode (${srcFm.mode})`);

    const text = read(join(ADAPTER_DIR, `${claudeName}.md`));
    const { fm, body } = parseFrontmatter(text);
    assert.equal(fm.name, claudeName, `${claudeName}: frontmatter name must match the file`);
    assert.ok((fm.description || "").length >= 40, `${claudeName}: needs a routing description`);
    // Omitting tools means "inherit every tool", which is the right declaration for
    // a general worker; an empty tools list would disable the very tool it needs.
    assert.ok(fm.tools === undefined || fm.tools.trim().length > 0, `${claudeName}: tools must be inherited or non-empty`);
    assert.equal(fm.model, undefined, `${claudeName}: must inherit the session's model, not pin one`);
    names.push(fm.name);

    if (entry.surface === "main") {
      assert.ok(body.includes(`claude --agent ${claudeName}`), `${claudeName}: must show the main-session launch`);
      assert.match(body, /as a subagent[\s\S]{0,400}(?:do not hold|do not claim)/i,
        `${claudeName}: must refuse session authority when reached through delegation`);
      assert.equal(entry.memoryAgentId, null, `${claudeName}: a main session has no subagent memory profile`);
    } else {
      assert.equal(body.includes("claude --agent"), false, `${claudeName}: a subagent must not present itself as a session agent`);
      assert.ok(entry.memoryAgentId, `${claudeName}: a delegation target needs its memory identity`);
    }
  }
  assert.equal(new Set(names).size, names.length, "agent names must be unique across the adapter");

  // Every portable role ships except the one documented private-environment mode.
  const shipped = new Set(adapterFiles.map((f) => f.replace(/\.md$/, "")));
  // The Windows product retired these portable roles; they are intentionally not installed.
  const RETIRED = ["free-mode", "ghost", "orchestrator", "solo-coordinator", "standalone", "fleet-reviewer", "quality-fixer", "researcher-web"];
  const missing = [...EXPECTED_ROSTER.primary, ...EXPECTED_ROSTER.subagent].filter((r) => !RETIRED.includes(r) && !shipped.has(`singularity-${r}`));
  assert.deepEqual(missing, [], "every portable role ships in the adapter");
});

// --- public policy ----------------------------------------------------------

test("both public policy files require structured RepoQL feedback", () => {
  const contributor = read(join(ROOT, "AGENTS.md"));
  const runtime = read(join(ROOT, "openchamber", "AGENTS.md"));
  for (const [label, text] of [["AGENTS.md", contributor], ["openchamber/AGENTS.md", runtime]]) {
    assert.ok(text.includes("repoql-feedback"), `${label}: must point at repoql-feedback/`);
    assert.match(text, /RepoQL/i, `${label}: must name RepoQL`);
    assert.match(text, /attribution/i, `${label}: must require attribution, not just a symptom`);
  }
});

test("the feedback template carries every field a maintainer needs", () => {
  const tpl = read(join(ROOT, "repoql-feedback", "TEMPLATE.md"));
  for (const field of ["Version", "Environment", "Exact command", "Expected", "Actual", "Reproduction", "Evidence", "Attribution", "Redaction"]) {
    assert.ok(new RegExp(field, "i").test(tpl), `TEMPLATE.md: missing "${field}"`);
  }
  assert.match(tpl, /no credential|never.*secret value/i, "TEMPLATE.md: must state the no-secrets rule");
});

test("the catalogue documents every agent and every skill", () => {
  const catalogue = read(join(ROOT, "docs", "AGENTS-SKILLS.md"));
  for (const name of [...EXPECTED_ROSTER.primary, ...EXPECTED_ROSTER.subagent]) {
    assert.ok(catalogue.includes(`\`${name}\``), `docs/AGENTS-SKILLS.md: missing agent ${name}`);
  }
  for (const name of EXPECTED_SKILLS) {
    assert.ok(catalogue.includes(`\`${name}\``), `docs/AGENTS-SKILLS.md: missing skill ${name}`);
  }
  assert.match(catalogue, /repoql-feedback/, "docs/AGENTS-SKILLS.md: must carry the feedback duty");
  assert.match(catalogue, /separately installed, licensed component/i, "docs/AGENTS-SKILLS.md: must declare the licensed plugin as external");
});
