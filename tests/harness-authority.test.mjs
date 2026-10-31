// tests/harness-authority.test.mjs — single engine authority, dormant Rust.
//
// The architecture decision this freezes: the kit is the harness's ONE engine
// authority, the launcher is verb-preserving, and the Rust state authority ships
// dormant and opt-in. Nothing here builds, starts or selects Rust.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const ROOT = resolve(fileURLToPath(new URL("../", import.meta.url)));
const read = (rel) => readFileSync(join(ROOT, rel), "utf8");
const harnessConfig = JSON.parse(read("harness/harness.config.json"));

test("the Rust authority protocol version is frozen at 1", async () => {
  const mod = await import(pathToFileURL(join(ROOT, "harness", "kit", "lib", "rust-authority.mjs")).href);
  assert.equal(mod.PROTOCOL_VERSION, 1);
  assert.equal(harnessConfig.rustAuthority.protocolVersion, 1);
});

test("the Rust authority ships dormant, never as the default", () => {
  assert.equal(harnessConfig.rustAuthority.mode, "dormant");
  assert.equal(harnessConfig.rustAuthority.binary, null);
  assert.equal(harnessConfig.rustAuthority.socket, null);
});

test("the launcher uses the real ORCHESTRA_* names and never selects an authority", () => {
  const src = read("bin/ai-orchestra");
  // Spelling guard: the mangled token ("ORCH" + "RA") must not appear anywhere.
  const mangled = "ORCH" + "RA_";
  assert.ok(!src.includes(mangled), "launcher contains a mangled ORCHRA_* token");
  assert.ok(/ORCHESTRA_KIT_HOME/.test(src), "launcher reads ORCHESTRA_KIT_HOME");
  assert.ok(!/process\.env\.ORCHESTRA_RUST_AUTHORITY\s*=/.test(src), "launcher assigns ORCHESTRA_RUST_AUTHORITY");
  assert.ok(!/rust-authority/.test(src), "launcher references the rust authority module");
});

test("the frozen authority protocol env names are declared and consumed", () => {
  const kit = read("harness/kit/lib/rust-authority.mjs");
  const env = {
    AUTHORITY: "ORCHESTRA_RUST_AUTHORITY",
    ROLLBACK: "ORCHESTRA_RUST_AUTHORITY_ROLLBACK",
    TOKEN: "ORCHESTRA_RUST_AUTHORITY_TOKEN",
    TOKEN_FILE: "ORCHESTRA_RUST_AUTHORITY_TOKEN_FILE",
    LEASE_MS: "ORCHESTRA_RUST_AUTHORITY_LEASE_MS",
  };
  for (const [key, name] of Object.entries(env)) {
    assert.ok(kit.includes(`"${name}"`), `AUTHORITY_ENV.${key} must declare the frozen name ${name}`);
  }
  const rust = read("harness/rust-authority/src/authority.rs") + read("harness/rust-authority/src/main.rs");
  for (const name of [env.AUTHORITY, env.TOKEN, env.TOKEN_FILE]) {
    assert.ok(rust.includes(name), `the dormant Rust authority must consume ${name}`);
  }
  // LEASE_MS is declared in the contract; the dormant binary does not read it yet.
  assert.ok(!rust.includes("ORCHESTRA_AUTHORITY_"), "Rust must not use the un-frozen ORCHESTRA_AUTHORITY_* names");
});

test("the engine defaults to the JavaScript authority", () => {
  const src = read("harness/kit/orchestrate.mjs");
  // The Rust path is opt-in through kit config/env; the file-backed state stays
  // the default. Assert the authority module is only reached through an
  // explicit selector rather than being wired unconditionally.
  assert.ok(/rust-authority\.mjs/.test(src), "expected the engine to reference the authority module");
  assert.ok(!/ORCHESTRA_RUST_AUTHORITY\s*=\s*["']1["']/.test(src), "engine hard-enables the Rust authority");
});

test("the Rust authority is never enabled by default", () => {
  assert.notEqual(harnessConfig.rustAuthority.enabled, true, "rustAuthority.enabled must not be true by default");
  for (const rel of ["compose/compose.yml", "compose/runtime-parity.override.yml", "harness/harness.config.json"]) {
    const src = read(rel);
    assert.ok(!/ORCHESTRA_RUST_AUTHORITY\s*=/.test(src), `${rel} must not enable the Rust authority`);
  }
});

test("a dormant authority is not shipped as a runnable service", () => {
  const src = read("harness/rust-authority/Cargo.toml");
  assert.match(src, /name\s*=\s*"[a-z0-9_-]+"/);
  // No installer, unit or compose file may start it.
  for (const forbidden of ["harness/rust-authority/orchestra-authority.service", "harness/rust-authority/docker-compose.yml"]) {
    assert.throws(() => read(forbidden), /ENOENT/, `${forbidden} must not exist`);
  }
});
