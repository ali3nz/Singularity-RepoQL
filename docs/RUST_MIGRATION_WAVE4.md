# Rust Wave 4: evidence gates, source-only candidate

Target: Windows Singularity RepoQL source V2 plus staged Rust Waves 1–3.
This wave adds `native/windows/release-evidence-rust/` and
`native/windows/verify_rust_wave4.ps1` without changing service ownership,
active orchestration, provider routing, native installed configuration or users'
memory records.

## Scope completed at source level

1. `compare_production_parity.py`: full read-only receipt comparator in
   `parity.rs`, including strict variant selection, two independently observed
   hosts, freshness, synthetic receipts, exact pinned repoql version, ABI and
   `PASS_RECEIPTED` decisions. CLI `parity` returns 2 on insufficient evidence.
2. `trace_linux_assumptions.py`: ZIP-based, redacted Linux source-candidate
   inventory in `linux_candidates.rs`, preserving line/category reporting.
   It does not label source references as executed dependencies.
3. `check_rust_lock_provenance.py`: Cargo.toml/lock structural provenance gate
   in `rust_locks.rs`, refusing missing locks, symlinks, invalid checksums and
   duplicate package identities. It cannot verify upstream signature trust.
4. `verify_option2_connectors.py::evaluate()`: inventory assessment in
   `connector_inventory.rs` only. Live Windows RepoQL pin verification and
   connector inventory collection are deliberately retained and must remain
   the exclusive source of trusted input.

The four ports are invoked through the `singularity-release-evidence` Rust CLI.
The existing Python entry points are still the authoritative release mechanism
until native builds, differential tests and operator sign-off. Rust policy
source presence alone is not a replacement.

## Evidence

- 28 independent reference scenarios pass against the original Python source.
- Rust compile, unit tests, Clippy and Python/Rust differential comparisons:
  **NOT RUN** because this authoring environment has no Rust toolchain.
- Windows installed service and native CLI execution: **NOT RUN**.
- No real production/Windows receipts were created or authenticated.
- Run `native/windows/verify_rust_wave4.ps1` on Windows for compile plus
  reference-vs-Rust comparisons, then review any Cargo.lock that Cargo generates.

## Parity limitations

- Python's exact ISO date parser accepts a slightly broader variety of inputs
  than Rust RFC3339. The 28 standard-case fixtures do not establish full
  timestamp-grammar parity. Keep the Python comparator authoritative until
  edge cases are reviewed and validated.
- Case-sensitive UTF-8 archive member matching follows the original scanner.
- Connector inventory evaluation does not assert live connector availability.
- This wave does not rewrite third-party Tencent, Kanzo, RepoQL, Windows GUI,
  telemetry, dashboard, hooks, scripts or installed service endpoints.
- The prior V2 source fixes remain staged; no deployment acceptance is implied.

## Next acceptance gate

On native Windows, ensure pinned dependencies, build and run unit tests,
execute the full 28-case differential fixture, and independently review
failure modes. Only after this stage may callers be moved to Rust under a
separate implementation change and real operational tests.
