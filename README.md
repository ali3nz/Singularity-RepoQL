# Singularity-RepoQL — agent memory and code intelligence that survive the session

Self-hosted memory for coding agents. Your agent talks to an LLM proxy; every
conversation is captured, an asynchronous pipeline extracts durable memory, and
later sessions receive the relevant context back. Optional add-ons: the
**OpenChamber** workspace UI with a native memory plugin, the **Claude Office**
activity visualizer, **Ghost** (a persistent companion agent that dreams), and
harness adapters.

This is the **RepoQL variant**: it ships everything above and wires the
OpenChamber bundle to your existing RepoQL installation, so your agents get
code intelligence (structure, symbols, concepts) from the RepoQL you already
run, alongside the memory system. See
[`docs/REPOQL-SETUP.md`](docs/REPOQL-SETUP.md).

Claude Code works out of the box through the proxy — no UI required.

Status: **release candidate**. A partial Windows 11 + WSL2 acceptance run
passed on one machine on 2026-10-19 using the WSL-native Docker Engine: the
memory/proxy loop, Claude Code proxy smoke test, OpenChamber and Office HTTP
endpoints, and RepoQL MCP handshake. Docker Desktop WSL integration, an actual
UI RepoQL tool call, reboot resilience, and backup/restore remain unverified;
Windows support therefore remains **experimental**. See
[`docs/platforms/windows.md`](docs/platforms/windows.md).

## Components

| Component | Role | Required |
|---|---|---|
| Memory Core (`memory-core`, :8420) | L0–L3 capture, extraction, search gateway | yes |
| Memory Hub (`memory-hub`; Panel :8125, Knowledge :8424) | Admin panel (teams/agents/tasks/skills/wiki) + knowledge service | yes |
| LLM Proxy (`proxy`, :8096) | Front door for coding agents: captures conversations, injects memory/skills/knowledge | yes for bring-your-own-harness |
| Extraction failover router (:8430, optional) | Retries extraction across providers on transient failures, with a shared monthly budget ledger | optional |
| OpenChamber (:3127, optional) | Workspace UI + `product-office` memory plugin | optional |
| Claude Office (:3128, optional) | 2D activity visualizer fed by the plugin or by harness adapters | optional |
| Ghost (`ghost/`, :18003 gateway, optional) | Persistent companion agent with 3-tier memory and a daily checkpointed 6-step dream cycle (`dream.mjs`) | optional |
| Knowledge promotion (`scripts/knowledge-promotion.py`) | Explicit, reversible promotion of verified knowledge into a curated store, indexed into Memory Core | optional |
| Harness adapters (`adapters/claude-code/`) | Hook-based metadata events for the visualizer | optional |
| RepoQL (your installation) | Code intelligence — index, tools, concepts — connected over MCP by the OpenChamber bundle | yes for this variant (installed separately) |

## Requirements

- Docker Engine 24+ with Compose v2. On Windows, run one engine reachable
  from WSL2: either Docker Desktop WSL integration or a Linux Engine inside
  WSL2 (the latter was used for the partial acceptance run).
- ~12 GB disk for the image set (memory stack ≈ 5 GB, OpenChamber ≈ 7 GB).
- An OpenAI-compatible or Anthropic-compatible endpoint for memory extraction
  and proxy traffic. A local model server is valid when reachable from both
  WSL2 and the containers; successful connectivity checks do not establish
  model quality.
- RepoQL installed for this variant (`rql` — see
  [`docs/REPOQL-SETUP.md`](docs/REPOQL-SETUP.md); the OpenChamber container
  needs a Linux rql, installed in WSL2 on Windows).
- Ports: `8420` core · `8125` panel · `8424` knowledge · `8096` proxy;
  optional `3127` OpenChamber · `3128` Office (loopback) · `8430` failover
  router.

## Quick start — memory stack (enough for Claude Code)

```bash
cd memory/upstream
./verify.sh --skip-llm     # environment/preflight only
cd ../..
scripts/start-memory-stack.sh
(cd memory/upstream && ./verify.sh)
```

The safe wrapper runs the byte-exact Tencent startup, redacts its output, and
requires `auth/verify` to return `data.valid=true` (the upstream verifier only
checks HTTP 200, which also occurs for an invalid key). The admin key is stored
in `memory/upstream/.admin-key` with mode 0600 and is not printed. Do not run
`memory/upstream/start-all.sh` directly. The wrapper asks for the memory-group
and proxy-group LLM configurations; one provider may serve both. Defaults:
Core `8420` · Panel `8125` · Knowledge `8424` · Proxy `8096`.

Then point Claude Code at the proxy (persist in `~/.claude/settings.json`):

```json
{ "env": {
    "ANTHROPIC_BASE_URL": "http://127.0.0.1:8096/claude-code/default",
    "ANTHROPIC_AUTH_TOKEN": "<your sk-mem-… user key>",
    "ANTHROPIC_MODEL": "<your upstream model>" } }
```

Open the Panel at `http://<host>:8125`, use the local admin key file when
needed (never paste its value into a transcript), and create a Team and a
business user. Drive the harness with that user's key rather than the admin
key. To verify capture and recall, follow
[`docs/MEMORY-SETUP.md`](docs/MEMORY-SETUP.md).

Other harnesses follow the same proxy pattern — see the upstream project's
`agents/` directory.

## Optional — OpenChamber (workspace UI + memory plugin)

OpenChamber is installed from its own upstream project; this repository ships
the configuration bundle and the memory plugin:

1. Install OpenChamber (see [`docs/OPENCHAMBER-SETUP.md`](docs/OPENCHAMBER-SETUP.md)).
2. Copy `openchamber/` into the instance's OpenCode config directory
   (`data/opencode/config/`): AGENTS.md, `agents/`, `opencode.jsonc`,
   `dcp.jsonc`, and `plugins/product-office/`.
