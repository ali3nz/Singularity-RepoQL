# Native Windows test handoff (Milestone 10)

This document is for an isolated Windows machine with Codex assistance. It is
not a product installer and should not be run against production. Use PowerShell
and native MSVC Rust, not WSL. Preserve GUI configuration and existing memories.

## Test order

1. Take a machine snapshot and export **private** backups of the Windows GUI
   configurations and service states. Never upload real token URLs or secrets.
2. Confirm `rql.exe --version` is exactly 1.7.15, verify both connector ABI 1
   manifests, and verify native paths without executing installer mutations.
3. Run `native/windows/preflight.ps1` with the chosen option and explicit local
   executable paths. This checks only file hashes and listening ports; do not
   mistake its successful exit for an installed service.
4. Run `cargo fmt --check`, `cargo clippy --all-targets -- -D warnings`,
   `cargo test` and `cargo build --release` on `native/desktop-bridge` from native
   Windows. Use `--no-default-features` for options 1/3 and
   `--no-default-features --features office,ghost` for options 2/4.
5. For options 2/4 set `SINGULARITY_OFFICE_NATIVE_AUTH_MODE=legacy_url` (or omit
   this variable; it is the default), and use the **existing private**
   `CLAUDE_OFFICE_PUBLIC_URL` and `CLAUDE_OFFICE_EMBED_URL` values. Do not copy
   or rewrite the token URL into a tracked file. Run
   `singularity-desktop-bridge.exe office-auth-check` and verify only redacted
   metadata is printed. Check same-origin iframe loading, sprites and WS.
6. Test RepoQL dashboard login, Tencent identity verification, Kanzo ping and
   actual card mutations, Agent Chat durable delivery and Rust Harness health.
   Distinguish `reachable` from completed end-to-end acceptance. Verify Ghost
   task control and prompt edit/revert only for options 2/4.
7. Run one **real GUI** Claude Desktop Code tab session (1/2) or OpenChamber
   Desktop session (3/4) and verify scoped memory capture and *new-session*
   recall, actual tool calls and Office events where enabled. Neither CLI-only
   integration nor a standalone MCP test is an acceptable substitute.
8. Force controlled restart, crash/recovery, second concurrent writer, logoff
   and reboot. Verify process ownership, persisted data, Windows service start
   identity, NTFS ACLs and no unknown service or user process was stopped.
9. Measure CPU using actual Win32 samples, and display only supported,
   source-attributed Claude/OpenChamber subscription usage. Unknown entitlement
   or token allowance must remain unknown, never substituted with Harness data.
10. Test reversible upgrade and clean uninstall with retained memories, user
   settings and Office URL backup. Obtain explicit approval before promoting
   release artifacts or modifying GitHub main.

## Acceptance receipt

For EACH option record commit/archive digest, Windows build, GUI build,
RepoQL/connector versions, process identity, which concrete commands ran,
what GUI action was observed, service restart evidence, actual queries and
responses with secrets redacted, Windows logs, data/ACL changes, rollback
result and any failures/skips. Require all critical checks pass before
marking the option ready.
