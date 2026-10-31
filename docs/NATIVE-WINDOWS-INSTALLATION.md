---
description: Supported per-user native Windows installation, lifecycle, and source-only recovery procedure for the Singularity stack.
tags: [windows, native-installation, lifecycle, source-refresh, rollback]
---

# Native Windows installation (Claude Code + Ghost + Office + RepoQL)

This is the single supported install path for the native Windows build. It
installs per user under `%LOCALAPPDATA%\Singularity\WindowsNative`; it does not
require Administrator rights and does not install services.

The release tree is the checkout that contains `native\windows`. Run every
command from that directory in Windows PowerShell 5.1 or PowerShell 7.

## What the installer provides

| Component | Runtime | Default port / task |
| --- | --- | --- |
| Dashboard (Ghost operations) | Python 3.12 + Node | `18100`, `Singularity-WindowsSupervisor` |
| Claude Office (Ghost-only identity, Ben default layout) | Python 3.13 | `18128`, `Singularity-ClaudeComplete-Office` |
| Ghost scheduler | Node (Codex runner) | `18473` / `18474` |
| Tencent MemoryCore capture | Node / Docker as documented | see `docs/MEMORY-SETUP.md` |
| RepoQL | `rql` 1.7.18, per user | `%LOCALAPPDATA%\rql\rql.exe` |

Office is seeded with the Ghost-only office and the operator's *Ben* layout
(`office\assets\ben-layout.json` and `ben-saved-layouts.json`). Desks are
furniture: every authored desk is drawn even when its agent is absent. Ghost is
the only seeded identity.

## Prerequisites

- Windows 10/11 x64.
- PowerShell 5.1+.
- Network access to the pinned sources on first install (Node, RepoQL, Python).
- No Administrator shell. Do not run `manage_*.ps1` from `C:\Users\<you>`: keep
  the shell in the release tree so RepoQL does not walk up to the profile root.

`native\windows\runtime-pins.json` records every download and SHA256 the
installer accepts. `bootstrap_runtime.ps1` fails closed instead of installing an
unpinned Python.

## One-command install

```powershell
# Review what would happen (default; writes nothing)
powershell -NoProfile -ExecutionPolicy Bypass -File .\native\windows\bootstrap_runtime.ps1

# Resolve or install runtimes, then run the full supervisor install and
# build the two pinned connector packages
powershell -NoProfile -ExecutionPolicy Bypass -File .\native\windows\bootstrap_runtime.ps1 -Apply -InstallProduct -ProvisionConnectors
```

`bootstrap_runtime.ps1`:

1. resolves Python 3.12 (dashboard/Ghost), Python 3.13 (Office), Node (for
   `scripts/native-memory-supervisor.mjs`), RepoQL 1.7.18 and the Ghost runner;
2. installs missing runtimes per user from the pinned official sources in
   `runtime-pins.json`, verifying SHA256 (or the official signature where a
   hash is not published);
3. calls `manage_native_windows.ps1 -Mode Install -Apply` with the resolved
   paths, so the user runs one command rather than filling every parameter;
4. with `-ProvisionConnectors`, builds both bundled RepoQL connector packages
   with 1.7.18, verifies their pinned bytes, and reports each connector as
   installed or missing. It does not install a connector or grant a host or
   folder; the output's `connectorProvisioning.installCommand` is the exact
   local consent command.

Use `-SourceRoot <path>` only when installing from a copied staging directory.
Use `-Python312Exe` / `-Python313Exe` to point at existing interpreters.

## Lifecycle

The manager is idempotent and every mode supports `-Apply`; without it the mode
only reports.

```powershell
$m = '.\native\windows\manage_native_windows.ps1'
powershell -NoProfile -ExecutionPolicy Bypass -File $m -Mode Plan
powershell -NoProfile -ExecutionPolicy Bypass -File $m -Mode Install -Apply
powershell -NoProfile -ExecutionPolicy Bypass -File $m -Mode Start -Apply
powershell -NoProfile -ExecutionPolicy Bypass -File $m -Mode Status
powershell -NoProfile -ExecutionPolicy Bypass -File $m -Mode Stop -Apply
powershell -NoProfile -ExecutionPolicy Bypass -File $m -Mode Uninstall -Apply
```

Registering the tasks needs a logon token for the current user. If the machine
is sitting at the sign-in screen, log in and rerun `-Mode Install -Apply`; the
tasks are logon-triggered, not boot services.

## Source-only refresh and rollback

