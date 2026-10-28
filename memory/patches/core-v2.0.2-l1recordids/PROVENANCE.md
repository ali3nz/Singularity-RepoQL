# Provenance — MemoryCore `l1recordids` source overlay

| Field | Value |
|---|---|
| Upstream project | [TencentCloud/TencentDB-Agent-Memory](https://github.com/TencentCloud/TencentDB-Agent-Memory) |
| Upstream revision | tag `v2.0.2`, commit `99a1a2c251741658917e3fa700bf8e337ad15a5f` |
| Upstream subpath | `MemoryCore/` |
| Upstream license | MIT — see `memory/upstream/LICENSE` (byte-exact, vendored) |
| Pinned tarball | `https://codeload.github.com/TencentCloud/TencentDB-Agent-Memory/tar.gz/99a1a2c251741658917e3fa700bf8e337ad15a5f` |
| Pinned tarball sha256 | `11dab534e0a11ce69de2f9eef309fa85d297b63fbfa63df20742a15d0a6267e0` |
| Patch file | `core-l1recordids.patch` |
| Patch sha256 | recorded in `series.json` (`patch.sha256`) — hashes here would drift |
| Live image the head was read from | `tencent-memorycore:v2.0.2-99a1a2c-l1recordids1` |

## What this is

Eight modified files and one added regression test, exported as a unified diff.
`series.json` lists every path with its exact `base_sha256` and `head_sha256`;
that file, not this page, is the machine-readable authority.

The head content was not taken from a description of the change. On 2026-10-28,
`sha256sum` inside the running container `tencent-memorycore` returned values
**byte-identical** to the eight source files this series was cut from, so the
series describes what the live image actually runs.

The changes are, in order of appearance:

- `core/record/l1-extractor.ts` — extraction guards.
- `core/store/sqlite/memory-store.ts` — honour `recordIds` on L1 lookups (the
  `l1recordids` in the image tag). Without it SQLite returned every L1 row,
  which made `atomic/update` target the wrong record.
- `core/tdai-core.ts`, `gateway/server.ts`, `gateway/v2-router.ts`,
  `services/pipeline-worker.ts`, `utils/pipeline-factory.ts` — L2 cursor,
  flush route, pipeline drain and session-lock behaviour behind the same work.
- `adapters/standalone/llm-runner.ts` — the standalone model fallback ladder.
- the `issue712` ladder regression test — offline regression for that ladder
  (local mock OpenAI-compatible servers, no external network).

## Derivative-work notice

This overlay is a **derivative work** of TencentDB-Agent-Memory and is
distributed under the same MIT terms. Copyright (C) 2026 Tencent. The diff
format is our packaging, not an upstream artifact; the change content is
upstream-licensed code.

## Rebuilding

1. Fetch the pinned tarball and verify its sha256 against the table above.
2. Extract; `cd MemoryCore`.
3. `patch -p1 -E --batch --forward < core-l1recordids.patch`.
4. `docker build -t tencent-memorycore:v2.0.2-99a1a2c-l1recordids1 .`
   (the upstream `MemoryCore/Dockerfile` is used unmodified).

No network access is needed after step 1; nothing here calls a fleet endpoint.
