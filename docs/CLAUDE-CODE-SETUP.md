# Claude Code setup — specialised persistent agents without OpenChamber

Claude Code users get the same specialised, self-learning agents OpenChamber
ships — as native Claude Code subagents, with their own persistent Tencent
MemoryCore identities, automatic memory recall, lesson capture through the
existing Singularity loop, and RepoQL code intelligence over MCP. This page
documents the Claude Code integration; the memory-stack bring-up itself is in
[`MEMORY-SETUP.md`](MEMORY-SETUP.md).

Windows 11 note: everything below runs in WSL2 (the Linux `claude`, and — when
RepoQL is connected — the Linux `rql` binary). Paths and commands are WSL2
paths; there is no Windows-native variant.

## What gets installed

| Piece | Where | What it does |
|---|---|---|
| 7 subagent definitions | `~/.claude/agents/` (user) or `<project>/.claude/agents/` (project) | the specialised agents below |
| `SubagentStart` / `SubagentStop` hooks | `~/.claude/settings.json` (merged — never replacing your settings; a timestamped backup is written first) | hook the agents into the memory loop |
| MemoryCore profiles | your Singularity installation's memory stack | the agents' persistent identities |
| `singularity-repoql` MCP server | Claude Code user-level MCP config | RepoQL code intelligence (when `rql` is installed) |

The integration's state is recorded in `data/claude-code-integration.json` inside
the Singularity checkout so **uninstall removes only these pieces**.

## Agent roster (Claude Code name → MemoryCore identity)

One logical agent owns exactly one MemoryCore identity (`team_id` / `user_id`
/ `agent_id`). The Claude Code display names are namespaced to avoid collision
with Claude Code's built-in subagents; the memory identity is the role name, so
an OpenChamber agent and its Claude Code twin **share the same profile** — no
duplicate identity is ever created.

| Claude Code subagent | MemoryCore `agent_id` | Role |
|---|---|---|
| `singularity-code-reviewer` | `code-reviewer` | implementation critic; read-only checks; BLOCKING/NON-BLOCKING/APPROVE verdicts; RepoQL concept capture when connected |
| `singularity-quality-fixer` | `quality-fixer` | staged-file fixer; edits only inside its staged context dir; no shell |
| `singularity-researcher-web` | `researcher-web` | evidence-driven web research with cited sources |
| `singularity-thinker` | `thinker` | deep reasoning/diagnosis; reason and recommend only |
| `singularity-explore` | `explore` | fast read-only codebase exploration |
| `singularity-general` | `general` | full-surface execution worker |
| `singularity-board` | `board` | Board of Advisors (8 seats, ruling with per-seat positions and dissent) |

Deliberately **not** part of this integration:

- **Ghost** keeps its own `ghost-companion` profile and its own setup
  ([`GHOST-SETUP.md`](GHOST-SETUP.md)); no second Ghost identity is created and
  nothing Ghost-related installs automatically.
- **Standalone** is not a subagent. Its working rules belong to Claude Code's
  main agent (Claude Code already behaves as the primary operator agent
  without a delegation policy), so shipping it as a duplicate subagent would
  add nothing; the integration therefore does not install one.

## Install

```bash
cd ~/Singularity-RepoQL            # the Singularity checkout
# first bring up the memory stack (docs/MEMORY-SETUP.md), then:
python3 scripts/provision-secrets.py --memory-user-key <scoped user key>
node scripts/install-claude-code.mjs install
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
  documentation (`python3 scripts/memory-doc-ingest.py search "<topic>"`).
- **Stop** — the final-answer closeout: it (1) re-drives pending MemoryCore
  documentation ingestion (`memory-doc-ingest.py retry --all`, event-driven;
  a no-op when the ledger is clean) and (2) verifies the session's recorded
  documentation assessment (`scripts/doc-policy.mjs assess` / `check`). A
  material task that reports `DOC_UPDATED` without verified ingestion,
  `DOC_BLOCKED`, or an unreported knowledge-capture status is BLOCKED with
  concrete remediation — bounded to 3 blocks per session, honouring
  `stop_hook_active`, and never applied to sessions that recorded no
  assessment (ordinary chat, read-only work).

The policy is shared with OpenChamber and re-checkable exactly the same way:
`node scripts/doc-policy.mjs check --session <id>`. Full mechanics, statuses
(`DOC_INGEST_INDEXED`/…), revision/supersession behaviour, security
boundaries and troubleshooting: [`docs/DOC-INGESTION.md`](DOC-INGESTION.md).

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
node --test scripts/install-claude-code.profiles.test.mjs
node scripts/install-claude-code.mjs status
```

Then in a live Claude Code session:

1. run `/agents` — all seven `singularity-*` agents should be listed;
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

Removes: the seven agent files it installed, exactly its hook handlers and env
keys from settings (a timestamped backup is written first), and — only if this
install recorded it — the `singularity-repoql` MCP server. It never removes
unrelated user agents, hooks or MCP servers. Profiles, the ledger and all
captured memories are intentionally **kept**: re-creating the integration
later resumes with the same identities and history. To also drop memory state,
follow the memory-stack uninstall in [`MEMORY-SETUP.md`](MEMORY-SETUP.md)
(that deletes your memories — say what you are doing first).

## Relation to Variants A and B (INSTRUCTIONS.md)

- **Variant A (memory stack + Claude Code):** after the stack is up, run this
  installer — Claude Code users get the specialised agents and the memory loop
  without OpenChamber or Claude Office.
- **Variant B (full stack):** unchanged; and when Claude Code is also
  installed, the same installer adds the native integration. Both clients then
  share the Singularity instance consistently — the same logical agent is the
  same MemoryCore identity under either runtime.
