# Milestone 76 — Claude Code Complete dashboard, connectors, hooks, agents, release gates

**Status: SOURCE IMPLEMENTED; WINDOWS ACCEPTANCE BLOCKED.** This is an audit of the recovered Milestone 75 source, not a report of executing the native GUI or a signed release. The source-only dashboard is shipped in the selected Option 2 profile, but until this change was not wired into the phased installer. No Windows services, Task Scheduler jobs, connector imports or real authenticated dashboard pages were touched here.

## Actual findings and changes

1. **Dashboard was packaged but unregistered.** The component classifier intentionally ships dashboard files without installing them by default. Added an explicit current-user dashboard lifecycle: `DashboardPlan`, `DashboardRegister -Apply`, `DashboardVerify`, `DashboardStart -Apply` and `DashboardRemove -Apply` in `native/windows/install_claude_complete.ps1`, backed by `native/windows/manage_claude_complete_dashboard.ps1` and `claude_complete_dashboard_host.py`.
2. **Native dashboard source flags were wrong.** Fixed `dashboard/.env.windows.example` to select the Claude Code Complete profile. The host helper forces `SINGULARITY_WINDOWS_NATIVE=1`, `SINGULARITY_INSTALL_VARIANT=2`, fixed loopback bind/peer allowlist, explicit native RepoQL executable, user-chosen workspace and a protected user-private state directory. It neither downloads binaries nor issues credentials in task arguments.
3. **Task ownership, uninstall and upgrade gap.** Registration requires a pinned RepoQL 1.7.18 + connector ABI 1 preflight, the exact staged source, current user, low privileges, and a receipt. Removal verifies the owned task and retains state. Uninstall removes the dashboard task before removing the supervisor task and staged files. Stage retire, rollback, and upgrade planning refuse active or unknown dashboard dependencies. A crash between journal and registration produces a **blocked manual-recovery state**, not a guessed clean install.
4. **Connector source presence did not prove installation.** Both source connectors carry ABI 1; TypeScript type checking passes for `connectors/memorycore` and `connectors/kanzo`. Added `native/windows/verify_option2_connectors.py` to require a unique, fresh, active RepoQL registry/import row for each scheme. It uses the existing dashboard connector adapter, never automatically installs imports, and never equates a registered connector with a working MCP call.
5. **RepoQL parity used host-absolute file addresses.** The source now uses repo-root-relative `file:///` URIs for read and index query, using the explicit chosen workspace as the CLI current working directory. The indexed-file count uses RepoQL's documented `rql query --json` form rather than assuming a human-readable two-line table. The exact RepoQL 1.7.18 CLI behavior must be confirmed live; a decorated JSON envelope will fail closed.
6. **Incomplete release gates.** Added `repoql_connectors_kanzo_memorycore_active` and `native_dashboard_authenticated_http` to the evidence matrix. These 19 gates are evidence slots, not reported success. Updated the release source audit to require dashboard registrar/host, connector verifier, native gate and connector adapter.
7. **Confused `AGENTS.md` authority.** Rewrote root contributor `AGENTS.md` to describe only the supported Claude Code Complete integration and to distinguish it from the installed runtime rule `~/.claude/rules/singularity-workflow.md`. Corrected the standalone agent's reference to that installed rule. The installer still owns 17 agent definitions, 10 Singularity skills, 4 memory/documentation events and 7 Office event types; the official RepoQL Claude plugin owns its MCP and 17 expected plugin skills, while project `.mcp.json` owns Kanzo. Source/static inventory does not certify native GUI discovery.

## Operator workflow (test Windows account)

After building both Rust binaries, validating the source and acceptance bundle, preparing it and staging it via the documented phased installer, plan the dashboard separately:

```powershell
.\native\windows\install_claude_complete.ps1 -Mode DashboardPlan
.\native\windows\install_claude_complete.ps1 -Mode DashboardRegister -Apply `
  -PythonExe 'C:\Python\python.exe' `
  -RepoqlExe "$env:LOCALAPPDATA\rql\rql.exe" `
  -Workspace 'C:\Projects\ExampleWorkspace'
.\native\windows\install_claude_complete.ps1 -Mode DashboardVerify
.\native\windows\install_claude_complete.ps1 -Mode DashboardStart -Apply
python native/windows/verify_option2_connectors.py `
  --rql-exe "$env:LOCALAPPDATA\rql\rql.exe" --workspace 'C:\Projects\ExampleWorkspace'
```

**Do not use sample paths without checking real installation paths.** The dashboard's credential link must be generated and opened locally, and must never enter receipts, screenshots or chat. On Windows verify the task principal, action, trigger, listener, authenticated dashboard route, official RepoQL Control Panel handshake and issuance, Tencent/Kanzo proxies, source index, connector freshness and actual MCP calls. The dashboard's launch task does **not** start Tencent/Office/Ghost/Kanzo daemons; those are independent prerequisites and acceptance gates. The dashboard can report truthful unconfigured states while dependencies remain unavailable.

Rollback/remove dashboard task **before** any stage retirement or upgrade. Registration does not start it; explicit `DashboardStart -Apply` starts the current-user task. Any scheduler or ownership ambiguity blocks mutation.

## Evidence collected on this host

- Connector TypeScript compile/type checks: both `tsc --noEmit` clean.
- Changed Node parity fixture checks and focused installer/dashboard source checks passed.
- Existing Claude configuration / project MCP focused test modules passed.
- Bundle scanner and source release audit to be recorded in the milestone receipt.
- **Not executed here:** Windows PowerShell, scheduled task registration, Python native listener, real RepoQL/Tencent/Kanzo services, live connector sweeps, the Claude Desktop Code tab, official RepoQL plugin invocation, Office/Ghost, reboot, uninstall, and Rust compilation.

## Release rules

A valid source tree or matching manifest is not proof of `rql.exe` signature/provenance, plugin launch ownership, real connector installation, panel authentication, native GUI integration or production readiness. Keep `releaseReady=false` until Codex verifies every relevant live gate on Windows and records redacted evidence.

## Optional Rust route selection

The Windows acceptance bundle can carry
`bin/singularity-dashboard-routes.exe`. After staged inventory verification,
add `-UseRustDashboardRoutes` to the existing `DashboardRegister` command
to opt in. The registration binds the executable's staged SHA256 to the
scheduled task and startup checks it again. Existing registrations are
unchanged. To switch an existing task or restore the default, remove its
owned task through `DashboardRemove -Apply` and register again with or
without the flag. This does not reset dashboard state or credentials.

Authentication and origin checks still run in Python before dispatch.
The Rust selector receives only the public route key and read/write flag,
then its result must match the Python route. It does not receive request
bodies, tokens, cookies, query parameters, or private path suffixes.
Native Windows authenticated browser acceptance is still required.
