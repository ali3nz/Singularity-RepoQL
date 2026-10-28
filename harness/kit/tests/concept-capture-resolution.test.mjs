// Ticket 799 I3: fixture-only tests for relevance resolution and universal aliasing.
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, chmodSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { captureConcept, queryGlobMatchCount, resolveRelevanceGlobs, mapCandidatesToConcepts } from "../lib/concept-capture.mjs";

const candidate = (extra = {}) => ({
  name: "Ticket799ResolverProbe",
  category: "rule",
  invariant: "A dry-run must prove every relevance glob resolves before capture.",
  tags: "ticket799,resolution",
  relevance: "**/services/tencent-memorycore.md",
  ...extra,
});
const opts = (dir, extra = {}) => ({
  dryRun: true,
  conceptsDir: dir,
  tombstonesDir: join(dir, "absent-tombstones"),
  lineageDir: join(dir, "absent-lineage"),
  ...extra,
});
function fakeRql(dir, count) {
  const bin = join(dir, "rql-fixture.sh");
  const argsFile = join(dir, "rql-args.txt");
  writeFileSync(bin, `#!/bin/sh\nprintf '%s\\n' "$*" > '${argsFile}'\nprintf '[{"matches":${count}}]\\n'\n`);
  chmodSync(bin, 0o755);
  return { bin, argsFile };
}

test("RepoQL glob resolver queries glob_files and parses a zero-match count", async () => {
  const dir = mkdtempSync(join(tmpdir(), "i3-rql-zero-"));
  const { bin, argsFile } = fakeRql(dir, 0);
  const saved = process.env.RQL_BIN;
  process.env.RQL_BIN = bin;
  try {
    const r = await queryGlobMatchCount("**/ai-orchestration/kit/**");
    assert.deepEqual(r, { ok: true, count: 0 });
    assert.match((await import("node:fs")).readFileSync(argsFile, "utf8"), /glob_files/);
    assert.match((await import("node:fs")).readFileSync(argsFile, "utf8"), /ai-orchestration\/kit/);
  } finally {
    if (saved === undefined) delete process.env.RQL_BIN; else process.env.RQL_BIN = saved;
  }
});

test("dry-run refuses all-zero relevance without writing", async () => {
  const dir = mkdtempSync(join(tmpdir(), "i3-dryrun-zero-"));
  const r = await captureConcept(candidate(), opts(dir, { resolveGlob: async () => ({ ok: true, count: 0 }) }));
  assert.equal(r.ok, false);
  assert.equal(r.code, "UNRESOLVED_RELEVANCE");
  assert.match(r.detail, /no relevance glob matched/);
});

test("dry-run drops only zero-match globs and retains resolved scopes", async () => {
  const dir = mkdtempSync(join(tmpdir(), "i3-drop-zero-"));
  const r = await captureConcept(candidate({ relevance: "**/services/tencent-memorycore.md;**/no-such-ticket799.md" }),
    opts(dir, { resolveGlob: async (g) => ({ ok: true, count: g.includes("no-such") ? 0 : 1 }) }));
  assert.equal(r.ok, true, JSON.stringify(r));
  assert.deepEqual(r.relevanceResolution.resolved, ["**/services/tencent-memorycore.md"]);
  assert.deepEqual(r.relevanceResolution.dropped, ["**/no-such-ticket799.md"]);
  assert.equal(r.args.includes("--relevance"), true);
  assert.equal(r.args[r.args.indexOf("--relevance") + 1], "**/services/tencent-memorycore.md");
});

test("isUniversal false maps to contextual true, true maps to universal", async () => {
  const dir = mkdtempSync(join(tmpdir(), "i3-universal-alias-"));
  const resolver = async () => ({ ok: true, count: 1 });
  const contextual = await captureConcept(candidate({ isUniversal: false }), opts(dir, { resolveGlob: resolver }));
  assert.equal(contextual.ok, true, JSON.stringify(contextual));
  assert.equal(contextual.args.includes("--universal"), false);
  const universal = await captureConcept(candidate({ name: "Ticket799UniversalProbe", isUniversal: true }), opts(dir, { resolveGlob: resolver }));
  assert.equal(universal.ok, true, JSON.stringify(universal));
  assert.equal(universal.args.includes("--universal"), true);
});

