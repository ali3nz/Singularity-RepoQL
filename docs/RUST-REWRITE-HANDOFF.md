# Singularity full-Rust rewrite — offsite handoff

**Status: source handoff, not a release.** This tree is the reviewed Wave56 source
reconciled onto `main`. The recorded locked builds of all eight crates are in the
historical receipts; this build environment had no Rust toolchain, so the tree was **not
rebuilt here** — run REPRODUCE §3 first. It has **not** been installed, upgraded, rolled
back or accepted on a real Windows machine.
The remaining acceptance steps are listed in [RUST-REWRITE-ACCEPTANCE.md](RUST-REWRITE-ACCEPTANCE.md).

Read in this order:

1. `START-HERE.md` in the delivery ZIP (entry point, checksums, verify commands).
2. This document — scope, architecture, activation, operations.
3. [RUST-REWRITE-ACCEPTANCE.md](RUST-REWRITE-ACCEPTANCE.md) — what the evidence proves and what it does not.
4. [RUST-REWRITE-CONTRACTS.md](RUST-REWRITE-CONTRACTS.md) — protocols, schemas, guards, focused tests.
5. [RUST-REWRITE-REPRODUCE.md](RUST-REWRITE-REPRODUCE.md) — build it yourself on a clean Windows VM/CI runner.
6. `rust-rewrite-evidence/README.md` — historical receipts, sanitized and labelled.
7. `AGENTS-WAVE56-HISTORICAL.md` — Wave56 working AGENTS prose, **not policy**.

## 1. What this tree is

| Fact | Value |
|---|---|
| Base commit this overlay started from | `d4d2758` (`main`, 178 commits) |
| Overlay source | reviewed Wave56 working copy, 1158 files, 8 Rust crates / 8 `Cargo.lock` |
| Files copied by the overlay | 451 (707 source files were already byte-identical) |
| Preserved from `main` | every main-only legacy path, and `main`'s `AGENTS.md` unchanged |
| Build/dependency/runtime directories | never copied (`target/`, `node_modules/`, `dist/`, `data/`, `state/`, DBs, secrets) |
| Current checksum authority | root `SHA256SUMS`; `MANIFEST.json.file_hashes` points at `docs/rust-rewrite-evidence/MANIFEST-FILE-HASHES.json` |

The repository carries **source only**. No compiled binary, MSI, dependency cache,
database, live setting or credential is part of it.

### Checksum authority and the 37 known mismatches

The frozen Wave56 `SHA256SUMS` and `NATIVE_WINDOWS_SOURCE_MANIFEST.json` were produced
before the last reviewed source changes, so they carry **37 known mismatches** against
their own tree. They are kept as provenance only:

- `docs/rust-rewrite-evidence/SHA256SUMS.wave56.frozen`
- `docs/rust-rewrite-evidence/NATIVE_WINDOWS_SOURCE_MANIFEST.wave56.json`

They are **not** acceptance and **not** the current authority. Verify this tree with the
root `SHA256SUMS` (see §9). `NATIVE_WINDOWS_SOURCE_MANIFEST.json` in the tree root is the
historical revision metadata consumed by the packaging scripts; it is not relabelled here.

## 2. Product scope

One installation profile: **Claude Code Full**. The numeric profile `2` is retained only
for staging and receipt compatibility. The retired frontends are not supported; their old
paths remain in the tree because deleting them is a separate cleanup with its own
compatibility risk, and they are inert for this product.

`native/windows/CLAUDE_CODE_ONLY_SCOPE.md` is the authoritative short scope statement.

### Literal whole-product Rust — what it means here

The first-party code that runs on Windows is being migrated to Rust. The product also
depends on engines that are **integrated, not rewritten** and are not redistributed here:

| External engine | Role | Boundary |
|---|---|---|
| Claude Code | agent runtime and hooks host | installed separately by the operator; MIT-licensed CLI, not vendored |
| RepoQL (`rql` 1.7.18) | code index/query engine | separate installer, pinned by URL + SHA256 in `native/windows/runtime-pins.json` |
| Kanzo | work-item server | separate AGPL-3.0 process, unmodified; connector only reads its API |
| Tencent MemoryCore 2.0.2 (`99a1a2c`) | memory stack | vendored derivative patches only; upstream tarball pinned by SHA256 |
| Claude Office | activity visualizer | separate compose project, pinned fork revision |
| Node.js 24.22.2 | legacy oracle + orchestration | pinned download + SHA256; not bundled |
| Python 3.12 / 3.13 | legacy oracle + dashboard backend | resolved from the host, fail-closed when absent; 3.13 required for Office |

