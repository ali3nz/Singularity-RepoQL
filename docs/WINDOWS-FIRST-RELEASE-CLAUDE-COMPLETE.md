# Singularity Windows: Claude Code Complete — first release contract

Last updated: 2026-10-29. Status: **NOT RELEASE READY**. This is a Codex/native-Windows installation and acceptance runbook, not a claim that any distributed ZIP is an installer.

## Scope and prerequisites

Variant 2 must include the installed Claude Code Desktop **Code tab** integration; all 9 `singularity-*` agents; four hook events (SubagentStart, SubagentStop, SessionStart and Stop); Tencent MemoryCore capture, recall, extract, promotion and durable recovery; RepoQL and Kanzo MCP servers plus both RepoQL connector manifests; Agent Chat and Kanzo board/task tools; Claude Office visualizer; authentication-isolated dashboard with usage/CPU history; native Windows persistence, reboot, backup and uninstall. No Ubuntu, WSL, Docker, SSH workers or Claude free-worker quota required for core service operation.

The *complete* source ZIP currently does **not** contain a compiled Windows installer, the external pinned Claude Office app, or verified native Tencent/RepoQL/Kanzo daemons. Never tell an end user it is ready to run from its archive alone. For `-Apply` use a test Windows account and explicit operator approval; never change a working production installation.

## Version and supply chain

- Obtain native RepoQL from its **official** Windows installer at `https://downloads.repoql.ai/latest/install-rql.ps1`. First run `powershell -NoProfile -File native/windows/provision_repoql.ps1` in audit mode; inspect the downloaded reviewFile in the audit JSON, compare it with the official site and note its SHA256, and only then use `-Apply -InstallerSha256 <reviewed SHA256>`.
- The **installed latest RepoQL** is not automatically the **certified compatible RepoQL**: this source currently requires **1.7.18 and connector ABI 1**. If the official newest version differs, update the pinned gates and run both real connector conformance suites before signing any package. Do not downgrade or claim compatibility without tests. The production Docker host can remain on its current version.
- Acquire a native **Kanzo** executable from a verified upstream Windows build, or build the Rust crate natively on Windows. Its Linux/macOS shell installer is **not** a Windows provisioning method. Confirm its `mcp` stdio command and writable board storage with live handshakes; refuse release when no safe Windows executable exists.
- Build the Rust bridge, Harness authority and supervisor on a Windows runner; verify signatures/hashes and hold the binary manifest. No downloaded executable from an unverified mirror.
- The Claude Office viewer is an external pinned app, *not bundled*. Acquire and build the pinned source natively, with the established **token-in-server-URL credential method**; preserve backend token extraction and proxy behaviour. Do not replace this with keyfile or embedded browser token authentication. Validate real event delivery and prompt edit.
- Ghost is retired from the Windows product; legacy Linux variants only. Zero available Claude workers must not stall the installer, live memory capture, or persistent board operations. Never silently use a paid alternative.

## Project MCP registration (all variants; no global settings edits)

Use `native/windows/configure_project_mcp.mjs` in the extracted and validated release source, after installing actual `rql.exe` and `kanzo.exe`. For Option 2, the official `repoql@repoql-plugins` Claude Code plugin provides the RepoQL MCP server; this project installer registers only Kanzo. The RepoQL 1.7.18 executable is still required and must be independently version-verified. Existing `.mcp.json` RepoQL entries cause Option 2 to refuse installation until the operator resolves the overlap; it does not remove them automatically. The executable paths must be full local Windows drive paths; no PATH/wsl/batch/script fallback.

```powershell
node native/windows/configure_project_mcp.mjs --variant 2 --workspace C:\\Projects\\MyWorkspace --rql-exe C:\\Tools\\rql.exe --kanzo-exe C:\\Tools\\kanzo.exe
node native/windows/configure_project_mcp.mjs --apply --variant 2 --workspace C:\\Projects\\MyWorkspace --rql-exe C:\\Tools\\rql.exe --kanzo-exe C:\\Tools\\kanzo.exe
# Roll back only if the generated file has not been changed by anyone else:
node native/windows/configure_project_mcp.mjs --rollback --workspace C:\\Projects\\MyWorkspace
```

