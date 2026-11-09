# Native Windows unified memory gateway installation and proof

**Status:** source candidate. The Rust gateway is present and its dependency lockfile is checked; an independently observed native Windows build, executable identity, actual data-plane acceptance and reboot test are **NOT TESTED** by this release. Never label the dashboard graph as Windows-local merely because an HTTP request succeeds.

## Why this is required

The previously observed `Singularity-Unified-Tunnel` scheduled task used `ssh.exe -L 127.0.0.1:18101:127.0.0.1:18101` to point the Windows graph at Dockerhost. The dashboard's local Python shim then forwarded the graph into the tunnel. This made **Dockerhost** RepoQL and Tencent memory visible inside the Windows UI. The source port rejects that owner and uses an executable-path-pinned Windows gateway (`bin/unified-repoql-control.exe`) instead.

**Data-flow requirement:** authenticated Windows dashboard at `127.0.0.1:18100` → Python bridge → **verified project-owned Windows Rust process** at `127.0.0.1:18101` → same Windows dashboard's read-only RepoQL API at `127.0.0.1:18100` and separately authorized Windows-local Tencent skill gateway. There is no production fleet fallback. The Rust gateway uses independent bearer secrets from local private files. A local TCP port alone does not prove data locality: independently inspect the owner, service config, and both actual data sources.

## Before any write

1. From the *actual* Windows staged checkout, compare the installed source hashes and existing task/action metadata against this reviewed candidate. Record the current Windows dashboard port, its private bearer token file path, the local RepoQL `rql.exe` path/version/index, Tencent endpoint and identity, task list and the listener process for 18100/18101/18102/18421/18431. **Do not print private tokens**. Check that neither this source candidate nor any Dockerhost SSH tunnel is hiding a newer valid implementation.
2. Confirm the dashboard at `127.0.0.1:18100` really exposes `/api/links`, `/api/hub-doc-rows`, and `/api/memory-docs` under its bearer authentication; those are what the imported Rust graph reader calls. Confirm it uses the Windows-local `rql.exe`, workspace and index. Confirm Tencent's Windows-local endpoint supports the expected `/api/v1/knowledge/wiki/graph` route and identity fields. If not, report an API contract gap instead of hardcoding or forwarding Dockerhost data.
3. Verify Rust stable/MSVC toolchain, `Cargo.lock` and `Cargo.toml`. No native binaries are in the source package. Inspect the existing `bin` directory: never overwrite a foreign binary. Confirm the state directory is per-user and unrelated data will not be touched.

## Bounded source build and task installation

All commands are PowerShell run under the intended Windows account. The build and gateway tasks are independent of the product's existing desktop bridge. Keep the ordinary dashboard process running until the candidate is verified.

From the staged source root:

```powershell
.\native\windows\build_unified_gateway.ps1
.\native\windows\build_unified_gateway.ps1 -Apply
python .\native\windows\check_rust_lock_provenance.py
```

Only `-Apply` builds with `cargo build --release --locked` and copies an otherwise absent executable into the adjacent project-owned `bin` directory. Inspect the script's output and capture the binary SHA256. The companion Rust `memory_scope_audit.exe` is built from the same crate under `target/release`, but does not need installation for the graph.

The next script takes explicit **local paths**, **not secret contents**. Use your verified per-user state directory and the actual Windows dashboard token file; never use a Dockerhost gateway token. Do not paste token bytes into command lines or logs. `-Mode Plan` does not alter the system.

```powershell
.\native\windows\manage_unified_gateway.ps1 -Mode Plan -StateDir $env:LOCALAPPDATA\Singularity\Dashboard -RepoqlTokenFile $env:LOCALAPPDATA\Singularity\Dashboard\token
```

The paths above match the native Option 2 dashboard state. The gateway manager derives them by default and refuses a divergent state directory. Run without path overrides unless the installed dashboard is independently verified to use a different accepted configuration. If the current Windows RepoQL index contains a reviewed documentation import, add the **exact** `-HubDocUriPrefix` matching that import. Omit it to disable hub document cross-links; Dockerhost is never the implicit default. If Tencent is configured, supply `-TencentBase` as the verified exact `http://127.0.0.1:18431/` origin, with independently verified `-TencentServiceId`, `-TencentUserKeyFile`, and `-WikiIds` selected by the authorized Windows identity. Test the local Tencent gateway route before expecting graph nodes. **Wiki discovery:** when `-WikiIds` is omitted the gateway discovers this identity's own wikis, team first: `meta/team/list`, then `knowledge/wiki/list {team_id}`, then `knowledge/wiki/graph` for each wiki (capped at 10, read-only actions only). Discovery failures are reported in the Tencent source's `error` list, and an identity with no wikis reports `no_wikis_for_identity`; neither is hidden or replaced with fleet data. Only proceed if ownership, ACL, binary, and both local API contracts pass.

