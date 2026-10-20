# OpenChamber setup — workspace UI + memory plugin (optional)

[OpenChamber](https://github.com/openchamber/openchamber) is an MIT-licensed
workspace UI for coding agents (web, desktop and VS Code builds). This
repository ships the **configuration bundle** and the **memory and reminder
plugins** that make it part of Singularity; the application itself is
installed from its own project.

## 1. Install OpenChamber

Any of the upstream install paths works — they all install the same
application:

- **Desktop app** — GitHub Releases of `openchamber/openchamber`.
- **VS Code extension** — marketplace listing from the same project.
- **CLI** (Node 24.14+):
  `curl -fsSL https://raw.githubusercontent.com/openchamber/openchamber/main/scripts/install.sh | bash`
- **Docker (reference path used here)**:

  ```bash
  git clone https://github.com/openchamber/openchamber
  cd openchamber && docker build -t openchamber:local .
  ```

## 2. Copy the Singularity bundle into the config directory

Copy the contents of `openchamber/` from this repository into the instance's
OpenCode configuration directory:

| Repo path | Goes to (`<config-dir>/…`) | What it is |
|---|---|---|
| `openchamber/AGENTS.md` | `AGENTS.md` | runtime agent policy (memory usage, evidence honesty, permissions) |
| `openchamber/agents/` | `agents/` | nine agent definitions (below) |
| `openchamber/opencode.jsonc` | `opencode.jsonc` | OpenCode config: compaction + plugin list |
| `openchamber/dcp.jsonc` | `dcp.jsonc` | config for the DCP compaction plugin |
| `openchamber/plugins/product-office/` | `plugins/product-office/` | the memory-capture plugin |
| `openchamber/plugins/runbook-nudge/`  | `plugins/runbook-nudge/`  | the runbook/concept reminder plugin |
| `openchamber/package.json` | `package.json` | declares the config dir as an ESM package |

With the Docker Compose path, the config dir is `data/opencode/config/` in
this repository (it is bind-mounted into this container only). Keep this
runtime bundle isolated from the Windows Electron app and any existing
`~/.config/opencode/` configuration; do not overwrite those files. For native
installs the config dir is `~/.config/opencode/`.

The shipped agents (`standalone` and `ghost` are primary; the rest are subagents):

| Agent | Role |
|---|---|
| `standalone` | unrestricted operator-driven primary agent — does the task directly |
| `ghost` | persistent companion agent that dreams — maintains 3-tier memory (`ghost/ghost-memory.mjs`) and consolidates daily reflections (`ghost/dream.mjs`; see [`GHOST-SETUP.md`](GHOST-SETUP.md)) |
| `thinker` | deep reasoning for difficult technical decisions and diagnosis |
| `general` | general-purpose research and multi-step execution |
| `explore` | fast codebase exploration (patterns, symbols, questions) |
| `researcher-web` | evidence-driven web research |
| `code-reviewer` | implementation critic for significant changes |
| `quality-fixer` | write-capable fixer scoped to its staged context directory |
| `board` | Board of Advisors — eight-persona strategic judgment panel (financial officer, tax strategist, attorney, corporate strategist, investment advisor, real estate advisor, estate planner, insurance & risk advisor) |

## 3. Provision credentials and start

Start the memory stack first with `scripts/start-memory-stack.sh`. Build
`openchamber:local` and (when enabled) `claude-office:local` before starting
the product compose services. From the repository root, provision plugin
secrets and create `secrets/openchamber.env` with mode 0600; keep the UI
password value out of the shell transcript. Then run:

```bash
python3 scripts/provision-secrets.py --variant 3   # option 4: --variant 4 --with-ghost
scripts/start.sh    # creates bind dirs/network, attaches memory-core, then attaches the EXISTING OpenChamber (container or native) — never creates a second one; rql inside an attached container is verified with node scripts/attach-openchamber.mjs --container
```

Then open `http://127.0.0.1:3127` and log in with your UI password. The
container binds to loopback by default; change the port mapping in
`compose/compose.yml` if you need LAN access (and put it behind your own auth
or tunnel — the UI password is the only gate).

## 4. How the plugin works

`plugins/product-office/` runs inside OpenChamber's OpenCode runtime:

- **Memory channel** — on completed sessions, user/assistant pairs are
  reconciled into Memory Core; only sessions under the capture roots (default
  the OpenChamber home; override with `SINGULARITY_MEMORY_ROOTS`) are
  ingested. Requires
  `data/opencode/config/product-secrets/memory.json`
  (`{"baseUrl":"http://memory-core:8420","authPrefix":"Bearer ","gatewayKey":"","serviceId":"…","userKey":"sk-mem-…"}`).
- **Office channel** (used by installation option 4) — session/tool lifecycle events are queued
  and POSTed to Claude Office (same capture roots). Requires `office.json`
  (`{"endpoint":"http://product-office:8000/api/v1/events","ingestKey":"…"}`).

Each channel reports its own state: `not-configured` (file missing),
`invalid-endpoint` (URL fails the pinned host/port check), or ready/degraded
tracked under plugin storage. A missing Office changes nothing about memory
capture.

`plugins/runbook-nudge/` works alongside it: a non-gating context hook that
asks the primary agent to check tracking records, the covering runbook,
existing RepoQL concepts and the installation's indexed shared documentation
(`python3 scripts/memory-doc-ingest.py search "<topic>"`) before substantial
work, and to create/update the runbook, refresh concepts, report validation
honestly AND a documented documentation outcome (`DOC_UPDATED` /
`DOC_NOT_REQUIRED` with a reason / `DOC_BLOCKED`) before its final answer.
When documentation was updated, the closeout nudge instructs the agent to
ingest it into MemoryCore (`memory-doc-ingest.py ingest`, verified retrieval
required) and record the closure assessment (`scripts/doc-policy.mjs assess`,
SINGDOC token) — the SAME policy the Claude Code integration enforces. It is
fail-open, it never edits anything, it stays a reminder (OpenCode exposes no
documented stop-interception hook; closure is enforced through review, the
deterministic `doc-policy.mjs check` and release validation, not a synthetic
hard stop), and `OPENCHAMBER_RUNBOOK_NUDGE=off` disables it; details in
[`docs/DOC-INGESTION.md`](DOC-INGESTION.md).

## RepoQL integration

The bundle ships the RepoQL wiring: `opencode.jsonc` declares the `repoql`
MCP server (`rql mcp`, stdio) and `compose/repoql.override.yml` mounts your
`rql` binary into the container — `scripts/start.sh` applies it automatically
when the binary is detected. Without the mount, the `repoql` server reports a
startup failure and everything else works unchanged. Full walkthrough:
[`REPOQL-SETUP.md`](REPOQL-SETUP.md).

## 5. Verify the integration

1. Start a short session in the UI and finish it.
2. The session should appear in the Memory Panel (`http://127.0.0.1:8125`).
3. Run the machine check: `tests/validate-memory-loop.sh` (from this
   repository).
4. In a new session, reference something from the first one — recall should
   carry it.

## Notes

- The DCP plugin (`@tarquinen/opencode-dcp`) is installed from npm on first
  start; that download needs network access.
- Updating the bundle: re-copy `openchamber/` over the config dir; the plugin
  is backward-compatible with an absent Office and an absent memory config
  (channels simply stay off).
- Keep `data/opencode/config/` out of version control — it holds credentials
  (`product-secrets/`, mode 0600).