For Option 1, this writes **project `.mcp.json`** with `mcpServers.repoql` and `mcpServers.kanzo` using `rql.exe mcp` and `kanzo.exe mcp`. For Option 2, it writes **only `mcpServers.kanzo`**, while the official RepoQL Claude plugin owns RepoQL MCP registration. Claude Code must approve and show both the plugin-managed RepoQL server and project Kanzo server **connected** in `/mcp`, with an actual tool call through each server. For variants 3/4, it writes **OpenCode 2 `opencode.json`** with `mcp.servers.{repoql,kanzo}` using the executable as a command array; OpenChamber Settings → MCP must show two working servers. It refuses to overwrite a preexisting `opencode.jsonc` instead of creating an ambiguous duplicate configuration. Existing MCP names owned by others are never replaced.

These registrations are **project-scoped**, not automatically made available to every arbitrary project or every Claude Code session. A subsequent installed-product release needs an explicitly authorized per-user registration strategy and scope verification. A project MCP is not a substitute for dashboard process configuration, connector installation, or the Agent Chat relay.

## Claude Code hooks and agents

After verified MemoryCore configuration and Node installation, run the **native Windows Claude settings installer** `native/windows/configure_claude_code_windows.mjs` in read-only mode, then its documented opt-in `--apply` in an isolated account. It must install all 17 agent definitions, four memory/documentation hooks and seven Office hooks with the runtime import closure, without replacing foreign settings. Confirm hook execution by starting a mapped Singularity subagent, saving one qualified lesson, closing and starting another session, then checking the recalled lesson and exactly-one stored record after retry. The real Node subprocess/HTTP process tests can be run offline before native GUI tests.

The agent instructions in `openchamber/AGENTS.md`, shipped Claude agent definitions and shared doc-policy hooks are normative for decision rules; they do not themselves prove that their MCP endpoints or memories were installed. When a required tool is unavailable, state it and block dependent features, rather than inventing a tool, card, memory, usage sample or Ghost activity. Material changes must pass documentation closure and searchable ingestion.

## Integration acceptance: refuse false positives

For each installed variant, preserve redacted machine-readable receipts for: native RepoQL executable/version plus actual MCP `tools/list`/index/query; both `connectors/memorycore` and `connectors/kanzo` performing one create/search/readback; Tencent L0/L1 new-session capture and recall, promotion and conflict correction with source evidence; Kanzo board create/update/readback and Agent Chat persistent delivery across restarts; dashboard active-session authentication and correct GUI-only usage attribution, explicit **unknown** subscription quota if not authoritative, CPU history isolated to this variant; and (variant 2/4 only) real Ghost scheduled lifecycle and Claude Office rendered events/prompt edits.

Run native clean install, restart, upgrade and rollback/uninstall **without** `wsl.exe`, `docker.exe`, docker services, Linux `/proc`, systemd, bash or SSH agents; gather process tree and service/task scheduler evidence. Fail when any required live receipt is missing. The existing `native/windows/runtime_closure.py`, `native_runtime_acceptance.py`, `compare_production_parity.py` and `claude_complete_release_audit.py --require-release-ready` provide the release gate scaffolding. A 200 health status, imported module or dashboard page is not a substitute for end-to-end proof.

## Product release packaging decision

**Prefer a signed full Windows installer** only after native binaries and embedded/verified external application assets are available and reversible install lifecycle passes. Until then, an **agent-guided install from the repository** is an acceptable development preview, but must run this fail-closed checklist and clearly display which services remain unavailable. Users should not be asked to execute arbitrary unsigned scripts, disclose credentials or blindly run curl/PowerShell `iex` commands.

## Milestone 32 Claude Complete clarification: skills, model and memory contracts

The native Claude configuration installer now adds ten skills (see
`docs/WINDOWS-NATIVE-M32-CLAUDE-FLEET-MEMORY-SKILLS-AUDIT.md`), while retaining
all 17 agent definitions, four lifecycle hooks and guarded rollback. No agent
pins a default model: the effective model comes from the installed Claude Code
configuration and must be observed in the real GUI/CLI. Eight delegated agents
have per-role Tencent hooks; the nine main-session roles use separate main
session logic, not individual subagent hooks. Native install does not seed
profiles by itself. Run `scripts/setup-agent-profiles.mjs` against the real
MemoryCore and validate each identity before release. Docs closeout proves
Tencent indexing only; independently confirm RepoQL can retrieve the same
updated document after its workspace index finishes. The full product release
remains blocked while live identities, dual-index readbacks or GUI skill
activation are missing.
