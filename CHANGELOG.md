# Changelog

All notable changes to this release are recorded here. The repository is
distributed as a release candidate until the capability gate reports VERIFIED
for every mandatory capability of the chosen installation option.

## [0.1.0-rc10] - 2026-10-24

Second review round. A review of rc9 found that the acceptance path was still
partial and that the new owner check could not work from the CLI, so rc9 is
superseded.

### Fixed
- **Acceptance could persist halfway.** `accept()` advances review -> accept ->
  done inside one mutation, and a failure on the second step still wrote the
  first. A refused mutation now writes nothing: stage, status, history, evidence
  and `updatedAt` are byte-identical after a refusal, which also makes `accept`
  atomic.
- **`advance` accepted without checking the evidence files.** Only `accept()`
  called `verifyPack()`, so a direct reviewer/coordinator pair could complete a
  run whose file-backed evidence had changed. The integrity check is now part of
  `acceptanceCheck()`, so every path to `done` performs it.
- **A caller could assert the verdict.** `advance()` took a `verdict` option,
  and `accept()` always passed `"approve"`, so a recorded `changes_requested`
  could be overruled. The option is gone: the verdict is the last
  `review-verdict` recorded in the cycle, and it must be approving.
- **Pack identity ignored decision metadata.** `packHash()` hashed bytes,
  kind, producer and revision, so two reviews of identical text with different
  verdicts hashed the same. Metadata is now canonicalised into the hash.
- **`begin`/`advance` could not be used from the CLI.** The in-flight claim was
  a pid, and every CLI invocation is a new process, so a normal
  `begin` then `advance` pair always failed. The claim is now an owner token:
  `begin` prints it and `advance --owner <token>` presents it. A second `begin`
  while work is in flight is refused.
- **Stage scoping was incomplete.** Evidence was scoped by cycle but not by the
  stage that produced it, so a `test-output` captured while implementing could
  prove validation. Each requirement now names the stage(s) that may produce it.
- **The claim itself had a write window.** The claim file was created with
  O_EXCL and its pid written afterwards, so a competing dispatcher could read an
  empty claim, conclude the owner was gone and reclaim it — CI produced a real
  double launch this way. The claim is now created by linking a fully written
  temporary file, so its content exists the instant the name does, and a
  content-less claim gets a short grace before it is treated as dead.
- **Acceptance expiry was re-applied to history.** `health()` reran the approval
  check with the current time, so an accepted run flipped to `INVALID_EVIDENCE`
  an hour later, while `isComplete()` disagreed. Expiry now gates the act of
  accepting only; a completed run is judged on evidence integrity and approval
  scope. Both functions use the same definition, and `acceptedAt` is recorded.

### Added
- Regression tests for each item: refused mutations leave persisted state
  untouched, `advance --to done` verifies files, a verdict cannot be asserted,
  decisions are part of the pack hash, the owner token works across processes,
  evidence from another stage is not stage proof, and expiry does not
  un-accept a completed run. 47 Node subtests and 9 messaging scenarios.

### Documentation
- `docs/ORCHESTRATION.md` documents the owner token, stage-origin evidence,
  historical acceptance and metadata in the pack hash.

## [0.1.0-rc9] - 2026-10-24

> Superseded by rc10: acceptance could persist a partial transition, the
> direct `advance` path skipped evidence verification, a caller could assert
> the verdict, and the in-flight owner check could not work from the CLI.

Hardens the orchestration gates. An independent review of rc8 found bypasses in
the gates themselves, so rc8 is superseded: do not treat its orchestration layer
as a control boundary.

### Fixed
- **Acceptance could be forged.** `advance --to done` accepted a hand-added
  `approval` evidence entry and never consulted `run.approvals`. Authority now
  comes from the stored approval only: the evidence kind is reserved (the CLI
  refuses it), and the transition validates pack hash, revision, expiry,
  independence and seat identity itself.
