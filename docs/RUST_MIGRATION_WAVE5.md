# Rust Wave 5: executed policy integration and source packaging bridge

Baseline: Windows Singularity RepoQL V2 plus staged Rust Waves 1–4.
This is **source-only** and **not an accepted Rust-only Windows deployment**.

## Completed in this source candidate

1. `harness/kit/lib/native-memory-policy.mjs` provides an explicit opt-in,
   bounded local process bridge to `singularity-memory-parity`. It uses an
   absolute configured binary path, no shell, bounded JSON requests/responses,
   timeout, strict schemas and no implicit fallback when Rust fails.
2. Existing synchronous JS call sites can invoke the native binary for RepoQL
   live-source ordering, current/historical/belief temporal policy, exact-value
   tombstone checks, payload budget and byte splitting, bound capture-ledger
   selection, current-truth lineage filtering, candidate provenance policy and
   memory impact scoring. Unconfigured behavior remains unchanged.
3. The native lineage adapter retains the existing strict JavaScript sidecar
   reader, then validates that the Rust filter returned exactly the supplied
   record names and correctly classified stale/invalid states.
4. The native memory-impact CLI adds a read-only file-backed scoring path. The
   JS caller still discovers the approved knowledge directory and supplies the
   exact file list; Rust cannot expand the search scope.
5. `payload-budget` returns a valid omission manifest with `ok:false` and CLI
   exit code 0. Previously an exceeded budget was incorrectly treated as a
   broken Rust process, preventing trustworthy negative differential tests.
6. Source archive building supports an explicit `--rust-binary` CLI option. The
   pre-existing Python scanner rechecks each ZIP, SHA256, size, requested
   variant, archive name and release status independently. Production installer
   selection remains unchanged.
7. Added a native runtime smoke test, 31-case reference/differential fixture,
   Rust boundary tests, packager bridge tests and Windows validation script.
   The old V1/V2 parity fixtures remain available.

## Explicit native selection, after Windows acceptance

```
$env:SINGULARITY_RUST_MEMORY_POLICY_BIN = 'C:\\singularity\\singularity-memory-parity.exe'
```

This affects only the current shell and its child processes. Remove the
variable to restore normal JavaScript policy execution. Do not enable in
production before the new verification gate has passed and the operator
has separately approved a service cutover.

Windows source-only archive build after the packager's native acceptance:

```
python native/windows/build_source_variants.py --rust-binary C:\\singularity\\singularity-source-packager.exe --output-dir C:\\singularity\\staged-source
```

## Local validation that actually ran

- Node harness: 71 passed, 1 skipped, 0 failed.
- Memory retrieval regressions: 43 passed, 0 failed.
- Windows Node tests: 30 passed, 0 failed.
- Windows Python unit tests: 13 passed, 0 failed.
- RC stack: 11 passed, 0 failed.
- Overlay verifier: 3 passed, 0 failed (structural tests only).
- Reference-only differential fixtures: v1 23, v2 22, v3 31.
- Node CLI protocol tests: included in harness total; tested invalid executable,
  malformed JSON, rejected result, invalid permutation, limit enforcement and
  mandatory context preservation on native ranking failure.
- Modified JavaScript syntax check and Python bytecode compilation: pass.
- Native Rust compilation, Clippy, actual Rust-vs-JS differential testing,
  Windows service execution and end-to-end memory performance: NOT RUN.

The reference-only fixture passes do NOT prove Rust behavior: no Rust binary
was available in the authoring environment. The Rust toolchain and registry
were not available from this machine. An actual binary must pass all suites
before these opt-in integrations can be accepted.

## Onsite source acceptance entry point

```
pwsh -File native/windows/verify_rust_wave5.ps1
```

After reviewed Cargo.lock files are available, rerun using
`-RequireReviewedLocks`. The script builds the four new Rust crates, runs
unit/Clippy/release checks, compares three fixture suites against the genuine
Rust CLI, exercises the normal JS functions with Rust enabled and reruns the
memory retrieval regression. It does not install, restart or modify services.

Existing crates and service/supervisor integration have their own acceptance
requirements. This script is a source parity gate, not a deployment gate.

## Important limitations

- The major orchestration engine, hooks, providers, Kanzo authorization path,
  native Windows service lifecycle, Tencent backend, RepoQL's own binary,
  dashboard and browser UI remain different implementations. A complete
  Rust-only product has NOT been written.
- The opt-in adapter still uses Node to call a child Rust binary. It is an
  integration bridge, not an in-process Rust runtime or a performance claim.
- Native process startup per policy call may have a significant latency cost.
  Benchmark before making it the default.
- The existing trusted Kanzo `verifyTask` authorization must still run before
  `recoverBoundTask` can read the ledger. The native `task-links` command only
  performs read-only linked-unit selection, never cross-agent recovery.
- Cargo.lock generation, dependency provenance review and full native Windows
  compilation are outstanding. No compiled executable is included.
- The pinned Tencent source, overlay application and native backend tests are
  still separate from this Rust work.
- No installed service, GitHub repository, model routing or coordinator stage
  was changed. No memory records were written by this migration.
