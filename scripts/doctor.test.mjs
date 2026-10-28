// Regression tests for scripts/doctor.mjs (§11):
//   - an uninstalled host never exits 0 and never claims VERIFIED;
//   - every section is reusable-shipped-checks only (no parallel state);
//   - a verified install record flips installation/capture-hooks to VERIFIED;
//   - statuses match the §11 vocabulary and never leak key material.
// Run: node --test scripts/doctor.test.mjs
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { doctor, renderHuman, captureWriterCheck, readAttachRecord } from "./doctor.mjs";

const ROOT = resolve(import.meta.dirname, "..");
const ABSENT = { SINGULARITY_MEMORY_CONFIG: "/nonexistent/memory.json", SINGULARITY_CLAUDE_CODE_STATE: "/nonexistent/state.json", SINGULARITY_ATTACH_BACKUPS: "/nonexistent/attach-backups" };

test("an empty host reports NOT_CONFIGURED, never a fake pass, and never exits 0", async () => {
  const sections = await doctor({ env: { ...process.env, ...ABSENT } });
  const byName = Object.fromEntries(sections.map((s) => [s.name, s]));
  assert.equal(byName.installation.state, "NOT_CONFIGURED");
  assert.match(byName.installation.detail, /no install record/);
  assert.ok(!sections.some((s) => s.state === "VERIFIED" && s.name === "memorycore"));
  // the human renderer exposes all section names and no key-shaped material
  const text = renderHuman(sections);
  assert.ok(!/sk-[A-Za-z0-9]{6,}/.test(text));
  assert.match(text, /RESULT: INCOMPLETE/);
});

