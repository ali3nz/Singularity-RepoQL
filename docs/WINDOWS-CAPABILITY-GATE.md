# Windows capability retrieval gate

Last updated: 2026-11-14 — fleet#1307; reference contract fleet#1304.

## What it enforces

The native `singularity-capability-gate.exe` hooks Claude Code UserPromptSubmit
and Stop. Capability/access questions get HubDocs/RepoQL-first instructions.
Ordinary work and questions reviewing an earlier answer are not blanket-gated;
a present-tense follow-up about actual access is gated.

A routed answer needs successful tool-result evidence of reading the access
index and an owning skill/service Markdown document, plus acting identity,
operation, scope limit, verification status and checked source. A statement that
a document was read is not a tool receipt. RepoQL `read` and direct documentation
Read calls are supported; shell lookups must start with `rql read`.

The bundled access index is a dated fleet snapshot, **not permission granted to
this Windows account**. Prefer current HubDocs/RepoQL and probe the owning
surface. If this cannot establish a conclusion, use the exact unverified notice
given by the hook rather than infer fleet-wide absence from local tools.

## Claude Code boundary

One failed Stop check asks for correction. On another failure, or when
`stop_hook_active` already signals a retry, the hook stops with an explicit
unverified notice. It does **not** retract text already streamed to the UI.
Missing/corrupt/unwritable session state or a rotated/unavailable transcript
cannot establish routing: Stop then permits completion rather than blocking an
unrelated session or creating a retry loop. This is not Pi projection parity.
No live model call is needed to test this boundary. Documentation Read receipt
paths use forward slashes (for example `C:/policy/skills/google-drive.md`), or
use a RepoQL read URI for the current owning document.

## Install and verify

The hook executable must use the console subsystem: a GUI-subsystem executable
does not reliably wait/pipe through PowerShell and can lose stdin/stdout. The
Claude hook runner owns hidden process launch.

Build only this executable from `native/windows/rust-supervisor`:

```powershell
cargo test --locked --offline --bin singularity-capability-gate
cargo build --locked --offline --release --bin singularity-capability-gate
pwsh -NoProfile -File native/windows/configure_capability_gate.ps1 -Mode Inspect
```

The Apply mode requires independently verified settings, executable and policy
SHA256 values, plus `-Binary` and `-Policy` absolute input paths. Retain the
original settings bytes and ACL in the dockerhost task backup **before Apply**.
The installer refuses affected active Claude Code sessions (the independent
Claude Desktop app is not affected), foreign changes and existing destinations.
It appends exactly one group to UserPromptSubmit and Stop, verifies all sibling
settings structurally unchanged and preserves settings ACL. No services restart.

Installed root: `%LOCALAPPDATA%/Singularity/CapabilityGate-fleet1307`.
Per-session state is owner/System-only and retains routing metadata, not prompt,
answer or credential values. The installation receipt contains only hashes,
public paths and ACL metadata. Use a fresh Claude Code session after install.

## Rollback and troubleshooting

Retrieve the verified original settings from
`/mnt/newdata/backups/singularity-wave56/fleet-1307/`. Transfer privately and
hash-verify it before invoking the installer with `-Mode Rollback`,
`-RestoreSettings <original-file>` and `-ExpectedSettingsSha256 <current-hash>`.
Rollback requires current settings to match the installer's exact owned
postimage and the restore input to match the original hash. Later user edits
cause refusal, not overwrite. Installed files can remain inactive as evidence.

If Apply reports active sessions, wait or obtain explicit operator direction;
do not kill sessions. If a receipt check fails, use current docs through a
supported Read/RepoQL read tool, or give the exact unverified notice. Treat a
bundled snapshot as documented, not live-verified. No credential changes or
model/bridge probes are part of this installation.
