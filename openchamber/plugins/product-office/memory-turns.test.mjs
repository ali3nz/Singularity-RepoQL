import { test } from "node:test";
import assert from "node:assert/strict";
import { buildTurns, processedThrough, textOf } from "./memory-turns.js";

const u = (id, text) => ({ type: "user", id, text, time: { created: 1700000000000 } });
const a = (id, text) => ({ type: "assistant", id, text, time: { created: 1700000000001 } });
const toolOnly = (id) => ({ type: "assistant", id, content: [{ type: "tool", id, name: "bash" }] });
const partsMsg = (id, parts) => ({ type: "assistant", id, content: parts, time: { created: 1700000000002 } });

test("simple question/answer pair becomes one turn", () => {
  const turns = buildTurns([u("u1", "Q A?"), a("s1", "Answer A.")]);
  assert.equal(turns.length, 1);
  assert.deepEqual(turns[0].userIds, ["u1"]);
  assert.equal(turns[0].text, "Q A?");
  assert.equal(turns[0].reply, "Answer A.");
});

test("consecutive user messages share one answer and are never double-paired", () => {
  const turns = buildTurns([u("u1", "Question A"), u("u2", "Additional instruction B"), a("s1", "Answer covering both.")]);
  assert.equal(turns.length, 1);
  assert.deepEqual(turns[0].userIds, ["u1", "u2"]);
  assert.match(turns[0].text, /Question A/);
  assert.match(turns[0].text, /Additional instruction B/);
  assert.equal(turns[0].reply, "Answer covering both.");
});

test("separate run/run sequences pair each answer to its own question", () => {
  const turns = buildTurns([u("u1", "First"), a("s1", "One"), u("u2", "Second"), a("s2", "Two")]);
  assert.equal(turns.length, 2);
  assert.equal(turns[0].reply, "One");
  assert.equal(turns[1].reply, "Two");
  assert.deepEqual(turns[1].userIds, ["u2"]);
});

test("tool continuations do not split a turn", () => {
  const turns = buildTurns([u("u1", "Run the check"), toolOnly("t1"), a("s1", "Check passed."), toolOnly("t2"), a("s2", "Also cleaned up.")]);
  assert.equal(turns.length, 1);
  assert.match(turns[0].reply, /Check passed\./);
  assert.match(turns[0].reply, /Also cleaned up\./);
  assert.equal(turns[0].replyEndIndex, 2); // first text-bearing assistant
  assert.equal(turns[0].endIndex, 4);
});

test("interrupted execution at end of page stays uncaptured", () => {
  // No reply ever arrives: nothing is recorded, and nothing is stolen.
  assert.equal(buildTurns([u("u1", "Interrupted prompt")]).length, 0);
  // A later prompt joins as a newly opened turn once IT gets its own answer;
  // the interrupted prompt is only merged when it truly shares the same reply.
  const turns = buildTurns([u("u1", "Interrupted prompt"), u("u2", "Follow-up"), a("s2", "Reply covering both.")]);
  assert.equal(turns.length, 1);
  assert.deepEqual(turns[0].userIds, ["u1", "u2"]);
});

test("assistant output before any user message is never captured", () => {
  assert.equal(buildTurns([a("s0", "Bootstrap noise"), u("u1", "Q"), a("s1", "R")]).length, 1);
});

test("empty/whitespace user messages do not open turns", () => {
  const turns = buildTurns([u("s", "   "), a("s0", "noise"), u("u1", "Real question"), a("s1", "Real answer")]);
  assert.equal(turns.length, 1);
  assert.equal(turns[0].text, "Real question");
});

test("tools-shaped content is extracted via parts", () => {
  assert.equal(textOf(partsMsg("x", [{ type: "text", text: "hello" }, { type: "tool", name: "t" }])), "hello");
  assert.equal(textOf(null), "");
});

test("processedThrough reports the end of the last closed turn", () => {
  const msgs = [u("u1", "First"), a("s1", "One"), u("u2", "Second")];
  const turns = buildTurns(msgs);
  assert.equal(processedThrough(turns, 0), 2); // only s1's turn is closed (index 0..1)
});