- **Interrupted and blocked runs could advance.** A transition cleared
  `interrupted` and resumed as if the stage had completed. `advance` now refuses
  while a run is interrupted, paused, blocked or has another process's stage in
  flight; `orch-run reconcile` clears an interruption explicitly, changes no
  stage, and the step still needs its evidence. `resume` no longer clears one.
- **Approval identity was caller-asserted.** Any string was accepted as an
  approver, and `--revision` was used as both the claimed and expected revision,
  so a caller could satisfy the comparison. An approver must now be a declared
  reviewer or operator seat; the coordinator and implementers are refused; the
  revision comes from the run, and `approve --revision` is rejected.
- **Evidence was reusable across attempts.** After a correction, the previous
  cycle's diff and test output still satisfied the next attempt. Evidence is now
  stamped with its stage and cycle, and only the current cycle counts.
- **A free route could be declared, not verified.** `verifiedAt` and `evidence`
  were optional, so a route claiming zero pricing with no source was eligible.
  All four conditions are now required, and an incomplete declaration fails
  closed instead of being downgraded.
- **A live dispatch claim could be stolen by age.** The 900-second stale rule
  reclaimed a claim whose owner was still running, and a crash between launching
  and recording the outcome left the message launchable again. Reclaiming is now
  liveness-only, intent is recorded before the side effect, and an unconfirmed
  launch holds at exit 24 until an operator passes `--reconcile-unknown`.
- **`health` returned 0 for bad states.** `process.exit()` discarded the
  `exitCode` it set, so `STUCK`, `BLOCKED`, `FAILED` and `INVALID_EVIDENCE` all
  exited 0. `health` now returns the code directly, and accepted evidence that
  no longer verifies is reported as `INVALID_EVIDENCE`, not `COMPLETE`.

### Added
- `orch-run begin` (mark the current stage in flight) and `orch-run reconcile`
  (clear an interruption, changing no stage), so crash recovery is exercisable
  from the CLI instead of only from module tests.
- Regression tests for every finding above: forged acceptance, blocked and
  interrupted transitions, cross-process in-flight advance, cycle reuse,
  seat-identity approval, revision binding, unverified free routes, claim
  liveness, unknown dispatch outcome and `health` exit codes.

### Documentation
- `docs/ORCHESTRATION.md` corrected: the quick start no longer shows an invalid
  transition, verification is described as file-backed only, and the approval,
  cycle and interruption rules match the implementation.

## [0.1.0-rc8] - 2026-10-24

> Superseded by rc9. An independent review found that several gates described
> below could be bypassed; the release is kept only as history.

Optional portable orchestration. Nothing in the installer, the memory stack,
RepoQL, Ghost, Office or the existing coordinator changed; rc5-rc7 tags are
untouched.

### Added
- `scripts/orch-run`: operator CLI for orchestrated runs — `start`, `status`,
  `list`, `history`, `evidence`, `advance`, `approve`, `accept`, `pause`,
  `resume`, `stop`, `recover`, `verify`, `modes`, `health`. Every mutation is
  role checked; read-only commands are separate.
- `orchestration/state.mjs`, `runs.mjs`: durable run and case identity, one JSON
  file per run, atomic writes, append-only transition history.
- `orchestration/stage-machine.mjs`: six stages with an explicit transition
  table, per-stage evidence requirements and bounded retries. A stage with
  unknown result is marked `interrupted` and blocks; it is never completed.
- `orchestration/evidence.mjs`: hashed evidence entries bound to a source
  revision, a stable pack hash and an integrity check that re-reads the bytes.
- `orchestration/approvals.mjs`: identity-bound approvals carrying stage, pack
  hash, reviewed revision and TTL; stale packs and expired approvals are
  refused, and a coordinator cannot approve its own run.
- `orchestration/leases.mjs`: filesystem resource leases with owner, TTL,
  conflict detection and idempotent release.
- `orchestration/modes.mjs`: `solo`, `duo`, `quad`, `super`, `custom` and
  `free_only` as seat plans with authority, enforcing reviewer independence and
  a single coordinator when the plan is built.
