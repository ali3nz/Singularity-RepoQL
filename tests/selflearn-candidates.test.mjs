import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  LESSON_SCHEMA,
  discoverCandidate,
  listCandidates,
  loadCandidate,
  evaluateCandidates,
  validateLesson,
  parseModelJson,
  dedupLesson,
  candidateSummary,
  markPromoted,
  recordVerification,
  candidatePath,
  promotionCommand,
} from "../scripts/selflearn-candidates.mjs";

const scratch = () => mkdtempSync(join(tmpdir(), "selflearn-test-"));
const PROVIDER = { source: "test", url: "http://127.0.0.1:1/v1", model: "test-model", key: "" };
const OK_RQL = () => ({ status: 0, stdout: "no capsule matched" });

function lesson(over = {}) {
  return {
    schema: LESSON_SCHEMA,
    title: "InitialiseBeforeQuery",
    lesson: "Initialise the lazily-created connection before executing a query so a fresh process does not fail.",
    category: "bugfix",
    generalizable: true,
    confidence: "high",
    needsVerification: false,
    evidenceRefs: ["src/cache.py"],
    duplicateOf: null,
    ...over,
  };
}

const modelReturning = (obj) => async () => JSON.stringify(obj);

test("validateLesson enforces the versioned schema and supplied-evidence refs", () => {
  const ok = validateLesson(lesson(), { allowedRefs: ["src/cache.py"] });
  assert.equal(ok.ok, true);
  assert.equal(validateLesson(lesson({ schema: "other.v1" }), { allowedRefs: ["src/cache.py"] }).ok, false);
  assert.equal(validateLesson(lesson({ category: "made-up" }), { allowedRefs: ["src/cache.py"] }).ok, false);
  assert.equal(validateLesson(lesson({ evidenceRefs: ["src/not-supplied.py"] }), { allowedRefs: ["src/cache.py"] }).ok, false);
  assert.equal(validateLesson(lesson({ evidenceRefs: [] }), { allowedRefs: ["src/cache.py"] }).ok, false);
  assert.equal(validateLesson(lesson({ title: "" }), { allowedRefs: ["src/cache.py"] }).ok, false);
  assert.equal(validateLesson({ ...lesson(), extra: true }, { allowedRefs: ["src/cache.py"] }).ok, false, "unknown fields are refused, not silently accepted");
  assert.deepEqual(validateLesson({ schema: LESSON_SCHEMA, noLesson: true }, { allowedRefs: [] }), { ok: true, lesson: { noLesson: true } });
});

test("parseModelJson tolerates a fenced/chatty answer but never invents JSON", () => {
  assert.equal(parseModelJson('```json\n{"schema":"x"}\n```').schema, "x");
  assert.equal(parseModelJson('Sure: {"a":1} done').a, 1);
  assert.equal(parseModelJson("no json here"), null);
});

