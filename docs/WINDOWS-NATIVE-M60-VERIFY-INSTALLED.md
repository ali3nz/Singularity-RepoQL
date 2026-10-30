# Milestone 60 — Verify an installed Claude Code Complete configuration without its download

After a verified Option 2 deployment is staged and configured, it should not
require preserving an old download or bootstrap directory just to re-check
*installed* bytes and receipt ownership. The new `VerifyInstalled` read-only
installer mode verifies the owned current staged binaries and complete source
manifest; then verifies installed Claude Code hooks/agents/skills, Kanzo project
MCP registration, and (only when a parent proxy receipt exists) the exact
owned provider settings.

From the verified installer source on the native Windows machine:

```powershell
.\native\windows\install_claude_complete.ps1 -Mode VerifyInstalled `
  -NodeExe 'C:\Approved\node.exe' `
  -ClaudeHome 'C:\Users\Operator' `
  -Workspace 'C:\Workspace' `
  -InstallRoot "$env:LOCALAPPDATA\Singularity\WindowsNativePreview"
```

No `-Bundle`, `-Prepared`, `-Bootstrap`, `-Apply`, private token, or original
installer download is required. Any missing, changed or unowned installed
component fails closed. The read-only result does **not** prove the native
Claude Desktop Code tab loaded the plugin, connected RepoQL/Kanzo MCP,
launched Office or Ghost, or persisted Tencent memory. It does not validate
actual task scheduler execution, network liveness or reboot recovery.

Run the separate `SupervisorVerify` task-readback and real Windows GUI and
memory tests later. Until then **SOURCE ONLY — RELEASE BLOCKED**.
