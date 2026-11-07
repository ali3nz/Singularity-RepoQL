# Native Windows dashboard, memory and Kanzo: source-to-runtime acceptance

**Source cut: 1 November 2026. Current state: source candidate, NOT a verified Windows install.** This is the shortest safe route from the reviewed Dockerhost UX and memory rules to Singularity's native Claude Code installation. It does not replace `docs/NATIVE-WINDOWS-INSTALLATION.md` or the existing orchestrator's work gates.

## Actual source inputs and their roles

| Source | Used for | Not copied |
| --- | --- | --- |
| `singularity-repoql-git-latest.zip` | Baseline native Windows installation, native Claude Code hooks and MCP contracts | No automatic assumption that installed Windows is identical |
| `repoql-dashboard-sidebar-icons-20261101.zip` | Cumulative modern Command Center, Kanban, Agent Lounge, 23 icons, typography and responsive UI | Linux `systemd` service files, Cloudflare Access authority |
| `repoql-dashboard-latest.zip` | Rust unified read-only gateway, graph provenance contract and locked Rust dependencies | Dockerhost usage event files, secrets, live memory or host identifiers |
| `repoql-memory-remediation-20261101.zip`, `agents-md-evidence-reviewed-20261101.zip` | Provenance-aware RepoQL lookup, bounded memory recall, scoped durable learning and Kanzo ownership rules | Linux cron jobs, role mappings, fleet executor or Dockerhost filesystem paths |
| `ai-orchestra-harness.zip`, `ai-orchestra-source.zip`, `harness-scoped-self-learning-20261028.zip` | Evidence-first memory policy and negative scope testing | A second orchestrator, model router or duplicated memory writer |

`PORT-DELTA.json` identifies every source file changed from the synced Git ZIP, with source and destination hashes. `SHA256SUMS` identifies the full source candidate. Do not use the delta on an unrelated or newer checkout. This candidate has not been promoted to GitHub main or to a released installer.

## Onsite run sequence, minimal work remaining

1. **Discover and own scope.** Check the canonical `AGENTS.md` and `adapters/claude-code/singularity-workflow.md`, acquire work scope through the installed Kanzo flow, and record the actual Windows source root, source revision, local dashboard and RepoQL binaries, Tencent identity, configured ports, existing graph task and process owners. Compare the candidate `PORT-DELTA.json` and the installed source. If the installed source diverges, reconcile it selectively; never overwrite newer work. Preserve unrelated Windows data and Codex.
2. **Apply source only** after an exact dry run, in a new staging directory. The helper deliberately requires `-Apply` and a new backup directory. All paths must be discovered native Windows absolute paths. Example invocation with PowerShell variables set from verified discovery (no secrets):

   ```powershell
   & $CandidateSource\native\windows\apply_verified_source_port.ps1 -Mode Plan -CandidateSource $CandidateSource -InstalledSource $InstalledSource -BackupDir $SourceBackupDir
   & $CandidateSource\native\windows\apply_verified_source_port.ps1 -Mode Apply -Apply -CandidateSource $CandidateSource -InstalledSource $InstalledSource -BackupDir $SourceBackupDir
   ```

   This copies changed **source files** only; no running service, task, local memory or token is touched. The receipt and per-file original backups support `-Mode Rollback -Apply` with the same arguments. Only run rollback when hashes still match the source postimage or original preimage.
