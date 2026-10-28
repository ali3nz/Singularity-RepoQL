# Singularity — contributor agent instructions

These instructions apply to AI agents working **on this repository**. The
runtime agent policy that ships to users is `openchamber/AGENTS.md`; the agent
definitions users load are `openchamber/agents/*.md`.

## What this repository is

Singularity-RepoQL packages a self-hosted agent memory stack (TencentDB Agent
Memory: memory-core + memory-hub + proxy) plus the RepoQL integration, shipped
through exactly four installation options (`--variant 1-4`): the OpenChamber
bundle connects to
the user's existing RepoQL installation (code intelligence through the
`repoql` MCP server).

- `openchamber/` — OpenChamber configuration bundle: runtime AGENTS.md, seventeen
  agent definitions (nine primary, eight subagent, including `ghost`), ten skills
  under `openchamber/skills/`, OpenCode config, the `product-office` plugin
  (memory capture + Office event forwarding), the `runbook-nudge`
  plugin (context-time runbook/RepoQL-reminder nudges + documentation-closure
  instructions), and the RepoQL MCP
  wiring. `docs/AGENTS-SKILLS.md` is the shipped inventory: every agent, every
  skill, and what is deliberately external.
- `scripts/doc-policy.mjs` + `scripts/doc-ingest-node.mjs` — the SHARED
  documentation policy and automatic MemoryCore runbook ingestion used by both
  OpenChamber and the Claude Code integration
  (`adapters/claude-code/doc-hook.mjs`).
- `adapters/claude-code/` — Claude Code integration: native `singularity-*`
  subagent definitions, memory hooks (recall/capture), documentation hooks
  (start guidance + Stop closeout check), settings-merge installer.
- `memory/upstream/` — vendored upstream quickstart (byte-exact upstream).
- `office/`, `ghost/`, `compose/`, `scripts/`, `adapters/`, `templates/` — helpers;
  Office and Ghost are the bundled parts of installation options 2 and 4
  (Claude Office visualizer, Ghost persistent companion agent that dreams).
- `docs/`, `tests/` — documentation and validation.

## Ground rules

- Never commit runtime state, credentials, generated memory data, host-specific
  paths, or internal infrastructure references. `.gitignore` covers the common
  cases; extend it when you add new outputs.
- Never print secret values into chat, logs, commits, issue text, or test
  output. Reference them by variable name and file location only.
- `memory/upstream/` is byte-exact upstream code. Do not edit those files in
  place — wrap or document changes elsewhere and keep
  `memory/upstream/PROVENANCE.md` accurate.
- `openchamber/opencode.jsonc` targets current OpenCode config semantics
  (singular `plugin` key). Validate config after edits.
- The RepoQL integration is part of this repository's product surface
  (`mcp.repoql` in `openchamber/opencode.jsonc`, `compose/repoql.override.yml`,
  `docs/REPOQL-SETUP.md`). Keep it working; `tests/validate-local.sh` checks
  the bundle statically. `repoql`/`rql` references are allowed in this
  repository; every other internal-reference pattern stays forbidden
  (`tests/forbidden-refs.txt`).
- Run `tests/validate-local.sh` before declaring a change complete:
  plugin/unit tests, JSONC parsing, script syntax, Python compile, and the
  forbidden-reference scan. `tests/validate-memory-loop.sh` needs a running
  stack and is the release acceptance suite.
- Follow existing conventions, prefer the smallest change, and do not expand
  scope. If a change affects documented behavior, update the matching
  document under `docs/` in the same change.
- Material tasks report a documentation outcome (`DOC_UPDATED` /
  `DOC_NOT_REQUIRED` with a reason / `DOC_BLOCKED`); updated runbooks are
  ingested with `scripts/doc-ingest-node.mjs` and verified searchable before
  completion is claimed. `node scripts/doc-policy.mjs check` verifies any
  task's closure deterministically (`docs/DOC-INGESTION.md`).

## RepoQL feedback

RepoQL is part of the product surface, so its defects are part of our work.

Every RepoQL defect, limitation, or confusing behavior met while building,
testing, or running anything here gets **one structured report** in
`repoql-feedback/`, following `repoql-feedback/TEMPLATE.md`: the exact version
and environment, the exact command or call, expected versus actual, a
reproduction, redacted evidence, and an explicit attribution section.

Attribution is not optional. A report earns a maintainer's time only when it
argues, from observed behavior, that RepoQL itself is at fault. Harness, client,
host, environment, and agent mistakes are not RepoQL reports — mislabeling them
burns exactly the signal this directory exists to create.

Never put a credential value, personal or customer data, or an identifying
private hostname into a report — or into the chat, log, or commit that carries
it. Report the shape and the location, never the value.
