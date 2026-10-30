# Milestone 27: Claude Code native Windows hook/agent configuration

Status: **source-tested, native Windows runtime UNVERIFIED**. This component
configures Claude Code only. It does **not** install or run Singularity's
Tencent MemoryCore, RepoQL 1.7.18, Rust services, dashboard, Ghost or Office;
there is no completed native Windows product release.

## Source change

`native/windows/configure_claude_code_windows.mjs` is a narrowly scoped,
explicit, Windows-only *write* path for options **1 and 2**. Its pure filesystem
functions are tested on Linux using isolated fixture directories, but the CLI
refuses `apply` and `rollback` outside Windows.

- Require already verified staging source manifest matching the selected
  Claude GUI option, 1.7.18, and the corresponding Ghost/Office feature flags.
  Validate SHA256 for the **two** shared hook scripts (`memory-hook.mjs`
  and `doc-hook.mjs`), configured through four events. It additionally validates and copies all
  **17** agent definitions and the six shared ESM import dependencies against manifest hashes.
- Require a regular-file `node.exe` path and a regular-file, pre-existing
  MemoryCore configuration file. This checks filesystem type/name, **not** the
  executable's signature or whether the MemoryCore configuration works. Do not
  fabricate defaults or read/print credentials.
- Preserve unrelated settings, hooks, agent files and user environment values.
  Refuse malformed hook-event/group structures instead of overwriting them,
  an existing Singularity hook limited by a foreign matcher, a conflicting
  Singularity-named agent, or a conflicting memory path.
- Put always-on hooks into a matcher-free group; foreign event matchers do not
  restrict Singularity's hooks.
- Maintain a durable before-change journal and a backup of existing settings.
  Rollback deletes only newly created, unchanged agents and removes the owned
  hooks/paths. If the user edits settings after the install, merge-removal
  preserves unrelated edits. If an owned agent changes, rollback refuses to
  erase it; the operator must reconcile it manually.
- Source path and target ancestor symlink checks use Node's `lstat`.
  Windows junction/reparse-point behavior and NTFS ACLs still require live
  validation. Do not claim Win32 path containment from Linux tests alone.
- `verify` is read-only: checks local config wiring, not service availability.
  Successful verification explicitly returns `runtimeVerified:false`.

## Example isolated Windows invocation (NOT executed here)

The paths below are examples; use actual verified installed paths and an
isolated Windows test account first. **Do not apply on the production host.**

```powershell
node native/windows/configure_claude_code_windows.mjs --mode plan `
  --variant 2 `
  --source 'C:\Users\Example\AppData\Local\Singularity\current\source' `
  --home 'C:\Users\Example' `
  --node-exe 'C:\Program Files\nodejs\node.exe' `
  --memory-config 'C:\Users\Example\AppData\Local\Singularity\data\memory.json' `
  --office-config 'C:\Users\Example\AppData\Local\Singularity\data\office.json'
```

For Option 2, `office.json` must be a protected JSON object with an `endpoint` URL and a nonempty `ingestKey`. The installer validates the shape without making a network call and sets `OFFICE_CONFIG` in Claude settings. It registers seven Office event hooks alongside the four memory/documentation hooks, preserving unrelated hooks. Office itself must be independently installed and accepted; configuration does not prove a working event connection. Option 1 does not require this file.

After independently verifying the plan, user scope, package trust, NTFS ACLs,
Node path and MemoryCore configuration, the same command with `--mode apply
--apply` performs the bounded settings/agent change. `--mode verify --home
'C:\Users\Example'` checks the configured files. `--mode rollback --apply
--home 'C:\Users\Example'` undoes unmodified owned files; the receipt remains
if manual recovery is required.

The `.claude/.singularity-native-claude-journal.json` contains **paths and
hashes**, not credentials. The settings backup may contain **secrets** and must
remain protected by the user account's NTFS ACLs. The journal/backup should
not be committed, uploaded or printed in logs.

## Windows/Codex release acceptance

1. Compile/bundle Node runtime from a trusted installer; validate actual
   script execution from Claude Code CLI **and** the intended Desktop Code tab.
2. Run install, reinstall refusal, verify and rollback under a disposable user,
   including one existing foreign hook and agent and a settings file with
   secret values. Verify original bytes after rollback, log redaction, ACLs
   and symlink/junction resistance.
3. Trigger each of the four hooks in a real Claude session, confirm MemoryCore
   identities, capture and recall. Verify 17 agents in both intended GUI
   surfaces, with zero available Claude background workers.
4. Test interrupted installation and external edits while the journal exists;
   never suppress manual recovery or delete conflicting user files.
5. Complete Office pinned native frontend/backend, Ghost agent backend,
   dashboard and RepoQL/MCP integrations, service lifecycle, signing and full
   no-Docker/no-WSL product installation. Those remain blockers.

No changes have been made to production, local Claude settings or GitHub main.

### Conservative rollback for pre-existing hooks

If matching Singularity hooks existed before installation **and** Claude settings changed after installation, rollback refuses with `PREEXISTING_HOOKS_REQUIRE_MANUAL_MERGE`. This prevents deleting an earlier working hook when performing generic ownership removal. The settings, backup and journal remain unchanged for an explicit three-way resolution. An unchanged post-install settings file can still be restored exactly from its backup.

### Milestone 29 follow-up

Verification now requires every agent file to exist and validates the exact hook
argument vector, Node executable type and MemoryCore configuration type.
An aborted rollback where the pre-install user settings backup exists but the
current settings file is missing retains the backup and journal and requires
manual reconciliation. The extracted option 1/2 source archives must also
load both real hook modules through Node and exercise safe no-op calls.
See `docs/WINDOWS-NATIVE-M29-CLAUDE-RELEASE-HARDENING.md`.
