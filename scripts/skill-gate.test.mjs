#!/usr/bin/env node
// scripts/skill-gate.test.mjs — verification gate contract tests.
//bun test scripts/skill-gate.test.mjs
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, readFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  buildAuthHeaders,
  memorySkillCall,
  verifySkill,
  runGate,
  gateStatus,
  verifyChain,
  readLedger,
} from "./skill-gate.mjs";

const CFG = { authPrefix: "K ", gatewayKey: "SECRET-DO-NOT-PRINT", serviceId: "tdai-memory-core", userKey: "user-key-1" };

// A mock /v3/skill store: records calls, serves list & delete.
function makeMockStore({ activeItems, listError = null, codeMutator = null } = {}) {
  const calls = [];
  const impl = async (url, init) => {
    const path = String(url).split("/v3/skill/")[1] || "";
    const body = init?.body ? JSON.parse(init.body) : {};
    calls.push({ sub: path, body, headers: { ...init?.headers } });
    const respond = (obj) => ({ status: 200, text: async () => JSON.stringify(obj) });
    if (listError && path === "list") throw new Error(listError);
    if (path === "list") return respond({ code: 0, data: { items: activeItems } });
    if (path === "delete") return respond({ code: 0, data: { ok: true } });
    if (codeMutator) return codeMutator(path, body);
    return respond({ code: 0, data: {} });
  };
  return { calls, impl };
}

function tmpRoot() {
  const root = mkdtempSync(join(tmpdir(), "sg-root-"));
  return root;
}

function withEvidenceFile(root, rel = "evidence.txt", body = "step-1 ok\nstep-2 ok\n") {
  mkdirSync(join(root, rel, ".."), { recursive: true });
  writeFileSync(join(root, rel), body);
  return rel;
}

function verifiedSkill(skill_id = "s-good", extra = {}) {
  return {
    skill_id, name: "rotate-extraction-credentials", description: "how to rotate provider creds",
    content: "step one: locate secrets/nvidia-api-provider.json; step two: probe with nvidia-probe.py; step three: update memory.json",
    metadata_json: JSON.stringify({
      gate: { evidence: { files: extra.filesHint || ["evidence.txt"], repoQueries: [] } },
    }),
    content_hash: "hash-" + skill_id, created_at_ms: 1000, status: "active", team_id: "t1", owner_agent_id: "extracter-1",
    ...extra,
  };
}

test("auth headers are built from config and malformed configs are refused", () => {
  const h = buildAuthHeaders(CFG);
  assert.equal(h["x-tdai-service-id"], "tdai-memory-core");
  assert.match(h.Authorization, /^K /);
  assert.throws(() => buildAuthHeaders({ gatewayKey: "K", serviceId: "S" }), /missing/);
});

test("memorySkillCall enforces the application envelope: code != 0 is an error, HTTP 200 alone is not success", async () => {
  let calls = 0;
  const store = makeMockStore({ activeItems: [] });
  // application-level failure: HTTP 200 with code != 0
  let threw = null;
  try {
    await memorySkillCall("http://x", CFG, "list", {}, { fetchImpl: async () => ({ status: 200, text: async () => JSON.stringify({ code: 401, message: "bad key" }) }) });
  } catch (e) { threw = e; }
  assert.match(String(threw), /application code 401/);
  // transport-level failure: HTTP 404
  threw = null;
  try {
    await memorySkillCall("http://x", CFG, "list", {}, { fetchImpl: async () => ({ status: 404, text: async () => "not found" }) });
  } catch (e) { threw = e; }
  assert.match(String(threw), /HTTP 404/);
  // success envelope passes through
  const body = await memorySkillCall("http://x", CFG, "list", {}, { fetchImpl: async () => ({ status: 200, text: async () => JSON.stringify({ code: 0, data: { items: [] } }) }) });
  assert.deepEqual(body.data.items, []);
});

test("fail-closed: skills without gate metadata are UNVERIFIED (archived), verified ones keep active status", () => {
  const root = tmpRoot();
  withEvidenceFile(root);
  const good = verifiedSkill("s-good");
  const bad = verifiedSkill("s-bad", { metadata_json: null, name: "auto-extracted-nothing" });
  const vGood = verifySkill(good, { root, rqlAvailable: false, existing: [] });
  const vBad = verifySkill(bad, { root, rqlAvailable: false, existing: [] });
  assert.equal(vGood.verdict, "verified", JSON.stringify(vGood));
  assert.equal(vBad.verdict, "unverified");
  assert.ok(vBad.reasons[0].includes("no gate.evidence metadata"));
  rmSync(root, { recursive: true, force: true });
});

