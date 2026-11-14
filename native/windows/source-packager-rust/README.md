# Native Windows source packager in Rust

Replaces the behavior of these project-owned tools without shelling out to Node or Python:

- `scripts/bundle-classification.mjs`: shipped-file walking, ordered source classification and four-option partitions.
- `native/windows/windows_source_policy.py`: native Windows path exclusions, Office and Ghost boundaries, Linux deployment entrypoint filtering.
- `native/windows/build_source_variants.py`: source selection, deterministic ZIP metadata, hashes, source manifests and four variant packages.
- `native/windows/scan_source_archive.py`: read-only ZIP member validation, Windows name constraints, release policy, size caps, CRC reads, hashes and manifest checks.

This is a **source implementation**, not a compiled Windows executable. The original paths remain untouched until the onsite engineer proves behavioral parity. The Rust packager refuses to follow source symlinks, rejects non-ASCII member paths to avoid unsafe Windows case-fold collisions, and refuses to overwrite existing ZIP outputs. These additional fail-closed guards may reject inputs previously accepted. A byte-for-byte ZIP match is not required, but member inventories, contents, manifests and source policies must agree.

Build on Windows from repository root:

```powershell
cargo test --manifest-path native/windows/source-packager-rust/Cargo.toml
cargo clippy --manifest-path native/windows/source-packager-rust/Cargo.toml --all-targets -- -D warnings
cargo build --release --manifest-path native/windows/source-packager-rust/Cargo.toml
```

CLI commands:

```text
singularity-source-packager partition ROOT
singularity-source-packager classify RELATIVE_PATH
singularity-source-packager verify-policy ROOT VARIANT
singularity-source-packager scan PACKAGE.zip [PACKAGE.zip ...]
singularity-source-packager build ROOT OUTPUT_DIRECTORY [VARIANT]
```

When built by Cargo from the crate directory, the executable is `target/release/singularity-source-packager.exe`. The binary does not deploy services, change the installed runtime, or claim native functional acceptance.


## Extracted source integrity gate (Wave 15 source only)

`singularity-source-packager verify-extracted EXTRACTED_SOURCE_ROOT` independently
checks the packaged `NATIVE_WINDOWS_SOURCE_MANIFEST.json`, expected SHA256 and
file sizes, source-only acceptance claims, the RepoQL 1.7.18 connector contract,
Windows-safe relative paths, duplicate case-folded names, untracked source files and `SHA256SUMS`.
It reads only the supplied extracted source tree and never writes to it.

This gate is NOT proof of installation ownership, publisher/source authenticity,
Windows reparse safety in unrelated parent directories, publisher signing, or
runtime acceptance. Keep the existing PowerShell ownership receipt checks and
original ZIP scanner. Run `python native/windows/test_rust_extracted_tree.py
--rust-cli PATH_TO_COMPILED_PACKAGER` on native Windows after Cargo compilation.
The reference fixture script alone does not establish Rust parity.
