# Runtime parity — what the product now carries from the live system

> **Windows release update (2026-10-29):** RepoQL 1.7.18 is now the required native Windows target. This document describes earlier production observations using 1.7.15; those observations must not be relabeled as 1.7.18 test evidence. See `docs/WINDOWS-NATIVE-M18-REPOQL-UPGRADE.md`.

> **Native prompt sync (2026-11-13):** the additional hash-pinned L1 prompt
> is a staged native prepare transform, not a third image overlay. The historical
> eight-file image inventory below is unchanged. See `DOCKERHOST-SYNC-2026-11-13.md`.

**Answer first.** This change ports the parts of the live fleet runtime that are
*mechanism*, not someone's day: two pinned memory-stack overlays, the single
capture writer, the two read-only RepoQL connectors, the Ghost prompt store and
chain runner, and the Claude Office fork pin. It does **not** port the Ghost
dream/sweep/wake *content*, and it does not claim runtime acceptance. Every
overlay is pinned by hash, the source patch series is proven apply → reverse →
re-apply on Windows, and nothing here redistributes an upstream engine.

| Area | Carried | Pinned to | Proven by |
|---|---|---|---|
| MemoryCore overlay | 8 upstream files + 1 regression test, as a diff | TencentDB-Agent-Memory `v2.0.2` @ `99a1a2c`, tarball `11dab534…` | `tests/runtime-parity.patch-roundtrip.sh` — head/base hashes at every step |
| memory-hub overlay | One compiled parser bundle over a digest-pinned base | `agentmemory/memory-hub@sha256:53a3285b…` | Dockerfile asserts base hash, overlay hash, `node --check`, `PATCH-751` marker |
| Capture writer | Live consumer, runner, unit, timer, env contract | live 37,441-byte consumer | disabled by default, no identity defaults, own-container cleanup |
| RepoQL connectors | Kanzo + MemoryCore `1.0.0` source, synthetic fixtures | RepoQL host `1.7.15` | `SOURCE-SHA256` per file, grant assertions |
| Ghost | Versioned prompt store, prompt reader, chain runner, blank seeds | — | 8 unit tests + chain smoke test |
| Office | Fork pin + deployed override shape | `ali3nz/claude-office` `95d8bdc` | README/PROVENANCE agree; old `4ce0d00` pin removed |

## Single-writer contract (capture)

There is exactly one automatic capture writer. The supported owner is the host
timer plus the capture-only consumer in `memory/portable/`; the alternative is
the product-office plugin, never both. Capture is off unless an env file says
`CAPTURE_ENABLED=1`; the unit's env file is optional so an un-activated host has
an inert green unit instead of a red one on every tick. Identity (`TEAM_ID`,
`USER_ID`) has no default anywhere: a host that has not chosen its memory
identity does not capture. The full contract, including what the installer must
refuse, is in [`../memory/portable/README.md`](../memory/portable/README.md).

## Source inventory

What was read, and where. These are read-only source references; the shipped
files carry no fleet path.

| Source | What it is | Live version observed |
|---|---|---|
| `~/docker/tencent-memory/src/v2.0.2-99a1a2c/MemoryCore` | MemoryCore source under the running image | 8 files byte-identical to `tencent-memorycore:v2.0.2-99a1a2c-l1recordids1` (`sha256sum` inside the container on 2026-10-28) |
| `~/backups/tencent-memory/evidence/src-99a1a2c…tar.gz` | Pinned upstream tarball | sha256 `11dab534e0a11ce69de2f9eef309fa85d297b63fbfa63df20742a15d0a6267e0` |
| `~/docker/tencent-memory-hub/build-751/` | Hub overlay build context | `tencent-memory-hub:751-parser-fix` |
| `~/docker/tencent-memory/consumer/` | Capture consumer + units | 2026-10-26 20:16 NZDT |
| `~/docker/work/kanzo-repoql-connector-20261027/` | Kanzo connector source | `RepoQL.Connectors.Kanzo.1.0.0.nupkg` |
| `~/docker/work/repoql-connector-memorycore-20261027/connector/` | MemoryCore connector source | `Tencent.MemoryCore.1.0.0.nupkg` |
| `~/docker/ai-agents/companion/`, `~/docker/ghost-status/` | Ghost runtime | `ghost-chain.mjs` 12,489 B, `prompt_store.py` 11,451 B, `task-prompts.mjs` 1,819 B |
| `~/docker/claude-office` | Office fork checkout | HEAD `95d8bdc`, clean, deployed image `local/claude-office:layout-clock-20261027` |

Two drifts found while reading, and what was done about them:

1. **The capture unit and the compose file disagree on the image tag.** The
   live compose runs `tencent-memorycore:v2.0.2-99a1a2c-l1recordids1`; the live
   capture runner runs `tencent-memorycore:v2.0.2-99a1a2c` (no overlay). The
   consumer only needs Node inside that image, so capture is not wrong — but the
   tag should be one value. The port defaults both to the overlay tag.
2. **Office is four commits past the documented `4ce0d00` pin.** The product
   text was stale, not the deployment. The port pins the commit the running
   image was built from.

## What this cannot claim

- **No live acceptance.** No image was built in this work, no container was
  started, no install was run, no UI was opened. "Ported" means the source,
  pins and tests are here — not that option 2 or 4 works end to end.
- **No Ghost dream/sweep/wake content port.** The live implementations are
  75 KB / 88 KB / 41 KB of operator-specific text and fleet checks. Porting them
  faithfully is a product design change; `ghost/sweep/README.md` records exactly
  what stayed behind and why. The product's existing `ghost/dream.mjs` is
  untouched.
