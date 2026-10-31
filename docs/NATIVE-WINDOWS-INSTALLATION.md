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

# Resolve or install runtimes, then run the full supervisor install
powershell -NoProfile -ExecutionPolicy Bypass -File .\native\windows\bootstrap_runtime.ps1 -Apply
```

`bootstrap_runtime.ps1`:

1. resolves Python 3.12 (dashboard/Ghost), Python 3.13 (Office), Node (for
   `scripts/native-memory-supervisor.mjs`), RepoQL 1.7.18 and the Ghost runner;
2. installs missing runtimes per user from the pinned official sources in
   `runtime-pins.json`, verifying SHA256 (or the official signature where a
   hash is not published);
3. calls `manage_native_windows.ps1 -Mode Install -Apply` with the resolved
   paths, so the user runs one command rather than filling every parameter.

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
tasks are `Running`; the source suite is `283 passed, 11 skipped` with zero
failures and zero errors.

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
