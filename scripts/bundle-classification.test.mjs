// Unit tests for the single component-classification table that drives the
// four installation options. Fixtures are minimal and synthetic; the last test
// walks the real shipped tree so a NEW file cannot land without a decision.
import { test } from "node:test";
import assert from "node:assert/strict";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  COMPONENT, VARIANT_COMPONENTS, CREDENTIAL_COMPONENTS, OPT_IN_COMPONENTS,
  classifyBundleFile, variantIncludesComponent, partitionBundleFiles,
  variantFileSet, assertVariantExactSet, assertInstalledSet, excludedForVariant,
  walkShippedFiles, auditComponentSet,
} from "./bundle-classification.mjs";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");

const FIXTURE = [
  "AGENTS.md",
  "scripts/install-claude-code.mjs",
  "openchamber/opencode.jsonc",
  "openchamber/agents/general.md",
  "openchamber/agents/ghost.md",           // ghost
  "openchamber/plugins/runbook-nudge/index.js",
  "openchamber/plugins/product-office/index.js", // office
  "ghost/dream.mjs",                       // ghost
  "ghost/ghost.compose.yml",               // ghost
  "office/office.compose.yml",             // office
  "systemd/ghost-dream.service",           // ghost
  "compose/extraction-failover.compose.yml",
  "templates/product.env.example",
  "dashboard/app.py",                      // dashboard: opt-in adjunct
  "dashboard/static/app.js",
  "harness/kit/orchestrate.mjs",
  "bin/ai-orchestra",
  "connectors/kanzo/connector.json",
];

test("every variant is one explicit component set", () => {
  assert.deepEqual(VARIANT_COMPONENTS[1], [COMPONENT.CORE]);
  assert.deepEqual(VARIANT_COMPONENTS[3], [COMPONENT.CORE]);
  for (const v of [2, 4]) {
    assert.deepEqual(VARIANT_COMPONENTS[v], [COMPONENT.CORE, COMPONENT.GHOST, COMPONENT.OFFICE]);
  }
  assert.equal(variantIncludesComponent("1", COMPONENT.GHOST), false);
  assert.equal(variantIncludesComponent(2, COMPONENT.GHOST), true);
  assert.equal(variantIncludesComponent("4", COMPONENT.OFFICE), true);
  assert.throws(() => variantIncludesComponent("5", COMPONENT.CORE), /unknown installation option/);
});

test("classification is component-explicit and never guesses", () => {
  assert.equal(classifyBundleFile("ghost/dream.mjs").component, COMPONENT.GHOST);
  assert.equal(classifyBundleFile("openchamber/agents/ghost.md").component, COMPONENT.GHOST);
  assert.equal(classifyBundleFile("systemd/ghost-dream.timer").component, COMPONENT.GHOST);
  assert.equal(classifyBundleFile("office/office.compose.yml").component, COMPONENT.OFFICE);
  assert.equal(classifyBundleFile("openchamber/plugins/product-office/office-events.js").component, COMPONENT.OFFICE);
  assert.equal(classifyBundleFile("scripts/orch_chat_office.py").component, COMPONENT.OFFICE);
  assert.equal(classifyBundleFile("openchamber/agents/general.md").component, COMPONENT.CORE);
  assert.equal(classifyBundleFile("openchamber/plugins/runbook-nudge/index.js").component, COMPONENT.CORE);
  // UNKNOWN must be null, never "core": a new directory needs an explicit rule
  assert.equal(classifyBundleFile("vendor/newthing/x.js"), null);
  assert.equal(classifyBundleFile("newdir/feature.mjs"), null);
  assert.equal(classifyBundleFile(""), null);
});

test("partition keeps unclassified files visible", () => {
  const p = partitionBundleFiles([...FIXTURE, "unreviewed/component.mjs"]);
  assert.deepEqual(p.unclassified, ["unreviewed/component.mjs"]);
  assert.ok(p.ghost.length >= 3 && p.office.length >= 2 && p.core.length >= 3);
});

test("option 1 and 3 ship CORE only — exact exclusion of Ghost and Office", () => {
  for (const v of ["1", "3"]) {
    const set = variantFileSet(FIXTURE, v);
    assert.ok(set.includes("openchamber/opencode.jsonc"));
    assert.ok(!set.some((f) => f.startsWith("ghost/") || f.startsWith("office/")), `option ${v} must ship no ghost/office file`);
    assert.ok(!set.includes("openchamber/agents/ghost.md"), `option ${v} must not ship the ghost agent`);
    assert.ok(!set.some((f) => f.includes("product-office")), `option ${v} must not ship the office plugin`);
    const excluded = excludedForVariant(FIXTURE, v);
    assert.ok(excluded.includes("ghost/dream.mjs") && excluded.includes("office/office.compose.yml"));
  }
});

test("native Ghost scheduler source is complete-only and never falls through to core", () => {
  const files = [
    "native/windows/ghost_scheduler_host.py",
    "native/windows/ghost_task_scheduler.ps1",
    "native/windows/manage_ghost_scheduler.ps1",
    "native/windows/test_ghost_scheduler_host.py",
  ];
  for (const path of files) assert.equal(classifyBundleFile(path).component, COMPONENT.GHOST, path);
  for (const variant of ["1", "3"]) {
    const set = variantFileSet([...FIXTURE, ...files], variant);
    assert.ok(files.every((path) => !set.includes(path)), `option ${variant} must exclude native Ghost scheduler files`);
  }
  for (const variant of ["2", "4"]) {
    const set = variantFileSet([...FIXTURE, ...files], variant);
    assert.ok(files.every((path) => set.includes(path)), `option ${variant} must include native Ghost scheduler files`);
  }
});

