# Singularity RepoQL Windows Native Public Release: Milestone 6

**Date:** 29 October 2026 NZDT
**Baseline:** Git source at `4f3d0f971f09ec677e7d4e5e49147476c054b311` plus isolated Milestones 1–5; this milestone supersedes the previous Windows source-review ZIPs.
**Release verdict: BLOCKED. SOURCE REVIEW ONLY.** No WSL dependency is intended; no native Windows executable or complete installer is included. No existing user installation, services, private repo, or GitHub main were modified.

## Explicit operator decision: use RepoQL 1.7.15

- **Both Kanzo and Tencent MemoryCore connector ABIs are pinned to `abi: 1` against externally installed native `rql.exe 1.7.15` only.** Do not auto-upgrade or silently use 1.7.17 from PATH. Its connector contract is incompatible with these source manifests.
- Python `native/windows/repoql_compat.py` performs bounded, read-only `rql.exe --version`, validates both manifests, and returns a nonzero status on mismatch. Rust `singularity-desktop-bridge repoql-preflight --rql <path>` is its native equivalent, but this Rust code **has not been compiled**.
- The Python dashboard startup now calls the exact-version gate **before** opening an HTTP listener or issuing a capability token in native Windows mode; Linux/legacy behaviour is untouched. This is a compatibility gate, not connector functional acceptance.
- Source variant manifests carry `repoql.requiredVersion=1.7.15` and `repoql.connectorAbi=1`; all four packages are checked. `rql.exe` is **never shipped** in source packages. The actual installed Windows binary and both connector installs must still be tested with RepoQL licensing/permission verified.

## Installation options and feature boundaries

| Option | Native GUI | RepoQL 1.7.15 / Tencent / Kanban / Agent Chat / Dashboard | Ghost & Claude Office | Source review gate | Native Windows acceptance |
|:---|:---|:---|:---|:---|:---|
| 1 | Claude Desktop **Code tab** (not terminal Claude CLI) | Required | Excluded | PASS static | NOT RUN |
| 2 | Claude Desktop Code tab | Required | Included | PASS static | NOT RUN |
| 3 | OpenChamber **Desktop GUI** (not OpenCode CLI) | Required | Excluded | PASS static | NOT RUN |
| 4 | OpenChamber Desktop GUI | Required | Included | PASS static | NOT RUN |

The source ZIPs are *not installers*: they contain no built Rust `.exe`, no registered Windows service, no dependency bootstrap, no desktop settings mutation, and no cryptographically signed published binaries. Static source variant selection is therefore **not four tested installations**.

## Dashboard integration audit

| Surface | Source status here | Windows-specific blocker / acceptance |
|---|---|---|
| RepoQL native dashboard | Same-origin official RepoQL login issuance and cookie-scoped embed code exists | Verify `rql.exe 1.7.15` token issuance, iframe, WebSocket, cookie policies and renewal in actual browser GUI |
| Tencent native panel | Existing local owner-key file, auth verify, session handshake, fixed panel proxy | Run native MemoryCore service, ACL-protect key, validate handshake on Windows and live L0/L1/L2/L3 recall |
| Kanzo Kanban | Existing fixed-loopback panel and read-only RepoQL connector | Native board service and connector install/sweep/index, task edits/comments, no cross-session leakage; the local `/mcp` route must stay unexposed |
| Agent Chat | Existing mailbox/feed backend, read-only monitoring | Native durable mailbox writer/reader and cross-session delivery, cursor and restart integration not proved |
| Claude Office (2/4 only) | Rust event bridge source, GUI event adapter, iframe/backend auth proxy source | Native Office renderer and backend installation, short-lived token exchange, GUI lifecycle events, web socket, focus/seating acceptance absent |
| Ghost tasks and prompt editor (2/4 only) | Ghost dashboard viewer, actions incl `set-prompt`, `revert-prompt` in legacy Python proxy | Ghost control hub uses Unix-domain socket and has no native Windows transport or ACL-backed auth yet; task/prompt writes not accepted |
| Live memory graph | Existing `/api/unified/graph` Rust gateway adapter with bounded cache | Unified graph service is not installed or supervised natively; no proven live updates, identity / lineage / redaction acceptance |
| CPU chart | Linux `/proc` collector source; Windows now shows unsupported instead of pretending | Native Rust Windows process CPU sampler and source-attested PID ownership still needed |
| Token/subscription usage | **New native strict projection:** only explicit `claude-desktop-code` or `openchamber-desktop-subscription` receipt origins; no fleet/Freebuff totals in native GUI usage view | No trustworthy native GUI subscription collector exists. Aggregated or missing records are **unknown**, not zero. Paid plan allowance cannot be inferred from models or costs |

### Authentication design (no disabling controls)

