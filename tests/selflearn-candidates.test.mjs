import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFileSync } from "node:child_process";
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
  collectWorkspaceEvidence,
} from "../scripts/selflearn-candidates.mjs";

const scratch = () => {
  const root = mkdtempSync(join(tmpdir(), "selflearn-test-"));
  mkdirSync(join(root, "src"));
  writeFileSync(join(root, "src", "cache.py"), "def init():\n    return True\n");
  return root;
};
const PROVIDER = { source: "test", url: "http://127.0.0.1:1/v1", model: "test-model", key: "" };

test('workspace evidence includes staged changes, working edits and space-containing new files', t => {
  const root = scratch();
  t.after(() => rmSync(root, {recursive: true, force: true}));
  execFileSync('git', ['init', '--quiet'], {cwd: root, windowsHide: true, stdio: 'ignore'});
  writeFileSync(join(root, 'src/cache.py'), 'STAGED_FLAG = True\n');
  execFileSync('git', ['add', '--', 'src/cache.py'], {cwd: root, windowsHide: true, stdio: 'ignore'});
  writeFileSync(join(root, 'src/cache.py'), 'STAGED_FLAG = False\nWORKTREE_FLAG = True\n');
  writeFileSync(join(root, 'src/new feature.py'), 'NEW_CONTENT = True\n');
  const evidence = collectWorkspaceEvidence(root, ['src/cache.py', 'src/new feature.py']);
  assert.equal(evidence.observable, true);
  assert.match(evidence.diff, /\+STAGED_FLAG = True/);
  assert.match(evidence.diff, /\+WORKTREE_FLAG = True/);
  assert.match(evidence.diff, /\+NEW_CONTENT = True/);
  assert.deepEqual(evidence.untracked, ['src/new feature.py']);
  assert.equal(evidence.untrackedOmitted, 0);
});

test('workspace evidence never broadens an empty file scope into a repository diff', () => {
  const calls = [];
  const evidence = collectWorkspaceEvidence('unused', [], {execImpl: (command, args) => {
    calls.push(args);
    return {status: 0, stdout: 'true\n'};
  }});
  assert.equal(evidence.observable, true);
  assert.deepEqual(calls, [['rev-parse', '--is-inside-work-tree']]);
});

test('workspace evidence stops before an expired command budget', () => {
  let calls = 0;
  const evidence = collectWorkspaceEvidence('unused', ['src/cache.py'], {deadlineMs: Date.now() - 1,
    execImpl: () => {calls++; return {status: 0, stdout: 'true\n'};}});
  assert.equal(evidence.observable, false);
  assert.equal(calls, 0);
});

test('workspace evidence cannot accept a no-index timeout as normal differences', () => {
  let noIndexCalls = 0;
  const evidence = collectWorkspaceEvidence('unused', ['src/new feature.py'], {execImpl: (command, args) => {
    if (args[0] === 'rev-parse') return {status: 0, stdout: 'true\n'};
    if (args[0] === 'ls-files') return {status: 0, stdout: 'src/new feature.py\0'};
    if (args.includes('--no-index')) {noIndexCalls++; throw new Error('controlled timeout without exit status');}
    return {status: 0, stdout: ''};
  }});
  assert.equal(evidence.observable, false);
  assert.equal(noIndexCalls, 1);
});

