# Singularity RepoQL Windows native: M23 dashboard and usage handover

**BASELINE:** Milestone 23 source-only; all four variants have RepoQL **1.7.18 / ABI 1**. Do not deploy a source ZIP as an installer. No WSL or Docker for native installs. Claude Office token-URL method remains default for complete options 2/4. Zero Claude Code free workers is supported by separately configured OpenChamber native transport; capacity/queue acceptance remains pending.

## What was actually executed outside Windows

- Real Python dashboard HTTP listener: option-specific `/api/unified/usage`, optional Office/Ghost routes, native readiness, and Freebuff/provider usage exclusion, with synthetic upstream usage payloads.
- Python unit tests: exact GUI source attribution and safe sample-only reporting, native CPU history isolation, existing Office/Tencent/Kanzo handshake tests, Ghost prompt history, Windows policy/source suites.
- Node front-end module import: four variant-specific usage labels and Win32 CPU scale, plus legacy Linux CPU presentation preservation.
- Browser smoke was attempted, but this environment forbids Chromium localhost navigation with `ERR_BLOCKED_BY_ADMINISTRATOR`; therefore browser UI was **not accepted**.

## Codex native Windows test sequence

1. From unpacked source run `python -m unittest discover -s native/windows -p 'test_*.py'` and `python -m unittest discover -s dashboard -p 'test_*.py'`; then `node dashboard/static/native_variant_ui.test.mjs`.
2. With a real Windows Python + Node installed, run the four-option dashboard listener tests from a normal user account, including rendered browser navigation (the Chromium smoke can be opted in with `RUN_BROWSER_SMOKE=1`).
3. Build Rust authority/bridge/supervisor; run Windows named-pipe and Job Object tests; validate the native CPU sample and process identity.
4. For options 1/2 only show Claude Desktop Code-attributed recent receipts; for options 3/4 only OpenChamber Desktop-attributed recent receipts. Reject Freebuff, CLI/API traffic and cross-GUI events. Never estimate a 30-day token total from incomplete recent records.
5. **Usage collection remains the P0 implementation gap.** Integrate to the real installed OpenChamber `Settings → Usage` provider quota source by discovering its versioned, authenticated, read-only API in the installed OpenChamber build. Do NOT scrape user credentials, infer API billing from a model name, or claim subscription quota from raw OpenCode token counters. For Claude Code, verify a GUI-specific session provenance and completeness model before enabling full totals. No such authoritative collector is installed by M23.
6. Check Office token-derived `X-API-Key` upstream without token leaking to the browser, Ghost prompt edits/reverts with real native service, Kanzo task mutations, Agent Chat delivery, live memory graph, Tencent capture/recall, and RepoQL 1.7.18 connector reindex/query across all four variants.
7. Install an actual native CPU history collector; until then `/api/cpu` must remain unavailable on Windows. The CPU dashboard must not display the Linux 4-core systemd quota or `/proc` collector description on Windows.
8. Run production-vs-Windows parity tests, including self-learning document ingestion, evidence, correction, archive retention, provider failover and independent role scopes. Record version/build hashes, timestamps, actual GUI screenshots and response excerpts with secrets redacted.

## Release policy

Missing or stale provider receipts imply **UNKNOWN**, not zero. Missing collector data must not be used to assert plan status. Native `readiness` is diagnostic only. Every test must distinguish real Windows integration from synthetic loopback service fixtures. Preserve the historical production Docker configuration unmodified.