- **Connectors are not exercised by `rql connector test` here.** The host that
  can do that is pinned to RepoQL `1.7.15` on controller, which is outside this
  change's write boundary. What *is* proven: TypeScript syntax, manifest grants,
  synthetic-fixture wellformedness, and per-file source hashes. The live suites
  (`suite-multicall.json`, the recorded board samples) are real records and are
  deliberately not shipped.
- **The Kanzo connector makes HTTP GETs.** "No network calls" applies to the
  *installer*: nothing in this change reaches a production endpoint at install
  or test time. The connector's runtime grant is loopback-only, read-only, 6
  requests per minute, and is stated at install with `--allow-local-host`.
- **No host or runtime was upgraded.** The product host stays on RepoQL `1.7.15`
  (1.7.17 rejects the folder importer this product uses); Kanzo stays `v0.1.3`
  (0.2.1 is only newer, not required); MemoryCore stays `v2.0.2`.
- **No visual review of Office.** The geometry/sprite work described in the
  fleet's Office documentation is not verified here; the pin and the deployment
  shape are, the pixels are not.

## Integrator requirements

These belong to whoever lands the release; this change deliberately does not
touch them.

1. **`SHA256SUMS` / `MANIFEST.json`.** New files need entries: `memory/patches/**`,
   `memory/portable/**`, `connectors/**`, `ghost/chain.mjs`,
   `ghost/chain.example.json`, `ghost/task-prompts.mjs`, `ghost/prompt-store/**`,
   `ghost/sweep/README.md`, `compose/runtime-parity.override.yml`,
   `tests/runtime-parity.test.mjs`, `tests/runtime-parity.sh`,
   `tests/runtime-parity.patch-roundtrip.sh`, `docs/RUNTIME-PARITY.md`,
   `office/PROVENANCE.md`, `office/office.deployed.override.example.yml`.
   Do not regenerate the manifest to hide the existing 26-mismatch baseline;
   the drift gate stays as it is until that is fixed deliberately.
2. **`THIRD_PARTY_NOTICES.md`.** Three additions: TencentDB-Agent-Memory (MIT,
   derivative overlay + compiled hub bundle), the RepoQL connector API (MIT),
   and Claude Office / upstream `paulrobello/claude-office` (MIT, source pin
   only — not redistributed). Kanzo is **AGPL-3.0-only, separate unmodified
   process, not redistributed**; say that in the notices rather than listing it
   as bundled code.
3. **Installer (`scripts/install-claude-code.mjs`).** Options 1/3 must keep
   Ghost and Office absent; 2/4 include them. The new pieces that need wiring:
   capture owner selection (refuse two writers), the memory-stack image tags
   (overlay, not upstream), and the Ghost prompt-store directory
   (`GHOST_PROMPT_DIR`, default `/var/lib/ghost-control/prompts`) seeded from
   `ghost/prompt-store/seeds.json`. None of that is done here.
4. **`scripts/start.sh`.** `compose/runtime-parity.override.yml` is
   profile-gated and additive; it must not be added to a default start path, and
   a host must not run it *and* `memory/upstream/start-all.sh` (two MemoryCores).
5. **`docs/OFFICE-SETUP.md` and `README.md`.** If they name a fork revision,
   it has to become `95d8bdc`. `office/README.md` is updated here; the other two
   are not in this change's paths.
6. **The Ghost agent prompt** (`openchamber/agents/ghost.md`) is owned by another
   worker. This change does not read or write it.
7. **Dashboard UI / control HTTP bridge** are owned by another worker. Only the
   prompt store's storage contract is provided here so that worker can build
   against a stable shape.

## Verification performed

On the release host (WSL2 Ubuntu 24.04, Node `v22.20.0`, git `2.43.0`),
in a fresh checkout of `d5a227fa6f20dd7c5974dea8ed55322fe6429e9d` on branch
`runtime-parity-20261028`:

| Check | Result |
|---|---|
| `tests/runtime-parity.patch-roundtrip.sh` | PASS — tarball hash matches, apply → 9 head hashes ok → reverse → 9 base hashes ok → re-apply → 9 head hashes ok |
| `python3 test_prompt_store.py` | 8 tests, OK |
| `node ghost/chain.mjs` success / failure / plan | exit 0 / exit 1 with later step `skipped` / plan lists steps |
| `node --check` on new `.mjs`, `python3 -m py_compile` on new `.py` | clean |
| `node --test tests/runtime-parity.test.mjs` | see the gate output recorded with the handover |
| `git diff --check` | clean |

The exact command output is kept with the task evidence, not pasted here, so a
reader cannot mistake a transcript for a re-run.

## Reproducing a build

The engine is never redistributed, so a build starts from the public source:

```bash
# MemoryCore overlay
curl -fLO https://codeload.github.com/TencentCloud/TencentDB-Agent-Memory/tar.gz/99a1a2c251741658917e3fa700bf8e337ad15a5f
sha256sum -c <<< "11dab534e0a11ce69de2f9eef309fa85d297b63fbfa63df20742a15d0a6267e0  *.tar.gz"
tar xzf <tarball> && cd <extracted>/MemoryCore
patch -p1 -E --batch --forward < <repo>/memory/patches/core-v2.0.2-l1recordids/core-l1recordids.patch
docker build -t tencent-memorycore:v2.0.2-99a1a2c-l1recordids1 .

# Hub overlay
docker build -t tencent-memory-hub:751-parser-fix <repo>/memory/patches/hub-751
```
