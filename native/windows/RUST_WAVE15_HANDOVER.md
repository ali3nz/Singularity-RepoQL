# Wave 15 native Windows handover

Status: SOURCE_ONLY, Rust UNCOMPILED, deployment BLOCKED.

## Incremental source changes

1. Parent-session memory provider and uninstall decisions have native Rust
   ports in `memory-parity-rust/src/main_proxy.rs` and are connected in
   `adapters/claude-code/main-memory.mjs` behind the existing opt-in switch.
2. Extracted Windows source receipt and hash validation is independently
   implemented in `source-packager-rust/src/staged_tree.rs`. It supplements
   the original archive scanner and stage ownership checks; it does not make
   a source ZIP an installer or approve production deployment.
3. The static source audit now recognises the existing `not(windows)` Ghost
   guards, retaining Linux-only source while refusing unguarded Windows
   control entry points.
4. Windows native verification and GitHub CI run the new compiled differentials
   only after reviewed dependency lockfiles exist.

## Native Windows steps (isolated checkout only)

```powershell
pwsh -File .\native\windows\prepare_rust_locks.ps1 -GenerateMissing
pwsh -File .\native\windows\verify_rust_upgrade.ps1 -Native
```

The first command modifies the isolated checkout and requires human dependency
review. The second must pass format, Rust tests, Clippy and native binary
comparisons. Do not set `SINGULARITY_RUST_MEMORY_POLICY_BIN` on any installed
service until all compiled differences and live agent memory tests pass.

## Required follow-up evidence

- Compile all eight crates using reviewed, committed Cargo.lock files.
- Run the actual 576-case `differential_main_proxy.py` against the compiled
  memory-parity executable and 18-case `test_rust_extracted_tree.py` against
  the compiled source-packager executable.
- Validate real parent-session and delegated MemoryCore isolation, fresh
  session recall and write/readback. Do not interpret offline CONFIGURED as
  authenticated VERIFIED.
- Validate pinned Tencent source and its backend overlay, RepoQL 1.7.18
  connectors, current Kanzo authorization, and each required Office event.
- Run native installer upgrade, rollback, uninstall, reboot and user UI
  acceptance on a dedicated Windows engineering host.
- Rebuild the old `bootstrapper/source.zip` only after all native acceptance;
  the historical embedded archive is intentionally preserved unchanged in
  the cumulative source candidate and is NOT the Rust upgrade installer.

Nothing in this handover authorises a service change, installation, credential
exposure or a release approval. No installed system was touched here.

## Known inherited test limitations

The full legacy Claude installer test suite has two `resolveVariant` failures
in this Windows source tree because `ghost/setup-ghost.sh` and
`office/office.compose.yml` are absent. Both failures reproduce on the
unchanged Wave 14 baseline. The Windows Ghost/Office profile is verified by
its dedicated variant scanner. This does not grant an exception for any
failure in the Windows-specific installer or memory regression suites.
