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
- **Install needs the loopback allowance (the installer grants it for you; manual fallback below):**

  ```bash
  rql connector install RepoQL.Connectors.Kanzo.1.0.0.nupkg
  ```

  Manual path only: with no envelope flags, RepoQL opens its local install review page. It states
  the loopback host `http://localhost:4242` and the 6 requests/minute limit;
  approve that page only when it is the board you mean. The host refuses a
  connector that reaches loopback without this approval.

### MemoryCore

- **Network:** none. It reads files under one configured source root.
- **Source root:** the installer grants the product's own memory data folder
  automatically. Only a manual `rql connector install` shows RepoQL's local
  install review page, where you would choose the store's own folder.

  ```bash
  rql connector install Tencent.MemoryCore.1.0.0.nupkg
  ```

- **Read-only:** it never writes to the source root and the store's service stays
  the folder's only writer. Raw conversations, vectors and checkpoints are
  deliberately left out; one file per L1 record, L2 scene block and L3 persona is
  copied, with the store's own ids and provenance.

## Building and installing

The supported product setup builds both packages with the pinned RepoQL CLI
**1.7.18** and verifies the exact package bytes against
[`packages.lock.json`](packages.lock.json):

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File .\native\windows\bootstrap_runtime.ps1 -Apply -InstallProduct -ProvisionConnectors
```

That writes the packages under `%LOCALAPPDATA%\Singularity\connectors\packages`
and reports each connector as installed or missing. If pinned release packages
are already in that folder, the same command verifies their exact hashes and
package contents against `packages.lock.json` and reuses them instead of running
`connector pack`. It does not install a connector. To install both connectors
automatically with their fixed access:

```powershell
$m = '.\native\windows\manage_native_windows.ps1'
$repoqlExe = "$env:LOCALAPPDATA\rql\rql.exe"
$pythonExe = "$env:LOCALAPPDATA\Singularity\runtime\python312\python.exe"

# Read-only connector inventory
powershell -NoProfile -ExecutionPolicy Bypass -File $m -ConnectorAction status `
  -RepoqlExe $repoqlExe `
  -PythonExe $pythonExe

# Install both connectors (automatic, fixed access)
powershell -NoProfile -ExecutionPolicy Bypass -File $m -ConnectorAction install -Apply `
  -RepoqlExe $repoqlExe `
  -PythonExe $pythonExe
```

The command installs each missing connector automatically with the fixed access
its manifest asks for: Kanzo reaches only its loopback board address at 6
requests/minute, and MemoryCore reads only the product's own data folder. The
installer, not the operator, states that access, so no page opens. Without
`--auto-approve` the helper falls back to RepoQL's local install review page; a
closed page, a declined page or a timeout is reported as `waiting_for_consent`
or `declined`. `-ConnectorAction status` is read-only and reports installed/missing.

For a manual author check (no package is committed):

```bash
rql connector test connectors/kanzo/connector.ts --fixtures connectors/kanzo/suite.json
rql connector test connectors/memorycore/connector.ts --fixtures connectors/memorycore/suite.json
```

`.nupkg` output is deliberately **not** committed: a package is a build artifact
whose bytes depend on the builder's CLI. `SOURCE-SHA256` next to each connector
pins the source that produced the live `1.0.0` package, and
`tests/runtime-parity.test.mjs` re-checks it. `packages.lock.json` pins the
1.7.18 package bytes built from that source.

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
