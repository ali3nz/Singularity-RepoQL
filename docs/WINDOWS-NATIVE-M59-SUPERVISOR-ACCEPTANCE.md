# Milestone 59 — Read-only Windows supervisor task identity verification

The native Code Complete task registrar protects installation ownership, but
an existing task is **not** proof that the correct limited user logon trigger
and files survived installation or reboot. A separate `SupervisorVerify` mode
now checks the exact task name, executable and config arguments, identity,
limited run level, single logon trigger, enabled settings and existing private
files. It refuses foreign/changed tasks and never emits user names, paths,
arguments or config contents in its acceptance receipt.

Run after staged deployment and task registration, using the same explicitly
approved private supervisor config:

```powershell
.\native\windows\install_claude_complete.ps1 -Mode SupervisorVerify `
  -SupervisorConfig "$env:LOCALAPPDATA\Singularity\Private\supervisor.json"
```

This *does not* prove the supervisor process is running, child Job Object
containment, successful Office/Ghost startup, or reboot recovery. Those still
require independent Windows runtime tests and the versioned evidence matrix.
A missing task or mismatched task has a nonzero exit status. No service or
scheduler state is changed.

**SOURCE ONLY — RELEASE BLOCKED** until actual Windows task and runtime proof.
