# Windows 11 (WSL2 + Docker) — walkthrough

This walkthrough targets RepoQL users who want the memory stack and OpenChamber
alongside their existing Windows RepoQL installation. The Linux containers
run inside WSL2; no native Windows container port is involved.

## Acceptance status (2026-10-19)

A partial live acceptance run passed on one Windows 11 / Ubuntu 24.04 WSL2
machine using the WSL-native Docker Engine 29.1.3 and RepoQL 1.7.15. Docker
Desktop WSL integration is an alternative but was not exercised in this run.
The platform remains **experimental**: machine OS build/kernel metadata and
several UI, reboot, and backup/restore steps were not verified.

Verified: memory stack health and `verify.sh`; memory capture/recall
loop; Claude Code proxy smoke test (HTTP 200); the OpenChamber and Claude Office images built from
OpenChamber `bf977d2ed` and Claude Office `1fce512`; OpenChamber and Office
HTTP endpoints returned 200, with Office healthy; rql 1.7.15 was mounted in
OpenChamber and the `rql mcp` initialize handshake passed. The RepoQL host
status check and recovery drill used disposable in-container git workspaces,
not a user's project.

Not verified: creating a Team/business user in the Panel; selecting agents or
making a RepoQL tool call in a real OpenChamber UI session; plugin event
appearance from an interactive session; Docker Desktop-specific behavior;
full cross-container stale-claim failure wording; Windows reboot; backup and
restore. Do not claim full acceptance until these are tested.

## Prerequisites

- Windows 11 x64 with WSL2 and Ubuntu 24.04+ (or Debian 13+). If WSL is not
  installed, run `wsl --install -d Ubuntu-24.04` from elevated PowerShell,
  launch the distro once, and confirm `wsl -l -v` reports version 2.
- One Docker Engine available inside WSL2: either Docker Desktop with its
  WSL2 engine and integration enabled for this distro, or a Linux Docker
  Engine running inside WSL2. Verify from the WSL terminal with `docker info`
  and `docker compose version`. Avoid assuming both engines share images.
- `git`, `curl`, Python 3, and the Linux RepoQL binary (`rql`) in WSL2. If
  `rql --version` is missing, try `bash -lc 'rql --version'` or
  `~/.local/bin/rql --version`. A Windows-only `rql.exe` cannot run inside
  the OpenChamber Linux container.
- Clone under the WSL2 Linux filesystem (for example
  `~/Singularity-RepoQL`), not `/mnt/c`; this keeps bind mounts and 0600
  secret files on Linux storage.
- A provider endpoint for memory extraction and proxy traffic. A local model
  server is fine if its WSL/container-reachable URL and model id are correct.
  Endpoint reachability verifies transport only, not model quality. For
  Windows-hosted model servers, use an address reachable from the containers;
  do not assume `127.0.0.1` inside a container points to Windows.
- Options 1–2 use Claude Code. If it is not installed in WSL2, install the
  Linux build from Anthropic's official guide:
  `curl -fsSL https://claude.ai/install.sh | bash`, then `claude --version`.
  A Windows-side `claude.exe` absent from WSL's PATH is not available to the
  WSL terminal.

## Before starting

Check for conflicts on memory ports `8420`, `8125`, `8424`, `8096`, and UI
ports `3127`, `3128` in both WSL2 and Windows. In WSL2:

```bash
ss -ltnp | grep -E ':(8420|8125|8424|8096|3127|3128)([[:space:]]|$)' || true
```

On Windows, inspect listeners with `Get-NetTCPConnection -State Listen`.
Identify the owning process before changing anything; do not stop an unknown
listener. The memory quickstart checks its four ports, but UI ports should
also be checked before first start.

## Bring-up sequence

```bash
cd ~/Singularity-RepoQL
rql --version                         # WSL Linux binary, not rql.exe
(cd memory/upstream && ./verify.sh --skip-llm)
scripts/start-memory-stack.sh         # safe wrapper; redacts key output
(cd memory/upstream && ./verify.sh)
python3 scripts/provision-secrets.py --variant 3   # --variant 4 --with-ghost for option 4
```

For options 3/4, copy the repository's `openchamber/` bundle into the
detected instance's config directory — `node scripts/attach-openchamber.mjs`
does this with per-file backups (see `INSTRUCTIONS.md`); for a compose-managed
instance this is `data/opencode/config/`. This directory is
specific to the container runtime: do not copy it over Windows Electron's
configuration or a user's existing native OpenCode configuration. Build
`openchamber:local` and `claude-office:local` before the product start; see
[`OPENCHAMBER-SETUP.md`](../OPENCHAMBER-SETUP.md) and
[`OFFICE-SETUP.md`](../OFFICE-SETUP.md).

Create the UI password file without echoing its value:

```bash
umask 077
mkdir -p secrets
python3 -c 'import secrets; print("OPENCHAMBER_UI_PASSWORD=" + secrets.token_urlsafe(32))' > secrets/openchamber.env
chmod 600 secrets/openchamber.env
scripts/start.sh
```

The startup script creates its bind-mount directories as the WSL user before
Compose can create them as root, verifies they are writable by container
UID:GID 1000:1000, creates the shared `singularity-product-net`,
attaches memory-core as `memory-core`, and attaches (or, only when you
explicitly choose managed mode, starts) OpenChamber. In attach mode it reuses
your running OpenChamber container or native install and never creates a
second one; `rql` inside an attached container is checked with
`node scripts/attach-openchamber.mjs --container`. The UI containers run as UID 1000. If a previous
failed first start already created root-owned mount paths, follow the
permissions recovery in [`TROUBLESHOOTING.md`](../TROUBLESHOOTING.md); do not
use `chmod 777`.

Verify endpoints and integration:

```bash
curl -fsS -o /dev/null -w '%{http_code}\n' http://127.0.0.1:3127/
curl -fsS -o /dev/null -w '%{http_code}\n' http://127.0.0.1:3128/
bash tests/validate-memory-loop.sh
bash tests/validate-repoql.sh
```

OpenChamber and Claude Office bind to loopback. `tests/validate-repoql.sh`
checks the mounted rql binary, workspace-scoped host status, and MCP initialize
handshake; a real UI tool call still needs a human session check.

## Acceptance checklist

- [x] Memory stack and `verify.sh`; memory capture/recall loop.
- [x] Claude Code proxy smoke test returned HTTP 200.
- [x] OpenChamber and Office containers started; ports 3127/3128
      returned HTTP 200; Office health was healthy.
- [x] RepoQL 1.7.15 in the container and MCP initialize handshake.
- [ ] Create a Team and business user in the Panel.
- [ ] Verify plugin session capture/Office activity from a real UI session.
- [ ] Make a RepoQL tool call in the UI against a WSL project and observe
      `<project>/.repoql/`.
- [x] Run the one-time `rql serve --path .` recovery in a disposable scratch
      workspace after abruptly stopping its RepoQL host; it returned to ready.
      Cross-container stale-claim wording and a user's actual project remain
      untested.
- [ ] Recreate the OpenChamber container while preserving RepoQL state.
- [ ] Reboot Windows and confirm containers return or can be restored by
      `scripts/start.sh`.
- [ ] Create a backup and restore it into clean volumes.

Record the Windows OS build, WSL kernel, Docker Engine/Desktop version, and
rql version with any future acceptance report. The OS build and WSL kernel
were not captured in the partial run documented here.