A claim of "whole product in Rust" is therefore **false** unless it is scoped to the
first-party Windows runtime. No proprietary upstream binary is redistributed in this
repository or the delivery ZIP.

## 3. Architecture: what is Rust, what is not

### 3.1 Rust crates (8, all with committed `Cargo.lock`)

| Crate | Path | Binaries | Role |
|---|---|---|---|
| `orchestra-observer` 0.6.0 | `harness/rust-authority` | `orchestra-observer` | read-only authority/observer over orchestration runs |
| `singularity-desktop-bridge` 0.1.0 | `native/desktop-bridge` | `singularity-desktop-bridge` | native MCP bridge; `office` feature is opt-in (`--no-default-features --features office`) |
| `singularity-memory-parity` 0.1.0 | `native/windows/memory-parity-rust` | `singularity-memory-parity`, `memory-turn-capture`, `singularity-memory-turn-capture` | capture/parity CLI for the memory loop |
| `singularity-rc-stack` 0.1.0 | `native/windows/rc-stack-rust` | `singularity-rc-stack` | readiness/control stack |
| `singularity-release-evidence` 0.1.0 | `native/windows/release-evidence-rust` | `singularity-release-evidence` | release evidence collection and receipts |
| `singularity-windows-supervisor` 0.1.0 | `native/windows/rust-supervisor` | `singularity-windows-supervisorw`, `singularity_windows_supervisorw`, `singularity_windows_supervisor_service`, `singularity-windows-setup`, `singularity-capability-gate` | supervisor, Windows service wrapper, Rust setup front-end, capability gate |
| `singularity-source-packager` 0.1.0 | `native/windows/source-packager-rust` | `singularity-source-packager` | source packaging and archive scan |
| `unified-repoql-control` 0.1.0 | `native/windows/unified-gateway-rust` | 24 binaries including `singularity-dashboard-listener`, `singularity-dashboard-routes`, `singularity-unified-proxy`, `singularity-memorycore-reader/writer`, `singularity-repoql-connectors`, `kanzo_board_audit` | dashboard listener/routes, unified proxy, memory/doc ledger bridges, Kanzo audit |

`docs/RUST-REWRITE-INVENTORY.json` is the machine-readable inventory: package, version,
edition, license, features, every binary, dependency names, lockfile path and SHA256.

### 3.2 First-party paths that remain JS / Python / PowerShell

`docs/RUST-REWRITE-PATHS.json` lists **every** first-party source file (870) with language
and category. Totals:

| Language | Files | Category | Files |
|---|---|---|---|
| JavaScript | 352 | runtime | 451 |
| Python | 307 | test | 347 |
| Rust | 117 | installer | 47 |
| PowerShell | 62 | build | 11 |
| SQL | 11 | legacy (retired frontends) | 14 |
| WiX | 9 | | |
| TypeScript | 5 | | |
| Batch | 3 | | |
| Go | 2 | | |
| C# | 1 | | |
| Shell | 1 | | |

The large remaining areas, and why each is still there:

| Area | Paths | State |
|---|---|---|
| Dashboard HTTP backend and state | `dashboard/*.py` | Python still owns routing, auth, state and the RepoQL proxy; the Rust listener/routes/proxy are **opt-in** and run beside it |
| Claude Code hooks and capture glue | `adapters/claude-code/*.mjs`, `scripts/memory_turn_capture.py`, `scripts/doc-ingest-node.mjs`, `memory/portable/*.mjs` | JavaScript/Python; Rust capture CLI is available but activation is explicit |
| Orchestration harness | `harness/kit/**` | JavaScript (runs, gates, memory orchestra, worker completion) |
| Installer / upgrade / uninstall | `native/windows/*.ps1`, `native/windows/setup/*.ps1` | PowerShell remains the transaction authority; the Rust setup binary delegates to these scripts |
| Bots | `native/windows/openmausbot/**` | Python bot bridge plus a Rust job wrapper |
| Packaging/release | `native/windows/build_*.py`, `scan_source_archive.py`, `scripts/bundle-classification.mjs` | Python/JS, with the Rust source packager available |
| Tests and fixtures | `tests/`, `dashboard/test_*`, `native/windows/test_*` | mixed; they are the legacy oracle |

