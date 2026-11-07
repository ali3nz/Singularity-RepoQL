---
description: Verified native Windows candidate behavior and the limits that prevent full release certification.
tags: [windows, release, acceptance, claude-code, memory, documentation-ingestion]
---

# Native Windows release candidate acceptance

The complete native package has been exercised on one Windows x64 workstation. Reboot/logon startup, Claude desktop Code-mode tool discovery, parent-conversation capture, and automatic documentation ingestion passed the checks below. These results support evaluating the source candidate. They do not certify a signed binary installer, every provider, every connector workflow, or every supported platform.

## Verified behavior

| Check | Observed result | Boundary |
| --- | --- | --- |
| Reboot and genuine logon startup | After an actual reboot and user sign-in, all four product tasks started automatically. The post-reboot verifier passed 26 checks with no failures or warnings. | No manual task starts were used for this acceptance run. |
| Core services | Dashboard, Office, Ghost, and the MemoryCore gateway, core, and panel answered their probes after logon. | Health does not establish extraction, recall quality, or provider failover. |
| RepoQL in Claude desktop Code mode | A fresh GUI session explored the source repository using RepoQL. | RepoQL must be pointed at a repository, not the user's home directory. |
| Kanzo in Claude desktop Code mode | The actual `list_projects` MCP call returned a successful empty-project result in the configured workspace. | Registration is project-scoped. No project was created and no write operation was tested. |
| Fresh parent-conversation capture | Read-only MemoryCore queries returned both user and assistant messages from three fresh GUI sessions. The stored content matched the corresponding transcript turns. | These checks verify capture and persistence, not L1 extraction or new-session semantic recall. |
| Office | The served build and authenticated layout matched the approved assets. The browser rendered the canvas without JavaScript errors; the overview WebSocket returned a state update. The operator accepted the live Office check. | The operator's visual acceptance is separate from the automated build/layout checks. |
| Office source recovery | Canonical Restage verified 1,351 source files, preserved 3,885 protected runtime files and task XML, and retained all 1,343 previous-source files. Start succeeded as a separate action. | Restage does not start the task automatically. |
| Automatic document ingestion | The installed SessionStart hook recorded a baseline. A harmless Markdown canary was then created, and the installed Stop hook discovered it and reported `DOC_INGEST_INDEXED`. An independent ledger check returned `DOC_INGEST_VERIFIED`; a separate live search retrieved its exact marker and revision. | This was a scripted execution of the installed native hooks with the workspace as the process working directory. No manual ingest call, mock gateway, or manual memory write was used. It was not a GUI-driven document edit. |

## Test results and remaining limits

Focused validation included 76 parent-hook tests, a Python discovery run of 248 tests with three skips, and an installed-Node run of 532 tests with 526 passing and six explicit skips. The later Office lifecycle regression run passed all 27 tests. The full Node diagnostic discovery on the repaired tree completed **868 tests with 831 passes, 0 failures, and 37 explicit skips**; the native Python discovery completed **266 tests with 3 skips**. A Linux source-control run on Node 22.14 completed **868 tests with 844 passes, 0 failures, and 24 explicit skips**. The parser overlay's separate image-integration suite ran inside the pinned image: **21 tests, 19 passes, 2 skips** because the archived failure dumps were not available. The new dashboard shortcut contract suite ran on Windows with **5 tests, 5 passes, no skips**, using temporary Desktop and asset directories; no shortcut was created on the real Desktop. The 37 skips are labelled prerequisites, not silently disabled assertions: pinned memory-hub image artifacts, Python 3 differential cases, the legacy Docker/Ubuntu installer path, absent compiled native Rust binaries, the POSIX Claude CLI shell-stub fixture, and POSIX-only mode checks. Each result applies to its tested scope, not to the whole product.

The earlier pre-fix diagnostic run was **not green**: 821 tests included 776 passes, 29 failures, and 16 skips. The diagnosed mechanisms were repaired and the repaired tree's final full run is the 868-test result above. The earlier result remains historical; it is not converted into a pass.

The following remain outside this acceptance:

- A clean-machine and ARM64 certification matrix, publisher signing, and a turnkey binary installer.
- Full provider failover, extraction, semantic recall, and connector end-to-end certification beyond the specific checks above.
- GUI-driven document creation, RepoQL readback of that document revision, and document revision/supersession recovery under concurrent writers. The successful canary verifies the MemoryCore ingestion path, not a two-store acknowledgment.
- The private-inventory disclosure scan, complete shipped-image review, exact-commit CI, and other gates required before creating a release tag under [Release gate](RELEASE.md).

