# Memory patches — curated overlay exports

This directory carries the **curated** changes Singularity applies on top of the
vendored upstream memory stack (`memory/upstream/`). It exists so a reader can
see exactly what a live image adds to upstream source, and so a build can
reproduce the same image without redistributing the upstream engine.

`memory/upstream/` is byte-exact and is never edited. Everything here is an
overlay: a patch series, an overlay Dockerfile, and the provenance that pins
what the overlay was cut from.

| Overlay | Base | What it changes |
|---|---|---|
| [`core-v2.0.2-l1recordids/`](core-v2.0.2-l1recordids/) | TencentDB-Agent-Memory `v2.0.2` @ `99a1a2c` (MIT), `MemoryCore/` | Eight source files plus one regression test: the L1 `recordIds` lookup honouring, the standalone model-fallback ladder, and the pipeline/extraction guards behind them. |
| [`hub-751/`](hub-751/) | `agentmemory/memory-hub` image @ `sha256:53a3285b…` | One file overlay: the knowledge-ingest parser bundle, plus its own tests. The Dockerfile fails closed if the base bundle is not the reviewed digest. |

## Why patches and not a fork

- **Attribution stays explicit.** Every file here is a derivative of MIT-licensed
  Tencent source; each directory carries the upstream project, revision
  (`PROVENANCE.md`), and the base/head hashes of every touched file.
- **The upstream engine is not redistributed.** `core-v2.0.2-l1recordids`
  ships diffs only. Rebuilding needs the pinned public tarball, whose sha256 is
  recorded in `series.json`; `tests/runtime-parity.patch-roundtrip.sh` refuses
  to run against a tarball with a different hash.
- **Roundtrip is the acceptance test.** A series that cannot be applied *and*
  reversed to the exact base hashes is not a curated export. That is what the
  roundtrip test proves, on Windows, before release.

## Applying

From an extracted upstream `MemoryCore/` directory (the copy produced by the
pinned tarball):

```bash
patch -p1 -E --batch --forward  < <series-dir>/core-l1recordids.patch
patch -p1 -E --batch --reverse  < <series-dir>/core-l1recordids.patch   # undo
```

`-E` matters: reversing a file creation with GNU patch removes the emptied
file. `git apply` leaves a zero-byte file behind, which would silently hide a
series that cannot be reversed; the roundtrip test therefore uses `patch`.

A `.patch` file is a verbatim unified diff, so its blank context lines begin
with a space. That is what `git diff --check` calls trailing whitespace; the
whitespace gate excludes `memory/patches/*/*.patch` for that reason, and the
roundtrip test is what proves the series.

## Not included

- The fleet's private configuration, identity map, team/user ids, endpoint
  URLs, ledger, memories, dreams and vector store: those are runtime state, not
  source, and none of them belong in a public repository.
- Any built image or image layer. `memory/portable/` documents the build recipe
  and the tags the live host runs; the build itself is the operator's.
