# Singularity RepoQL: Windows Claude Code and OpenMausBot

This is an optional, Windows-local **source candidate**, not a certified public build. It is designed for Option 2, using one installed Windows OpenMausBot desktop server. It does not install OpenMausBot, provide a model subscription, copy Dockerhost credentials, or grant privileged tools to bots. No Docker, SSH, WSL, background polling, extra memory writer, or model call is required by these integration scripts.

## What is carried over from dockerhost

The 2026-11-05 dockerhost `omb-bot-access` runbook describes a shared Pi `AGENTS.md`, a fleet-gates extension, and scoped RepoQL/Kanzo MCP tools. Only the **behavioural instructions** and **existing Windows-local Kanzo/RepoQL routes** are portable here. Linux Pi extensions, root SSH, hubdoc wrappers, container timers, and Tencent capture writers must not be bundled or started on public Windows machines.

The template in `native/windows/openmausbot/AGENTS.md` covers current source inspection, Kanzo ownership, existing planner/reviewer/final gates, scoped memory, explicit nudge checkpoints, token thrift, and truthful closure. The installer puts this file at `%USERPROFILE%\.openmausbot\bots\AGENTS.md`, the common ancestor of the bot workspace paths in upstream `server/bot-folder.ts`. Upstream `server/lending-memory.ts` lists ancestor `AGENTS.md` files as eligible context; **this does not prove every engine enforces these rules or loads them on its next turn**. Check the configured engine and use a real prompt/tool acceptance test. The installer refuses to overwrite a different user-authored file.

Actual tool enforcement must be supplied by the installed engine and Windows-native Kanzo/orchestration gates. This package does **not** claim the native Pi fleet-gates extension is ported to Windows. It intentionally does not simulate Kanzo claims or attach pre-approvals to messages.

## How Claude Code speaks with OpenMausBot

The official OpenMausBot MCP server provides `list_bots`, `send_bot_message`, `wait_for_conversation`, `get_bot_messages`, and other bounded tools (upstream `docs/mcp-server.md`). The Windows project's existing `.mcp.json` configurator registers it **only when a local OpenMausBot desktop installation and a paired client token already exist**. There is no replacement MCP implementation, duplicated RepoQL registration or extra AI dispatcher.

The standard Windows desktop location is `%LOCALAPPDATA%\Programs\OpenMausBot\OpenMausBot.exe`, with `resources\server\mcp-server.js` next to it. The MCP client launcher is `native/windows/openmausbot/claude_mcp_launcher.mjs`. It reads a private token at `%LOCALAPPDATA%\Singularity\OpenMausBot\mcp-session.token`, then launches the upstream MCP script through the desktop's bundled Node runtime. The project `.mcp.json` holds only the absolute executable/launcher paths and local port. No token is passed as a command argument, printed, committed, or stored in the project configuration.

### One-time pairing

1. Install OpenMausBot for the logged-in Windows user, start it, and make sure its UI uses Windows loopback and an authenticated session. Confirm the service trust mode does not allow unauthenticated local mutation.
2. In OpenMausBot select **Settings > Phone > Set up a phone** and get a one-time code.
3. Use the documented OpenMausBot `connect` CLI to exchange that code for a **dedicated client session**, saving the token to `%LOCALAPPDATA%\Singularity\OpenMausBot\mcp-session.token`. The upstream CLI supports `--out` and does not print the token. Restrict the directory and file to the Windows account (and authorised system administrators); inspect NTFS ACLs before activating the integration. Do not use the dashboard password as the MCP token.
4. Run the existing Option 2 `install_claude_complete.ps1 -Mode Configure -Apply` after its prerequisites are met. During its existing Kanzo MCP configuration, the presence of the desktop executable, MCP script, and token file automatically adds the OpenMausBot MCP server. The same pass installs the shared bot rules without overwriting a foreign file.
5. In Claude Code, approve the project's OpenMausBot MCP registration, list bots, send a safe test message, wait for a settled answer, and independently confirm the model/usage receipt. No model calls occur during setup checks.

**Dashboard provisioner status.** The dashboard provisioner (`native/windows/provision/provisioner.py`, integration `openmausbot_mcp`) only detects the token file: it must be a regular, non-symlink file of at most 4096 bytes whose content matches the `omb_sess_` session format. The token value is never read into receipts, logs or command lines. When the token is missing or invalid, the integration reports `needs_user_action` and the one-time pairing in steps 1 to 3 must be completed by hand. Automated pairing through the `connect` CLI is not implemented because that CLI's flags and non-interactive pairing source are not verified in this repository. The ACL helper that restricts the token location with `icacls` is not yet wired to any live step.

The default local OpenMausBot port is 8799. If the desktop selects a different port, **update the source configuration and reapply only through the existing owned MCP rollback process**; do not edit a receipt-owned `.mcp.json` manually. The launcher refuses unknown ports and does not discover other hosts with a bearer token. If the project MCP was already configured before pairing, use the existing `--rollback` and controlled `--apply` flow during an authorised maintenance window; never modify a foreign or active MCP definition in place. Run the project's `verify` action afterwards.

### Offline rule check (read only)

```powershell
node .\native\windows\openmausbot\install_shared_rules.mjs plan
node .\native\windows\openmausbot\install_shared_rules.mjs verify
```

A direct `apply` is only needed when the Option 2 configurator did not include the optional integration and the actual OpenMausBot bot directory exists. A matching receipt is required for rollback. Changed/foreign rules must be reviewed, not overwritten.

## Security and token costs

