#!/usr/bin/env node
// b/kit/v46-memory-retrieval-truth-test.mjs — fleet#1202 focused regressions.
// Covers the deterministic gates the five-outcome work touches:
//   1. W4 live-source ordering (backup sibling vs canonical file; directory scope;
//      query object vs string; no over-demotion of ordinary names)
//   2. W3 three-valued temporal eligibility (UNKNOWN never hides legacy knowledge)
//   3. W3 tombstone subject rejection + fail-closed unreadable index, exercised through
//      the real context-pack retrieval boundary with a fake RepoQL transport.
// Run: node b/kit/v46-memory-retrieval-truth-test.mjs
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { liveSourceOrder } from "./lib/repoql-client.mjs";
import { currentTruth, TEMPORAL_VERDICT } from "./lib/memory-temporal.mjs";

const T = mkdtempSync(join(tmpdir(), "v46-"));
const TOMBS = join(T, "tombstones");
mkdirSync(TOMBS, { recursive: true });
function tomb(name, subject, status = "active") {
  return `---\ncategory: tombstone\nstatus: ${status}\nsubject: ${subject}\nrejectedClaim: the rejected claim for ${subject}\nreason: test fixture\napprovedBy: operator\n---\n\n# ${name}\n`;
}
writeFileSync(join(TOMBS, "TombTombTest.md"), tomb("TombTombTest", "TombTest"));
writeFileSync(join(TOMBS, "TombRetired.md"), tomb("TombRetired", "RetiredCapsule", "retired"));
writeFileSync(join(TOMBS, "TombScopedOther.md"), tomb("TombScopedOther", "ScopedOther", "active").replace("reason: test fixture", "scope: concept:///other/**\nreason: test fixture"));
writeFileSync(join(TOMBS, "TombScopedKnowledge.md"), tomb("TombScopedKnowledge", "ScopedKnowledge", "active").replace("reason: test fixture", "scope: concept:///knowledge/**\nreason: test fixture"));
// Isolate tombstone/temporal fixture behavior from a deployment's independent
// lineage filter. The lineage fail-closed contract has its own regression suite.
process.env.ORCH_MEMORY_RETRIEVAL_FILTER = "DISABLED";
// memory-tombstone reads ORCH_TOMBSTONES_DIR at import time.
process.env.ORCH_TOMBSTONES_DIR = TOMBS;
const { tombstoneForSubject } = await import("./lib/memory-tombstone.mjs");
const { createBuildContextPack } = await import("./lib/context-pack.mjs");

let pass = 0, fail = 0;
function P(cond, label) {
  if (cond) { pass++; return; }
  fail++;
  console.error(`FAIL: ${label}`);
}

// ---- 1. W4 live-source ordering -------------------------------------------
const live = { uri: "local:///kit/lib/context-pack.mjs", score: 0.56 };
const backup = { uri: "local:///kit/lib/context-pack.mjs.pre-736-swap-20261019T021859Z", score: 0.59 };
const candidate = { uri: "local:///kit/lib/context-pack.mjs.candidate-736", score: 0.24 };
const backupOr = { uri: "local:///kit/lib/context-pack.mjs.bak-20261019", score: 0.10 };
const ordinary = { uri: "local:///kit/lib/backup-notes.mjs", score: 0.40 };
const ordinaryPre = { uri: "local:///kit/lib/preflight-check.mjs", score: 0.30 };

let ordered = liveSourceOrder([backup, live, candidate, backupOr], "buildContextPack");
P(ordered[0].uri === live.uri, "W4: backup siblings never outrank the canonical file for an exact symbol");
P(ordered.length === 4, "W4: ordering never drops a result");
P(ordered.find((r) => r.uri === backup.uri).score === 0.59, "W4: retrieval scores are preserved, not rewritten");

// A {q} plan entry is normalised, not stringified to [object Object].
ordered = liveSourceOrder([backup, live], { q: "context-pack.mjs" });
P(ordered[0].uri === live.uri, "W4: a {q} plan entry drives the exact-name preference");

