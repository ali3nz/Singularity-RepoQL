# Wave 21: scoped native MemoryCore write transport

Wave 20 shipped opt-in native read clients. Wave 21 adds a separate, opt-in Rust conversation write transport, retains authorization and readback in the existing owner, and checks two more read-only count endpoints.

Primary paths:
- `native/windows/unified-gateway-rust/src/bin/singularity-memorycore-writer.rs`
- `scripts/native-memorycore-reader.mjs`
- `scripts/memory-config-loader.mjs`
- `scripts/setup-agent-profiles.mjs`
- `native/windows/unified-gateway-rust/tests/differential_memorycore_writer.py`
- `native/windows/RUST_WAVE21_HANDOVER.md`

No writes are performed twice for parity testing. Unlike idempotent read comparisons, write parity compares **one write per isolated fixture process** against a reference request and response contract. The real native process must pass compiled differential tests before any opt-in testing. Default settings do not change.

The orchestration runtime, dashboard backend, other provider integrations, service lifecycle and global Windows installer remain partly JavaScript/Python. Full Rust migration and release approval are not claimed.