3. Provision plugin credentials (`scripts/provision-secrets.py`), start the
   stack (`scripts/start.sh`), and open the UI.

With the plugin active, every completed OpenChamber turn is captured into
Memory Core, relevant memory is recalled into new sessions, and — when Claude
Office is installed — session activity appears in the visualizer.

## RepoQL integration (this variant)

The OpenChamber bundle declares the `repoql` MCP server and ships a compose
override that mounts your `rql` binary into the container; `scripts/start.sh`
detects the binary and applies it automatically. Walkthrough:
[`docs/REPOQL-SETUP.md`](docs/REPOQL-SETUP.md).

## Optional — Claude Office (activity visualizer)

Build from the upstream project (a fork carrying the Focus/seating updates is
used by the reference deployment) and start it with
`office/office.compose.yml`. See [`office/README.md`](office/README.md) and
[`docs/OFFICE-SETUP.md`](docs/OFFICE-SETUP.md).

## Optional — Ghost (persistent companion agent that dreams)

Ghost is a persistent AI companion agent that maintains a three-tier memory
layout (Memory Stack `/v1/memories`, RepoQL `rql`, and local git-backed
reflection markdown in `data/ghost/memory/`) and runs a daily checkpointed
6-step dream cycle (`experiences -> related -> patterns -> evolution -> consolidate -> summary`).
Enable it with `bash ghost/setup-ghost.sh` (or
`python3 scripts/provision-secrets.py --with-ghost`) and start it via
`scripts/start.sh` or `ghost/ghost.compose.yml`. Clean-slate seed templates
only — zero personal memories are shipped. See [`ghost/README.md`](ghost/README.md)
and [`docs/GHOST-SETUP.md`](docs/GHOST-SETUP.md).

## Optional — knowledge promotion and extraction failover

- Promotion: `scripts/knowledge-promotion.py --propose TITLE BODY SOURCE` …
  `--promote PROPOSAL --truth-name NAME` (explicit, reversible, provenance kept;
  indexed into Memory Core with content-hash dedup).
- Failover: `scripts/extraction-failover.mjs` + `scripts/cohere-quota.mjs` as an
  optional router in front of the core's extraction endpoint. A single-provider
  installation does not need it.

## Repository layout

```text
openchamber/   AGENTS.md, agents/, opencode.jsonc, dcp.jsonc, plugins/product-office/
memory/        README.md, upstream/ (vendored quickstart), .env.example
office/        README.md, office.compose.yml
ghost/         README.md, ghost.compose.yml, setup-ghost.sh, dream.mjs, ghost-memory.mjs, ghost-turn.mjs, ghost-gateway.mjs, seed/, systemd/
compose/       compose.yml (OpenChamber stack), repoql.override.yml, extraction-failover.compose.yml
scripts/       start.sh, start-memory-stack.sh, redaction/verification helpers, provision-secrets.py, knowledge-promotion.py
adapters/      claude-code/ (hook-based Office adapter)
templates/     product.env.example
docs/          ARCHITECTURE, MEMORY-SETUP, MEMORY-LOOP, OPENCHAMBER-SETUP, REPOQL-SETUP, OFFICE-SETUP, GHOST-SETUP, TROUBLESHOOTING
tests/         validate-local.sh, validate-memory-loop.sh, validate-repoql.sh
```

## Install — give this to your agent

Open [`INSTRUCTIONS.md`](INSTRUCTIONS.md) in this repository: it is the
complete, Windows-specific walkthrough for both installs. Paste **one** of
the briefs below to your agent (in the WSL2 terminal session where `rql` is
installed). Do not run both.

**Variant A — memory stack for Claude Code (no Claude Office, no
OpenChamber):**

```text
Clone https://github.com/ali3nz/Singularity-RepoQL , open INSTRUCTIONS.md,
and execute the "Variant A" section exactly as written.
Windows only: this machine is Windows 11 with WSL2 and Docker Desktop, and
rql is already installed and on PATH. Do not install Claude Office or
OpenChamber. Report what you installed, every verification command and its
output, and anything that did not match the documented behavior.
```

**Variant B — full stack with OpenChamber, the specialised agents
(including the Board of Advisors) and Claude Office:**

```text
Clone https://github.com/ali3nz/Singularity-RepoQL , open INSTRUCTIONS.md,
and execute the "Variant B" section exactly as written. Windows only: this machine is Windows 11 with WSL2 and
Docker Desktop, and rql is already installed and on PATH; start.sh should
detect it and mount it into OpenChamber automatically. The specialised
agents shipped in openchamber/agents (including board, the Board of
Advisors) install with the bundle. Report what you installed, every
verification command and its output, and anything that did not match the
documented behavior.
```
## Documentation



[`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md) ·

[`docs/MEMORY-SETUP.md`](docs/MEMORY-SETUP.md) ·

[`docs/MEMORY-LOOP.md`](docs/MEMORY-LOOP.md) ·

[`docs/OPENCHAMBER-SETUP.md`](docs/OPENCHAMBER-SETUP.md) ·

[`docs/REPOQL-SETUP.md`](docs/REPOQL-SETUP.md) ·

[`docs/memory-capture-promotion.md`](docs/memory-capture-promotion.md) ·

[`docs/OFFICE-SETUP.md`](docs/OFFICE-SETUP.md) ·

[`docs/GHOST-SETUP.md`](docs/GHOST-SETUP.md) ·

[`docs/TROUBLESHOOTING.md`](docs/TROUBLESHOOTING.md)



## License



MIT — see [`LICENSE`](LICENSE). Upstream components keep their own licenses;

see [`THIRD_PARTY_NOTICES.md`](THIRD_PARTY_NOTICES.md).
