# Wave 18 Windows engineering handover

Status: SOURCE ONLY, native compilation NOT_RUN, production release BLOCKED.

## Compile and verify on isolated native Windows

1. Confirm the source ZIP SHA256 against the accompanying manifest.
2. Generate the four missing lockfiles in the isolated checkout and review all
   resolved packages, sources and checksums before native verification.
3. Run `pwsh -File .\native\windows\verify_rust_upgrade.ps1 -Native`.
4. Specifically inspect `differential_upgrade_acceptance.py` results with the
   compiled `singularity-release-evidence.exe`. The 649 scenarios cover blocked
   states as valid plans, not success approvals.
5. Verify the native Windows acceptance matrix with real, independently
   reviewed receipts. Do not mark `REPORTED_PASS_UNREVIEWED` as a verified gate.
6. Verify authenticated dashboard, RepoQL connector ownership and pinned version,
   Kanzo task claim and closeout, Tencent delegated and parent memory,
   current truth/tombstones, upgrading and rollback in the onsite test plan.

No source-only gate authorizes a cutover. Do not enable the two Rust release
policy commands on an installed service before compiled and live acceptance.

The new policy binary setting is `SINGULARITY_RUST_RELEASE_EVIDENCE_BIN`.
It is intentionally separate from the memory policy binary setting.
A missing, symlinked, reparse-ancestor or mismatched native binary blocks a
selected operation rather than falling back.
