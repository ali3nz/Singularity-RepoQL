# Windows Rust source migration: Wave 14

## Scope

Wave 14 adds three read-only acceptance decisions to the existing Rust
`singularity-memory-parity` binary: delegated agent identity-map validation
the operator action classifier for marked TEST-document reconciliation,
and repository-relative RepoQL document URI construction.
The existing Windows JavaScript entry points select Rust only when
`SINGULARITY_RUST_MEMORY_POLICY_BIN` is explicitly configured. They compute
and validate the original result first, then compare it to the native result.
A difference or failure refuses the request. This is deliberate compatibility
scaffolding, not a silent fallback or proof that Windows native parity passed.

The CLI never provisions profiles, reads identity maps from disk, contacts
MemoryCore, reads document contents, authorizes Kanzo tasks, invokes RepoQL,
indexes documents, or triggers Tencent repair. The original owners retain those
privileges. The delegated role roster remains defined by
`adapters/claude-code/agent-map.mjs`.

## Source changes

- `native/windows/memory-parity-rust/src/windows_acceptance.rs` provides the two
  pure decisions plus Rust unit tests.
- `native/windows/claude_complete_memory_profiles.mjs` uses checked native
  validation after the existing identity/namespace safeguards.
- `native/windows/claude_complete_doc_reconciliation.mjs` uses checked native
  reconciliation actions, without changing the read-only plan or live repair
  boundaries.
- `native/windows/claude_complete_doc_parity.mjs` uses checked native
  repository-relative URI construction. Path, symlink and document-content
  validation remain with the existing JavaScript owner.
- `native/windows/rust_acceptance_boundary.test.mjs` checks forged native
  success, refusal, malformed data and verified outcomes.
- `native/windows/memory-parity-rust/tests/differential_windows_acceptance.py`
  generates 438 synthetic reference cases from existing JavaScript routines.
  When supplied with a compiled `--rust-cli`, it also performs exact native
  comparisons. Reference-only mode is NOT native validation.
- `native/windows/verify_rust_upgrade.ps1` and Windows CI run both suites.

## Local validation

Running Node/Python reference tests proves the existing behavior and the
opt-in bridge, but Rust compilation and native differential tests remain
NOT_RUN without an installed compiler and reviewed Cargo.lock. No live
profile, Kanzo identity, Tencent backend, installed dashboard, or Windows
upgrade was touched.

## Onsite gate

From an isolated native Windows checkout, after reviewing and committing the
missing Cargo lockfiles:

```powershell
pwsh -File .\native\windows\verify_rust_upgrade.ps1 -Native
```

Do not enable the environment variable on installed services until that
compiled differential gate and live acceptance of the Windows product pass.
This source ZIP is not an installer or a production release.
