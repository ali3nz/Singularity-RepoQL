# Singularity RepoQL native Windows — Milestone 9 (source-only)

**Date:** 2026-10-29 NZDT. **Release decision: BLOCKED.** No clean Windows install, native GUI acceptance, Rust compile, Windows service lifecycle or end-to-end integration has been proven. This source-only work follows Milestone 8; baseline Git commit `4f3d0f971f09ec677e7d4e5e49147476c054b311`. **RepoQL is pinned to exactly 1.7.15; connector ABI 1. No WSL intended.** No production machines, GitHub main, tokens or real GUI settings were changed.

## Implemented and tested in this milestone

1. **Claude Office token URL rollback guaranteed:** Prior Linux/production integration used `CLAUDE_OFFICE_PUBLIC_URL` plus `CLAUDE_OFFICE_EMBED_URL=https://<same-host>/?token=...&embed=1`, with the dashboard extracting the token server-side, forwarding it as `X-API-Key` to Office on a fixed local address, and loading the iframe through `/embed/office/?embed=1`. Milestone 8 introduced a Windows private-key file and had a UI launch bug: `office_bridge.embed_url()` still required the old URL despite file-mode authentication. Milestone 9 makes Windows `key_file` mode actually work without the legacy URL, and adds explicit `SINGULARITY_OFFICE_NATIVE_AUTH_MODE=legacy_url` to restore the original token flow without reverting unrelated security controls. On native rollback the URL must be HTTPS, match `CLAUDE_OFFICE_PUBLIC_URL`, and contain exactly one token plus `embed=1`. The browser never receives the secret URL. Invalid mode and missing keys fail closed. Linux retains its existing URL semantics, including unrelated query parameters. **Complete operational and source rollback instructions:** `docs/WINDOWS-OFFICE-AUTH-ROLLBACK.md`. This preserves a compatibility path but does **not** prove it works with the actual installed Windows Claude Office backend or that the key file has secure ACLs.
2. **Supervisor process safety:** `scripts/native-memory-supervisor.mjs` now refuses PID ownership with missing recorded/live `exe` or creation time; matches start time exactly rather than tolerating a 2.5-second recycled PID window; refuses `--dry-run` with `stop`, `start`, `restart`, `status`; and cleans up launched children if the ownership manifest write fails. This is defensive Node code on the way to a Rust supervisor, not a claim of native Windows service readiness.
3. **Read-only Windows preflight:** `native/windows/preflight.ps1` accepts option 1–4 and explicit candidate `rql.exe`, Rust bridge and native GUI executable paths. It computes fingerprints, checks exactly RepoQL 1.7.15 where available, and probes fixed loopback service TCP ports. It never reads tokens, starts processes, installs packages or declares release readiness; a listening port is not an authenticated health receipt. **PowerShell has not been executed on Windows** in this environment; the test checks its source safety contract only.
4. **Source ZIP security gate:** `native/windows/scan_source_archive.py` rejects unsafe member names, symlinks, private/runtime files, executable binaries, checksum or manifest mismatches, out-of-scope features and missing 1.7.15/ABI 1 pins. Included in Windows CI source. It is not a malware, dependency or PII-content scanner. All four option archives will be rebuilt and tested before distribution.
5. **Readiness precision:** native Office readiness now requires valid credentials, a healthy Office HTTP probe **and a usable same-origin iframe path**, not just a reachable port. The UI no longer misleadingly requires a token URL when using the key-file mode.

## Variant matrix — source not installer

| Option | Native GUI target | Core stack | Extra features | Status |
|---|---|---|---|---|
| 1 | Claude Desktop Code tab | Tencent MemoryCore, RepoQL 1.7.15, Kanzo, Agent Chat, dashboard | None | SOURCE ONLY |
| 2 | Claude Desktop Code tab | Same | Ghost + Claude Office | SOURCE ONLY |
| 3 | OpenChamber Desktop GUI | Same | None | SOURCE ONLY |
| 4 | OpenChamber Desktop GUI | Same | Ghost + Claude Office | SOURCE ONLY |

