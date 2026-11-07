# Native Windows unified graph gateway (Rust source candidate)

This is a **reviewed source port**, not a claimed tested Windows installer.
Original data plane: Dockerhost `repoql-dashboard-latest.zip`, crate
`unified/rust`. Preserves the existing HTTP `/v1/*` graph, usage and Tencent
catalog contracts while changing Windows origin policy and configuration.

## Windows differences

- RepoQL and Tencent upstreams must be explicit IPv4 loopback HTTP origins.
- `UNIFIED_REPOQL_TOKEN_FILE`, `UNIFIED_GATEWAY_TOKEN_FILE`, and (if Tencent is
  configured) `UNIFIED_TENCENT_USER_KEY_FILE` must refer to existing absolute
  files in independently ACL-protected local storage. No Dockerhost defaults.
- Tencent mutation from the Windows dashboard gateway is forcibly disabled,
  regardless of `UNIFIED_TENCENT_WRITES`. Actual memory capture belongs to
  the separately authenticated Windows MemoryCore connector and hooks.
- The listening socket is fixed `127.0.0.1:18101` unless a reviewed local port
  change is made; the Windows dashboard owner check is pinned to this same
  binary in the staged product `bin` directory.
- Runtime `--check` validates configuration without listening or accessing
  records. A passing check is **not** a healthy data source or a proof of
  Windows-local memory contents.

Do not configure an SSH tunnel to a Dockerhost listener as a substitute. The
current Windows Tencent skill gateway and memory core may not expose all the
Dockerhost wiki graph endpoints. If `/api/v1/knowledge/wiki/graph` or the
RepoQL links API is unavailable, the graph must report the source failure and
remain unaccepted until the real Windows adapter contract is established.

Build on native Windows with a pinned toolchain:

```powershell
cargo test --locked --manifest-path .\native\windows\unified-gateway-rust\Cargo.toml
powershell -NoProfile -File .\native\windows\build_unified_gateway.ps1
powershell -NoProfile -File .\native\windows\build_unified_gateway.ps1 -Apply
```

Configure and register the dedicated **current-user** task with
`manage_unified_gateway.ps1` only after independently verifying the Windows
RepoQL authentication token and Tencent local gateway schema. The task is not
started automatically. Disable the **verified** project-owned SSH tunnel via
`disable_unified_tunnel.ps1` before starting the local gateway. Registration
must not modify unrelated services, shared credentials or task schedules.

Acceptance requires (1) a real Windows Rust build/lock evidence, (2) exact
listener process path, (3) token-authenticated health, (4) graph and source
errors from local endpoints, (5) unique Windows-only fixture nodes/edges,
(6) a Dockerhost-only negative fixture absent from the Windows graph,
(7) restart/reboot and authenticated browser readback. Until all tests pass,
mark graph locality **NOT VERIFIED**. See `docs/WINDOWS-LOCAL-UNIFIED-GATEWAY.md`.

## Windows Kanzo stage diagnostics (read-only Rust CLI)

`cargo build --locked --release --bins` produces a separate
`kanzo_board_audit.exe` beside the unified gateway executable. From a local
Windows account with a verified `kanzo.exe` listener, run
`native/windows/audit_kanzo_board.ps1` for read-only stage counts. This tool
reads the native Kanzo board JSON, validates `todo`, `doing`, `review`, `done`
and `backlog` statuses and reports the count of older hidden closed tasks.
It does not copy task details, create claims, write a board, or mark work
accepted. An authoritative `doing` status is a Kanzo stage, not evidence
that an agent has claimed the card. Actual claim/closeout verification uses
the installed Kanzo MCP and independent task readback.

Hub document cross-links are disabled by default on Windows. Only when the
locally indexed RepoQL import has been independently verified can an operator
supply `-HubDocUriPrefix` to the native gateway registration script. This must
be the exact `github://` import root ending in `/`. The original Dockerhost
hub URI is no longer an implicit Windows default.
