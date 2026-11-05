# Milestone 23: native dashboard functions and usage measurement matrix

**Release state: source-only, NOT native Windows accepted.** RepoQL **1.7.18**, connector ABI **1**. Options 2/4 keep Claude Office's proven server-side token-URL credential source. No Claude Code free-worker capacity required for the separate OpenChamber loopback transport.

## Installation variants and UI policy

| Function | 1 Claude lean | 2 Claude complete | 3 OpenChamber lean | 4 OpenChamber complete |
|---|---|---|---|---|
| RepoQL dashboard and embedded control | Included; live acceptance missing | Included; live acceptance missing | Included; live acceptance missing | Included; live acceptance missing |
| Tencent MemoryCore panel | Included; authenticated HTTP simulation tested | Same | Same | Same |
| RepoQL/Tencent unified memory graph | Included; local gateway contract tested | Same | Same | Same |
| Kanzo board and Agent Chat feed | Included; local proxy/state tests | Same | Same | Same |
| Harness and self-learning | Included in source; production parity UNVERIFIED | Same | Same | Same |
| Claude Office | Excluded from archive and 404 API | Included; token-URL method | Excluded from archive and 404 API | Included; token-URL method |
| Ghost | Excluded from archive and 404 API | Included; native prompt-control end-to-end unverified | Excluded | Included; end-to-end unverified |
| GUI token source accepted | `claude-desktop-code` only | `claude-desktop-code` only | `openchamber-desktop-subscription` only | `openchamber-desktop-subscription` only |
| Fleet, Freebuff and other GUI traffic | Not included in native GUI usage | Not included | Not included | Not included |
| Subscription quota or 30-day total | **Unknown** | **Unknown** | **Unknown** | **Unknown** |
| CPU unit | Win32 percentage of one logical core | Same | Same | Same |
| CPU history | Not collected without a native Windows collector | Same | Same | Same |
| Windows Integration Status page | Included; per-component diagnostic only | Same | Same | Same |

## Implemented and tested here

- Server-side GUI usage is scoped to the exact selected installation variant. No cross-GUI, provider-wide, Freebuff or fleet totals can be recast as subscription tokens.
- The native dashboard labels totals and subscription allowances **unknown**, even if recent timestamped samples exist. No incomplete recent page becomes a daily chart.
- Native Freebuff allowance and provider-wide OpenChamber telemetry endpoints explicitly return unavailable, while the Linux dashboard retains its original telemetry.
- Native `/api/cpu` returns no Linux SQLite history. Live `cpu_now` still uses the Rust Win32 probe if the separate compiled bridge is installed. The browser labels native CPU as percentage of one logical core; it never asserts systemd's 400% quota.
- All four variants have a read-only Windows Integration Status UI, backed by the existing readiness endpoint. Reachable is not equivalent to functional or release-ready.
- Actual Python dashboard listener tests cover all four options, filtered usage, optional-feature route exclusion, Freebuff/source isolation and readiness. Node module tests check the visual GUI/CPU labels.

## Usage ingestion and authoritative subscriptions: outstanding blocker

The current source can **filter and display** explicitly attributed recent receipts from the unified gateway but **cannot certify that Claude Desktop Code or OpenChamber emits complete, attributable provider receipts on native Windows**. No full-period sums or actual subscription quota are inferred. OpenChamber has its own Settings → Usage page, which fetches quota windows for connected providers; duplicating that data in RepoQL requires a separately authenticated, versioned, read-only integration to the actual installed OpenChamber host. Do not infer subscription quotas from OpenCode message token counters, OpenRouter traffic or provider names. Claude Code subscription quota is similarly not established by hook events. If a provider does not expose this data, display unavailable, not zero.

No application credentials or token URLs belong in the browser. For Office the existing server-side `CLAUDE_OFFICE_EMBED_URL` token extraction remains the configured mechanism; do not replace it without a separately proven rollback.

## Required Codex checks on native Windows

1. Compile and run all Rust crates, native authority tests and Windows supervisor tests (with no WSL or Docker).
2. Confirm each option's visible navigation and backend routes in the installed desktop GUI; ensure options 1/3 have no Office/Ghost source or navigation.
3. Connect OpenChamber's real usage/quota source (not a guessed endpoint), verify account/provider boundaries and data schema with test receipts, then implement a bounded desktop-source collector with the plan limitations clearly exposed.
4. Run real GUI session metering tests for Claude Code options 1/2 and OpenChamber options 3/4; verify off-origin and cross-GUI receipts are rejected and totals remain unknown unless a complete verified window exists.
5. Install a native Win32 CPU history collector with process identity verification, interval, retention and process-local capacity semantics; confirm reboot recovery and no Linux quota labels.
6. Demonstrate RepoQL 1.7.18 index/query, Tencent scoped capture and recall, self-learning promotion, graph updates, Kanzo/Agent Chat durable delivery and optional Office/Ghost control, including restart and rollback.
7. Preserve a production-vs-Windows behavioural comparison for all core flows. A green HTTP health check is never enough.

Automated Chromium navigation was attempted here but blocked by the sandbox browser policy (`ERR_BLOCKED_BY_ADMINISTRATOR`). No browser acceptance credit is claimed for that attempt. Rust binaries remain uncompiled here.
