# Milestone 74 — resumable parent-session proxy settings restore (source only)

The parent-memory proxy's `rollbackParentProxy` previously wrote a new `settings.json.singularity-parent-restore-<uuid>` without recording its path. A crash after writing that file could leave a private settings backup outside the receipt-owned recovery scope.

The rollback now writes an owner-validated restore path into the receipt *before* writing any restore bytes. It validates the exact temporary file against the original settings SHA-256, refuses changed or symlinked files, and resumes rollback whether the temp is absent, already written, or its rename has already completed. The read-only verifier reports `PARENT_PROXY_ROLLBACK_IN_PROGRESS` when a restore journal exists, rather than claiming a fully installed proxy. This does not overwrite user settings that drift after the attempt.

Targeted Node tests passed (14, including three new interrupted/tampered restore cases). The source archive scanner and release audit pass with release approval blocked. No actual Windows Claude Desktop provider acceptance, authenticated Tencent recall, or full regression run was performed.
