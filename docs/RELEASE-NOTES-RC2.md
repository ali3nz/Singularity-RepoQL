# Release notes — Singularity RepoQL Windows RC2 (0.3.0.0)

Local, unsigned, unpublished release candidate. Built from branch `rc-fleet893`
(`ba00658` plus this slice's commits) on windows241 with the repository's own
`installer/build-msi.ps1`. Nothing was pushed, tagged or signed, and Drive was
not touched.

## Artifact

| Field | Value |
|---|---|
| MSI | `Singularity-RepoQL-Windows-Fleet861RC-0.3.0.0-x64.msi` |
| Bytes | 205,752 |
| SHA-256 | `42ef699fa6cba1e418b3b6ebb4822ea5c4b52ea57d22078c4591fccd069739b1` |
| Source archive | `singularity-native-windows-option2-SOURCE-ONLY.zip` |
| Archive SHA-256 | `282fbc77ef2e5b829f70235799fe3eeeab351cb914649b4e6789e2af9fadd64b` |
| Archive files | 949 (5,364,245 bytes) |
| WiX | 6.0.2, provisioned by the build script into a temporary tool path |
| Toolchain | `x86_64-pc-windows-msvc`, rustc 1.99.1, dotnet 8.0.425, Python 3.12.10 |
| Install root | `%LOCALAPPDATA%\Singularity\Fleet861RC` |
| Package identity | Version 0.3.0.0, ProductCode `FA5CBA0A-50E7-521E-926E-DC517FB2993F`, UpgradeCode `7F2C4D19-5A6B-4C7E-9B3D-1E8A0C5D2F61` (unchanged) |

The package replaces the 0.2.0.0 RC in place through `RemoveExistingProducts` and
still cannot touch the production package, which has a different UpgradeCode,
perMachine scope and Program Files root.

## What this RC contains

Everything committed on `rc-fleet893`, which the previously installed 0.2.0.0 RC
did not have:

- Dashboard auto-local sign-in (per-request consent, first-navigation session).
- Setup health provisioner and the Kanzo-claim MCP server.
- Headless OpenMausBot adapter with RC-owned state.
- Native memory stack module (`memory/rc_stack.py`) and its scoped probe.
- Real provisioner adapters for the local integrations.
- Password-mode embed boundary for the RepoQL dashboard and the tencent, office
  and kanzo gateway panels.

## Defects found in this slice, and the resolutions

**D1 — the source pin predated the branch (fixed).** `installer/build-msi.ps1`
and `installer/prepare_msi_payload.py` pinned the 2026-11-05 archive
(`e8392ba8…`). That archive has no auto-local dashboard code and none of the
branches' modules; building from it can only reproduce the old product. The
installed RC proved it: its payload receipt named the same archive and its
`server.py` carried zero auto-local references. Resolution: the archive is now
generated from HEAD by `native/windows/build_source_variants.py --variant 2`,
which recomputes `SHA256SUMS` and `NATIVE_WINDOWS_SOURCE_MANIFEST.json` and runs
`scan_source_archive` before writing. Both pins now carry `282fbc77…`.

**D2 — the stale native source manifest (fixed as a side effect).** The
integrations slice reported 8 of 933 hashes in
`NATIVE_WINDOWS_SOURCE_MANIFEST.json` no longer matching HEAD, which made any
configurator `apply` against the tree fail with
`SOURCE_HASH_PROVENANCE_MISMATCH`. The regenerated archive ships a manifest that
matches its own contents (949 entries).

**D3 — uninstall leaves Python bytecode behind (documented, not fixed here).**
`msiexec /x` removes every payload file (verified: 0 non-payload, non-bytecode
files remained) but leaves `dashboard\__pycache__\*.pyc` and
`native\windows\__pycache__\*.pyc`, so the `source` directory tree survives as
17 empty directories plus bytecode. Those files are written at runtime and are
not MSI-owned, so Windows Installer cannot remove them. Resolution for this
slice: the clean cycle removes the residual RC root before reinstalling, and a
follow-up should either run the dashboard with `PYTHONDONTWRITEBYTECODE=1` or
have the uninstall custom action clean the bytecode. Recorded as a known
limitation of an otherwise clean uninstall.

**D4 — the ARP entry is registered machine-wide despite perUser scope
(observed, pre-existing).** With `Scope="perUser"`, `ALLUSERS=2` and
`MSIINSTALLPERUSER=1`, files still land under `%LOCALAPPDATA%`, but the
Add/Remove entry appears under `HKLM` because this SSH session is elevated. The
0.2.0.0 package behaved identically, so this is not a regression. Consequence:
removing the RC from an elevated session works, and removal from an unelevated
one may prompt. Production is unaffected — the RC's UpgradeCode and install
directory remain disjoint.

**D5 — detached build and server processes die with the SSH session
(environmental).** Win32-OpenSSH puts session children in a kill-on-close job.
Two detached build attempts terminated silently mid-`cargo test` with no event
log entry. Resolution: process creation through `Win32_Process.Create` and, for
the RC server, a launcher that spawns it with `DETACHED_PROCESS |
CREATE_NEW_PROCESS_GROUP` and redirected stdio. The RC now survives session
teardown and was verified still serving afterwards.

**D6 — `Get-NetTCPConnection` under-reports the RC listener (environmental).**
Several "listener not up" readings were false: `Get-NetTCPConnection
-LocalPort 18200` returned nothing while `GET /` answered 200. Listener state is
therefore confirmed by HTTP probes, not by that cmdlet.

## Test results in numbers

| Battery | Result |
|---|---|
| `cargo test` desktop-bridge / rust-supervisor / unified-gateway-rust | 20 / 0 (no tests) / 31 passed, exit 0 each |
| Rust lock provenance (`check_rust_lock_provenance.py`) | pass, `readyForRustDependencyReview: true` |
| `Test-RCIsolation.ps1` | 17/18 checks pass; the only failure is its pre-install-only assertion that the RC is not yet in ARP |
| `rc-http-suite.ps1` (lane-a) | 27 pass / 10 fail — all ten are password-mode assertions superseded by the auto-local default (see the acceptance matrix) |
| Python: embed, auth_modes, local_account, gateway_locality | 5, 14, 5, 9 tests, all OK |
| Python: provision, memory, openmausbot | 13, 10, 13 tests, all OK |
| Node: kanzo-claim | 17/17 pass |
| Auto-local first navigation on the installed RC | `GET /` → 200, `srq_session` issued with no credentials |
| dockerhost-blocked firewall probe | blocked with the rule, still serving locally, rule removed, inventory unchanged |

## Residual items

There is exactly one external step left, and it is not a product defect: an
Anthropic login on windows241 for a live Claude model reply. The blocked bot
turn from the integrations slice names it precisely (`Not logged in · Please run
/login`, no `~/.claude/.credentials.json`). Nothing in the repository can supply
that credential.

Not tested in this slice: a silent NSIS installer path (the RC ships the MSI),
code signing, Cloudflare/Drive publication, and any browser-rendered visual
inspection of the panels.
