# RUST-REWRITE-CONTRACTS — protocols, schemas and guards

These are the behaviours a change must preserve. Each row names the code that implements
the contract and a focused command that exercises it. Nothing here requires a live
Windows host except where stated.

## 1. RepoQL connector contract

| Item | Value | Source |
|---|---|---|
| Required RepoQL version | `1.7.18` | `native/windows/repoql_compat.py` (`REQUIRED_VERSION`) |
| Connector contract | `fetch-render` | same (`REQUIRED_CONNECTOR_CONTRACT`) |
| Required calls | `parse`, `fetch`, `render` | same (`REQUIRED_CALLS`) |
| Bundled connector manifests | `connectors/kanzo/manifest.yaml`, `connectors/memorycore/manifest.yaml` | same (`MANIFESTS`) |
| Version check | fail-closed; an ambiguous banner is rejected | `parse_version()` |

Focused checks:

```bash
python3 native/windows/repoql_compat.py --help
python3 -m unittest discover -s native/windows -p 'test_rust_repoql_preflight.py' -q
python3 native/windows/verify_option2_connectors.py    # Windows host, installed tree
```

Read/RepoQL URIs stay forward-slash (`repoql://...`, file paths passed to `rql read`) on
every platform. Do not pass Windows backslash paths into connector calls; convert at the
boundary (`Path.as_posix()` in Python, `replace('\\','/')` in JS shims).

## 2. CLI, stdio and pipe semantics

- MCP launchers are transparent pipes: stdin/stdout/stderr of the child are forwarded
  unchanged, no framing or console decoration.
  Source: `native/windows/openmausbot/claude_mcp_launcher.mjs`,
  `native/desktop-bridge/src/repoql_compat.rs`.
- No-console rule: nothing in the Rust binaries prints a banner to stdout that a caller
  parses. Diagnostics go to stderr, structured results to stdout.
- Exit codes are the contract: `0` success, non-zero failure with the reason on stderr.
  Do not add a "success" JSON body on failure.
- Capture and doc-ledger binaries keep single-writer discipline: one process owns the
  ledger at a time; a second writer fails rather than interleaving.

## 3. Receipts and correlation

Receipts are the correlation mechanism; there is no separate trace id.

| Receipt | Schema | Written by |
|---|---|---|
| Staging receipt | `schema: 1`, `state: STAGED_UNVERIFIED`, `option: 2`, `repoqlVersion: "1.7.18"` | `stage-native.ps1`, consumed by `install_claude_complete.ps1` |
| Task preimage | `wave56-verified-task-preimage/v1` | dashboard task transaction |
| Task/manager receipt | `singularity-claude-complete-dashboard/*` (schema, option, taskName, arguments, binary paths) | `manage_claude_complete_dashboard.ps1` |
| Parent proxy receipt | `.singularity-parent-memory-proxy-receipt.json` | `install_claude_complete.ps1` parent modes |
| MCP receipt | `.singularity-native-mcp-receipt.json` | `Configure` |
| Assembly receipt | `wave56-synchronized-assembly/v1` | `fleet-1266` assembly driver (historical) |
| Cutover receipt | `wave56-windows-cutover/v1` | cutover driver (historical) |
| Delivery receipt | `singularity-rust-rewrite-handoff/v1` | this build (`_delivery/DELIVERY.json`) |

Rules:

- A receipt that names a binary must record its SHA256; consumers re-hash and refuse drift
  (`STAGED_BINARY_HASH_DRIFT`).
- A receipt whose `schema`, `option` or owner does not match is refused
  (`UNOWNED_STAGE_RECEIPT`, `TASK_TRANSACTION_VERIFIED_BACKUP_REQUIRED`).
- Receipts are never edited in place to change history; write a new one and keep the old.

## 4. Guards a change must not widen

| Guard | Implementation | Focused check |
|---|---|---|
| Single writer (ledger, capture) | `scripts/memory-doc-ingest.py`, `scripts/memory_turn_capture.py`, `harness/kit/lib/state-lock.mjs` | `python3 tests/test-memory-doc-ingest.py`, `python3 tests/test-memory-security.py` |
| Role / identity scope | `scripts/memory-config-loader.mjs`, `dashboard/local_account.py` | `python3 -m unittest discover -s dashboard -p 'test_variant_features.py'` |
| Claim / lease / busy lane | `harness/kit/lib/run-registry.mjs`, `resource-lease.mjs`, `engine-state.mjs` | `node --test harness/kit/lib/*.test.mjs` (runner-dependent) |
| Ownership / preimage | `install_claude_complete.ps1`, `task_action_transaction.ps1` | Windows: `-Mode VerifyInstalled`, `DashboardVerify` |
| Capability gate | `native/windows/configure_capability_gate.ps1`, `singularity-capability-gate` | protocol fixture receipt (historical) |
| Credential boundary | `scripts/redact-memory-startup.py`, hook redaction tests | `python3 tests/test-memory-security.py`, `node --test adapters/claude-code/memory-hook.test.mjs` |

