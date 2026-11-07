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
