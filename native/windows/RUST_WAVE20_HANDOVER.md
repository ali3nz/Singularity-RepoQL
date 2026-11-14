# Rust Wave 20 native Windows engineering handover

## Authoritative source

Use the complete Wave 20 source archive or its Wave 19 incremental patch. Do not
apply the historical embedded Windows bootstrapper as an installer. All runtime
behavior remains JS/Python unless explicitly enabled for test.

## In an isolated Windows source checkout

1. Run `python scripts/verify_wave20_source.py` to verify the exact source
   inventory and SHA256 receipts. Verify the outer ZIP SHA256 independently.
2. Run `node --test harness/kit/tests/native-memorycore-reader.test.mjs scripts/native-memorycore-v3.test.mjs`.
3. Build the already-locked Rust crate:

   `cargo fmt --manifest-path native/windows/unified-gateway-rust/Cargo.toml --all -- --check`

   `cargo test --manifest-path native/windows/unified-gateway-rust/Cargo.toml --locked --bin singularity-memorycore-reader`

   `cargo clippy --manifest-path native/windows/unified-gateway-rust/Cargo.toml --locked --bin singularity-memorycore-reader -- -D warnings`

   `cargo build --manifest-path native/windows/unified-gateway-rust/Cargo.toml --locked --release --bin singularity-memorycore-reader`

4. Differentially compare real compiled Rust to the independent JavaScript
   client against a stub local HTTP server:

   `python native/windows/unified-gateway-rust/tests/differential_memorycore_reader.py --rust-cli native/windows/unified-gateway-rust/target/release/singularity-memorycore-reader.exe`

5. Only after all compiled tests pass, configure the opt-in binary path in an
   **isolated test process**. Validate delegated memory identity separation,
   parent memory separation, current revision retrieval, link provenance and
   missing-memory behavior. Never expose private identities or credentials in
   receipts.
6. Complete the existing native Windows upgrade, reboot and rollback matrices,
   including real Kanzo claims and Tencent Core acceptance, before considering
   live activation. Inspect and review the four missing Cargo.lock files for
   other crates independently. Do not invent resolution hashes.

## Fail-closed policy

Unknown endpoints, non-loopback origins, redirects, symlink credential files,
malformed responses, untrusted executable paths, byte overflows and divergent
results cannot be accepted as memory recall. A selected native error remains an
error; it never falls back to another agent's memory. Reads may occur twice
(reference plus native) in the opt-in validation phase, so only **idempotent
read endpoints** are enabled. No Rust memory write path is present.

## Explicit status

Rust binary compile: NOT_RUN in authoring environment.
Native Windows differential: NOT_RUN in authoring environment.
Live Tencent, Kanzo, RepoQL, memory and UI acceptance: NOT_RUN.
Upgrade and rollback: NOT_RUN.

No installation, GitHub commit, or running service was changed by this source pass.
