# Native Windows release-evidence tools, Rust Wave 4

Source-level Rust replacements for existing read-only local evidence utilities.
No installation, provider communication, credential reads or running services.

| Rust CLI subcommand | Existing source reference | Status |
| --- | --- | --- |
| `parity` | `compare_production_parity.py` | Complete read-only comparator port, synthetic `--now` for differential testing |
| `linux-candidates` | `trace_linux_assumptions.py` | Complete ZIP source candidate inventory port |
| `rust-lock` | `check_rust_lock_provenance.py` | Complete structural Cargo lockfile gate port |
| `connector-evaluate` | `verify_option2_connectors.py` `evaluate()` only | Pure inventory decision port; native RepoQL probe and binary version check remain in Python |

These ports are implemented, but NOT active replacements. Their original Python
entrypoints are preserved because this authoring environment has no Rust compiler
and no native Windows runtime. Source-only is NOT accepted, installed, or signed.

## Build and test on Windows

From this directory on Windows:

```powershell
cargo fmt --all -- --check
cargo test --locked
cargo clippy --locked --all-targets -- -D warnings
cargo build --locked --release
python tests/differential.py --repo ../../.. --rust-cli target/release/singularity-release-evidence.exe
```

`cargo test --locked` requires a generated, reviewed and committed `Cargo.lock`.
Until that exists, use `cargo test` in an isolated engineering clone and
inspect the produced lockfile before any release. Always use the full
`verify_rust_wave4.ps1` script for release gating after lock review.

### CLI invocation

```powershell
.\target\release\singularity-release-evidence.exe parity --production production.json --windows windows.json
.\target\release\singularity-release-evidence.exe linux-candidates option1-SOURCE-ONLY.zip
.\target\release\singularity-release-evidence.exe rust-lock --source-root C:\src\Singularity-RepoQL
.\target\release\singularity-release-evidence.exe connector-evaluate --inventory inventory.json
```

The CLI never upgrades an unverified receipt to a release approval. `parity`,
`rust-lock`, and `connector-evaluate` return exit code 2 for blocked results.
`linux-candidates` returns 0 for successful diagnostics, even when it finds
Linux references, just like the original diagnostic.

## Acceptance boundary

The live connector inventory collector and native RepoQL pin checker were NOT
replaced. Do not bypass those checks by presenting arbitrary user-supplied JSON
as proof that connectors actually work. The comparator only checks metadata.
Integration into production callers is explicitly deferred until compilation,
fixture differential tests and real Windows acceptance pass. The complete
remaining JS/Python application is NOT rewritten by this crate.

## Wave 8: documentation closeout policy

`doc_impact.rs` is a pure Rust port of `harness/kit/lib/doc-impact.mjs`. It
classifies changed source files as review-required or unmapped, then renders
the existing closeout receipt text. It does not decide that a document has
no impact. Opt-in selection is through the explicit
`SINGULARITY_RUST_EVIDENCE_POLICY_BIN` absolute executable path. While
selected, the JavaScript bridge checks exact output equivalence and refuses
mismatches. It does not alter any workflow stage.

Commands: `doc-impact-stdin` with `{"changedFiles":[...]}` and
`doc-render-stdin` with `{"classification":{...}}`. Both use bounded JSON
stdin and emit read-only JSON.

Native acceptance:

```text
python native/windows/release-evidence-rust/tests/differential_doc_impact.py --repo . --rust-cli native/windows/release-evidence-rust/target/release/singularity-release-evidence.exe
```

The compiler and native Windows evidence are still required before a release.