// Same stem in a DIFFERENT directory is not a backup sibling.
ordered = liveSourceOrder([
  { uri: "local:///repo-b/src/config.mjs.bak", score: 0.9 },
  { uri: "local:///repo-a/src/config.mjs", score: 0.5 },
], "config");
P(ordered[0].uri === "local:///repo-b/src/config.mjs.bak", "W4: cross-directory same-stem files are not treated as siblings");

// Same directory, DIFFERENT extension is a different file, not an artifact of it.
ordered = liveSourceOrder([
  { uri: "local:///p/src/config.mjs.bak", score: 0.9 },
  { uri: "local:///p/src/config.js", score: 0.5 },
], "config");
P(ordered[0].uri === "local:///p/src/config.mjs.bak", "W4: same-directory different-extension file is not a sibling");

// Same directory + same filename (extension preserved) IS an artifact: demoted.
ordered = liveSourceOrder([
  { uri: "local:///p/src/config.mjs.bak", score: 0.9 },
  { uri: "local:///p/src/config.mjs", score: 0.5 },
], "config");
P(ordered[0].uri === "local:///p/src/config.mjs", "W4: same-directory same-filename artifact is demoted");

// An exact file query prefers that exact file over a same-stem sibling.
ordered = liveSourceOrder([
  { uri: "local:///p/src/config.js", score: 0.9 },
  { uri: "local:///p/src/config.mjs", score: 0.5 },
], "src/config.mjs");
P(ordered[0].uri === "local:///p/src/config.mjs", "W4: exact filename beats a same-stem sibling");

// Production shape measured 2026-11-11: stale backup 0.9, competing memory-orchestra
// context.mjs 0.72, canonical 0.5. Requirement: the stale artifact is never first and
// never outranks its own canonical source; an unrelated higher-scored file may still lead.
const prodBackup = { uri: "local:///kit/lib/context-pack.mjs.pre-736-swap-20261019T021859Z", score: 0.9 };
const prodCanonical = { uri: "local:///kit/lib/context-pack.mjs", score: 0.5 };
const competing = { uri: "local:///kit/lib/memory-orchestra/context.mjs", score: 0.72 };
ordered = liveSourceOrder([prodBackup, competing, prodCanonical], "buildContextPack");
P(ordered[0].uri !== prodBackup.uri, "W4: production shape — the stale backup is never first");
P(ordered.indexOf(prodCanonical) < ordered.indexOf(prodBackup), "W4: production shape — canonical outranks its stale backup");

// Same directory + stem: canonical wins and the ordinary names are untouched.
ordered = liveSourceOrder([ordinaryPre, ordinary, live], "context pack");
P(ordered[0].uri === live.uri, "W4: exact filename in the query outranks unrelated names");
P(ordered.find((r) => r.uri === ordinary.uri).score === 0.40 && ordered.find((r) => r.uri === ordinaryPre.uri).score === 0.30,
  "W4: ordinary names containing backup/pre are NOT demoted (scores unchanged)");

// ---- 2. W3 three-valued temporal eligibility -------------------------------
const noMeta = "---\ncategory: rule\n---\n\nBody without temporal frontmatter.";
const expired = "---\ncategory: rule\nvalidFrom: 2026-01-01T00:00:00Z\nvalidTo: 2026-02-01T00:00:00Z\n---\n\nBody.";
const future = "---\ncategory: rule\nvalidFrom: 2030-01-01T00:00:00Z\n---\n\nBody.";
const active = "---\ncategory: rule\nvalidFrom: 2026-01-01T00:00:00Z\nvalidTo: 2030-01-01T00:00:00Z\n---\n\nBody.";
const now = new Date("2026-11-11T00:00:00Z");

P(currentTruth({ capsuleBody: noMeta, now }) === TEMPORAL_VERDICT.MATCH, "W3: UNKNOWN temporal metadata never hides legacy knowledge");
P(currentTruth({ capsuleBody: expired, now }) === TEMPORAL_VERDICT.NO_MATCH, "W3: known expired validity is excluded from current truth");
P(currentTruth({ capsuleBody: future, now }) === TEMPORAL_VERDICT.NO_MATCH, "W3: known future validity is excluded from current truth");
P(currentTruth({ capsuleBody: active, now }) === TEMPORAL_VERDICT.MATCH, "W3: a fact inside its known validity window is current");
let threw = false;
try { currentTruth({ capsuleBody: "---\nvalidFrom: not-a-date\n---\n", now }); } catch { threw = true; }
P(threw, "W3: malformed temporal metadata is a hard error (callers record it, never guess)");