test("discovery is durable, idempotent, and independent of the doc disposition", () => {
  const dir = scratch();
  try {
    const a = discoverCandidate({ session: "s1", files: ["src/a.py"], root: dir, reason: "r" });
    const b = discoverCandidate({ session: "s1", files: ["src/a.py"], root: dir, reason: "r" });
    assert.equal(a.created, true);
    assert.equal(b.created, false);
    assert.equal(b.record.seenCount, 2);
    assert.equal(listCandidates(dir).length, 1);
    assert.equal(b.record.state, "DISCOVERED");
    assert.equal(b.record.schema, "selflearn.candidate.v1");
    assert.equal(b.record.promotion.approvalRequired, true);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("evaluation formulates a real lesson through one bounded model call and stops at the approval gate", async () => {
  const dir = scratch();
  try {
    discoverCandidate({ session: "s2", files: ["src/cache.py"], root: dir });
    let calls = 0;
    const res = await evaluateCandidates({
      root: dir, provider: PROVIDER, runRql: OK_RQL, limit: 2,
      modelCall: async () => { calls++; return JSON.stringify(lesson()); },
    });
    assert.equal(calls, 1, "exactly one model call per candidate");
    assert.equal(res.outcomes[0].state, "AWAITING_APPROVAL");
    const rec = loadCandidate(res.outcomes[0].id, dir);
    assert.equal(rec.lesson.title, "InitialiseBeforeQuery");
    assert.equal(rec.lesson.text.length > 20, true);
    assert.equal(rec.dedup.checked, true, "the RepoQL dedup search actually ran");
    assert.equal(rec.verification.state, "satisfied");
    assert.equal(rec.promotion.eligible, true);
    assert.equal(rec.promotion.approvalRequired, true, "policy: promotion is never automatic");
    assert.match(rec.promotion.command, /^rql concept add /);
    assert.equal(rec.state, "AWAITING_APPROVAL", "no authoritative write happened");
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("an equivalent existing capsule is a DUPLICATE, not a second authoritative record", async () => {
  const dir = scratch();
  try {
    mkdirSync(join(dir, ".repoql", "concepts"), { recursive: true });
    writeFileSync(join(dir, ".repoql", "concepts", "InitialiseBeforeQuery.md"),
      "---\nname: InitialiseBeforeQuery\ncategory: rule\ninvariant: Initialise the lazily-created connection before executing a query.\n---\n");
    assert.equal(dedupLesson(lesson(), { root: dir, runRql: OK_RQL }).duplicateOf !== null, true);
    discoverCandidate({ session: "s3", files: ["src/cache.py"], root: dir });
    const res = await evaluateCandidates({ root: dir, provider: PROVIDER, runRql: OK_RQL, modelCall: modelReturning(lesson()) });
    assert.equal(res.outcomes[0].state, "DUPLICATE");
    const rec = loadCandidate(res.outcomes[0].id, dir);
    assert.match(rec.dedup.duplicateOf, /\.repoql\/concepts\/InitialiseBeforeQuery\.md$/);
    assert.equal(rec.promotion.eligible, false);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("NO_LESSON is an honest terminal state, not a fabricated candidate", async () => {
  const dir = scratch();
  try {
    discoverCandidate({ session: "s4", files: ["src/x.py"], root: dir });
    const res = await evaluateCandidates({ root: dir, provider: PROVIDER, runRql: OK_RQL, modelCall: modelReturning({ schema: LESSON_SCHEMA, noLesson: true }) });
    assert.equal(res.outcomes[0].state, "NO_LESSON");
    const rec = loadCandidate(res.outcomes[0].id, dir);
    assert.equal(rec.lesson, null);
    assert.equal(rec.promotion.eligible, false);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("unverified lessons are retained but cannot be promoted until verified", async () => {
  const dir = scratch();
  try {
    discoverCandidate({ session: "s5", files: ["src/cache.py"], root: dir });
    const res = await evaluateCandidates({ root: dir, provider: PROVIDER, runRql: OK_RQL, modelCall: modelReturning(lesson({ needsVerification: true })) });
    assert.equal(res.outcomes[0].state, "NEEDS_VERIFICATION");
    const id = res.outcomes[0].id;
    assert.equal(markPromoted({ id, conceptId: "InitialiseBeforeQuery", root: dir }).ok, false, "verification gates promotion");
    assert.equal(recordVerification({ id, note: "pytest reproduced and passed", root: dir }).ok, true);
    const promoted = markPromoted({ id, conceptId: "InitialiseBeforeQuery", root: dir });
    assert.equal(promoted.ok, true);
    assert.equal(promoted.record.state, "PROMOTED");
    assert.equal(promoted.record.promotion.reference, "InitialiseBeforeQuery");
    assert.equal(markPromoted({ id, conceptId: "OtherName", root: dir }).ok, false, "promotion is recorded once");
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("a failed model call backs off with a bounded retry and eventually fails honestly", async () => {
  const dir = scratch();
  try {
    discoverCandidate({ session: "s6", files: ["src/a.py"], root: dir });
    const boom = async () => { throw new Error("provider down"); };
    const first = await evaluateCandidates({ root: dir, provider: PROVIDER, runRql: OK_RQL, modelCall: boom });
    assert.equal(first.outcomes[0].state, "DEFERRED");
    let rec = loadCandidate(first.outcomes[0].id, dir);
    assert.equal(rec.retries, 1);
    assert.ok(Date.parse(rec.nextAttemptAt) > Date.now(), "backoff is scheduled");
    // Not due yet: nothing is evaluated.
    const early = await evaluateCandidates({ root: dir, provider: PROVIDER, runRql: OK_RQL, modelCall: boom });
    assert.equal(early.evaluated, 0);
    // After the backoff elapses the retry runs, up to the bounded maximum.
    let state = null;
    for (let i = 0; i < 6; i++) {
      const later = await evaluateCandidates({ root: dir, provider: PROVIDER, runRql: OK_RQL, modelCall: boom, now: () => Date.now() + 2 ** 20 * (i + 1) * 60_000 });
      state = later.outcomes[0]?.state || state;
    }
    rec = loadCandidate(rec.id, dir);
    assert.equal(rec.state, "FAILED");
    assert.equal(rec.retries, 5);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("a stale EVALUATING claim is reclaimed instead of blocking the queue forever", async () => {
  const dir = scratch();
  try {
    const d =    discoverCandidate({ session: "s7", files: ["src/cache.py"], root: dir });
    const rec = loadCandidate(d.record.id, dir);
    const stale = { ...rec, state: "EVALUATING", claim: { id: "dead", at: new Date(Date.now() - 20 * 60_000).toISOString() }, updatedAt: new Date(Date.now() - 20 * 60_000).toISOString() };
    writeFileSync(candidatePath(rec.id, dir), JSON.stringify(stale, null, 2));
    const res = await evaluateCandidates({ root: dir, provider: PROVIDER, runRql: OK_RQL, modelCall: modelReturning(lesson()) });
    assert.equal(res.evaluated, 1);
    assert.equal(loadCandidate(rec.id, dir).state, "AWAITING_APPROVAL");
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("two concurrent evaluators never process the same candidate twice", async () => {
  const dir = scratch();
  try {
    discoverCandidate({ session: "s8", files: ["src/cache.py"], root: dir });
    let calls = 0;
    const slowModel = async () => { calls++; await new Promise((r) => setTimeout(r, 80)); return JSON.stringify(lesson()); };
    const [a, b] = await Promise.all([
      evaluateCandidates({ root: dir, provider: PROVIDER, runRql: OK_RQL, modelCall: slowModel }),
      evaluateCandidates({ root: dir, provider: PROVIDER, runRql: OK_RQL, modelCall: slowModel }),
    ]);
    assert.equal(calls, 1, "one claim, one model call");
    // The second pass either found the record claimed (LOCKED/SKIPPED) or no
    // longer eligible at all — either way it must not process it again.
    const secondStates = b.outcomes.map((o) => o.state);
    assert.equal(secondStates.length === 0 || secondStates.some((s) => s === "LOCKED" || s === "SKIPPED"), true);
    assert.equal(listCandidates(dir).filter((r) => r.state === "AWAITING_APPROVAL").length, 1);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("failure to reach RepoQL keeps the candidate but never makes it promotion-eligible", async () => {
  const dir = scratch();
  try {
    discoverCandidate({ session: "s9", files: ["src/cache.py"], root: dir });
    const res = await evaluateCandidates({ root: dir, provider: PROVIDER, limit: 1, runRql: () => ({ status: 1, stderr: "rql unavailable" }), modelCall: modelReturning(lesson()) });
    assert.equal(res.outcomes[0].state, "NEEDS_VERIFICATION");
    const rec = loadCandidate(res.outcomes[0].id, dir);
    assert.equal(rec.dedup.checked, false);
    assert.ok(rec.verification.pending.includes("dedup-confirmation"));
    assert.equal(rec.promotion.eligible, false);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("candidateSummary distinguishes pending work, formulated lessons and promotions", async () => {
  const dir = scratch();
  try {
    discoverCandidate({ session: "s10", files: ["src/cache.py"], root: dir });
    const before = candidateSummary(dir);
    assert.equal(before.pending, 1);
    assert.equal(before.awaitingApproval, 0);
    assert.equal(before.lastPromotion, null);
    const res = await evaluateCandidates({ root: dir, provider: PROVIDER, runRql: OK_RQL, modelCall: modelReturning(lesson()) });
    assert.equal(res.outcomes[0].state, "AWAITING_APPROVAL");
    assert.equal(markPromoted({ id: res.outcomes[0].id, conceptId: "InitialiseBeforeQuery", root: dir }).ok, true);
    const after = candidateSummary(dir);
    assert.equal(after.byState.PROMOTED, 1);
    assert.equal(after.lastPromotion.conceptId, "InitialiseBeforeQuery");
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("promotionCommand names the existing gated RepoQL surface", () => {
  assert.match(promotionCommand(lesson()), /^rql concept add [A-Za-z0-9]+ (rule|shape|knowledge) /);
});
