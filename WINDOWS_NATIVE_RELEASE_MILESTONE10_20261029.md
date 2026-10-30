# Singularity RepoQL — native Windows Milestone 10 (source only)

Date: 2026-10-29 NZDT. Baseline: original repository main at `4f3d0f971f09ec677e7d4e5e49147476c054b311`; cumulative source work through Milestone 10. **RELEASE BLOCKED.** The four source ZIPs are neither executables nor installed Windows services. WSL is not an accepted dependency. RepoQL remains **exactly 1.7.15 / connector ABI 1**. The operator requested the established Claude Office token URL as the default rather than migrating to a private key file by default.

## Implemented in this turn

1. **Office: production-compatible token URL is the native Windows default.** `dashboard/native_panel_proxy.py` now uses `SINGULARITY_OFFICE_NATIVE_AUTH_MODE=legacy_url` by default for native Windows, retains explicit `key_file`, and never sends the token URL to the iframe. `dashboard/office_bridge.py` requires an HTTPS public origin matching the configured embed URL with exactly one `token`, `embed=1`, and optional single `room=modern|dm`. Unknown query parameters and origins fail closed. Linux semantics remain unchanged. Private configurations are not included in packages. `docs/WINDOWS-OFFICE-AUTH-ROLLBACK.md` covers both policies and source-level reversal. There is no authentication bypass; token exchange remains server-to-server on loopback.
2. **Rust native GUI event connector reuses the same token URL where no explicit Office JSON config was supplied.** `native/desktop-bridge/src/office.rs` implements validated credential sourcing for `office-claude` and `office-opencode`, a fixed local `/api/v1/events` transport, and `office-auth-check` diagnostic with redacted output. An explicitly supplied `SINGULARITY_OFFICE_CONFIG` retains its own endpoint/ingestKey without fallback if invalid. This Rust change **has not been compiled locally or tested against an actual Office event receiver**; whether its event endpoint accepts this exact key must be proven on Windows. Dashboard and event ingestion are different integration surfaces.
3. **Office end-to-end proxy simulation.** An actual local fake Office HTTP server received dashboard GET and POST through `native_panel_proxy.serve`; the forwarded `X-API-Key` held the token but the browser response contained no secret. The same test confirms invalid HTTP token URLs fail before contacting the upstream. This does not prove upstream Office app rendering or live WebSockets.
4. **Tencent/Kanzo real loopback protocol simulations.** A fake Tencent server verified the request body and owner key; the dashboard response returned only allowed user identity fields. A fake Kanzo replied to `/api/ping`; its unauthenticated `/mcp` route was refused by the browser proxy. Real connector ABI/index/search or Kanban edits are not established by these simulations.
5. **Ghost prompt store native Python compatibility.** Removed unconditional Unix-only `fcntl` import; implemented single-byte `msvcrt.locking` on Windows while retaining POSIX `flock`. Default Windows state directory is `%PROGRAMDATA%/Singularity/ghost/prompts` unless overridden. Preserved the revision/audit format. Added concurrent writer + revert regression. This is a transitional compatibility mechanism, **not the native Rust Ghost task/control server or NTFS ACL acceptance**.
6. **Dashboard native readiness** now probes authenticated Rust Harness coordinator health separately and does not confuse it with the gateway. Live Office event acknowledgements and Ghost prompt editing remain explicitly unverified, with optional components excluded in variants 1/3.
7. **Windows CI tests** include the new Office/Tencent/Kanzo loopback tests and Ghost prompt store suite. Source-only packages are scanned for restricted files, integrity, versions, and variant separation.

## Real tests and limitations

These results establish local/source correctness only. No Rust toolchain, Windows MSVC machine, real OpenChamber Desktop GUI, Claude Desktop Code-tab GUI, installed RepoQL engine, real Tencent/Kanzo/Office/Ghost app or full clean installer was available here.

- Dashboard stdlib Python suite: 44 passed (including new Office/Tencent/Kanzo roundtrips).
- Ghost prompt store Python suite: 9 passed (including concurrent writers).
- Native Windows Python source contract suite: 13 passed.
- Node source regression suite (including classifier, native supervisor, OpenChamber Office adapter, ingestion and Claude doc hooks): 54 passed.
- Static four-option/connector policy verification: passed; RepoQL 1.7.15 / ABI 1.
- Rust source added for Office token URL sourcing and auth diagnostic: **compilation NOT RUN**.
- Source manifest/ZIP/patch integrity: see separately generated package receipts in this milestone.

## Remaining work possible off the Windows machine

**P0 before any release candidate approval:**

- Build Rust on both Linux and Windows CI; repair compiler errors, warnings, formatting; pin dependencies/Cargo.lock for new bridge. None of those are shown passing from this environment.
- Implement a real native Windows installer for each option with transactional staging/rollback, Windows ACLs, service identity, explicit RepoQL 1.7.15 discovery and safe uninstall/upgrade. Current ZIPs are source review only.
- Implement a Windows-native Rust process supervisor/service lifecycle; existing Node supervisor is interim and Windows service/logoff/reboot lifecycle is unproven.
- Port Rust Harness authority transport off `AF_UNIX`/Linux peer UID and Linux `/proc` (e.g. an ACL-protected named-pipe or authenticated loopback transport), preserving anti-replay/ownership guarantees; source still uses Unix-only APIs and is **not native Windows ready**.
- Implement Ghost task/control server in Rust, including authenticated loopback, idempotent task actions, prompt edit/revert, audit, and persistent service lifecycle. Python prompt store compatibility alone is insufficient.
- Complete native MemoryCore/MemoryKnowledge/MemoryProxy installation and lifecycle. Proprietary/external binaries and runtime prerequisites must be documented rather than silently bundled.
- Implement authoritative Agent Chat and Kanban write/sync operations, unified live memory graph streaming, Rust dashboard back-end migration, and tested token renewal for RepoQL/Tencent/Office. Existing probes are not application acceptance.
- Replace Linux `/proc` and systemd-specific dashboard explanatory text and Harness/nanny paths with truthful native Windows equivalents; avoid claiming that the Unix-based controls work on Windows.
- Add deterministic offline mock suites for failures, restart/resume, WebSocket reconnects, concurrent writes and unauthorized cross-service token reuse, then run full test suites on clean artifacts.
- Complete licensing/provenance, secrets scan, clean dependency lock and SBOM, and any public dependency access check (including the Claude Office fork).

**Requires the actual Windows machine:**

- Execute MSVC Rust builds and binaries; verify Windows Defender/ACLs, paths with spaces, non-admin install, UAC and Windows service events/restart/logoff.
- Verify each of the four *native GUI* options using real Claude Desktop Code tab or OpenChamber Desktop, no CLI-only acceptance or WSL.
- Verify Office iframe textures, GET/POST/WS, event ingestion and token URL, plus same-origin dashboard headers and safe rollback against your known-good configuration.
- Verify licensed `rql.exe --version` exact 1.7.15, two connector ABI1 manifests and *live* index/search operations.
- Verify real Tencent memory ingestion/recall, Kanzo card mutations, Agent Chat durable notifications, Ghost pause/resume/task/prompt revision and recovery, memory graph live stream, Windows CPU samples and GUI-specific authoritative subscription usage.
- Execute full install/upgrade/uninstall/data-preservation cycles for all options; no release without receipts.

## Release verdict

**BLOCKED / DEVELOPMENT SOURCE ONLY.** Do not replace the production Office configuration or expose tokens in release files. The proven Office URL is now the intended native Windows default but its actual Windows integration is still unverified. The native Harness, Ghost task server and four-option installer are not finished.
