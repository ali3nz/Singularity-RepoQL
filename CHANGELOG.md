# Changelog

All notable changes to this release are recorded here. The repository is
distributed as a release candidate until the capability gate reports VERIFIED
for every mandatory capability of the chosen installation option.

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
