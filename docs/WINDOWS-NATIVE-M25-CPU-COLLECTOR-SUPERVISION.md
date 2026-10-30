# Milestone 25: native CPU collector supervision integration

Release state: **SOURCE ONLY — WINDOWS ACCEPTANCE BLOCKED**. RepoQL is pinned to **1.7.18**, connector ABI 1. This changes neither production Docker host nor upstream GitHub main.

## What is integrated and tested offline

- `dashboard/native_cpu_history.py` now exposes `collect_once` and `run_collector`. An unavailable RepoQL status produces a stored **gap**, never a fabricated zero. A database write failure is fatal rather than hidden by a second failed write; the Rust supervisor may then detect the child exit and end its owned stack. The existing retention and four-option SQLite isolation remain.
- `record` independently checks **Rust source label, exact sampled PID, process creation FILETIME, and RepoQL host startedAt** before accepting CPU data. A wrong PID now produces `identity_mismatch` even if timestamps happen to coincide.
- `native/windows/build_cpu_collector_component.py` generates a **read-only JSON component preview** for the Rust supervisor. This uses explicit native Windows paths for `python.exe`, `dashboard/native_cpu_history.py`, dashboard config, `singularity-desktop-bridge.exe`, and `rql.exe`. No task/service is registered, no process is launched, no credential is placed in the generated component. This is suitable for adding as an opt-in component to the installed supervisor's v1 JSON stack **only after native preflight**.
- The generated interpreter arguments use `-E -s -B` (not `-I`). `-I` was directly tested and found to break the collector's sibling imports. `-E -s -B dashboard/native_cpu_history.py --help` was directly executed successfully in this environment.
- The Rust supervisor already owns configured child process handles through a Win32 Job Object and checks for unexpected child exits. The collector's component has **no HTTP readiness endpoint**; `health: null` is intentional and is not proof of functional health.
- Python unit tests use actual SQLite writes with simulated RepoQL/Rust responses, including restart/PID mismatch, storage failure, four-option isolation and a continuous loop. Nothing in these tests confirms real Windows process-time values or installed lifecycle.

## Preview example (not an installation command)

```powershell
python native/windows/build_cpu_collector_component.py `
  --variant 3 `
  --python-exe 'C:\Python312\python.exe' `
  --dashboard-dir 'C:\Users\Example\AppData\Local\Singularity\current\source\dashboard' `
  --dashboard-config 'C:\Users\Example\AppData\Local\Singularity\config\dashboard.json' `
  --bridge-exe 'C:\Users\Example\AppData\Local\Singularity\current\bin\singularity-desktop-bridge.exe' `
  --repoql-exe 'C:\Program Files\RepoQL\rql.exe'
```

**Do not copy these example paths as a live configuration.** Choose paths that exist on the actual Windows installation. Verify owner-only ACLs, no reparse points/UNC/device paths, Python runtime version and signature, RepoQL version 1.7.18, and the bridge build provenance. Generator validation is syntactic only. The Rust supervisor itself must execute `check` against the complete stack, and all four variants need independent acceptance.

The generated `supervisorComponent` object must be inserted into the `components` array of the private v1 supervisor configuration. Do not replace other components or write tokens into the config. Obtain an operator-owned configuration backup and run preview/check first. The supervisor is not a Windows service installer yet and the source variant ZIP is **not** executable.

## Required Codex / native Windows acceptance

1. Compile and format/lint `native/desktop-bridge`, `harness/rust-authority`, `native/windows/rust-supervisor`. Run Windows-only named pipe, Job Object and process ownership tests. Any failures block installation.
2. Verify `python -E -s -B dashboard/native_cpu_history.py --help` under the chosen local Python runtime. Ensure the installed `current/source/dashboard/` layout matches the generator.
3. Run one-shot collector for each profile. Confirm RepoQL `host.pid` and `host.startedAt` match Windows process creation times. Read back the database directly; verify no older Linux `cpu.db` is read.
4. Add component to the private supervisor config (after creating a backup), run its `check` mode, then run the supervisor under an isolated test user. Confirm collector activity, actual `/api/cpu` figures, and each profile's isolated database.
5. Restart RepoQL while sampling. PID reuse, FILETIME mismatch and unknown Rust samples must become gaps and recover only on a new verified identity. Test disk-full/permission failures: collector must exit and supervisor must not report it as healthy.
6. Stop supervisor, reboot, upgrade, roll back and uninstall. Confirm no orphaned collector, no execution outside the owned Win32 Job, no silent overwrite of another installation's state, and correct Task Scheduler ownership.
7. Test four actual GUIs for usage attribution, optional features, provider quotas as **unknown when unverified**, memory ingestion and graph/agent behavior. Capture signed/dated production and native-Windows behavioural receipts; do not infer parity from reachability.

## Known blockers

Real Rust compilation, Windows Python/runtime packaging, actual native OS security and process identity, real RepoQL 1.7.18 connector reads/writes, Tencent/MemoryKnowledge, Harness, Kanban, Agent Chat, Ghost and Office services, and entire production-equivalent self-learning cycle remain unverified. No Claude Code free workers are assumed. Preserve the working Claude Office server token-URL authentication path in options 2/4.