- The Singularity dashboard continues to require its chosen first-run username and password. Dashboard cookies do not provide an OpenMausBot MCP session.
- Claude Code speaks to the Windows-local OpenMausBot MCP over loopback, with an independently paired device token. The OpenMausBot service must still enforce its own authentication and tool approvals. `AGENTS.md` and dashboard login are not a network sandbox.
- An unauthorised local user or process must not gain tokens via a permissive NTFS ACL. Test a separate Windows account and a browser with no cookie before claiming isolation. A local administrator can generally bypass app-level controls; do not claim an absolute dashboard-only boundary.
- OpenMausBot's bot creation, task dispatch and `send_bot_message` can trigger extra AI/model/tool usage. Registering and testing the MCP connection does not invoke a model by itself. Do not auto-poll or start background capture loops.
- Native Kanzo claims, independent review receipts, Pi/Claude engine gates, full Claude Office event delivery, and Tencent scoped memory write/recall remain separate live acceptance checks. Displaying a bot or receiving its reply proves none of those alone.

## Acceptance before public release

Record actual Windows results: private token ACL, clean installation and login, local-only listeners, one existing and one new bot reading shared rules, foreign-file conflict refusal, Claude Code `list_bots` + send/wait roundtrip, a denied unsafe action in each supported engine, a real Kanzo claim/readback/review, the correct Tencent role, restart/reboot recovery, and upgrade/rollback that preserves unrelated user settings. The native WiX MSI/Burn build and actual Windows installation remain untested from the offsite packaging environment.

## Windows RC headless integration (source candidate, not yet installed)

The Windows RC also includes a **product-owned OpenMausBot headless runtime** under
`%LOCALAPPDATA%\Singularity\Fleet861RC`, launched through the existing
`Fleet893-RC-OpenMausBot` logon task. That path was previously missed by Option 2,
which checked only for the desktop `.exe` and a paired token. The updated Option 2
MCP configurator now supports the **official** headless `cli.js mcp` command:

- Verify the RC-owned `state\omb\instance.json` matches the exact product
  payload, data directory, task and running PID. Never select an arbitrary
  listener or a CLI from `PATH`.
- Register a `stdio` MCP command using the pinned local Node executable,
  the product-owned `cli.js`, and the verified local `OMB_PORT`. No desktop
  executable or session token is required for the headless server running
  with the vendor's local-owner trust mode.
- Reuse `.singularity-native-mcp-receipt.json`, conflict refusal, revision
  checks and exact rollback; do not register a second RepoQL MCP server.
- Install the existing ancestor rules into the headless server's *actual*
  data directory using `install_shared_rules.mjs apply --data-dir ...`,
  refusing foreign or modified files. Test that the chosen engine actually
  reads the rules before claiming hook/gate parity.
- If the verified RC-owned headless instance is absent, the previous paired
  desktop OpenMausBot integration remains supported. If an instance manifest
  is present but ownership fails, refuse rather than silently fall back.

This is not an authentication or isolation proof. Local owner trust is specific
 to the vendor's headless mode, not to a system-wide trusted Windows identity;
run a cross-user negative authorization check before a multi-user release.
A configured MCP entry is not a working model interaction.

### Declarative Singularity Maintainer registration

`native/windows/openmausbot/provision_maintainer.mjs` is the additional
source-only integration helper. It uses the vendor's documented `team apply`
file format. Plan mode reads the RC instance without changing bots. Apply mode
requires `--apply`, creates one bot named **Singularity Maintainer** in its own
non-pruning team, uses the existing OpenMausBot default model, and independently
reads the bot back via the vendor CLI. It preserves existing teams and bots.

Example from a verified Windows Git source checkout:

```powershell
$root = (Get-Location).Path
$rc = Join-Path $env:LOCALAPPDATA 'Singularity/Fleet861RC'
node .\native\windows\openmausbot\provision_maintainer.mjs --source $root --rc-root $rc
node .\native\windows\openmausbot\provision_maintainer.mjs --source $root --rc-root $rc --apply
```

`--apply` uses the installed server's existing model configuration, snapshots
`bots --json` before and after (the applied team, `cwd`, `approval` and
`computer` must match the plan and unrelated bots must survive), then creates
the bot's own bounded routine through the vendor MCP `trigger` tool and reads it
back with `trigger_info`. Bot configuration (team, title, description, soul, approval, computer, cwd) is verified with the vendor read-only `team apply --check --json` (exit 6 = drift, reported as `OMB_BOT_CONFIG_MISMATCH`); this vendor behaviour is not yet confirmed live (NOT_RUN). The response reports `scheduleVerified:true` only when
that readback lists the routine enabled with a future run; otherwise the reason
is returned and the command exits non-zero. `--verify-schedule` repeats just the
readback.

Verified vendor contract used here (installed bundle plus `headless.py`):
`team apply` for the bot, `node cli.js mcp` for `list_bots`/`send_bot_message`
(stable `send_id`) and `trigger`/`trigger_info` for the routine. No OS scheduler,
no second routine store and no global `newBotDefaults` mutation is used.

Repair reporting is deliberately split: the Markdown report and the JSON result
carry `onDiskVerified:true` together with `loadedIntoActiveTurn:false`,
`gateEnforcementVerified:false`, `reloadRequired:true` and the exact operator
action. Reload or restart the running bot before treating repaired rules as live;
a health endpoint or an on-disk digest alone does not prove the live turn uses
them. Onsite acceptance still requires one real bot execution, a verified
repair, a Markdown report and an acknowledged OMB chat message; a source template
or a successful `team apply` by itself is not proof of an autonomous maintainer.
