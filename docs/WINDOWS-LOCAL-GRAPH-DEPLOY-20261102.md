# Singularity RepoQL: Windows local-only graph deployment

Date: 2026-11-02 NZDT. Status: **source candidate, Windows install and locality NOT verified**.

## Goal

On the actual Windows installation, the memory graph, RepoQL index, Tencent MemoryCore identity, services and persisted records must come from that Windows machine. No Dockerhost memory, SSH/reverse tunnel, remote filesystem, remote graph gateway or silent fallback. Remote LLM inference APIs are outside this memory-locality requirement; explicitly distinguish them if used. Preserve the existing Codex director/consultation workflow, in-scope resource ownership, and all unrelated Windows data and services.

## Package provenance

This candidate derives from `singularity-windows-memory-kanzo-dashboard-parity-20261101-v3-SOURCE-ONLY.zip` (SHA256 `d60fd15849d48ef35903130dcdcb7a495b433ebee6a95c6bbb40f345b779010a`). It retains the cumulative native Rust gateway, tunnel disabling helper, source-port plan/apply guard, Tencent local endpoints, Claude and Kanzo integration. The 2 November scoped changes are:

* `dashboard/static/app.js`: clear previous nodes, source badges, inspector and topic list when a graph request fails or explicitly returns unavailable, and show the current failure.
* `dashboard/unified_bridge.py`: on native Windows, do not serve a stale cached graph while an unsuccessful background refresh runs after its fresh TTL.
* `dashboard/test_unified_windows_proxy.py` plus `dashboard/tests/browser_unified_graph_fail_closed_smoke.py`: regression tests for source failure, recovery and graph cache rejection.
* `native/windows/audit_locality_20261102.ps1`: a read-only inspection of task, listener, outbound connection and configuration metadata. No keys are printed.

Neither code changes nor loopback URL tests prove Windows-local data. **Do not claim fixed until local acceptance below.** This is source, **not** a compiled installer.

## Existing agent: apply under the established Codex director/reviewer gates

1. On the actual Windows host, record computer identity, current installed checkout, Git revision and uncommitted diff, installed app profile, listener owners and project task actions. Run `native/windows/audit_locality_20261102.ps1` read only, retain redacted JSON evidence. Find any SSH port forward (including `Singularity-Unified-Tunnel`) and any external RepoQL/Tencent service base, shared state path or proxy; enumerate all relevant source boundaries rather than merely testing 18101. Never dump secret files.
2. Verify the archive SHA256. Extract into a **new** project-owned candidate location. Run `python native/windows/verify_source_release.py`, the dashboard Python suite and `python dashboard/tests/browser_unified_graph_fail_closed_smoke.py` with Chromium/Playwright if available. Compare the candidate's `PORT-DELTA.json`, `SHA256SUMS`, and exact changed files with the actual installed source. `native/windows/apply_verified_source_port.ps1 -Mode Plan -CandidateSource $CandidateSource -InstalledSource $InstalledSource -BackupDir $BackupDir` is read only. Set `$CandidateSource`, `$InstalledSource`, and `$BackupDir` to independently discovered local absolute paths before execution. Apply only if all manifest preimages match; otherwise reconcile existing newer changes, especially previous v3 deployments, instead of overwriting them. `-Mode Apply -Apply` changes project-owned source only after the plan is reviewed.
3. In the reconciled *installed* source, run locked native Rust tests/builds, including `native/windows/unified-gateway-rust`. `native/windows/build_unified_gateway.ps1 -StagedSource $InstalledSource` plans; `-Apply` compiles and installs the local `unified-repoql-control.exe` only if the target has no unreconciled binary. Capture binary hash and compiler exit codes. Do not treat source tests as Windows build evidence.
4. Verify ownership of `Singularity-Unified-Tunnel` with `native/windows/disable_unified_tunnel.ps1` (no arguments). Once exact owner/action/forward and absence of unrelated dependencies are confirmed, use `-Apply` to stop and disable only that project-owned forward. Inspect 18101 listener again; do not kill other tasks/processes on a guess. The reviewed Rust gateway is loopback-only and the source has no Dockerhost credential fallback.
5. Provision **local** Windows RepoQL with its actual local workspace/index and Tencent MemoryCore with its own private local metadata and user identity using existing project lifecycle. Configure `native/windows/manage_unified_gateway.ps1` with that exact local dashboard token and local Tencent endpoint. Start via its Plan / Register / Start / Verify workflow. If an existing owned gateway needs replacement, reconcile its task/config and preserve state as required. Refuse any unresolved localhost proxy/SSH/reverse tunnel or UNC/mounted remote backend. Ensure the dashboard process uses its approved native launcher and `SINGULARITY_WINDOWS_GATEWAY_EXE` points to the built executable.
6. Prove provenance separately for RepoQL, Tencent and merged graph: use authorized unique **Windows-only** records and one existing Dockerhost-only negative record. Check underlying Windows index/metadata paths and listener executable owners, direct source responses, then authenticated dashboard. A Windows marker must appear under the correct source, Dockerhost-only marker must not appear. Force the local gateway off and confirm the browser clears its graph and indicates unavailable. Restart it and verify recovery; repeat after reboot. A local IP, healthy process, or `available=true` alone is insufficient.
7. Verify the requested product integrations independently: new-session Claude memory capture/recall with negative cross-role scope, Kanzo persisted work transitions, local Ghost/Office endpoints when applicable and native browser behaviour. Record PASS / FAIL / NOT_TESTED per item and preserve exact command output, hashes, redacted task/port receipts. Publish GitHub release / installable EXE only if actual Windows install, functional/local memory and rollback gates pass. Do not claim production success from this archive.

## Exact acceptance contract

* 127.0.0.1:18101 listening owner is the staged Windows native `unified-repoql-control.exe`, not `ssh.exe`, a Python usage shim or remote proxy.
* The 18100 RepoQL dashboard, RepoQL index/working directory, Tencent MemoryCore/MemoryPanel and associated ports are Windows-owned processes accessing local Windows storage. No remote fallback is configured or observed.
* `native/windows/manage_unified_gateway.ps1 -Mode Verify` succeeds **and** independent record-provenance acceptance succeeds for RepoQL-only, Tencent-only, merged graph, negative Dockerhost-only record and restart.
* Previously loaded memory disappears on graph request failure instead of masquerading as live. Its recovery brings back only the newly read local data.
* Existing workflows and unrelated Windows files, services, credentials, Dockerhost production and orchestration stay unchanged.

## Onsite evidence to return

Actual Windows host identity, installed source root/hash/diff, candidate ZIP SHA, native EXE SHA, read-only inspection JSON, exact scheduled-task action/process owners and connection listing, local graph fixtures with source identity and negative Dockerhost check, screenshot before/after fail/recover, tests with exits, reboot/readback result, remaining blockers. If native Tencent cannot be installed, show **unavailable** rather than secretly forwarding to Dockerhost.