// ---- 3. W3 tombstone subject rejection ------------------------------------
P(tombstoneForSubject("TombTest", [{ subject: "TombTest", status: "active", name: "TombTombTest" }])?.name === "TombTombTest", "W3: active tombstone rejects its subject");
P(tombstoneForSubject("tombTest", [{ subject: "TombTest", status: "active", name: "TombTombTest" }])?.name === "TombTombTest", "W3: subject match is case-insensitive");
P(tombstoneForSubject("RetiredCapsule", [{ subject: "RetiredCapsule", status: "retired", name: "TombRetired" }]) === null, "W3: retired tombstone does not reject");
P(tombstoneForSubject("UnrelatedCapsule", [{ subject: "TombTest", status: "active" }]) === null, "W3: unrelated subject is not rejected");
P(tombstoneForSubject("", [{ subject: "TombTest", status: "active" }]) === null, "W3: empty subject never matches");
P(tombstoneForSubject("ScopedCaps", [{ subject: "ScopedCaps", status: "active", scope: "concept:///other/**" }], "concept:///knowledge/ScopedCaps.md") === null,
  "W3: a tombstone scoped elsewhere does not reject the capsule");
P(tombstoneForSubject("ScopedCaps", [{ subject: "ScopedCaps", status: "active", scope: "concept:///knowledge/**" }], "concept:///knowledge/ScopedCaps.md")?.subject === "ScopedCaps",
  "W3: an in-scope tombstone rejects the capsule");

// ---- 4. context-pack retrieval boundary ----------------------------------
const concept = (name, body) => ({ uri: `concept:///knowledge/${name}.md`, score: 1, body });
function fakeRepoql(name, body) {
  return {
    query: async () => ({ ok: true, results: [concept(name, body)] }),
    get: async () => ({ ok: true, content: body }),
  };
}
async function pack(name, body, opts = {}) {
  const build = createBuildContextPack({ repoql: fakeRepoql(name, body), repoqlPrimary: true });
  return build({ stage: opts.stage ?? "PLAN", mandatory: { task: "v46 fixture" }, historicalQueries: ["fixture"], historicalMode: opts.historicalMode });
}

// Only an exact rejected invariant is tombstoned, never a capsule name alone.
let r = await pack("TombTest", "---\ncategory: knowledge\n---\n**Invariant**\nthe rejected claim for TombTest\n\n**Evidence**\nRejected body.");
P(!r.pack.includes("Rejected body"), "W3-pack: an exact tombstoned invariant never enters the current pack");
P((r.manifest.omitted || []).some((o) => /tombstone:/i.test(o.omissionReason || "")), "W3-pack: the tombstone drop is recorded in the manifest");
// A corrected claim on the same subject must stay eligible.
r = await pack("TombTest", "---\ncategory: knowledge\n---\n**Invariant**\nthe corrected claim for TombTest\n\n**Evidence**\nCorrected body.");
P(r.pack.includes("Corrected body"), "W3-pack: a corrected invariant is not rejected by an older subject tombstone");

// retired tombstone does not exclude
r = await pack("RetiredCapsule", "---\ncategory: knowledge\n---\nRetired-body.");
P(r.pack.includes("Retired-body"), "W3-pack: a retired tombstone does not exclude the capsule");

// UNKNOWN temporal metadata is preserved
r = await pack("UnknownCaps", "---\ncategory: knowledge\n---\nUnknown-temporal-body.");
P(r.pack.includes("Unknown-temporal-body"), "W3-pack: legacy capsule without temporal metadata is preserved");

// known-expired capsule is excluded from a current pack
r = await pack("ExpiredCaps", "---\ncategory: knowledge\nvalidTo: 2026-02-01T00:00:00Z\n---\nExpired-body.");
P(!r.pack.includes("Expired-body"), "W3-pack: a known-expired capsule is excluded from current retrieval");
P((r.manifest.omitted || []).some((o) => /temporal:outside-validity-window/.test(o.omissionReason || "")), "W3-pack: the temporal drop is recorded");

