# Windows RC2 handoff sheet

State at handoff: RC 0.3.0.0 **installed** on windows241 under
`C:\Users\Ben\AppData\Local\Singularity\Fleet861RC`, dashboard running detached
on loopback `127.0.0.1:18200` in default auto-local mode, production untouched.

## Where things are

| Thing | Path |
|---|---|
| MSI | windows241 `%TEMP%\rc2-out\Singularity-RepoQL-Windows-Fleet861RC-0.3.0.0-x64.msi` (sha256 `42ef699f…`) |
| Build receipt | windows241 `%TEMP%\rc2-out\Singularity-RepoQL-MSI-BUILD-RECEIPT.json` |
| MSI install logs | windows241 `%TEMP%\rc2\msi-upgrade.log`, `msi-uninstall.log`, `msi-reinstall.log` |
| RC tree | windows241 `%LOCALAPPDATA%\Singularity\Fleet861RC` (`source\`, `bin\`, helper scripts) |
| RC state | windows241 `%LOCALAPPDATA%\Singularity\Fleet861RC\state` |
| RC logs | windows241 `%LOCALAPPDATA%\Singularity\Fleet861RC\logs` (`rc2-serve.out`, `http-suite-rc2final.txt`) |
| Launcher used | windows241 `%LOCALAPPDATA%\Singularity\Fleet861RC\pkg\rc2_serve.py` (spawns the server detached) |
| Source archive | dockerhost `work/singularity-windows-claude-omb-20261105/dist-rc2/singularity-native-windows-option2-SOURCE-ONLY.zip` |
| Repo tree | dockerhost `work/singularity-windows-claude-omb-20261105/tree`, branch `rc-fleet893` |
| Raw logs | `work/singularity-windows-claude-omb-20261105/evidence-msi/01..27` and the run directory's `evidence/` |

## How to reproduce

```powershell
# regenerate the archive from the tree (dockerhost or any host with node)
python3 native/windows/build_source_variants.py --output-dir <out> --variant 2

# build (windows241, MSVC + cargo + dotnet + py on PATH; vcvars64 imported)
powershell -File installer\build-msi.ps1 -SourceZip <zip> -BuildRoot <new dir> `
  -OutputDirectory <out> -WxsFile installer\SingularityRepoQLRC-v2.wxs `
  -MsiFileName Singularity-RepoQL-Windows-Fleet861RC-0.3.0.0-x64.msi

# lifecycle
msiexec /i <msi> /qn /norestart /l*v upgrade.log
msiexec /x {FA5CBA0A-50E7-521E-926E-DC517FB2993F} /qn /norestart /l*v uninstall.log
msiexec /i <msi> /qn /norestart /l*v reinstall.log
```

Launch the RC server only through a detached launcher: a process started
directly by an SSH session is killed when that session closes (win32-OpenSSH
job object). Confirm readiness with an HTTP probe, not with
`Get-NetTCPConnection`, which under-reports this listener.

Stop command: `Stop-Process -Id <pid of the python running server.py>` (or
`Get-CimInstance Win32_Process | ? CommandLine -match 'Fleet861RC\\source\\dashboard\\server.py'`).

## What is verified

Upgrade over 0.2.0.0, clean uninstall, clean reinstall, isolation gate, Rust and
Python and Node batteries, auto-local first navigation, and the firewall probe
that proves the RC works with the fleet host unreachable while leaving the
production inventory (7 scheduled tasks, production ports, production ARP)
unchanged. Full row-by-row evidence is in
`docs/WINDOWS-RC2-ACCEPTANCE-MATRIX.md`.

## What is not verified, or is left for the director

1. **Anthropic login** on windows241 — the only external step. Until someone
   signs in, a bot model reply returns `Not logged in · Please run /login`.
2. **Live panel rendering** was verified over HTTP, not in a browser; no visual
   inspection of the tencent/office/kanzo/RepoQL panels was performed.
3. **Backend gateways** (`unified-repoql-control`, memory core, Office/Ghost)
   were not started, so auth-gated proxy endpoints answer 502. This is why ten
   `rc-http-suite` assertions fail in auto-local mode; see the matrix row 12.
4. **Uninstall bytecode residue** (defect D3): `msiexec /x` cannot remove
   runtime `__pycache__` files. A follow-up should set
   `PYTHONDONTWRITEBYTECODE=1` in the launcher or add a cleanup action.
5. **ARP hive** (defect D4): the RC registers machine-wide when installed from
   an elevated session, as the 0.2.0.0 package did.
6. **`bootstrapper/source.zip`** is a stale tracked snapshot and is not the
   source this MSI was built from.
7. **Signing, Burn bundle, Drive and publication** were deliberately not
   touched; nothing was pushed or tagged.
8. **Python suites** ran on dockerhost Linux, not on Windows.

## Claims NOT made

No product `runtimeVerified` / `native_runtime_accepted` attestation is claimed:
the payload receipt still records `native_runtime_accepted: false`, and the build
receipt records `product_runtime_accepted: false`. This slice proves packaging,
lifecycle, and local HTTP/window behaviour — not a full native runtime
acceptance.
