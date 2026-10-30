# RepoQL connectors — Kanzo and MemoryCore

Two read-only RepoQL connectors, ported from the live fleet runtime at their
shipped versions (`1.0.0`). They copy a source's own records into the workspace
so a question can find a card or a memory beside the code, and they never write
back to the source.

| Package | Scheme | Source it reads | Transport |
|---|---|---|---|
| [`kanzo/`](kanzo/) | `kanzo://board` | A Kanzo board | HTTP GET against the board's own **loopback** API |
| [`memorycore/`](memorycore/) | `memorycore://data` | A Tencent MemoryCore data folder | Local files only, read-only |

## Why these are here

Singularity's product promise is that RepoQL is authoritative and recall is
bounded. A product install that cannot see its own board or its own memory store
is a REPL with a file browser. These connectors are the supported, versioned way
to make both visible, with the grant written down instead of implied.

## Grants — what each one is allowed to do

The grant is part of the package, not a setting a reader has to discover.

### Kanzo

- **Host:** `http://localhost:4242` only, marked `local: true`. This is the
  board's own loopback listener. There is no other host in the manifest.
- **Method:** `GET` only. The board's API has no authentication, so nothing is
  ever sent with a request and no credential is stored.
- **Rate:** `requestsPerMinute: 6`. A sweep is every 900 s and compares the whole
  board; a card's comments are fetched only when the card or the board's change
  counter moved.
- **Install needs the loopback allowance made explicit:**

  ```bash
  rql connector install RepoQL.Connectors.Kanzo.1.0.0.nupkg \
      --allow-local-host http://localhost:4242
  ```

  A connector that reaches localhost without that flag is refused by the host,
  which is the behaviour we want: the grant is stated at install time.

### MemoryCore

- **Network:** none. It reads files under one configured source root.
- **Source root:** `--source-root data=<folder>`. The manifest's default is a
  suggestion (`~/tencent-memory/data`), not a requirement; the installer sets
  the folder the store's own service writes.
- **Read-only:** it never writes to the source root and the store's service stays
  the folder's only writer. Raw conversations, vectors and checkpoints are
  deliberately left out; one file per L1 record, L2 scene block and L3 persona is
  copied, with the store's own ids and provenance.

## Building

Windows release target: build both connectors with RepoQL CLI **1.7.18** (connector ABI 1). The user reports that 1.7.18 fixes the 1.7.17 compatibility regression; this is **not yet verified against the actual Windows CLI**. Production may remain on its previously proven 1.7.15. Do not reuse connector packages across CLI versions without a real install, indexing and readback test:

```bash
cd connectors/kanzo
rql connector types .                       # writes/refreshes repoql-connector.d.ts
rql connector test connector.ts --fixtures <suite>   # offline, no host, no network
rql connector pack connector.ts --id RepoQL.Connectors.Kanzo --version 1.0.0 --authors <you>

cd ../memorycore
rql connector test connector.ts --fixtures lifecycle.json
rql connector pack connector.ts --id Tencent.MemoryCore --version 1.0.0 --authors <you>
```

`.nupkg` output is deliberately **not** committed: a package is a build artifact
whose bytes depend on the builder's CLI. `SOURCE-SHA256` next to each connector
pins the source that produced the live `1.0.0` package, and
`tests/runtime-parity.test.mjs` re-checks it.

## Fixtures

Fixtures are synthetic and were checked to contain no operator record:

- `kanzo/fixtures/` — a small board listing and one task detail, with invented
  titles and comments.
- `memorycore/fixtures/live-{1,2,3}/` — three store shapes (records, scene
  blocks, personas), invented content, `team-fixture` / `agt-fixture` ids only.

## Licensing

The connector source is ours (MIT, same as this repository). Both build against
the public RepoQL connector API (MIT). Kanzo itself is
[`emanuele-em/kanzo`](https://github.com/emanuele-em/kanzo) `v0.1.3`,
**AGPL-3.0-only**: it is not redistributed here, not linked, not modified, and
not upgraded. The connector speaks to its HTTP API as a separate process, which
is the same relationship any client of a web service has. The MemoryCore store is
Tencent's MIT code; only its data folder is read. The `.nupkg` naming
coincidence between Kanzo's own packaging and this RepoQL package is packaging
format, not a shared binary.

## Provenance

See [`PROVENANCE.md`](PROVENANCE.md) for the source paths, the sha256 of every
ported file, and the exact edits made while porting.
