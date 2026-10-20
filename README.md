# Singularity-RepoQL — agent memory and code intelligence that survive the session

Self-hosted memory for coding agents, built for integrating with what you
already run. Your agent talks to an LLM proxy; every conversation is captured
through a single-owner pipeline, an asynchronous extraction process turns it
into durable memory, later sessions receive bounded relevant context back,
verified lessons flow through automatic knowledge promotion, and material
changes are caught, documented and ingested without user commands.

This is the **RepoQL package**: it wires Tencent MemoryCore, specialised
agents, RepoQL code intelligence and (in the complete variants) Ghost and the
Claude Office visualizer into your existing harness — Claude Code or
OpenChamber. It never installs a duplicate harness and never touches a
managed instance.

## START HERE: GIVE THIS TO YOUR AI AGENT

Paste **one** of these briefs to your coding agent in the WSL2 terminal where
your harness and `rql` already work — the agent performs the install and the
verification. Exactly four variants exist:

| Variant | Harness | MemoryCore + specialist agents | Automatic docs + knowledge lifecycle | Ghost | Claude Office |
|---|---|---|---|---|---|
| **1 — Claude Code + MemoryCore** | existing Claude Code | required | required | — | — |
| **2 — Claude Code Complete** | existing Claude Code | required | required | **required** | **required** |
| **3 — Existing OpenChamber + MemoryCore** | existing OpenChamber | required | required | — | — |
| **4 — OpenChamber Complete** | existing OpenChamber | required | required | **required** | **required** |

**Variant 1 — Claude Code + MemoryCore:**

```text
Clone https://github.com/ali3nz/Singularity-RepoQL into your home directory.
Start the memory stack: bash scripts/start-memory-stack.sh (loopback
publishing by default; it verifies auth before proceeding). Then run
node scripts/install-claude-code.mjs install --enable-main-memory --variant 1
from the clone. This installs the seven specialised subagents, their persistent
MemoryCore identities, ordinary-session proxy routing, the documentation hooks
and RepoQL MCP against an existing installation. Verify with
node scripts/install-claude-code.mjs status --probe (expect MAIN AGENT
MEMORY: VERIFIED), then bash tests/validate-memory-loop.sh (expect LOOP OK).
Never run memory/upstream/start-all.sh directly. Report every command, its
result, and anything that deviated from the documented behavior.
```

**Variant 3 — existing OpenChamber + MemoryCore:**

```text
Clone https://github.com/ali3nz/Singularity-RepoQL into your home directory.
Do NOT install OpenChamber — attach to the existing one. Start the memory
stack: bash scripts/start-memory-stack.sh. Then run
bash scripts/start.sh (it mounts the freshly provisioned RepoQL binary and
attaches the plugins) and follow scripts/OPENCHAMBER-SETUP.md (renamed under
docs/OPENCHAMBER-SETUP.md) to copy openchamber/ config, provision plugin
credentials (python3 scripts/provision-secrets.py) and verify: real RepoQL
tool calls, memory capture of a completed turn, later-session recall,
documentation closeout gate (DOC_UPDATED / DOC_NOT_REQUIRED) and the
memory-loop check (bash tests/validate-memory-loop.sh). Report every command,
its result, and anything that deviated from the documented behavior.
```

For variants 2 and 4, the same brief gains one line —
"and complete the Ghost + Claude Office parts of ghost/README.md and
office/README.md exactly" — and the installer's variant gate then requires
both components to be present and functional before it reports success.
Never paste admin keys anywhere; when the installer needs the scoped business
key it reads the protected files itself.

Status: **release candidate**. A partial Windows 11 + WSL2 acceptance run
passed on one machine on 2026-10-19 using the WSL-native Docker Engine: the
memory/proxy loop, Claude Code proxy smoke test, OpenChamber and Office HTTP
endpoints, and RepoQL MCP handshake. Docker Desktop WSL integration, an actual
UI RepoQL tool call, reboot resilience, and backup/restore remain unverified;
Windows support therefore remains **experimental**. See
[`docs/platforms/windows.md`](docs/platforms/windows.md).

## Components

- **Memory Core** (`memory-core`, :8420) — L0–L3 capture, extraction, search
  gateway; the experiential-memory plane. RepoQL remains authoritative for
  code and verified knowledge; MemoryCore is advisory context.
- **Memory Hub** (`memory-hub`; Panel :8125, Knowledge :8424) — admin panel
  + knowledge service used by the documentation/lifecycle gates.
- **LLM Proxy** (`proxy`, :8096) — front door for coding agents: captures
  conversations (single owner per event scope), injects memory, skills and
  knowledge. The default published boundary is loopback only.
- **Extraction failover router** (`scripts/extraction-failover.mjs`, :8430
  when enabled) — retries extraction across a provider ladder on transient
  failures with a shared monthly budget ledger.
- **OpenChamber** (:3127) — workspace UI + `product-office` memory plugin
  (brought by you; never reinstalled by this package).
- **Claude Office** (:3128) — activity visualizer (complete variants).
- **Ghost** (`ghost/`, gateway :18003) — persistent companion agent with a
  checkpointed 6-step dream cycle; `GHOST_BACKEND` selects the runtime
  (`openchamber` container or `claude-code` CLI, no docker needed).
- **Knowledge promotion** (`scripts/knowledge-promotion.py` + brokered
  capture) — evidence-gated, provenance-stamped promotion into the curated
  store; never an agent free-for-all.