`RefreshSource` replaces only `current\source` and the two source-manifest SHA256 pins. It keeps both staged binaries, every other receipt field, task configuration, and external state unchanged. The manager does not stop or start tasks. It refuses to proceed while a known source consumer is running or its state cannot be verified.

The first successful refresh stores the old source and exact receipt bytes in `source-refresh-snapshot`. That snapshot enables one rollback and blocks another refresh until rollback succeeds. Do not remove or rename the snapshot by hand.

**Limit:** Static source identifies the supervisor, dashboard, and Ghost scheduler as consumers of `current\source`. Runtime consumer mapping has not been confirmed on Windows, so this procedure is not deployment authorization. Complete an independent review and native Windows validation before deployment.

### Prerequisites

- Use a prepared source export with `NATIVE_WINDOWS_SOURCE_MANIFEST.json`; the manager checks the profile, complete file inventory, file sizes, and SHA256 hashes.
- The install receipt must say `installed_not_started`. The current stage must pass its source, binary, and receipt checks.
- Stop the supervisor, dashboard, and Ghost consumers before applying the refresh. The manager verifies task ownership and state and scans process metadata. It does not stop them for you.
- Resolve any existing candidate, snapshot, reparse path, receipt mismatch, or unmanifested file before proceeding. The manager refuses unmanifested files, including `.pyc`; it never removes them.

### Refresh

First review the read-only plan:

```powershell
$m = '.\native\windows\manage_native_windows.ps1'
$source = 'C:\path\to\prepared-source-export'
powershell -NoProfile -ExecutionPolicy Bypass -File $m -Mode RefreshSource -SourceRoot $source
```

Proceed only if the output reports `source_refresh_planned`, the expected option and source count, `willModify: false`, and `binariesTouched: false`. Then apply the refresh:

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File $m -Mode RefreshSource -SourceRoot $source -Apply
```

Verify that the result reports `source_refreshed`, `binariesPreserved: true`, `taskConfigurationPreserved: true`, and `rollbackAvailable: true`. The manager verifies the installed source and receipts before returning.

### Rollback

Review the rollback plan, then apply it only if the output names the expected source file count and `willModify: false`:

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File $m -Mode RollbackSource
powershell -NoProfile -ExecutionPolicy Bypass -File $m -Mode RollbackSource -Apply
```

Verify that the result reports `source_rolled_back`, `binariesPreserved: true`, `taskConfigurationPreserved: true`, `userStatePreserved: true`, and `rollbackAvailable: false`. A successful rollback restores the exact source and receipt preimages, then removes only the verified refresh snapshot contents.

### Failure handling

- If a precondition fails, do not bypass it. Restore the expected stopped state or resolve the reported ownership, drift, or inventory mismatch first.
- `NATIVE_SOURCE_REFRESH_FAILED_RECOVERED` and `NATIVE_SOURCE_ROLLBACK_FAILED_RECOVERED` mean the manager restored the prior active source and exact receipt bytes after a failed operation. The retained snapshot blocks another attempt; inspect it and resolve the failure before asking an operator to retry.
- `NATIVE_SOURCE_REFRESH_RECOVERY_INCOMPLETE` or `NATIVE_SOURCE_ROLLBACK_RECOVERY_INCOMPLETE` means readback could not prove full recovery. Do not rerun refresh or delete anything. Preserve the install and snapshot for operator review.
- If rollback fails while cleaning its verified snapshot, the old source and receipts may already be active even though cleanup did not finish. Preserve the remaining snapshot and ask an operator to inspect it before retrying.
- Never delete an unmanifested file or a pending transaction artifact to make a check pass. The manager does not rebuild binaries, register tasks, change task arguments, or deploy the refreshed source.

## RepoQL connectors

The product ships the `kanzo` and `memorycore` connector source and a pinned
1.7.18 package recipe, not committed `.nupkg` bytes. A fresh source install can
build and verify both packages through the same bootstrap path:

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File .\native\windows\bootstrap_runtime.ps1 -Apply -InstallProduct -ProvisionConnectors
```

The packages are written under
`%LOCALAPPDATA%\Singularity\connectors\packages`; the build receipt and the
scratch RepoQL workspace stay beside them. If both pinned release packages are
already there, setup verifies their exact hashes and contents against
`connectors\packages.lock.json` and reuses them. Otherwise it runs the real
`rql connector test` and `rql connector pack` commands, tests the compiled
package as well as the TypeScript source, and fails closed on any mismatch.

A source build needs a healthy RepoQL host. On a machine with many configured
MCP bridge servers, RepoQL can spend several minutes starting them before the
host is ready for `connector pack`; the pinned release-artifact path avoids that
host startup work.

Connector installation is deliberately separate, because it needs the operator.
Run it with the operator present:

```powershell
$m = '.\native\windows\manage_native_windows.ps1'
# read-only discovery
powershell -NoProfile -ExecutionPolicy Bypass -File $m -ConnectorAction status `
  -RepoqlExe "$env:LOCALAPPDATA\rql\rql.exe" `
  -PythonExe "$env:LOCALAPPDATA\Singularity\runtime\python312\python.exe"