test('workspace evidence counts every omitted new file beyond its retained list', () => {
  const untracked = Array.from({length: 21}, (_, index) => `src/new-${index}.py`);
  const evidence = collectWorkspaceEvidence('unused', ['src'], {execImpl: (command, args) => {
    if (args[0] === 'rev-parse') return {status: 0, stdout: 'true\n'};
    if (args[0] === 'ls-files') return {status: 0, stdout: untracked.join('\0') + '\0'};
    return {status: args.includes('--no-index') ? 1 : 0, stdout: ''};
  }});
  assert.equal(evidence.observable, true);
  assert.equal(evidence.untracked.length, 20);
  assert.equal(evidence.untrackedOmitted, 17);
});
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
    assert.equal(discoverCandidate({ session: "new", files: ["src/cache.py"], root: dir }).created, false);
    assert.equal(loadCandidate(saved.id, dir).state, "NEEDS_VERIFICATION");
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
  const meta = validatePromotionMetadata({ conceptName: "CacheInitRule", capsuleCategory: "rule", tags: "cache,init", relevance: "**/src/cache.py", verification: "file:///src/cache.py#symbol=init", ttlDays: 90, why: "init before query" }, lesson()).metadata;
  const cmd = promotionCommand(lesson(), meta);
  assert.deepEqual(cmd.args.slice(0, 4), ["concept", "add", "CacheInitRule", "rule"]);
  assert.ok(cmd.args.includes("**/src/cache.py"));
  assert.ok(cmd.args.includes("90"));
  assert.equal(cmd.shell, false);
  const evil = promotionCommand(lesson({ lesson: "Fix it $(echo PWNED) now", title: "T" }), meta);
  assert.equal(evil.args[4], "Fix it $(echo PWNED) now", "untrusted content remains one literal argument");
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
    assert.match(markPromoted({ id, root: dir, conceptId: "CacheInitRule" }).error, /verification|metadata|conceptName/);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("promotion reference must match the recorded metadata", async () => {
  const dir = scratch();
  try {
    discoverCandidate({ session: "mismatch", files: ["src/cache.py"], root: dir });
    const res = await evaluateCandidates({ root: dir, provider: PROVIDER, runRql: OK_RQL, modelCall: modelReturning(lesson()) });
    const id = res.outcomes[0].id;
    const ok = recordPromotionMetadata({ id, root: dir, metadata: { conceptName: "CacheInitRule", capsuleCategory: "rule", tags: "cache", relevance: "**/src/cache.py" } });
    assert.equal(ok.record.state, "AWAITING_APPROVAL");
    assert.equal(markPromoted({ id, root: dir, conceptId: "OtherName" }).ok, false);
    assert.equal(markPromoted({ id, root: dir, conceptId: "CacheInitRule" }).ok, false, "metadata alone proves neither approval nor an authoritative write");
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("dedup recovery preserves an operator-recorded command", async () => {
  const dir = scratch();
  try {
    discoverCandidate({ session: "keep-cmd", files: ["src/cache.py"], root: dir });
    const first = await evaluateCandidates({ root: dir, provider: PROVIDER, runRql: () => ({ status: 1 }), modelCall: modelReturning(lesson()) });
    const id = first.outcomes[0].id;
    const meta = recordPromotionMetadata({ id, root: dir, metadata: { conceptName: "CacheInitRule", capsuleCategory: "rule", tags: "cache", relevance: "**/src/cache.py" } });
    assert.ok(meta.record.promotion.command.args.includes("CacheInitRule"));
    assert.equal(meta.record.state, "NEEDS_VERIFICATION");
    const retry = await evaluateCandidates({ root: dir, runRql: OK_RQL, now: () => Date.now() + 300_000 });
    assert.equal(retry.outcomes[0].state, "AWAITING_APPROVAL");
    assert.ok(loadCandidate(id, dir).promotion.command.args.includes("CacheInitRule"));
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
    assert.equal(recordPromotionMetadata({ id, root: dir, metadata: { conceptName: "Bad!", capsuleCategory: "rule", tags: "a", relevance: "**/src/cache.py" } }).ok, false);
    assert.equal(recordPromotionMetadata({ id, root: dir, metadata: { conceptName: "WideScope", capsuleCategory: "rule", tags: "a", relevance: "**" } }).ok, false);
    const ok = recordPromotionMetadata({ id, root: dir, metadata: { conceptName: "CacheInitRule", capsuleCategory: "rule", tags: "cache,init", relevance: "**/src/cache.py", verification: "file:///src/cache.py#symbol=init", ttlDays: 90, why: "operator confirmed init order" } });
    assert.equal(ok.ok, true);
    assert.equal(ok.record.state, "AWAITING_APPROVAL");
    assert.ok(ok.record.promotion.command.args.includes("CacheInitRule"));
    assert.equal(ok.record.promotion.eligible, true);
    const promoted = markPromoted({ id, conceptId: "CacheInitRule", root: dir });
    assert.equal(promoted.ok, false);
    assert.equal(loadCandidate(id, dir).state, "AWAITING_APPROVAL");
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

// ---- native MemoryCore drafting fallback (opt-in, win32 only) ----
import { resolveFormulationProvider, resolveNativeMemoryCoreProvider } from "../scripts/selflearn-candidates.mjs";
import { symlinkSync } from "node:fs";

function nativeFixture(mutate = () => {}) {
  const local = mkdtempSync(join(tmpdir(), "native-mc-"));
  const memDir = join(local, "Singularity", "WindowsNative", "memory");
  mkdirSync(memDir, { recursive: true });
  const keyFile = join(memDir, "llm.key");
  writeFileSync(keyFile, "fixture-key-value\n");
  const stack = {
    schema: "native-memory-supervisor/v1",
    components: {
      gateway: { port: 18431 },
      core: { env: { TDAI_LLM_BASE_URL: "http://127.0.0.1:18431/v1", TDAI_LLM_MODEL: "extraction-failover" }, llmKeyFile: keyFile },
    },
  };
  mutate(stack, { memDir, keyFile });
  writeFileSync(join(memDir, "stack.json"), JSON.stringify(stack));
  return { local, memDir, keyFile, env: { LOCALAPPDATA: local } };
}

test("native MemoryCore provider is disabled by default and win32-only", () => {
  const f = nativeFixture();
  try {
    assert.equal(resolveFormulationProvider({ root: f.local, env: f.env }), null);
    assert.equal(resolveNativeMemoryCoreProvider({ env: f.env, platform: "linux" }), null);
    const p = resolveNativeMemoryCoreProvider({ env: f.env, platform: "win32" });
    assert.equal(p.source, "native-memorycore");
    assert.equal(p.native, true);
    assert.equal(p.key, "fixture-key-value");
    assert.equal(JSON.stringify(p).includes("fixture-key-value"), false);
    assert.ok(!Object.keys(p).includes("key"));
  } finally { rmSync(f.local, { recursive: true, force: true }); }
});

test("native MemoryCore provider is last: explicit providers win", () => {
  const f = nativeFixture();
  try {
    const env = { ...f.env, SINGULARITY_SELFLEARN_LLM_URL: "http://127.0.0.1:9/v1", SINGULARITY_SELFLEARN_LLM_MODEL: "m", SINGULARITY_SELFLEARN_LLM_KEY: "k" };
    const p = resolveFormulationProvider({ root: f.local, env, allowNativeMemoryCore: true });
    assert.ok(p);
    assert.notEqual(p.source, "native-memorycore");
    assert.equal(p.url, "http://127.0.0.1:9/v1");
  } finally { rmSync(f.local, { recursive: true, force: true }); }
});

for (const [name, mutate] of [
  ["wrong schema", (s) => { s.schema = "other/v1"; }],
  ["non-loopback host", (s) => { s.components.core.env.TDAI_LLM_BASE_URL = "http://10.0.0.5:18431/v1"; }],
  ["port mismatch", (s) => { s.components.core.env.TDAI_LLM_BASE_URL = "http://127.0.0.1:9999/v1"; }],
  ["wrong path", (s) => { s.components.core.env.TDAI_LLM_BASE_URL = "http://127.0.0.1:18431/other"; }],
  ["userinfo", (s) => { s.components.core.env.TDAI_LLM_BASE_URL = "http://u:p@127.0.0.1:18431/v1"; }],
  ["query string", (s) => { s.components.core.env.TDAI_LLM_BASE_URL = "http://127.0.0.1:18431/v1?x=1"; }],
  ["fragment", (s) => { s.components.core.env.TDAI_LLM_BASE_URL = "http://127.0.0.1:18431/v1#f"; }],
  ["empty model", (s) => { s.components.core.env.TDAI_LLM_MODEL = " "; }],
  ["missing key file", (s, c) => { s.components.core.llmKeyFile = join(c.memDir, "absent.key"); }],
]) {
  test("native MemoryCore provider is unavailable on " + name, () => {
    const f = nativeFixture(mutate);
    try { assert.equal(resolveNativeMemoryCoreProvider({ env: f.env, platform: "win32" }), null); }
    finally { rmSync(f.local, { recursive: true, force: true }); }
  });
}

test("native MemoryCore provider is unavailable for an empty key and a missing stack", () => {
  const f = nativeFixture();
  try {
    writeFileSync(f.keyFile, "  \n");
    assert.equal(resolveNativeMemoryCoreProvider({ env: f.env, platform: "win32" }), null);
    rmSync(join(f.memDir, "stack.json"));
    assert.equal(resolveNativeMemoryCoreProvider({ env: f.env, platform: "win32" }), null);
    assert.equal(resolveNativeMemoryCoreProvider({ env: {}, platform: "win32" }), null);
  } finally { rmSync(f.local, { recursive: true, force: true }); }
});

test("native MemoryCore provider refuses a symlinked key file when links can be created", (t) => {
  const f = nativeFixture();
  try {
    const real = join(f.local, "real.key");
    writeFileSync(real, "k");
    rmSync(f.keyFile);
    try { symlinkSync(real, f.keyFile); } catch { t.skip("symlink creation not permitted"); return; }
    assert.equal(resolveNativeMemoryCoreProvider({ env: f.env, platform: "win32" }), null);
  } finally { rmSync(f.local, { recursive: true, force: true }); }
});
