// Regression tests: current-truth retrieval must fail closed when the
// controller cannot prove tombstone/lineage state (2026-10-31).
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, chmodSync, rmSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFileSync } from "node:child_process";
import { loadTombstones } from "../lib/memory-tombstone.mjs";
import * as tombstoneModule from "../lib/memory-tombstone.mjs";
import { createBuildContextPack } from "../lib/context-pack.mjs";
import { excludeInvalidFromCurrentRetrieval } from "../lib/memory-lineage.mjs";

function fakeSsh(body) {
  const dir = mkdtempSync(join(tmpdir(), "fresh-ssh-"));
  writeFileSync(join(dir, "ssh"), `#!/bin/sh\n${body}\n`);
  chmodSync(join(dir, "ssh"), 0o755);
  return dir;
}

async function withSsh(body, fn) {
  const dir = fakeSsh(body);
  const saved = process.env.PATH;
  process.env.PATH = `${dir}:${saved}`;
  try { return await fn(); } finally { process.env.PATH = saved; }
}

test("tombstone index fails closed when the controller is unreachable", async () => {
  await withSsh("exit 255", () => {
    const r = loadTombstones("/definitely/absent/tombstones");
    assert.equal(r.ok, false);
    assert.equal(r.code, "TOMBSTONE_INDEX_UNREACHABLE");
  });
});

test("an existing local parent does not make a missing tombstone directory local", async () => {
  const parent = mkdtempSync(join(tmpdir(), "fresh-local-parent-"));
  try {
    await withSsh("exit 255", () => {
      const r = loadTombstones(join(parent, "tombstones"));
      assert.equal(r.ok, false);
      assert.equal(r.code, "TOMBSTONE_INDEX_UNREACHABLE");
    });
  } finally {
    rmSync(parent, { recursive: true, force: true });
  }
});

test("a demonstrably absent directory is an empty tombstone store", async () => {
  const parent = mkdtempSync(join(tmpdir(), "fresh-absent-parent-"));
  try {
    // The fake ssh EXECUTES the real remote command locally, so this exercises
    // the probe semantics rather than a canned answer.
    await withSsh('shift\nexec sh -c "$1"', () => {
      const r = loadTombstones(join(parent, "tombstones"));
      assert.equal(r.ok, true);
      assert.deepEqual(r.tombstones, []);
    });
  } finally {
    rmSync(parent, { recursive: true, force: true });
  }
});

test("the remote probe distinguishes a file, a missing dir and an inaccessible parent", () => {
  const parent = mkdtempSync(join(tmpdir(), "fresh-probe-shape-"));
  try {
    const file = join(parent, "tombstones");
    const dangling = join(parent, "dangling-tombstones");
    writeFileSync(file, "not a directory");
    symlinkSync(join(parent, "no-such-target"), dangling);
    const run = (target) => execFileSync("sh", ["-c", tombstoneModule.tombstoneProbeCommand(target)], { encoding: "utf8" }).trim();
    assert.equal(run(file), "NOT_A_DIRECTORY");
    assert.equal(run(file + "/"), "NOT_A_DIRECTORY", "a trailing slash must not hide an existing file");
    assert.equal(run(file + "///"), "NOT_A_DIRECTORY");
    assert.equal(run(dangling), "NOT_A_DIRECTORY");
    assert.equal(run(dangling + "/"), "NOT_A_DIRECTORY", "a trailing slash must not hide a dangling symlink");
    assert.equal(run(join(parent, "absent")), "ABSENT");
    assert.equal(run(join(parent, "missing-parent", "tombstones")), "UNVERIFIABLE");
  } finally {
    rmSync(parent, { recursive: true, force: true });
  }
});

test("a trailing slash cannot turn an existing file into an absent store", () => {
  const parent = mkdtempSync(join(tmpdir(), "fresh-slash-store-"));
  try {
    const file = join(parent, "tombstones");
    writeFileSync(file, "not a directory");
    const r = loadTombstones(file + "/");
    assert.equal(r.ok, false);
    assert.equal(r.code, "TOMBSTONE_INDEX_UNREADABLE");
  } finally {
    rmSync(parent, { recursive: true, force: true });
  }
});

