// The installer's four options must be driven by the ONE component table
// (scripts/bundle-classification.mjs): options 1/3 ship core only, options 2/4
// ship Ghost + Office, and an unclassified package file blocks every option
// instead of silently shipping with the wrong one.
import { test } from "node:test";
import assert from "node:assert/strict";
import { resolveVariant } from "./install-claude-code.mjs";

const deps = {
  detectOpenchamberInstance: () => ({ kind: "native", configDir: "/tmp/does-not-matter" }),
  ghostSetupExists: () => true,
  officeComposeExists: () => true,
};

test("each of the four options resolves with a classification-verified component set", () => {
  for (const v of ["1", "2", "3", "4"]) {
    const r = resolveVariant({ variant: v, scope: "user", skipProfiles: false }, deps);
    assert.equal(r.problems.some((p) => /component set/.test(p)), false, `option ${v}: ${r.problems.join("; ")}`);
    assert.ok(r.notes.some((n) => n.includes(`component set verified for option ${v}`)),
      `option ${v} must report its verified component set: ${r.notes.join(" | ")}`);
  }
});

test("options 1/3 are core only; options 2/4 include Ghost and Office", () => {
  const note = (v) => resolveVariant({ variant: v, scope: "user" }, deps).notes.join(" ");
  assert.match(note("1"), /core only \(no Ghost, no Office\)/);
  assert.match(note("3"), /core only \(no Ghost, no Office\)/);
  assert.match(note("2"), /core \+ Ghost \+ Office/);
  assert.match(note("4"), /core \+ Ghost \+ Office/);
});

test("an unclassified package file blocks the option (never ships silently)", () => {
  const blocked = resolveVariant({ variant: "1", scope: "user" }, {
    ...deps,
    auditComponentSet: () => ({
      ok: false,
      problems: ["unclassified shipped file(s) — assign an explicit component: vendor/new.js"],
      installedFiles: [],
      counts: { core: 0, ghost: 0, office: 0 },
    }),
  });
  assert.equal(blocked.ok, false);
  assert.match(blocked.problems.join(" "), /component set does not match option 1/);
  assert.match(blocked.problems.join(" "), /vendor\/new\.js/);
});

test("a Ghost/Office leak into a core-only option is refused", () => {
  const leak = resolveVariant({ variant: "3", scope: "user" }, {
    ...deps,
    auditComponentSet: () => ({
      ok: false,
      problems: ["option 3 must not install ghost files (1 leaked: openchamber/agents/ghost.md)"],
      installedFiles: [], counts: { core: 1, ghost: 1, office: 0 },
    }),
  });
  assert.equal(leak.ok, false);
  assert.match(leak.problems.join(" "), /must not install ghost files/);
});
