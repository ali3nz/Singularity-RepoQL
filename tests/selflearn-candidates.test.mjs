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
  recordPromotionMetadata,
  validatePromotionMetadata,
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
    assert.equal(res.outcomes[0].state, "NEEDS_VERIFICATION");
    const rec = loadCandidate(res.outcomes[0].id, dir);
    assert.equal(rec.lesson.title, "InitialiseBeforeQuery");
    assert.equal(rec.lesson.text.length > 20, true);
    assert.equal(rec.dedup.checked, true, "the RepoQL dedup search actually ran");
    assert.equal(rec.verification.state, "pending");
    assert.ok(rec.verification.pending.includes("promotion-metadata"));
    assert.equal(rec.promotion.eligible, false);
    assert.equal(rec.promotion.approvalRequired, true, "policy: promotion is never automatic");
    assert.equal(rec.promotion.command, null);
    assert.equal(rec.state, "NEEDS_VERIFICATION", "missing promotion metadata remains held");
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
    assert.match(rec.dedup.duplicateOf.replaceAll("\\", "/"), /\.repoql\/concepts\/InitialiseBeforeQuery\.md$/);
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
    assert.equal(promoted.ok, false, "missing verified promotion metadata keeps the gate closed");
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
    assert.equal(loadCandidate(rec.id, dir).state, "NEEDS_VERIFICATION");
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
    assert.equal(listCandidates(dir).filter((r) => r.state === "NEEDS_VERIFICATION").length, 1);
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

