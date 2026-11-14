# RUST-REWRITE-ACCEPTANCE — what the evidence proves

**This document is the boundary between "built" and "accepted".** Read it before quoting
any number from the receipts.

## 1. Evidence carried in this tree

All eight receipts are historical: they were produced in the private Wave56 working copy
before this reconciliation and are copied here wrapped with `_annotation.historical = true`
and `not_current_acceptance = true`. Each wrapper records the digest of the original file
and the redactions applied (Windows profile paths, POSIX home paths, machine/user SIDs,
e-mail addresses). Raw secret values were never copied.

Source: `docs/rust-rewrite-evidence/`.

| Receipt | What it recorded | Numbers | Limits recorded in the file |
|---|---|---|---|
| `native-build-verification.json` | locked Rust builds for every crate | 32 checks over 8 crates, `allPassed: true` | `fullGatePass: false`, `liveAcceptance: NOT_RUN`, `cutover: NOT_RUN` |
| `final-lock-provenance.json` | lockfile provenance gate | 8 crates, all `lockfileValid`, `readyForRustDependencyReview: true` | `nativeWindowsBuildVerified: false`, `publisherProvenanceVerified: false`, `releaseReady: false` |
| `listener-fix-v4-parity-result.json` | compiled listener parity against the reference gateway | 27 gateway cases total (26 reused, 1 fresh), 10 locality-guard tests, `exitCode: 0`, `compiledParity: PASS_COMPOSITE_ALL_27_GATEWAY_CASES` | `liveAcceptance: NOT_RUN`, `rollback: NOT_RUN`, `cutover: NOT_RUN`, `fullGatePass: false` |
| `gate1307-protocol-final.json` | capability-gate protocol fixture | 5 boolean protocol properties true, `modelRequests: 0` | fixture only, no live install |
| `gate1307-apply.json` | capability-gate hook install on the operator host | `onlyAppendedHooks: true`, `activeSessionsModified: false` | host-local install receipt, not product acceptance |
| `fleet-1266-assembly-result.json` | synchronized 10-binary assembly | 10 binaries, `runtimeModified: false`, `acceptedOnWindows: false` | assembly only |
| `fleet-1266-cutover-result.json` | dashboard listener cutover on the operator host | `dashboardCutover: true`, 4 HTTP checks, `rollback: not_needed`, listener PID recorded | `browserVisualVerified: false`, `claudeSettingsModified: false` |
| `fleet-1266-validation.json` | six focused validation rows | setup tests, hook transform, staging rollback, 10-binary replacement, live cutover, preservation | each row names its own log; these were the Wave56 host, not this tree |

### What they establish

- The eight crates build locked on the recorded host, and every crate has a reviewable
  `Cargo.lock`.
- The compiled dashboard listener matched the reference gateway across the 27 recorded
  cases.
- A prior Wave56 bundle was assembled and its listener cut over on the recorded host
  without changing Claude settings or other services.

### What they do **not** establish

- They are **not** acceptance of this reconciled tree. The tree changed after these receipts
  were frozen (that is why the frozen manifests carry 37 known mismatches).
- No installer, upgrade, uninstall, rollback, ACL, service or scheduled-task run is covered.
- No target-PC cutover, real identities, provider grants, production data migration or
  startup ordering is covered.
- No GUI, Office panel or browser/asset acceptance is covered.
- `releaseReady: false` in the lock receipt is deliberate and still true.

## 2. What this build actually verified

Focused package-integrity checks only (per assignment: no exhaustive product test run).
Results are recorded in `_delivery/DELIVERY.json` in the ZIP and summarised here:

| Check | Command | Result |
|---|---|---|
| Tree digests | `sha256sum -c SHA256SUMS` | see `DELIVERY.json` |
| File-hash map parity | `MANIFEST-FILE-HASHES.json` vs tree | see `DELIVERY.json` |
| Lock provenance | `python3 native/windows/check_rust_lock_provenance.py` | see `DELIVERY.json` |
| Crates and locks | inventory `crate_count`/`locks_present` | 8 / 8 |
| Secret boundary | high-confidence pattern scan with per-hit triage | see `DELIVERY.json` (`untriaged_count: 0`) |
| Source packaging | `build_source_variants.py --variant 2` + `scan_source_archive.py` | see `DELIVERY.json` |
| Rebuild from source | `cargo test --locked` per crate | **not run in this build environment** (no Rust toolchain); historical receipts only, see REPRODUCE §3 |

`DELIVERY.json` is the machine-readable truth for this build; do not restate these as
"tests passed" beyond the named commands.

## 3. Remaining acceptance (not run here)

Run these on a clean Windows x64 VM, then repeat on the target PC with real identities.

1. **Installer transaction and rollback first**
   `install_claude_complete.ps1 -Mode Plan` → `Stage` → `Verify` → `Configure` → `Verify`;
   then `RollbackStage` and confirm the previous stage is byte-identical.
2. **Dashboard backend** — `DashboardPlan`/`DashboardRegister`/`DashboardVerify` with and
   without `-UseRustDashboardListener`, `-UseRustDashboardRoutes`, `-UseRustUnifiedProxy`;
   authenticated loopback for `/`, account/status, features, health.
3. **Hooks, memory IO, capture** — Claude Code SessionStart/Stop, capture → extraction →
   promotion, rust capture CLI vs legacy oracle parity, single-writer behaviour.
4. **Orchestration and bot glue** — a bounded run, worker completion, state lock, OpenMaus
   bot lifecycle.
5. **Native activation and interpreter removal** — capability gate records what is still
   required; only then test removal of Node/Python on a disposable VM.
6. **One focused native release acceptance** — a single end-to-end pass on the target
   machine: install, upgrade, uninstall, rollback, data preserved, services/tasks owned and
   removed, receipts correlate. This is the gate that turns "source handoff" into "release".

Do not run step 5 before steps 1-4 pass; do not claim step 6 from source-level checks.

## 4. Explicit non-claims

- Source-only: `SOURCE_ONLY_NOT_RELEASE_READY` still applies to the native Windows profile.
- The ZIP is not an installer and contains no compiled binary.
- No claim is made about Claude Code, RepoQL, Kanzo, Tencent MemoryCore, Claude Office or
  any provider account behaviour beyond the pins listed in
  [RUST-REWRITE-HANDOFF.md](RUST-REWRITE-HANDOFF.md).
