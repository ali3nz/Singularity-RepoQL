# Milestone 29: Claude Code complete-source runtime-closure and rollback hardening

Release status: **SOURCE ONLY / BLOCKED**. Tests here execute on a Linux filesystem using isolated user homes and real extracted source ZIPs. These tests are not native Windows GUI, installer, service or Tencent/RepoQL acceptance.

## Implemented changes

1. The Windows Claude Code configurator now verifies the SHA256 of the complete direct ESM hook import closure: agent map, memory config loader, memory reconciliation, document policy, self-learning candidate evaluator, and Node document ingestion engine. It still verifies memory/doc hooks and all 17 agent definitions. An omitted or changed closure file fails before any settings writes.
2. Both actual variant 1 and variant 2 extracted archives are imported using Node ESM, and their real `memory-hook.mjs` and `doc-hook.mjs` modules are invoked in safe no-op scenarios before isolated configure/verify/rollback. This catches missing transitive imports, not merely missing source names.
3. Rollback refuses to remove the recovery journal/backup if previously existing user settings were deleted after configuration. That state requires manual reconciliation instead of silently losing the original settings.
4. Read-only post-install verification now requires actual installed agent files, regular Node and memory config files, and the exact expected executable/script/kind hook argument vector. It cannot mislabel missing files or modified arguments as healthy.
5. The preceding source milestone included OpenChamber's missing `doc-ingest-node.mjs` dependency in its transactional attach runtime. That repair is preserved.

## Executed regression evidence

- `python -m unittest discover -s native/windows -p 'test_*.py' -q`: **80 passed**.
- `python -m unittest discover -s dashboard -p 'test_*.py' -q`: **97 passed, 1 browser skipped**.
- `python -m unittest discover -s ghost/prompt-store -p 'test_*.py' -q`: **9 passed**.
- `node --test adapters/claude-code/*.test.mjs native/windows/configure_claude_code_windows.test.mjs scripts/attach-openchamber.test.mjs openchamber/plugins/runbook-nudge/runbook-nudge.test.mjs`: **151 passed**.
- Actual extracted option 1/2 installation integration and real Node hook imports: **2 subtests passed** (included in Windows Python suite).

## Native Windows / Codex acceptance remains mandatory

- Compile, format and test the Rust desktop bridge, authority, and supervisor. Verify Win32 named-pipe security, process containment and startup/rollback.
- Run actual Claude Code CLI and Desktop Code tab with the four configured hooks. Capture, resume, recall and document ingestion through real authenticated Tencent MemoryCore; verify RepoQL 1.7.18 indexing and connector ABI 1.
- Install complete Ghost and pinned Claude Office frontend/backend natively with the established server-side token-in-URL configuration (unchanged). Validate service restarts, token privacy and task/prompt events.
- Verify genuine usage data sourcing and native dashboard functions for each installation, including unknown quotas where authoritative data is unavailable.
- Inspect Windows ACLs, junctions/reparse points, correct Node.exe identity, file and registry provenance, and the effects of interruption or concurrent user settings edits.
- Require clean install, upgrade, rollback, reboot and uninstall on Windows, with no Docker, WSL or Ubuntu runtime. Zero free Claude workers must not block optional OpenChamber worker fallback.

**Nothing in this milestone certifies production parity or an executable public release.** No production configuration or GitHub main change was made.