Historical milestone documents retain their own checkpoint results and unresolved items. Use [Native Windows installation](NATIVE-WINDOWS-INSTALLATION.md) for the complete-package procedure and [Document ingestion](DOC-INGESTION.md) for ledger and retrieval semantics. Do not interpret a source push as passing the tagged-release gate.
## Fleet861 release-candidate isolation (2026-11-05)

A release candidate is installed beside the live product, so package identity and runtime roots are acceptance criteria, not cleanup afterwards. `installer/Test-RCIsolation.ps1` is the read-only pre-install gate: it installs nothing, stops nothing, and exits `0` only when isolation is demonstrated.

| element | production package | Fleet861 RC package |
| --- | --- | --- |
| MSI UpgradeCode | `A4059181-F59A-4C8D-B098-E26C9111B74E` | `7F2C4D19-5A6B-4C7E-9B3D-1E8A0C5D2F61` |
| MSI ProductCode | build-assigned | pinned `3C9A51E7-8B24-4D6F-A0C5-6D7E9B1F4A28` |
| Install directory | `<ProgramFiles>\Singularity RepoQL` (per-machine) | `%LOCALAPPDATA%\Singularity\Fleet861RC` (per-user, no elevation; `C:\Users\Ben\AppData\Local\Singularity\Fleet861RC`) |
| Bundle UpgradeCode | `E83EDB61-178B-4CD3-92F0-9C97E6D6292F` | `B1D6E4A9-3F58-47C2-8E90-2A5C7B3D4186` |
| State root | `%LOCALAPPDATA%\Singularity\WindowsNative` | `%LOCALAPPDATA%\Singularity\Fleet861RC\state` |
| Dashboard port | `18100` (gateway `18101`, tunnel `18128`) | `18200` |

The RC payload is files only. `installer/Configure-Singularity.ps1` is deliberately **not** the RC launch target: it writes to the live `%LOCALAPPDATA%\Singularity\WindowsNative\memory` tree and targets port `18100`, so invoking it from a candidate install would mutate the running product. `SingularityRepoQLRCBundle.wxs` launches the read-only `Readiness.ps1` instead. Any RC runtime that needs its own state and port must take them from validated local configuration, not from the production wizard.

Measured on Windows host `ALI3NZ` at `2026-11-05T12:08:43Z`, against the approved per-user root `%LOCALAPPDATA%\Singularity\Fleet861RC` and before any MSI was installed: **18 of 18 isolation checks passed, exit code 0**, covering distinct MSI/Bundle identities, distinct install-directory name, `perUser` scope with the install root under `%LOCALAPPDATA%` and not under `<ProgramFiles>`, a disjoint and absent RC state root, a read-only readiness launch target, a free port `18200` outside the production ports, no Fleet861 ARP entry, and all seven production scheduled tasks still present. The receipt is `installer/RC-ISOLATION-RECEIPT.json` when `-ReceiptPath` is supplied.

Also measured in this lane: the dashboard contract suite ran **189 tests, 1 skip, exit code 0** on the Linux build host, and on the Windows host **189 tests with 5 failures and 13 errors** after the fix below. The remaining Windows failures are test-harness gaps on that host, not passing checks: `zoneinfo` has no `tzdata` (0 available time zones, so the Ghost NZ-time cases cannot resolve), SQLite handles held by the App outlive `TemporaryDirectory` cleanup on Windows, one assertion compares `D:\State` with the literal `D:/State`, and the variant/usage cases expect upstream data while `SINGULARITY_WINDOWS_NATIVE=1` correctly fails closed with `windows_local_unified_gateway_unverified` when no verified gateway executable is configured. `dashboard/harness_rust.py` was fixed: `_default_token_file()` no longer calls `Path.home()` unguarded, which raised `RuntimeError` on Windows when `USERPROFILE` was absent and aborted `App` construction, taking the four real-listener auth and panel-boundary tests with it. Those four now pass on Windows, including unauthenticated `401` for every embed handshake, cross-audience cookie rejection, and refusal to expose the Kanzo MCP through the panel proxy.
