# Windows RC2 — 18-row acceptance matrix

Scope: local MSI build, isolated RC lifecycle, test batteries, release
paperwork. Machine: windows241 (`ali3nz\ben`, PowerShell 5.1). Install root:
`C:\Users\Ben\AppData\Local\Singularity\Fleet861RC`. Every row names the raw log
that proves it; logs are in `evidence-msi/` (and copied into the run
directory's `evidence/`).

| # | Acceptance item | Result | Evidence |
|---|---|---|---|
| 1 | Source archive regenerated from branch HEAD by the repository generator, with release scan | PASS — 949 files, 5,364,245 B, sha256 `282fbc77…`; `scan_source_archive` accepted it | `06-msi-build-foreground.log`, generator stdout |
| 2 | Archive contains the branch's work, not the stale snapshot | PASS — `headless.py`, `rc_stack.py`, `test_embed_password_mode.py` present; `server.py` sha `202aeabe` with 14 auto-local references (old archive: `4b5ac325`, 0) | archive inspection in run notes, `04-installed-rc-source.log` |
| 3 | Both source pins updated to the new archive | PASS — `build-msi.ps1` `$expectedSourceHash`, `prepare_msi_payload.py` `SOURCE_SHA256` | `git diff` review recorded before commit |
| 4 | MSI built by the verified entry point only, local, no Burn/signing/publication | PASS — `build-msi.ps1` exit 0; WiX 6.0.2 self-provisioned; MSI 205,752 B sha256 `42ef699f…`; no bundle built | `06-msi-build-foreground.log` |
| 5 | Payload receipt binds the MSI to the archive | PASS — `INSTALLER-PAYLOAD-RECEIPT.json` records `source_zip_sha256` `282FBC77…`, 951 source entries, four binary hashes | `06-msi-build-foreground.log`, `17-reinstall-lifecycle.log` |
| 6 | Rust dependency provenance gate | PASS — `readyForRustDependencyReview: true`, exit 0 | `06-msi-build-foreground.log` |
| 7 | Rust unit tests for the three crates | PASS — desktop-bridge 20, rust-supervisor 0 (no tests), unified-gateway 31; exit 0 each | `07-rust-cargo-tests.log` |
| 8 | Upgrade over the installed 0.2.0.0 RC | PASS — `msiexec` exit 0; ARP 0.2.0.0 `{4E7B62D5…}` → 0.3.0.0 `{FA5CBA0A…}`; source 951 → 968 (951 payload + 17 runtime `.pyc`); `server.py` now `202aeabe`; `state\token` preserved | `15-upgrade-lifecycle.log` |
| 9 | Clean uninstall | PASS with defect D3 — `msiexec /x` exit 0; ARP gone from HKCU/HKLM/WOW6432Node; `bin\`, `Start-Here.ps1`, `README-MSI.md`, `Configure-Singularity.ps1` gone; residual files 17, **all** `__pycache__`, 0 non-payload product files | `16-uninstall-lifecycle.log`, `17-reinstall-lifecycle.log` |
| 10 | Clean reinstall | PASS — residual root removed, `msiexec /i` exit 0; 951 installed = 951 archive entries, **0 extras, 0 missing**; four binaries present; four helper scripts present; fresh state | `17-reinstall-lifecycle.log` |
| 11 | `Test-RCIsolation.ps1` from its verified location | PASS 17/18 — the single failure is `rc_not_already_in_arp`, a pre-install-only assertion that is necessarily false once the RC is installed; every isolation check (distinct UpgradeCode/ProductCode/install dir/bundle, perUser scope, LOCALAPPDATA root, disjoint live roots, non-production port, launch target, 7/7 live tasks) passes | `18-rc-isolation.log` |
| 12 | `lane-a/evidence/rc-http-suite.ps1` from its verified location | **27 pass / 10 fail**, each failure itemised: `root_anon` (expects sign-in page, gets auto-local session), `api_status_anon` 401→502, `api_health_anon` 401→200, `api_panels_anon` 401→404, `api_omb_anon` 401→404, `cookie_forged` 401→502, `api_status_bearer_with_origin` 401→502, `api_status_bearer_wrong` 401→502, `api_after_logout` 401→502, `listener_released_after_stop`. All ten assert *unauthenticated* behaviour or a suite-owned server stop; the RC2 default authenticates the first request and its backend gateways are not running, so 200/502 are the correct answers in this mode. Password-mode boundaries are covered instead by `test_auth_modes.py`, `test_local_account.py` and `test_embed_password_mode.py` (all pass) | `23-rc-http-suite.log`, `24`, `25`, `26` |
| 13 | Python unit batteries | PASS — embed 5, auth_modes 14, local_account 5, gateway_locality 9, provision 13, memory 10, openmausbot 13; all `OK`, exit 0 | `12-python-suites-unittest.log`, `14-session-and-kanzo-suites.log` |
| 14 | Short-TTL session behaviour | PASS — `test_auth_modes.py` (TTL/expiry assertions) 14/14; live cookie contract observed `HttpOnly; SameSite=Strict; Max-Age=28800` | `14-session-and-kanzo-suites.log`, `21-rc-foreground-serve.log` |
| 15 | Node kanzo-claim suite | PASS — 17 tests, 17 pass, 0 fail | `14-session-and-kanzo-suites.log` |
| 16 | Installed RC left in default auto-local mode | PASS — with `SINGULARITY_LOCAL_ACCOUNT_AUTH=1` and fresh state, `GET /` returns 200 and a `srq_session` cookie with no credentials; server survives session teardown | `19`, `21`, `22-rc-detached-start.log` |
| 17 | dockerhost-blocked test with exclusive RC executable path and guaranteed cleanup | PASS — rule scoped to the RC's interpreter `…\Programs\Python\Python312\python.exe` (not the production `…\Singularity\Runtime\python\python.exe`) + remote `192.168.1.240`; probe `BLOCKED PermissionError` while `127.0.0.1:18200` still `REACHED` and the dashboard answered 200; rule removed in `finally`, probe `REACHED` again, `RC2-*` rules back to 0 | `27-firewall-dockerhost-block.log` |
| 18 | Production inventory unchanged, paperwork complete, committed without publication | PASS — 7/7 `Singularity-*` tasks before and after, production ports untouched, production ARP untouched; scans and documents below; commits local only, no remote configured | `27-firewall-dockerhost-block.log`, `09`, `10`, `git log` |

## Tracked-file scans (W8)

`git ls-files` = 980 files, 16.7 MiB total for the whole tree.

| Check | Result |
|---|---|
| Private-key / cloud-token patterns over tracked files | 4 files matched, all deliberate fixtures: `adapters/claude-code/memory-hook.test.mjs` (redaction test), `connectors/kanzo/tools/build_suite.py` (`hunter2secret` sample), `connectors/kanzo/tools/pin.py` (forbidden-value list), `harness/kit/orchestrate.mjs` (`dummy12345678`, `secret-in-evidence` fixture). No live credential |
| `Bearer <token>` literals | 6 matches, all fixtures/assertions (`fixture0123456789`, `dummy…`, local probe headers) |
| Binary / non-text tracked files | 3: `bootstrapper/source.zip` (5,306,179 B), `docs/assets/memory-architecture.png`, `native/windows/assets/singularity-dashboard.ico` |
| Files over 512 KiB | `bootstrapper/source.zip`, `docs/assets/memory-architecture.png`, `harness/kit/orchestrate.mjs` |
| Checksums | The RC2 archive carries a regenerated `SHA256SUMS` (949 entries) and `NATIVE_WINDOWS_SOURCE_MANIFEST.json` (950 entries incl. itself); MSI sha256 recorded in the release notes |

`bootstrapper/source.zip` is a **stale tracked artifact**: a 934-file copy of the
2026-11-05 snapshot (`a7b18e7e…`, zip of `e8392ba8…`), committed in the baseline
commit `63215e6`. It is not what the MSI builds from and it does not match this
branch. It should either be refreshed from the RC2 archive in a follow-up or
removed from version control; this slice leaves it untouched and documents it so
nobody mistakes it for the release source.

## Upstream reconciliation

| Item | Value |
|---|---|
| Branch | `rc-fleet893`, no remote configured (local only) |
| Base | `5aaf766` (Fleet861 RC 0.2.0.0 reviewed tree) |
| Commits ahead of base before this slice | 4 integrations commits, tree clean at `ba00658` |
| This slice | Pin/identity change + documentation, committed path-scoped after re-reading `git diff` |
| Upstream divergence | None claimed. No upstream fetch/push/tag was performed and no remote exists, so nothing can be reported as merged |
| Files changed by this slice | `installer/build-msi.ps1`, `installer/prepare_msi_payload.py`, `installer/SingularityRepoQLRC-v2.wxs`, plus `docs/RELEASE-NOTES-RC2.md`, `docs/WINDOWS-RC2-ACCEPTANCE-MATRIX.md`, `docs/WINDOWS-RC2-HANDOFF.md` |
