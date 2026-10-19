# Memory — the memory stack

This directory holds the memory stack: a vendored upstream quickstart
(`upstream/`), an environment template (`.env.example`), and how Singularity
wires them together.

## What runs

| Service | Container | Port | Role |
|---|---|---|---|
| memory-core | `tdai-memory-core` | 8420 | memory gateway: capture, extraction (L0–L3), search |
| memory-hub | `tdai-memory-hub` | 8125 panel · 8424 knowledge | admin panel (teams/agents/tasks/skills/wiki) + knowledge service |
| proxy | `tdai-proxy` | 8096 | LLM front door for coding agents — captures conversations, injects memory/skills/knowledge |

All three images are public on Docker Hub (`agentmemory/*`), multi-arch, no
login required. Storage defaults to **SQLite + local Docker volumes** — no
external storage, no NFS, no private registry.

## Quick start

```bash
cd memory/upstream
./verify.sh --skip-llm    # optional dry-run: environment and prerequisites
./start-all.sh            # interactive: fills .env, checks both LLM endpoints, starts all three
```

`start-all.sh` copies `upstream/.env.example` to `upstream/.env` when none
exists, asks for two LLM configurations (memory group + proxy group — the same
provider can serve both), verifies each endpoint answers, and writes the
values back to `upstream/.env`. When it finishes it prints the Panel URLs and
the Claude Code environment block; the admin user key (`sk-mem-…`) is stored
in `upstream/.admin-key`.

Non-interactive install: copy this directory's `.env.example` to
`memory/upstream/.env`, fill in the values, then run `./start-all.sh` (it still
confirms each group — press Enter to keep).

Verify again any time:

```bash
cd memory/upstream && ./verify.sh
docker logs tdai-memory-core --tail 50
```

Full walkthrough including Panel setup and the self-learning loop:
[`../docs/MEMORY-SETUP.md`](../docs/MEMORY-SETUP.md).

## Files

- `upstream/` — byte-exact copy of the upstream quickstart
  (`deploy/global-images` at tag v2.0.2). Do not edit; see
  `upstream/PROVENANCE.md`.
- `.env.example` — English template with the same variable names as the
  upstream template (`upstream/.env.example`, annotated in Chinese upstream).
  Copy to `upstream/.env` for a scripted install.
- `upstream/.env` — your real configuration (created by `start-all.sh`;
  gitignored).
- `upstream/.admin-key` — generated admin `sk-mem-…` user key (gitignored).
  Clients use this key, or a dedicated user key you create in the Panel.

## How Singularity wires it

OpenChamber's memory plugin resolves `http://memory-core:8420` over the product
service network. The upstream quickstart creates the `tdai-memory-stack`
network; [`../scripts/start.sh`](../scripts/start.sh) attaches the
`tdai-memory-core` container to the `singularity-product-net` network with the
alias `memory-core`.

## Operations

- Stop: `./stop-all.sh` (`--purge` also removes containers and volumes).
- Back up: data lives in the Docker volumes `tdai-memory-core-data` and
  `tdai-panel-data`. The SQLite databases inside can be snapshotted with
  `VACUUM INTO` from a container-side shell — see
  [`../docs/MEMORY-SETUP.md`](../docs/MEMORY-SETUP.md) § backup and restore.
- Upgrade: `PULL=1 ./start-all.sh` pulls fresh `:latest` images; pin explicit
  tags in `.env` for reproducibility.
- Restart policy: the upstream scripts create containers without a restart
  policy; add `docker update --restart unless-stopped <container>` if you want
  automatic recovery after a host reboot.
