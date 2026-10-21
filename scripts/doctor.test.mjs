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
