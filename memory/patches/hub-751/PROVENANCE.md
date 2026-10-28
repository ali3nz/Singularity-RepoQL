# Provenance — memory-hub `751` parser overlay

| Field | Value |
|---|---|
| Base image | `agentmemory/memory-hub@sha256:53a3285b6444628384fc0b9a1b5da66558daddbed8aba880ee66d390764b7c6a` |
| Base bundle under overlay | `/app/knowledge/dist/ingest-v2-CSw_7GGw.mjs` |
| Base bundle sha256 (asserted by the Dockerfile) | `c63a85473c2337ddc83699d82d268c71b0f73f3dc0a08afb18c257b7a6e7ff3a` |
| Overlay file | `patch/ingest-v2-CSw_7GGw.mjs` |
| Overlay sha256 | `8ff062420227290a56c4251705ce4aed631a437874362272e9935369c7225c54` |
| Live image | `tencent-memory-hub:751-parser-fix` |

## What this is

The hub's knowledge-ingest parser is a compiled bundle inside a published
image. Upstream #751 (wiki re-ingest of a failed raw source) is fixed by
replacing that one bundle, not by rebuilding the hub from source — the base
image is used unmodified and pinned by digest.

The `Dockerfile` is deliberately paranoid, and it is the acceptance test:

1. it asserts the sha256 of the base bundle **before** copying over it, so a
   changed base image fails the build instead of silently accepting an overlay
   onto a different program;
2. it `node --check`s the overlay;
3. it asserts the sha256 of the overlay it just copied (one added line over the live
   build context: the live context checked the base, not its own overlay), then greps
   for the `PATCH-751` marker, so a replaced or truncated file fails;
4. it greps that `dist/server.mjs` still imports the file name it replaces.

An image that builds is therefore an image whose overlay actually landed on the
reviewed base.

## Derivative-work notice

`patch/ingest-v2-CSw_7GGw.mjs` is a compiled derivative of the Tencent
MemoryKnowledge ingest parser (MIT, Copyright (C) 2026 Tencent) and is
distributed under the same MIT terms. The `PATCH-751` marker and the fix itself
are ours; everything else is upstream-licensed code.

## Build

```bash
docker build -t tencent-memory-hub:751-parser-fix memory/patches/hub-751
```

The build needs network access to pull the pinned base image. Nothing in it
calls a fleet endpoint, and it publishes nothing.

## Tests

`tests/` holds the parser regression (`parse.test.mjs`), its runner
(`run-tests.sh`), and two diagnostics (`diag.mjs`, `summary.mjs`). They run
against the overlay bundle inside the built image:

```bash
docker run --rm --entrypoint sh tencent-memory-hub:751-parser-fix \
  -lc 'cd /app/knowledge && node tests/parse.test.mjs'
```
