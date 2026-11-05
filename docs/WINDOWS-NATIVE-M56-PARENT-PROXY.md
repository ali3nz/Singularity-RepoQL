# Milestone 56: Parent-session Tencent proxy configuration (source only)

**Scope:** native Windows Claude Desktop **Code tab** / Claude Code Complete. `RELEASE BLOCKED`. No user provider settings or live credentials were changed in the build sandbox. This workflow configures a local model proxy route, **not** proof of memory capture, persistence, or recall.

## Why separate configuration?

Delegated agent memory profiles (eight agents) and the ordinary parent Code-tab conversation are different namespaces. Earlier installation only installed delegation/document hooks; the parent provider proxy route was left to separate manual setup. M56 introduces an opt-in, receipt-owned configurator that refuses foreign provider settings and provides a reversible upgrade path. It does **not** initialize the proxy process or create Tencent accounts.

## Private configuration (never commit or upload)

Create an approved private JSON file, with restrictive Windows ACLs, of exactly this form, using an existing local proxy endpoint, approved scoped token, and actual configured provider model:

```json
{
  "schema": "singularity-option2-parent-proxy/v1",
  "baseUrl": "http://127.0.0.1:8096/claude-code/default",
  "token": "<operator-managed-private-token>",
  "model": "<approved-provider-model>"
}
```

The tool requires a 127.0.0.1 HTTP endpoint with an explicit port and `/claude-code/<scope>` path; no URL userinfo or trailing query/fragment. It refuses existing foreign routing, API keys, Bedrock/Vertex/Foundry, apiKeyHelper, conflicting token/model values, or an already-owned parent receipt. No token is printed by the tool. The private file and settings backup contain secrets; do not include them in support logs or source ZIPs.

## Operator commands (Windows PowerShell, current user)

Only after the reviewed bundle is prepared, staged, and the native Claude Code Complete `Configure` operation has produced an owned Claude configuration receipt:

```powershell
$installer = 'C:\Private\Singularity\native\windows\install_claude_complete.ps1'
$installRoot = Join-Path $env:LOCALAPPDATA 'Singularity\WindowsNativePreview'
$nodeExe = 'C:\Program Files\nodejs\node.exe'
$claudeHome = $HOME
$private = 'C:\Private\singularity-parent-proxy.json'

& $installer -Mode ParentPlan -InstallRoot $installRoot -NodeExe $nodeExe -ClaudeHome $claudeHome -ParentProxyConfig $private
# Review all foreign-provider conflicts and the original settings backup plan.
# Apply only after explicit consent, backup and local proxy configuration review:
& $installer -Mode ConfigureParent -InstallRoot $installRoot -NodeExe $nodeExe -ClaudeHome $claudeHome -ParentProxyConfig $private -Apply -Confirm:$false
& $installer -Mode VerifyParent -InstallRoot $installRoot -NodeExe $nodeExe -ClaudeHome $claudeHome
```

`VerifyParent` checks the receipt and current settings bytes. It **cannot** verify an authenticated provider round-trip or cross-session Tencent recall. To reverse, run `-Mode RollbackParent ... -Apply -Confirm:$false` before `RollbackConfig` or uninstall; rollback requires unchanged owned settings and a verified original backup. Unexpected edits deliberately block automated rollback for operator review. Interrupted apply with unchanged original settings can be recovered.

**Live acceptance:** generate the native Code-tab two-session plan with `native/windows/claude_complete_gui_acceptance_plan.py`; actually run the two prompts in independent native GUI sessions and separately verify Tencent persistence and access controls. The legacy standalone `claude` CLI test does not establish Code-tab behavior. Test all nine parent-session roles and Ghost scope isolation separately. Record redacted evidence, not memories or tokens.

## Engineering boundaries

Source code: `native/windows/configure_parent_memory_proxy.mjs`, `native/windows/install_claude_complete.ps1`, `native/windows/uninstall_claude_complete.ps1`.

No Windows PowerShell or native GUI commands were executed here. The route is an optional application configuration operation, **not a finished native installer, an authenticated provider test, or release acceptance**.
