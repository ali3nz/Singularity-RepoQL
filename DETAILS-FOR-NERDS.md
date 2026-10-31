---
description: Technical installation, components, security boundaries, and verification details for Singularity RepoQL.
tags: [singularity, repoql, windows, claude-code, installation, technical-details]
---

# Details for Nerds

For the short introduction and the prompt to give your agent, see the [README](README.md).

## Agent installation checklist

Read [Native Windows installation](docs/NATIVE-WINDOWS-INSTALLATION.md) and the installer source before applying changes. Check the computer for every prerequisite, install missing dependencies from the documented official sources, and build the native binaries when needed. This includes the required Python versions and timezone data, Node, Git, RepoQL, and the Rust/MSVC/Windows SDK build tools where required. Do not assume that running the bootstrap alone completes every prerequisite or Claude Code integration step.

Use the repository's pinned versions and integrity checks. Configure the memory providers and Ghost runner with accounts the user is authorized to use. Ask before adding a paid service or making system-wide changes. Preserve unrelated applications, Claude settings, hooks, and user data.

Connect RepoQL, MemoryCore, Kanzo, Ghost, the dashboard, and Office to the intended Claude Code workspace. Set up documented sign-in startup. In a fresh Claude Code session, verify code search, conversation capture and retrieval, task tools, dashboard access, Office events, and a harmless scheduled job. Report any missing account, unsupported platform, or unverified behavior explicitly. A process starting is not an end-to-end test.

Dashboard shortcut: run `native/windows/manage_dashboard_shortcut.ps1 -Mode Create` (optionally `-DashboardPort <port>`, `-StateDir <dashboard state folder>`) as the installing user. It writes a per-user `Singularity Dashboard.lnk` on the Desktop with the bundled icon. The shortcut runs `open_dashboard.ps1` from `%LOCALAPPDATA%\Singularity\DashboardShortcut`, which reads the dashboard capability key from `<state dir>\token` (default `%LOCALAPPDATA%\Singularity\Dashboard`) and opens `http://127.0.0.1:<port>/#k=<key>` in the default browser; the key is never printed or logged, and if no key file exists the plain address (which explains how to get a fresh link) is opened. It needs no administrator rights, refuses to overwrite a shortcut it does not own (marked in the shortcut description), and `-Mode Remove` deletes only an owned shortcut and the two files in its own folder. `-Mode Status` reports state. Do not paste the key or a link containing it into chat, logs or issues.

## Package and release status

One native Windows package brings together RepoQL code intelligence, Tencent MemoryCore, Ghost scheduling, an authenticated dashboard, and the Claude Office activity viewer. The installer targets the complete package only.

Codex can build, install, test, and operate the native components without a local Claude application. Claude Code agent definitions, skills, rules, and lifecycle hooks are included for users who choose that integration. Installing those files alone does not establish that a Claude session captured or recalled memory.

**Release status: Windows-native source release candidate.** Native reboot/logon startup, Claude desktop Code-mode RepoQL and Kanzo discovery, parent-conversation capture, and a scripted automatic documentation-ingestion smoke test have been verified on one Windows x64 workstation. This is not a signed, turnkey binary installer or full release certification. See the [acceptance results and remaining limits](docs/WINDOWS-RELEASE-ACCEPTANCE.md). Historical milestone receipts verify only their own checkpoints.

## Install the complete package

Follow [Native Windows installation](docs/NATIVE-WINDOWS-INSTALLATION.md). The native lifecycle entrypoint is `native/windows/manage_native_windows.ps1`. It provides Plan, Install, Start, Status, Stop, Uninstall, and Reinstall operations; mutations require `-Apply`. The public entrypoint selects the complete package internally and presents no option menu.

The package uses native Windows executables and per-user scheduled tasks. Its dashboard and control services bind to loopback. Keep private configuration and credentials in the protected per-user state directory. Never paste keys into issues, logs, command arguments, or Git.

