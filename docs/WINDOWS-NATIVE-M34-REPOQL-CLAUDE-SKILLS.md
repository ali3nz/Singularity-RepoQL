# Milestone 34: RepoQL official Claude Code plugin and skill completeness

Release: SOURCE ONLY, NOT CERTIFIED ON NATIVE WINDOWS. Continues M33 Option 2.

## Requirement

All official RepoQL Claude Code skills must be available from the native Claude Desktop Code tab as part of the Complete install, without replacing Singularity's ten skills, silently upgrading the pinned RepoQL binary, or altering existing user-owned settings.

## Implementation

`native/windows/configure_claude_code_windows.mjs` now requests the official `repoql@repoql-plugins` in the selected user's `%USERPROFILE%\.claude\settings.json`, registering `RepoQL/RepoQL` as a marketplace with `autoUpdate:false`. This is the upstream plugin, NOT a copied or modified skill set. It supplies its own skills, MCP tooling, hooks, and agents, and its skills retain `/repoql:<skill>` namespacing. The ten Singularity skills are still separately installed as before.

The same configuration writes `REPOQL_NO_BOOTSTRAP=1`, preventing the official plugin from using its first-use download to install or upgrade `rql.exe` without the pinned-version acceptance process. The required RepoQL binary version remains 1.7.18 (ABI 1). The official plugin has its own version; a version match with `rql.exe` must not be presumed.

The native configuration install requires explicit apply. Claude Code still controls marketplace/plugin trust, download, installation, and activation, which can require user confirmation or a restart. Configuration `enabledPlugins:true` alone **does not prove installed or discoverable skills**. A live GUI acceptance must confirm these stages.

Existing compatible marketplace/plugin settings remain intact. Settings with a conflicting marketplace, disabled RepoQL plugin, or conflicting binary bootstrap env refuse installation rather than overriding user preferences. Installation-created entries are tracked in the existing durable journal and only removed during safe rollback. Unrelated settings, custom plugins and custom skills are preserved.

## Reviewed upstream skill inventory

The official `RepoQL/RepoQL` `plugins/repoql/skills` directory contained these 17 names at inspection on 2026-10-29:

- effective-markdown
- effective-repoql
- findings
- flow
- installing-connectors
- mermaid-diagrams
- monitoring-repoql
- north-star
- odad
- plan
- research
- skill-builder
- statusline-builder
- system-design
- troubleshooting-repoql
- using-uplinks
- writing-connectors

Version-scope: this is an upstream snapshot, not a commitment that all future plugin releases have exactly 17 skills. Compare against the upstream release actually deployed before updating the contract. The source-only verifier checks these files under a user-scoped official Claude plugin cache registration. It does not execute downloaded plugin code, claim skill activation in a GUI, or inspect any credentials. A missing registration or missing skill file is not counted as success.

## Mandatory Windows acceptance

1. Confirm the reviewed RepoQL 1.7.18 binary was installed independently, with its full path, SHA256, version and ABI; verify the official plugin never changes it while bootstrapping is disabled.
2. Apply the Claude native configuration with explicit user consent, then open the native Claude Desktop Code tab. Approve installation of the official RepoQL marketplace/plugin if requested. Do not use Claude CLI or OpenChamber CLI as the install path.
3. Verify the plugin is installed and enabled; inspect the actual installed plugin folder, assert all 17 reviewed skills have `SKILL.md`, and compare against the plugin release's complete published skill inventory. On missing or extra names, reconcile against upstream rather than guessing.
4. Restart or reload plugins if the native GUI requests it; exercise at least `repoql:effective-repoql`, `repoql:using-uplinks`, `repoql:installing-connectors`, and `repoql:writing-connectors` in native Code tab. Confirm all other RepoQL skills are visible in skill discovery.
5. Validate RepoQL MCP tools against a real attached workspace, verify actual index results, and confirm Tencent agent memory, hub-doc dual readback, Ghost isolation and the Office lifecycle separately. No source-only skill test substitutes for those live checks.
6. Verify rollback preserves foreign settings and all pre-existing plugins and that any installed external plugin remains user-owned; this installer only rolls back the settings entries it created. Plugin uninstall, if desired, is a separate explicit Claude action.

## Evidence and limitations

Focused `node --test native/windows/configure_claude_code_windows.test.mjs` covers declarative plugin settings, conflict rejection, owned rollback, preservation of pre-existing config, and file-cache verification. `node --test native/windows/audit_claude_fleet_contract.test.mjs` checks the source inventory. These tests do not install a native Claude plugin or prove GUI discovery.

Official sources: https://github.com/RepoQL/RepoQL and https://code.claude.com/docs/en/settings#plugin-configuration . No RepoQL binary or externally licensed binary payload is redistributed.