test("option 2 and 4 ship CORE + Ghost + Office — exact inclusion", () => {
  for (const v of ["2", "4"]) {
    const set = variantFileSet(FIXTURE, v);
    for (const must of ["ghost/dream.mjs", "office/office.compose.yml", "openchamber/agents/ghost.md",
      "openchamber/plugins/product-office/index.js", "systemd/ghost-dream.service"]) {
      assert.ok(set.includes(must), `option ${v} must ship ${must}`);
    }
    const excludedHere = excludedForVariant(FIXTURE, v);
    assert.deepEqual(excludedHere.filter((f) => !f.startsWith("dashboard/")), [], `option ${v} installs everything except the opt-in dashboard`);
    assert.deepEqual(excludedHere.filter((f) => f.startsWith("dashboard/")).length, 2, "the dashboard stays opt-in");
  }
});

test("assertVariantExactSet validates the SET; assertInstalledSet validates a leak", () => {
  const ok1 = assertVariantExactSet(FIXTURE, "1");
  assert.equal(ok1.ok, true, ok1.problems.join("; "));
  assert.ok(!ok1.included.some((f) => f.startsWith("ghost/")), "the computed option-1 set excludes ghost files");

  // a Ghost file ACTUALLY INSTALLED for a core-only option is a hard problem
  const leaked = assertInstalledSet(["AGENTS.md", "scripts/x.mjs", "openchamber/agents/ghost.md"], "3");
  assert.equal(leaked.ok, false);
  assert.deepEqual(leaked.leaked, ["openchamber/agents/ghost.md"]);
  assert.match(leaked.problems.join(" "), /must not install ghost files/);

  // an unclassified file blocks rather than silently shipping
  const unknown = assertVariantExactSet(["AGENTS.md", "scripts/x.mjs", "vendor/x.js"], "1");
  assert.equal(unknown.ok, false);
  assert.match(unknown.problems.join(" "), /unclassified shipped file/);

  // option 2 with no ghost files at all is incomplete, not a pass
  const empty = assertVariantExactSet(["AGENTS.md", "scripts/x.mjs"], "2");
  assert.equal(empty.ok, false);
  assert.match(empty.problems.join(" "), /must ship ghost files/);
  assert.equal(assertInstalledSet(["AGENTS.md", "scripts/x.mjs"], "2").ok, false);
  assert.equal(assertInstalledSet(FIXTURE.filter((f) => !f.startsWith("dashboard/")), "2").ok, true);
});

test("the dashboard is shipped but installed by no option (opt-in adjunct)", () => {
  assert.equal(classifyBundleFile("dashboard/app.py").component, COMPONENT.DASHBOARD);
  assert.deepEqual(OPT_IN_COMPONENTS, [COMPONENT.DASHBOARD]);
  for (const v of ["1", "2", "3", "4"]) {
    const set = variantFileSet(FIXTURE, v);
    assert.ok(!set.some((f) => f.startsWith("dashboard/")), `option ${v} must not install the dashboard`);
  }
  // an installed dashboard file for a core-only option is a hard leak
  const leak = assertInstalledSet(["AGENTS.md", "scripts/x.mjs", "dashboard/app.py"], "1");
  assert.equal(leak.ok, false);
  assert.deepEqual(leak.leaked, ["dashboard/app.py"]);
  // the package still classifies it: no unclassified file
  const parts = partitionBundleFiles(FIXTURE);
  assert.ok(parts.dashboard.length >= 2);
});

test("credentials follow the same table (ghost/office only for 2 and 4)", () => {
  assert.equal(CREDENTIAL_COMPONENTS["ghost.json"], COMPONENT.GHOST);
  assert.equal(CREDENTIAL_COMPONENTS["office.json"], COMPONENT.OFFICE);
  const v3 = auditCredentialNames("3");
  const v4 = auditCredentialNames("4");
  assert.deepEqual(v3, ["memory.json", "selflearn.json"]);
  assert.ok(v4.includes("ghost.json") && v4.includes("office.json"));
});

function auditCredentialNames(variant) {
  return Object.entries(CREDENTIAL_COMPONENTS)
    .filter(([, c]) => VARIANT_COMPONENTS[variant].includes(c))
    .map(([n]) => n);
}

test("the real shipped tree is fully classified (no silent new file)", () => {
  const files = walkShippedFiles(ROOT);
  assert.ok(files.length > 100, `the walk must see the shipped tree (saw ${files.length})`);
  assert.ok(!files.some((path) => path.split("/").includes("target")), "Cargo build outputs are never source package files");
  const parts = partitionBundleFiles(files);
  assert.deepEqual(parts.unclassified, [], "every shipped file needs an explicit component");
  assert.ok(parts.ghost.length > 0 && parts.office.length > 0, "the real tree carries Ghost and Office payload");
  const one = auditComponentSet(ROOT, "1");
  assert.equal(one.ok, true, one.problems.join("; "));
  assert.ok(!one.installedFiles.some((f) => f.startsWith("ghost/")), "option 1 installs no ghost file");
  assert.ok(!one.installedFiles.some((f) => f.startsWith("office/")), "option 1 installs no office file");
  const four = auditComponentSet(ROOT, "4");
  assert.equal(four.ok, true, four.problems.join("; "));
  assert.ok(four.installedFiles.some((f) => f.startsWith("ghost/")));
  assert.ok(four.credentials.some((c) => c.name === "ghost.json"));
});
