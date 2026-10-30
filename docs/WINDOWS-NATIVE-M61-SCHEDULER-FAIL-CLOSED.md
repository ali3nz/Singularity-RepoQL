# Milestone 61 — Fail-closed Windows task scheduler guards on state changes

The native installer previously checked for an existing supervisor task using
`Get-ScheduledTask -TaskName ... -ErrorAction SilentlyContinue`. An access,
service or query failure could appear as task absence and allow destructive
staging/configuration changes while an active logon task still referred to the
staged binaries.

The shared `Assert-SupervisorTaskAbsent` precondition now requires a successful
scheduler enumeration and refuses the exact Singularity supervisor name.
A failed enumeration is **unknown**, never a green light. The guard applies
to stage promotion (including a first-time stage with a stale task), stage
rollback, first-stage retirement/restoration, and direct configuration
rollback. Task unregistration is a separate owner-checked, operator-approved
step. This does not stop or delete arbitrary Windows tasks.

Focused structural tests check the error-handling and call sites. Real Windows
PowerShell, scheduler permissions and reboot behavior are **unverified**.
Release remains **BLOCKED**.
