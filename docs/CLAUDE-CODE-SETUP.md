# Claude Code setup — specialised persistent agents without OpenChamber

Claude Code users get the same specialised, self-learning agents OpenChamber
ships — as native Claude Code subagents, with their own persistent Tencent
MemoryCore identities, automatic memory recall, lesson capture through the
existing Singularity loop, and RepoQL code intelligence over MCP. This page
documents the Claude Code integration; the memory-stack bring-up itself is in
[`MEMORY-SETUP.md`](MEMORY-SETUP.md).

**Scope:** the installation instructions below apply only to the legacy Linux/WSL workflow. They are **not** the Windows-native Option 2 installer. For the native Windows Claude Desktop Code tab, use [`WINDOWS-NATIVE-M27-CLAUDE-CONFIGURATION.md`](WINDOWS-NATIVE-M27-CLAUDE-CONFIGURATION.md) and its `native/windows/configure_claude_code_windows.mjs` plan/apply/verify flow. The native Complete variant additionally requires `--office-config` with an existing protected JSON file containing `endpoint` and `ingestKey`. The source ZIP is not a native service installer: Office and Ghost remain separate, unverified runtimes.

Legacy Windows users following this page run Linux Claude Code and RepoQL in WSL2; those commands must not be used to install the native Windows Complete package.

## What gets installed

| Piece | Where | What it does |
|---|---|---|
| 9 agent definitions | `~/.claude/agents/` (user) or `<project>/.claude/agents/` (project) | five delegation targets + four main-session agents (below) |
| `SubagentStart` / `SubagentStop` hooks | `~/.claude/settings.json` (merged — never replacing your settings; a timestamped backup is written first) | hook the agents into the memory loop |
| MemoryCore profiles | your Singularity installation's memory stack | the agents' persistent identities |
| `singularity-repoql` MCP server | Claude Code user-level MCP config | RepoQL code intelligence (when `rql` is installed) |

The integration's state is recorded in `data/claude-code-integration.json` inside
the Singularity checkout so **uninstall removes only these pieces**.

## Agent roster

Fifteen selected non-pentest roles are installed, in two surfaces.

**Delegation targets** — Claude Code spawns these through the Agent tool, and each
one reuses the role's MemoryCore identity (`team_id` / `user_id` / `agent_id`).
The display names are namespaced to avoid collision with Claude Code's built-in
subagents; the memory identity is the role name, so an OpenChamber agent and its
Claude Code twin **share the same profile** — no duplicate identity is created.

| Claude Code agent | MemoryCore `agent_id` | Role |
|---|---|---|
| `singularity-code-reviewer` | `code-reviewer` | implementation critic; read-only checks; BLOCKING/NON-BLOCKING/APPROVE verdicts; no automatic concept writes |
| `singularity-thinker` | `thinker` | deep reasoning/diagnosis; reason and recommend only |
| `singularity-explore` | `explore` | fast read-only codebase exploration |
| `singularity-general` | `general` | full-surface execution worker |
| `singularity-board` | `board` | Board of Advisors (8 seats, ruling with per-seat positions and dissent) |

**Main-session agents** — launched as the session agent with
`claude --agent singularity-<role>`. They carry the role's authority, so they are
not delegation targets; they have no separate MemoryCore identity (the
main-session proxy lane already captures the session, and a second profile would
duplicate it).

| Claude Code agent | Launch | Role |
|---|---|---|
| `singularity-duel-coordinator` | `claude --agent singularity-duel-coordinator` | DUO seat plan: two workers, one reviewer |
| `singularity-quad-coordinator` | `claude --agent singularity-quad-coordinator` | QUAD seat plan: four workers, one reviewer |
| `singularity-duo` | `claude --agent singularity-duo` | DUO implementer working against an independent reviewer |
| `singularity-super` | `claude --agent singularity-super` | SUPER mode: full surface, may implement inside its own run |

Claude Code has no frontmatter field that hides a definition from the Agent tool,
so the nine main-session definitions are also visible to delegation. Each body
states its launch form and instructs a delegated instance to refuse session
authority; the roster test (`adapters/claude-code/integration.test.mjs`) asserts
that contract.

## Install

