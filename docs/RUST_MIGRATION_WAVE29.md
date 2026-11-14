# Windows Singularity Rust Wave 29

Date: 13 November 2026. Scope: Windows Claude Code Full installation source only. No native build or deployment approval.

## Changed component

- Add the `singularity-native-readiness` Rust CLI as a pure, read-only renderer of the existing Windows service readiness report.
- Preserve the existing Python authenticated probes and their invocation order. Python executes each enabled probe once, catches private exceptions and supplies only seven booleans plus the Office feature flag to Rust.
- Use `SINGULARITY_NATIVE_READINESS_RUST_BINARY` as an optional absolute native executable path. Absent opt-in, only Python is used. With opt-in, reject missing or symlinked executables, failures, invalid JSON, oversized requests or response and any output unequal to the Python reference.
- Keep `release_ready` unconditionally false. A successful local service ping is not proof of a Windows installation, account login, source indexing, subscription receipts or GUI workflow acceptance.
- Add Python bridge regressions and 656 deterministic source-only reference cases. Native compiled comparison is a separate required Windows CI gate and remains unexecuted in this environment.

## Non-goals

No modification of the coordinator, approvals, memory writer, bot supervision, user accounts, service endpoints, installer, rollback mechanisms or Linux Docker host. Rust performs no network requests, file reads or mutations in this wave.

## Validation and release gate

Run from the extracted source root on a supported Windows build host, after the Cargo lockfile policy gate is satisfied:

```powershell
python native/windows/check_rust_lock_provenance.py
cargo fmt --manifest-path native/windows/unified-gateway-rust/Cargo.toml --all -- --check
cargo test --manifest-path native/windows/unified-gateway-rust/Cargo.toml --locked --bin singularity-native-readiness
cargo clippy --manifest-path native/windows/unified-gateway-rust/Cargo.toml --locked --bin singularity-native-readiness -- -D warnings
cargo build --manifest-path native/windows/unified-gateway-rust/Cargo.toml --locked --release --bin singularity-native-readiness
python native/windows/unified-gateway-rust/tests/differential_native_readiness.py --rust-cli native/windows/unified-gateway-rust/target/release/singularity-native-readiness.exe
```

Run the complete Windows CI acceptance and upgrade rollback tests before using this binary in a real installation. Stop on any mismatch, test failure or lockfile provenance failure. The source archive is not an installer.

## Reversal

Leave `SINGULARITY_NATIVE_READINESS_RUST_BINARY` unset to retain the previous Python renderer. If opted in, remove the variable to reverse the renderer selection without changing any service or data. The Python report remains the authority.