The Rust setup binary does **not** replace the PowerShell workflow: `native/windows/rust-supervisor/src/setup.rs`
maps its phases to `install_claude_complete.ps1` / `uninstall_claude_complete.ps1` and passes
`-PythonExe` / `-NodeExe` through. The Rust dashboard listener is supervised by
`dashboard/native_listener.py` and only starts when the operator opts in.

## 4. Activation boundaries (old vs new)

Defaults are legacy. Rust paths activate only through explicit installer switches or
environment variables; nothing flips silently.

| Switch | Scope | Effect |
|---|---|---|
| `-UseRustDashboardRoutes` | `DashboardRegister` / `DashboardRebind` | serve dashboard routes from `singularity-dashboard-routes` |
| `-UseRustDashboardListener` | same | run `singularity-dashboard-listener` behind the Python supervisor |
| `-UseRustUnifiedProxy` | same | Rust unified proxy in front of the Python backend |
| `-UseRustDocWriter` | `Configure` | Rust doc-writer bridge |
| `-NativeSetupConfirmed` | `Apply` only | the Rust setup GUI has already taken phase confirmation |
| `SINGULARITY_DASHBOARD_NATIVE_LISTENER` | runtime | path to the listener binary used by the Python supervisor |
| `SINGULARITY_WINDOWS_NATIVE=1` | runtime | declares the native Windows host to the shared scripts |
| `SINGULARITY_RUST_MEMORY_POLICY_BIN`, `SINGULARITY_RUST_MEMORYCORE_{READER,WRITER}_BIN`, `SINGULARITY_DOC_RUST_BIN`, `SINGULARITY_RUST_EVIDENCE_POLICY_BIN`, `SINGULARITY_NATIVE_READINESS_RUST_BINARY` | runtime | per-bridge binary overrides; unset means legacy path |
| `SINGULARITY_OFFICE_NATIVE_AUTH_MODE`, `SINGULARITY_DASHBOARD_AUTH_MODE`, `SINGULARITY_LOCAL_ACCOUNT_AUTH` | runtime | auth-mode boundaries; do not change without the matching receipt |

Removal of an interpreter is a later gate: the Rust capability gate
(`singularity-capability-gate`, `native/windows/configure_capability_gate.ps1`) records what
is still needed. Do not uninstall Node/Python while the legacy oracle paths above are active.

## 5. Install, upgrade, uninstall

### 5.1 Transaction model

`native/windows/install_claude_complete.ps1` is the operator-gated workflow. It is
fail-closed and preview-first:

- Mutating modes require `-Apply`; read-only modes refuse `-Apply`.
- `-NativeSetupConfirmed` is accepted only together with `-Apply`.
- The install root must stay inside `%LOCALAPPDATA%\Singularity` (default
  `%LOCALAPPDATA%\Singularity\WindowsNativePreview`), otherwise
  `INSTALL_ROOT_OUTSIDE_PRIVATE_LOCALAPPDATA`.
- Stage and Configure are separate commits. Staging writes `STAGING_RECEIPT.json`
  (`schema 1`, `state STAGED_UNVERIFIED`, `option 2`, `repoqlVersion 1.7.18`); Configure
  requires that receipt and re-verifies every staged binary hash — drift is
  `STAGED_BINARY_HASH_DRIFT`.

Modes: `Plan`, `Stage`, `Configure`, `Verify`, `UpgradePlan`, `VerifyInstalled`,
`SupervisorPlan`, `SupervisorVerify`, `RegisterSupervisor`, `RemoveSupervisor`,
`RollbackConfig`, `RollbackStage`, `RetireStage`, `RestoreRetired`, `ParentPlan`,
`ConfigureParent`, `VerifyParent`, `RollbackParent`, `DashboardPlan`, `DashboardRegister`,
`DashboardRebind`, `DashboardVerify`, `DashboardStart`, `DashboardRemove`.

Staging is reversible per user: `stage-native.ps1 -Rollback` restores one previous snapshot
and leaves external service data alone. `RetireStage` / `RestoreRetired` move a stage out of
the way without deleting the receipt that owns it.

Task registration is transactional. `native/windows/task_action_transaction.ps1` hashes the
task XML with `Actions` and registration dates removed, the task SDDL, and the action triple,
and requires a verified preimage receipt (`wave56-verified-task-preimage/v1`, verified on
dockerhost, archived under
`/mnt/newdata/backups/singularity-wave56/fleet-1266/windows-preimage`) before it replaces
`Singularity-ClaudeComplete-Dashboard`. A missing or mismatched preimage aborts.

