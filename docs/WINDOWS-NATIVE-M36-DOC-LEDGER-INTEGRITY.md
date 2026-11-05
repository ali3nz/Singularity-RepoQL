# Milestone 36: Fail-closed documentation ledger recovery

Release status: SOURCE ONLY, BLOCKED. This checkpoint does not certify a native Windows service or Claude Desktop Code-tab integration.

## Defect verified in Milestone 35 source

Both `scripts/doc-ingest-node.mjs` (used by native Claude Code hooks) and `scripts/memory-doc-ingest.py` treated malformed JSON in the existing `data/doc-index/ledger.json` as an empty ledger during a write. A subsequent ingest could replace the damaged file with an empty revision inventory, severing the local record of previously verified, active, and superseded documentation revisions. The Node read-only path also silently returned an empty ledger. Neither behavior is an acceptable repair policy for durable memory.

## Changes

- Both engines reject malformed JSON and unsupported ledger schema/shape with `DOC_LEDGER_CORRUPT`; a nonexistent ledger is still initialized for a first install.
- Writers refuse the operation before MemoryCore writes and before ledger replacement. The existing ledger bytes remain available for forensic recovery. A failed lock-protected Python write releases its owner lock; Node also releases its lock on refusal.
- A dedicated fast Python corruption regression is included in the Windows CI workflow. The Node test covers the same invalid inputs, preservation, recovery, and zero gateway calls during refusal.
- This intentionally does **not** auto-repair, auto-delete, or re-create damaged history. Restore a verified backup or reconstruct the ledger from independently verified MemoryCore state with an explicit operator review. Never replace an unknown ledger merely to clear the error.

## Test evidence and limits

- Node native Claude/Windows configuration/document suites: 165 passed, 0 failed.
- Focused Node document suite: 15 passed.
- Python Windows source suite: 82 passed.
- Python dedicated corruption test: 1 passed. Existing cross-language lock tests: 3 passed.
- Existing Python documentation integration suite and combined Node parity run exceeded their runtime limits. Individual Python corruption case passed; three cross-language Node parity tests had passed before the combined run timed out. The combined runs are INCOMPLETE, not green.
- Windows service and GUI testing, Rust compilation, RepoQL 1.7.18, persistent Tencent service behavior and dual independent document index readbacks: NOT RUN.

## Release next steps

1. Reproduce a clean Windows install of Option 2 with approved official RepoQL plugin skills, pinned binary, ten Singularity skills, and seventeen Claude agent definitions.
2. Create, edit, and supersede the same hub document; independently read back the exact current revision from real Tencent MemoryCore and RepoQL, from a fresh Claude Desktop Code-tab session.
3. Test restart, failed ingestion and recovery; then test live agent profile seeding, session recall, Ghost isolation, Office and dashboard lifecycle.
4. Keep release BLOCKED until independent runtime receipts establish the above. Source tests do not substitute for Windows acceptance.