Dependencies include Windows x64, RepoQL **1.7.18**, Python with timezone data, and the runtimes described in the installation guide. Building the Rust binaries also needs the MSVC toolchain and Windows SDK. Docker and WSL are not prerequisites for the native path. A configured runner executable is required for Ghost work; installing the scheduler does not provision a model account or bypass its limits.

## Components

- **RepoQL** indexes code and approved knowledge. The bundled MemoryCore and Kanzo connectors use the RepoQL 1.7.18 `parse` / `fetch` / `render` contract. A fresh source install builds and pins both 1.0.0 packages; installing them still requires the operator's local consent page. Earlier experimental `abi: 1` manifests are incompatible with this supported runtime.
- **Tencent MemoryCore** stores scoped conversations and extracted memories. The connector reads L1 record shards and L2/L3 profile files without modifying the source store. Capture, extraction, and recall require their runtime and identity configuration; a healthy listener alone verifies none of them.
- **Ghost** keeps planning drafts separate from registered Windows schedules. Activation rereads the exact draft revision, persists the prompt revision, registers a real task, and verifies its action, principal, trigger, and enabled state before displaying it as active. Updates and cancellation also require independent readback. Execution receipts survive host restart.
- **Dashboard** provides authenticated schedule editing and native integration panels. A per-user capability binds local scheduler requests to the configured Windows owner. Cloudflare identity alone does not authorize that owner's tasks.
- **Claude Office** visualizes actual agent events. Its upstream code has separate provenance and license notices. Office presence is event evidence, not proof that a model request, memory extraction, or scheduled job succeeded.
- **Claude Code integration** includes seventeen role definitions and ten Singularity skills. The official RepoQL plugin owns RepoQL MCP; the project MCP entry owns Kanzo. Existing unrelated settings and credentials are preserved.

## Use Claude desktop Code mode

Open the workspace selected during installation. Kanzo is registered in that workspace's `.mcp.json`, not globally and not automatically in another repository. Approve the project MCP server when Claude prompts. A successful `list_projects` response saying there are no projects is a valid connection test; it does not create a project.

The official RepoQL plugin supplies code-intelligence tools. Point it at an actual repository rather than a home or Documents directory. The parent-session Stop and SessionEnd hooks capture user and assistant messages into their own MemoryCore identity. Documentation hooks baseline eligible Markdown at SessionStart and discover changes at Stop. [Document ingestion](docs/DOC-INGESTION.md) distinguishes a verified searchable revision from a pending or failed write.

## Providers

Use provider credentials you own. The extraction router supports Cohere and additional OpenAI-compatible providers configured with a private key file and provider descriptor. Provider availability, quotas, and models can change. A controlled provider failure must reach a second real provider before failover is accepted.

On Windows the router binds only to loopback. Enable its local bearer requirement and keep the access key in the private secrets directory. Router health is not a successful completion test.

## Development and acceptance

Build and test directly on Windows. Inspect existing product ownership before changing tasks, files, or services. Clean-install tests remove only project-owned resources and preserve unrelated software, user data, and Codex.

Native Rust compilation, focused source tests, live browser tests, actual scheduler execution, memory/provider integration, install/restart/uninstall/reinstall, and reboot recovery are separate checks. Report untested checks explicitly. Do not label a source archive as a usable installer or a successful test as proof of a different advertised capability.

The [acceptance report](docs/WINDOWS-RELEASE-ACCEPTANCE.md) records the verified native path. Legacy Linux/container instructions and historical four-profile source tools remain for provenance and compatibility work. They are not additional installer choices in this Windows release candidate.

## Documentation and license

[Architecture](docs/ARCHITECTURE.md), [memory](docs/MEMORY-SETUP.md), [Claude Code integration](docs/CLAUDE-CODE-SETUP.md), [Office](docs/OFFICE-SETUP.md), and [tagged-release gates](docs/RELEASE.md).

This repository is MIT licensed. Preserve separate upstream and third-party notices when distributing Tencent, Office, Kanzo, and other dependencies.