test("full queue retains pending, approved and promoted provenance records", () => {
  const dir = scratch();
  try {
    const saved = discoverCandidate({ session: "protected", files: ["src/cache.py"], root: dir }).record;
    writeFileSync(candidatePath(saved.id, dir), JSON.stringify({ ...saved, state: "AWAITING_APPROVAL" }));
    for (let i = 0; i < 199; i++) {
      const rec = discoverCandidate({ session: `protected-${i}`, files: ["src/cache.py"], root: dir }).record;
      writeFileSync(candidatePath(rec.id, dir), JSON.stringify({ ...rec, state: "NEEDS_VERIFICATION" }));
    }
    assert.equal(discoverCandidate({ session: "protected", files: ["src/cache.py"], root: dir }).record.state, "AWAITING_APPROVAL");
    assert.equal(discoverCandidate({ session: "new", files: ["src/cache.py"], root: dir }).created, false);
    assert.equal(listCandidates(dir).length, 200);
    assert.equal(candidateSummary(dir).queueFull, true);
    assert.equal(loadCandidate(saved.id, dir).state, "AWAITING_APPROVAL");
    writeFileSync(candidatePath(saved.id, dir), JSON.stringify({ ...saved, state: "PROMOTED" }));
    assert.equal(discoverCandidate({ session: "new", files: ["src/cache.py"], root: dir }).created, true);
    assert.equal(loadCandidate(saved.id, dir).state, "PROMOTED");
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("rediscovery preserves retry state and a live evaluation", async () => {
  const dir = scratch();
  try {
    const args = { session: "rediscover", files: ["src/cache.py"], root: dir };
    const id = discoverCandidate(args).record.id;
    await evaluateCandidates({ root: dir, env: {}, limit: 1 });
    const deferred = loadCandidate(id, dir);
    assert.equal(deferred.state, "DEFERRED");
    assert.deepEqual(discoverCandidate(args).record, deferred);
    const evaluating = { ...deferred, state: "EVALUATING", claim: { id: "held", at: new Date().toISOString() } };
    writeFileSync(candidatePath(id, dir), JSON.stringify(evaluating));
    assert.deepEqual(discoverCandidate(args).record, evaluating);
    assert.deepEqual(loadCandidate(id, dir), evaluating);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("formulated lesson is durable before a failed dedup call", async () => {
  const dir = scratch();
  try {
    const id = discoverCandidate({ session: "persist", files: ["src/cache.py"], root: dir }).record.id;
    const res = await evaluateCandidates({ root: dir, provider: PROVIDER,
      modelCall: modelReturning(lesson()), runRql: () => {
        const current = loadCandidate(id, dir);
        assert.equal(current.state, "NEEDS_VERIFICATION");
        assert.equal(current.lesson.title, "InitialiseBeforeQuery");
        throw new Error("RepoQL unavailable");
      } });
    assert.equal(res.outcomes[0].state, "NEEDS_VERIFICATION");
    assert.equal(loadCandidate(id, dir).dedup.checked, false);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("a missing provider backs off instead of starving dedup recovery", async () => {
  const dir = scratch();
  try {
    const deferred = discoverCandidate({ session: "no-provider", files: ["src/other"], root: dir }).record.id;
    const unavailable = await evaluateCandidates({ root: dir, env: {}, limit: 1 });
    assert.equal(unavailable.outcomes[0].state, "DEFERRED");
    assert.ok(Date.parse(loadCandidate(deferred, dir).nextAttemptAt) > Date.now());
    const candidate = discoverCandidate({ session: "recovery", files: ["src/cache.py"], root: dir }).record.id;
    await evaluateCandidates({ root: dir, provider: PROVIDER, limit: 1,
      runRql: () => ({ status: 1 }), modelCall: modelReturning(lesson()) });
    const recovered = await evaluateCandidates({ root: dir, env: {}, limit: 1,
      now: () => Date.now() + 120_000, runRql: OK_RQL });
    assert.equal(recovered.outcomes[0].id, candidate);
    assert.equal(recovered.outcomes[0].state, "NEEDS_VERIFICATION");
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("dedup recovers without repeating the model and preserves manual verification", async () => {
  const dir = scratch();
  try {
    discoverCandidate({ session: "retry", files: ["src/cache.py"], root: dir });
    let calls = 0;
    const first = await evaluateCandidates({ root: dir, provider: PROVIDER,
      runRql: () => ({ status: 1, stderr: "offline" }),
      modelCall: async () => { calls++; return JSON.stringify(lesson({ needsVerification: true })); } });
    const id = first.outcomes[0].id;
    assert.equal(recordVerification({ id, root: dir, note: "verified independently" }).record.state, "NEEDS_VERIFICATION");
    const retry = await evaluateCandidates({ root: dir, runRql: OK_RQL, now: () => Date.now() + 120_000, modelCall: () => { throw new Error("must not call model"); } });
    assert.equal(retry.outcomes[0].state, "NEEDS_VERIFICATION");
    const rec = loadCandidate(id, dir);
    assert.equal(calls, 1);
    assert.equal(rec.verification.note, "verified independently");
    assert.ok(rec.verification.satisfied.includes("dedup-confirmation"));
    assert.equal(rec.promotion.approvalRequired, true);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("dedup outage retries back off and later identify duplicates", async () => {
  const dir = scratch();
  try {
    discoverCandidate({ session: "retry-duplicate", files: ["src/cache.py"], root: dir });
    const down = () => ({ status: 1, stderr: "offline" });
    const first = await evaluateCandidates({ root: dir, provider: PROVIDER, runRql: down, modelCall: modelReturning(lesson()) });
    const id = first.outcomes[0].id;
    const again = await evaluateCandidates({ root: dir, runRql: down, now: () => Date.now() + 120_000 });
    assert.equal(again.outcomes[0].state, "NEEDS_VERIFICATION");
    assert.equal(loadCandidate(id, dir).dedupRetries, 2);
    assert.equal((await evaluateCandidates({ root: dir, runRql: OK_RQL })).evaluated, 0);
    mkdirSync(join(dir, ".repoql", "concepts"), { recursive: true });
    writeFileSync(join(dir, ".repoql", "concepts", "InitialiseBeforeQuery.md"),
      "---\nname: InitialiseBeforeQuery\ninvariant: Initialise the lazily-created connection before executing a query.\n---\n");
    const retry = await evaluateCandidates({ root: dir, runRql: OK_RQL, now: () => Date.now() + 300_000 });
    assert.equal(retry.outcomes[0].state, "DUPLICATE");
    assert.equal(loadCandidate(id, dir).promotion.eligible, false);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("legacy outage candidates cannot bypass missing promotion metadata", async () => {
  const dir = scratch();
  try {
    const id = discoverCandidate({ session: "legacy", files: ["src/cache.py"], root: dir }).record.id;
    await evaluateCandidates({ root: dir, provider: PROVIDER, runRql: () => ({ status: 1 }), modelCall: modelReturning(lesson()) });
    const old = loadCandidate(id, dir);
    old.verification.requirements = ["evidence-refs-resolve", "repoql-dedup-ran", "dedup-confirmation"];
    old.verification.pending = ["repoql-dedup-ran", "dedup-confirmation"];
    old.promotion.command = "legacy unsafe command";
    writeFileSync(candidatePath(id, dir), JSON.stringify(old));
    const result = await evaluateCandidates({ root: dir, runRql: OK_RQL, now: () => Date.now() + 120_000 });
    assert.equal(result.outcomes[0].state, "NEEDS_VERIFICATION");
    assert.ok(loadCandidate(id, dir).verification.pending.includes("promotion-metadata"));
    assert.equal(markPromoted({ id, root: dir, conceptId: "InitialiseBeforeQuery" }).ok, false);
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
    assert.equal(res.outcomes[0].state, "NEEDS_VERIFICATION");
    assert.equal(markPromoted({ id: res.outcomes[0].id, conceptId: "InitialiseBeforeQuery", root: dir }).ok, false);
    const after = candidateSummary(dir);
    assert.equal(after.byState.NEEDS_VERIFICATION, 1);
    assert.equal(after.lastPromotion, null);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("promotionCommand names the existing gated RepoQL surface", () => {
  assert.equal(promotionCommand(lesson({ lesson: "$(malicious)" })), null);
  assert.equal(promotionCommand(lesson(), { conceptName: "Bad Name!", capsuleCategory: "rule", tags: "a", relevance: "src/**" }), null);
  assert.equal(promotionCommand(lesson(), { conceptName: "WideScope", capsuleCategory: "rule", tags: "a", relevance: "**" }), null);
  const meta = validatePromotionMetadata({ conceptName: "CacheInitRule", capsuleCategory: "rule", tags: "cache,init", relevance: "src/cache.py", verification: "src/cache.py#symbol=init", ttlDays: 90, why: "init before query" }, lesson()).metadata;
  const cmd = promotionCommand(lesson(), meta);
  assert.ok(cmd.startsWith("rql concept add CacheInitRule rule "));
  assert.ok(cmd.includes("--relevance src/cache.py"));
  assert.ok(cmd.includes("--ttl-days 90"));
  const evil = promotionCommand(lesson({ lesson: "Fix it $(echo PWNED) now", title: "T" }), meta);
  assert.ok(evil.includes("'Fix it $(echo PWNED) now'"), "model text must be single-quoted so $(...) cannot execute");
  assert.ok(!evil.includes('"$('), "model text must never be double-quoted");
});

test("pre-fix records cannot bypass the operator metadata gate", async () => {
  const dir = scratch();
  try {
    discoverCandidate({ session: "legacy-promote", files: ["src/cache.py"], root: dir });
    const res = await evaluateCandidates({ root: dir, provider: PROVIDER, runRql: () => ({ status: 1 }), modelCall: modelReturning(lesson()) });
    const id = res.outcomes[0].id;
    const legacy = loadCandidate(id, dir);
    legacy.state = "AWAITING_APPROVAL";
    legacy.promotion = { eligible: true, approvalRequired: true, command: "rql concept add X rule 'y' --relevance '**'" };
    legacy.verification = { state: "satisfied", requirements: ["evidence-refs-resolve"], satisfied: ["evidence-refs-resolve"], pending: [] };
    writeFileSync(candidatePath(id, dir), JSON.stringify(legacy));
    assert.equal(markPromoted({ id, root: dir, conceptId: "CacheInitRule" }).ok, false);
    assert.match(markPromoted({ id, root: dir, conceptId: "CacheInitRule" }).error, /metadata/);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("promotion reference must match the recorded metadata", async () => {
  const dir = scratch();
  try {
    discoverCandidate({ session: "mismatch", files: ["src/cache.py"], root: dir });
    const res = await evaluateCandidates({ root: dir, provider: PROVIDER, runRql: OK_RQL, modelCall: modelReturning(lesson()) });
    const id = res.outcomes[0].id;
    const ok = recordPromotionMetadata({ id, root: dir, metadata: { conceptName: "CacheInitRule", capsuleCategory: "rule", tags: "cache", relevance: "src/cache.py" } });
    assert.equal(ok.record.state, "AWAITING_APPROVAL");
    assert.equal(markPromoted({ id, root: dir, conceptId: "OtherName" }).ok, false);
    assert.equal(markPromoted({ id, root: dir, conceptId: "CacheInitRule" }).ok, true);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("dedup recovery preserves an operator-recorded command", async () => {
  const dir = scratch();
  try {
    discoverCandidate({ session: "keep-cmd", files: ["src/cache.py"], root: dir });
    const first = await evaluateCandidates({ root: dir, provider: PROVIDER, runRql: () => ({ status: 1 }), modelCall: modelReturning(lesson()) });
    const id = first.outcomes[0].id;
    const meta = recordPromotionMetadata({ id, root: dir, metadata: { conceptName: "CacheInitRule", capsuleCategory: "rule", tags: "cache", relevance: "src/cache.py" } });
    assert.ok(meta.record.promotion.command.includes("CacheInitRule"));
    assert.equal(meta.record.state, "NEEDS_VERIFICATION");
    const retry = await evaluateCandidates({ root: dir, runRql: OK_RQL, now: () => Date.now() + 300_000 });
    assert.equal(retry.outcomes[0].state, "AWAITING_APPROVAL");
    assert.ok(loadCandidate(id, dir).promotion.command.includes("rql concept add CacheInitRule rule "));
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("verify on a legacy record still requires operator metadata", async () => {
  const dir = scratch();
  try {
    discoverCandidate({ session: "legacy-verify", files: ["src/cache.py"], root: dir });
    const res = await evaluateCandidates({ root: dir, provider: PROVIDER, runRql: OK_RQL, modelCall: modelReturning(lesson({ needsVerification: true })) });
    const id = res.outcomes[0].id;
    const rec = loadCandidate(id, dir);
    rec.verification.requirements = ["evidence-refs-resolve", "repoql-dedup-ran", "manual-verification"];
    rec.verification.pending = ["manual-verification"];
    writeFileSync(candidatePath(id, dir), JSON.stringify(rec));
    const v = recordVerification({ id, root: dir, note: "checked" });
    assert.equal(v.record.state, "NEEDS_VERIFICATION");
    assert.ok(v.record.verification.pending.includes("promotion-metadata"));
    assert.equal(markPromoted({ id, root: dir, conceptId: "CacheInitRule" }).ok, false);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("operator-recorded promotion metadata unlocks the approval gate", async () => {
  const dir = scratch();
  try {
    discoverCandidate({ session: "meta", files: ["src/cache.py"], root: dir });
    const res = await evaluateCandidates({ root: dir, provider: PROVIDER, runRql: OK_RQL, modelCall: modelReturning(lesson()) });
    const id = res.outcomes[0].id;
    assert.equal(loadCandidate(id, dir).state, "NEEDS_VERIFICATION");
    assert.equal(recordPromotionMetadata({ id, root: dir, metadata: { conceptName: "Bad!", capsuleCategory: "rule", tags: "a", relevance: "src/cache.py" } }).ok, false);
    assert.equal(recordPromotionMetadata({ id, root: dir, metadata: { conceptName: "WideScope", capsuleCategory: "rule", tags: "a", relevance: "**" } }).ok, false);
    const ok = recordPromotionMetadata({ id, root: dir, metadata: { conceptName: "CacheInitRule", capsuleCategory: "rule", tags: "cache,init", relevance: "src/cache.py", verification: "src/cache.py#symbol=init", ttlDays: 90, why: "operator confirmed init order" } });
    assert.equal(ok.ok, true);
    assert.equal(ok.record.state, "AWAITING_APPROVAL");
    assert.ok(ok.record.promotion.command.includes("rql concept add CacheInitRule rule "));
    assert.equal(ok.record.promotion.eligible, true);
    const promoted = markPromoted({ id, conceptId: "CacheInitRule", root: dir });
    assert.equal(promoted.ok, true);
    assert.equal(promoted.record.state, "PROMOTED");
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
