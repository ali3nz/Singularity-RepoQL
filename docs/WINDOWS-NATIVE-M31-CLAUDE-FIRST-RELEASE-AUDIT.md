# Milestone 31 — first release candidate preparation: Claude Code Complete

Last updated: 2026-10-29

**Gate: BLOCKED / SOURCE ONLY.** This milestone extends integration code; it does not contain actual Windows runtime executables, a complete installer, or a working external Claude Office build.

## Implemented and locally tested

- Project-scoped **RepoQL + Kanzo MCP registration** for all four variants: Claude Code `.mcp.json` and OpenChamber/OpenCode **v2** `opencode.json` `mcp.servers`; explicit local `rql.exe mcp` and `kanzo.exe mcp`, no WSL/SSH/Docker launcher; project configuration conflict checks, backup, journal and guarded rollback.
- **RepoQL 1.7.18 / connector ABI 1** is still the certified source policy. Official latest installer download and review-first optional update script added. Upgrading to a different latest version BLOCKS release until all version gates are migrated and real Tencent/Kanzo connector conformance reverified. Public version number of the latest official release was not independently established by this work.
- Claude Code native settings installer now includes a **shared workflow rule** (`.claude/rules/singularity-workflow.md`) with 17 agent definitions and four event hooks; source SHA verification, foreign rule collision refusal, tamper-aware rollback, and verification of rule drift.
- The previous pending Claude memory fix is incorporated: retry-stable task identity and no recalled content from MemoryCore API-level failures. Real Node subprocess/HTTP tests establish behaviour with mock backend; no native Tencent parity claim.
- Legacy Linux/OpenCode v1 `openchamber/opencode.jsonc` with `/usr/local/bin/rql` excluded from **Windows** variants, retained in the complete source for historical production parity. The OpenCode v2 MCP project file is generated at installation; do not copy the old config.
- A detailed reviewed-agent installation, validation and recovery runbook exists at `docs/WINDOWS-FIRST-RELEASE-CLAUDE-COMPLETE.md`.

## Product-level acceptance matrix (all fail closed)

| Required function | Source / offline evidence | Missing native acceptance |
|---|---|---|
| Latest RepoQL binary | Review-first installer, exact 1.7.18 compatibility gate | Official latest version, binary signature/provenance; real index/query; newer version migration |
| RepoQL MCP Claude/OpenChamber | Four variant configurations, isolated FS round-trips | Real GUI `tools/list` and working query |
| Kanzo MCP + Kanban | MCP configurations, rollback tests | Native kanzo.exe provenance, board create/update/readback + persistence |
| Tencent + RepoQL connector | Connector source and compatibility manifests | Native MemoryCore host, L0/L1, indexing into both connectors |
| Claude hooks, 17 agents, workflow rules | Source-hash installer, verification and rollback tests | Real Desktop Code-tab hook delivery and agent selection |
| Self-learning | Stable idempotency, HTTP simulated capture/recall, doc ingestion tests | Cross-session verified memory, promotion, correction, replay and provenance |
| Agent Chat | Transport/relay source | Native end-to-end persisted message delivery, restart |
| Ghost | Source/prompt history tests | Native daemon, no-Claude-worker behaviour, prompt editing, recovery |
| Claude Office | Token URL backend/proxy and HTTP simulated integration | Pinned external app installed, real events and prompt editing |
| Dashboard + usage | Variant source filtering, proxy and CPU history tests | Authenticated GUI and source-accurate usage; authoritative quota if supported; browser tests |
| Installer/uninstaller | Narrow Claude configuration and MCP transactions | Entire application services, signed bins, transactional setup, reboot, upgrade and uninstall |
| No Linux/WSL/Docker | Package excludes known Linux entrypoints | Real native process/dependency trace and four full installations |

## Existing tests and handover

Use `node --test native/windows/configure_project_mcp.test.mjs native/windows/configure_claude_code_windows.test.mjs adapters/claude-code/memory-hook-process.test.mjs` and `python -m unittest discover -s native/windows -p 'test_*.py' -q`, followed by the dashboard/Ghost suites. The extracted variant test additionally imports the MCP installer from the *actual* source ZIP and performs apply/rollback in a temporary workspace. These are **not** real Windows GUI acceptance results.

On Windows with Codex: review `docs/WINDOWS-FIRST-RELEASE-CLAUDE-COMPLETE.md`, compile all Rust crates, obtain trusted native RepoQL and Kanzo executables, configure project MCP then Claude Code hooks/agents/rules, start real Tencent/RepoQL/Kanzo, Office and Ghost services, and execute the production-parity receipt suite. Do not open release gate while any component is unverified.

**Preserved:** Production Docker host untouched, Claude Office token-in-server-URL method, zero-Claude-worker OpenChamber alternative, four profile boundaries. `DOC_UPDATED`: release runbook and integration contract updated; runtime ingestion is blocked until a real MemoryCore host is available.
