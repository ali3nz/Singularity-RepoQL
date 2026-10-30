# Milestone 20 — Native Windows integration hardening (SOURCE ONLY)

**Release decision: BLOCKED.** Prepared from the complete Milestone 19 source. The Windows RepoQL target is exactly **1.7.18** and connector ABI **1**; production host is unchanged. No WSL or Docker are intended as Windows installation prerequisites, but **native runtime dependency closure is still not proven**.

## Implemented and tested here

1. The Windows Rust supervisor rejects remote and non-drive-absolute paths, plus symlinks and Windows reparse points (including junctions) at any ancestor of the selected executable, working directory or JSON configuration. A second safety check runs at launch.
2. HTTP 200 on a configured port is no longer enough to call a managed service ready. The supervisor now requires exactly one `X-Singularity-Component: <id>` header and a 200 status on its configured health path; duplicate, absent or mismatched identity is rejected. This is **identity-shaped readiness**, not cryptographic process attestation.
3. A global 1,200 ms deadline protects the Rust health probe from indefinite trickle-response stalls, in addition to individual I/O timeouts. Rust source units and source-contract tests were added; the Rust code remains **uncompiled** here.
4. The Windows dashboard implements `GET /.well-known/singularity-health` on **loopback only**, returning `X-Singularity-Component: dashboard` without a user token or internal telemetry. Other methods and legacy Linux mode are rejected. Real localhost HTTP route tests pass.
5. The authenticated Rust Harness dashboard client no longer follows HTTP redirects or inherits HTTP proxy settings, refuses malformed/upstream URLs, and reads its native default token from `%LOCALAPPDATA%/Singularity/Harness/coordinator.token`. A negative health response cannot be reported as ready. Eight live loopback tests included a redirect to a separate local server with no credential transfer.
6. The Windows CI workflow now executes all new Python tests and will execute Rust unit tests on Windows/Linux once triggered on a repository branch with a working toolchain.

## Operational integration contract

The Rust supervisor's HTTP readiness is intentionally stricter than the previous generic 200 check. Any supervised component given a `health` entry must implement this identity header. Only the dashboard's native Windows endpoint has been integrated and tested here. Tencent, RepoQL, Kanzo, Agent Chat, Office, Ghost and the memory graph must **not** be assigned unverified health paths that cannot meet this contract; their native service wrappers and acceptance remain outstanding. `health=None` is a source-level process-survival check, not a validated ready service.

For a native dashboard supervisor component, configure its `health.path` as `/.well-known/singularity-health`, `health.port` to the actual loopback listener, and `id` as `dashboard`. The returned header is not a substitute for service ownership proof, connector index/readback, GUI event delivery, or end-to-end self-learning tests.

## Still blocked — implementation, compilation and live acceptance

- No Rust compiler or native Windows runner was available in this environment. No Win32 binary was compiled, no Rust unit test executed, and no GUI was launched.
- The Rust supervisor is still an unreleased candidate; full service configuration, termination/restart recovery, executable provenance, ACLs and process ownership must pass real Win32 testing.
- The full native Windows installer, rollback of GUI/service registrations, upgrades and uninstall are unfinished. Source staging is not an installer.
- Tencent MemoryCore / MemoryKnowledge services, RepoQL 1.7.18 connector round trips, self-learning, source attribution, Agent Chat, Kanzo and the graph are not yet demonstrated end-to-end on Windows.
- Claude Office retains the known working token URL default in options 2/4. Its native daemon, events and iframe still require live acceptance. Ghost controls and prompt editing require native daemon acceptance.
- Claude Code zero free workers remains an explicit capacity boundary. The opt-in native OpenChamber/OpenCode worker transport is only protocol-tested, not an infinite or automatically available pool.
- Production-vs-Windows behavioural receipts for capture, recall, promotion, conflicting corrections and restart recovery remain missing. The source parity gate will reject absent evidence.

**No deployment, GitHub main modification, Office authentication replacement, or production state change was performed.**
