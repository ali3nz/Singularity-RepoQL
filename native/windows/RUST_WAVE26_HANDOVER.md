# Wave 26, Claude Code Full Windows Rust migration

## Product contract

Exactly one install: Claude Code Full. The source package retains Kanzo, Tencent
MemoryCore integration, RepoQL, the dashboard, Claude Office and Openmaus bots.
No Ghost or OpenChamber runtime trees are eligible for the Windows release.
The internal legacy receipt `variant=2` remains the sole supported identity.
The source archive is **not an installer** and contains no authenticated third
party services or executable runtime. The root `MANIFEST.json` now reflects
this single product, and the obsolete runtime pin is removed. The static
release verifier checks both so stale multi-frontend metadata cannot return.

## Added Rust execution boundary

`native/windows/unified-gateway-rust/src/bin/singularity-agentchat-feed.rs`
ports the active read-only durable Agent Chat dashboard feed and recent sender
projection. It has no network connection, runtime authority, cursor advancement,
message delivery or write endpoints. File reads are bounded to 160 files and the
last 128 KiB/120 lines per inbox with final-entry link checks.

`dashboard/agentchat_feed.py` remains authoritative by default. Setting
`SINGULARITY_AGENTCHAT_RUST_BINARY` to the absolute existing native executable
explicitly selects Rust. Every Rust response is compared with the Python result
before being displayed. Native error, missing executable or mismatched response
fails closed. This deliberate dual read can detect a concurrent inbox update;
it will return an error rather than silently display inconsistent data.

## Verification in this source environment

- Agent Chat bridge and file identity regression tests
- 200 Python feed/presence oracle scenarios, **not Rust execution**
- Single full profile source ZIP scanner and static source audit
- Single full profile readiness tests, including rejection of retired options
- Windows verification script and Windows CI build/differential wiring
- Reproducible source patch from the previous single-profile package

The environment has no Cargo, rustc or PowerShell. Native Rust compilation,
Rust/Python differential checks and Windows tests remain **NOT_RUN**.
The full release cannot be accepted based on these source checks.

## Windows engineering validation (isolated checkout)

```powershell
pwsh -File .\native\windows\prepare_rust_locks.ps1 -GenerateMissing
pwsh -File .\native\windows\verify_rust_upgrade.ps1 -Native
```

The first operation requires a reviewed lockfile change. Neither command is a
production install. Any new Rust executable must pass `cargo fmt --check`,
`cargo clippy -D warnings`, native Rust unit tests and differential parity before
enabling it in a real dashboard.

## Remaining work achievable in the source environment

- Further bounded runtime ports: dashboard APIs, Openmaus supervision, RepoQL
  transport and memory reconciliation, with existing authority preserved.
- Retire remaining compatibility references in source, examples and tests without
  erasing historical evidence or weakening exclusion guards.
- Integrate a controlled Rust installer and rollback receipts with the only full
  Claude Code profile. It must never silently activate or change live services.
- Extend deterministic replay and regression coverage before changing defaults.

## Outside this environment

- Rust compilation and committed lockfile provenance for all crates.
- Real Windows Claude Code, Kanzo, Tencent MemoryCore, RepoQL, Claude Office,
  Openmaus and dashboard acceptance.
- Native Windows service restart, actual installer, rollback, GUI and data
  migration tests. Live release remains blocked until those pass.