// historicalMode retrieves the superseded fact on explicit request
r = await pack("ExpiredCaps", "---\ncategory: knowledge\nvalidTo: 2026-02-01T00:00:00Z\n---\nExpired-body.", { historicalMode: true });
P(r.pack.includes("Expired-body"), "W3-pack: explicit historical retrieval may return a superseded capsule");

// malformed temporal metadata is kept and recorded, never silently hidden
r = await pack("BadTemporal", "---\ncategory: knowledge\nvalidFrom: not-a-date\n---\nMalformed-body.");
P(r.pack.includes("Malformed-body"), "W3-pack: malformed temporal metadata does not hide a legacy capsule");
P((r.manifest.currentTruth?.problems || []).some((p) => /temporal-malformed/.test(p.problem || "")), "W3-pack: malformed temporal metadata is recorded");

// scope is part of the tombstone contract: a tombstone for another URI prefix must not
// exclude this capsule, while one covering its URI prefix must.
r = await pack("ScopedOther", "---\ncategory: knowledge\n---\nScoped-other-body.");
P(r.pack.includes("Scoped-other-body."), "W3-pack: a tombstone scoped elsewhere does not exclude the capsule");
r = await pack("ScopedKnowledge", "---\ncategory: knowledge\n---\n**Invariant**\nthe rejected claim for ScopedKnowledge\n\n**Evidence**\nScoped-knowledge-body.");
P(!r.pack.includes("Scoped-knowledge-body."), "W3-pack: an in-scope tombstone excludes an exact rejected invariant");

// Current-only lineage filtering must never suppress explicitly historical or
// REVIEW retrieval, even when a stale or invalid sidecar exists.
const LINEAGE = join(T, "lineage");
mkdirSync(LINEAGE, { recursive: true });
writeFileSync(join(LINEAGE, "ExpiredCaps.json"), JSON.stringify({ recordId: "ExpiredCaps", lineageState: "stale" }));
writeFileSync(join(LINEAGE, "InvalidCaps.json"), JSON.stringify({ recordId: "InvalidCaps", lineageState: "invalid" }));
process.env.ORCH_LINEAGE_DIR = LINEAGE;
process.env.ORCH_MEMORY_RETRIEVAL_FILTER = "ENABLED";
r = await pack("ExpiredCaps", "---\ncategory: knowledge\n---\nStale-lineage-body.");
P(!r.pack.includes("Stale-lineage-body."), "W3-pack: stale lineage is excluded from current retrieval");
P((r.manifest.omitted || []).some(o => /lineage:stale/.test(o.omissionReason ?? "")), "W3-pack: current lineage exclusion is audited");
r = await pack("ExpiredCaps", "---\ncategory: knowledge\n---\nStale-lineage-body.", { historicalMode: true });
P(r.pack.includes("Stale-lineage-body."), "W3-pack: historical mode bypasses current lineage exclusion");
P(r.manifest.lineageFilter?.historicalBypass === true, "W3-pack: historical lineage bypass is recorded");
r = await pack("InvalidCaps", "---\ncategory: knowledge\n---\nInvalid-lineage-body.", { stage: "REVIEW" });
P(r.pack.includes("Invalid-lineage-body."), "W3-pack: REVIEW stage bypasses current lineage exclusion");
process.env.ORCH_MEMORY_RETRIEVAL_FILTER = "DISABLED";

// fail closed: an unreadable/corrupt tombstone plane must not admit a capsule
writeFileSync(join(TOMBS, "TombCorrupt.md"), "not a tombstone frontmatter");
r = await pack("AnythingCapsule", "---\ncategory: knowledge\n---\nUnverified-plane-body.");
P(!r.pack.includes("Unverified-plane-body"), "W3-pack: unreadable tombstone plane fails closed (capsule not admitted)");
P((r.manifest.omitted || []).some((o) => /tombstone-index-unverified/.test(o.omissionReason || "")), "W3-pack: fail-closed reason is recorded");

console.log(JSON.stringify({ suite: "v46-memory-retrieval-truth", pass, fail, rc: fail ? 1 : 0 }));
process.exitCode = fail ? 1 : 0;
