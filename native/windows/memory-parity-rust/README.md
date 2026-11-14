# Windows Singularity memory policy Rust ports

Status: SOURCE CANDIDATE ONLY. No native Windows service, orchestration stage, or existing JavaScript/Python module has been replaced. This is not an approved build or a tested Rust binary.

The migration is bounded to five existing, identifiable components:

| Rust module | Origin | What has been ported | Not yet ported |
|---|---|---|---|
| `authority.rs` | `native/windows/memory_authority_preflight.py` | JSON configuration, directory and symlink checks, same diagnostic result shape | Native Windows executable validation |
| `ranking.rs` | `harness/kit/lib/repoql-client.mjs` | `liveSourceOrder` canonical artifact demotion and exact filename ordering | RepoQL I/O and cache |
| `temporal.rs` | `harness/kit/lib/memory-temporal.mjs` | Temporal extraction, timestamp normalization, current/historical/belief queries | The JavaScript host integration |
| `tombstone.rs` | `harness/kit/lib/memory-tombstone.mjs` | Canonical claim values, rejection digests, scope and exact-value matching | Tombstone file/SSH reader and writes |
| `source_policy.rs` | `native/windows/windows_source_policy.py` and `scan_source_archive.py` | Variant exclusion and safe archive member predicates | ZIP integrity, manifests and SHA256 checks |
| `task_recovery.rs` | `memory/portable/task-recovery.mjs` | Bound ledger selection, post-authorization L1/L0 row filtering, budgets, chronological ordering | Kanzo verifier, Core transport, ledger file I/O |

## Security and correctness boundaries

- `task_recovery::recover_from_verified_snapshots` is a library function ONLY. The CLI intentionally does not expose it. The trusted Windows caller must verify Kanzo task authorization and supply a registered MemoryCore identity before collecting snapshots. A boolean flag inside a public CLI is not sufficient authorization.
- The existing V2 `tombstoneForSubject` retrieval check is intentionally not replicated: it can suppress a corrected claim on the basis of a different rejected value. Rust implements the established exact-value contract instead.
- The existing V2 `context-pack.mjs` historical lineage gating defect is not fixed by these ports. The live JavaScript path remains unchanged, so the V2 acceptance hold remains in force.
- Existing published source variants do not yet include this crate. It must be incorporated only after native compilation, regression tests and a new source manifest are generated.
- `chrono` timestamp parsing intentionally accepts ISO-8601/RFC3339 and date-only values. JavaScript `Date.parse` also accepts several non-ISO inputs. Differential tests must establish compatibility for real retained data before any switch.
- `task_recovery` currently truncates by Unicode scalar values rather than JavaScript UTF-16 code units. Non-BMP character equivalence must be proven before a runtime switch.

## Build and run, on a machine with Rust installed

```powershell
cargo test --manifest-path native/windows/memory-parity-rust/Cargo.toml
cargo clippy --manifest-path native/windows/memory-parity-rust/Cargo.toml --all-targets -- -D warnings
cargo build --release --manifest-path native/windows/memory-parity-rust/Cargo.toml
.\native\windows\memory-parity-rust\target\release\singularity-memory-parity.exe preflight --root C:\Singularity-RepoQL
```

The exact executable path above assumes Cargo's default target directory and a build invoked from inside the crate, which may differ depending on the build environment.

## Read-only JSON input commands

All commands other than `preflight` accept one JSON document on stdin and produce one JSON response:

- `rank`: `{ "query": "config.mjs", "results": [{ "uri": "local:///src/config.mjs", "score": 0.5 }] }`
- `temporal`: `{ "mode": "current", "now": "2026-11-12T00:00:00Z", "capsuleBody": "validFrom: 2026-01-01T00:00:00Z" }`
- `tombstone-check`: `{ "subject": "Renewal", "field": "period", "claim": "14 days", "tombstones": [] }`
- `task-links`: `{ "ledger": { "units": {} }, "taskId": "task-abcdef1234", "agent": "agent-alpha" }`

## Acceptance procedure

1. Confirm the baseline source revision and independently review the new Rust code.
2. Run `cargo fmt --check`, `cargo test`, `cargo clippy` and native Windows build with a real toolchain.
3. Differential-test outputs of Rust and JavaScript/Python on saved production-safe fixtures, covering malformed inputs, Unicode, numeric timestamps and historical mode.
4. Fix the two existing V2 retrieval defects in the authoritative implementation and rerun regressions.
5. Bind the Rust library through the existing trusted Windows agent surface only after passing the Kanzo and native MemoryCore tests. Do not change orchestration routing or service ownership just to adopt Rust.
6. Regenerate four official Windows source variants and their checksum manifests from the actual release source, then do native Windows acceptance.

No existing source files, services, GitHub repositories or Google Drive artifacts were modified by this candidate.

## Follow-on source wave

The next staged wave adds the pure `candidate_policy`, `lineage`,
`memory_impact` and `payload_budget` modules and an independent reference
fixture suite. See `PORTING_STATUS.md` for exact coverage, remaining boundaries,
validation commands and the existing V2 correctness defects. The added CLI
commands are `candidate-policy`, `lineage-filter`, `lineage-graph`,
`memory-impact`, `payload-budget` and `split-bytes`. They operate exclusively on
JSON snapshots supplied on stdin. The `task_recovery` authorization rule is
unchanged: the public CLI still cannot invoke task recovery against MemoryCore.


## Wave 7: bounded lesson capture CLI

