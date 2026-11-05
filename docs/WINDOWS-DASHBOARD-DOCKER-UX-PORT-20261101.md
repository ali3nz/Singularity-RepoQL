# Native Windows dashboard UX parity candidate, 1 November 2026

## Exact provenance and release status

- Windows base: `singularity-repoql-git-latest.zip` from the synced Google Drive `Harness/ai-orchestra` folder (newer Git source than M91). M91 SHA256 `fe9bbf286d96459b95a2993be971250649c51a5c8c123d5352f59e57bb44388c` is historical code provenance only; it is not the implementation base for this release.
- Docker UX source: `repoql-dashboard-sidebar-icons-20261101.zip` SHA256 `513b0043b28c66baf8e33925a42ffad743bbd05d263181cb33d46762e29ef7de`.
- Scope: Windows dashboard frontend port, Windows-local Rust unified gateway source and optional read-only Rust memory audit, documented Windows agent memory policy, native gateway task scripts and separate tunnel-removal script. This is not a native Windows tested release.
- Verification details and all changed-file hashes: `CHANGES.json` in the delivery package, plus the refreshed root `SHA256SUMS`.

## UX parity delivered in source

- Exact latest Docker CSS, HTML and Kanzo native board module.
- Updated Command Center: five compact colourful primary cards, operations overview with guarded read-only Kanzo and Agent Chat probes, no duplicate Tencent/RepoQL primary cards.
- Seven selectable dark/light themes, 23 colour-coded sidebar icons, three expanded sections, responsive mobile bottom dock.
- Agent Lounge: compact recent-agent rail, readable full-width conversation stream, grouping, filters, unread counter and jump-to-latest. Windows has a new read-only presence endpoint reporting only recent senders. It never declares a Kanzo claim or working agent from chat messages; true worker counts require an authoritative presence tracker.
- Kanban native board: focused work queue, separate backlog, search, colour status and guarded stage mutation through existing Kanzo endpoints. A status change is not a claim; administrative Done is not evidence of implementation success.
- Preserved Windows source contracts: four variant-gated routes, local GUI usage scope, one-core Windows CPU metrics, native readiness view under Diagnostics, Ghost UI, Office and protected panel embedding.
- Ghost module strict-mode parsing correction: modules already run in strict mode; the function-level directive with a default argument was invalid JavaScript.

## Original local-memory defect

Observed runtime trace supplied by Freebuff: dashboard pointed to Windows-local Python shim 18102 which forwarded to SSH tunnel 18101 and the Docker host unified Rust gateway. An IP loopback origin alone does not establish backend locality. That trace is runtime evidence supplied by the operator; it was not reproduced on this working environment.

The source guard in `dashboard/unified_bridge.py` now checks, for native Windows calls, that the loopback port is owned by the directly running project-owned Windows Rust gateway executable `unified-repoql-control.exe` at the pinned installation path. A missing gateway, `ssh.exe`, Python shim, unapproved process, failed Win32 ownership query or invalid port returns `available:false` with `windows_local_unified_gateway_unverified`. It does not read/send the gateway token, and clears any cached graph on owner-validation failure. Existing proxy same-origin, credential, redirect and response size controls remain. Tests simulate an SSH listener, an unapproved shim, a direct local gateway, and a previously cached remote graph. Native process ownership must still be proven on Windows.

### Required onsite completion

1. Keep the Docker host unchanged. Inspect the installed Windows task, listener owner, wrapper settings, token-file provenance and actual Windows-local RepoQL index and Tencent services. Do not display token contents.
2. Execute `native/windows/disable_unified_tunnel.ps1` without `-Apply` first. After confirming the project-owned task matches the specific SSH forwarding contract, use `-Apply` to stop and disable it. The script does not delete files or kill unrelated processes. Verify no `ssh.exe` owns port 18101.
3. Use the reviewed Dockerhost `unified-repoql-control` Rust crate now ported to `native/windows/unified-gateway-rust/`. Verify the exact source, dependency lock and API contracts against the installed Windows RepoQL and Tencent services. Build with `native/windows/build_unified_gateway.ps1 -Apply` only after a read-only plan. A Rust executable is **not** bundled and cannot be claimed installed or accepted.
4. Provision a private Windows-owned gateway key, independent of the Docker token, with user-scoped ACLs. Set `UNIFIED_SERVICE_BASE` to its direct loopback listener and `UNIFIED_GATEWAY_TOKEN_FILE` to the local key path. Remove runtime use of the usage shim 18102 for unified graph/health. Preserve unrelated GUI usage telemetry settings; avoid wholesale config replacement.
5. Confirm PID, executable path, `/v1/health` and `/v1/graph` against the local gateway through the authenticated dashboard. Verify local RepoQL 1.7.18 and the active installed parse/fetch/render connector contract, plus local Tencent memory core, using unique **local-only** synthetic records, then prove Docker-only markers do not appear. If the gateway is missing or incomplete, preserve `available:false`; release remains blocked for the local graph.
6. Test all four installation variants, Ghost/Office availability gates, authenticated browser navigation, frontend responsive widths, Kanzo board actions in a scoped test project, and reboot recovery. Inspect the actual built binary and task state, not only local mock tests.
7. Retain prior source snapshots unchanged. Import this candidate into an isolated working tree, verify hashes and reconcile any newer Windows changes before deploying or publishing. Never force push or overwrite source with an unverified binary.

For the gateway installation, authoritative paths and Windows test matrix see `docs/WINDOWS-LOCAL-UNIFIED-GATEWAY.md`. RepoQL and Tencent sources remain separate; a green Rust health endpoint is not a locality proof.

## Offline test status

- RepoQL Windows Python dashboard tests: updated test receipts are in the delivery report; the historical M91 port had 157 tests and 1 skipped.
- Native Windows variant UI source test: 5/5.
- Existing pure JS editor contract test: 19/19.
- Docker command center Node contract: PASS.
- Unified gateway tests: 11 passed, including 4 new locality tests.
- Browser smoke tests for navigation/sidebar, operations overview and Agent Lounge: PASS at desktop/mobile fixture widths with no observed horizontal overflow.
- Native Windows process ownership check and actual local graph: **NOT TESTED** on Windows, no local gateway installed.

## Scope and acceptance

No deployment to Windows, service/task mutation, live authenticated Windows UI test, native gateway compilation or GitHub release was performed. The frontend parity candidate can be reviewed as source; live functional parity remains unverified until the onsite steps pass. Do not use the Docker-host gateway or token to make the panel appear healthy.
