# Rust migration Wave 3: Windows source package and RC memory stack

Date: 2026-11-12. Baseline: the consolidated Windows Singularity V2 source plus Wave 2 Rust memory-policy candidate. This is authoring source, **not** a finished Rust-only Windows application.

## New Rust replacements

- `native/windows/source-packager-rust`: independently written native implementation of the existing JS shipped-file classifier, Python Windows source policy, four-option source archive builder, and fail-closed ZIP scanner. There are no Node or Python runtime calls in this crate. The legacy tools remain for differential acceptance and rollback.
- `native/windows/rc-stack-rust`: native RC config generation, lifecycle, health, local token reading, scoped write/recall/delete verification, and restricted state cleanup. It invokes the current project-owned Node supervisor and the installed Tencent HTTP service; it does not replace either vendor Core or the supervisor.
- Existing `native/windows/memory-parity-rust` Wave 2 crate remains staged. Its pure policy ports still require compilation and trusted host integration.

## Added compatibility evidence

- A golden fixture of 1,044 classified paths and all four Python source-policy outcomes captured from the preexisting implementations.
- Rust crate unit tests for Windows archive member rules, source classification, variants, RC configuration and health.
- `native/windows/source-packager-rust/tests/compare_legacy_release.py` compares each Rust-built source archive to the Python builder, including every member's contents and the manifest semantics.
- `native/windows/verify_rust_wave3.ps1` runs Cargo formatting, tests, Clippy, release builds, four source package builds, Rust ZIP scanning, and differential archive validation on Windows.

## Rules maintained

No changes to coordinator stages, model selection, worker routing, Kanzo claims, agent identities, provider APIs, service lifecycle ownership or installer deployment. The existing JS and Python paths remain the live implementation, because neither the new Rust crates nor the previous ten Rust policy modules have been compiled or tested on native Windows from this environment. Do **not** remove legacy entrypoints until the engineer establishes callsite parity, rebases/updates the installer, and verifies native behavior.

## Unported scope

A complete Rust-only system additionally requires replacing the in-use JavaScript/Python orchestrator and hook runtime, MCP/RepoQL connectors and transport, dashboard Python HTTP service, memory capture consumer and writer, desktop integration and installers, numerous utility modules and test runners. Third-party RepoQL, Kanzo and Tencent binaries must remain external dependencies unless separately licensed and redesigned. Automated one-to-one translation is not equivalent to functional migration.

## Verification gate

The authoring environment has no `rustc`, `cargo`, Cargo registry or native Windows session, so Rust compile, differential, runtime and deployment are **NOT RUN**. Legacy reference tests passing do not prove Rust equivalence. The onsite engineer must run `native/windows/verify_rust_wave3.ps1` and supply logs before enabling these replacements.

The two previously flagged V2 retrieval bugs are patched in the staged JavaScript candidate with new regressions. This does not certify that the Rust host runtime uses those fixes.