Options 1 and 3 exclude Ghost/Office runtime modules, but may contain general **documentation about them**. `native/windows/variants.json` is the authoritative source contract. Rust features `office,ghost` apply to 2/4 only, but **Rust binaries have not been compiled**.

## Evidence collected offline

- Dashboard Python regression suite: **38 tests passed**, including new private-file/legacy-URL rollback scenarios. (Final count to be verified after packaging.)
- Native Windows source/version/payload scanner unit tests: **10 tests passed**.
- Focused Node suite (supervisor, document ingest, Claude policy, OpenChamber adapter, bundle classifier): **54 tests passed**.
- Source verifier requires 1.7.15/ABI 1 and exactly four variants. Final packaging must pass ZIP CRC, per-file SHA256 and lean/complete separation.
- All runs are source-level in a non-Windows environment. Rust `cargo test/fmt/clippy`, Windows PowerShell execution, genuine RepoQL 1.7.15 connector load and GUI sessions are **NOT RUN**.

## What can still be built or tested without the user's Windows PC

**P0:** Run Rust compilation/fmt/clippy via a capable CI runner; create and commit `Cargo.lock`; fix any Windows FFI/compiler failures; build independent signed/hashable x64/ARM64 artifacts. Rewrite persistent service process supervision, per-user Windows credential lifecycle and control transport in Rust, leaving only necessary PowerShell installer/bootstrap and JS/TS plugin entrypoints.

**P0:** Implement a transactional native installer and uninstaller (four options) with side-by-side backup, ownership-safe shutdown, rollback, upgrade checks, explicit service identity, ACL enforcement and no WSL/Docker dependencies. The present ZIPs are **not** installers.

**P1:** Implement genuine Rust-backed memory writes with persistent retries, dedupe and scoped recall; native Tencent MemoryCore/MemoryKnowledge service lifecycle; typed RepoQL 1.7.15 Kanzo+Tencent connector install/health/index/refresh verification. Simulate service restart and failed writes with disposable fixtures.

**P1:** Implement a native Ghost HTTP control **server** matching the Rust client (tasks, prompts, confirmations, revisions and rollback); native Office backend/event forwarding; Rust Agent Chat queue/cursors; Rust graph backend with live updates/reconnect; dashboard proxy/SSO token renewal with audience and CSRF enforcement. Preserve the already-working production Office token URL path as rollback.

**P1:** Implement verifiable GUI-sourced subscription usage receipts; expose only Claude Desktop Code and OpenChamber subscriptions actually available to the user. No generic Harness/Freebuff totals or synthetic token usage. CPU source is Rust Win32 but still uncompiled/unverified. Audit licensing, bundled third-party versions, secrets, source provenance, SBOM and signing.

## Windows-only acceptance before public release

1. Execute the PowerShell preflight and Rust builds on actual Windows 11 (and minimum supported version), with the user explicitly selecting exact GUI binaries/config directories. Prove hooks/MCP are invoked by **Claude Desktop Code tab or native OpenChamber**, not merely a terminal CLI.
2. Prove native, durable Tencent, MemoryKnowledge, RepoQL 1.7.15 and Kanzo startup on localhost, connector ABI 1 load, proper indexing, actual write/capture/recall, strict identity isolation and restart recovery.
3. Prove each of the **four options** from a clean Windows user profile, including upgrade, idempotent reinstall, uninstall, clean rollback and no WSL/Docker assumptions.
4. In 2/4, compare Office `key_file` and `legacy_url` modes with the **same installed Office**. Verify rendered desk, sprites, iframe, WS, event ingestion, no duplicate events and secret-free browser/network logs. Ghost task/prompt edits must be confirmed by real native daemon receipts.
5. Confirm dashboard authenticated RepoQL token issuance, Tencent session, Kanzo board CRUD, Agent Chat delivery/cursor, live memory graph, CPU probe and genuine GUI subscription metrics. Verify Windows NTFS ACLs, local-only listeners, token rotation and denial of untrusted origins.

**Do not describe any option as publicly installable or production-ready until these live checks are complete.**
