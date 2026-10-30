# Milestone 71 — resumable unchanged-settings Claude rollback

The Claude Code Complete settings installer restores a user’s exact original
settings file when it has not changed since installation. Prior to M71, this
branch used an untracked temporary file during restore. A crash could strand a
credential-bearing settings copy outside the ownership receipt.

M71 records an exact `rollbackRestore` entry before writing, with the installed
SHA-256, original SHA-256 and a UUID-named temp path. Recovery validates the
journal, retained backup, current settings and temp hashes. It can safely resume
before or after rename; it refuses foreign changes and modified temps. It does
not print credentials or guess file ownership. M70 also preserved a distinct
journal for the user-edited merge rollback branch.

The README handover no longer pins the obsolete M43 source ZIP: operators must
choose the latest verified complete-source checkpoint and check its receipt.

Focused Node tests only. Rust compilation and native Claude Code runtime were
not performed. Release status: **BLOCKED**.
