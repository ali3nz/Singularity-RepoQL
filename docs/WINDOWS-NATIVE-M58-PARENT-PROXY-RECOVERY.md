# Milestone 58: Crash-safe Claude parent proxy credential-temp recovery

Parent-session settings changes include a private token. A process crash between
writing the token-bearing settings temporary file and renaming it can leave an
orphaned file in the Claude configuration directory. M58 journals the exact
random temporary path **before** writing the file.

- A completed apply has no pending temp; verification treats a leftover temp
  as a failed configuration until reviewed.
- A receipt-owned rollback deletes the exact pending temp only when its path
  matches the journal's owned UUID suffix and its SHA-256 matches the expected
  post-apply settings bytes. A drifted file or foreign path is never deleted.
- An interrupted apply with original settings intact can be recovered without
  overwriting newer user settings. Existing M56 receipts without this new field
  remain readable; unknown orphan files from older crashes require operator
  review rather than unsafe wildcard deletion.
- The token is not emitted in output or stored in the receipt. The receipt
  stores the temp path and hashes only.

Focused Node tests cover normal apply/rollback, interrupted promotion,
leftover-temp detection, tampering, and unrelated-file preservation.

**SOURCE ONLY; RELEASE BLOCKED.** The Windows Code tab provider routing,
Tencent roundtrip, native ACL enforcement and fresh-session recall remain
unverified. Do not interpret cleanup as a memory acceptance success.
