# Milestone 21 — Windows runtime observations and Agent Chat read safety

**Release status: BLOCKED — SOURCE ONLY.** Windows required RepoQL remains **1.7.18**, connector ABI **1**. No dependency on Claude Code free workers has been introduced. Claude Office still defaults to the previously working server-side token URL. Production Linux services and GitHub main were not changed.

## Implemented and tested in this development environment

1. `native/windows/native_runtime_acceptance.py` is a *read-only* native Windows CLI, distinct from source inventory. It accepts an exact-schema, data-only configuration containing four local PE executable paths and optional component-specific loopback health ports. It refuses UNC/WSL locations, Windows reserved names, NTFS alternate data streams, reparse points, missing or non-PE files, known Docker/WSL runtime wrappers and ambiguous RepoQL version banners. No arbitrary command lines or credentials can be supplied. Only the known `rql.exe --version` check is executed with a five-second bound.
2. The health probe makes direct `127.0.0.1` GET requests to `/.well-known/singularity-health`, with no redirects or ambient proxy, and checks unique component identity headers with bounded response reads. The existing Rust supervisor's identity header remains **reachability evidence only**, not authenticated process identity, functional success or proof of the specific child owning the port. Only the Windows dashboard currently implements this endpoint in source.
3. The CLI refuses to run on non-Windows hosts, does not start/stop services, does not modify GUI state, does not read bearer tokens, refuses to overwrite an output receipt, and cannot produce a parity PASS or public-release-ready receipt. Live Windows observations must still be accompanied by separate production-vs-Windows functional tests.
4. `dashboard/agentchat_feed.py` now compares the file identity observed without following the final symlink to the file actually opened. It rejects a symlink, Windows reparse point or file swapped between `lstat` and `open`. This is defense in depth for file replacement, **not complete protection against malicious parent-directory races**; native Windows ACLs and real delivery/replay remain mandatory.
5. New real HTTP and filesystem-race tests are included in native Windows CI.

## Running the diagnostic on a future native Windows machine

Provide a JSON file with this **example shape only**, replacing all paths and ports with verified local installations:

```json
{
  "schema": "singularity-windows-runtime-observation-config/v1",
  "variant": 4,
  "repoql_version": "1.7.18",
  "files": {
    "repoql": "C:\\PATH\\TO\\rql.exe",
    "bridge": "C:\\PATH\\TO\\singularity-desktop-bridge.exe",
    "supervisor": "C:\\PATH\\TO\\singularity-windows-supervisor.exe",
    "gui": "C:\\PATH\\TO\\OpenChamber.exe"
  },
  "health": [{"id": "dashboard", "port": 8765}]
}
```

Then run `py -3 native\windows\native_runtime_acceptance.py --config C:\\path\\runtime.json --output C:\\path\\new-observation.json` on native Windows. A `public_release_ready: false` result is **expected even when binaries and HTTP observations pass**. The report deliberately cannot certify memory capture, self-learning, connector indexing, Office events, Ghost prompt edits, Agent Chat delivery, live graph, GUI usage or rollback.

## Remaining P0 blockers

- No `rustc`/`cargo` available in this container and no linked GitHub repository accessible to dispatch the authored Windows CI. The new Rust authority, supervisor and desktop bridge remain uncompiled and their Win32 runtime tests unrun.
- Full GUI installation, upgrades, rollback, scheduled service lifecycle and Windows ACL/Job Object acceptance need an actual Windows runner with compiled binaries.
- Native Tencent MemoryCore/MemoryKnowledge, RepoQL 1.7.18 connector index and readback, Harness worker leases, self-learning, Agent Chat delivery/replay, Kanzo writes, Office token URL/event flow, Ghost daemon, memory graph and usage attribution need real end-to-end tests against independently installed services.
- Windows package ZIPs are source-only. They exclude Linux deployment artifacts but retained shared Linux source code may still contain platform assumptions; dynamic dependency closure remains unverified.

This milestone should not be described as a working installer, a completed native port or production-equivalent self-learning.
