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

## Optional Rust Windows setup frontend

The acceptance bundle can include `singularity-windows-setup.exe`. This is a
native dialog frontend for the existing receipt owned phased scripts. It is
not the historical GUI, a bundled dependency installer, or a production
release. The existing drivers still verify the candidate, stage ownership,
configuration and rollback preconditions.

Create a private JSON request with schema `singularity-windows-setup/v1`,
an exact phase name, and `driverRoot` set to the reviewed source tree root.
The input names are the corresponding existing PowerShell names in lower
camel case. Paths must be absolute and local. Do not put credentials in the
JSON. Use configuration file paths, not their contents. Run the GUI
executable with `--request` followed by the absolute JSON path. The prompt
defaults to No and launches only the selected phase. For the full preview
report or diagnostics, use the existing PowerShell driver directly.
`--validate-request` checks the typed request and driver path without
displaying a dialog or running any script.

To try the optional compiled dashboard listener, register the owned dashboard
task with `-UseRustDashboardListener`. Rust owns the public loopback socket,
in memory session expiry and revocation, scrypt password derivation and
verification, the bounded static file read, and constant time comparison of hashed
automation bearer values. Existing local account hashes
remain compatible. Python still owns the account file, rate limits, cookies,
origin checks, page authorization, HTML injection, API routes, proxies and
mutations behind the private loopback stream. Removing the owned task and
registering without the flag restores the previous listener without deleting
state. In native listener mode, Rust owns account file creation,
credential verification and reading and writing the persisted login mode.
Existing v1 account files remain compatible with the Python listener.
Account creation publishes the complete record without overwriting an
existing file and requires a local filesystem that supports hard links.
The current private dashboard ACL remains the Windows permissions boundary.
If a native account or mode write has an unknown outcome, session control
stays closed until the service is restarted and reloads the persisted mode.
Python still owns the browser cookie, session issuance policy and throttle.

Rust also produces the JSON bodies for
`GET /api/features`, `GET /api/health` and `GET /api/account/status` over
the existing private control pipe. Python still decides who may call
these routes, sets the HTTP response headers and owns the other routes.

When the reviewed acceptance bundle supplies `singularity-source-packager.exe`,
Stage runs the supplied candidate's `promote-pending` command. Rust verifies
the pending and outgoing snapshots before moving either. It moves fixed
sibling directories without overwriting a destination. If the second move
fails, it attempts to restore the outgoing snapshot and preserves the pending
directory for recovery. PowerShell still owns ACLs, copies, receipt creation
and explicit rollback. Older bundles without the tool keep the existing
PowerShell path. Native Windows execution remains a separate acceptance gate.

For rollback, retire and restore, the operator can supply a separately
reviewed `-RecoveryVerifierExe` and its `-RecoveryVerifierSha256`. The tool
must be outside the entire install tree being moved. The driver checks the
digest before invoking it. With this option, rollback checks both the
incoming and outgoing snapshots before either move. The existing ownership
and task checks still run. Do not select an executable from a snapshot
whose integrity is under review.

For the six fixed unified dashboard API routes, `DashboardRegister
-UseRustUnifiedProxy` opts into the staged native proxy. The registration
records the verified binary digest. The host keeps browser authorization,
Origin checks, the Windows gateway process ownership check and graph
cache policy. The Rust transport reads the local gateway token file,
uses only an explicit loopback IP, refuses redirects and never falls back
to the Python proxy on failure. The vendor panel proxies are unchanged.