```powershell
.\native\windows\manage_unified_gateway.ps1 -Mode Register -Apply -StateDir $env:LOCALAPPDATA\Singularity\Dashboard -RepoqlTokenFile $env:LOCALAPPDATA\Singularity\Dashboard\token
.\native\windows\disable_unified_tunnel.ps1
.\native\windows\disable_unified_tunnel.ps1 -Apply
.\native\windows\manage_unified_gateway.ps1 -Mode Start -Apply -StateDir $env:LOCALAPPDATA\Singularity\Dashboard
.\native\windows\manage_unified_gateway.ps1 -Mode Verify -StateDir $env:LOCALAPPDATA\Singularity\Dashboard
```

Registration does not start anything. The old project-owned tunnel must be independently verified before disabling; an unrelated SSH process must never be killed. The port must be unbound before starting the native gateway. `Verify` checks OS process ownership, local bearer auth, Rust health and a RepoQL graph source response. It does **not** prove that individual records originated in Windows or that Tencent memory is available. Unique Windows-only positive and Dockerhost-only negative records remain required.

## Actual acceptance

1. Through an authenticated Windows browser session, request `/api/unified/health`, then `/api/unified/graph?repoql=true&tencent=false`, `...repoql=false&tencent=true`, and the combined graph. Record sources availability/errors separately. Confirm that a source failure is visible and no stale Dockerhost graph is returned.
2. Create a temporary, unique **Windows-only** RepoQL test record through the normal approved index path, refresh/read it independently, and locate its graph node. Create or select a separate authorized **Windows-only** Tencent test record and verify graph independently. Use a known Dockerhost-only synthetic marker as a **negative** check: it must be absent in the Windows graph. Delete disposable records only using their originating authorized APIs and ownership scope. Do not copy production memory or change foreign data.
3. Verify source provenance: endpoint paths, owning processes and binaries, Windows workspace root, repoql index receipt, Tencent source identity, unique marker retrieval, and different source IDs. A `200 OK` or `rust=true` health marker alone cannot pass this gate.
4. Verify forbidden fallback: disable the native gateway and request the graph. Expected: unavailable, not a different graph. Restart native gateway and repeat. Reboot Windows and verify owned scheduled task, authenticated dashboard, and both local data sources independently. Confirm unrelated Windows tasks and services remain unchanged.
5. Run Windows `cargo test --locked` for the unified crate and the root Windows Python/JS dashboards tests. Review untested capabilities (`/v1/usage`, `/v1/openrouter`, broad Tencent catalog) separately; do not infer full product parity from graph acceptance.

**Rollback:** stop and remove only `Singularity-Windows-Unified-Gateway` using `manage_unified_gateway.ps1 -Mode Stop -Apply` and `-Mode Remove -Apply`. The script preserves private tokens, configuration, and all foreign data. The previous tunnel is **not** automatically re-enabled: any intentional restoration requires a separate scope and locality review. Leave the graph visibly unavailable if there is no owned local service.

## Boundaries

- No install script may reset Windows, kill arbitrary processes, change an unrelated SSH task or copy Dockerhost memory data, credentials or indexes. The reversible gateway task is per-user.
- Windows native GUI, RepoQL 1.7.18 connector ABI, Tencent credentials, Claude parent/delegated memory and Office all have **separate acceptance gates**. See `docs/WINDOWS-AGENT-MEMORY-POLICY.md` and the existing acceptance matrix.
- This release is **SOURCE ONLY**, with no signed installer or verified Windows binary. Publishing reviewed code is not evidence of a functioning Windows installation.

### Kanzo status audit

Build the unified Rust crate with `--bins`, then run
`native/windows/audit_kanzo_board.ps1` using the actual staged source. This
performs read-only local Kanzo listener and API checks, pipes the board into
`kanzo_board_audit.exe`, and returns native counts for `todo`, `doing`,
`review`, `done`, and `backlog`, with separate `done_hidden` visibility. It
never transitions tasks or asserts a real work claim from stage counts. In a
controlled disposable task, independently verify MCP claim -> `doing` stage
readback -> closeout -> `done` readback and claim release; the dashboard alone
cannot prove this lifecycle. Keep the existing orchestration gates unchanged.

## Exact native dashboard and gateway pairing

The option 2 dashboard launcher always reads its capability token from
`%LOCALAPPDATA%\Singularity\Dashboard\token` and forwards `/api/unified/*`
requests to `127.0.0.1:18101` using the separately generated
`%LOCALAPPDATA%\Singularity\Dashboard\unified-gateway.token`.
`manage_unified_gateway.ps1` now derives **the same** dashboard StateDir and
RepoqlTokenFile by default. It refuses a different state directory or a
separate RepoQL bearer file rather than silently registering a gateway that
reads the wrong graph. If the dashboard task was configured with a nondefault
port, pass the actual verified port with `-DashboardPort`. After registration
read back its private config and independently check the dashboard registered
port, Rust process ownership and RepoQL `/api/links` response. The pinned
`UNIFIED_REPOQL_BASE` is the *local Singularity dashboard API*, not the
`rql dashboard` native web panel on 41005. Do not point it at 41005.

The gateway's own `/v1/health` response only reports Rust process health.
Treat the unified graph as unavailable unless the real Windows RepoQL and
Tencent source records have passed independent readbacks and the Windows-only
positive and Dockerhost-only negative markers.