```bash
cd ~/Singularity-RepoQL            # the Singularity checkout
# first bring up the memory stack (docs/MEMORY-SETUP.md), then:
python3 scripts/provision-secrets.py --memory-user-key <scoped user key>
# every install selects one of the four installation options (inline, or via
# the numbered menu on an interactive terminal):
node scripts/install-claude-code.mjs install --variant 1
# (option 2 uses --variant 2; options 3/4 attach OpenChamber — INSTRUCTIONS.md)
```

The installer is idempotent. Re-running it will not duplicate agents, hooks,
profiles or MCP servers, will not overwrite user-edited settings values, and
will not reset RepoQL. Useful flags:

| Flag | Effect |
|---|---|
| `--scope project --project-dir DIR` | install agents/hooks for one project instead of user-wide |
| `--team T` / `--user U` | bind agent profiles to a specific MemoryCore team/user (customer or project isolation; projects sharing one Singularity instance get the same profiles unless separated this way) |
| `--skip-profiles` | skip MemoryCore provisioning (hooks degrade gracefully until it is run later) |
| `--skip-repoql-mcp` | skip the RepoQL MCP registration |
| `--dry-run` | print the plan, change nothing, contact nothing |

What each step reuses from the existing product: profile provisioning runs the
**same seeder** (`scripts/setup-agent-profiles.mjs`, identity-map mode) the
OpenChamber stack uses, against the **same ledger**
(`data/agent-profiles/ledger.json`) — so an OpenChamber install and a Claude
Code install on the same Singularity checkout bind the same roles to the same
identities, and already-seeded profiles are `verified`, not duplicated.

## How the memory loop works for these agents

- **Recall (SubagentStart):** when a mapped agent starts, the hook reads the
  payload's `agent_type`, resolves it through the identity map, and queries
  that agent's own MemoryCore scope — ≤4 L0 + ≤4 L1 items, each clipped. The
  result is returned as hook-specific additional context, clearly stamped
  "advisory only": recalled memory never overrides the current request or
  verified code, and full transcripts or whole memory dumps are never injected.
- **Capture (SubagentStop):** finished Singularity agents contribute ONE
  bounded, redacted lesson each through the product's reconciled write path
  (query-before-write → add → verify) under the agent's own identity, using a
  stable task id so a retried or interrupted invocation does not duplicate
  records. Trivial output, non-Singularity subagents and the parent session
  are never captured; simultaneous subagents each persist under their own
  `agent_id`, so they cannot cross-attribute or overwrite each other.
- **The four outcomes are distinct:** a hook ran ≠ the API accepted ≠ the
  record was durably reconciled and verified. A degraded or failed capture/recall
  is reported on stderr and the agent continues normally — the hook never
  blocks Claude Code and never claims memory success that did not happen.
- **Credentials:** the hooks read the connection key from the installation's
  `memory.json` (0600, next to the stack); no secret value is written into
  agent definitions, settings, hooks or argv.
- Separately, if you route Claude Code through the memory proxy
  (`ANTHROPIC_BASE_URL=…/claude-code/default`), the parent session's
  conversations are captured as before. That proxy capture and the per-agent
  hook capture are the only two capture paths; they use different scopes and
  do not duplicate each other.

## Documentation hooks (shared policy + automatic MemoryCore ingestion)

Besides the memory hooks, the installer merges two documentation hooks from
`adapters/claude-code/doc-hook.mjs` (same settings-merge rules; upgrade path:
re-run the installer):

- **SessionStart** — injects the same bounded start-of-work guidance the
  OpenChamber runbook-nudge uses: check tracking records, read the covering
  runbook, search RepoQL concepts, search the installation's indexed shared
  documentation (`node scripts/doc-ingest-node.mjs search "<topic>"`).
- **SessionStart baseline** — the hook also records a per-session census of
  eligible documentation plus the git dirty set, so pre-existing dirty files
  are never attributed to your session.
- **Stop** — the final-answer closeout: it (1) re-drives pending MemoryCore
  documentation ingestion (`node scripts/doc-ingest-node.mjs retry --all`, event-driven;
  a no-op when the ledger is clean), (2) diff-checks the baseline and
  AUTO-INGESTS every new or changed eligible doc — tracked or newly created
  untracked, docs-only work included (content-hash dedup makes repeats a
  no-op), and (3) verifies the session's recorded documentation assessment
  (`scripts/doc-policy.mjs assess` / `check`), re-deriving the ingestion
  evidence from the ledger itself — a claimed status never counts. A material
  task that reports `DOC_UPDATED` without verified ingestion, `DOC_BLOCKED`,
  an unreported knowledge-capture status, or that made a material change with
  no recorded assessment at all is BLOCKED with concrete remediation —
  bounded to 3 blocks per session, honouring `stop_hook_active`, and never
  applied to sessions that made no changes (ordinary chat, read-only work).
  A malformed hook payload is a strict no-op.

