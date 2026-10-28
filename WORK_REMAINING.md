---
description: Known defects, unfinished integration, and acceptance gates for the native Windows WIP checkpoint.
tags: [windows, work-in-progress, release, acceptance]
---

# Work remaining

**This branch is a work-in-progress checkpoint, not a release.** Native Windows
support and the four installation options are not accepted end to end. Do not
use this checkpoint for production or treat a passing unit suite as release approval.

The checkpoint preserves the portable baseline at `5984d1e` and the native hook,
Node document-ingestion, and memory-supervisor work through source commit
`12fb568271c4ec729ef46e026372e817677febcc`. It is published as a snapshot on a
separate branch; the worker's intermediate history is not part of this checkpoint.
The separate orchestra-installer contribution at `8d90f181` is not integrated.

## Known correctness and data-safety defects

- [ ] **Normalize document reads before computing revision identity.**
  `scripts/doc-ingest-node.mjs` reads raw UTF-8, while the Python helper uses
  universal-newline text reads. Logically identical LF, CRLF, and CR documents
  can acquire different revision IDs and incorrectly appear stale. Apply one
  compatible source-read helper to classification, ingestion, status, and verify.
  Add LF/CRLF/CR/mixed-line-ending legacy-ledger and `UNCHANGED`/no-add regressions.
- [ ] **Protect live and successor ledger locks.** The two-minute directory-lock
  reaper can remove a valid slow writer's lock. The old writer's cleanup can then
  remove its successor's lock. Add ownership-safe release, live-owner protection,
  dead-owner recovery, and concurrent-record survival tests in Node and Python.
- [ ] **Make upgrade locking safe.** The old Python helper uses `.ledger.lock`
  with `fcntl`; the new helpers use `.ledger.lock.d`. They do not serialize with
  each other. Define and verify a safe upgrade procedure or compatibility guard.
  Do not run old and new document writers concurrently in the meantime.
- [ ] **Harden hook ownership and preservation.** A wrapper can be mistaken for
  an owned hook when our script is only a later argument. Require the actual
  invoked script, preserve foreign wrappers on merge/uninstall, handle user-added
  arguments without silently dropping them, and validate the `scriptPath` role.
- [ ] **Fix native path handling and command guidance.** Replace slash-based
  parent slicing in `doc-hook.mjs` with native dirname handling. Correct the stale
  Python interpreter hint and imprecise `status --file --all` example. Resolve
  Windows drive-letter parsing for `SINGULARITY_DOC_ROOTS` or document a safe
  supported alternative. Check nested-repository workspace detection.
- [ ] **Clean the native wiring patch without breaking it.** Nine whitespace
  findings remain in `docs/native-windows-wiring.patch`; verify patch applicability
  as well as the final diff check.

## Native memory runtime

- [ ] **Start and validate MemoryKnowledge.** It builds, but the recorded runtime
  startup fails with a missing `@opentelemetry/core` module. The handoff attributes
  this to incompatible OpenTelemetry peer requirements; that root cause is not yet
  fully established. Resolve and verify the dependency set, then verify health and
  an authenticated v3 read. Build success alone is not runtime acceptance.
- [ ] **Harden supervisor ownership and ACL verification before privileged use.**
  Missing executable/start-time fields bypass parts of the PID ownership check.
  Reject incomplete or forged manifests before signaling any process. Parse ACL
  principals rather than finding the username anywhere in `icacls` output. Test
  existing permissive files as well as newly created secrets. Do not install a
  privileged service with user-writable state until these checks are enforced.
- [ ] **Close supervisor lifecycle failure paths.** A manifest-write failure can
  leave started children without lifecycle authority. Roll back those children.
  Reject unsupported `--dry-run` combinations: `stop --dry-run` presently stops
  processes. Handle asynchronous spawn errors promptly and honor `stopTimeoutMs`.
- [ ] **Constrain preparation and child-process inputs.** Prove the staged source
  tree came from the verified archive; checking an unrelated archive is not enough.
  Pin build dependencies, remove hardcoded tool paths, restrict inherited credential
  environment variables, and verify actual listener addresses after startup.
- [ ] **Keep services alive across login/SSH-session boundaries.** The tested
  detached processes terminate when the Windows OpenSSH session closes. Implement
  and test an ownership-safe Windows service or scheduled-task lifecycle. Verify
  login/logout, reboot, stop, recovery, and data preservation.
- [ ] **Add a native MemoryProxy lifecycle.** The supervisor has no native proxy
  path. Define its configuration and validate startup, ownership, and shutdown.
- [ ] **Exercise `prepare` from a clean machine state.** The full command was
  dry-run and unit-tested; Core and Panel were built using the staging steps
  separately. Verify one clean end-to-end prepare, rebuild, and failure recovery.
