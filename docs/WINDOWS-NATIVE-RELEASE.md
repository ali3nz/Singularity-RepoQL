# Native Windows public release: acceptance plan and blockers

This is the **no-WSL, no-mandatory-Docker** product path. The existing
`docs/platforms/windows.md` is a WSL route and is **not** acceptance evidence.
Do not advertise public release until all required rows below pass on a fresh
Windows 11 machine (x64 and ARM64 where upstream GUIs have supported binaries).

## Product contract

One source of truth: `native/windows/variants.json`, read by the Rust bridge
(`singularity-desktop-bridge variant N`) and dashboard's Python policy. The
payload and UI must match its feature flags; the old Linux product dashboard
remains opt-in and unchanged when no variant is supplied. Native Windows
packages must set `SINGULARITY_WINDOWS_NATIVE=1` and a valid
`SINGULARITY_INSTALL_VARIANT=1..4`; missing or invalid options refuse to start.

| Option | GUI | Core | Extra | Rust Office build |
| --- | --- | --- | --- | --- |
| 1 | Claude Desktop Code tab | Tencent, RepoQL, Agent Chat, Kanban, dashboard | None | `--no-default-features` |
| 2 | Claude Desktop Code tab | Same | Ghost and Claude Office | `--no-default-features --features office` |
| 3 | OpenChamber Desktop | Same | None | `--no-default-features` |
| 4 | OpenChamber Desktop | Same | Ghost and Claude Office | `--no-default-features --features office` |

Options 1 and 3 must not install Ghost or Office services, agents, credentials,
visualizers, event hooks or executable features. The UI and backend now disable
Ghost and Office routes; the **native installer and actual minimal package are
still unfinished**. Enabling a route in JavaScript alone is not a security gate.

## Testing required for *each* option on a clean Windows VM

1. **Dependencies:** Install the supported OpenChamber Desktop OR Claude
   Desktop GUI (the Code tab), native `rql.exe` via its licensed official
   installer, and the native Tencent dependency stack. Record exact versions.
   No WSL, `bash`, systemd, Linux Docker socket or `/proc` dependency.
2. **Rust build:** `cargo fmt --check`, `cargo test --all-targets` with the
   option's features, Clippy with warnings denied, and a signed or hashed
   release-mode executable. Confirm the binary actually starts in the GUI.
3. **Installer:** discover GUI config schema/path; show diff, back up, retain
   settings/credentials, decline safely, install, upgrade, rollback/uninstall
   without touching other plugins or sessions. Windows ACLs are verified.
4. **Memory:** two users and agent scopes, real GUI new-session recall and
   automatic write/retrieve, restart survival, compaction and extraction,
   conflict/correction outcomes, negative secret-leak tests. Check L0-L3
   semantics against a known test fixture. Mere healthcheck is insufficient.
5. **RepoQL:** native Windows **1.7.18 exactly** (connector ABI 1), MCP tools in GUI, query/index/document
   references, native dashboard iframe login and cookie restrictions. Verify
   licence, version and the connector runtime ABI. Never include a third-party
   RepoQL executable in public packages without permission.
6. **Tencent connector:** the product setup builds and fixture-tests the pinned
   `connectors/memorycore` 1.7.18 package; installation grants the fixed
   product data-folder envelope automatically; nothing else is granted. Verify read-only
   roots, redaction, L1/L2/L3 freshness, identity isolation, no raw conversation
   import, and removal against the actual installed rql version.
7. **Kanban / Agent Chat:** run local Kanzo board, install/test Kanzo RepoQL
   connector with the installer's fixed envelope, observe real card changes and comments, session inbox cursor
   integrity, cross-session isolation, concurrent authors, restart durability
   and the difference between board state and verified task completion.
8. **Dashboard:** confirm variant-specific nav and disabled backend endpoints,
   Tencent and RepoQL panels, Agent Chat/Kanban, mobile/narrow layout,
   authentication, CORS/CSRF, IPv6 loopback and a browser screenshot.
9. **Office/Ghost (2/4 only):** start real native Windows backends, forward
   GUI events without leaking message bodies, verify actual frontend presence,
   data persistence and removal. Check 1/3 have no payload or Office code.
10. **Lifecycle:** Windows Service/Task Scheduler with deliberate ownership,
    fail-closed PID start-time checks, recovery, locked files, clean shutdown,
    concurrent GUI sessions, OS reboot, and unprivileged install.
