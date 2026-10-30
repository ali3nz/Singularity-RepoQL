# M77 — RepoQL bare version output and dashboard truthful dry-run

**Scope:** Claude Code Complete, native Windows source checkpoint. **Release remains BLOCKED.**

## Defects corrected

1. An operator reported that RepoQL `rql.exe --version` prints bare `1.7.18` on Windows, rather than `rql 1.7.18`. Source in M76 rejected the bare form in Python preflight/dashboard, Rust bridge, JavaScript project MCP/document-parity and PowerShell staging/preflight/provisioning probes. M77 accepts exactly one bare `1.7.18` (also `v1.7.18`) or one unambiguous versioned RepoQL banner, while still rejecting other versions, conflicting output and arbitrary library-version text. No release pin or ABI requirement was weakened.
2. `native/windows/manage_claude_complete_dashboard.ps1` derived `taskRegistered` partly from `-Apply` and the requested mode. Thus a `Register -Apply -WhatIf` operation could falsely report registration. M77 computes registration only from a **fresh** scheduler query and an owned matching task receipt, and refuses partial or ambiguous registration. `-WhatIf` still does not mutate the task; the output should now reflect no task when none exists.

## Changed production files

- `native/windows/repoql_compat.py` (also used by the dashboard's native RepoQL gate and runtime acceptance)
- `native/windows/configure_project_mcp.mjs` and `native/windows/claude_complete_doc_parity.mjs`
- `native/desktop-bridge/src/repoql_compat.rs`
- `native/windows/preflight.ps1`, `native/windows/stage-native.ps1`, `native/windows/provision_repoql.ps1`
- `native/windows/manage_claude_complete_dashboard.ps1`

## Validation available here

Targeted Python and JavaScript tests verify bare and banner formats, wrong/ambiguous versions, existing project MCP behavior and source-level dashboard wiring. PowerShell/Rust checks are **source contracts only** on this Linux host (no `pwsh`, `cargo` or `rustc`). Do not present them as compiled or native executions.

## Windows acceptance still required

- On a disposable approved Windows environment, run the **real verified** RepoQL 1.7.18 `rql.exe --version` and every affected probe, confirming the exact reported stdout.
- Compile the Rust bridge and run its native RepoQL preflight with the real executable; compare results to the Python, JavaScript and PowerShell paths.
- Verify `manage_claude_complete_dashboard.ps1 -Mode Register -Apply -WhatIf` reports `taskRegistered:false` with no existing task. Then explicitly approve registration, require `taskRegistered:true` only after an owned task is independently observed. Verify removal and partial-state failures.
- The existing Windows acceptance ZIP contains older binaries; **rebuild from M77 source**. Do not promote an old ZIP or claim its Rust bridge contains this fix.
- Check publisher provenance separately; this patch does not establish a digital signature or authenticated supplier.

All other outstanding M76 live acceptance requirements remain: dashboard listener/browser authentication, real RepoQL connector sweeps, native Claude Desktop Code tab, Tencent, Office, Ghost, hooks, reboot, rollback and uninstall. The changes do **not** install or alter any live service here.
