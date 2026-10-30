# Milestone 13 — Native Windows IPC deadline and rollback follow-up

Changes: four-worker, overlapped Win32 named-pipe authority with bounded request/read/write and cancellation draining; bounded response-read grace; new stalled-client Windows acceptance test; transactional stage rollback preserving active files under `held-current`.

The intended Windows release still uses native GUI applications and **no WSL**, RepoQL **1.7.15** (connector ABI 1) and the established Claude Office token URL default for complete options 2 and 4. No changes to production or GitHub main.

Detailed evidence and blockers: `docs/WINDOWS-NATIVE-M13-RELEASE-GATE.md`. **Source-only, no Windows Rust binary and not an installer.**