- [ ] **Complete memory acceptance beyond raw storage.** Verify runtime extraction,
  cross-session agent recall, dreaming/provider authentication, and secret ACLs
  across the supported installation and service-account paths. Do not confuse raw
  write/search persistence across a process restart with cross-session agent recall.
- [ ] **Test Panel UI and authentication flows.** Health/root responses do not
  establish configuration, login, authorization, or browser workflow acceptance.

## Installer and orchestra integration

- [ ] Review and integrate the separate orchestra-installer contribution. Harden
  normal upgrades, launcher ownership, native home/symlink behavior, installation
  root ownership, and uninstall-ledger containment before accepting it.
- [ ] Attach must copy `doc-ingest-node.mjs` as the fifth runtime file. Installer
  calls must pass trusted recorded `previousScriptPaths`. Replace the Python retry
  hint in doctor, and fix the Windows/POSIX assumptions in installer tests.
- [ ] Verify the shared kit installation and real runtime for all four numbered
  options. Keep the kit as the engine authority and the Node launcher thin.
  Remove inherited remote-host assumptions from local selftests.
- [ ] Verify the same 17 permitted agent definitions in both adapters. Keep the
  excluded pentest/private integrations and guardian control code out of the
  public product. Keep the dashboard opt-in.

## Application and public-source acceptance

- [ ] Complete real **Claude Desktop Code-tab** acceptance: installed configuration,
  startup and memory hooks, orchestra operation, upgrade, uninstall, and rollback.
  CLI startup-hook evidence does not establish GUI acceptance or model authentication.
- [ ] Complete real **OpenChamber GUI/plugin** acceptance using the native runtime,
  preserving existing credentials, configuration, projects, and memory data.
- [ ] Resolve public availability of the required
  [Office fork](https://github.com/ali3nz/claude-office) and pinned commit
  `95d8bdc5728b23bcf0fee4c371b35e071c44f642`. Anonymous checks returned 404.
  Options 2/4 are not publicly reproducible until this is resolved. Do not change
  repository visibility or substitute another build without owner authorization.
- [ ] Verify Office read-back and the full option matrix: **1/3 exclude Ghost and
  Office; 2/4 include both**. Dashboard installation remains optional.
- [ ] Do not claim full OpenChamber application parity: the referenced app delta
  is not publicly available, and its apply script intentionally refuses it.

## Evidence and release gates

Evidence is revision- and environment-specific:

- The portable baseline passed 99 targeted tests and 626 selftests with one skip.
  Those results predate the native additions.
- The independent native D2 rerun at `509362a` produced **98 pass, 1 fail, 7
  Python-only skips**. The remaining failure exposed the newline defect above.
  D2 has a blocking independent review; its requested corrections are not included.
- Native Claude Code 2.1.303 executed the shipped documentation startup hook using
  isolated `--init-only` settings. It accepted the context and wrote a baseline.
  Exec-form arguments preserved spaces and an apostrophe. No conversation prompt
  was supplied; Desktop GUI and memory hooks were not established by that probe.
- The D3 handoff reports **15 pass, 0 fail** on native Windows. Its retained
  evidence records loopback Core/Panel health, authenticated raw write/search,
  marker persistence across restart, shutdown, foreign-port refusal, PID ownership
  checks, and a restricted secret ACL. These do not prove the missing runtime gates.
- Independent checks of this checkpoint on native Node 22.23.4 repeated **15 pass,
  0 fail** for the supervisor. Four focused hook/platform/ingestion/parity suites
  produced **40 pass, 1 fail, 7 skips** from a CRLF checkout. The failure is the
  same recorded-Python newline compatibility defect, not a green acceptance run.

Before a release:

- [ ] Fix the correctness/data-safety blockers and obtain a fresh independent review.
- [ ] Run the native suites from a fresh default-CRLF checkout with isolated HOME
  and explicit test Git identity. Report failures and skips rather than weakening
  compatibility assertions.
- [ ] Verify all four clean-install paths plus upgrade, uninstall, and byte/data
  restoration. Complete live kit, GUI, memory, and Office acceptance.
- [ ] Finish README/usage/runbook coverage for the dashboard, knowledge/connectors,
  harness, kit, agents, supported platforms, and known licensing/dependency limits.
- [ ] Resolve combined-work licensing before making redistribution claims. The
  RepoQL engine is commercial/unbundled; Kanzo remains a separate AGPL process.
- [ ] Regenerate and verify distribution checksums after final content changes;
  run the public-reference/secret scan and fresh-clone validation.
- [ ] Obtain final release approval before tagging or promoting this WIP branch.

Further development and validation must be **native Windows, without WSL**.
Do not stop unrelated services to free ports. Keep tests isolated, preserve user
data and rollback copies, and never commit credentials or runtime scratch data.
