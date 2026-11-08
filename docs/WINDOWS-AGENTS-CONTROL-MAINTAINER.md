# Windows Claude Code Agents Control and OpenMausBot maintenance

## Scope and exclusions

This change targets the **Windows-native Claude Code Complete (Option 2)** product only. It does not change or deploy the real dockerhost dashboard. No GitHub or SSH MCP is installed, registered or required. The four product capabilities are RepoQL, Kanzo, MemoryCore and OpenMausBot; RepoQL is provided through the official Claude plugin, MemoryCore through the RepoQL connector and product's capture/recall hooks. Do not register duplicate MCP servers just to satisfy an inventory label.

The installed Claude Code roster contains fifteen selected agents: nine existing main-session identities (including Ghost) and six delegation agents (General, Explore, Researcher, Thinker, simple Code Reviewer and Board). Fleet Reviewer and Quality Fixer are not part of this Windows roster or default Windows MemoryCore provisioning. Existing user-created agents and stale profiles are not deleted by a source update. Remove previously installed, owned obsolete definitions only through a verified Windows uninstall/reconcile receipt.

## Native dashboard change

The `Agents Control` sidebar page appears only when `SINGULARITY_WINDOWS_NATIVE=1`. It shows installed Claude Code agent names, descriptions and models, and allows editing the Markdown of the fifteen known Singularity agent definitions. Edits use the current file SHA256 as a revision token, a local immutable backup, and an atomic replacement. The code reviewer cannot be granted Bash, Edit or Write by this editor. Arbitrary user agents, reparse paths and unrelated files are not editable. The response reports file-save only; actual Claude Code reload must be tested in a new delegation.

An `MCP integrations` section shows configured names and scopes, not command arguments, environment values, secret keys or credentials. It deliberately does not claim the MCP is connected merely because a registration exists. Agents Control does not automatically provision the four required connections; installation and connection validation stay with their existing supported Windows procedures. The dashboard hides the Linux-specific Orchestra/Harness navigation on native Windows, preserving the existing production Linux source paths for their own runtime.

## Hooks, gates and rules

Keep the existing Windows-native configurator and the installed identity map as authoritative. Its SessionStart, SubagentStart, SubagentStop, Stop, Office events, documentation closeout and memory hooks remain owned by the configurator, not the dashboard editor or OpenMausBot. Never create competing hooks, a second single-writer MemoryCore capture path or a shadow RepoQL index.

The `singularity-code-reviewer` is the single, read-only implementation reviewer. Documentation and evidence gates remain controlled by the established Claude Code workflow. A maintenance bot must not self-approve a policy change or suppress a failing gate.

## Singularity Maintainer

One Windows-local OpenMausBot bot named `Singularity Maintainer` is defined by `native/windows/openmausbot/SINGULARITY-MAINTAINER.md`. It is designed to repair real, project-owned configuration, integration, memory and documentation defects using existing installers and verifiers. The read-only diagnostic entrypoint is `native/windows/openmausbot/maintenance_audit.mjs`, which reuses the source's existing Claude and MCP verification functions and the OMB shared-rules verifier. It never repairs anything by itself.

A production Maintainer needs an actual locally running product-owned headless OpenMausBot instance (or an authenticated paired desktop instance), one registered bot identity, authorised repair tools and a supported OMB scheduled check. It must demonstrate one controlled failing check, a limited fix, independent readback, a genuine Markdown report and an acknowledged message in its own OMB chat. Creating a template or installing shared `AGENTS.md` is not provisioning evidence. Do not automatically claim that scheduled checks or chat delivery work.

## Acceptance on Windows

1. Apply these source changes to the **verified current** repository tree; regenerate source hashes/manifest and rebuild the Windows product through the existing release pipeline. A source archive is not an installed MSI.
2. Verify installed Claude Code agents are the fifteen selected roles. Verify only the six delegation roles get their own MemoryCore profiles and Ghost retains its own identity. Verify all appropriate hooks and documentation closeout rules independently in an actual Claude Code session.
3. Log in to the native Windows dashboard and edit the Code Reviewer or Board definition. Confirm an unchanged revision is rejected on a second save, the original backup exists, a foreign agent is not editable, and the updated instructions load in a new Claude Code delegation. Verify cross-origin writes are rejected.
4. Verify live RepoQL tool calls, Kanzo read/write, MemoryCore capture plus subsequent recall, and an OpenMausBot bot message through the official paired local MCP. The MCP inventory alone is not sufficient.
5. Register one Singularity Maintainer in OMB, run the diagnostic check, repair a controlled project-owned defect, verify the repair, inspect its Markdown report and independently read back its OMB chat message.
6. Check Ghost scheduled job execution, Office event delivery, restart/reboot and uninstall/rollback, plus dashboard desktop/mobile presentation. Do not publish a ready verdict until the selected advertised capabilities pass.

## Source-only tests executed here

The patch contributor validated Python security/unit tests, Claude Code roster and memory hook tests, Windows native configuration tests, OMB MCP/shared-rule tests and dashboard JavaScript contracts in an offline Linux source checkout. These are **not** Windows native acceptance and cannot certify runtime integrations, service creation or bot provisioning.

The source-only OMB provisioning helper is `native/windows/openmausbot/provision_maintainer.mjs`; it uses the vendor `team apply` contract rather than modifying bot storage. No schedule, repair or chat delivery is claimed from provisioner success.

## 8 November dashboard mirror carryover

The latest dockerhost dashboard Agents Control UI was reconciled selectively. Windows now adds searchable agent rows, a local Claude model chooser, metadata-only backup history, and registration-only user/project rules and hook inventory. No Pi/OpenCode model settings, Linux mutator, canonical Linux AGENTS.md sync, dockerhost OMB ledger or host-specific dashboard routes were carried into Windows. See `docs/WINDOWS-DASHBOARD-MIRROR-RECONCILIATION-20261108.md` for source timestamp, explicit exclusions and remaining Windows acceptance.