test("a verified install record with existing hook paths reads as VERIFIED wiring", async () => {
  const dir = mkdtempSync(join(tmpdir(), "doctor-state-"));
  try {
    const stateFile = join(dir, "state.json");
    const hookPath = join(ROOT, "adapters/claude-code/memory-hook.mjs");
    assert.ok(existsSync(hookPath), "the real hook script must exist for this fixture");
    writeFileSync(stateFile, JSON.stringify({
      version: 1,
      installs: [{
        installedAt: new Date().toISOString(), scope: "user", settingsPath: join(dir, "settings.json"),
        hooksScript: hookPath, docHooksScript: join(ROOT, "adapters/claude-code/doc-hook.mjs"),
        variant: { id: "1", name: "Claude Code + Tencent MemoryCore", verified: true },
      }],
    }), "utf8");
    const sections = await doctor({ env: { ...process.env, ...ABSENT, SINGULARITY_CLAUDE_CODE_STATE: stateFile } });
    const byName = Object.fromEntries(sections.map((s) => [s.name, s]));
    assert.equal(byName.installation.state, "VERIFIED");
    assert.equal(byName.installation.option, "1");
    assert.equal(byName["capture-hooks"].state, "VERIFIED");
    assert.equal(byName.ghost, undefined, "option 1 ships neither Ghost nor Office — no phantom sections");
    assert.equal(byName["claude-office"], undefined);
    // no key material anywhere in the output
    assert.ok(!/sk-[A-Za-z0-9]{6,}/.test(JSON.stringify(sections)));
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("a two-provider router is CONFIGURED at most, VERIFIED only with a real completion (§6)", async () => {
  const health = { status: "ok", ladder: ["A", "B"], attempts: 3, failovers: 1 };
  let completions = 0;
  const fetchImpl = async (url, opts = {}) => {
    const u = String(url);
    if (u.endsWith("/health")) return { ok: true, json: async () => health };
    if (u.includes("/v3/meta/auth/verify")) return { ok: true, json: async () => ({ data: { valid: true } }) };
    if (u.includes("/chat/completions")) {
      completions += 1;
      return { ok: true, json: async () => ({ choices: [{ message: { content: "pong" } }] }) };
    }
    throw new Error(`unexpected fetch ${u}`);
  };
  const sections = await doctor({ env: { ...process.env, ...ABSENT }, fetchImpl });
  const router = sections.find((s) => s.name === "extraction-router");
  assert.equal(router.state, "VERIFIED", "a real completion through the router is the VERIFIED evidence");
  assert.match(router.detail, /round-tripped/);
  assert.equal(completions, 1, "exactly ONE bounded real completion is issued");

  // Without the completion route the router stays CONFIGURED — never VERIFIED.
  const fetchNoCompletion = async (url) => String(url).includes("/chat/completions")
    ? { ok: false, status: 503, json: async () => ({}) }
    : (String(url).endsWith("/health") ? { ok: true, json: async () => health } : { ok: true, json: async () => ({ data: { valid: true } }) });
  const s2 = await doctor({ env: { ...process.env, ...ABSENT }, fetchImpl: fetchNoCompletion });
  assert.equal(s2.find((s) => s.name === "extraction-router").state, "CONFIGURED");
});

test("a missing router on an INSTALLED host is INCOMPLETE (mandatory), NOT_CONFIGURED only uninstalled", async () => {
  const deadFetch = async () => { throw new Error("refused"); };
  const absent = await doctor({ env: { ...process.env, ...ABSENT }, fetchImpl: deadFetch });
  assert.equal(absent.find((s) => s.name === "extraction-router").state, "NOT_CONFIGURED");
  const dir = mkdtempSync(join(tmpdir(), "doctor-state-"));
  try {
    const stateFile = join(dir, "state.json");
    writeFileSync(stateFile, JSON.stringify({ version: 1, installs: [{
      installedAt: new Date().toISOString(), scope: "user", settingsPath: join(dir, "settings.json"),
      hooksScript: join(ROOT, "adapters/claude-code/memory-hook.mjs"), variant: { id: "1", name: "opt1", verified: true },
    }] }), "utf8");
    const installed = await doctor({ env: { ...process.env, ...ABSENT, SINGULARITY_CLAUDE_CODE_STATE: stateFile }, fetchImpl: deadFetch });
    assert.equal(installed.find((s) => s.name === "extraction-router").state, "INCOMPLETE");
    assert.match(installed.find((s) => s.name === "extraction-router").detail, /MANDATORY/);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("option 4 Ghost/Office rows never claim VERIFIED from configuration existence (§6)", async () => {
  const dir = mkdtempSync(join(tmpdir(), "doctor-office-"));
  try {
    const stateFile = join(dir, "state.json");
    writeFileSync(stateFile, JSON.stringify({ version: 1, installs: [{
      installedAt: new Date().toISOString(), scope: "user", settingsPath: join(dir, "settings.json"),
      hooksScript: join(ROOT, "adapters/claude-code/memory-hook.mjs"), variant: { id: "4", name: "opt4", verified: true },
    }] }), "utf8");
    const officeCfg = join(dir, "office.json");
    writeFileSync(officeCfg, JSON.stringify({ endpoint: "http://127.0.0.1:9/api/v1/events", ingestKey: "x" }), "utf8");
    // Ghost config exists but must NOT read as VERIFIED from existence alone.
    writeFileSync(join(dir, "ghost.json"), "{}", "utf8");
    const sections = await doctor({ env: {
      ...process.env, ...ABSENT, SINGULARITY_CLAUDE_CODE_STATE: stateFile,
      GHOST_MEMORY_CONFIG: join(dir, "ghost.json"), SINGULARITY_OFFICE_CONFIG: officeCfg,
    } });
    const ghost = sections.find((s) => s.name === "ghost");
    assert.ok(ghost, "option 4 ships Ghost");
    assert.notEqual(ghost.state, "VERIFIED", "ghost.json existence is not functional evidence");
    const office = sections.find((s) => s.name === "claude-office");
    assert.notEqual(office.state, "VERIFIED", "an unreachable Office must not read VERIFIED");
    assert.match(office.detail, /NOT consumed|not reachable|rejected/i);
    assert.ok(!/sk-[A-Za-z0-9]{6,}/.test(JSON.stringify(sections)));
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

// ── required wiring per option (classification-driven, INCOMPLETE when missing) ─

import { MANAGED_BEGIN, MANAGED_END, mergeJsoncIntegration } from "./attach-openchamber.mjs";

function wiringFixture(variant) {
  const dir = mkdtempSync(join(tmpdir(), "doctor-wiring-"));
  const stateFile = join(dir, "state.json");
  writeFileSync(stateFile, JSON.stringify({ version: 1, installs: [{
    installedAt: new Date().toISOString(), scope: "user", settingsPath: join(dir, "settings.json"),
    hooksScript: join(ROOT, "adapters/claude-code/memory-hook.mjs"), variant: { id: variant, name: `opt${variant}`, verified: true },
  }] }), "utf8");
  const cfgDir = join(dir, "cfg");
  mkdirSync(join(cfgDir, "product-secrets"), { recursive: true });
  writeFileSync(join(cfgDir, "AGENTS.md"), "# the user's instructions\n");
  writeFileSync(join(cfgDir, "opencode.jsonc"), '{\n  // user comment\n  "mcp": { "repoql": { "type": "local", "command": ["/custom/rql", "mcp"] } }\n}\n');
  return { dir, stateFile, cfgDir };
}

test("wiring is INCOMPLETE until the managed block and integration keys are present", async () => {
  const { dir, stateFile, cfgDir } = wiringFixture("1");
  try {
    const env = { ...process.env, ...ABSENT, SINGULARITY_CLAUDE_CODE_STATE: stateFile, SINGULARITY_OPENCHAMBER_CONFIG_DIR: cfgDir };
    const before = await doctor({ env });
    const w1 = before.find((s) => s.name === "wiring");
    assert.equal(w1.state, "INCOMPLETE");
    assert.match(w1.detail, /agents-managed-policy/);
    assert.match(w1.detail, /jsonc-integration/);

    // bring the wiring up to what the attach writes
    writeFileSync(join(cfgDir, "AGENTS.md"), `# the user's instructions\n\n${MANAGED_BEGIN}\npolicy\n${MANAGED_END}`);
    const merged = mergeJsoncIntegration(readFileSync(join(cfgDir, "opencode.jsonc"), "utf8"), { plugin: ["pkg@1"] });
    assert.equal(merged.ok, true);
    writeFileSync(join(cfgDir, "opencode.jsonc"), merged.text);
    writeFileSync(join(cfgDir, "product-secrets", "memory.json"), "{}\n");
    writeFileSync(join(cfgDir, "product-secrets", "selflearn.json"), "{}\n");
    const after = await doctor({ env });
    assert.equal(after.find((s) => s.name === "wiring").state, "VERIFIED");
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("option 1 wiring rejects Ghost/Office credentials (no leak), option 4 requires them", async () => {
  const { dir, stateFile, cfgDir } = wiringFixture("1");
  try {
    writeFileSync(join(cfgDir, "product-secrets", "memory.json"), "{}\n");
    writeFileSync(join(cfgDir, "product-secrets", "selflearn.json"), "{}\n");
    writeFileSync(join(cfgDir, "product-secrets", "ghost.json"), "{}\n");
    const env = { ...process.env, ...ABSENT, SINGULARITY_CLAUDE_CODE_STATE: stateFile, SINGULARITY_OPENCHAMBER_CONFIG_DIR: cfgDir };
    const w1 = (await doctor({ env })).find((s) => s.name === "wiring");
    assert.equal(w1.state, "INCOMPLETE", "a Ghost credential on option 1 is a leak");
    assert.match(w1.detail, /credential-exclusion:ghost\.json/);

    // option 4 requires the Ghost and Office credentials the same table names
    const s4 = join(dir, "state4.json");
    writeFileSync(s4, JSON.stringify({ version: 1, installs: [{
      installedAt: new Date().toISOString(), scope: "user", settingsPath: join(dir, "settings.json"),
      hooksScript: join(ROOT, "adapters/claude-code/memory-hook.mjs"), variant: { id: "4", name: "opt4", verified: true },
    }] }), "utf8");
    const env4 = { ...env, SINGULARITY_CLAUDE_CODE_STATE: s4 };
    const w4 = (await doctor({ env: env4 })).find((s) => s.name === "wiring");
    assert.equal(w4.state, "INCOMPLETE");
    assert.match(w4.detail, /credential:office\.json/, "Office is mandatory for option 4");
    // complete the option-4 wiring: block + integration keys + office credential
    writeFileSync(join(cfgDir, "AGENTS.md"), `# the user's instructions\n\n${MANAGED_BEGIN}\npolicy\n${MANAGED_END}`);
    const merged4 = mergeJsoncIntegration(readFileSync(join(cfgDir, "opencode.jsonc"), "utf8"), { plugin: ["pkg@1"] });
    writeFileSync(join(cfgDir, "opencode.jsonc"), merged4.text);
    writeFileSync(join(cfgDir, "product-secrets", "office.json"), "{}\n");
    assert.equal((await doctor({ env: env4 })).find((s) => s.name === "wiring").state, "VERIFIED");
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("doctor has no dashboard row for any option (nothing ships one yet)", async () => {
  for (const v of ["1", "2", "3", "4"]) {
    const { dir, stateFile } = wiringFixture(v);
    try {
      const sections = await doctor({ env: { ...process.env, ...ABSENT, SINGULARITY_CLAUDE_CODE_STATE: stateFile } });
      assert.equal(sections.some((s) => /dashboard/i.test(s.name)), false, `option ${v} must not claim a dashboard`);
    } finally { rmSync(dir, { recursive: true, force: true }); }
  }
});

// ── capture single owner (issue 7): exactly one automatic writer ────────────

test("exactly one automatic capture writer; two are refused as INCOMPLETE", () => {
  const dir = mkdtempSync(join(tmpdir(), "doctor-capture-"));
  try {
    mkdirSync(join(dir, "systemd"), { recursive: true });
    writeFileSync(join(dir, "capture-consumer.mjs"), 'fs.writeFileSync(lockPath, body, { flag: "wx" });\n');
    writeFileSync(join(dir, "systemd", "tencent-capture.service"), "[Service]\n");
    writeFileSync(join(dir, "systemd", "tencent-capture.timer"), "[Timer]\n");
    const env = { SINGULARITY_CAPTURE_DIR: dir, SINGULARITY_SYSTEMD_DIR: join(dir, "systemd") };
    let r = captureWriterCheck({ env });
    assert.equal(r.state, "VERIFIED", r.detail);

    writeFileSync(join(dir, "systemd", "second-capture.timer"), "[Timer]\n");
    r = captureWriterCheck({ env });
    assert.equal(r.state, "INCOMPLETE", "two timers are two automatic writers");
    assert.match(r.detail, /exactly one writer/);

    rmSync(join(dir, "systemd", "second-capture.timer"));
    writeFileSync(join(dir, "capture-consumer.mjs"), "no lock here\n");
    r = captureWriterCheck({ env });
    assert.equal(r.state, "INCOMPLETE");
    assert.match(r.detail, /exclusive lock/);

    assert.equal(captureWriterCheck({ env: { ...env, SINGULARITY_CAPTURE_DIR: join(dir, "nope") } }).state, "NOT_CONFIGURED");
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("the shipped capture templates are NOT an installed writer (host location only)", () => {
  // Regression (job-3 finding 9): the default scan used the package's own
  // memory/portable/systemd samples, so every checkout reported an installed
  // single writer. Only a unit in the host systemd directory counts.
  const pkg = mkdtempSync(join(tmpdir(), "doctor-capture-pkg-"));
  const units = mkdtempSync(join(tmpdir(), "doctor-capture-units-"));
  try {
    const installed = join(pkg, "memory", "portable");
    mkdirSync(join(installed, "systemd"), { recursive: true });
    writeFileSync(join(installed, "capture-consumer.mjs"), 'fs.writeFileSync(lockPath, body, { flag: "wx" });\n');
    writeFileSync(join(installed, "systemd", "tencent-capture.service"), "[Service]\n");
    writeFileSync(join(installed, "systemd", "tencent-capture.timer"), "[Timer]\n");
    const r = captureWriterCheck({ env: { SINGULARITY_CAPTURE_DIR: installed, SINGULARITY_SYSTEMD_DIR: units } });
    assert.equal(r.state, "NOT_CONFIGURED", "template units are not an installed scheduler");
  } finally { rmSync(pkg, { recursive: true, force: true }); rmSync(units, { recursive: true, force: true }); }
});

test("doctor detects options 3/4 from the attach record and runs variant-aware checks", async () => {
  // Regression (job-3 finding 8): options 3/4 have no Claude Code install
  // record, so the doctor reported NOT_CONFIGURED and never ran the wiring or
  // capture-writer checks for an attached host.
  const dir = mkdtempSync(join(tmpdir(), "doctor-attach-"));
  try {
    const cfgDir = join(dir, "cfg");
    mkdirSync(join(cfgDir, "product-secrets"), { recursive: true });
    const backups = join(dir, "attach-backups");
    const stamp = join(backups, "2026-10-28T00-00-00-000Z");
    mkdirSync(stamp, { recursive: true });
    const writeManifest = (variant) => writeFileSync(join(stamp, "MANIFEST.json"), JSON.stringify({
      createdAt: new Date().toISOString(), variant,
      target: { kind: "native", container: null, configDir: cfgDir }, files: [],
    }), "utf8");
    const base = {
      ...process.env, ...ABSENT,
      SINGULARITY_ATTACH_BACKUPS: backups,
      SINGULARITY_SYSTEMD_DIR: join(dir, "units"),
      GHOST_MEMORY_CONFIG: "/nonexistent/ghost.json",
      SINGULARITY_OFFICE_CONFIG: "/nonexistent/office.json",
    };

    writeManifest("3");
    assert.equal(readAttachRecord({ env: base }).variant, "3");
    const s3 = await doctor({ env: base });
    const by3 = Object.fromEntries(s3.map((x) => [x.name, x]));
    assert.equal(by3.installation.option, "3");
    assert.equal(by3.installation.state, "INCOMPLETE");
    assert.match(by3.installation.detail, /option 3 was ATTACHED/);
    assert.match(by3.installation.detail, /gate --variant 3 --config-dir/);
    assert.ok(by3["capture-writer"], "the capture single-owner check runs on an attached host");
    assert.match(by3.wiring.detail, /option 3/);
    assert.equal(by3.ghost, undefined, "option 3 ships neither Ghost nor Office");
    assert.equal(by3["claude-office"], undefined);

    writeManifest("4");
    const s4 = await doctor({ env: base });
    const by4 = Object.fromEntries(s4.map((x) => [x.name, x]));
    assert.equal(by4.installation.option, "4");
    assert.ok(by4.ghost, "option 4 reports its Ghost row");
    assert.ok(by4["claude-office"], "option 4 reports its Office row");
    assert.match(by4.wiring.detail, /option 4/);
    assert.match(by4.wiring.detail, /credential:office\.json/, "variant-aware wiring requires Office for option 4");
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("the dashboard is claimed only when it is installed (opt-in adjunct)", async () => {
  const dash = mkdtempSync(join(tmpdir(), "doctor-dash-"));
  const { dir, stateFile } = wiringFixture("1");
  try {
    const base = { ...process.env, ...ABSENT, SINGULARITY_CLAUDE_CODE_STATE: stateFile };
    assert.equal((await doctor({ env: base })).some((s) => /dashboard/i.test(s.name)), false);
    const withDash = await doctor({ env: { ...base, SINGULARITY_DASHBOARD_DIR: dash } });
    const row = withDash.find((s) => /dashboard/i.test(s.name));
    assert.ok(row, "an installed dashboard is reported");
    assert.equal(row.state, "VERIFIED");
    assert.match(row.detail, /opt-in/);
  } finally { rmSync(dir, { recursive: true, force: true }); rmSync(dash, { recursive: true, force: true }); }
});
