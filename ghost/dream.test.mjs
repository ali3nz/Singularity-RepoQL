import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  DREAM_STEPS,
  dreamStepPrompts,
  parseMemoryEntries,
  applyMemoryEntries,
  assertOwnMemfs,
  cleanErr,
  runDream,
} from "./dream.mjs";

test("DREAM_STEPS has the 6-step reflection pipeline", () => {
  assert.deepEqual(DREAM_STEPS, [
    "experiences",
    "related",
    "patterns",
    "evolution",
    "consolidate",
    "summary",
  ]);
  const prompts = dreamStepPrompts("ghost");
  assert.equal(prompts.length, 6);
  for (const p of prompts) {
    assert.ok(typeof p.prompt === "string" && p.prompt.length > 30);
  }
});

test("parseMemoryEntries parses valid JSON entries and filters out invalid files", () => {
  const raw = `{"entries":[
    {"file":"MEMORY.md","text":"2026-10-19 Prefer explicit readiness checks before declaring services up.","confidence":"high"},
    {"file":"../escape.md","text":"2026-10-19 Should be rejected by filename regex","confidence":"low"},
    {"file":"short.md","text":"too short","confidence":"low"}
  ]}`;
  const parsed = parseMemoryEntries(raw);
  assert.equal(parsed.length, 1);
  assert.equal(parsed[0].file, "MEMORY.md");
  assert.equal(parsed[0].confidence, "high");
});

test("assertOwnMemfs blocks path traversal and sibling references", () => {
  const tmp = mkdtempSync(join(tmpdir(), "ghost-memfs-"));
  try {
    assert.equal(assertOwnMemfs(tmp, ["MEMORY.md", "persona.md"], "explorer"), true);
    assert.throws(() => assertOwnMemfs(tmp, ["../outside.md"], "explorer"), /DREAM_ESCAPE/);
    assert.throws(() => assertOwnMemfs(tmp, ["explorer-notes.md"], "explorer"), /DREAM_CROSS_AGENT/);
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});

test("cleanErr redacts bearer tokens and sk- keys", () => {
  const dirty = "Failed with Authorization=Bearer secret_token_1234567890 and key sk-abcdef1234567890";
  const cleaned = cleanErr(dirty);
  assert.ok(!cleaned.includes("secret_token_1234567890"));
  assert.ok(!cleaned.includes("sk-abcdef1234567890"));
  assert.ok(cleaned.includes("<redacted>"));
});

test("runDream executes all 6 steps with mock callImpl and commits consolidated memory", async () => {
  const tmp = mkdtempSync(join(tmpdir(), "ghost-dream-run-"));
  try {
    const memDir = join(tmp, "memory");
    mkdirSync(memDir, { recursive: true });
    writeFileSync(join(memDir, "persona.md"), "# Persona — Ghost\nPersistent companion.", "utf8");
    writeFileSync(join(memDir, "MEMORY.md"), "# Ghost Long-Term Reflections\n", "utf8");

    let callIdx = 0;
    const mockCall = async (_messages, _maxTokens) => {
      callIdx++;
      if (callIdx === 5) {
        return JSON.stringify({
          entries: [
            {
              file: "MEMORY.md",
              text: "2026-10-19 Verified that checkpointed dream cycles commit cleanly to local git memory.",
              confidence: "high",
            },
          ],
        });
      }
      return `Step ${callIdx} reflection output with enough characters to pass the length threshold.`;
    };

    const res = await runDream({
      agentId: "ghost",
      agentDir: tmp,
      force: true,
      fresh: true,
      callImpl: mockCall,
      now: () => new Date("2026-10-19T12:00:00Z"),
    });

    assert.equal(res.status, "complete");
    assert.equal(callIdx, 6);
    assert.ok(existsSync(res.journal));
    const memContent = readFileSync(join(memDir, "MEMORY.md"), "utf8");
    assert.ok(memContent.includes("checkpointed dream cycles commit cleanly"));
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});
