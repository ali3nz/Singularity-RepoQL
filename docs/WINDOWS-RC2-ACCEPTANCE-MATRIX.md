# Windows RC — 18-row acceptance matrix (0.5.2.0)

Scope: local MSI build, isolated RC lifecycle, test batteries, release
paperwork. Machine: windows241 (`ali3nz\ben`, PowerShell 5.1). Install root:
`C:\Users\Ben\AppData\Local\Singularity\Fleet861RC`. Branch `rc-fleet893`.
Every row names the raw log that proves it; logs are in
`work/singularity-windows-claude-omb-20261105/evidence-msi-remediation/`
(numbered; the low 60s are this continuation).

| # | Acceptance item | Result | Evidence |
|---|---|---|---|
| 1 | Source archive regenerated from branch HEAD by the repository generator | PASS — Option 2 variant, 955 files, 5,395,868 B, sha256 `be465e58…8ecfb`; the 0.5.1.0 pin `22539c92…` is replaced in both pin sites | `60-msi-build-052.log`, generator stdout |
| 2 | Archive carries the branch's work, not a stale snapshot | PASS — archive members `dashboard/repoql_native_auth.py`, `dashboard/server.py`, `dashboard/test_repoql_panel_origin.py`, `native/windows/rc_services.py` hash-equal to the committed tree; `installer/` is deliberately excluded from the archive | hash comparison in run notes |
| 3 | Both source pins and the package identity updated | PASS — `build-msi.ps1` `$expectedSourceHash`, `prepare_msi_payload.py` `SOURCE_SHA256`, `SingularityRepoQLRC-v4.wxs` version 0.5.2.0 + ProductCode `D8737523…`, `README-MSI.md` | `git show f366b8d` |
| 4 | MSI built by the verified entry point only — local, unsigned, no Burn, no publication | PASS — `build-msi.ps1` exit 0 in 1.3 min; WiX 6.0.2 self-provisioned; MSI 7,480,295 B sha256 `006C9A7F…66EE7A0`; no bundle produced | `60-msi-build-052.log` |
| 5 | Payload receipt binds the MSI to the archive | PASS — `singularity-msi-build/2`, `source_zip_sha256` `BE465E58…`, `media: embedded-cab`, one distribution file with its hash | `60-msi-build-052.log` (`C:\rc893-out7\Singularity-RepoQL-MSI-BUILD-RECEIPT.json`) |
| 6 | Rust dependency provenance gate | PASS — `singularity-rust-lock-release-gate/v1`, three crates, locks valid, exit 0 | `60-msi-build-052.log` |
| 7 | Rust unit tests for the three crates | PASS — `rust_tests_skipped: false` in the build receipt; the per-crate summaries are in the same log | `60-msi-build-052.log` |
| 8 | Major upgrade over the installed 0.5.1.0 from a folder holding only the MSI | PASS — `msiexec` exit 0; ARP `{FD77347A…}` 0.5.1.0 → `{D8737523…}` 0.5.2.0; installed files 1263 → 1263; installed source carries the resolver, the bind-record read and the embed env, and no hard-coded `127.0.0.1:41005` | `62-upgrade-051-to-052.log` |
| 9 | Clean uninstall | PASS — `msiexec /x` exit 0; ARP entry gone; `source\` payload removed (0 files); RC `workspace\` state preserved | `57-lifecycle-final-uninstall-reinstall.log` |
| 10 | Clean reinstall from the distribution-only folder | PASS — `msiexec /i` exit 0; ARP 0.5.2.0; 1263 installed files; distribution folder held only the MSI | `57-lifecycle-final-uninstall-reinstall.log` |
| 11 | `Test-RCIsolation.ps1` from its verified location | PASS with a corrected check — 15/17; `rc_port_free` **now passes** after D10 below; the two remaining failures are pre-install-only assertions (`rc_state_root_absent`, `rc_not_already_in_arp`) that are necessarily false on a machine where the RC is installed. Every isolation assertion passes: distinct UpgradeCode/ProductCode/install dir/root, perUser scope, LOCALAPPDATA root, disjoint live roots, non-production port, 7/7 live tasks | `58-rc-isolation-post-install.log` |
| 12 | Mode-aware HTTP/auth acceptance in **auto-local**, with `-Ttl 30` | PASS — 18 pass / 0 fail / 0 not tested, including `repoql_panel` (handshake 200 → panel 200, 12,434 B), `session_ttl_expiry_auto_local`, logout/re-issue, forged cookie, Origin and custom-header boundaries | `49-auth-auto-local-052-ttl.log` |
| 13 | Mode-aware HTTP/auth acceptance in **password**, with `-Ttl 30` | PASS — 20 pass / 0 fail / 0 not tested: sign-in, wrong password (401 `invalid_credentials`), foreign-Origin sign-in (403), issued-session acceptance, `session_ttl_expiry`, logout revocation (401 on the same cookie), all four panels | `50-auth-password-052-ttl.log` |
| 14 | Python unit batteries at HEAD | PASS — dashboard 223 tests (1 skipped), native/windows 30, native/windows/provision 14, memory 11; all `OK` | `63-unit-suites-052.log` |
| 15 | Functional dashboard/API data | PASS — `/api/status` 200 from the RC RepoQL host: `ready/queryable/searchable`, 2,225 files, 0 pending/failed/stale, semantic 100 %; `/api/setup/health` 200 with 5 rows; Tencent panel 561 B app shell; Office panel 18,196 B; Kanzo board `/api/board` 200 with the four statuses; login capability never returned to the browser (303, no `#k=`/`t=`) | `51-functional-checks-052.log` |
| 16 | Functional official RepoQL Control Panel and one write through the proxy | PASS — panel document `RepoQL Dashboard` + `/embed/repoql/assets/store.js` 200 (66,481 B `text/javascript`); Kanzo project+task created through the dashboard proxy, read back, then deleted, board restored to 0 projects / 0 tasks | `56-functional-panel-write-acceptance-v3.log` |
| 17 | MSI/source correspondence | PASS — every one of the 957 packaged archive members is present in the installed `source\` and byte-identical (957 identical, 0 missing, 0 different, 0 unexpected extra); 5 staged binaries recorded with their hashes | `61-msi-source-correspondence-052.log` |
| 18 | Production inventory unchanged; local commits only | PASS — the seven `Singularity-*` tasks identical before and after install/uninstall/reinstall; production ports 18100/18101/18126/18128 never bound (idle before and after); production ARP and `WindowsNative\current` untouched; commits are local only (no remote configured) | `57-lifecycle-final-uninstall-reinstall.log`, `git log` |

Not re-run for 0.5.2.0 (recorded, not claimed): the dockerhost-blocked firewall
exercise (row 17 of the 0.3.0.0 matrix) was proven for the previous candidate and
is unchanged by this slice; re-running it needs a temporary firewall rule, which
this continuation did not add. Everything else above is measured on 0.5.2.0.

## Defects found and fixed in this continuation

| # | Defect | Cause | Resolution |
|---|---|---|---|
| D8 | Installed candidate issued no session; every `/api/…` answered `401 dashboard_secret_required` | The RC launcher never set `SINGULARITY_LOCAL_ACCOUNT_AUTH`, so `dashboard/server.py` built no `LocalAccount` (production's host does set it) | `panel_env()` sets it and defaults the mode to `auto-local`; two contracts. Commit `effff46` |
| D9 | The RepoQL Control Panel answered 503 `native_repoql_proxy_unconfigured`, then 502 | Two causes: `REPOQL_NATIVE_EMBED_URL` was never advertised, and the upstream was the constant `127.0.0.1:41005` while RepoQL mints its panel listener on a **dynamic** port recorded in `<workspace>/.repoql/cache/dashboard-bind.json` (this machine: production 52511, RC 59796) | Resolver `panel_origin()` reads the bind record (or `SINGULARITY_REPOQL_PANEL_ORIGIN`), the proxy and redirect boundary use it, the RC advertises the same-origin embed. Commit `77ff3fa`; 6 new contracts |
| D10 | `Test-RCIsolation.ps1` failed `rc_port_free` on a port that refused every connection | The check trusted `Get-NetTCPConnection`, which still listed a LISTENING row with owning pid 0 after the process exited | Occupancy is decided by connecting. Commit `a367e62` |

### Harness defects found and fixed (not product defects)

The auth suite reported every post-sign-in request as 401. A raw-socket probe of
the *same* cookie value answered `authenticated: true`, while
`Invoke-WebRequest -Headers @{Cookie=…}` reached the server without it: Windows
PowerShell 5.1 manages cookies only through its own container and silently drops
a caller-supplied `Cookie` header. Two further suite errors were fixed with it:
the TTL case waited 6 s for a 30 s floor (`session_ttl()` clamps to `MIN_TTL`),
and the wrong-password case ran before an account existed (400
`account_not_configured` instead of 401 `invalid_credentials`). The suite now
speaks HTTP over `TcpClient`, waits `max(30, Ttl) + 6`, and orders the
wrong-password test after setup. Evidence for the diagnosis and each iteration:
`64-installed-cookie-diagnostic.log` (value-free cookie probe: the same value is
`authenticated: true` over a raw socket and invisible through
`Invoke-WebRequest`), `52`, `53`, `54`, `55` (contract discovery for the panel
asset and the Kanzo write), then the acceptance runs `49`, `50`, `56`.

## Tracked-file scans

| Check | Result |
|---|---|
| Private-key / cloud-token patterns over tracked files | 4 files matched, all deliberate fixtures (`memory-hook.test.mjs` redaction test, `connectors/kanzo/tools/build_suite.py` sample, `connectors/kanzo/tools/pin.py` forbidden list, `harness/kit/orchestrate.mjs` fixtures). No live credential |
| `Bearer <token>` literals | fixtures/assertions only, unchanged by this slice |
| Binary / non-text tracked files | `bootstrapper/source.zip` (stale, documented), `docs/assets/memory-architecture.png`, `native/windows/assets/singularity-dashboard.ico` |
| Session values in this continuation's logs | none — every log prints cookie name/length/flags only; the diagnostic prints status and shapes, never a value (the 43-character length and the flag set are reported, never the value) |
| Archive checksums | the archive carries a regenerated `SHA256SUMS` and `NATIVE_WINDOWS_SOURCE_MANIFEST.json` (957 entries) |

## Upstream reconciliation

| Item | Value |
|---|---|
| Branch | `rc-fleet893`, **no remote configured** (local only) |
| Base | `5aaf766` (Fleet861 RC 0.2.0.0 reviewed tree) |
| Commits added by this continuation | `add6601`, `effff46`, `1d9a89a`, `28070d2`, `77ff3fa`, `f366b8d`, `a367e62` (+ the documentation commit) |
| Upstream divergence | None claimed: no fetch, push or tag was performed and no remote exists |
| Files changed in the 0.5.2.0 slice | `dashboard/repoql_native_auth.py`, `dashboard/server.py`, `dashboard/test_repoql_panel_origin.py` (new), `native/windows/rc_services.py`, `native/windows/test_rc_services.py`, `installer/build-msi.ps1`, `installer/prepare_msi_payload.py`, `installer/SingularityRepoQLRC-v4.wxs`, `installer/README-MSI.md`, `installer/Test-RCIsolation.ps1`, plus these documents |

## Final receipt

| Field | Value |
|---|---|
| Commit | `a367e62` + the documentation commit on top (recorded in the handoff) |
| Source archive | `singularity-native-windows-option2-SOURCE-ONLY.zip`, 955 files, 5,395,868 B, SHA-256 `be465e585cff47730c17ed904cfb5016e6fc5a7b32fca894156e8a3689c8ecfb` |
| MSI | `Singularity-RepoQL-Windows-Fleet861RC-0.5.2.0-x64.msi`, 7,480,295 B, SHA-256 `006c9a7fa24f7516537b8dd6aa68e5e0177a0d3539d7ebd740904d96f66ee7a0` |
| Package identity | 0.5.2.0, ProductCode `D8737523-4311-477E-B1E6-E8CA69714C3F`, UpgradeCode `7F2C4D19-5A6B-4C7E-9B3D-1E8A0C5D2F61` |
| Install root | `%LOCALAPPDATA%\Singularity\Fleet861RC` (perUser, no elevation) |
| Publication | none — local, unsigned, unpublished |