test("missing evidence files fail the verdict; present files with repoQueries hit pass", () => {
  const root = tmpRoot();
  const rel = withEvidenceFile(root);
  const s = verifiedSkill("s-files", { metadata_json: JSON.stringify({ gate: { evidence: { files: [rel], repoQueries: ["x"] } } }) });
  // rql missing → the file evidence carries the verdict (recorded as limited) when rqlAvailable=false
  const v = verifySkill(s, { root, rqlAvailable: false, existing: [] });
  assert.equal(v.verdict, "verified", JSON.stringify(v));
  // points to a non-existent path → fail-closed
  const bad = verifiedSkill("s-files-bad", { metadata_json: JSON.stringify({ gate: { evidence: { files: ["data/does/not/exist.txt"], repoQueries: [] } } }) });
  const vBad = verifySkill(bad, { root, rqlAvailable: false, existing: [] });
  assert.equal(vBad.verdict, "unverified", JSON.stringify(vBad));
  assert.ok(vBad.reasons.some((r) => r.includes("evidence file missing")));
  rmSync(root, { recursive: true, force: true });
});

test("duplicate detection archives the newer copy and keeps the older one", () => {
  const rel = "e.txt";
  const root = tmpRoot();
  withEvidenceFile(root, rel);
  const older = verifiedSkill("older", { created_at_ms: 1000, name: "rotate creds procedure", description: "rotate provider creds", filesHint: [rel] });
  const newer = verifiedSkill("newer", { created_at_ms: 2000, name: "rotate creds procedure", description: "rotate provider creds", filesHint: [rel] });
  // the older one stays verifiable (skip duplicates within verify when already incapable) — keep it verified
  const vOlder = verifySkill(older, { root, rqlAvailable: false, existing: [] });
  assert.equal(vOlder.verdict, "verified");
  const vNewer = verifySkill(newer, { root, rqlAvailable: false, existing: [older] });
  assert.equal(vNewer.verdict, "duplicate");
  assert.equal(vNewer.duplicateOf.skill_id, "older");
  rmSync(root, { recursive: true, force: true });
});

test("runGate archives unverified skills via /v3/skill/delete and appends hash-chained ledger rows", async () => {
  const root = tmpRoot();
  const rel = withEvidenceFile(root);
  const good = verifiedSkill("s-good", { metadata_json: JSON.stringify({ gate: { evidence: { files: [rel], repoQueries: [] } } }) });
  const bad = verifiedSkill("s-bad", { metadata_json: null, name: "empty-capsule-no-provenance" });
  const store = makeMockStore({ activeItems: [good, bad] });
  const ledger = join(root, "ledger.jsonl");
  const out = await runGate({ root, base: "http://mock", cfg: CFG, ledgerPath: ledger, fetchImpl: store.impl, dryRun: false, rqlAvailable: false });
  assert.equal(out.ok, true, out.error || "");
  assert.equal(out.summary.archived, 1);
  assert.equal(out.summary.verified, 1);
  const deleteCalls = store.calls.filter((c) => c.sub === "delete");
  assert.equal(deleteCalls.length, 1);
  assert.equal(deleteCalls[0].body.skill_id, "s-bad");
  // ledger: two rows, hash-chained
  const rows = readLedger(ledger);
  assert.equal(rows.length, 2);
  const chain = verifyChain(ledger);
  assert.equal(chain.ok, true, JSON.stringify(chain));
  rmSync(root, { recursive: true, force: true });
});

test("runGate is idempotent: already-decided skill hashes are skipped on a second run", async () => {
  const root = tmpRoot();
  const rel = withEvidenceFile(root);
  const good = verifiedSkill("s-good", { metadata_json: JSON.stringify({ gate: { evidence: { files: [rel], repoQueries: [] } } }) });
  const store = makeMockStore({ activeItems: [good] });
  const ledger = join(root, "ledger.jsonl");
  await runGate({ root, base: "http://mock", cfg: CFG, ledgerPath: ledger, fetchImpl: store.impl, dryRun: false, rqlAvailable: false });
  const store2 = makeMockStore({ activeItems: [good] });
  const out2 = await runGate({ root, base: "http://mock", cfg: CFG, ledgerPath: ledger, fetchImpl: store2.impl, dryRun: false, rqlAvailable: false });
  assert.equal(out2.ok, true);
  assert.equal(out2.summary.skipped, 1);
  assert.equal(out2.summary.verified, 0);
  assert.equal(out2.summary.archived, 0);
  assert.equal(store2.calls.filter((c) => c.sub === "delete").length, 0);
  // ledger unchanged (still 1 row)
  assert.equal(readLedger(ledger).length, 1);
  rmSync(root, { recursive: true, force: true });
});