### 5.2 Upgrade verification

`native/windows/verify_rust_upgrade.ps1` is the Rust-aware upgrade check; `UpgradePlan`
produces the plan, `VerifyInstalled` checks the installed tree. `native/windows/verify_prepared_option2_candidate.py`
verifies a prepared candidate against its manifest, and
`native/windows/verify_option2_connectors.py` checks connector presence and versions.

### 5.3 Uninstall

`native/windows/uninstall_claude_complete.ps1` removes what the install owns, in reverse
order, by receipt. It refuses unowned stages (`UNOWNED_STAGE_RECEIPT`), and it does not
delete operator data or external service state. The Rust setup front-end exposes the same
uninstall phases and adds no separate removal logic.

### 5.4 ACLs, tasks, ownership, config and data

| Object | Owner / location | Notes |
|---|---|---|
| Install root | `%LOCALAPPDATA%\Singularity\WindowsNativePreview` | private per-user ACL; must stay under `%LOCALAPPDATA%\Singularity` |
| Staging receipt | `<stage>\STAGING_RECEIPT.json` | ownership proof for Configure/Rollback/Retire |
| Dashboard state | dashboard state dir, private ACL via `Set-Acl` in `manage_claude_complete_dashboard.ps1` | never world-readable |
| Scheduled tasks | `Singularity-ClaudeComplete-Dashboard`, `Singularity-ClaudeSessionWatcher`, `Singularity-CpuHistoryCollector` | registered by `manage_claude_complete_dashboard.ps1`, `register_claude_session_watcher.ps1`, `register_cpu_collector.ps1` with explicit principals/settings |
| Supervisor service | `register-supervisor-service.ps1` (SDDL checked) | service wrapper binary `singularity_windows_supervisor_service` |
| Memory config | `%LOCALAPPDATA%\Singularity\...` config JSON passed as `-MemoryConfig` | secret values are referenced by file, never logged |
| Office config | `-OfficeConfig`, `SINGULARITY_OFFICE_CONFIG` | required for the Office feature |
| Parent proxy config | `-ParentProxyConfig` + `.singularity-parent-memory-proxy-receipt.json` | receipt required for parent wiring |
| Doc index | `SINGULARITY_DOC_DATA` | atomic flock ledger, single writer |
| Claude settings | `-ClaudeHome` / workspace `.claude` | only touched by Configure, with `.singularity-native-mcp-receipt.json` |

Config merge is receipt-driven: each manager records what it wrote (`schema`, `option`,
`taskName`, arguments, binary paths) so a later manager can detect foreign or drifted state
instead of overwriting it.

## 6. Dashboard, memory, orchestration and bots

- **Dashboard**: Python backend (`dashboard/server.py`, `unified_bridge.py`,
  `local_account.py`) stays authoritative. Rust listener/routes/proxy are opt-in, speak a
  private framed channel to the Python supervisor (`dashboard/native_listener.py`), and fall
  back if the binary is missing or fails its hash/ownership check.
- **Memory loop**: capture → extraction → promotion is driven by
  `scripts/memory_turn_capture.py`, `scripts/memory_promote.py`, `scripts/memory-doc-ingest.py`
  and the harness memory orchestra. Rust binaries (`singularity-memory-parity`,
  `singularity-memorycore-reader/writer`, `singularity-doc-ledger-*`) are invoked through
  explicit environment overrides only. Single-writer contract is unchanged.
- **Orchestration**: `harness/kit` (runs, stages, gates, leases, worker completion) remains
  JavaScript. `orchestra-observer` reads run state; it does not write it.
- **Bots**: `native/windows/openmausbot/` (Python bridge) plus Rust job wrapper; lifecycle
  guarded by `manage_openmausbot.ps1` and `test_openmausbot_lifecycle.py`.
- **Office**: `singularity-desktop-bridge` with `--features office`; panel auth modes are
  explicit and must match the config receipts.

## 7. Packaging and release tooling

| Tool | Purpose |
|---|---|
| `native/windows/build_source_variants.py` | builds the source-only variant archive (`--variant 2`) |
| `native/windows/scan_source_archive.py` | scans the produced archive for forbidden content |
| `native/windows/source-packager-rust/` | Rust implementation of the same packaging contract |
| `native/windows/verify_source_release.py` | static packaging contract check (runs in CI) |
| `native/windows/check_rust_lock_provenance.py` | requires a committed, reviewable `Cargo.lock` for each crate |
| `scripts/bundle-classification.mjs` | classifies bundle entries for release review |
| `.github/workflows/ci.yml` | Python/Node tests, Windows source package build + scan, gitleaks |
| `.github/workflows/native-desktop-rust.yml` | locked Rust builds/tests, lock gate, listener/routes checks |

