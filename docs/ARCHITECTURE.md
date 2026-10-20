# Architecture

Singularity is a self-hosted memory system for coding agents. It captures what
your agent did, distills it asynchronously into durable memory, and feeds the
relevant parts back into later sessions. Every component runs on your own
hardware; there is no telemetry and no hosted service.

## Component map

```text
        ┌───────────────────────┐        ┌───────────────────────┐
        │  OpenChamber (:3127)  │        │ Claude Code / other   │
        │  + product-office     │        │ harnesses             │
        │    plugin             │        └──────────┬────────────┘
        └──────────┬────────────┘                   │ ANTHROPIC_BASE_URL
                   │ session capture                │  http://…:8096/claude-code/default
                   │ (turn → API)                   ▼
                   │                  ┌──────────────────────────┐
                   │                  │  proxy (:8096)           │
                   │                  │  captures conversations, │
                   │                  │  injects memory/skills/  │
                   │                  │  knowledge               │
                   │                  └──────────┬───────────────┘
                   │                             │ upstream LLM
                   ▼                             ▼
        ┌──────────────────────────────────────────────────────┐
        │  memory-core (:8420)                                 │
        │  L0 store · search · async extraction pipeline       │
        │  ┌──────────┐  ┌──────────┐  ┌──────────┐            │
        │  │ L0 units │→ │ L1 facts │→ │ L2 / L3  │            │
        │  └──────────┘  └──────────┘  └──────────┘            │
        └────────────┬─────────────────────────────────────────┘
                     │
        ┌────────────▼───────────────┐   ┌──────────────────────┐
        │ memory-hub                 │   │ Claude Office        │
        │ Panel :8125 · Knowledge    │   │ (:3128, optional)    │
        │ :8424 (teams/agents/tasks/ │   │ visualizer fed by    │
        │ skills/wiki)               │   │ plugin or adapters   │
        └────────────────────────────┘   └──────────────────────┘
```

Optional pieces (drop them and the system still works):

- **Extraction failover router** (`:8430`) — retries extraction requests
  across a provider ladder on transient failures, with a shared monthly quota
  ledger for the metered provider.
- **Claude Office** — pixel-art activity visualizer; the memory path marks its
  channel `not-configured` and stays off when Office is absent.
- **Ghost** (`ghost/`, `:18003` loopback gateway) — persistent
  companion agent (part of installation options 2 and 4) with three-tier memory and a daily checkpointed 6-step dream
  cycle (`ghost/dream.mjs`) that commits provenance-stamped reflections into
  `data/ghost/memory/`. Stays off when `secrets/ghost.env` is absent. See
  `GHOST-SETUP.md`.
- **RepoQL** (when connected) — code-intelligence MCP server for the
  workspace; wired in via `compose/repoql.override.yml` and
  `openchamber/opencode.jsonc`. See `REPOQL-SETUP.md`.
- **Harness adapters** (`adapters/claude-code/`) — metadata-only event
  forwarding from harness hooks.

## Networks and name resolution

| Network | Members | Purpose |
|---|---|---|
| `tdai-memory-stack` | memory-core, memory-hub, proxy, failover router (when enabled) | the memory stack, created by the upstream quickstart |
| `singularity-product-net` | OpenChamber, Claude Office, memory-core (alias) | product traffic; created by `scripts/start.sh` |

The OpenChamber plugin resolves Memory Core as `http://memory-core:8420` and
Claude Office as `http://product-office:8000`, both validated by host and port
before a single request is sent.

The RepoQL MCP server is not a network member: when enabled it runs as a
stdio child process next to OpenChamber, with the Linux rql binary
bind-mounted in by compose/repoql.override.yml. `scripts/start.sh` attaches the memory-core
container to the product network under the `memory-core` alias; Office joins
with the `product-office` alias through its compose file.

## Data and storage

- All state is SQLite inside Docker volumes — `tdai-memory-core-data`
  (conversations, facts, layers) and `tdai-panel-data` (panel state). No
  external database, no NFS.
- Credentials live on the host filesystem only: `memory/upstream/.env`
  (provider keys), `memory/upstream/.admin-key` (admin user key),
  `secrets/claude-office.env` (Office API + ingest keys), and
  `data/opencode/config/product-secrets/{memory,office}.json` (plugin
  configuration). All are mode 0600 and gitignored.

## Trust boundaries

- The plugin and adapters forward **metadata only** to Office — session and
  tool names, statuses, project names. Prompts, assistant text and tool I/O
  never leave the memory path.
- The Office ingest API is CIDR-gated (`CLAUDE_OFFICE_ALLOW_CIDR`), default
  `127.0.0.0/8,172.16.0.0/12`; the product-network range must stay included
  for the plugin to deliver events.
- OpenChamber and Office bind to loopback (`127.0.0.1:3127`, `127.0.0.1:3128`)
  by default. Expose them deliberately, behind your own auth or tunnel.
- The memory stack's gateway key (`MEMORY_CORE_GATEWAY_API_KEY`) is disabled
  by default for local zero-config use; see `memory/.env.example` before
  enabling it.

## The memory loop

Capture → extraction → recall, with an explicit promotion path for curated
knowledge. Full walkthrough: [`MEMORY-LOOP.md`](MEMORY-LOOP.md).

## Repository layout

```text
openchamber/   AGENTS.md, agents/, opencode.jsonc, dcp.jsonc, plugins/product-office/
memory/        README.md, upstream/ (vendored quickstart), .env.example
office/        README.md, office.compose.yml
ghost/         README.md, ghost.compose.yml, setup-ghost.sh, dream.mjs, ghost-memory.mjs, ghost-turn.mjs, ghost-gateway.mjs, seed/, systemd/
compose/       compose.yml (OpenChamber stack), repoql.override.yml, extraction-failover.compose.yml
scripts/       start.sh, start-memory-stack.sh, redaction/verification helpers, provision-secrets.py, knowledge-promotion.py
adapters/      claude-code/ (Office adapter + Claude Code native-agent integration + doc hooks)
templates/     product.env.example
docs/          ARCHITECTURE, MEMORY-SETUP, MEMORY-LOOP, OPENCHAMBER-SETUP, CLAUDE-CODE-SETUP, DOC-INGESTION, REPOQL-SETUP, OFFICE-SETUP, GHOST-SETUP, TROUBLESHOOTING
tests/         validate-local.sh, validate-manifest.sh, manifest-regression.test.sh, validate-memory-loop.sh, validate-repoql.sh
```
