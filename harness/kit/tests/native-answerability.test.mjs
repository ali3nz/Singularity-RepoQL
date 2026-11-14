import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, chmodSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { resolve } from "node:path";
import { detectConflicts, judgePacket, judgeExpandedCancellation } from "../lib/memory-orchestra/answerability.mjs";
import { NativeMemoryPolicyError } from "../lib/native-memory-policy.mjs";
import { buildVerdict } from "../lib/memory-orchestra/context.mjs";

const moduleUrl = pathToFileURL(resolve("harness/kit/lib/memory-orchestra/answerability.mjs")).href;
const fake = `#!/usr/bin/env node
(async () => {
  const fs = require('node:fs');
  const mode = process.argv[2];
  const input = JSON.parse(fs.readFileSync(0,'utf8'));
  delete process.env.SINGULARITY_RUST_MEMORY_POLICY_BIN;
  const ref = await import(${JSON.stringify(moduleUrl)});
  let value;
  if (mode === 'answerability-packet') value = ref.judgePacket(input);
  else if (mode === 'answerability-expanded') value = ref.judgeExpandedCancellation(input.plan, input.fused);
  else if (mode === 'answerability-conflicts') value = ref.detectConflicts(input.candidates);
  else return process.exit(2);
  if (process.env.TEST_BAD_ANSWERABILITY === '1') value = {state:'SUFFICIENT',reason:'fabricated',missing:[],targetedExpansion:null};
  process.stdout.write(JSON.stringify({ok:true,value}));
})().catch(err=>{console.error(err);process.exit(2)});
`;

const f = (channels, intent = "how-to") => ({
  plan: { intent }, fused: {ok: true, candidates: channels.map((channel,i) => ({
    id: `row${i}`, channel, claimText: "one operational subject", validity: i ? "STALE" : "CURRENT",
  }))},
});

test("answerability opt-in uses native result only when it matches JS evidence law", {skip: process.platform === "win32"}, () => {
  const before = process.env.SINGULARITY_RUST_MEMORY_POLICY_BIN;
  const dir = mkdtempSync(join(tmpdir(), "singularity-answerability-"));
  const bin = join(dir, "policy-bin");
  writeFileSync(bin, fake);
  chmodSync(bin, 0o700);
  try {
    delete process.env.SINGULARITY_RUST_MEMORY_POLICY_BIN;
    const source = f(["procedure-runbook", "repoql-concept"]);
    const expected = judgePacket(source);
    const expanded = judgeExpandedCancellation(source.plan, source.fused);
    const conflicts = detectConflicts(source.fused.candidates);
    assert.equal(expected.state, "SUFFICIENT");
    assert.equal(expanded.state, "CONFLICTED");
    assert.equal(conflicts.length, 1);
    process.env.SINGULARITY_RUST_MEMORY_POLICY_BIN = bin;
    assert.deepEqual(judgePacket(source), expected);
    assert.deepEqual(judgeExpandedCancellation(source.plan, source.fused), JSON.parse(JSON.stringify(expanded)));
    assert.deepEqual(detectConflicts(source.fused.candidates), JSON.parse(JSON.stringify(conflicts)));
    const partial = f(["procedure-runbook"]);
    assert.equal(judgePacket(partial).targetedExpansion, "repoql-concept");
    const empty = f([]);
    assert.equal(judgePacket(empty).state, "INSUFFICIENT");
    process.env.TEST_BAD_ANSWERABILITY = "1";
    assert.throws(() => judgePacket(source), e => e instanceof NativeMemoryPolicyError && e.code === "NATIVE_ANSWERABILITY_MISMATCH");
    assert.throws(() => judgeExpandedCancellation(source.plan, source.fused), e => e instanceof NativeMemoryPolicyError && e.code === "NATIVE_ANSWERABILITY_MISMATCH");
    assert.throws(() => detectConflicts(source.fused.candidates), e => e instanceof NativeMemoryPolicyError && e.code === "INVALID_NATIVE_ANSWERABILITY");
    delete process.env.TEST_BAD_ANSWERABILITY;
    process.env.SINGULARITY_RUST_MEMORY_POLICY_BIN = join(dir, "missing");
    assert.throws(() => judgePacket(source), e => e instanceof NativeMemoryPolicyError && e.code === "NATIVE_POLICY_UNAVAILABLE");
  } finally {
    if (before === undefined) delete process.env.SINGULARITY_RUST_MEMORY_POLICY_BIN;
    else process.env.SINGULARITY_RUST_MEMORY_POLICY_BIN = before;
    delete process.env.TEST_BAD_ANSWERABILITY;
    rmSync(dir, {recursive: true, force: true});
  }
});


test("DEEP judge remains bounded to a downgrade and does not throw an unbound llmRefine error", async () => {
  const old = process.env.ORCH_MORCH_FUSION;
  try {
    process.env.ORCH_MORCH_FUSION = "ENABLED";
    const fused = { ok: true, candidates: [{ id: "episode-a", channel: "episode-historical",
      origin: "steps", claimText: "Verified observed operation", validity: "CURRENT",
      evidenceLocator: "file:///episode", verification: "VERIFIED" }] };
    const result = await buildVerdict({ hook: "DECISION_REPAIR", query: "what happened",
      fused, expandFn: async () => { throw new Error("unexpected expansion"); },
      judge: async () => "PARTIAL" });
    assert.equal(result.state, "PARTIAL");
    assert.equal(result.refinedBy, "llm-judge");
    assert.ok(result.packet.entries.some(x => x.id === "episode-a"));
  } finally {
    if (old === undefined) delete process.env.ORCH_MORCH_FUSION;
    else process.env.ORCH_MORCH_FUSION = old;
  }
});
