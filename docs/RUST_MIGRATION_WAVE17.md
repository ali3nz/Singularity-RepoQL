# Windows Singularity Rust migration: Wave 17

Status: **SOURCE CANDIDATE. NOT COMPILED. NOT A WINDOWS INSTALLER.**

## Implemented in source

The existing `singularity-memory-parity` executable has three new bounded
commands in `document_learning.rs`, plus strict JavaScript parity adapters:

1. `doc-policy-classify` classifies material versus skipped workspace files and
   reports whether the selection is documentation-only. Existing node:path
   platform behavior, runtime-state exclusions, and path order are preserved.
2. `doc-root-entries` splits configured documentation roots using Windows `;`
   or POSIX `:` while preserving Windows volume letters.
3. `selflearn-candidate-id` derives the durable eight-character SHA256
   identifier from a session and a de-duplicated, UTF-16-sorted file set.
4. `selflearn-validate-lesson` verifies the strict model lesson schema,
   evidence reference membership, allowed categories, and UTF-16 string sizes.
   A rejected lesson is a valid policy verdict, not a process transport error.

The shared OpenChamber runtime ships a sibling `scripts/document-learning-rust.mjs`
transport with the policy scripts. It cannot rely on importing the repository's
`harness/kit` folder after installation. Attach and Claude package closure
checks verify this module is present. The transport is a narrow, standalone
four-command interface, not a new orchestrator or memory owner.

The production JavaScript boundaries use the Rust result **only** with
`SINGULARITY_RUST_MEMORY_POLICY_BIN` explicitly set to the compiled binary,
and only after it exactly matches the JavaScript reference result. Invalid or
unavailable Rust results block the operation without fallback. With the switch
unset, the original behavior is unchanged. The Rust process does not call
MemoryCore, RepoQL, Kanzo, a model, or a filesystem writer.

Additionally, `isEligibleDocPath` now uses a path-component containment test,
instead of a string prefix. A sibling directory with a matching name prefix
cannot be accepted as a workspace-owned document.

## Validation performed on this source

- `node --test tests/doc-policy.test.mjs tests/selflearn-candidates.test.mjs tests/rust-document-learning-boundary.test.mjs`
- `python native/windows/memory-parity-rust/tests/differential_document_learning.py --repo .`
- OpenChamber installed-runtime loader, attach rollback, Claude hook, and
  Windows source closure regressions.
- Focused memory retrieval and Windows source contract regressions.

Source reference tests are **not** compiled Rust parity. The 950 synthetic
JavaScript cases include path exclusions, native Windows root delimiters,
Unicode candidate IDs, invalid model lessons, and evidence mismatches.

## Native validation and cutover

In an isolated native Windows engineering checkout with reviewed Cargo locks:

```powershell
pwsh -File .\native\windows\verify_rust_upgrade.ps1 -Native
```

The native gate compiles all eight source crates and executes the JavaScript to
Rust differential scripts, including `differential_document_learning.py`,
with the actual `singularity-memory-parity.exe`. Its success is **not** live
agent acceptance and does not deploy anything.

The candidate remains release-blocked pending four reviewed Cargo.lock files,
compiled Rust differential parity, pinned Tencent MemoryCore backend evidence,
Kanzo authorization evidence, native agent-memory behavior, installer replacement,
and isolated upgrade/rollback acceptance. Do not enable the native opt-in switch
on an installed Windows service before those checks pass.

The source still contains JavaScript and Python. This wave does not replace the
orchestration coordinator or the current memory storage and document ledger.