3. **Build and test** using the installed source and its locked Rust crates. Native Windows toolchain: Rust MSVC, Python and Node. Check `native/windows/check_rust_lock_provenance.py`, then run `cargo test --locked --all-targets` inside `native/windows/unified-gateway-rust`, and the existing project Python/JS suites. Build the Windows Rust binary and board auditor with `native/windows/build_unified_gateway.ps1 -Apply`. Inspect build hashes and existing binary ownership before staging; the build helper refuses to overwrite an existing gateway binary.
4. **Stop the false remote graph.** Check `native/windows/disable_unified_tunnel.ps1` without switches first. It verifies the exact project-owned `Singularity-Unified-Tunnel` task and the `ssh.exe -L 127.0.0.1:18101` arguments. Only after independent ownership verification run it with `-Apply`. An unrelated 18101 owner is not killed. The dashboard must show **unavailable** if the local Rust gateway is missing; no Dockerhost fallback or Dockerhost gateway secret.
5. **Register the native local gateway**, first `native/windows/manage_unified_gateway.ps1 -Mode Plan` with the **actual** local `-StateDir` and `-RepoqlTokenFile`, then `-Mode Register -Apply`, `-Mode Start -Apply`, `-Mode Verify`. Use `-TencentBase`, `-TencentServiceId`, `-TencentUserKeyFile` and `-WikiIds` only when separately checked against the local Windows Tencent connector. There is no implicit Dockerhost documentation import; `-HubDocUriPrefix` is optional and must identify an actual indexed local import. `Verify` proves local Rust process identity, **not** data provenance. See `docs/WINDOWS-LOCAL-UNIFIED-GATEWAY.md` for the full bounded procedure.
6. **Prove memory locality.** Through an authenticated dashboard fetch RepoQL-only, Tencent-only and combined graphs. Independently index a unique disposable Windows-only RepoQL record, and create an authorized Windows-only Tencent record. Confirm each graph source shows its own unique marker, and an independently known Dockerhost-only marker is **absent**. Check real listener ownership, token source paths, RepoQL workspace/index and Tencent identity. Stop the gateway and verify the graph becomes unavailable rather than displaying a cached Dockerhost graph. Reboot and repeat. If any of this is not demonstrable, the memory graph is **NOT VERIFIED**.
7. **Enable installed Claude Code rules and hooks**, not just repository instructions. The runtime rule is `adapters/claude-code/singularity-workflow.md` installed under the supported Claude Code rule directory; hook registration must use the existing `native/windows/configure_claude_code_windows` flow. Preserve the official `repoql@repoql-plugins` RepoQL MCP owner, and the product's Kanzo/MemoryCore connectors. Verify `SessionStart`, `SubagentStart`, `SubagentStop`, `Stop`, and `SessionEnd` with safe representative sessions, and confirm `doc-hook` did not overwrite earlier user content. Hooks may capture asynchronously; a zero exit is not a persisted memory receipt. Check fresh RepoQL indexing independently of Tencent ingestion. For memory, use bounded current source-backed recall, no unscoped global search and no duplicate manual memory writer.
8. **Prove Kanzo stages and closeout.** Run `native/windows/audit_kanzo_board.ps1` after compiling the Rust board auditor. It reports exact native `todo`, `doing`, `review`, `backlog`, `done`, visible total and older hidden closed records. For an authorized disposable task, verify `check_work` → `claim_work` → existing native status transition to `doing` → readback while active → existing review gate if applicable → `close_work` with outcome and remaining work → readback `done` and claim release. `done` means **Closed**, not success. An empty In progress board alone proves neither bug nor health. Do not bulk-move, delete or close unrelated cards, or infer ownership from Agent Lounge messages.
9. **Indexing and memory freshness probes.** In a fresh authorized Claude Code session, perform eight bounded RepoQL source lookups, for example Frigate, Home Assistant, Sonarr, Radarr, Kanzo, Ghost, Singularity dashboard and installed agent memory rules. For each, record the current URI, index/import freshness, current file readback and whether the answer came from a real Windows workspace. An absent topic is **NOT FOUND**, not fabricated. Check relevant bounded Tencent recall against observed current sources and verify the same specific record can be retrieved from a different session. Independently inspect Kanzo connector SQL view registration; `docs/WINDOWS-KANZO-INDEXED-VIEW-COMPATIBILITY.md` records a known pinned 1.0.0 historical-view incompatibility, without changing the locked connector package in this source candidate.
10. **UI and release gate.** Open the **real authenticated Windows dashboard**, desktop and narrow mobile. Confirm exactly five primary Command Center cards, 23 functioning sidebar icons, single System knowledge entries for Tencent/RepoQL, grouped Agent Lounge feed, compact Kanban and proper native Closed counts, operations unavailability when source APIs are down, Ghost and Office behavior, and no browser errors. Run restart, uninstall and reinstall of project-owned components; record full changed-file hashes and native compilation logs. Release only if actual supported capability matrix is PASS, FAIL or NOT TESTED, and all required gates pass.

## Source and runtime authority boundaries

- **RepoQL** identifies code and documents, which must still be read from the current authoritative indexed Windows workspace; an old search hit does not establish current truth. Confirm version and connector ABI before using Dockerhost CLI examples.
- **Tencent MemoryCore** stores scoped prior context and reviewed eligible lessons. Verify independent parent/delegated identity separation, negative cross-role retrieval and next-session readback before asserting capture success. Do not silently merge Dockerhost memories into a Windows profile.
- **Kanzo** owns task records, claims and stage status; Agent Chat is coordination/presence only. The dashboard presents native Kanzo stages and never makes the claim on an agent's behalf.
- **Ghost and Office** retain their native product APIs; the Rust graph gateway does not replace their scheduler, routes, or permissions.
- **Rust scope:** the locked native unified gateway and bounded read-only Kanzo/memory audits are Rust; replacing existing Python web/auth/Windows service logic would need real Windows differential tests and is not automatically required to ship the front-end UX.

## Verification status at packaging

`PORT-DELTA.json` and this note are source receipts. Actual Windows Rust compilation, listener provenance, local RepoQL/Tencent records, active Kanzo task lifecycle, browser visual acceptance and reboot remain **NOT TESTED** from this environment. No live Windows change, token action, task registration or GitHub release publication has occurred.

## Source update to existing Claude Code user rules

The first-time Claude Code installer rejects the newer `singularity-workflow.md`
when an older one already exists, even if its ownership receipt was written by
Singularity. This source release includes a dedicated, resumable refresh for
the installer-owned rule only. Run a read-only plan, then apply under the
installed Windows user's profile, using the actual staged source root:

```powershell
$src = (Resolve-Path .).Path
$homeDir = [Environment]::GetFolderPath('UserProfile')
node .\native\windows\refresh_installed_claude_rules.mjs --source $src --home $homeDir
node .\native\windows\refresh_installed_claude_rules.mjs --source $src --home $homeDir --apply
```

A missing ownership journal, foreign edits, incorrect source, or pending
configuration change must be reported and not bypassed. Following refresh,
run the existing `configure_claude_code_windows.mjs --mode verify` and inspect
that the intended hook events, loaded rules, identities, and official RepoQL
plugin are actually present. This updates no agent files, MCP, secrets, Kanzo
claims, or Windows service configurations. Native runtime proof is separate.

## Additional acceptance gates

The acceptance matrix now explicitly reports `kanzo_todo_doing_closed_lifecycle`,
`docker_dashboard_visual_parity`, `windows_unified_graph_locality`,
`claude_workflow_rule_refresh`, and `repoql_import_freshness_readback`.
No gate may be marked PASS based on a source archive, mocked contract, or
HTTP success alone. A genuinely local Rust gateway process restart changes
its PID; the Python dashboard bridge invalidates graph caches on that owner
change to prevent old memory data from surviving the cutover.
