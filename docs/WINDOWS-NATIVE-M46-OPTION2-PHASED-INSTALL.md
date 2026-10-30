# M46 — Native Claude Code Complete phased installation (source only)

This is an **operator-gated Windows orchestration tool**, not a certified installer. It joins existing tested components rather than bypassing their preflight, ownership and rollback rules. It requires the real native Windows acceptance candidate built by CI. No compiled EXE, Windows service, GUI test or credential is included in this source checkpoint.

## Phases

`native/windows/install_claude_complete.ps1` has six modes:

| Mode | Mutates? | What happens |
| --- | --- | --- |
| `Plan` (default) | No | Independently verifies the prepared candidate, checks native inputs, previews staging and Claude/Kanzo configuration |
| `Stage -Apply` | Yes | Stages two already-built binaries and verified source using `stage-native.ps1` |
| `Configure -Apply` | Yes | Rechecks every staged source SHA-256, plans then applies Claude settings/agents/skills and Kanzo project MCP; separate owned receipts |
| `Verify` | No | Checks staged contents and Claude configuration; verifies owned Kanzo MCP registration and its rollback journal, **not** live MCP traffic |
| `SupervisorPlan` | No | Validate supplied supervisor configuration and preview exact per-user scheduled-task registration |
| `RegisterSupervisor -Apply` | Yes | Delegate safe per-user logon registration to the existing task registrar; requires staged binary and owner-approved private config |
| `RemoveSupervisor -Apply` | Yes | Remove only the matched owned task; refuse altered or running tasks, without needing the original bundle |
| `RollbackConfig -Apply` | Yes | Rolls back owned Kanzo project MCP changes then Claude changes, refusing foreign changes |
| `RetireStage -Apply` | Yes | Preserve intact first-time staging in `held-retired`; only when there are no owned Claude/MCP receipts or supervisor task and no previous upgrade snapshot |
| `RestoreRetired -Apply` | Yes | Restore the verified, unchanged `held-retired` snapshot only when no active staging exists |
| `RollbackStage -Apply` | Yes | Restores prior staged snapshot, preserving the displaced current staging as held files |

Supervisor actions additionally require `-SupervisorConfig` pointing to a private user-controlled JSON file under LocalAppData/Singularity, with protected ACLs. The registrar invokes the Rust supervisor in `check` mode but registration does not prove process health. Stage rollback refuses to run if the named supervisor task is still present.

Execution requires native Windows PowerShell 5.1, Python 3, Node, a reviewed acceptance bundle and separately reviewed bootstrap files. Nothing downloads or executes installers, uses WSL/Docker/CLI instead of the Claude Desktop Code tab, or provisions secrets. Prep must have completed into a new user-private `%LOCALAPPDATA%/Singularity/WindowsNativePreview` child directory. Caller supplies absolute paths to `-Bundle`, `-Prepared`, `-Bootstrap`, `-PythonExe`, `-NodeExe`, `-RepoqlExe`, `-ClaudeExe`, `-KanzoExe`, `-MemoryConfig`, `-OfficeConfig`, `-ClaudeHome`, `-Workspace`. See script parameters for `-InstallRoot`. Supply flags with `-Mode Plan`, then repeat with `Stage -Apply` and `Configure -Apply` **only after review/backup and explicit consent**.

The `-Bootstrap` directory must be extracted from the original reviewed candidate; its verification helpers must exactly match the prepared source. Both the original bundle and prepared candidate are rechecked before stage/configure. Neither the bundle manifest nor hash equality establishes a trusted software publisher. Stage refuses old snapshots it cannot safely retain. Configuration uses its own transactional receipts but **the whole multi-component process is not atomic**. A partial configuration failure must be investigated before invoking the scoped rollback mode. RollbackConfig checks each owned receipt independently so it can recover after only one configurator completed. RollbackStage refuses when either configuration receipt exists. For first-time staging with no `previous` snapshot, `RetireStage` and `RestoreRetired` provide an opt-in reversible preserve/move path. Both refuse active task/configuration dependencies, unexpected staged files, altered checksums or an existing conflicting snapshot. They never delete application files. A failed or interrupted move requires operator recovery. Never run these mutation modes against a production profile before Windows staging tests, backup, and approved rollback.

**No automatic task registration, service start, plugin marketplace acceptance, Tencent profile seeding, RepoQL indexing or Office/Ghost launch is performed.** Successful source staging or settings configuration does not satisfy any runtime acceptance gate. Official RepoQL plugin owns RepoQL MCP; Kanzo is the only project MCP owned by this product variant. RepoQL 1.7.18 and ABI 1 remain pinned. All 17 agents, 10 product skills, 17 official RepoQL skills, delegated and parent Tencent memory, Ghost isolation and live Office event roundtrips require Windows evidence.

## Verification status

The accompanying tests are fast source-contract tests only; no PowerShell runtime or native GUI was accessible here. `releaseReady:false` is mandatory. Full Windows CI, integration regression and actual installer lifecycle must be run later, before Codex declares release acceptance.
