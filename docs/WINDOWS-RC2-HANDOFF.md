# Windows RC 0.5.2.0 — handoff

Local, unsigned, unpublished release candidate. Branch `rc-fleet893` (no remote
configured). Everything below is measured on windows241; nothing is claimed for
another machine or for an upstream merge.

## What the package is

| Field | Value |
|---|---|
| MSI | `Singularity-RepoQL-Windows-Fleet861RC-0.5.2.0-x64.msi` |
| Bytes / SHA-256 | 7,480,295 / `006c9a7fa24f7516537b8dd6aa68e5e0177a0d3539d7ebd740904d96f66ee7a0` |
| Source archive | `singularity-native-windows-option2-SOURCE-ONLY.zip`, 955 files, 5,395,868 B, SHA-256 `be465e585cff47730c17ed904cfb5016e6fc5a7b32fca894156e8a3689c8ecfb` |
| Identity | Version 0.5.2.0, ProductCode `D8737523-4311-477E-B1E6-E8CA69714C3F`, UpgradeCode `7F2C4D19-5A6B-4C7E-9B3D-1E8A0C5D2F61` |
| Scope | perUser, no elevation; install root `%LOCALAPPDATA%\Singularity\Fleet861RC` |
| Media | one embedded CAB — the MSI alone is the distribution |

## What changed since 0.5.1.0

1. **The RepoQL Control Panel now points at the host that serves it.** RepoQL
   mints its panel listener on a dynamic port and records the origin in
   `<workspace>/.repoql/cache/dashboard-bind.json`; the dashboard proxied the
   constant `127.0.0.1:41005`, which on this machine is no host at all
   (production host 52511, RC host 59796). `panel_origin()` resolves
   `SINGULARITY_REPOQL_PANEL_ORIGIN` or the bind record, the proxy, the WebSocket
   path and the redirect boundary all use it, and the RC launcher advertises the
   same-origin embed. The panel went from 503/502 to 200 with its own assets.
2. **`Test-RCIsolation.ps1` decides port occupancy by connecting**, not by a
   socket-table row that Windows can leave behind with owning pid 0.
3. Carried over from 0.5.1.0: the installed dashboard owns its local account
   (`SINGULARITY_LOCAL_ACCOUNT_AUTH=1`, default mode `auto-local`) and the five
   backends start from the candidate's own tree.

## How it was proven (logs in `evidence-msi-remediation/`)

| Claim | Log |
|---|---|
| Build from the committed tree, embedded CAB, WiX 6.0.2, Rust gate + tests | `60-msi-build-052.log` |
| Upgrade 0.5.1.0 → 0.5.2.0 from a distribution-only folder | `62-upgrade-051-to-052.log` |
| Uninstall, clean reinstall, production inventory unchanged | `57-lifecycle-final-uninstall-reinstall.log` |
| RC isolation gate (with the post-install pre-install assertions named) | `58-rc-isolation-post-install.log` |
| Auth acceptance, auto-local, `-Ttl 30` (expiry + logout) | `49-auth-auto-local-052-ttl.log` (18/0/0) |
| Auth acceptance, password, `-Ttl 30` (expiry + logout) | `50-auth-password-052-ttl.log` (20/0/0) |
| Real data: RepoQL status, setup health, three panels | `51-functional-checks-052.log` |
| Official Control Panel document + asset, Kanzo write cycle through the proxy | `56-functional-panel-write-acceptance-v3.log` (7/0) |
| Installed payload vs archive, byte for byte | `61-msi-source-correspondence-052.log` (957/957) |
| Python batteries at HEAD | `63-unit-suites-052.log` |
| Post-reinstall smoke | `59-post-reinstall-smoke.log` |

## What an operator should know

- **State is preserved across uninstall.** `state\`, `workspace\`, `memory\` and
  the installed board's own home stay; only the packaged payload is removed.
- **The RC needs an interactive logon** to start the RepoQL host. A
  `rql serve` launched from a scheduled task exits with
  `Win32Exception: Access denied` before its startup phase, for both the
  user-local and the installed binary; the same command from an ordinary logon
  starts in ~2 s. This is a harness limitation of the installed product's own
  task (`Interactive/Background`, stored credentials), not something this
  candidate can create unattended.
- **Ports**: dashboard 18200, Kanzo 18202, Office 18203, Memory core/panel
  18221/18226, RepoQL panel = whatever that workspace's host binds (read from the
  bind record). Production 18100/18101/18126/18128 are never bound.
- **Isolation gate sequencing**: run `Test-RCIsolation.ps1` *before* the first
  install. After an install it correctly reports `rc_state_root_absent` and
  `rc_not_already_in_arp` as failed; that is the gate describing a machine that
  already has the candidate, not a packaging fault.
- **No secrets in this tree or in the logs.** Session values are never printed;
  the RepoQL login capability is never returned to the browser (the launch route
  answers 303 with no `#k=`/`t=`).

## Open items (external only)

- Anthropic/model API account authorization for a live bot reply.
- The dockerhost-blocked firewall exercise was not re-run for 0.5.2.0; it was
  proven for the previous candidate and no rule was added in this continuation.
- `bootstrapper/source.zip` remains a stale tracked artifact (documented, not
  used by the build).

## Resume

```powershell
# install (distribution folder holds only the MSI)
msiexec /i .\Singularity-RepoQL-Windows-Fleet861RC-0.5.2.0-x64.msi /qn /norestart

# start the five backends, then the dashboard
& "$env:LOCALAPPDATA\Programs\Python\Python312\python.exe" `
  "$env:LOCALAPPDATA\Singularity\Fleet861RC\source\native\windows\rc_services.py" launch

# re-run the acceptance in either mode
powershell -NoProfile -ExecutionPolicy Bypass -File .\rc-auth-suite.ps1 -Mode auto-local -Ttl 30
powershell -NoProfile -ExecutionPolicy Bypass -File .\rc-auth-suite.ps1 -Mode password -Ttl 30
```
