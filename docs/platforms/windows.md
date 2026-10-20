# Windows 11 (WSL2 + Docker) — walkthrough

This walkthrough targets RepoQL users who want the memory stack and OpenChamber
alongside their existing Windows RepoQL installation. The Linux containers
run inside WSL2; no native Windows container port is involved.

## Platform support

Windows support uses Linux containers through WSL2 and remains experimental.
Choose either a WSL-native Docker Engine or Docker Desktop's WSL integration,
and validate the selected engine and installation option on your machine.
Use the checklist below; endpoint health alone does not establish functional
memory, native plugin events or successful RepoQL tool calls.

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
configuration or a user's existing native OpenCode configuration. Reuse the
existing OpenChamber image; only option 4 needs `claude-office:local`. See
[`OPENCHAMBER-SETUP.md`](../OPENCHAMBER-SETUP.md) and
[`OFFICE-SETUP.md`](../OFFICE-SETUP.md).

Start the selected attach flow without replacing the existing UI credentials:

```bash
SINGULARITY_VARIANT=3 scripts/start.sh  # use 4 for OpenChamber Complete
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

## Validation checklist

- [ ] Memory stack and `verify.sh`; memory capture/recall loop.
- [ ] Claude Code proxy responds and ordinary sessions capture and recall
      automatically in a new session (options 1/2).
- [ ] Existing OpenChamber remains usable with its configuration preserved
      (options 3/4); Claude Office displays native events (options 2/4 only).
- [ ] RepoQL binary in the target and MCP initialize handshake.
- [ ] Create a Team and business user in the Panel.
- [ ] Verify plugin session capture/Office activity from a real UI session.
- [ ] Make a RepoQL tool call in the UI against a WSL project and observe
      `<project>/.repoql/`.
- [ ] Exercise documented RepoQL recovery in a disposable scratch workspace,
      including cross-container stale-claim handling where applicable. Never
      interrupt a user's active RepoQL host for a recovery drill.
- [ ] Recreate the OpenChamber container while preserving RepoQL state.
- [ ] Reboot Windows and confirm containers return or can be restored by
      `scripts/start.sh`.
- [ ] Create a backup and restore it into clean volumes.

When diagnosing platform issues, include the Windows OS build, WSL kernel,
Docker Engine/Desktop version and RepoQL version, without credentials.