- Keep dashboard session auth separate from per-service authorization. Do not reuse bearer tokens from URLs in arbitrary iframes or expose them in browser scripts.
- Existing local dashboard proxies support service-specific backend keys and same-origin cookie/session exchange. Native Windows further refuses remote hosts for Tencent, Office and Kanzo.
- Verify user-owned key files with Windows ACLs, token issuance/rotation, CSRF/Origin, WebSocket scope, browser cookie behaviour and restart before claiming seamless login. RepoQL-issued tokens must come from the supported official 1.7.15 interface. **No authentication bypass is a substitute for these checks.**

## Rust migration audit

**Rust source added to date:** MCP memory search, scoped GUI config planner, optional Office event transport, release variant reader and 1.7.15 compatibility preflight. Office source is compiled out of lean variants by feature gate. Rust build and Clippy have NOT RUN on this machine (Rust compiler unavailable).

**Still largely Python/Node and priority for migration:** Windows process supervisor and service lifecycle; secure credential/ACL storage; memory write capture, extraction and verified recall; dashboard HTTP proxy, real-time memory graph feed, CPU and source-accurate usage exporter; durable Agent Chat delivery; Kanzo service and Ghost task/prompt control bridge. GUI plugin glue will necessarily remain JavaScript/TypeScript where the upstream desktop applications require that API; converting it to Rust would not eliminate the supported host interface.

## Tests actually run in this environment

- **Rust:** NOT RUN / UNCOMPILED. Windows service and GUI acceptance: NOT RUN.
- **New RepoQL pin tests:** Python 6 passed; native dashboard compatibility tests 3 passed.
- **Native GUI-only usage projection:** 3 passed, nulls for unknown rather than fabricating totals.
- **Native fixed-loopback panel tests:** 2 passed.
- **Dashboard `test_*.py`:** 16 passed (includes new tests); additional variant tests verified 7 passed in a separate discovery pattern (overlapping tests are not added to counts).
- **Focused Node source suite:** 42 passed (includes bundle classifier, MemoryCore reconciliation, Claude hook and OpenChamber GUI adapter).
- **Static four-option source verifier:** 29 required sources checked; all four option matrices passed; installed ABI and live connector acceptance NOT VERIFIED.
- **ZIP CRC and per-file SHA256:** recheck against the final generated release archives and record their fingerprints. This is packaging integrity, not functional operation.

## Prioritised outstanding work doable from a non-Windows development environment

1. **Make Rust compilable and independently testable on Linux Rust toolchain or Windows CI**: automated fmt/test/clippy and static binary build; resolve compiler errors before native testing. This environment has neither a Rust compiler nor actual CI artifacts. Source cannot be advertised as Rust-built yet.
2. **Implement transport-independent Rust services**: bounded durable memory event ledger, Windows-safe ownership primitives with trait-based backends and fake clocks, Agent Chat notifications, typed dashboard service status, and verified startup/rollback state machine. Do not port runtime behaviours without preserving existing source contracts and extensive tests.
3. **Build native Windows service/installer prototype** with reversible backup/restore, exact variant selection, ACL checks, and token provisioning as a dry-run first. No unattended changes to existing GUI profiles; no secrets in installers.
4. **Bring dashboard to Rust** behind current stable JSON contracts; validate existing endpoints with synthetic Tencent/RepoQL/Kanzo/Office/Ghost servers, CSRF and cookie tests, browser UI snapshots. The proxy must not expose unauthenticated loopback board MCP endpoints.
5. **Complete asset and legal checks:** third-party licence/SBOM/provenance, explicit public distribution permission for RepoQL engine, secret scan of ZIPs and staged payloads, UI accessibility and privacy controls.
6. **Prepare hermetic synthetic end-to-end fixtures** for four option plans and connectors, including 1.7.15 ABI simulated manifest acceptance and newer-version refusal. These tests cannot replace executing the real RepoQL binary.

## Acceptance that specifically requires Windows GUI hardware or a Windows CI runner

- Build and run Rust x64 Windows EXEs in both feature sets; verify real installed `rql.exe --version` output is **exactly 1.7.15**; install both connectors and exercise actual GET/index/embedding/sweep/status on the real engine.
- Native MemoryCore/MemoryKnowledge/MemoryProxy dependency resolution and startup, Windows service persistence across logout/reboot, automatic capture and cross-session recall in **Claude Desktop Code tab** and **OpenChamber Desktop GUI**.
- Native Kanzo, Claude Office renderer, Ghost task/prompt editing, Agent Chat session delivery, live memory graph, correctly scoped CPU and real subscription usage in native dashboard.
- Four **separate clean-machine installs**, upgrades and uninstall/rollback, collision recovery and negative security cases. No WSL, Docker requirement, CLI-only demonstration or inherited Linux runtime is accepted as proof.

**Final gate: NOT READY FOR PUBLIC RELEASE.** Do not merge to product main or advertise all four Windows options as working. Use this exact source archive as the next review baseline and only promote a version after Windows CI and real GUI evidence pass.
