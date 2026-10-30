# Milestone 49: one read-only acceptance observation command

This milestone adds `native/windows/claude_complete_windows_probe.py` for **native Claude Desktop Code tab / Claude Code Complete only**. It does not install, update, start or stop anything.

The entrypoint composes pre-existing bounded proof checks without inventing a new backend protocol:

1. `prepare_option2_candidate.inspect` verifies the candidate ZIP, manifest and nested source. Offline `--bundle` inspection is available on any host.
2. Explicit `--live` on native Windows requires a previously prepared candidate, and invokes `verify_prepared_option2_candidate.verify_prepared` to check its complete on-disk inventory against the original ZIP.
3. It invokes `native_runtime_acceptance.observe` to observe known binaries, pinned `rql.exe` version 1.7.18, and identity-shaped loopback health endpoints configured locally. These observations **do not prove component ownership or correctness**.
4. Optional `--evidence-dir` reads and checks SHA-256 for existing, operator-collected acceptance receipts and reports unreviewed vs missing vs failed gates. It never creates, alters, or approves gate receipts.

A local runtime config must use `singularity-windows-runtime-observation-config/v1`, variant `2`, and the existing fixed binary and component identities. Do not commit that private config. The output intentionally omits local paths, URLs, keys, chat text, or raw service replies. It always returns `release_ready: false`.

## Offline inspection (without Windows)

```powershell
python native/windows/claude_complete_windows_probe.py --bundle C:\Private\candidate.zip --runtime-config C:\Private\runtime-observation.json
```

## Explicit read-only Windows observations (after a genuine candidate is built and prepared)

```powershell
python native/windows/claude_complete_windows_probe.py --bundle C:\Private\candidate.zip --prepared "$env:LOCALAPPDATA\Singularity\WindowsNativePreview\option2-test-001" --runtime-config C:\Private\runtime-observation.json --evidence-dir C:\Private\reviewed-gate-evidence --live --output C:\Private\m49-observations.json
```

No current source milestone includes a compiled binary, developer-accepted installer, proof of GUI skills, actual Tencent conversation recall, independent RepoQL index readback, Office event roundtrip, Ghost isolation or reboot recovery. **Release remains BLOCKED.**

## Testing strategy

Nine isolated, mocked unit tests target orchestration and fail-closed behavior. Wider regression and native Windows acceptance are deliberately deferred until the user requests staged final testing.
