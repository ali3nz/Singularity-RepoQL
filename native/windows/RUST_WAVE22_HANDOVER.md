# Windows Rust Wave 22: dashboard model telemetry normalization

Status: SOURCE ONLY. Rust compilation, native Windows behavior, a live
collector run using Rust, and installation are NOT_RUN in the authoring host.

## Change and ownership

The optional `singularity-telemetry-model` Rust binary in the already-locked
`native/windows/unified-gateway-rust` crate normalizes batches of up to 128
model-usage metadata rows. The output is restricted to provider, billed tokens,
reported outbound cost and the receiving-side versus sender-side cost kind.
The Python dashboard collector remains the source of truth for accounting
semantics, journal cursors, SQLite storage, source transactions, retention and
all authorizations. The binary neither reads files nor calls the network.

In the default configuration no binary is invoked. With the optional
`SINGULARITY_RUST_TELEMETRY_BIN` environment variable set to an absolute,
trusted executable, each batch is passed through Rust. Python checks every
result against the original reference before committing source transactions.
Any mismatch or timeout rolls back that source transaction; it does not fail
or block the orchestration harness. On the next collection the cursor is retried.

The child receives only a closed list of engine/model and measured-usage fields.
Prompts, responses, ledger IDs, source paths, secrets, provider credentials,
transcript text and run IDs are excluded. Arbitrary strings in numeric fields
are refused in native mode. The default Python path retains its legacy behavior.

## Windows engineer validation

1. Review the source archive SHA256 and extracted source manifest. Do not deploy
   the preserved historical bootstrapper or assume a ZIP is an installer.
2. Confirm unchanged `native/windows/unified-gateway-rust/Cargo.lock`, then in
   a native Windows engineering checkout run:

```powershell
cargo fmt --manifest-path native/windows/unified-gateway-rust/Cargo.toml --all -- --check
cargo test --manifest-path native/windows/unified-gateway-rust/Cargo.toml --locked --bin singularity-telemetry-model
cargo clippy --manifest-path native/windows/unified-gateway-rust/Cargo.toml --locked --bin singularity-telemetry-model -- -D warnings
cargo build --manifest-path native/windows/unified-gateway-rust/Cargo.toml --locked --release --bin singularity-telemetry-model
Push-Location dashboard
python -m unittest test_rust_telemetry_model test_native_telemetry_platform
Pop-Location
python native/windows/unified-gateway-rust/tests/differential_telemetry_model.py --rust-cli native/windows/unified-gateway-rust/target/release/singularity-telemetry-model.exe
```

3. Use a **temporary test telemetry database** and synthetic usage JSONL data
   before selecting `SINGULARITY_RUST_TELEMETRY_BIN` on a dashboard test
   collector. Verify the same totals, deduplication, source cursor, retention,
   and no novel credential exposure. Exercise a deliberately broken binary and
   confirm the source transaction rolls back without affecting the harness.
4. Clear `SINGULARITY_RUST_TELEMETRY_BIN` to return to Python-only normalization.
   It is a selection change, not an upgrade/rollback of data already written.
5. Run the full `native/windows/verify_rust_upgrade.ps1 -Native` gate once all
   eight Rust crates have reviewed Cargo.lock files. It must still independently
   validate Tencent, Kanzo, RepoQL, native Windows services, upgrade and rollback.

## Outstanding boundaries

- `cargo`, `rustc` and `pwsh` are not installed in this authoring environment.
  The new Rust source has never been compiled or executed here; Python source
  regression and synthetic reference scenarios cannot prove Rust parity.
- Four other crates lack reviewed Cargo.lock files.
- Python still owns the telemetry database, most dashboard code, and the
  production collector. This is not a complete Rust dashboard rewrite.
- Main orchestration, service management, installer, other connectors and
  native MemoryCore behavior remain subject to separate migration/acceptance.
- This source artifact changes no GitHub repo, service or installed Windows app.
