# Provenance — RepoQL connectors

Both connectors are the live `1.0.0` packages' source, ported into this
repository. `SOURCE-SHA256` in each connector directory lists the sha256 of every
file **as committed here**; it is generated from the files themselves and
re-checked by `tests/runtime-parity.test.mjs`, so it cannot drift silently.

**Windows release target:** RepoQL 1.7.18, connector ABI 1. The product setup builds both `1.0.0` packages with that CLI and pins their exact bytes in [`packages.lock.json`](packages.lock.json); the source and package fixture suites pass. A live install, index and readback still requires operator consent and is not claimed here. The 1.7.15 entry below is historical provenance for the production package, not the Windows release pin.

## Kanzo (`kanzo/`)

| Field | Value |
|---|---|
| Live source | `~/docker/work/kanzo-repoql-connector-20261027/` |
| Live package | `dist/RepoQL.Connectors.Kanzo.1.0.0.nupkg` |
| Scheme / version | `kanzo`, `1.0.0` |
| Connector host built against | RepoQL `1.7.15` (client `1.7.17`) |
| Board it was built against | Kanzo `v0.1.3` (AGPL-3.0-only, separate process) |

### Edits made while porting

Only identifiers that named the fleet were replaced; no logic changed.

| File | Edit |
|---|---|
| `README.md` | example board keys use the generic `work#12` |
| `connector.ts` | help string uses the generic `work#3` |
| `help/layout.md` | example board keys use the generic `work#12` |
| `manifest.yaml` | unchanged (loopback host + 6 rpm grant already portable) |

The board URL `http://localhost:4242` is the board's documented loopback
default. For a non-default port, change it in both `manifest.yaml`
(`network.hosts`) and `connector.ts` (`BASE`), then rebuild — the manifest is
what the host enforces, and the two must agree.

## MemoryCore (`memorycore/`)

| Field | Value |
|---|---|
| Live source | `~/docker/work/repoql-connector-memorycore-20261027/connector/` |
| Live package | `../Tencent.MemoryCore.1.0.0.nupkg` |
| Scheme / version | `memorycore`, `1.0.0` |

### Edits made while porting

| File | Edit |
|---|---|
| `manifest.yaml` | `source.roots.data.default` `~/docker/tencent-memory/data` → `~/tencent-memory/data` |
| `README.md` | install example and the "manifest suggests" paragraph now use `~/tencent-memory/data` |
| `connector.ts` | one comment named a real team/agent pair; replaced with `team%3Ateam-fixture%7Cagent%3Aagt-fixture` |
| `fixtures/` | `vectors.db` stubs removed; every fixture keeps invented content and `*-fixture` ids |

## What is not redistributed

- The built `.nupkg` files (build artifacts).
- The Kanzo board's data, SQLite file or service binary.
- Any real MemoryCore record, profile, vector database or checkpoint.
- The fleet's identity map (`team-c3…`, `usr-c1…`, `agt-…`): no such id appears
  in any committed file. `tests/runtime-parity.test.mjs` fails if one reappears.
