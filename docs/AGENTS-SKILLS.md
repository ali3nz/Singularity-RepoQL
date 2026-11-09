# Agents and skills — the shipped inventory

Last updated: 2026-10-28

What this repository ships as agent definitions and skills, what each one is for,
what is deliberately **not** shipped, and what has to be installed separately. Use
this page as the authoritative catalogue; if a role is not listed here, it did not
ship.

Two directories are in scope:

| Repo path | Lands at | Contents |
| --- | --- | --- |
| `openchamber/agents/` | `<config-dir>/agents/` | 10 definitions (5 primary, 5 subagent), including the Linux-only Ghost companion |
| `openchamber/skills/` | `<config-dir>/skills/` | 10 skills, one directory each with a `SKILL.md` |
| `adapters/claude-code/agents/` | `~/.claude/agents/` | 9 `singularity-*` definitions (4 main-session agents, 5 subagents) |

## Agent roster

Every definition is portable: no host names, no personal paths, no account or
subscription entitlements, no hardcoded model ids. A `mode: primary` agent is one
the operator selects; a `mode: subagent` agent is one another agent dispatches.

| Agent | Mode | Role |
| --- | --- | --- |
| `super` | primary | full execution surface; plans, implements and delegates, and may open a `super` run whose coordinator may implement |
| `duel-coordinator` | primary | coordinates a `duo` run — two workers, one reviewer; allocates and never implements |
| `quad-coordinator` | primary | coordinates a `quad` run — four workers, one reviewer, four is the ceiling |
| `duo` | primary | implementation half of a two-seat pair; implements, the reviewer reviews |
| `general` | subagent | general-purpose research and multi-step execution with the full tool surface |
| `explore` | subagent | fast codebase exploration; read-only |
| `thinker` | subagent | deep reasoning for difficult decisions and diagnosis; read-only |
| `code-reviewer` | subagent | implementation critic for significant changes; read-only, returns BLOCKING / NON-BLOCKING / APPROVE |
| `board` | subagent | eight-seat advisory panel returning one ruling with per-seat positions and dissent |
| `ghost` | primary | optional Linux companion runtime profile, excluded from the Windows Claude Code roster |

Windows installs retain the nine roles above Ghost. The Linux companion runs
OpenCode with `--agent ghost` and needs its shared source profile. Its memory
profile remains managed by the separate Ghost setup flow.

### Orchestration vocabulary

The orchestration roles share one vocabulary, defined in code rather than in prose:
`orchestration/modes.mjs`. A mode is a **seat plan with authority**, never an alias
for an agent name and never a permission grant.

| Mode | Workers | Coordinator may implement | Provider policy |
| --- | --- | --- | --- |
| `solo` | 1 | no | any |
| `duo` | 2 | no | any |
| `quad` | 4 | no | any |
| `super` | 2 | yes | any |
| `custom` | explicit | explicit | any |
| `free_only` | 1 | no | free only |

Two invariants are enforced when a plan is built: the reviewer is never an
implementer, and the coordinator never holds the reviewer seat. Runs are driven by
`scripts/orch-run`, which needs Node and nothing else — no hosted service, no
network, no paid model.

## Skill inventory

Ten skills ship in `openchamber/skills/`. Each is a directory with a `SKILL.md`
carrying `name` and `description` frontmatter.

| Skill | Purpose |
| --- | --- |
| `board` | convene the operator's personal Board of Advisors over a decision |
| `claude-office-visual` | change and verify the Claude Office visualizer with vision checks |
| `consult-dispatch` | route an evidence pack to a **configured** consultant and poll the pointer |
| `handoff` | compact a session into a handoff note at a boundary or transfer |
| `hub-doc-update` | update the canonical project documentation after a durable behavior change |
| `implementation-review` | run the pre-completion review pass before claiming done |
| `issue-closeout` | close the tracked work item in one action with truthful metadata |
| `mcp-builder` | design, build and review integration servers to local conventions |
| `retro` | propose environment, tooling, doc and check improvements after a session |
| `statusline-builder` | compose a status line from the code-index widget inventory |

### Conditional skills

Two skills name a capability this repository does not ship, on purpose. Both fail
closed rather than inventing it:

- **`consult-dispatch`** needs a consultant endpoint and broker configured in the
  installation. Without one it reports that no consultant is configured and falls
  back to local review. It never invents an endpoint and never answers in a
  consultant's name.
- **`issue-closeout`** needs a work tracker connected to the session. Without one it
  reports that and stops; it never invents an identifier.

## Not shipped here — external, separately installed

### RepoQL plugin skills

The RepoQL plugin is a **separately installed, licensed component**. Its skills are
part of that package and are deliberately **not copied** into this repository. Ship
the prerequisite, not the package.

If the plugin is installed, its help tree supplies its own skill inventory —
including the effective-use, troubleshooting, monitoring, uplink and connector
guides, and the statusline widget fragments that `statusline-builder` reads via
`help:///skills/...`. If it is not installed, those skills do not exist in the
session, and no agent here may pretend otherwise.

### Office

Claude Office is a separate visualizer application (`github.com/ali3nz/claude-office`),
installed by options 2 and 4; this repository carries the office plugin and compose
file, not the visualizer source. Ghost is retired from the Windows product.

## Native Windows Claude Code skills (Milestone 32)

The native Windows Claude configuration installer **now supports installation** of
all ten above skills under `~/.claude/skills/<slug>/SKILL.md` for the complete
Claude Code variant. The lean Claude variant installs nine, excluding
`claude-office-visual`. It canonicalizes skill frontmatter names and replaces
the Office skill's Linux Compose deployment wording in the **installed** copy
only. Source inclusion does not prove installation in the Desktop Code tab;
Codex must execute the Windows installer and confirm skill discovery, skill
execution and guarded rollback. These are distinct from the separately licensed
RepoQL plugin skills, which are not bundled.

## Claude Code adapter

`adapters/claude-code/agents/` ships the **9 selected Claude Code roles** as `singularity-*`
definitions, mapped to their memory identities in
`adapters/claude-code/agent-map.mjs`. Five delegation targets map a `subagent`-mode
role; four main-session surfaces map a `primary`-mode role, declare
`claude --agent <name>` as their launch form, and refuse session authority when
reached through the Agent tool.

Every mapped definition points at a real `openchamber/agents/` file and its surface
mirrors that file's mode; `adapters/claude-code/integration.test.mjs` enforces both
directions.

## RepoQL feedback duty

Every RepoQL defect, limitation, or confusing behavior — hit while building,
testing, or running anything here — is reported in `repoql-feedback/` with
[`repoql-feedback/TEMPLATE.md`](../repoql-feedback/TEMPLATE.md), one report per
issue, with version, environment, exact command, expected versus actual,
reproduction, redacted evidence, and an explicit attribution section.

Attribution matters as much as the report: a harness fault, an environment fault,
or an agent mistake filed as a RepoQL report is worse than no report, because it
spends maintainer attention on the wrong system. [The README](../repoql-feedback/README.md)
carries the full rule, including what must never appear in a report.

## Maintaining this catalogue

When a definition or skill is added, removed, or renamed:

1. update the table above;
2. update `tests/portable-agent-bundle.test.mjs`, which asserts the exact roster and
   skill manifest and fails on drift;
3. update the Claude Code adapter only if the role's mode is `subagent`.

The test is the guard; this page is the explanation. Neither substitutes for the
other.