test("runGate dry-run makes no writes and appends nothing", async () => {
  const root = tmpRoot();
  withEvidenceFile(root, "d.txt");
  const bad = verifiedSkill("s-bad", { metadata_json: null, name: "no-provenance" });
  const store = makeMockStore({ activeItems: [bad] });
  const ledger = join(root, "ledger.jsonl");
  const out = await runGate({ root, base: "http://mock", cfg: CFG, ledgerPath: ledger, fetchImpl: store.impl, dryRun: true, rqlAvailable: false });
  assert.equal(out.ok, true, out.error || "");
  assert.equal(out.dryRun ?? out.summary.dryRun, true);
  assert.equal(store.calls.filter((c) => c.sub === "delete").length, 0);
  assert.equal(existsSync(ledger), false);
  rmSync(root, { recursive: true, force: true });
});

test("store outage fails the run without fabricating success", async () => {
  const root = tmpRoot();
  const store = makeMockStore({ activeItems: [], listError: "ECONNREFUSED" });
  const out = await runGate({ root, base: "http://mock", cfg: CFG, ledgerPath: join(root, "l.jsonl"), fetchImpl: store.impl, dryRun: false, rqlAvailable: false });
  assert.equal(out.ok, false);
  assert.equal(out.exitCode, 1);
  assert.match(String(out.error), /ECONNREFUSED|refused/i);
  rmSync(root, { recursive: true, force: true });
});

test("no secret value appears in any gate output or ledger", async () => {
  const root = tmpRoot();
  withEvidenceFile(root, "e.txt");
  const good = verifiedSkill("s-good", { metadata_json: JSON.stringify({ gate: { evidence: { files: ["e.txt"], repoQueries: [] } } }) });
  const bad = verifiedSkill("s-bad", { metadata_json: null, name: "no-provenance" });
  const store = makeMockStore({ activeItems: [good, bad] });
  const ledger = join(root, "l.jsonl");
  const out = await runGate({ root, base: "http://mock", cfg: CFG, ledgerPath: ledger, fetchImpl: store.impl, dryRun: false, rqlAvailable: false });
  const blob = JSON.stringify(out) + readFileSync(ledger, "utf8");
  assert.ok(!blob.includes(CFG.gatewayKey), "gateway key leaked");
  assert.ok(!blob.includes(CFG.userKey), "user key leaked");
  rmSync(root, { recursive: true, force: true });
});

test("gateStatus summarizes decisions and verifies the chain", async () => {
  const root = tmpRoot();
  withEvidenceFile(root, "e.txt");
  const good = verifiedSkill("s-good", { metadata_json: JSON.stringify({ gate: { evidence: { files: ["e.txt"], repoQueries: [] } } }) });
  const bad = verifiedSkill("s-bad", { metadata_json: null, name: "no-provenance" });
  const store = makeMockStore({ activeItems: [good, bad] });
  const ledger = join(root, "l.jsonl");
  await runGate({ root, base: "http://mock", cfg: CFG, ledgerPath: ledger, fetchImpl: store.impl, dryRun: false, rqlAvailable: false });
  const s = await gateStatus({ root, ledgerPath: ledger });
  assert.equal(s.chain.ok, true);
  assert.equal(s.by.verified, 1);
  assert.equal(s.by.unverified, 1);
  rmSync(root, { recursive: true, force: true });
});

test("tampered ledger rows break the chain verification", async () => {
  const root = tmpRoot();
  withEvidenceFile(root, "e.txt");
  const good = verifiedSkill("s-good", { metadata_json: JSON.stringify({ gate: { evidence: { files: ["e.txt"], repoQueries: [] } } }) });
  const bad = verifiedSkill("s-bad", { metadata_json: null, name: "no-provenance" });
  const store = makeMockStore({ activeItems: [good, bad] });
  const ledger = join(root, "l.jsonl");
  await runGate({ root, base: "http://mock", cfg: CFG, ledgerPath: ledger, fetchImpl: store.impl, dryRun: false, rqlAvailable: false });
  // tamper: flip a verdict in the first row
  let raw = readFileSync(ledger, "utf8");
  const j = JSON.parse(raw.split("\n")[0]);
  j.record.verdict = "unverified"; // a distinct value — a no-op flip would be a vacuous tamper
  writeFileSync(ledger, JSON.stringify(j) + "\n" + raw.split("\n").slice(1).join("\n"));
  const c = verifyChain(ledger);
  assert.equal(c.ok, false);
  assert.ok(["broken chain", "content hash mismatch"].includes(c.detail));
  rmSync(root, { recursive: true, force: true });
});
