# Windows dashboard reconciliation against dockerhost mirror, 8 November 2026

Source reviewed: Google Drive `repoql-dashboard-latest.zip`, modified `2026-11-08T02:52:27.513Z`, and `repoql-dashboard-worktree-latest.zip`, modified `2026-11-08T02:53:00.289Z`. These are source archives, not a live dockerhost process check. Reconciliation is against the current Windows Claude Code Option 2 source candidate; it does not assert an exact per-file diff from the previous Drive revision, since the older binary ZIP revision could not be retrieved as parseable text.

## Included in this Windows source candidate

- The dockerhost Agents Control page's searchable agent inventory is adapted for installed Claude Code definitions, without revealing or editing third-party definitions.
- The current mobile-oriented model chooser is adapted as a local chooser for Claude Code's standard model aliases plus model values actually observed in installed agent definitions. It is *not* a provider registry, model availability check, or a Pi/OpenCode model picker. The existing explicit model text input remains.
- The dockerhost page's backup/status presentation is adapted as metadata-only, read-only revision backup history for one known Singularity agent. The existing SHA256 optimistic edit check, prewrite backup and atomic save remain authoritative. No restore button or automatic replacement is added.
- The canonical rules visibility idea becomes a read-only inventory of registered Claude Code hook event names and local rule filenames at user and selected project scope. It reports only registration, not hook execution. There is no single universal canonical AGENTS.md on a generic Windows install, so no write-through rule editor or projection generator is added.

## Deliberately not copied

- PiChamber/OpenCode default model and effort writes; OpenCode's `#effort` suffix is not Claude Code's native agent definition format.
- Linux hot-reload mutator, agents-md-sync.sh, `/home/ali3nz`, Linux backup paths, OpenChamber activation guards and systemd.
- Fleet agent/bot registration, OpenMausBot bot roster as Claude Code subagent files, bulk model changes without independent revision checks and automatic rollback of agent prompts.
- Dockerhost OpenMausBot's Now/Calendar/Needs Attention/History backend, which consumes its host's OMB ledger and Ghost status. A Windows equivalent needs a verified Windows OMB API and schedule execution contract before replacing the existing Windows local bot inventory.
- Fleet-specific dashboard telemetry and server infrastructure pages.

## Acceptance boundary

The read-only policy inventory and model picker have offline unit and syntax checks only. On Windows, verify the displayed local user/project rules and hooks correspond to the actual Claude Code configuration, and independently demonstrate a hook firing. Test search, modal operation, revision refusal, backup list, mobile browser and no disclosure of MCP or hook commands. Source changes must be staged on the exact accepted base and validated through the normal Windows-native install/release workflow. Do not deploy on dockerhost or assume OMB scheduled execution is operational.

## Follow-up: relevant page consolidation (V4)

- The source mirror already consolidated Repositories within Indexing, CPU/Errors/Excluded within Diagnostics, and knowledge category routes within Concepts. Windows already had these routes and tab strips, so they are **not recopied**.
- For native Windows options, the separate Ghost sidebar and Command Center card now resolve to one **OpenMausBot** workspace. The Local bots tab retains the local read-only inventory. The Ghost controls tab mounts the existing Windows Ghost controller, with unchanged API calls, event bindings and cleanup. Ghost's old `#/ghost` route is redirected to that tab. Non-native source variants retain the standalone Ghost view.
- The mobile Ghost shortcut now navigates to the OpenMausBot workspace on native Windows. Ghost's unimplemented Windows household planner remains unavailable, not represented as functional.
- This is a **navigation consolidation only**. It does not transplant the Linux OMB operations backend, change bot scheduling, alter OMB credentials or claim Ghost executions belong to an OpenMausBot conversation.
- Acceptance on Windows: verify options with and without Ghost, the legacy `#/ghost` deep link, local bots, Ghost controls, modal focus/cleanup, mobile dock, and no Dockerhost dependency. Runtime and browser acceptance remain `NOT_TESTED` here.
