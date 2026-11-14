# Rust Wave 15: parent memory provider governance and staged source integrity

Status: **source candidate only. Not compiled, not installed, not release accepted.**

## Parent-session memory, added in this wave

`native/windows/memory-parity-rust/src/main_proxy.rs` implements three pure
commands: `main-memory-state`, `main-memory-plan`, `main-memory-uninstall`.
`adapters/claude-code/main-memory.mjs` calls them only when
`SINGULARITY_RUST_MEMORY_POLICY_BIN` is explicitly configured. All returned
fields are checked against the existing JavaScript decision. In particular:

* An existing Anthropic, Bedrock, Vertex, Foundry or helper route cannot be
  silently overwritten without explicit provider-replacement consent.
* Offline configuration state is never promoted to a live VERIFIED claim.
* Uninstall can restore or remove only the three installer-owned environment
  keys, and only when the current value still matches the installation receipt.
* The Rust process receives only boolean evidence and enumerated key names,
  never API keys, tokens, model names, gateway URLs or previous credentials.
* The original JavaScript implementation retains settings mutation, network
  probes, installed identity ownership and the contents of the private files.

Default behavior, parent/delegated separation, Kanzo ownership and provider
routing are unchanged with the native switch unset.

## Native Windows source integrity, added in this wave

`native/windows/source-packager-rust/src/staged_tree.rs` implements the
read-only `verify-extracted EXTRACTED_SOURCE_ROOT` command. It verifies listed
source hashes and byte lengths, manifest/variant claims, Windows-safe paths,
case-folded duplicate paths, untracked extracted files, the exact RepoQL release pin and SHA256SUMS.
It uses bounded reads and never writes to a staging directory.

This is supplementary. It cannot establish publisher identity, staging receipt
ownership, live service readiness, Windows reparse safety in parent
directories, or a successful upgrade/rollback. The
original archive scanner and installer PowerShell ownership checks remain
required and authoritative.

## Existing Windows Ghost/Office static release gate correction

The static `native/windows/verify_source_release.py` gate previously refused
`native/desktop-bridge` simply because the Cargo feature `ghost = []` existed.
Actual code already gates both Ghost entry points with
`#[cfg(all(feature = "ghost", not(windows)))]` and reports false for Ghost on
Windows. The guard now verifies that exact Windows exclusion instead of
requiring removal of Linux-only Ghost code. A regression rejects unguarded or
feature-only Ghost entry points. No Windows Ghost runtime was enabled.

## Evidence that can be produced here

* `node --test adapters/claude-code/main-memory.test.mjs adapters/claude-code/main-memory-rust-boundary.test.mjs`
* `python native/windows/memory-parity-rust/tests/differential_main_proxy.py --repo .`
* `python native/windows/test_rust_extracted_tree.py`
* `python native/windows/verify_source_release.py` and the Ghost isolation unit tests
* Existing Windows source and memory regression tests

Reference suites do not run Rust and must never be presented as Rust parity.

## Onsite compiler and Windows handover

In an **isolated native Windows checkout**, after reviewing generated locks:

```powershell
pwsh -File .\native\windows\prepare_rust_locks.ps1 -GenerateMissing
pwsh -File .\native\windows\verify_rust_upgrade.ps1 -Native
```

Native verification compiles all eight crates, runs Clippy and unit tests,
then executes the 576 parent-memory cases and 18 staged-tree cases against
real binaries. Compiled equivalence is required before enabling the native
memory policy switch on installed services. Full real-agent delegated and
parent-session MemoryCore readback, pinned Tencent source backend validation,
RepoQL/connector sweeps, Kanzo claim readback, full Windows installer and
rollback evidence are still required and **NOT_RUN**.

Do not copy the source ZIP into production as an installer. No source-only
artifact or reference fixture constitutes production upgrade approval.

## Inherited installer test failures

Running the whole `adapters/claude-code/installer.test.mjs` suite from this
Windows-only source checkout yields two failures in `resolveVariant` tests
for the POSIX Ghost setup and Office compose files. Those exact failures
reproduce unchanged on the published Wave 14 baseline. The missing files
are intentionally excluded from the Windows source candidate. Do not treat
these tests as a Wave 15 regression or count the unfiltered integration
suite as passing. The native Windows source-variant scanner remains the
appropriate shipped-component gate. Restore the legacy POSIX artifacts only
when validating a separate complete Linux package, not the Windows source.