# build/verify packages only (no connector installation)
powershell -NoProfile -ExecutionPolicy Bypass -File $m -ConnectorAction build -Apply `
  -RepoqlExe "$env:LOCALAPPDATA\rql\rql.exe" `
  -PythonExe "$env:LOCALAPPDATA\Singularity\runtime\python312\python.exe"

# approve each local install page, one connector at a time
powershell -NoProfile -ExecutionPolicy Bypass -File $m -ConnectorAction install -Apply `
  -RepoqlExe "$env:LOCALAPPDATA\rql\rql.exe" `
  -PythonExe "$env:LOCALAPPDATA\Singularity\runtime\python312\python.exe"
```

The install action passes no envelope flags. RepoQL opens its local review page:
approve the Kanzo loopback host `http://localhost:4242` and the 6 requests/minute
rate, and choose the Tencent MemoryCore data folder. If the page is closed,
declined, or times out, the result says `waiting_for_consent` or `declined`
instead of claiming success. Run `-ConnectorAction status` afterwards. The
dashboard stays read-only and never installs a connector from a click.

### Dashboard desktop shortcut

Create the per-user shortcut after `Install`, and remove it before `Uninstall`:

```powershell
$s = '.\native\windows\manage_dashboard_shortcut.ps1'
powershell -NoProfile -ExecutionPolicy Bypass -File $s -Mode Create
powershell -NoProfile -ExecutionPolicy Bypass -File $s -Mode Status
# before -Mode Uninstall:
powershell -NoProfile -ExecutionPolicy Bypass -File $s -Mode Remove
```

`Create` is idempotent, needs no Administrator rights, and writes only
`Singularity Dashboard.lnk` on the Desktop plus the bundled icon and
`open_dashboard.ps1` under `%LOCALAPPDATA%\Singularity\DashboardShortcut`. It
refuses to overwrite a shortcut it does not own (marked in the shortcut
description); `Remove` deletes only the owned shortcut and its two supporting
files in that folder. The shortcut runs the launcher, which reads the dashboard
capability key from `<state dir>\token` (default
`%LOCALAPPDATA%\Singularity\Dashboard`) and opens
`http://127.0.0.1:18100/#k=<key>` in the default browser. The key is never
printed or logged; if no key file exists, the plain dashboard address is opened
and shows how to get a fresh link. `-DashboardPort` selects another dashboard
port and `-StateDir` another state folder. `Status` reports the path, URL,
ownership and supporting-file presence without writing anything. Never paste the
key or a link containing it into chat, logs or issues.

### Office only

```powershell
$o = '.\native\windows\manage_claude_office.ps1'
$py = "$env:LOCALAPPDATA\Singularity\runtime\python313\python.exe"  # resolved by bootstrap
powershell -NoProfile -ExecutionPolicy Bypass -File $o -Mode Plan -Port 18128
powershell -NoProfile -ExecutionPolicy Bypass -File $o -Mode Install -Apply `
  -OfficeSource .\office-source -PythonExe $py -Port 18128 `
  -AllowUnpinnedSource -AllowNetwork
powershell -NoProfile -ExecutionPolicy Bypass -File $o -Mode Start -Apply -Port 18128
powershell -NoProfile -ExecutionPolicy Bypass -File $o -Mode Status -Port 18128
```

`Install` asserts the staged source carries the release patches
(`Assert-PatchedSource`), copies the seed layout, creates a Python 3.13 venv,
installs `office\requirements-windows-py313.lock.txt`, stages the static build
and registers `Singularity-ClaudeComplete-Office` as a logon task. `Stop`,
`Uninstall` and `Reinstall` are the matching modes.

The local URL is printed by `Status`; keep the token on the machine. Open the
URL from the same host (`http://127.0.0.1:18128/?token=...`); loopback origins
are accepted on any port by the WebSocket gate, non-loopback origins are not.

## Verification

```powershell
Invoke-WebRequest http://127.0.0.1:18100/health -UseBasicParsing
Invoke-WebRequest http://127.0.0.1:18128/health -UseBasicParsing
Get-ScheduledTask | Where-Object TaskName -like 'Singularity*'
.\work\venv\Scripts\python.exe -m pytest native\windows -q
```

