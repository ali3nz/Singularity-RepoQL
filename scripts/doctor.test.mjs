// Regression tests for scripts/doctor.mjs (§11):
//   - an uninstalled host never exits 0 and never claims VERIFIED;
//   - every section is reusable-shipped-checks only (no parallel state);
//   - a verified install record flips installation/capture-hooks to VERIFIED;
//   - statuses match the §11 vocabulary and never leak key material.
// Run: node --test scripts/doctor.test.mjs
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, rmSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { doctor, renderHuman } from "./doctor.mjs";

const ROOT = resolve(import.meta.dirname, "..");
const ABSENT = { SINGULARITY_MEMORY_CONFIG: "/nonexistent/memory.json", SINGULARITY_CLAUDE_CODE_STATE: "/nonexistent/state.json" };

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