test("an invalid or unverifiable store is never reported absent", async () => {
  await withSsh('case "$*" in *"echo NOT_A_DIRECTORY"*) echo NOT_A_DIRECTORY; exit 0 ;; *) exit 255 ;; esac', () => {
    const r = loadTombstones("/definitely/absent/tombstones");
    assert.equal(r.ok, false);
    assert.equal(r.code, "TOMBSTONE_INDEX_UNREADABLE");
  });
  await withSsh('case "$*" in *"echo UNVERIFIABLE"*) echo UNVERIFIABLE; exit 0 ;; *) exit 255 ;; esac', () => {
    const r = loadTombstones("/definitely/absent/tombstones");
    assert.equal(r.ok, false);
    assert.equal(r.code, "TOMBSTONE_INDEX_UNREACHABLE");
  });
});

test("an unexpected controller answer is not accepted as absence", async () => {
  await withSsh('case "$*" in *"echo PRESENT"*) echo MAYBE; exit 0 ;; *) exit 255 ;; esac', () => {
    const r = loadTombstones("/definitely/absent/tombstones");
    assert.equal(r.ok, false);
    assert.equal(r.code, "TOMBSTONE_INDEX_UNREACHABLE");
  });
});

test("context pack omits concept hits when lineage evidence cannot be read", async () => {
  await withSsh("exit 255", async () => {
    const saved = {
      lineage: process.env.ORCH_LINEAGE_DIR,
      filter: process.env.ORCH_MEMORY_RETRIEVAL_FILTER,
    };
    process.env.ORCH_LINEAGE_DIR = "/definitely/absent/lineage";
    process.env.ORCH_MEMORY_RETRIEVAL_FILTER = "ENABLED";
    try {
      let fetched = false;
      const uri = "concept://rule/RejectedConcept";
      const pack = createBuildContextPack({
        repoqlPrimary: true,
        repoql: {
          query: async () => ({ ok: true, results: [{ uri, score: 1 }] }),
          get: async () => { fetched = true; return { ok: false }; },
        },
      });
      const { manifest } = await pack({ stage: "PLAN", historicalQueries: ["probe"] });
      assert.equal(fetched, false);
      assert.equal(manifest.lineageFilter.failClosed, true);
      assert.ok(manifest.omitted.some((o) => o.item === uri));
    } finally {
      if (saved.lineage == null) delete process.env.ORCH_LINEAGE_DIR;
      else process.env.ORCH_LINEAGE_DIR = saved.lineage;
      if (saved.filter == null) delete process.env.ORCH_MEMORY_RETRIEVAL_FILTER;
      else process.env.ORCH_MEMORY_RETRIEVAL_FILTER = saved.filter;
    }
  });
});

test("context pack fails closed on a corrupt local lineage sidecar", async () => {
  const lineage = mkdtempSync(join(tmpdir(), "fresh-lineage-corrupt-"));
  writeFileSync(join(lineage, "CorruptConcept.json"), "{not-json");
  const saved = {
    lineage: process.env.ORCH_LINEAGE_DIR,
    filter: process.env.ORCH_MEMORY_RETRIEVAL_FILTER,
  };
  process.env.ORCH_LINEAGE_DIR = lineage;
  process.env.ORCH_MEMORY_RETRIEVAL_FILTER = "ENABLED";
  try {
    assert.throws(() => excludeInvalidFromCurrentRetrieval(["CorruptConcept"], lineage));
    let fetched = false;
    const uri = "concept://rule/CorruptConcept";
    const pack = createBuildContextPack({
      repoqlPrimary: true,
      repoql: {
        query: async () => ({ ok: true, results: [{ uri, score: 1 }] }),
        get: async () => { fetched = true; return { ok: false }; },
      },
    });
    const { manifest } = await pack({ stage: "PLAN", historicalQueries: ["probe"] });
    assert.equal(fetched, false);
    assert.equal(manifest.lineageFilter.failClosed, true);
    assert.ok(manifest.omitted.some((o) => o.item === uri));
  } finally {
    if (saved.lineage == null) delete process.env.ORCH_LINEAGE_DIR;
    else process.env.ORCH_LINEAGE_DIR = saved.lineage;
    if (saved.filter == null) delete process.env.ORCH_MEMORY_RETRIEVAL_FILTER;
    else process.env.ORCH_MEMORY_RETRIEVAL_FILTER = saved.filter;
  }
});
