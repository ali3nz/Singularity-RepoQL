# RepoQL setup — code intelligence for the workspace

This repository is the RepoQL variant of Singularity: the same self-hosted
memory stack and OpenChamber bundle, with the RepoQL integration wired in. It
is for people who already run RepoQL — typically on Windows — and want their
OpenChamber agents to use it.

The two systems complement each other:

- **RepoQL** answers questions about the code: structure, symbols,
  relationships, and the concepts your team records about them.
- **MemoryCore** (this repository's memory stack) answers questions about the
  work: what was tried, decided and learned across sessions.

## What is wired

| File | What it does |
|---|---|
| `openchamber/opencode.jsonc` | declares the `repoql` MCP server (`rql mcp`, stdio) for the agent runtime |
| `openchamber/AGENTS.md` | teaches agents the RepoQL-first workflow |
| `compose/repoql.override.yml` | mounts the rql binary into the OpenChamber container |
| `scripts/start.sh` | detects the binary and applies the override automatically |
| `tests/validate-repoql.sh` | live check: rql in the container, host status, MCP handshake |

## Requirements

- RepoQL installed and working. Variant B requires the Linux WSL2 binary,
  not `rql.exe`; install it with the shell installer below. If the current
  shell does not find `rql`, try `bash -lc 'rql --version'` or
  `~/.local/bin/rql --version`; the installer may add that path only for login
  shells. `scripts/start.sh` detects `~/.local/bin/rql` or accepts an explicit
  `REPOQL_RQL_PATH`.
- Docker Engine and Compose v2 accessible inside WSL2: either a Linux Engine
  running in the distro or Docker Desktop's WSL2 engine with integration
  enabled for that distro. This acceptance used the native WSL Engine; see
  `docs/platforms/windows.md` for verified and untested platform details.
- WSL2 distro with glibc >= 2.38 (Ubuntu 24.04+ or Debian 13+): the rql
  release binary requires it. An older Ubuntu in WSL2 (22.04, glibc
  2.35) will not run the rql binary — upgrade the distro or use the
  service-style host at the end of this document. The official
  OpenChamber container image (Debian 13) has glibc 2.41.
- Projects must be git repositories (or run `rql init` in them): RepoQL
  never indexes a home directory. Keep projects under the OpenChamber
  `workspaces/` folder so their index state lives on the mounted volume
  and survives container restarts.

The OpenChamber container runs Linux. A Windows `rql.exe` cannot run inside it,
so the container needs a Linux rql binary. Installing rql in WSL2 is the
supported path; your Windows install keeps serving the agents you run on the
Windows side.

## Wire it up (WSL2 + Docker Engine)

```bash
# 1. Install rql in WSL2 (one command, no sudo) and verify
curl -fsSL https://downloads.repoql.ai/latest/install-rql.sh | bash
~/.local/bin/rql --version

# 2. From the repository root, start the stack — start.sh detects the binary
scripts/start.sh
#    (or wire it explicitly)
#    REPOQL_RQL_PATH="$HOME/.local/bin/rql" \
#      docker compose -f compose/compose.yml -f compose/repoql.override.yml up -d

# 3. Verify
bash tests/validate-repoql.sh
```

In the UI (`http://localhost:3127`), open a project and ask the agent to use
RepoQL — the `repoql` tools appear in the session, and the first answer starts
the index for that project's directory.

## How it works in the container

- The override bind-mounts your WSL2 binary to `/usr/local/bin/rql`
  (read-only), where the agent runtime finds it on PATH.
- `rql mcp` runs per session; the host launches on demand, indexes the
  session's project directory, and stores its state in `<project>/.repoql/` —
  inside the mounted `workspaces/` volume, so it survives container restarts.
- The host exits by itself after a few idle minutes; the next session starts
  it again.
- Add `.repoql/cache/` to your project's `.gitignore`; commit `.repoql/`
  concepts only deliberately.

## Updating rql

Re-run the installer in WSL2, then start the stack again (`scripts/start.sh`
or `docker compose ... up -d`) so the container is recreated and the new
binary is mounted. A bind mount pins the exact file it was given — the
running container keeps serving the old binary until it is recreated,
so run the stack again (or recreate the container) after every update.
The persisted `data/repoql` host directory keeps the container side
(native bundles, host identity) across recreations.

## One host per workspace

RepoQL lets one host serve a workspace at a time. Treat the WSL2 rql
install as the source for the container mount (install and update
there); do not also index the same project from a Windows-side host.

## Troubleshooting

- **`rql` not found in the container** — the override was not applied, or
  `REPOQL_RQL_PATH` points at the Windows executable. Re-run
  `scripts/start.sh` and check the mounts:
  `docker inspect singularity-openchamber --format '{{json .Mounts}}'`.
- **"This workspace is served by a host on another machine"** — a previous
  container stopped while its RepoQL host was active and left a stale claim in
  `<project>/.repoql/cache/host.lock`. From that workspace, run the named
  recovery once: `rql serve --path .` (inside the container, run it from the
  workspace directory). The recovery does not reset the index. Never use
  `rql host reset` for this symptom; it deletes the index.
- The live validator runs `rql host status` from its disposable git workspace;
  running it from `/home/openchamber` is expected to be refused because the
  container home is not an indexable project.
- **"not a workspace"** — the directory has no `.git` and no `.repoql`.
  RepoQL serves git projects, or directories explicitly marked with a
  `.repoql` directory.
- **Empty answers while `index:` is below 100%** — the index is still being
  built; retry after a moment.
- **ARM Windows** — the containers are amd64; use an rql build matching the
  container architecture, or the service-style host below.

## Alternative: a service-style RepoQL host

If you prefer a long-running host (or the mounted binary cannot run in your
container), the official image serves a repository over HTTP MCP:

```bash
docker run -d --name repoql-host \
  -v /path/to/repo:/workspace \
  -e REPOQL_LOCAL_SECRET=<one shared secret> \
  -p 52700:52700 \
  ghcr.io/repoql/rql
```

Then declare it as a remote MCP server in `openchamber/opencode.jsonc`
(`{"type":"remote","url":"http://host:52700/mcp","headers":{"Authorization":"…"}}`).
See `rql help hosting/container` for the full contract. This variant's shipped
config uses the stdio form above.
