# Milestone 18 — RepoQL 1.7.18 native Windows target

**Status:** source-only version-policy migration; **not** installed, compiled, or connector-tested on Windows. **Release remains BLOCKED**.

## Decision

- **Native Windows options 1–4 require an independently installed `rql.exe` reporting exactly RepoQL `1.7.18`.** The version is enforced in the Python preflight, dashboard, PowerShell installer preview/staging, Rust bridge, Rust supervisor, source archive scanner and parity checker. Unknown/ambiguous versions fail closed.
- Kanzo and Tencent MemoryCore manifests continue to declare **connector ABI 1**. ABI compatibility with RepoQL 1.7.18 is a hypothesis pending live tests, not an established fact.
- The user reports that 1.7.18 fixes the connector regression seen in 1.7.17. This was **not independently confirmed from a published 1.7.18 changelog** and is **not** equivalent to loading the connectors with the real Windows binary.
- The existing production Linux/Docker host **is not modified**. Its previous observed RepoQL 1.7.15 remains valid production evidence; Windows is now required to use 1.7.18. The runtime parity comparison permits those versions to differ, but still requires independent recent real feature receipts from each host.
- The proven Claude Office token-URL credential method remains unchanged. No change to Ghost/Office optional profiles or the zero-Claude-free-worker OpenChamber adapter.

## Areas changed in current source

1. `native/windows/variants.json` and `MANIFEST.json` — Windows required version.
2. `native/windows/repoql_compat.py`, `preflight.ps1`, `stage-native.ps1`, `scan_source_archive.py`, `verify_source_release.py` — exact native Windows version policy.
3. `native/desktop-bridge/src/repoql_compat.rs`, `native/windows/rust-supervisor/src/lib.rs` — matching Rust source policy. **Rust toolchain unavailable in local runner; not compiled here.**
4. `dashboard/native_repoql_gate.py`, `dashboard/native_readiness.py` and native dashboard examples — version-gated startup/readiness.
5. `native/windows/compare_production_parity.py` and two example receipts — version-neutral feature receipt name and independent production/native version checks.
6. `connectors/README.md`, `connectors/kanzo/README.md` — 1.7.18 target and requirements for rebuilding connectors. `connectors/PROVENANCE.md` preserves production package's 1.7.15 historical provenance.
7. `connectors/kanzo/tools/pin.py` no longer hard-codes a Linux-only `/root/.repoql/versions/1.7.15/rql` fixture binary; it uses explicit `SINGULARITY_RQL_EXE` or PATH `rql`.
8. `.github/workflows/native-desktop-rust.yml` adds cross-language release-version consistency check, but it has **not been run in GitHub CI**.

## Required native Windows acceptance before promotion

- Locate the independently installed `rql.exe` **without using WSL, Docker or a Unix shell**. Capture its executable hash, signed provenance where available and exact `rql.exe --version` output. Reject 1.7.15, 1.7.17, any other version or ambiguous output.
- Run the read-only native source and manifest preflight, then rebuild **both** Kanzo and Tencent MemoryCore connectors using the real 1.7.18 CLI. Test, pack, install and perform genuine index/sweep and readback under explicit user/team/agent scope; do not merely accept a healthy port or a passing synthetic fixture.
- Preserve the production host and the previously working connector packages. Compare real, non-synthetic receipts for memory indexing, recall, Kanzo tasks/comments and dashboard queries on production and native Windows. Failed or missing receipts block release.
- Run Windows CI `cargo fmt`, `cargo check`, `cargo test`, `cargo clippy` as configured, the PowerShell staging/rollback smoke tests, Windows ACL tests and all four real GUI installations.
- Record the native bridge, supervisor and connector versions in release receipts; do not set public-release status true until each P0 gate passes.

## Rollback

Version policy is source-controlled. To revert **only the version-policy change** during development, use the Milestone 17 source ZIP and the Milestone 17→18 patch supplied with this milestone, then rebuild and rerun the complete test suite. This will restore the prior **1.7.15 Windows pin**, but does not change an installed RepoQL binary and does **not** authorise rolling back an in-use index or connector data without a separately verified compatibility migration. The production Docker installation was never changed.

**Do not execute network-sourced installers automatically from the package or attempt to disable upstream service authentication.**
