# Milestone 65: fail-closed Windows supervisor task registration

The standalone `native/windows/register-supervisor-task.ps1` now treats scheduler query failures as **unknown**, never as task absence. Existing tasks must have exactly one expected action and logon trigger, approved current-user principal, limited runlevel, and enabled settings before registration, removal, or "already registered" status. Duplicate task names are refused, and registration/removal are independently read back. No task is registered or removed by source tests.

Run the real registrar and `verify_supervisor_task.ps1` with explicit operator approval on a clean native Windows test account, including scheduler denial, duplicates, modified triggers, ACL restrictions, task removal and re-enumeration. Confirm actual process start and reboot behavior separately. Source tests inspect required code paths only; they **do not execute PowerShell**. `releaseReady:false` persists.
