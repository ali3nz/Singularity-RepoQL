# Windows Rust memory upgrade, Wave 47

The Python and Node documentation ingesters can cross-check single-file status
and retry ledger lookup through the opt-in `doc-index-locate` Rust command.
The command receives two booleans per ledger row and whether a root was pinned.
It returns an ordinal or null. Without a root pin, multiple matches remain
ambiguous. With a pin, the first matching row for that root remains authoritative
in ledger order. Path equality, path containment, root authorization, original
records, locks, writes, and MemoryCore traffic stay with the existing owners.

`SINGULARITY_DOC_RUST_BIN` remains unset by default. If explicitly enabled,
an unavailable or divergent process blocks the request before retry writes.
The existing command-specific input and process bounds apply. All-file operations
and the independent verification path are unchanged.

The Windows upgrade script and workflow now require both documentation host
suites against a compiled Rust policy using a disposable HTTP stub and ledger.
The standalone differential also exercises the new locator, rejects malformed
input, and uses the actual synthetic-ID retrieval wire shape.

## What remains before production

1. In an isolated native Windows checkout, use
   `pwsh -File native/windows/prepare_rust_locks.ps1 -GenerateMissing`.
   Review the four generated resolutions for dependency source, versions,
   checksums and licenses. No lock was hand-authored here.
2. Run `pwsh -File native/windows/verify_rust_upgrade.ps1 -Native`.
   Compiled parity and stub tests are not service acceptance.
3. Back up the existing Windows installation and memory state. On a Windows
   test installation capture upgrade and rollback receipts, confirm real
   documentation indexing/search, role isolation, preserved current revision,
   and ledger recovery. Keep opt-ins disabled until these checks pass.

This is a source-only Windows profile 2 candidate, not an installer or release.
No Dockerhost or installed Windows state changed.