11. **Public distribution:** third-party licence/provenance, secrets/PII scan,
    SBOM, platform checksums, no caches/logs, install instructions, independent
    reproducible source build and release candidate CI passing.

## Actual current evidence and release gate

- Cross-platform Node adapter and dashboard Python regression tests can be
  run from this repository. They are **not** native Windows acceptance.
- Shared feature matrix, Rust optional Office compilation and backend route
  gates are implemented in source. They do not install or run the services.
- `dashboard/file_lock.py` enables Windows import and basic advisory locks
  for the Python host temporarily. It is **not** a Rust Windows supervisor.
- The native dashboard's `/proc` CPU collector does not yet have a Windows
  Rust process telemetry implementation and intentionally reports unsupported.
- **RepoQL compatibility now pinned:** only `rql.exe 1.7.18` with connector ABI
  1 is allowed for both Kanzo and Tencent connectors. The product setup now
  builds both 1.0.0 packages and pins their exact bytes in
  `connectors/packages.lock.json`; the source and package fixture suites pass.
  This still does not prove a live install, index or readback on Windows.
  `native/windows/repoql_compat.py`
  and Rust `singularity-desktop-bridge repoql-preflight --rql <absolute-rql.exe>`
  fail closed for 1.7.17, missing executables, failed probes and ABI drift.
  Release packaging records the pin and prohibits bundling third-party RepoQL.
  These checks do **not** prove the actual Windows connector runs; fixture/sync,
  installation, index/embedding and rollback require Windows acceptance.
- Automatic GUI conversation capture, Rust write ledger, new-session recall,
  agent handoff/orchestration, native host supervisor, Windows ACL-sealed
  credential lifecycle, installer and Office native backend remain blocked.

**Release status: BLOCKED.** Never replace a not-run check with a PASS. The
first Windows Codex task is to compile the Rust bridge and record the installed
GUI + RepoQL versions in a test VM before touching user configuration.


## Dashboard and auth acceptance clarifications (milestone 6)

The RepoQL panel's native login uses official RepoQL token issuance, not disabled authentication. Tencent, Office and Kanzo panels use same-origin session exchange and fixed upstream loopback. The new native Windows proxy rejects remote upstream hosts. Ghost tasks/prompt editing requires a native Windows authenticated control transport; its current Unix-socket adapter is unsupported on Windows. The live graph needs the real Rust unified backend. CPU telemetry needs Windows Rust process accounting. Native GUI token metrics now deliberately refuse generic Freebuff/Orchestra totals and show unknown unless a verified Claude Desktop Code or OpenChamber subscription source reports usage. Exact 1.7.18 preflight is the contract for both connectors. Full details: `WINDOWS_NATIVE_RELEASE_MILESTONE6_20261029.md`.


## Concurrent documentation ingestion and Windows path acceptance (Milestone 7)

Node and Python now use the same owner-tagged directory lock. A lock with old mtime is **never automatically removed**; waiting writers fail closed. After a crash, the operator must stop and verify every ingester, back up `data/doc-index/ledger.json`, then inspect the lock owner before any manual recovery. Windows CRLF is normalized to the same canonical revision text as Python, and configured `SINGULARITY_DOC_ROOTS` use semicolon separators on Windows. Test with genuine Windows file paths, concurrent sessions, and a killed writer before release.

## Milestone 9: safe Office rollback, Windows preflight and package scanner

The Windows Office key-file source is a configurable migration, not an irreversible removal of the previously working token URL. **Read `docs/WINDOWS-OFFICE-AUTH-ROLLBACK.md` before changing a working installation.** Native Windows defaults to `SINGULARITY_OFFICE_NATIVE_AUTH_MODE=legacy_url` (the established production token URL exchange) and supports optional `key_file` mode. Browser access remains same-origin and authenticated. Existing Linux Office behaviour is retained.

Run `native/windows/preflight.ps1` on the target Windows host using *explicit* paths to its GUI, Rust bridge and RepoQL 1.7.18 executable. The preflight never installs or starts components, never reads secrets and cannot mark an installation production-ready; listener results are not equivalent to application health. After building option source archives, `native/windows/scan_source_archive.py` checks the four manifests, SHA256SUMS, forbidden private/binary files, unsafe paths and unwanted optional features. Neither script is a substitute for a native GUI integration run.

The existing Node native-memory supervisor is additionally fail-closed for unverified process identities and rejects `stop --dry-run` as an unsafe request. Its future Rust replacement, service persistence, Windows ACLs and rollback tests remain release blockers.