- `orchestration/routing.mjs`: role-based, provider-independent routing with
  structured outcomes, retry classification, cost telemetry and a free-only
  policy that has no paid fallback. Verified-free requires declared zero pricing
  plus an explicit verification stamp.
- `docs/ORCHESTRATION.md`, `docs/CAPABILITY-MATRIX.md`: the operator contract and
  the source-level PRESENT/PARTIAL/MISSING/EXCLUDED comparison with the private
  reference, including what is deliberately not ported.
- 37 deterministic tests (`orchestration/*.test.mjs`, `scripts/orch-run.test.mjs`)
  wired into `tests/validate-local.sh` and therefore CI.

### Fixed
- `orch-chat --launch` could dispatch the same message twice from two
  processes. A per-message `O_EXCL` claim now makes at-most-once dispatch hold
  under concurrency; the second dispatcher exits 23 without launching.

## [0.1.0-rc7] - 2026-10-24

### Fixed
- `orch-chat dispatch-sol` recorded `status: launched` before it validated its
  launcher, so an unconfigured command, a dry run or a failed launcher could
  permanently consume a message. Configuration and template validation now run
  first, a dry run changes no state, and `launched` is recorded only after the
  launcher exits 0. Every failure path leaves the message retryable.
- `AGENTCHAT_WS_TMP` defaulted to an empty string, so `dispatch-sol` raised
  FileNotFoundError on a fresh install; it now defaults to `<state>/tmp`.

### Added
- `tests/test-orch-chat.py` scenario 6: unconfigured dispatch, incomplete
  template, dry run followed by a real launch, failed launcher followed by a
  retry, and duplicate-launch refusal.

## [0.1.0-rc6] - 2026-10-24

### Added
- `docs/RELEASE.md`: the two-layer release gate (public CI versus the operator
  run with the private overlay), the image-review step, the checksum ordering
  rule and the tag policy.

### Fixed
- The reference scanner pointed at `docs/RELEASE.md`, which did not exist; the
  document now ships with the repository and is indexed in the README.

## [0.1.0-rc5] - 2026-10-24

### Fixed
- Removed internal-only investigation material from the release tree.
- Removed private ticket identifiers and internal tool names from the agent-chat
  sources; the behavioural explanation each comment carried is preserved.
- Corrected two broken documentation links (`docs/ARCHITECTURE-ALIGNMENT.md`,
  `openchamber/plugins/product-office/README.md`).
- Corrected the README provider requirements: Groq and Cohere are the two
  shipped extraction routes, and additional OpenAI-compatible providers are
  documented as the optional secrets-directory file pair the router implements.
- Removed two screenshots that showed internal seat and lane names; the
  capability statement and the public fork link remain.
- `orch-chat dispatch-sol` no longer shells out to a private container path. It
  reads `AGENTCHAT_DISPATCH_CMD` (a shell template with `{case}` and `{id}`) and
  reports a clear unconfigured error when the variable is absent.

### Changed
- The disclosure guard is split in two: `tests/forbidden-refs.txt` is committed
  and carries generic shapes only, while `tests/forbidden-refs.local.txt` is
  gitignored and holds site-specific names. Public CI runs the generic guard;
  the release gate sets `FORBIDDEN_REFS_REQUIRE_LOCAL=1` and fails if the overlay
  is missing.
- The scanner fails closed on a missing, empty or malformed pattern file and on
  a grep error, instead of reporting a clean tree. Binary files are skipped by
  the text scan; image metadata is reviewed explicitly as part of the release
  gate.
- Added `tests/scan-refs.test.sh` (22 cases) covering public-guard parity,
  overlay detection, qualified versus unqualified issue references, CIDR
  handling, closed-failure modes and self-exclusion.

### Validation
- `tests/validate-local.sh` passed on the release commit: syntax checks, unit
  suites, manifest drift gate and the internal-reference scan.
- The reference scan also passed in release mode with the private overlay
  present.
- CI status for the tagged commit is recorded on the GitHub release page.
