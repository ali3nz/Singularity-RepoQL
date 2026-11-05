# Milestone 70 — resumable Claude Code settings merge rollback

When the user edits Claude settings after installation, rollback removes only the installer-owned hooks/plugin environment and preserves unrelated edits. Previously, a crash after rewriting the cleaned settings but before owned-file cleanup left a journal whose RepoQL plugin ownership check could no longer pass.

A receipt-owned `rollbackMerge` now stores the exact SHA-256 of the user-edited input, expected cleaned output, and a UUID-named temporary file **before** writing settings. A retry either resumes from verified temp contents or recognizes the already-completed merge. Newer/foreign changes, ambiguous temps or hash mismatches fail closed. The final receipt is removed only after remaining owned-file cleanup. No raw settings/secrets are placed in test receipts.

Focused tests: 43 Node tests pass, including explicit crash resume and tampered temp refusal. Native Windows Code-tab behavior, file locking and live plugin usage remain untested. Release BLOCKED.
