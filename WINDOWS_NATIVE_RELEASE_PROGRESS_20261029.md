# Singularity RepoQL: native Windows release engineering, Milestone 5

Date: 29 October 2026 NZDT. Baseline Git source archive 4f3d0f971f09ec677e7d4e5e49147476c054b311, superseding Milestone 4 in this development workspace. No WSL dependency is intended. **WIP SOURCE ONLY, NOT PUBLIC RELEASE READY.**

## Work implemented in this milestone

1. `native/windows/variants.json` is a machine-readable contract for all four GUI combinations. Claude Desktop Code tab options 1/2, OpenChamber Desktop options 3/4, RepoQL dashboard, Tencent connector, Kanban and Agent Chat in all, Ghost and Office only 2/4.
2. Rust `singularity-desktop-bridge variant 1|2|3|4` consumes the same contract; Office transport is now an optional Rust build feature (`--no-default-features` lean, `--features office` complete). This is still uncompiled source in this environment.
3. Dashboard Python backend exposes variant metadata and blocks Ghost and Office API, embed and static routes server-side for 1/3. Browser navigation and hash routes match. Ghost JS is dynamically imported only when the feature is actually enabled. This is routing control; it does not install underlying native services.
4. Transitional Windows file-lock adaptor removes the unconditional `fcntl` import error from dashboard components; sensitive graph annotation writes refuse on Windows until ACL-sealed Rust storage exists. RepoQL host-process/CPU metrics report unavailable rather than fabricating Linux `/proc` data.
5. Refactored MemoryCore config and idempotent reconciliation into shared core modules so lean source packages do not import excluded Ghost/Office modules. Verified actual extracted option-1 package resolves its Claude installer and memory hook without the optional modules.
6. Deterministic, checksum-bearing source-only archives for all four variants, with Ghost/Office source absent in 1/3 and present in 2/4; `scripts/bundle-classification.mjs` now classifies `native` source and optional app modules. These ZIPs have no executables, services, secrets or WSL requirements and are **not installers**.
7. Added `docs/WINDOWS-NATIVE-RELEASE.md` with an explicit clean-Windows-machine acceptance checklist and compatibility gates for GUI, Tencent, RepoQL, Kanzo and Agent Chat.

## Tests actually run here

- Node focused baseline + source packaging tests: 60 passed, 0 failed.
- Node memory-core separation / Claude hook and Office tests: 39 passed and 20 passed in focused runs (overlap with the 60-test suite; do not sum).
- Python feature policy tests: 4 passed; native file lock POSIX baseline: 1 passed; HTTP variant route tests: 3 passed. Total 8 Python focused tests.
- Source verifier: 19 mandatory source paths checked; four variants match feature contract; PASS STATIC ONLY.
- Extracted option-1 ZIP smoke test: imports legacy Claude installer and new shared memory hook without Ghost/Office: PASS.
- ZIP integrity and SHA256 per-file receipts: verified by builder (source ZIPs). This proves archive consistency, not native Windows compatibility.
- `cargo`, `rustc`, real Windows GUI, target RepoQL binary and native services **not available here**. No Windows compilation, Rust tests, Electron runtime, Office UI receipt or native installer acceptance was performed.

## Blocking defects / work before public release

- Native Windows Rust bridge has not yet compiled; CI run is not observed. Run rustfmt, cargo test, clippy and release builds on Windows with both Office feature sets.
- A full native Windows MemoryCore / MemoryKnowledge / MemoryProxy startup and Windows Service or Task Scheduler registration are not proven. The older Node supervisor has unsafe PID ownership and failure cleanup behaviour; do not reuse it unchanged.
- Automatic native GUI session capture, full L0-L3 recall, identity isolation and end-to-end persistence/verify/retry are not implemented to completion in Rust.
- Actual Claude Desktop Code-tab hooks, OpenChamber Desktop plugin loading and GUI MCP calls remain unverified. Native reversible installation and Windows credential ACL protection are still missing.
- RepoQL connector ABI must be tested against the exact Windows rql.exe. The Kanzo README records a working 1.7.15 `abi:1` and a failure under 1.7.17, so installing the connector without this check is unsafe. Tencent connector needs the same compatibility test.
- Native dashboard process metrics and annotation writes need Windows Rust implementations. Its legacy Linux Docker/WSL deployment paths and `/proc` collector are not a native installer.
- Kanzo board server, Agent Chat durable notification service, Claude Office renderer and Ghost backend are still external processes without a verified Windows install/lifecycle story.
- Third party licences, agent/prompt data privacy, actual dashboard authentication/browser tests, clean-VM upgrades/rollback and each of the four end-to-end option acceptance runs remain open.

## Next Codex-on-Windows acceptance command set

In a disposable directory containing the source ZIP, NOT the user's live installation:

```
cargo fmt --manifest-path native/desktop-bridge/Cargo.toml --check
cargo test --manifest-path native/desktop-bridge/Cargo.toml --all-targets --no-default-features
cargo test --manifest-path native/desktop-bridge/Cargo.toml --all-targets --no-default-features --features office
cargo clippy --manifest-path native/desktop-bridge/Cargo.toml --all-targets --no-default-features -- -D warnings
cargo clippy --manifest-path native/desktop-bridge/Cargo.toml --all-targets --no-default-features --features office -- -D warnings
python native/windows/verify_source_release.py
python -m unittest discover -s dashboard -p 'test_variant*.py'
```

Then confirm installed GUI and RepoQL versions and record a real Claude Code-tab and OpenChamber Desktop round trip, first with synthetic data and no live config mutations. No `claude` or `opencode` CLI session counts as native GUI acceptance.

## Publication boundary

No GitHub main changes, runtime deployments, credentials, GUI application settings or native services were changed here. These source snapshots are for review and continuation. The canonical working folder is Google Drive `Harness / ai-orchestra / Windows-Native-Rust-Development`. Next public release decision is **BLOCKED**, not RC approved.
