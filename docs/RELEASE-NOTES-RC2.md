# Release notes — Singularity RepoQL Windows RC (0.5.2.0)

Local, unsigned, unpublished release candidate. Built from branch `rc-fleet893`
(`a367e62` plus this documentation commit) on windows241 with the repository's
own `installer/build-msi.ps1`. Nothing was pushed, tagged or signed.

## Artifact

| Field | Value |
|---|---|
| MSI | `Singularity-RepoQL-Windows-Fleet861RC-0.5.2.0-x64.msi` |
| Bytes | 7,480,295 |
| SHA-256 | `006c9a7fa24f7516537b8dd6aa68e5e0177a0d3539d7ebd740904d96f66ee7a0` |
| Source archive | `singularity-native-windows-option2-SOURCE-ONLY.zip` |
| Archive SHA-256 | `be465e585cff47730c17ed904cfb5016e6fc5a7b32fca894156e8a3689c8ecfb` |
| Archive files | 955 (5,395,868 bytes) |
| WiX | 6.0.2, provisioned into a temporary tool path by the build script |
| Toolchain | `x86_64-pc-windows-msvc` |
| Install root | `%LOCALAPPDATA%\Singularity\Fleet861RC` |
| Package identity | 0.5.2.0, ProductCode `D8737523-4311-477E-B1E6-E8CA69714C3F`, UpgradeCode `7F2C4D19-5A6B-4C7E-9B3D-1E8A0C5D2F61` |

The package is one self-contained file (embedded CAB) and upgrades 0.5.1.0 in
place through the shared UpgradeCode.

## What this candidate contains

- **A working embedded RepoQL Control Panel.** The dashboard resolves the panel
  origin from the running host's own bind record
  (`<workspace>/.repoql/cache/dashboard-bind.json`) or from an explicit
  `SINGULARITY_REPOQL_PANEL_ORIGIN`, instead of assuming `127.0.0.1:41005`.
  RepoQL mints the listener on a dynamic port; on a machine that also runs the
  installed product those ports differ (52511 vs 59796 here), so the constant
  pointed at nothing or at the other workspace's panel. The proxy, its WebSocket
  path and its redirect boundary all use the resolved origin.
- **The installed dashboard opens signed in.** `SINGULARITY_LOCAL_ACCOUNT_AUTH=1`
  and a default `auto-local` mode come from the RC launcher, matching the
  production host; a `password` mode remains an explicit choice.
- **Five local backends start from the candidate's own tree**: the RepoQL host
  over an RC-owned workspace, MemoryCore + MemoryPanel, the owner identity, the
  Kanzo board on an RC home/port, and the Claude Office service on RC state.
- Auto-local sign-in, Setup health + repair, the Kanzo-claim MCP server, the
  headless OpenMausBot adapter, the native memory stack module and the password
  embed boundary for all four panels.

## Verified on windows241

| Exercise | Result |
|---|---|
| Upgrade 0.5.1.0 → 0.5.2.0 from a folder holding only the MSI | `msiexec` exit 0; ARP 0.5.2.0; installed source carries the resolver |
| Uninstall | exit 0; ARP gone; payload removed; `state\`/`workspace\` preserved |
| Clean reinstall | exit 0; 1,263 installed files; ARP 0.5.2.0 |
| Installed payload vs packaged archive | 957/957 members identical, 0 missing, 0 extra |
| Auth acceptance, auto-local, `-Ttl 30` | 18 pass / 0 fail / 0 not tested |
| Auth acceptance, password, `-Ttl 30` | 20 pass / 0 fail / 0 not tested |
| Functional data and panels | `/api/status` 2,225 files, semantic 100 %; Control Panel document + 66 KB asset; Tencent, Office, Kanzo panels 200; Kanzo write through the proxy created, read back and deleted |
| Python batteries | dashboard 223 (1 skipped), rc-services 30, provision 14, memory 11 — all OK |

## Defects fixed in this slice

1. RepoQL Control Panel proxied a hard-coded port (`native_repoql_proxy_unconfigured`
   then 502). Fixed by resolving the host's own listener; six new contracts.
2. `Test-RCIsolation.ps1` failed `rc_port_free` on a port that refused every
   connection, because `Get-NetTCPConnection` still listed a stale row with
   owning pid 0. Occupancy is now decided by connecting.

## Known limitations

- The RepoQL host must be started from an interactive logon; a scheduled-task
  start fails inside `rql serve` with `Win32Exception: Access denied` (the
  installed product uses a stored-credential task that an unattended harness
  cannot create).
- The dockerhost-blocked firewall exercise was not re-run for this candidate.
- `bootstrapper/source.zip` is a stale tracked artifact, unused by the build.
- Anthropic/model API account authorization is still an external step for a live
  bot reply.

---

# Earlier candidates (history)

The sections below document the 0.3.0.0 candidate and its slice. They are kept
because the defect list and the packaging decisions still explain the current
authoring (`MediaTemplate EmbedCab="yes"`, perUser scope, the deferred
`__pycache__` cleanup action, and the ARP observation).

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

## Security incident during this slice

**S1 — RC session cookie values appeared in tool output (contained).** While
reporting the HTTP suite, nine `srq_session` values from
`evidence-msi/26-rc-http-suite-fresh-account.log` were surfaced in terminal
output. Those sessions are treated as compromised. Containment:

1. The RC dashboard keeps sessions **only** in an in-memory dict
   (`dashboard/local_account.py:42`); nothing is written to disk. Killing the
   process therefore destroys every issued session.
2. Both prior server processes (launcher `11844`, interpreter `3256`) were
   terminated, the RC state directory was emptied, and the server was restarted
   under a new process pair (`20660`/`26772`). Evidence: log `30`.
3. All 55 session values across `21`, `23` and `26` were replaced with
   `[REDACTED]`; a re-scan of the retained logs finds no remaining value, and
   every test outcome (`SUMMARY pass=27 fail=10`) is unchanged. Future reporting
   prints cookie **name, length and flags** only.
4. Nothing production-side was touched or restarted, and no authentication
   check was weakened to accommodate the suite.

The exposed values are dead: they were memory-only in processes that no longer
exist. The one session live at handoff was issued after that restart.

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
| Post-incident revocation | prior server processes dead, state empty, session store memory-only, fresh 43-character session with `HttpOnly`/`SameSite=Strict`/`Max-Age=28800` |

## Residual items

There is exactly one external step left, and it is not a product defect: an
Anthropic login on windows241 for a live Claude model reply. The blocked bot
turn from the integrations slice names it precisely (`Not logged in · Please run
/login`, no `~/.claude/.credentials.json`). Nothing in the repository can supply
that credential.

Not tested in this slice: a silent NSIS installer path (the RC ships the MSI),
code signing, Cloudflare/Drive publication, and any browser-rendered visual
inspection of the panels.
