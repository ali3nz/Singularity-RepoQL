# Singularity Windows Rust Wave 21: MemoryCore write transport handover

Status: SOURCE ONLY. No compiled Rust or native Windows acceptance was performed in the authoring environment. The original runtime remains the default.

## Delivered scope

- A dedicated `singularity-memorycore-writer` executable in the already-locked `native/windows/unified-gateway-rust` crate. It accepts exactly one scoped `/v3/conversation/add` operation on stdin, reads credentials from the local MemoryCore configuration, connects to an explicit `127.0.0.1` HTTP origin, disables redirects, and never retries ambiguous delivery.
- An opt-in Node adapter enabled **only** when `SINGULARITY_RUST_MEMORYCORE_WRITER_BIN` is set to an absolute trusted executable. JavaScript checks the current local config matches the caller's credential and endpoint configuration before invoking the writer. It does not send credentials on argv or stdin, does not perform a second JavaScript write, and rejects missing application confirmation.
- The existing Claude Code hook still performs query-before-write, strict stable-task reconciliation, and readback. The agent charter seeder performs a live search readback before writing its own ledger when the native writer is enabled.
- The existing Rust reader and Node bridge additionally accept the two read-only `/v3/conversation/count` and `/v3/atomic/count` endpoints, checked against the reference response.
- Local fixture coverage for native bridge rejections and synthetic HTTP reads/writes, plus Windows CI and verification script integration.

## Native engineer validation in an isolated Windows checkout

1. Verify the outer archive checksum, extract the source, then run `python scripts/verify_wave21_source.py`.
2. Confirm the checked-in `native/windows/unified-gateway-rust/Cargo.lock` has not changed unexpectedly. This crate already has a lockfile, but **the four missing lockfiles in other crates remain release blockers**.
3. Run:

   ```powershell
   cargo fmt --manifest-path native/windows/unified-gateway-rust/Cargo.toml --all -- --check
   cargo test --manifest-path native/windows/unified-gateway-rust/Cargo.toml --locked --all-targets
   cargo clippy --manifest-path native/windows/unified-gateway-rust/Cargo.toml --locked --all-targets -- -D warnings
   cargo build --manifest-path native/windows/unified-gateway-rust/Cargo.toml --locked --release --bin singularity-memorycore-reader --bin singularity-memorycore-writer
   node --test scripts/native-memorycore-write.test.mjs scripts/native-memorycore-v3.test.mjs scripts/setup-agent-profiles.test.mjs
   python native/windows/unified-gateway-rust/tests/differential_memorycore_reader.py --rust-cli native/windows/unified-gateway-rust/target/release/singularity-memorycore-reader.exe
   python native/windows/unified-gateway-rust/tests/differential_memorycore_writer.py --rust-cli native/windows/unified-gateway-rust/target/release/singularity-memorycore-writer.exe
   ```

4. Only when the compiled checks pass, in an isolated synthetic Windows instance with dedicated test identity and a temporary local MemoryCore service, set `SINGULARITY_RUST_MEMORYCORE_WRITER_BIN` to the verified executable path and run one isolated Claude Code capture. Independently query MemoryCore to establish precisely one persisted turn and test that a retry does not duplicate it. Also verify that a disconnected or delayed write never triggers a second POST.
5. Restore the default immediately by **removing** the `SINGULARITY_RUST_MEMORYCORE_WRITER_BIN` setting. This only changes future transport selection; it cannot undo any already accepted memory write.
6. Review actual Kanzo authorization and Tencent backend evidence, then complete Windows install, reboot, data continuity and rollback acceptance. Do not switch live users before these gates.

## Known limitations and deliberately preserved interfaces

- MemoryCore, RepoQL and Tencent remain third-party components; this change does not replace their databases or authorization schemes.
- Rust is a transport only. It cannot decide tenant, agent, session, task, or content and does not own the memory ledger. The owner must continue to authorize namespace, reconcile and verify durable writes.
- If the Rust child times out, crashes, or returns malformed content, the caller must **not** reissue the write automatically. Re-query by stable task identity before deciding whether another write is needed.
- The binary will reject old callers that omit identity, task ID or message content. This is an intentionally stricter opt-in contract; the legacy JavaScript path is unchanged.
- The compiled Rust binary, real network transport equivalence, Windows ACL/reparse behavior, live MemoryCore, Kanzo, Tencent, installation and rollback are NOT_RUN here.
- Do not deploy the preserved historical embedded Windows bootstrapper as a Rust upgrade installer.

## Engineering acceptance

Source and reference tests here are not a Rust compilation result. The Windows native verification gate intentionally refuses to pass without checked-in lockfiles for all crates and actual compiled differential results. This source archive is not an installer or deployable release.