`src/bin/memory-turn-capture.rs` is a full source port of
`scripts/memory_turn_capture.py`'s propose/confirm/status workflow, including
rolling 24-hour caps, atomic state writes, read-only RepoQL dedup preview,
UTF-8 input bounds, and pending/confirmed records. It DOES NOT capture directly
into RepoQL or create a new durable memory writer. It intentionally tightens
confirmation to a file inside this state's own pending folder.

The existing Python entrypoint delegates only when
`SINGULARITY_RUST_TURN_CAPTURE_BIN` names an existing absolute executable.
If Rust fails, it fails closed without attempting the Python command again.
No switch is enabled in source packages. Run the source oracle with:

```
python native/windows/memory-parity-rust/tests/differential_capture.py --repo .
```

After building with Cargo on Windows, run:

```
python native/windows/memory-parity-rust/tests/differential_capture.py --repo . --rust-cli native/windows/memory-parity-rust/target/release/singularity-memory-turn-capture.exe
```

The `memory-impact-files` CLI now rejects unreadable or oversized knowledge
sources rather than substituting an empty body, which would hide stale concepts.
This requires an actual compiled CLI negative test before production opt-in.

## Wave 8: deterministic conflict gate signals

`conflict_signals.rs` ports four pure calculations from
`harness/kit/lib/concept-conflict-gate.mjs`:

- `contradiction-signal`: ordered antonym and shared-subject check
- `numeric-divergence`: conservative same-skeleton changed-number signal
- `extract-invariant`: read the emitted **Invariant** section
- `parse-capsule`: parse the existing restricted frontmatter shape

The existing JavaScript conflict gate still owns review, provenance, Sol
escalation, tombstones, and promotion routing. Native selection remains opt-in
through `SINGULARITY_RUST_MEMORY_POLICY_BIN`; invalid native output fails closed.

Reference fixtures (no Rust executable required):

```text
python native/windows/memory-parity-rust/tests/differential_conflict.py --repo .
```

Native Rust differential after compilation:

```text
python native/windows/memory-parity-rust/tests/differential_conflict.py --repo . --rust-cli native/windows/memory-parity-rust/target/release/singularity-memory-parity.exe
```

The new source is not accepted until actual native Rust differential, the
lockfile provenance gate, and the full Windows memory workflow pass.


## Wave 9: reconciliation and synthesis source ports

`reconcile-missing` and `synthesis-validate` are side-effect-free CLI operations.
The existing MemoryCore HTTP and synthesis lineage owners continue to perform
all reads, writes, authorization and persistence verification. The JavaScript
call sites compare the Rust result with the incumbent policy on every opt-in
call and reject disagreement before changing state. See
`docs/WINDOWS_RUST_MEMORY_UPGRADE_WAVE9.md` for source and native gates.

## Wave 10: authenticated task history post-processing

`task-recovery-snapshot` is a **pure formatter**, not a task authorization API.
It accepts JSON snapshots, returns `{ "ok": true, "value": ... }`, and has no
Kanzo/MemoryCore credentials or network client. In the trusted
`memory/portable/task-recovery.mjs` caller, Kanzo ownership is independently
checked before the ledger is opened. The existing engine then queries both
MemoryCore layers with task-ID pushdown and filters every returned row.

When explicitly enabled via `SINGULARITY_RUST_MEMORY_POLICY_BIN`, the JavaScript
caller compares both Rust-selected task links and Rust-formatted references
against the independently computed JavaScript results. Mismatch, malformed
native output or an unavailable binary fails closed with no references. No
installed service is changed or enabled automatically.

Run `python native/windows/memory-parity-rust/tests/differential_task_recovery.py
--repo .` for synthetic JavaScript reference fixtures. On a compiled Windows
binary, supply `--rust-cli` pointing to `singularity-memory-parity.exe` to
run the actual native differential, including empty/unauthorized cases. Source
reference tests alone do not establish native parity or real Kanzo integration.


### Wave 13 Claude Code capture helpers

`hook-redact` and `hook-capture-id` provide bounded, pure redaction and
stable SHA256 identity generation. The existing Claude Code hook is the trusted
caller and compares native output with its JavaScript contract before any
MemoryCore write. See `native/windows/RUST_WAVE13_HANDOVER.md` and
`tests/differential_hook_capture.py`. Do not set the native opt-in switch on
installed services before native compilation, all differential tests and live
memory acceptance.

### Wave 14: Windows acceptance decisions

`delegated-identity` accepts an already selected five-role delegated roster,
identity map and optional parent identity and returns a shape-only validation
result. `doc-reconcile-action` classifies already collected documentation
readback issues. `repoql-doc-uri` encodes repository-relative document URIs
for RepoQL read and indexed-row queries. They perform no I/O, seeding, indexing, repair or privileged
identity lookup. The associated Windows JavaScript callers compute their own
reference result before accepting the native response. The binary must pass
`tests/differential_windows_acceptance.py --rust-cli ...` on native Windows
before the opt-in environment variable is configured.


## Parent-session memory routing (Wave 15 source)

`main-memory-state`, `main-memory-plan`, and `main-memory-uninstall` consume ONLY boolean routing facts;
no proxy URL, provider auth token, API key, settings document, helper path, or
private model name enters the Rust standard input. `adapters/claude-code/main-memory.mjs`
retains authoritative mutation, explicit provider-replacement consent, and
all authenticated network probing. When the native switch is enabled, a
Rust plan is returned only after full field-by-field comparison with the
JavaScript decision. A failure refuses the operation rather than falling back.

The production native selection switch MUST stay disabled until a compiled
binary passes `differential_main_proxy.py --repo . --rust-cli <binary>` and
actual native Windows acceptance. The fixture has 576 synthetic cases, including rollback receipt ownership.
These tests do not authorise automatic proxy replacement, memory capture or
provider credential changes.
