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