A change that removes, bypasses or widens any of these is a gate change, not a refactor.

## 5. Transport and fixtures

- The compiled listener/gateway transport is exercised by 27 recorded cases
  (26 reused, 1 fresh) with 10 locality-guard tests. The historical receipt is
  `docs/rust-rewrite-evidence/listener-fix-v4-parity-result.json`; it records the source
  deltas and the reused receipt digests.
- Fixture sources live in `native/windows/unified-gateway-rust/tests/` and
  `tests/fixtures/doc-ingest/` (`wave19-chunk-golden.json`,
  `parity/python-observations.json`).
- Doc-ingest parity: `node --test tests/doc-ingest-parity.test.mjs`,
  `node --test tests/doc-ingest-rust-boundary.test.mjs`,
  `python3 tests/test-memory-doc-ingest-rust.py`.
- Rust capture parity: `node --test tests/rust-document-learning-boundary.test.mjs`,
  `native/windows/memory-parity-rust/tests/differential_document_learning.py` (needs the
  compiled binary).

## 6. Focused commands by area

Linux or Windows, from the repository root:

```bash
# packaging / release contract
python3 native/windows/verify_source_release.py
python3 -m unittest discover -s native/windows -p 'test_windows_source_ci.py' -q
python3 native/windows/build_source_variants.py --output-dir /tmp/src --variant 2
python3 native/windows/scan_source_archive.py /tmp/src/singularity-native-windows-option2-SOURCE-ONLY.zip

# Rust locks and builds
python3 native/windows/check_rust_lock_provenance.py
cargo test --manifest-path native/windows/unified-gateway-rust/Cargo.toml --all-targets --locked
cargo test --manifest-path native/windows/rust-supervisor/Cargo.toml --all-targets --locked
cargo test --manifest-path native/windows/memory-parity-rust/Cargo.toml --all-targets --locked
cargo test --manifest-path native/windows/rc-stack-rust/Cargo.toml --all-targets --locked
cargo test --manifest-path native/windows/release-evidence-rust/Cargo.toml --all-targets --locked
cargo test --manifest-path native/windows/source-packager-rust/Cargo.toml --all-targets --locked
cargo test --manifest-path harness/rust-authority/Cargo.toml --all-targets --locked
cargo test --manifest-path native/desktop-bridge/Cargo.toml --all-targets --no-default-features
cargo test --manifest-path native/desktop-bridge/Cargo.toml --all-targets --no-default-features --features office

# hooks / memory / dashboard
python3 tests/test-memory-security.py --windows-source
python3 tests/test-memory-promote.py
python3 tests/test-memory-doc-ingest.py
node --test tests/doc-policy.test.mjs
python3 -m unittest discover -s dashboard -p 'test_agentchat_rust_bridge.py'
```

## 7. Caller map (binary → who starts it)

| Binary | Started by |
|---|---|
| `singularity-windows-supervisorw` / `_service` | `register-supervisor-service.ps1` (service) |
| `singularity-windows-setup` | operator / Rust setup GUI; delegates to `install_claude_complete.ps1` |
| `singularity-dashboard-listener` | `dashboard/native_listener.py` when `-UseRustDashboardListener` |
| `singularity-dashboard-routes` / `singularity-unified-proxy` | dashboard registration when the matching switch is set |
| `singularity-memorycore-reader/writer`, `singularity-doc-ledger-*` | hooks and doc-ingest when the matching `SINGULARITY_*_BIN` is set |
| `singularity-memory-parity`, `memory-turn-capture` | capture scripts via `SINGULARITY_RUST_MEMORY_POLICY_BIN` |
| `singularity-release-evidence` / `singularity-source-packager` | release tooling and CI |
| `orchestra-observer` | harness observer sink (read-only) |
| `kanzo_board_audit` | Kanzo board audit in CI/release checks |

Anything not in this table is not started by the product; do not assume presence means
activation.