Expected: both health responses are `{"status":"ok"}`; the supervisor and Office
tasks are `Running`; the source suite finishes with zero failures and zero
errors. Do not treat a healthy listener or a built connector package as proof of
a live connector index or readback; that remains an operator-consented step.

## Ghost scheduler (A4)

The default-root manager registers `Singularity-Ghost-Scheduler` as a logon
task. It binds only `127.0.0.1:18473` in the current configuration; `18474` is
not opened by the accepted stack. The control key lives in
`%LOCALAPPDATA%\Singularity\GhostScheduler\config.json` and is never written to
Task Scheduler arguments or status output.

```powershell
$g = '.\native\windows\manage_ghost_scheduler.ps1'
powershell -NoProfile -ExecutionPolicy Bypass -File $g -Mode Plan
powershell -NoProfile -ExecutionPolicy Bypass -File $g -Mode Register -Apply
powershell -NoProfile -ExecutionPolicy Bypass -File $g -Mode Start -Apply
powershell -NoProfile -ExecutionPolicy Bypass -File $g -Mode Status
powershell -NoProfile -ExecutionPolicy Bypass -File $g -Mode Stop -Apply
```

The A4 lifecycle drives the same operations through
`manage_native_windows.ps1`; use the child manager directly only when isolating
Ghost. Keyed readback is `GET http://127.0.0.1:18473/state` with header
`X-Ghost-Control-Key`; the expected response is `{ "ok": true, "state":
"ready" }`. Do not print the key or pass it on a command line.

## Tencent MemoryCore and supervisor (A4)

The default root is `%LOCALAPPDATA%\Singularity\WindowsNative`; memory data is
under `memory\` and is deliberately outside the stage directory so reinstall
and uninstall preserve it. `manage_native_windows.ps1` generates both configs
from the staged source and the pinned runtime:

```powershell
$node = 'C:\Users\<you>\tools\node22\node-v22.23.4-win-x64\node.exe'
python .\native\windows\build_memory_stack_config.py `
  --root "$env:LOCALAPPDATA\Singularity\WindowsNative\memory" `
  --output "$env:LOCALAPPDATA\Singularity\WindowsNative\memory\stack.json" `
  --node $node `
  --source-root 'C:\Users\<you>\tools\singularity-native-runtime\source' `
  --build-root  'C:\Users\<you>\tools\singularity-native-runtime\build'
python .\native\windows\build_supervisor_config.py `
  --install-root "$env:LOCALAPPDATA\Singularity\WindowsNative" `
  --source-root  "$env:LOCALAPPDATA\Singularity\WindowsNative\current\source" `
  --memory-root  "$env:LOCALAPPDATA\Singularity\WindowsNative\memory" `
  --output       "$env:LOCALAPPDATA\Singularity\WindowsNative\supervisor.json"
```

Components and ports are `gateway` 18431, `core` 18421 and `panel` 18126. The
supervisor starts them in that order and owns their job object. Health checks:

```powershell
Invoke-WebRequest http://127.0.0.1:18431/health -UseBasicParsing   # status ok
Invoke-WebRequest http://127.0.0.1:18421/health -UseBasicParsing   # status ok
Invoke-WebRequest http://127.0.0.1:18126/ -UseBasicParsing        # panel HTML
```

The core bearer is stored only in `memory\state\secrets\core-bearer` with a
private ACL. A bounded L0 readback (no secret echoed) is:

```powershell
$key = (Get-Content "$env:LOCALAPPDATA\Singularity\WindowsNative\memory\state\secrets\core-bearer" -Raw).Trim()
$body = @{ team_id='openchamber-agents'; user_id='pilot-operator';
           agent_id='singularity-orchestrator'; query='windows native release'; limit=1 } |
        ConvertTo-Json -Compress
Invoke-RestMethod http://127.0.0.1:18421/v3/atomic/search -Method Post `
  -Headers @{ Authorization="Bearer $key"; 'x-tdai-service-id'='default' } `
  -ContentType 'application/json' -Body $body
```

