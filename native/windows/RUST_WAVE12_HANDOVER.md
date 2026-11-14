# Windows Singularity Rust Wave 12: active compatibility paths

Date: 2026-11-12. Based on the Windows V2 / Rust Wave 11 source candidate.
Status: SOURCE CANDIDATE ONLY. No production deployment or Rust build is certified.

## Implemented

- Reused the existing `orchestra-observer` Rust compatibility operations for `worker.decision`, `run_summary.build` and `gate.parse` (V2 only). The existing JavaScript entry points now support an explicit, optional native implementation.
- Added the read-only `run_health.derive` Rust policy to the existing `harness/rust-authority` crate and exposed it through its established `compat` interface.
- Added a single bounded child-process bridge `harness/kit/lib/rust-compat-policy.mjs`, selected by `SINGULARITY_RUST_COMPAT_BIN`, which must contain an absolute path to an executable.
- Every enabled native result is compared with a separately calculated JavaScript result. A mismatch, invalid path, process failure, timeout or malformed JSON throws a typed error without accepting native output or silently falling back. Without the variable, the original JavaScript behavior is unchanged.
- Run health file reads, legacy gate parsing, worker completion parsing, run summary file writing, coordinator workflow stages, authority, routing, Kanzo identity and MemoryCore ownership are unchanged.
- Added 100 JavaScript-generated run-health reference cases to the existing Rust authority golden fixtures (904 total), a source reference verification test and native transport failure tests.
- Extended the Windows `verify_rust_upgrade.ps1 -Native` path to compare those fixtures against the *compiled* Rust authority executable. Added an independent Windows CI job so missing Cargo locks in other crates do not suppress validation of the already locked authority crate. The global release gate still requires all eight lockfiles.

## Local verification

- `node --test harness/kit/tests/*.test.mjs harness/kit/lib/windows-portability.test.mjs memory/portable/task-recovery.test.mjs`: 84 passed, 1 skipped, 0 failed.
- `node harness/kit/v46-memory-retrieval-truth-test.mjs`: 43 passed, 0 failed.
- `node --test harness/rust-authority/tests/*.test.mjs`: 34 passed, 0 failed.
- Three Windows Node component suites: 30 passed, 0 failed.
- Selected Windows Python suites: 27 passed, 0 failed.
- RC stack Python suite: 11 passed, 0 failed.
- New Rust compat bridge and run-health oracle: 8 passed, 0 failed (already included in the focused Node coverage above; not a separate total).

All Rust build and cross-language assertions are **NOT RUN**, because the available environment has neither Cargo nor rustc. JS fixture passes are not proof of Rust parity.

## Native Windows engineering gate

In a fresh isolated source checkout, before enabling any runtime setting:

```powershell
pwsh -File .\native\windows\prepare_rust_locks.ps1 -GenerateMissing
pwsh -File .\native\windows\verify_rust_upgrade.ps1 -Native
```

The first script changes the isolated checkout by generating missing dependency lockfiles and still requires review. The second script must compile all eight Rust crates, run the full memory parity tests, and compare all 904 authority golden cases with a compiled `orchestra-observer.exe`. No production setting should be enabled if it fails.

Only after native tests and operator approval, in an isolated test session, optionally select the compiled binary:

```powershell
$env:SINGULARITY_RUST_COMPAT_BIN = (Resolve-Path .\harness\rust-authority\target\release\orchestra-observer.exe).Path
```

To return to the existing reference path in that session:

```powershell
Remove-Item Env:SINGULARITY_RUST_COMPAT_BIN
```

This environment variable alone does not install a service or migrate any memory data.

## Unresolved acceptance blockers

1. Rust compilation, linting, compiled differential parity and lockfile review.
2. Pinned Tencent MemoryCore source overlay application, backend tests and native Windows readback.
3. Kanzo's actual trusted authorization integration and registered agent identity for task recovery.
4. Windows native memory authority, live agent recall tests, service upgrade, installer packaging and rollback acceptance.
5. Remaining orchestration, dashboard, provider and Windows integration modules in JavaScript/Python. These have not been replaced by this wave.

No GitHub commit, Drive file or live Windows service was changed by this local source work.
