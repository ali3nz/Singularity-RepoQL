# Singularity-RepoQL — agent memory and code intelligence that survive the session

Self-hosted memory for coding agents. Your agent talks to an LLM proxy; every
conversation is captured, an asynchronous pipeline extracts durable memory, and
later sessions receive the relevant context back. Optional add-ons: the
**OpenChamber** workspace UI with a native memory plugin, the **Claude Office**
activity visualizer, and harness adapters.

This is the **RepoQL variant**: it ships everything above and wires the
OpenChamber bundle to your existing RepoQL installation, so your agents get
code intelligence (structure, symbols, concepts) from the RepoQL you already
run, alongside the memory system. See
[`docs/REPOQL-SETUP.md`](docs/REPOQL-SETUP.md).

Claude Code works out of the box through the proxy — no UI required.

Status: **release candidate**. The memory stack and adapters are validated on
Linux + Docker; the OpenChamber and Office integrations are validated against
the reference deployment. Windows (WSL2 + Docker Desktop) is the target
platform of this variant and stays **experimental** until the acceptance
checklist passes on real hardware — see
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
| Knowledge promotion (`scripts/knowledge-promotion.py`) | Explicit, reversible promotion of verified knowledge into a curated store, indexed into Memory Core | optional |
| Harness adapters (`adapters/claude-code/`) | Hook-based metadata events for the visualizer | optional |
| RepoQL (your installation) | Code intelligence — index, tools, concepts — connected over MCP by the OpenChamber bundle | yes for this variant (installed separately) |

## Requirements

- Docker Engine 24+ with Compose v2 (Linux or macOS; Windows via WSL2 is
  experimental).
- ~12 GB disk for the image set (memory stack ≈ 5 GB, OpenChamber ≈ 7 GB).
- One LLM provider key with an OpenAI-compatible or Anthropic-compatible
  endpoint, reachable from the host (used for extraction and summarization).
- RepoQL installed for this variant (`rql` — see
  [`docs/REPOQL-SETUP.md`](docs/REPOQL-SETUP.md); the OpenChamber container
  needs a Linux rql, installed in WSL2 on Windows).
- Ports: `8420` core · `8125` panel · `8424` knowledge · `8096` proxy;
  optional `3127` OpenChamber · `3128` Office (loopback) · `8430` failover
  router.

## Quick start — memory stack (enough for Claude Code)

```bash
cd memory/upstream
./verify.sh --skip-llm     # optional dry-run: environment + prereq checks
./start-all.sh             # interactive: writes .env, starts core + hub + proxy
```

`start-all.sh` asks for two LLM configurations (memory group and proxy group —
they may be the same provider), checks that each endpoint actually answers, and
prints the panel admin key. Defaults: Core `8420` · Panel `8125` ·
Knowledge `8424` · Proxy `8096`.

Then point Claude Code at the proxy (persist in `~/.claude/settings.json`):

```json
{ "env": {
    "ANTHROPIC_BASE_URL": "http://127.0.0.1:8096/claude-code/default",
    "ANTHROPIC_AUTH_TOKEN": "<your sk-mem-… user key>",
    "ANTHROPIC_MODEL": "<your upstream model>" } }
```

Open the Panel at `http://<host>:8125`, log in with the admin key printed by
`start-all.sh`, and create a Team and a business user. Drive the harness with
that user's key rather than the admin key. To verify capture and recall, follow
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
compose/       compose.yml (OpenChamber stack), repoql.override.yml, extraction-failover.compose.yml
scripts/       start.sh, provision-secrets.py, knowledge-promotion.py, extraction-failover.mjs, cohere-quota.mjs
adapters/      claude-code/ (hook-based Office adapter)
templates/     product.env.example
docs/          ARCHITECTURE, MEMORY-SETUP, MEMORY-LOOP, OPENCHAMBER-SETUP, REPOQL-SETUP, OFFICE-SETUP, TROUBLESHOOTING
tests/         validate-local.sh, validate-memory-loop.sh, validate-repoql.sh
```

## Install — give this to your agent

> Clone `https://github.com/ali3nz/Singularity-RepoQL`, read `README.md`, and
> install the memory stack for Claude Code by following “Quick start — memory
> stack”. Do not install the optional components unless asked. For OpenChamber,
> follow `docs/OPENCHAMBER-SETUP.md` exactly, and wire RepoQL per
> `docs/REPOQL-SETUP.md` when `rql` is already installed. Report what you
> installed and the verification results, using `tests/validate-memory-loop.sh`
> and `tests/validate-repoql.sh` where they apply.

## Documentation

[`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md) ·
[`docs/MEMORY-SETUP.md`](docs/MEMORY-SETUP.md) ·
[`docs/MEMORY-LOOP.md`](docs/MEMORY-LOOP.md) ·
[`docs/OPENCHAMBER-SETUP.md`](docs/OPENCHAMBER-SETUP.md) ·
[`docs/REPOQL-SETUP.md`](docs/REPOQL-SETUP.md) ·
[`docs/OFFICE-SETUP.md`](docs/OFFICE-SETUP.md) ·
[`docs/TROUBLESHOOTING.md`](docs/TROUBLESHOOTING.md)

## License

MIT — see [`LICENSE`](LICENSE). Upstream components keep their own licenses;
see [`THIRD_PARTY_NOTICES.md`](THIRD_PARTY_NOTICES.md).
