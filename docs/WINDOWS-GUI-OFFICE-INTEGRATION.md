# Windows GUI: Claude Office event integration (Milestone 4, unaccepted)

**Source-only.** This is a read-only setup procedure for future Codex testing on
Windows. Do not install it on an active workstation until the Rust crate has
been compiled and its hooks have been validated against the installed GUI
versions. The upstream Claude Office GUI/backend remain a separate application.
This change does not implement a native Rust clone of Office's frontend.

## Implementation and exact boundary

- `native/desktop-bridge/src/office.rs`: Rust-only mapping, metadata whitelist,
  endpoint validation, credentials, HTTP delivery, timeouts. CLI routes
  `office-claude EVENT-KIND` and `office-opencode`, reading bounded JSON from
  stdin. Both routes exit successfully when optional Office is unavailable.
- `native/gui-plugins/openchamber/singularity-office.mjs`: mandatory minimal
  OpenCode JavaScript plugin boundary. It gets documented OpenCode event hooks,
  strips text, injects no prompts, and invokes the Rust executable directly.
  It does NOT use or launch an OpenCode terminal CLI.
- Claude Desktop Code tab: the GUI can start the Rust binary from shared Claude
  Code hook settings via exec-form `command`/`args`. It does not launch a
  separate Claude Code CLI session.
- MCP memory lookup remains a separate Rust `serve` mode. Office visualization
  is not the same as memory capture or recall; neither capability is proven by
  receiving a session event.

## Local Office backend requirement

The existing Docker installation uses `http://product-office:8000/api/v1/events`.
That internal DNS name is *not available* to a Windows GUI. The native bridge
requires an actual authenticated loopback gateway at
`http://127.0.0.1:8000/api/v1/events` or `localhost`/`[::1]`. Do not expose
Office directly on the LAN or rewrite the existing Docker configuration.
In the native Windows test environment, confirm a local Office service or
an explicitly configured private loopback-forward first.

Create a locally restricted **secrets file** with the same established schema:

```json
{
  "endpoint": "http://127.0.0.1:8000/api/v1/events",
  "ingestKey": "PLACEHOLDER-NOT-A-REAL-KEY"
}
```

The JSON file is only an example. Do not check the real file into the repo or
copy its contents into app settings, issue reports or Drive archives. Native
Windows ACL enforcement is still an acceptance requirement.

Set `SINGULARITY_OFFICE_CONFIG` to its full path in the desktop app's actual
process environment. Nothing here creates user or system environment variables
for you. Check that the relevant native GUI process can read its intended
profile without changing authentication, models or other plugin settings.

## Claude Desktop Code tab

- Discover the **actual** Code tab project and the active `%USERPROFILE%\\.claude\\settings.json`.
- Read the hook configuration carefully, preserving all unrelated handlers.
  The installed Claude Desktop's Code tab must actually honor hooks for this
  release; opening Chat or running `claude` in a terminal is not acceptance.
- The command handler for each event is exec-form, which is supported by
  current Claude Code hooks. A SINGLE candidate handler looks like:

```json
{
  "type": "command",
  "command": "C:\\Singularity\\bin\\singularity-desktop-bridge.exe",
  "args": ["office-claude", "session-start"]
}
```

Replace the second argument with `prompt`, `pre-tool`, `post-tool`, `stop`,
`subagent-stop`, or `session-end` for the matching `UserPromptSubmit`,
`PreToolUse`, `PostToolUse`, `Stop`, `SubagentStop` or `SessionEnd` hook.
The `SessionStart` hook uses `session-start`. Never register this alongside an
already-installed `office-hook.mjs` for the same event without first proving
that the existing hook isn't already forwarding to the same Office backend.
A matching native event and a rendered Office desk must be observed live.

## OpenChamber Desktop (OpenCode plugin API)

The existing `openchamber/plugins/product-office` is written against the
shipped product's plugin runtime and Docker network. That path is **not**
proven to be the native OpenChamber desktop plugin API.

A separate, opt-in OpenCode API adapter is provided at
`native/gui-plugins/openchamber/singularity-office.mjs`. Once the installed
native GUI's embedded OpenCode plugin API is confirmed, merge *only that file*
into its recognized plugin directory, for example a user OpenCode plugin
directory. Do not copy the Docker-specific `opencode.jsonc` wholesale.

Set `SINGULARITY_DESKTOP_BRIDGE` to the absolute Windows path of the compiled
Rust `.exe` in the actual GUI process environment. The adapter does nothing
when the variable is absent. `SINGULARITY_OFFICE_CONFIG` supplies the
credential file path to the Rust subprocess. The adapter uses documented
OpenCode hooks for `session.created`, `session.idle`, `session.deleted`,
`session.compacted`, `session.error`, and `tool.execute.before/after`.
Only whitelisted event metadata passes to Rust; the Rust process checks the
session ID again. The adapter does not intercept the user's provider
configuration and does not call the `opencode` CLI.

This lightweight adapter is **best effort**. It does not persist event retries
on disk. Lost events after a crash and unsent events during logout remain
acceptance limitations. Also, the actual native OpenChamber app may package a
nonstandard OpenCode server or route plugin files differently. That needs
live validation, not a claimed guarantee.

## Tests and release gates

Offline: `node --test native/gui-plugins/openchamber/*.test.mjs`, plus Rust
`cargo test`, `cargo fmt --check` and `cargo clippy` when a toolchain is
available. Rust compilation and tests have NOT run here.

Native Windows acceptance:

1. Compile the Rust executable and run its tests. Inspect binary origin,
   target architecture, and permissions before placing it in a managed path.
2. Discover app versions and plugin/hook config without copying secrets.
3. Validate Office loopback backend readiness with a *synthetic* event and
   verify a receipt before handling real sessions.
4. Enable one app at a time, with backups and rollback. Verify GUI events and
   rendered desks in Office, first Claude Code tab, then OpenChamber Desktop.
5. Verify cross-session identity isolation, optional Office outage behaviour,
   no prompts/tool I/O in a packet capture, duplicate-event behaviour,
   GUI logout and restart, and host command windows remain hidden.
6. Prove Office is not receiving duplicated events from the legacy JS hooks.

**This adapter alone is NOT automatic memory capture, durable session recall,
Windows MemoryKnowledge service installation, or full Rust migration.**
