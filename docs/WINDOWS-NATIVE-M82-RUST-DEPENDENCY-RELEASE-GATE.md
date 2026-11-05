# Milestone 82 — Rust dependency lock provenance release gate

**Source-only; RELEASE BLOCKED**. Desktop bridge and Windows supervisor currently lack committed `Cargo.lock` files. Their CI commands can resolve dependency versions at build time, which is unsuitable as proof of a fixed release dependency graph. This check does not provide publisher signing, crate audit, trusted compiler evidence, or runtime acceptance.

`native/windows/check_rust_lock_provenance.py` is a **read-only, Python 3.11+** source gate for `native/desktop-bridge/Cargo.lock` and `native/windows/rust-supervisor/Cargo.lock`. It checks root package identity and version, Cargo.lock syntax 3/4, duplicate package identity, and registry package sources plus SHA-256 checksum fields. It prints only paths, hashes/counts, missing/valid states and explicit `releaseReady:false`; no network, crate installation or lock generation. Missing/ambiguous/untrusted lockfile content **fails closed**.

A separate Windows CI job now runs its six focused fixture tests, then the release dependency gate. **The gate intentionally fails until reviewed lockfiles are committed.** The existing `claude-complete-option2-bundle` job remains independent and may still produce a `WINDOWS-ACCEPTANCE-NOT-INSTALLER` candidate; that artifact is not approved for production.

Operator/Codex must generate each lockfile on the approved Windows Cargo toolchain, review the resolved crate graph and registries, commit both lockfiles with exact Cargo.toml revisions, run `cargo build --locked` and `cargo test --locked`, and independently verify compiled binaries and publisher provenance. A passing lockfile structural gate is only the beginning of a reproducible release, never a release-ready certificate.