- **Harness integration** (`adapters/claude-code/` + `openchamber/`) — seven
  specialised subagents with persistent MemoryCore identities, ordinary
  session routing, SubagentStart recall / SubagentStop capture, documentation
  hooks, RepoQL over MCP, and the variant gates in
  `scripts/install-claude-code.mjs`.
- **RepoQL (yours)** — code intelligence connected over MCP; installed
  separately ([`docs/REPOQL-SETUP.md`](docs/REPOQL-SETUP.md)).

## Requirements

- Docker Engine 24+ with Compose v2. On Windows, run one engine reachable
  from WSL2: either Docker Desktop WSL integration or a Linux Engine inside
  WSL2 (the latter was used for the acceptance runs).
- Measured incremental disk on the reference Windows 11 + WSL2 machine
  (2026-10-20, WSL-native engine; existing RepoQL/OpenChamber excluded):
  memory stack images ≈ 4.6 GB (`memory-core` 1.34 GB + `memory-hub` 2.02 GB
  + `memory-proxy` 1.22 GB) with SQLite volumes currently ≈ 5 MB (plan several
  GB for long-running capture + backups); Claude Code variant adds nothing
  beyond the clone (≈ 200 MB worktree incl. data); OpenChamber image 4.9 GB
  and Office image 0.6 GB count ONLY for variants 3/4 when you genuinely lack
  them. Plan ≈ 6 GB headroom for variants 1–2 and ≈ 12 GB only if you also
  pull OpenChamber and Office from scratch.
- Two configured processing-provider credentials for extraction (a ladder;
  see §Providers in docs/ARCHITECTURE.md). NVIDIA build, GroqCloud, Cerebras
  and OpenRouter all publish OpenAI-compatible endpoints.
- An OpenAI-compatible or Anthropic-compatible endpoint for user-visible proxy
  traffic. A local model server is valid when reachable from both WSL2 and
  the containers; successful connectivity checks do not establish model
  quality.
- RepoQL installed for this variant (`rql` — see
  [`docs/REPOQL-SETUP.md`](docs/REPOQL-SETUP.md); the OpenChamber container
  needs a Linux rql, installed in WSL2 on Windows).
- Ports: `8420` core · `8125` panel · `8424` knowledge · `8096` proxy (all
  loopback-bound by default via scripts/start-memory-stack.sh); `3127`
  OpenChamber · `3128` Office (loopback) · `8430` failover router when used.

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

## Documentation enforcement and automatic MemoryCore ingestion

Runbooks and guides are first-class outputs, not an afterthought. Both client
surfaces (OpenChamber and Claude Code) follow the same shared policy:

- material tasks report `DOC_UPDATED` / `DOC_NOT_REQUIRED` (with a reason) /
  `DOC_BLOCKED`; only genuinely non-material work may skip documentation
- updated runbooks are ingested (`scripts/memory-doc-ingest.py ingest`) and
  verified as genuinely SEARCHABLE (`DOC_INGEST_INDEXED`), not merely noted
- detection is automatic: each client keeps a per-session documentation
  baseline and ingests every new or changed eligible runbook at task close —
  including newly created, untracked, docs-only files — with no operator
  command
- revisions supersede previous ones; retrieval offers the current procedure
  and excludes stale versions
- `node scripts/doc-policy.mjs check --session <id>` re-verifies any task's
  documentation closure deterministically (usable from review and CI); the
  gate re-derives ingestion evidence from the ledger itself, so a claimed
  status is never proof

Details, statuses, revision management and troubleshooting:
[`docs/DOC-INGESTION.md`](docs/DOC-INGESTION.md).

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
tests/         validate-local.sh, validate-memory-loop.sh, validate-repoql.sh
```

## Install — give this to your agent

Use the copyable briefs in **START HERE** at the top of this README — they
are the four installation variants (`--variant 1|2|3|4` for Claude Code, an
attach-only flow for an existing OpenChamber). The full Windows-specific
walkthrough remains in [`INSTRUCTIONS.md`](INSTRUCTIONS.md), which leads with
the same variant matrix. A variant install refuses to report success while a
mandatory capability (profiles, routing, hooks, RepoQL MCP — or Ghost and
Office for the complete variants) is missing or unverified.
## Documentation



[`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md) ·
[`docs/ARCHITECTURE-ALIGNMENT.md`](docs/ARCHITECTURE-ALIGNMENT.md) ·

[`docs/MEMORY-SETUP.md`](docs/MEMORY-SETUP.md) ·

[`docs/MEMORY-LOOP.md`](docs/MEMORY-LOOP.md) ·

[`docs/DOC-INGESTION.md`](docs/DOC-INGESTION.md) ·

[`docs/OPENCHAMBER-SETUP.md`](docs/OPENCHAMBER-SETUP.md) ·

[`docs/REPOQL-SETUP.md`](docs/REPOQL-SETUP.md) ·

[`docs/memory-capture-promotion.md`](docs/memory-capture-promotion.md) ·

[`docs/OFFICE-SETUP.md`](docs/OFFICE-SETUP.md) ·

[`docs/GHOST-SETUP.md`](docs/GHOST-SETUP.md) ·

[`docs/TROUBLESHOOTING.md`](docs/TROUBLESHOOTING.md)



## License



MIT — see [`LICENSE`](LICENSE). Upstream components keep their own licenses;

see [`THIRD_PARTY_NOTICES.md`](THIRD_PARTY_NOTICES.md).