## 8. External pins, revisions and licenses

From `MANIFEST.json`, `native/windows/runtime-pins.json` and `docs/RUNTIME-PARITY.md`:

| Component | Pin | License / note |
|---|---|---|
| Node.js | 24.22.2, `node-v24.22.2-win-x64.zip`, SHA256 `ca1bff5d…99e2` | MIT; verified by `node --version` |
| RepoQL | 1.7.18, `install-rql.ps1` SHA256 `99ae8233…ae69` | separate product; connector contract pinned |
| Python | >= 3.12 (3.13 for Office) | resolved from host, fail-closed; no unpinned download |
| Tencent MemoryCore | v2.0.2 @ `99a1a2c`, tarball SHA256 `11dab534…67e0` | derivative patches with per-file `SOURCE-SHA256` |
| Kanzo | v0.1.3 @ `986f0fac…002` | AGPL-3.0, unmodified separate process |
| Claude Office | fork `ali3nz/claude-office` @ `95d8bdc` | separate compose project |
| RepoQL dashboard/MCP | RepoQL 1.7.18 required version, connector contract v1 | `.repoql` sources are not published |

No upstream proprietary binary is redistributed. Third-party notices stay in
`THIRD_PARTY_NOTICES.md`.

## 9. Verify this tree

```bash
# file list + digests (run at the repository root, Linux or Git Bash)
sha256sum -c SHA256SUMS            # every source file, excludes SHA256SUMS itself
python3 native/windows/check_rust_lock_provenance.py   # 8/8 locks
cargo test --manifest-path native/windows/unified-gateway-rust/Cargo.toml --all-targets --locked
cargo test --manifest-path native/windows/rust-supervisor/Cargo.toml --all-targets --locked
cargo test --manifest-path native/desktop-bridge/Cargo.toml --all-targets --no-default-features
cargo test --manifest-path native/desktop-bridge/Cargo.toml --all-targets --no-default-features --features office
```

`docs/rust-rewrite-evidence/MANIFEST-FILE-HASHES.json` carries the same digests as a map for
tooling that cannot parse `SHA256SUMS`.

## 10. What this handoff does not claim

- No Windows install, upgrade, uninstall, rollback, ACL, task or service acceptance was run for
  this tree. The only evidence is the historical, sanitized receipts plus source-level checks.
- No live Claude Code, RepoQL, Kanzo, Tencent MemoryCore, Office or provider grant was used.
- No target-PC cutover, real identities, production data migration or startup ordering was tested.
- No GUI acceptance, no Office panel acceptance, no browser/asset acceptance.
- The delivery ZIP is source, not an installer. `SOURCE_ONLY_NOT_RELEASE_READY` still applies.

The one next gate is a single focused native release acceptance on a clean Windows x64 VM,
then the onsite target-PC cutover. See [RUST-REWRITE-ACCEPTANCE.md](RUST-REWRITE-ACCEPTANCE.md).

## 11. Provenance of the claims in this document

| Claim | Source in this tree |
|---|---|
| crate/bin/feature inventory | `docs/RUST-REWRITE-INVENTORY.json` (generated from each `Cargo.toml`) |
| every first-party execution path + category | `docs/RUST-REWRITE-PATHS.json` |
| product scope | `native/windows/CLAUDE_CODE_ONLY_SCOPE.md`, `native/windows/variants.json` |
| install/upgrade/uninstall modes and guards | `native/windows/install_claude_complete.ps1`, `stage-native.ps1`, `uninstall_claude_complete.ps1`, `verify_rust_upgrade.ps1` |
| task transaction and preimage | `native/windows/task_action_transaction.ps1` |
| Rust setup delegation | `native/windows/rust-supervisor/src/setup.rs` |
| dashboard listener boundary | `dashboard/native_listener.py`, `native/windows/unified-gateway-rust/src/bin/dashboard_listener/` |
| pins and revisions | `native/windows/runtime-pins.json`, `MANIFEST.json`, `docs/RUNTIME-PARITY.md` |
| historical receipts | `docs/rust-rewrite-evidence/*.json` |
