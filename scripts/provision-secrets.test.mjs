// Unit tests for the Memory Core credential propagation rules of the
// provisioner (scripts/provision-secrets.py, B7).
//
// The provisioner is executed for real (python3) against temporary base
// directories. The admin and scoped values are SYNTHETIC test strings — never
// real credentials — and the tests assert only booleans and paths, so no value
// is printed by the test itself.
//
// Run: node --test scripts/provision-secrets.test.mjs
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const SCRIPT = resolve(dirname(fileURLToPath(import.meta.url)), "provision-secrets.py");
const ADMIN = `TESTADMIN-${"0".repeat(40)}`;
const SCOPED = `TESTSCOPED-${"1".repeat(40)}`;

/** A base directory holding a memory stack with a known administrative key. */
function makeBase() {
  const b = mkdtempSync(join(tmpdir(), "provision-base-"));
  mkdirSync(join(b, "memory", "upstream"), { recursive: true });
  writeFileSync(join(b, "memory", "upstream", ".admin-key"), `${ADMIN}\n`);
  return b;
}

const run = (b, args) => spawnSync("python3", [SCRIPT, "--base-dir", b, ...args], { encoding: "utf8" });
const memoryJson = (b) => join(b, "data", "opencode", "config", "product-secrets", "memory.json");
const readMem = (b) => JSON.parse(readFileSync(memoryJson(b), "utf8"));
const outputOf = (r) => `${r.stdout}\n${r.stderr}`;

test("the former administrative-key fallback flag is refused and writes nothing", () => {
  const b = makeBase();
  const r = run(b, ["--allow-admin-plugin-key"]);
  assert.equal(r.status, 2, outputOf(r));
  assert.equal(existsSync(memoryJson(b)), false, "a refused run leaves no plugin file");
  assert.doesNotMatch(outputOf(r), new RegExp(ADMIN));
});

test("an administrative key passed as the plugin key is REFUSED before any write (B7)", () => {
  const b = makeBase();
  const r = run(b, ["--variant", "2", "--memory-user-key", ADMIN]);
  assert.equal(r.status, 2, outputOf(r));
  assert.match(outputOf(r), /ADMINISTRATIVE/);
  assert.equal(existsSync(memoryJson(b)), false, "no plugin file is written");
  assert.equal(existsSync(join(b, "secrets", "claude-office.env")), false, "no Office secret is written by a refused run");
  assert.doesNotMatch(outputOf(r), new RegExp(ADMIN), "the admin value is never printed");
});

test("a scoped key is written and the administrative value never is (B7)", () => {
  const b = makeBase();
  const r = run(b, ["--variant", "1", "--memory-user-key", SCOPED]);
  assert.equal(r.status, 0, outputOf(r));
  const mem = readMem(b);
  assert.equal(mem.userKey, SCOPED, "the scoped key is the plugin identity");
  assert.ok(!JSON.stringify(mem).includes(ADMIN), "the administrative value is nowhere in the plugin config");
  assert.doesNotMatch(outputOf(r), new RegExp(ADMIN));
});

test("a stale administrative userKey already on disk is REPAIRED, never preserved (B7)", () => {
  const b = makeBase();
  mkdirSync(join(b, "data", "opencode", "config", "product-secrets"), { recursive: true });
  writeFileSync(memoryJson(b), JSON.stringify({ userKey: ADMIN, gatewayKey: "", baseUrl: "http://memory-core:8420" }));
  const r = run(b, ["--variant", "1", "--memory-user-key", SCOPED]);
  assert.equal(r.status, 0, outputOf(r));
  assert.equal(readMem(b).userKey, SCOPED);
  assert.ok(!JSON.stringify(readMem(b)).includes(ADMIN));
});

test("without a scoped key the userKey stays EMPTY and the administrative value is removed", () => {
  const b = makeBase();
  mkdirSync(join(b, "data", "opencode", "config", "product-secrets"), { recursive: true });
  writeFileSync(memoryJson(b), JSON.stringify({ userKey: ADMIN }));
  const r = run(b, ["--variant", "1"]);
  assert.equal(r.status, 0, outputOf(r));
  assert.equal(readMem(b).userKey, "", "an empty userKey is INCOMPLETE downstream, never a stand-in");
  assert.ok(!JSON.stringify(readMem(b)).includes(ADMIN));
  assert.doesNotMatch(outputOf(r), new RegExp(ADMIN));
});
