---
description: Give Claude Code project memory, code search, task tracking, scheduled work, and a dashboard on Windows.
tags: [singularity, repoql, claude-code, windows, getting-started]
---

# Singularity RepoQL

Give Claude Code a better way to keep track of your projects. Singularity brings together saved conversations, code search, a task list, scheduled work, and a dashboard on your Windows PC.

You don't need to set up each part yourself. Give Claude Code the prompt below and ask it to handle the installation for you.

## What does it do?

- **Keep useful context.** Save conversations and project notes so your agent can look them up when you return to your work.
- **Find the right code.** Help Claude search your project and understand how its files fit together.
- **Keep track of tasks.** Give your agent a place to record work and check what still needs doing.
- **Schedule work.** Set up jobs for your agent to run later using Ghost, the built-in scheduler.
- **See what's happening.** Use the dashboard to manage scheduled work, and Claude Office to view agent activity in a virtual office.

## Get started

You need a **Windows PC**, an internet connection, and **Claude Code installed and signed in**. Your agent will check for the other software it needs and install what's missing.

1. Open Claude Code on the PC where you want to install Singularity.
2. Copy the whole prompt below into its chat.
3. Let your agent do the setup. Approve permission requests you understand, and sign in if it asks you to connect an account. When the connector review pages open, approve the Kanzo loopback host and choose your MemoryCore data folder; do not grant any other host or folder.

```text
Install Singularity RepoQL from https://github.com/ali3nz/Singularity-RepoQL on this Windows PC.

Read DETAILS-FOR-NERDS.md and docs/NATIVE-WINDOWS-INSTALLATION.md, then follow the supported native installation. Check my computer, install all missing dependencies from the documented official sources, and build anything required. Build and install the two bundled RepoQL connectors, Kanzo and MemoryCore, through the product's supported setup. Do the setup work for me.

Connect all included tools to Claude Code in my chosen project: code search, memory, task tracking, Ghost scheduling, the dashboard, and Claude Office. Configure startup when I sign in. Preserve my existing files, settings, and other apps. Keep passwords and API keys private; ask before adding paid services or making system-wide changes.

Test the connections in a fresh Claude Code session, including saving and finding a harmless memory and running a harmless scheduled job. Fix setup problems yourself. Only ask me for permissions, account sign-ins, or choices you cannot make for me. Tell me clearly if anything could not be tested.

Create the "Singularity Dashboard" desktop shortcut with native/windows/manage_dashboard_shortcut.ps1 and check that it opens the dashboard.

Finish by telling me where the dashboard shortcut is (never show me the dashboard's private key or any link that contains it), the project folder to open, and simple instructions for everyday use, stopping, and uninstalling. Don't call the setup complete until the required checks pass.
```

Your usual Claude account or API costs still apply. If another part needs an account or API key, your agent should explain what it's for before asking you to connect it.

## Open your dashboard

The dashboard is the control panel for Singularity. It runs only on your own PC and is protected by a private key that stays on your computer.

- **Easiest way:** double-click the **Singularity Dashboard** icon (a glowing ring on a purple tile) on your Windows Desktop. Your agent creates it during setup. It opens the dashboard in your browser and signs you in automatically.
- **Address:** the dashboard lives at <http://127.0.0.1:18100/>. Typing it in by hand shows a page asking for a fresh link, so use the Desktop icon.
- **Can't see the icon, or the page won't open?** Tell your agent: “Open my Singularity dashboard and fix the shortcut if it is missing.” Don't ask it to show you the private key; it can open the dashboard for you without displaying it.

## After setup

Open the project folder your agent gives you and start a new Claude Code conversation. You can ask things like:

- “Find the code that handles signing in.”
- “Show me the tasks we still need to finish.”
- “Open my Singularity dashboard.”

If something isn't working, tell your agent what happened and ask it to check the installation. You don't need to diagnose it yourself.

## Want the technical details?

[Details for Nerds](DETAILS-FOR-NERDS.md) covers how the parts work, installation requirements, security, and testing limits.

## License

[MIT](LICENSE), with [separate notices for included third-party software](THIRD_PARTY_NOTICES.md).