The policy is shared with OpenChamber and re-checkable exactly the same way:
`node scripts/doc-policy.mjs check --session <id>`. Full mechanics, statuses
(`DOC_INGEST_INDEXED`/…), revision/supersession behaviour, security
boundaries and troubleshooting: [`docs/DOC-INGESTION.md`](DOC-INGESTION.md).

## Main-agent persistent memory (proxy routing for the NORMAL session)

The eight `singularity-*` delegation targets each own a persistent MemoryCore
identity through the hooks above. The **normal parent session** gets persistent memory
when Claude Code routes its model requests through the Singularity memory
proxy — the proxy captures the parent conversation, injects relevant prior
context in later sessions, and nothing about the ordinary Claude Code
experience changes (no agent selection, no memory commands).

Enable it during install — advanced configuration within the selected
installation option:

```bash
node scripts/install-claude-code.mjs install --variant 1 --enable-main-memory
# interactive installs offer this as configuration inside the selected option (answer Y)
# automation may pass --no-main-memory to keep routing untouched
```

The installer writes into `~/.claude/settings.json` (`env`, merged, file mode
0600, timestamped backup first, previous values recorded for restore):

```json
{ "env": {
    "ANTHROPIC_BASE_URL": "http://127.0.0.1:8096/claude-code/default",
    "ANTHROPIC_AUTH_TOKEN": "<scoped business-user key from memory.json>",
    "ANTHROPIC_MODEL": "<your upstream model, when required>" } }
```

Consent and conflict rules — an existing provider configuration is never
silently replaced:

- fresh configuration with no provider settings → routing enabled when you
  accept (or `--enable-main-memory` for automation);
- an existing Singularity proxy entry → verified and reused, nothing duplicated;
- an existing Anthropic/Bedrock/Vertex/Foundry/third-party gateway, or another
  `ANTHROPIC_BASE_URL` → the installer REFUSES and asks for explicit
  `--replace-provider` consent on a second run; your current provider keeps
  working in the meantime and the previous values are recorded for rollback;
