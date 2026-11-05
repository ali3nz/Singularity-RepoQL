# Milestone 42: Claude Code Complete Option 2 Windows build candidate

## Scope and decision

Option 2 only. This implements an honest, repeatable Windows build packaging path for **two native Rust executables and the exact Option 2 source-only profile**. It is an acceptance candidate, **not an installer**. The source ZIP remains a source profile; bundling native executables does not confer installed service, GUI, Office, Ghost, Tencent or RepoQL acceptance.

## Windows CI deliverable

New `claude-complete-option2-bundle` job in `.github/workflows/native-desktop-rust.yml`:

1. Runs the isolated bundle-assembler tests on Windows.
2. Compiles `singularity-desktop-bridge.exe` with `office,ghost` features.
3. Compiles `singularity-windows-supervisor.exe`.
4. Creates and verifies the Option 2 source-only ZIP from the *same* repository checkout.
5. Uses `build_option2_acceptance_bundle.py` to validate both AMD64 PE binaries, version pins, source manifest, ZIP inventory and hashes. The assembler refuses non-Windows hosts, unexpected file names, symlinked inputs, conflicting output files, wrong variants, incorrect architecture and malformed source.
6. Uploads a single short-retention artifact labelled `WINDOWS-ACCEPTANCE-NOT-INSTALLER`, linked to the GitHub commit in its manifest.

No third-party executable, service secrets or user profile data are bundled. Binary PE format alone is **not** evidence of a trusted software publisher. This build requires a source checkout and an authorized Windows GitHub runner; it has not been executed in the current Linux sandbox.

## Acceptance bundle layout

- `bin/singularity-desktop-bridge.exe`
- `bin/singularity-windows-supervisor.exe`
- `source/singularity-native-windows-option2-SOURCE-ONLY.zip`
- `ACCEPTANCE_BUNDLE_MANIFEST.json`, including verified SHA256 digests, provenance commit when available and explicit `production_release_ready:false`.

## Operator handoff on native Windows

From Milestone 43 onward, use the guarded `bootstrap/prepare_option2_candidate.py` inside the outer candidate to inspect and prepare the verified nested source without manually extracting the second ZIP; see `docs/WINDOWS-NATIVE-M43-OPTION2-PREPARATION.md`. Earlier M42 candidates still require manual extraction. Run the existing read-only preflight and use `native/windows/stage-native.ps1` **only with explicit approval** and locally verified, independently installed `rql.exe` version **1.7.18** and Claude Desktop GUI executables. Staging does not install, start or verify the service stack. Do not run staging on a production system until rollback and source provenance are independently reviewed.

## Outstanding live acceptance

The following remain **blocked**: actual Windows CI execution and Rust compilation receipts, publisher signing and provenance, native Claude Desktop Code-tab agent/skill activation (10 Singularity + 17 RepoQL), Office UI and Ghost isolation, Tencent MemoryCore delegated/parent fresh-session readbacks, independent Tencent/RepoQL revision parity, service lifecycle/reboot/rollback/uninstall, Windows permission inspection and approved installer distribution.

## Verification available without Windows

Python unit tests exercise positive and negative package cases with **synthetic PE headers**. Such fixtures are not a substitute for a signed, compiled Windows executable, and are never published as an acceptance binary. Both Rust executables still require real Windows compilation and runtime acceptance.
