# Historical receipts and frozen manifests

Everything in this directory is **historical provenance**, captured before this handoff build.
It is not acceptance of the reconciled tree, the installer, the GUI, upgrade/rollback or any
live Windows run, and the frozen checksum files are not the current checksum authority.

- `SHA256SUMS` at the repository root is the current authority for this tree.
- `MANIFEST.json` points at that authority and at `MANIFEST-FILE-HASHES.json`.
- `SHA256SUMS.wave56.frozen` and `NATIVE_WINDOWS_SOURCE_MANIFEST.wave56.json` are the Wave56
  working-copy manifests. Both carry 37 known mismatches against their own tree because reviewed
  source changes were applied after they were frozen; they are kept to show what was frozen, not
  to verify the current tree.
- Each `*.json` receipt is wrapped with `_annotation.historical = true`,
  `not_current_acceptance = true`, the digest of the original private file and the list of
  sanitizing redactions applied. Raw secret values were never copied.

See `docs/RUST-REWRITE-HANDOFF.md` for the current state and what remains unverified.
