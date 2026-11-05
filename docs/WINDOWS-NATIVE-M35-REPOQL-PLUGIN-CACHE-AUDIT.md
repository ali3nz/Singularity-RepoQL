# Milestone 35: Strict RepoQL Claude Code skill cache acceptance

Release: SOURCE ONLY. Native Windows GUI loading remains untested.

## Verified defect in the M34 offline verifier

M34's `inspectRepoqlSkillAssets` accepted any non-symlink regular file called `SKILL.md` beneath a registered cache path. It could report all 17 reviewed skills as present even when the files contained no Claude skill frontmatter, belonged to a different plugin under the cache root, or came from an unrelated marketplace. It also did not report extra upstream skill directories. This was not sufficient evidence for the user requirement that all official RepoQL skills be included and correctly installed in Claude Code Complete.

## Implemented

`native/windows/configure_claude_code_windows.mjs` now checks the registry for a user-scoped `repoql@repoql-plugins` entry, and accepts only a cache path under `.claude/plugins/cache/repoql-plugins/repoql/<version>`. It rejects reparse/symlink ancestry. It checks `.claude-plugin/plugin.json` for `name: repoql`, inventories immediate skill directories, and requires each of the 17 names reviewed at M34 to have a nonempty bounded `SKILL.md` with matching `name:` YAML frontmatter. An unknown extra skill directory flags upstream inventory drift for reconciliation, not success. It checks each installed version independently rather than blending files from multiple versions. A malformed or missing registry, cache, manifest or skill file reports a machine-readable issue code.

Offline configuration verification reports `repoqlPluginCacheComplete` separately from `configured`. An all-files-present cache does NOT set `repoqlPluginSkillsVerified`: native Claude Desktop Code tab still needs to load and discover the plugin. No executable, plugin script, downloads, GUI or remote API are invoked by this read-only audit. The official RepoQL binary stays pinned to 1.7.18 with `REPOQL_NO_BOOTSTRAP=1`, preserving the M34 behavior. The externally licensed plugin files are not redistributed.

## Windows release acceptance

1. Install/approve `repoql@repoql-plugins` inside the native Claude Desktop Code tab, not by assuming settings declaration performs a complete install.
2. Run `node native/windows/configure_claude_code_windows.mjs --mode verify --home C:\Users\...` from a Windows Node runtime, inspect `repoqlPluginSkillAssets` and require `repoqlPluginCacheComplete: true`, `missing: []`, `unexpected: []` and `invalid: []`. Do not interpret `configured` as actual native GUI acceptance.
3. Confirm Claude Desktop Code tab lists and invokes all reviewed RepoQL skills, including `repoql:effective-repoql`, `repoql:using-uplinks`, `repoql:installing-connectors`, and `repoql:writing-connectors`. Verify actual skill discovery and invocation in a fresh/reloaded session.
4. Independently confirm the pin for `rql.exe` 1.7.18, MCP tool operation and workspace index readback, and the separate Tencent/main-session/Ghost/hub-doc acceptance gates.

The 17-skill baseline is an observed upstream source snapshot on 2026-10-29. Changes to RepoQL's official plugin require a reviewed inventory update. A cache-only result cannot prove source code authenticity or runtime behavior; actual artifact provenance and GUI loading remain mandatory before release.