A successful empty result is `code: 0` with an empty `items` array; a 401 means
the bearer or `x-tdai-service-id` is wrong, not that memory is empty. Memory
capture is enabled in the generated core config; startup logs are under
`memory\logs\`.

## Claude Code configuration (A4)

The complete configurator installs 17 `singularity-*` agents, 10 skills, the
workflow rule, memory hooks on `SubagentStart`/`SubagentStop`/`SessionStart`/
`Stop`, and the official RepoQL plugin (`repoql@repoql-plugins`). Back up
`%USERPROFILE%\.claude\settings.json` and `.claude.json` before applying; the
configurator keeps its own transaction journal and will not overwrite foreign
agents or hooks.

```powershell
Copy-Item "$env:USERPROFILE\.claude\settings.json" `
  "$env:USERPROFILE\Documents\claude-settings.backup.json" -Force
node .\native\windows\configure_claude_code_windows.mjs `
  --mode plan --variant 2 `
  --source "$env:LOCALAPPDATA\Singularity\WindowsNative\current\source" `
  --home $env:USERPROFILE `
  --memory-config "$env:LOCALAPPDATA\Singularity\WindowsNative\memory\memory-hook.json" `
  --office-config <office-hook.json>
# after reviewing the plan, repeat with --mode apply --apply
node .\native\windows\configure_claude_code_windows.mjs --mode verify --home $env:USERPROFILE
```

`--node-exe` is optional: the configurator resolves the bootstrap runtime under
`%LOCALAPPDATA%\Singularity\runtime`, then PATH, and refuses a machine-local
`C:\Users\<name>\tools\...` Node. `--memory-config` must be the generated
`memory-hook.json` (the stack manifest `stack.json` has no service key); it is
ACL-private and carries the core bearer. `settings.json` stores only paths,
never the Office ingest key or the core bearer. The Office event-hook client config lives outside the B7-owned
`office\` tree at `%LOCALAPPDATA%\Singularity\ClaudeCode\office-hook.json`
with a private ACL. The Office service itself is owned by B7; A4 does not start,
stop or install it. A4's verifier checks the memory hooks and the RepoQL plugin,
and observes the Office task and its `18128` health endpoint without writing to
the B7 tree.

The RepoQL plugin is installed at user scope after the settings plan:

```powershell
claude plugin install repoql --marketplace RepoQL/RepoQL -y --json
claude mcp list    # plugin:repoql:repoql ... Connected
```

If `claude auth status` reports `loggedIn: false`, `claude -p` cannot call a
model. The hook path still fires before the API error; use `claude` interactive
login when a live model turn is required.

## Post-reboot verifier (A4)

`native\windows\verify_after_reboot.ps1` is read-only. It checks the four
logon tasks and their action needles (supervisor, Claude dashboard, B7-owned
Office, Ghost), the dashboard marker, keyed Ghost `/state`, Office `18128`
health, memory gateway/core/panel health, L0 readback, RepoQL 1.7.18, the
Claude settings/agents/plugin registry and the CLI version, then writes a JSON
receipt. It does not start or stop anything; Office is observed read-only.

```powershell
powershell -NoProfile -ExecutionPolicy Bypass `
  -File .\native\windows\verify_after_reboot.ps1
powershell -NoProfile -ExecutionPolicy Bypass `
  -File .\native\windows\verify_after_reboot.ps1 -Json
```

Expected on the accepted host: `POST_REBOOT_VERIFY=True PASS=26 FAIL=0 WARN=0`
(the count includes the Office task, port and HTTP checks).
Receipts land in
`%LOCALAPPDATA%\Singularity\WindowsNative\state\receipts\post-reboot-*.json`.
Run it after sign-in because all four tasks are logon-triggered; a session at
the sign-in screen is not a failed install.

## A4 lifecycle evidence and recovery

The accepted default-root sequence is Plan, Install, Start, Status, Stop,
Uninstall, Reinstall, Start. Receipts are written under
`R\work\evidence\lifecycle\a4-*` by the operator harness. `Uninstall` removes
only verified owned tasks and manifest-owned files, deletes the installation
receipt, and preserves `memory\` and user state; because the receipt is gone,
use `Install` after `Uninstall`. `Reinstall` is the upgrade path from an
existing installed/partial receipt and refuses an absent receipt or an
unverified stage.

`-SkipOffice` is mandatory for this non-Office stack. Never run the A4 manager
without it on a host where B7 owns Office, and never point `-InstallRoot` at a
directory containing unowned files: the manager fails closed with
`NATIVE_INSTALL_ROOT_CONTAINS_UNOWNED_CONTENT`.

## Uninstall and rollback

`-Mode Uninstall -Apply` stops and unregisters the tasks, removes the
`WindowsNative` install root and leaves user data in `%LOCALAPPDATA%\Singularity`
alone. Remove that directory only when the user asks for a full reset.

No release step in this document commits, pushes or regenerates `SHA256SUMS`.
