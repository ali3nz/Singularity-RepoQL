# Windows Singularity RepoQL Rust upgrade: Wave 7 engineering handover

Status: **source candidate, not a built or deployed Windows release**.
Baseline: Windows V2 + Rust Waves 1 through 6. The coordinator, Kanzo task
ownership, memory writer and all installed services are unchanged.

## Newly implemented source

1. `native/windows/memory-parity-rust/src/bin/memory-turn-capture.rs` ports the
   complete bounded `scripts/memory_turn_capture.py` propose, confirm and status
   workflow into an additional Rust executable in the existing memory crate.
   The CLI stages lessons and confirms completed promotion; it never writes
   concepts or calls a language model. The RepoQL dedup preview remains a
   read-only `rql explore` call, limited to 60 seconds.
2. `scripts/memory_turn_capture.py` delegates to the Rust executable only when
   `SINGULARITY_RUST_TURN_CAPTURE_BIN` is explicitly set to an existing absolute
   path. A native error is fatal, without Python fallback or double execution.
   The default Python operation is unchanged.
3. Confirmation in the Rust implementation is restricted to a canonical file
   inside the configured `pending/` directory. The legacy Python implementation
   does not impose this restriction. The difference is intentional, because a
   general file path must not be promotable through the memory capture CLI.
4. `native/windows/memory-parity-rust/src/main.rs` now fails closed when
   `memory-impact-files` cannot read an explicitly selected knowledge file or
   a file exceeds the bounded input limits. The previous empty-content fallback
   could silently suppress a stale-memory review finding.
5. Added the source-only bridge tests and independent legacy capture scenarios
   in `test_rust_capture_cli_bridge.py` and `differential_capture.py`. Added a
   compiled CLI negative test for missing knowledge files.
6. `native/windows/verify_rust_upgrade.ps1` now includes capture bridge tests,
   the source oracle and the compiled native differential. Added an isolated
   Cargo.lock preparation tool, `prepare_rust_locks.ps1`, and a Windows CI
   workflow for the memory Rust binaries.

## Trust and feature boundaries

- No production switch is enabled in any delivered source variant. Do not add
  `SINGULARITY_RUST_TURN_CAPTURE_BIN` to global agent environments until the
  compiled Rust executable passes its differentials.
- RepoQL concepts remain governed by their existing authority and scope.
- MemoryCore L0/L1 writes, replay, the capture consumer's read-after-write
  reconciliation and Kanzo task authorization are not transferred to this CLI.
- The full Rust-only application migration is **not complete**. The active
  orchestration, dashboard and many service integrations remain non-Rust.
- Four Rust crates still lacked committed Cargo.lock files at the Wave 6
  baseline. No lockfile has been fabricated here.
- **The embedded bootstrapper is NOT a Rust upgrade installer.**
  `bootstrapper/source.zip` still contains the historical source archive
  (934 entries, pinned SHA256 `a7b18e7e7bf7debab22d1a20c4a511768b60e926348f41f560c66fd9e0db46f5`).
  `bootstrapper/main.go` pins that archive, while the MSI builder and payload
  generator separately pin a different historical source SHA256 beginning
  `e8392ba8`. Neither hash identifies this Wave 7 source. These pins must be
  reconciled, rebuilt and reviewed **after** native Rust acceptance. Do not
  present the historical bootstrapper as an upgrade path for this candidate.
- The pinned Tencent upstream source and native Windows services remain
  unavailable here. No backend build or service acceptance is claimed.

## Windows engineering procedure (isolated source checkout)

Use a disposable checkout at the reviewed source revision. Do not point the
scripts at an installed Singularity location, live SQLite databases or live
MemoryCore state.

1. Run the source-only gate:

   ```powershell
   pwsh -File .\native\windows\verify_rust_upgrade.ps1
   ```

2. Install a reviewed Rust toolchain in the engineering environment and inspect
   the crate manifests. Generate only the *missing* lockfiles with:

   ```powershell
   pwsh -File .\native\windows\prepare_rust_locks.ps1 -GenerateMissing
   ```

   Review the committed package versions, registry sources, checksums and
   licenses independently. A structurally valid lockfile is not a publisher
   trust verdict.

3. Run the compiled source gate after lock review:

   ```powershell
   pwsh -File .\native\windows\verify_rust_upgrade.ps1 -Native
   ```

   This invokes `cargo fmt`, `cargo test`, `cargo clippy`, release builds and
   actual Rust-versus-reference differentials. It does not install, register
   or restart Windows services, migrate memory, or enable native flags.

4. After the compiled Rust memory CLI passes, exercise its new lesson capture
   command with `--skip-rql` against a temporary engineering state directory.
   Compare the pending and confirmed files with the Python reference. Confirm
   the original Python wrapper's exit codes and fail-closed behavior with
   the explicit binary switch.

5. Only after independent sign-off, consider a scoped opt-in for the bounded
   lesson capture command. For rollback, unset
   `SINGULARITY_RUST_TURN_CAPTURE_BIN`; both implementations use the same
   `state.json` and pending/confirmed file format. Retain a backup of this
   state before attempting a real cutover.

6. Treat the main orchestrator, RepoQL retrieval, Tencent MemoryCore overlay,
   Kanzo ownership and Windows service acceptance as **separate unfinished
   integration gates**. Success of the lesson capture port does not certify
   end-to-end memory parity or a fully Rust Windows release.

## Unverifiable in this environment

The source environment did not contain `cargo` or `rustc`, could not reach the
Rust distribution service, and is not Windows. Thus Rust compilation, Rust
execution, cross-language equivalence and native Windows runtime tests remain
**NOT RUN**, even though the Python/Node reference and source-bridge tests run.

## Corrections before acceptance

1. Compile the Rust crate. Resolve any compiler, format or clippy problems on
   the actual toolchain; retain a new diff and rerun tests.
2. Confirm Unicode, DST, Windows file rename, RQL timeout and symlink behavior
   in the native capture CLI using temporary directories.
3. Confirm there is no project-specific Windows packaging exclusion for the
   second executable and that all four source distributions include the new
   Rust source files.
4. Review and commit real Cargo.lock files. Never fake checksum entries.
   Then regenerate and verify the embedded bootstrapper payload and all MSI
   source pins from the accepted source. Do not manually bypass hash gates.
5. Obtain separate native approval for the wider Rust migration and for the
   Tencent MemoryCore and Kanzo integration boundaries.
