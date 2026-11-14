# Windows Singularity Rust migration, Wave 16

Status: SOURCE CANDIDATE ONLY. Rust compilation, executable parity and native Windows acceptance are NOT_RUN.

## Memory promotion governance

`native/windows/memory-parity-rust/src/promotion.rs` adds three pure commands to the existing memory policy CLI:

* `promotion-shortlist`: selects up to 12 indices within the 4,000-character budget, preserving the incoming record order.
* `promotion-advance`: evaluates cursor progression against retained review entries and deferred records.
* `promotion-eligibility`: enforces the three-per-day promotion cap and the seven-day named concept repeat rule.

`scripts/memory_promote.py` calls them only when `SINGULARITY_RUST_MEMORY_POLICY_BIN` is explicitly set to an absolute executable file. Before any state mutation, it computes the same decision independently using Python and rejects absent, malformed or divergent native replies. With the switch unset, Python continues to own execution. This does not change the original Kanzo, RepoQL, Tencent or orchestration ownership boundaries.

No authentication headers, MemoryCore endpoint, stored credentials or candidate excerpts are sent to the Rust subprocess. The subprocess receives sanitized IDs, timestamps, excerpt lengths and boolean text-presence flags only. Network requests, output display, cursor storage and promotion execution remain in Python.

## Resolved cursor integrity defects

The prior `--advance-ts` path blocked deferred entries but did **not** block other unresolved shortlisted records. This could silently leave records behind. The new decision refuses cursor movement without a presented shortlist, beyond the maximum presented timestamp, or past any unresolved/deferred record.

`pendingReview` retains record IDs and timestamps across repeated scans, including eligible records that arrived in the same queried page but were hidden by the display budget. `--mark-done` permits release of reviewed entries. Confirmed cursor progress prunes only entries already at/below the accepted cursor. The review ledger is capped at 2,048 IDs; exceeding it refuses the write instead of evicting history.

`save_cursor` now writes to a temporary file on the same filesystem, flushes and fsyncs it, and atomically replaces the saved cursor. A failed replace leaves the previously committed state intact. The scanner still assumes a single agent writer per workspace. No concurrent writer locking was added.

Source rows lacking a stable ID, positive timestamp or nonblank content cannot participate in a timestamp-based shortlist. The raw `--probe` display is retained for diagnosing unsupported MemoryCore response shapes.

## Evidence available in this environment

* `python tests/test-memory-promote.py`
* `python tests/test-memory-promote-rust.py`
* `python native/windows/memory-parity-rust/tests/differential_promotion.py --repo .`
* `python native/windows/verify_source_release.py`
* `node harness/kit/v46-memory-retrieval-truth-test.mjs`

The differential runner generates 600 deterministic reference cases. Without `--rust-cli`, this tests the Python oracle and sanitized protocol only and does not validate the Rust implementation. The Windows native gate and CI workflow invoke the same script with the compiled binary.

## Known limitations, not waived

* Rust/Cargo are unavailable here; four newer Rust crates still lack reviewed dependency lockfiles. These are release blockers.
* The promotion scanner still makes one bounded MemoryCore listing request per run. Its cursor cannot prove coverage of records outside that page without a complete ordering/pagination guarantee. Avoid asserting global exhaustive promotion coverage.
* The legacy Python scanner, JavaScript coordinator, dashboard, connectors and Windows service/installer runtime still exist. This is NOT a complete Rust rewrite.
* Tencent pinned source/backend tests, live Kanzo authorization, actual MemoryCore read/write acceptance, native Windows build, upgrade and rollback have not been run here.
* Legacy bootstrappers remain historical source assets; they are not Rust upgrade executables.

On an isolated Windows engineering checkout, after reviewing generated Cargo locks:

```powershell
pwsh -File .\native\windows\prepare_rust_locks.ps1 -GenerateMissing
pwsh -File .\native\windows\verify_rust_upgrade.ps1 -Native
```

These checks do not install, restart or mutate production services. Do not enable the native switch until compiled parity and real Windows memory acceptance have passed.
