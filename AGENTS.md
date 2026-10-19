# Singularity — contributor agent instructions

These instructions apply to AI agents working **on this repository**. The
runtime agent policy that ships to users is `openchamber/AGENTS.md`; the agent
definitions users load are `openchamber/agents/*.md`.

## What this repository is

Singularity-RepoQL packages a self-hosted agent memory stack (TencentDB Agent
Memory: memory-core + memory-hub + proxy) with optional integrations, plus
the RepoQL integration this variant adds: the OpenChamber bundle connects to
the user's existing RepoQL installation (code intelligence through the
`repoql` MCP server).

- `openchamber/` — OpenChamber configuration bundle: runtime AGENTS.md, seven
  agent definitions, OpenCode config, the `product-office` plugin
  (memory capture + optional Office event forwarding), and the RepoQL MCP
  wiring.
- `memory/upstream/` — vendored upstream quickstart (byte-exact upstream).
- `office/`, `compose/`, `scripts/`, `adapters/`, `templates/` — optional
  components and helpers.
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
- The RepoQL integration is part of this variant's product surface
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
