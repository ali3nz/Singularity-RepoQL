# Windows (WSL2 + Docker Desktop) — target platform of this variant

This repository variant is built for Windows: RepoQL users who want the
memory stack and OpenChamber alongside the RepoQL they already run. WSL2 is
used for installing and running the Linux containers; no separate Linux
machine is required.

Status: the stack and integrations are validated on Linux + Docker. The
Windows path below is the acceptance checklist — Windows-specific claims stay
experimental until every item passes on real hardware. Record the results.

## Architecture being proven

Windows 11 x64 + WSL2 + Docker Desktop (Linux containers) running the same
containers unchanged, plus rql installed in WSL2 and mounted into the
OpenChamber container (see [`REPOQL-SETUP.md`](../REPOQL-SETUP.md)). No native
Windows port, no separate packaging.

## Prerequisites

- Windows 11 x64 with WSL2 enabled (`wsl --install`) and a current WSL kernel.
- Docker Desktop with the WSL2 backend and **WSL integration enabled for your
  distro** (Settings → Resources → WSL Integration).
- 16 GB RAM recommended (the memory stack and OpenChamber together are the
  heavy part).
- RepoQL installed — the Windows install serves your Windows-side agents; the
  container needs a Linux rql in WSL2 (one command, see REPOQL-SETUP.md).
- Clone the repository **inside the WSL2 filesystem** (e.g.
  `~/Singularity-RepoQL`), not under `/mnt/c/...`: bind-mount performance and
  file permissions for SQLite volumes and the 0600 secrets files are both
  wrong on DrvFs.

Run every command in a WSL2 shell (Ubuntu), not PowerShell. Compose files use
relative paths only — no host-path edits are needed.

## Bring-up sequence

```bash
# rql for the container (once)
curl -fsSL https://downloads.repoql.ai/latest/install-rql.sh | bash

cd ~/Singularity-RepoQL/memory/upstream
./verify.sh --skip-llm
./start-all.sh                 # interactive; Docker Desktop must be running

cd ~/Singularity-RepoQL
python3 scripts/provision-secrets.py
scripts/start.sh               # detects rql and mounts it into OpenChamber
tests/validate-repoql.sh       # RepoQL wiring: container, host status, MCP handshake
```

Notes specific to Docker Desktop:

- `host.docker.internal` is provided natively on Docker Desktop, so the
  default `KNOWLEDGE_PUBLIC_BASE_URL` works as shipped.
- Ports published on `127.0.0.1` inside WSL2 are reachable from Windows
  browsers via `localhost` (Docker Desktop forwards them).
- Line endings: keep the checkout LF-only. If Git on the Windows side ever
  touches the tree, re-clone inside WSL2 before running any script.

## Acceptance checklist

1. Memory stack starts; `docker ps` shows `tdai-memory-core`,
   `tdai-memory-hub`, `tdai-proxy`; `./verify.sh` passes both LLM groups.
2. Panel reachable at `http://localhost:8125`; a team and business user can be
   created.
3. Panel credentials are mode 0600 in the WSL2 filesystem (`stat -c %a
   memory/upstream/.admin-key` → `600`).
4. `tests/validate-memory-loop.sh` passes (capture → search → knowledge
   promotion round-trip).
5. Claude Code (or another harness) through the proxy: session captured, then
   recalled in a following session.
6. `scripts/start.sh` brings OpenChamber up; UI at `http://localhost:3127`.
7. Plugin channels are healthy: sessions appear in the Panel; with Office
   installed, activity renders at `http://localhost:3128`.
8. `tests/validate-repoql.sh` passes (rql in the container, host status, MCP
   handshake).
9. In a UI session, a RepoQL tool call answers for a project directory and
   reports index readiness; `<project>/.repoql/` appears in the WSL2 checkout.
10. Recreate the OpenChamber container (`docker compose ... up -d
    --force-recreate`) and confirm sessions still reach RepoQL; if a session
    reports a stale host claim, follow the `rql serve` recovery in
    REPOQL-SETUP.md troubleshooting.
11. Restart the machine; containers return per the restart policy you set, or
    re-running `scripts/start.sh` restores the stack.
12. Backup tarball created per MEMORY-SETUP § backup; restore into clean
    volumes succeeds.

Record the OS build, WSL kernel, Docker Desktop version and rql version with
the results — support claims require those. Report results or blockers on the
issue tracker.
