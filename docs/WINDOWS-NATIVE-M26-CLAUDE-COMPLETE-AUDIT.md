# Milestone 26 — Claude Code complete Windows release audit

**Scope:** Option 2 (Claude Desktop **Code tab**, with CLI usage an independent
acceptance surface). This is a **source-only handover**, not an installer or an
accepted Windows release. The production Docker host is unchanged.

## Verified in this offline environment

- Option 2's selected source archive contains the 17 expected Claude Code
  agent definition files, the agent-to-MemoryCore identity map, session and
  subagent hook handlers, Office event adapter, Ghost source, Office bridge,
  dashboard, source preflight and native Rust bridge/supervisor source.
- The Claude Code integration test suite exercises hook parsing, settings
  merge, agent identity and memory hook behaviour. The independent read-only
  Windows planner `native/windows/plan_claude_code_windows.mjs` derives the four
  direct-executable hooks using existing tested merge logic. It never writes
  settings, copies agents, registers MCP, modifies credentials or provisions
  MemoryCore. It rejects nonlocal/unsafe Windows path strings and executable
  names other than `node.exe`. It **does not** output unrelated existing
  settings (which can contain credentials).
- Office and Ghost source inclusion is not equivalent to running services.
  `office/` contains three deployment/provenance documents, **not** the pinned
  Office application's frontend/backend. The Office runtime is intentionally
  an external dependency: `ali3nz/claude-office`, pinned at
  `95d8bdc5728b23bcf0fee4c371b35e071c44f642`. A native runtime build,
  pinned source/provenance and real event/display acceptance are missing.
- The legacy `scripts/install-claude-code.mjs` deliberately refuses Windows;
  the Windows staging script stages source and a caller-supplied Rust executable
  only. No complete setup, upgrade/uninstall or service lifecycle exists.
- The Ghost agent currently names a Claude Code backend in the legacy full
  option. **Zero free Claude workers is a real capacity constraint**. The
  separate OpenChamber/OpenCode adapter does not automatically make Ghost's
  backend, worker leases or recovery operable. No automatic paid fallback.
- RepoQL remains **1.7.18, ABI 1**. Claude Office stays in its proven
  **server-side token-in-URL** authentication mode; the dashboard strips the
  token from browser-facing URL/path. Do not replace this route by default.
- Dashboard usage is scoped to `claude-desktop-code`, NOT OpenChamber,
  Freebuff or Fleet usage. Complete subscription totals and quota windows
  remain **Unknown** without an authoritative installed-GUI collector.

## Generate a read-only Windows settings plan

```powershell
node native/windows/plan_claude_code_windows.mjs `
  --variant 2 `
  --repo-root 'C:\Users\Example\AppData\Local\Singularity\current\source' `
  --node-exe 'C:\Program Files\nodejs\node.exe' `
  --existing-settings 'C:\Users\Example\.claude\settings.json'
```

The displayed paths are examples, not approved installed locations. The
planner only shows Singularity-owned planned hooks and new environment path
keys; it does not reveal pre-existing keys or full settings. It does **not**
validate filesystem ACLs, actual binary signatures, existing path ownership,
GUI-managed settings scope or actual hook execution. Use a private test
user, backup settings, then validate exact target GUI/CLI settings behaviour
before writing any live configuration.

## Native Windows acceptance checklist for Codex

1. **Compile on native Windows**: Rust bridge, Harness authority and supervisor;
   run fmt/clippy/test including named-pipe/Job Object process containment.
2. **Resolve Claude Code target**: identify actual CLI and Desktop Code-tab
   settings scopes and hook support for the installed version. Verify the
   17-agent roster is visible in both intended surfaces without overwriting
   existing agents. Confirm all four hooks execute with real Windows paths.
3. **Production-equivalent memory**: prove session capture and recall in a
   **new** Claude Code session, per-agent isolation, candidate assessment,
   documentation review and verified ingestion, conflict correction, and
   RepoQL MCP indexing/query through the actual 1.7.18 binary and connectors.
4. **Full-only services**: build and authenticate pinned Claude Office from
   its own source without Docker/WSL; deliver actual Claude Code metadata
   events; verify office pixels, iframe authentication, and restart. Start
   native Ghost, edit and revert a prompt, and demonstrate dream recovery.
   With no Claude worker slots, require explicitly configured and authorized
   separate backend; queue tasks if capacity is zero, never assume success.
5. **Dashboard**: verify actual CPU collector and history, per-installation
   isolation, verified usage receipt source, unknown subscription allowances,
   Ghost and Office navigation/proxies, live memory graph and Kanzo/Agent Chat
   durable delivery. Check correct authentication and no token leakage.
6. **Release lifecycle**: clean-install, upgrade, rollback, uninstall, reboot,
   ACL/reparse-point checks, and a native process/dependency trace proving no
   Ubuntu, Docker or WSL requirement. Preserve all existing user configuration.
7. **Evidence**: export signed/dated operational receipts for production and
   Windows, not only source tests or HTTP 200 probes. Gate every advertised
   mandatory feature on real behaviour. Keep release status **BLOCKED** until
   all required tasks pass.

## Automated gates

`python native/windows/claude_complete_release_audit.py <option2.zip>`
checks the complete source inventory, and emits explicit runtime blockers.
`--require-release-ready` exits nonzero (3) for source-only packages; this is
intentional and must not be bypassed by green unit tests.

`node --test native/windows/plan_claude_code_windows.test.mjs` validates the
read-only plan, direct-exec hooks, refusal of unsafe paths, idempotent settings
merge inputs and avoidance of secret disclosure. Neither test certifies an
installed Windows system.
