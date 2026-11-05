import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { cohereQuota } from "./cohere-quota.mjs";

const roots = [];
function dir() { const d = mkdtempSync(join(tmpdir(), "cohere-quota-")); roots.push(d); return d; }
process.on("exit", () => { for (const p of roots) { try { rmSync(p, { recursive: true, force: true }); } catch {} } });

test("counts each authorised attempt exactly once", () => {
  const file = join(dir(), "q.json");
  const now = Date.parse("2026-10-17T00:00:00Z");
  for (let i = 1; i <= 3; i++) {
    const r = cohereQuota({ file, monthlyCap: 10, reserve: 5, now });
    assert.equal(r.allowed, true);
    assert.equal(r.attempts, i);
  }
  const ledger = JSON.parse(readFileSync(file, "utf8"));
  assert.equal(ledger.attempts, 3);
});

test("refuses once the routine limit is reached", () => {
  const file = join(dir(), "q.json");
  const now = Date.parse("2026-10-17T00:00:00Z");
  assert.equal(cohereQuota({ file, monthlyCap: 5, reserve: 3, now }).allowed, true);
  assert.equal(cohereQuota({ file, monthlyCap: 5, reserve: 3, now }).allowed, true);
  const third = cohereQuota({ file, monthlyCap: 5, reserve: 3, now });
  assert.equal(third.allowed, false);
  assert.equal(third.reason, "routine-limit-reached");
});

test("serialises concurrent reservations without duplicate slots", async () => {
  const file = join(dir(), "q.json");
  const now = Date.parse("2026-10-17T00:00:00Z");
  const results = await Promise.all([
    Promise.resolve(cohereQuota({ file, monthlyCap: 10, reserve: 5, now })),
    Promise.resolve(cohereQuota({ file, monthlyCap: 10, reserve: 5, now })),
  ]);
  assert.equal(results.filter(r => r.allowed).length, 2);
  assert.deepEqual(results.map(r => r.attempts).sort(), [1, 2]);
});

test("fails closed on a malformed ledger", () => {
  const file = join(dir(), "q.json");
  writeFileSync(file, "{not json");
  const r = cohereQuota({ file, monthlyCap: 10, reserve: 5, now: Date.now() });
  assert.equal(r.allowed, false);
  assert.equal(r.reason, "unreadable-ledger");
});

test("resets on month rollover", () => {
  const file = join(dir(), "q.json");
  const oct = Date.parse("2026-10-20T00:00:00Z");
  const nov = Date.parse("2026-11-02T00:00:00Z");
  cohereQuota({ file, monthlyCap: 10, reserve: 5, now: oct });
  const r = cohereQuota({ file, monthlyCap: 10, reserve: 5, now: nov });
  assert.equal(r.allowed, true);
  assert.equal(r.attempts, 1);
});
