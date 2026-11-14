# Windows Singularity Rust migration: Wave 18

Status: **SOURCE CANDIDATE. NOT COMPILED. NOT AN INSTALLER.**

## Scope completed in source

The existing `singularity-release-evidence` crate now has two new native
stdin-only policy commands:

- `upgrade-plan-stdin` computes the dependency and ordered action plan for the
  Windows Option 2 upgrade from already validated receipt-presence booleans
  and authoritative native scheduler states. It **never** executes an action.
- `acceptance-matrix-stdin` computes the redacted Claude Code Complete
  acceptance matrix from gate receipts already validated by the Python owner.
  Even 24 reported PASS results never establish release readiness.

The Python entry points `native/windows/plan_option2_upgrade.py` and
`native/windows/claude_complete_acceptance_matrix.py` continue to own receipt
validation, reparse-point checks, source file hash verification, and collection
of scheduler evidence. The Rust process receives only sanitized policy inputs,
never credential values, local paths, raw receipts, evidence logs or files.

The selected Rust decision is returned only after exact comparison with the
current Python result. An error, malformed binary result or mismatched decision
is refused with no automatic fallback. The native path is enabled only by
`SINGULARITY_RUST_RELEASE_EVIDENCE_BIN` pointing to a previously compiled and
independently reviewed, locally owned `singularity-release-evidence.exe`.
With the variable unset, existing Python behavior remains unchanged.

## Local source tests

- 24 Python upgrade, acceptance and native boundary tests (before extended
  release checks), including forged native approval and reparse-point paths.
- 649 independent Python reference scenarios generated from real synthetic
  receipts: 576 upgrade configurations and 73 acceptance states.
- Memory retrieval and original Windows source-contract tests.
- The original source archive scanner verifies all four generated variants.

These Python oracle checks are **not** Rust executable parity. The compiled
binary comparison uses the same fixtures only after native compilation.

## Windows native verification

In a disposable Windows engineering checkout containing reviewed dependency
locks, run:

```powershell
pwsh -File .\native\windows\verify_rust_upgrade.ps1 -Native
```

This runs the expanded `differential_upgrade_acceptance.py` suite against
`singularity-release-evidence.exe` alongside the existing memory and release
policy suites. The dedicated Windows CI job also runs this compiled differential.
It never installs, restarts or reconfigures a service.

## Release blockers

Four crates lack generated, reviewed Cargo lockfiles. Rust compilation and
native binary parity are not proven here. The Tencent MemoryCore pinned backend,
real Kanzo task authorization, live Windows nine-agent memory behavior, native
installer replacement and upgrade/rollback receipts remain unverified.
Significant legacy JavaScript and Python runtime remains. The embedded legacy
bootstrapper is historical and must not be used as a Rust installer.