test("conflicting universal aliases fail closed", async () => {
  const dir = mkdtempSync(join(tmpdir(), "i3-universal-conflict-"));
  const r = await captureConcept(candidate({ isUniversal: false, contextual: false }), opts(dir, { resolveGlob: async () => ({ ok: true, count: 1 }) }));
  assert.equal(r.ok, false);
  assert.equal(r.code, "INVALID_CANDIDATE");
  assert.match(r.detail, /conflicts with contextual/);
});


test("principles cannot be made contextual by a legacy false alias", async () => {
  const dir = mkdtempSync(join(tmpdir(), "i3-principle-universal-"));
  const r = await captureConcept({ name: "Ticket799ContextualPrincipleProbe", category: "principle", invariant: "Principles remain universal even when legacy aliases are supplied.", tags: "ticket799,universal", isUniversal: false }, opts(dir));
  assert.equal(r.ok, false);
  assert.equal(r.code, "INVALID_CANDIDATE");
  assert.match(r.detail, /principles are universal/);
});


// Operator directive 2026-10-27 (scoped self-learning): scope must never widen
// because a caller forgot a field.
test("an omitted contextual stays contextual", async () => {
  const dir = mkdtempSync(join(tmpdir(), "i799-omit-contextual-"));
  const r = await captureConcept(candidate(), opts(dir, { resolveGlob: async () => ({ ok: true, count: 1 }) }));
  assert.equal(r.ok, true, JSON.stringify(r));
  assert.equal(r.args.includes("--universal"), false, "omission must not become universal");
  assert.equal(r.contextual, true, "omission resolves to contextual scope");
});

test("explicit universal still works", async () => {
  const dir = mkdtempSync(join(tmpdir(), "i799-explicit-universal-"));
  const r = await captureConcept(candidate({ isUniversal: true }), opts(dir, { resolveGlob: async () => ({ ok: true, count: 1 }) }));
  assert.equal(r.ok, true, JSON.stringify(r));
  assert.equal(r.args.includes("--universal"), true);
  assert.equal(r.contextual, false);
});

test("source-qualified relevance is accepted, relative is refused", async () => {
  const dir = mkdtempSync(join(tmpdir(), "i799-source-qualified-"));
  const ok = await captureConcept(candidate({ relevance: "github://example-org/example-repo/kit/**" }),
    opts(dir, { resolveGlob: async () => ({ ok: true, count: 16 }) }));
  assert.equal(ok.ok, true, JSON.stringify(ok));
  const bad = await captureConcept(candidate({ relevance: "src/**" }), opts(dir, { resolveGlob: async () => ({ ok: true, count: 1 }) }));
  assert.equal(bad.ok, false);
  assert.equal(bad.code, "INVALID_CANDIDATE");
  assert.match(bad.detail, /relevance/);
});


// Operator directive 2026-10-27: an auto-candidate may not carry a fabricated
// scope. Without a real one it is held, never published as **/work/**.
test("candidate mapping never fabricates a scope", () => {
  const base = { kind: "implementation_invariant", claim: "Workers must not publish a concept without an established scope.", why: "directive" };
  const none = mapCandidatesToConcepts([{ ...base, id: 1 }]);
  assert.equal(none.ready.length, 0);
  assert.equal(none.held.length, 1);
  assert.match(none.held[0].reason, /no established relevance scope/);
  const broad = mapCandidatesToConcepts([{ ...base, id: 2, relevance: "**/work/**" }]);
  assert.equal(broad.ready.length, 0, "**/work/** must never be mapped");
  const narrow = mapCandidatesToConcepts([{ ...base, id: 3, relevance: "**/services/tencent-memorycore.md" }]);
  assert.equal(narrow.ready.length, 1);
  assert.equal(narrow.ready[0].relevance, "**/services/tencent-memorycore.md");
  const source = mapCandidatesToConcepts([{ ...base, id: 4, relevance: "github://example-org/example-repo/kit/**" }]);
  assert.equal(source.ready.length, 1, "source-qualified relevance is supported");
});