- environment-variable overrides in the invoking shell can shadow the settings
  file (Claude Code's own precedence); if that happens set your actual endpoint
  via `SINGULARITY_MAIN_AGENT_PROXY_URL` and consider removing the conflicting
  process env;
- the installed proxy URL resolves from `SINGULARITY_MAIN_AGENT_PROXY_URL` >
  `memory/upstream/.env` `PROXY_PORT` > the default `8096` — the same rules apply
  when Claude Code and the proxy run in different network environments.

Authentication uses the scoped **business-user** key from
`data/opencode/config/product-secrets/memory.json` (`userKey`) — never the
MemoryCore admin key — and the token is written only into the 0600 settings
file and never printed, logged or committed.

Verify and operate:

```bash
node scripts/install-claude-code.mjs status --probe   # MAIN AGENT MEMORY: VERIFIED
node scripts/install-claude-code.mjs status           # offline classification
node scripts/install-claude-code.mjs uninstall        # removes only what the installer wrote
```

`status` separates **MAIN AGENT MEMORY** (`CONFIGURED → VERIFIED (with the
authenticated probe) | DISABLED | DEGRADED | CONFLICTED`) from **SPECIALISED
AGENT MEMORY** (hooks + seeded identities), and never reports VERIFIED from a
matching URL alone. A session using the routed proxy is captured and
recalled automatically — see `docs/MEMORY-LOOP.md` and the honest
`docs/MEMORY-SETUP.md` note that a transport check proves transport, not
recall quality.

## RepoQL for Claude Code

When `claude mcp add` works and a runnable Linux `rql` is found (PATH,
`REPOQL_RQL_PATH`, or `~/.local/bin/rql` — the WSL2 installer location), the
installer registers the **`singularity-repoql`** user-scope stdio MCP server
pointing at your existing `rql`. It never removes other MCP servers, never
resets an index, and creates no second RepoQL host: `rql mcp` serves the
session's project directory the same way the OpenChamber integration does —
one host per workspace, state in `<project>/.repoql/`. If the claude CLI is
not detected, the installer prints the equivalent manual command.

Review/explore/thinker prompts use RepoQL first for code structure and
recorded concepts when it is connected, and say `NO_CONCEPT_CHANGE (repoql
unavailable)` otherwise. Code intelligence is RepoQL's job; MemoryCore stays
the experience/decisions store — the two are never conflated.

## Verify (what to run after installing)

```bash
node --test adapters/claude-code/integration.test.mjs   # shipped definitions + identity map
node --test adapters/claude-code/memory-hook.test.mjs   # hook behavior (faked core)
node --test adapters/claude-code/installer.test.mjs
node --test adapters/claude-code/main-memory.test.mjs
node --test scripts/install-claude-code.profiles.test.mjs
node scripts/install-claude-code.mjs status
```

Then in a live Claude Code session:

1. run `/agents` — all fifteen `singularity-*` agents should be listed
   (eight delegation targets, nine main-session agents);
2. invoke `singularity-code-reviewer` on a small synthetic change and let it
   finish — the Panel should then show `claude-code-code-reviewer-*` sessions
   under `team openchamber-agents / agent code-reviewer`;
3. replay: start a NEW Claude Code session, invoke the reviewer on a related
   topic — its SubagentStart recall should surface the prior lesson (visible
   above its task as "Singularity persistent memory");
4. isolation: invoke `singularity-thinker` and confirm its recall queries use
   `agent thinker` only — nothing from the reviewer's profile is attributed to
   it (identity isolation is enforced server-side by scope).

Items 1–2 above are covered by unit tests with a faked MemoryCore; steps 3–4
against a live stack were not yet executed in this release — run them once and
report what you observe. Hook support for SubagentStart context injection is
implemented per the documented hook contract; if your Claude Code version
ignores the injected context, the same memory remains reachable via the proxy
injection and verification (steps 2–3) shows which path is active in your version.

## Uninstall / disable

```bash
node scripts/install-claude-code.mjs uninstall            # same --scope/--project-dir as install
```

Removes: the fifteen agent files it installed, exactly its hook handlers and env
keys from settings (a timestamped backup is written first), and — only if this
install recorded it — the `singularity-repoql` MCP server. It never removes
unrelated user agents, hooks or MCP servers. Profiles, the ledger and all
captured memories are intentionally **kept**: re-creating the integration
later resumes with the same identities and history. To also drop memory state,
follow the memory-stack uninstall in [`MEMORY-SETUP.md`](MEMORY-SETUP.md)
(that deletes your memories — say what you are doing first).

## Relation to the installation options (INSTRUCTIONS.md)

Exactly four installation options exist (`--variant 1|2|3|4`; interactive
installs offer the same numbered menu). This installer is the Claude Code
surface:

- **Option 1 — Claude Code + MemoryCore:** after the stack is up, run this
  installer — Claude Code users get the specialised agents and the memory loop
  without OpenChamber, or Claude Office.
- **Option 2 — Claude Code Complete:** the same flow; Ghost and Claude Office
  are automatically included — Ghost's `GHOST_BACKEND=claude-code` keeps the
  complete Claude Code option independent of OpenChamber.
  **Provisioning boundary:** this installer wires Claude Code only. It does not
  start MemoryCore, Ghost or Claude Office. From the repository root:

  ```bash
  bash scripts/start-memory-stack.sh
  python3 scripts/provision-secrets.py --variant 2 --with-ghost && bash ghost/setup-ghost.sh
  python3 scripts/provision-secrets.py --variant 2
  docker compose -f office/office.compose.yml up -d
  ```

  The install is INCOMPLETE until those have run and the gate verifies the two
  capabilities. The same boundary is printed by `install --variant 2`.
- **Options 3 and 4 — existing OpenChamber:** `scripts/start.sh` attaches to
  the running OpenChamber (compose-managed, your own managed container, or
  native `~/.config/opencode`) via `scripts/attach-openchamber.mjs` with
  plugin credentials provisioned through
  `scripts/provision-secrets.py --variant 3|4`; it never creates a second
  OpenChamber. When Claude Code is also installed, this installer adds the
  native integration. Both clients then share the Singularity instance consistently
  — the same logical agent is the same MemoryCore identity under either
  runtime.
