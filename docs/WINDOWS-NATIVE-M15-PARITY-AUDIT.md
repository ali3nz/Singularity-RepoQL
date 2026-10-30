# Native Windows versus production Docker: Milestone 15 evidence audit

**Release verdict: BLOCKED.** Do not claim feature parity, native service installation, absence of runtime Linux dependencies, or native Rust compilation on the basis of this source package. This is a read-only review plus source portability changes, not a successful clean Windows installation.

## Scope and source of truth

- Audited the complete Milestone 14 source tree and the four source-only variants. The existing Docker/Linux production implementation remains present in the **complete source** for comparison; it is not intended to execute in native Windows option packages.
- The Milestone 15 Windows SOURCE-ONLY builder now excludes Linux deployment entrypoints: `compose/`, `systemd/`, `memory/upstream/`, `memory/portable/systemd/`, `*.sh`, `*.service`, `*.timer`, `*.compose.yml`, Dockerfiles, the legacy dashboard Docker Compose and Linux `/proc` sampler. The post-build scanner rejects any reintroduction. This **does not** prove the remaining Python/Node/Rust services have native Windows backends or run without Docker.
- Each option retains the common source adapters for Tencent MemoryCore, RepoQL MCP 1.7.15 / ABI 1, dashboard, Agent Chat, Kanban and memory workflows. Options 2 and 4 also contain Ghost and Office; 1 and 3 exclude them.
- The legacy `scripts/install-claude-code.mjs` explicitly refuses to run on Windows. Do not silently route Windows users through its Docker probing or shell provisioning. Its Docker-oriented Linux production operations remain unchanged.
- The Agent Chat Python CLI can import on Windows and uses a Windows state directory and bounded file lock. The Linux consult dispatch path deliberately refuses Windows operation until process identity and the native Rust launcher are proven. The dashboard's read-only Agent Chat feed now uses `%LOCALAPPDATA%/Singularity/AgentChat` as a native default; explicit environment overrides still win. This is not evidence that the relay or delivery is production-equivalent.
- The dashboard state default now uses `%LOCALAPPDATA%/Singularity/Dashboard` for native Windows instead of `~/.local/state`. The portable Rust CPU probe exists but authentic native RepoQL process attribution and history are still unverified.
- The Office token-URL exchange remains the Windows default for complete variants, with its known production-compatible server-side handling. No change was made to the production Office settings. The older `docs/WINDOWS-NATIVE-RELEASE.md` default description was corrected; it had incorrectly claimed `key_file` was the default.

## Concrete dependencies and missing behaviour — P0 unless stated otherwise

| Subsystem | Findings from audited source | Windows acceptance still required |
| --- | --- | --- |
| Tencent MemoryCore / MemoryKnowledge | Production `memory/upstream/*.sh` and Compose launchers are excluded from Windows variants. No tested native Windows replacement stack is included. | Start native components, persist data, recover after reboot, prove authentic identities, ingestion, extraction, recall and separation. |
| RepoQL | The package pins 1.7.15 / connector ABI 1; binaries are supplied externally. | Install genuine native `rql.exe`, index/query/readback and test both real connectors, not only `--version`. |
| Legacy doctor/installer | The existing doctor recommends Compose and the legacy installer invokes Docker; the installer now refuses Windows, but doctor parity remains unproven. | A native doctor must verify every required Windows feature from real process/data proofs and refuse release without them. |
| Self-learning and documentation | Legacy Node/Python/Rust assessment, ingestion, candidate promotion and reconciliation sources exist. Source-level tests are not semantic parity. | Reproduce production fixtures end-to-end: session capture, bounded extraction, proposed knowledge, conflict handling, verified documentation and TTL/relevance validation. |
| Harness | Rust Windows named-pipe server and Windows Job Object supervisor are source-only. The shared `harness/kit/orchestrate.mjs` still contains Linux `/proc` checks and Docker/SSH worker instructions; native IPC alone does not port these workflows. | Compile and run all Rust crates, client identity, pipe ACLs/timeouts, crash/restart handling and spawn-to-job ownership race. |
| Claude Desktop / OpenChamber GUI | Native hooks/adapters and configuration planning exist, but no completed transactionally reversible GUI installer. | Prove actual GUI hook activity, auto capture/recall in a *new* session, MCP tools, user consent/rollback and no CLI-only substitution. |
| Agent Chat and Kanban | CLI read/state portability improved; no proven Windows relay/backend. Kanzo connector is source, not a running native Kanzo board. | Durable cross-session messages, board CRUD/readback, cursor/idempotency, conflict/restart recovery. |
| Ghost (2/4) | Legacy Linux task/control logic and prompt store; partial Rust HTTP client only. | Native control daemon, task lifecycle, prompt versions/revert, confirmed writes, dream cycle and interruption recovery. |
| Claude Office (2/4) | Known token URL/proxy preserved; Linux Docker Office compose excluded from Windows variants. | Native Office startup, real GUI event round trip and iframe rendering without token leakage. |
| Dashboard | Python server and route/feature guards exist; Linux-specific telemetry logic remains in shared code; native service orchestration and real connector integration unproven. | End-to-end same-origin sessions for each service, CSRF, auto renewal, live graph, CPU/GUI subscription metrics and restart. |
| Public distribution | Windows SOURCE-ONLY ZIPs contain no binaries or working installer. | Signed reproducible native builds, dependency SBOM/licence review, Windows installer/uninstaller, clean VM acceptance for all four options. |

## What can be checked now versus what cannot

**Offline/source verified (not functional Windows acceptance):** four Windows source package filesets do not include the explicitly identified Linux deployment assets; the package manifest no longer declares WSL-free operation or parity as an established fact; source checksum/security checks and Node/Python tests can run; Windows Agent Chat CLI portability/fail-closed dispatch policy can be inspected; the Docker-oriented installer refuses native Windows.

**Not evidenced here:** a live production feature-level baseline, compiled Windows Rust binaries, a working native Tencent/MemoryKnowledge service, native Office/Ghost/Kanzo services, actual GUI agent hooks, Windows CPU attribution or subscription receipts, self-learning equivalence, or clean install/upgrade/reboot/uninstall. A green health endpoint, present source file or passing mocked test **never** upgrades these statuses to PASS.

## Behavioural parity procedure (must be run on two actual systems)

Use **the same synthetic fixture set** in both environments (never production secrets or private conversations): two independent user keys, multiple agent identities and isolated sessions, a deliberately conflicting fact, one relevant and one irrelevant document, CRLF/LF revision equivalence, a new-session recall question and intentionally interrupted task/run. Record each test's observed output, negative assertions, version, timestamp and an immutable evidence ID. Test normal and restart/reboot paths.

1. On the production Docker host, capture fresh **sanitised** receipts for the observable outcomes, not only process/port status. Confirm which capabilities the production install actually demonstrates. Do not dump API keys, Office token URLs, conversation contents, mailbox identities or real memory records.
2. On a clean Windows 11 VM **without WSL or Docker installed**, perform independent builds/installation for options 1 through 4. For each option verify real native process ancestry and files, Rust IPC, GUI events, connector indexing, both memory and self-learning paths and post-reboot outcomes. If any subprocess attempts to invoke Docker, WSL, bash, systemd, `/proc`, a Unix socket or an unavailable Linux-only service, record FAIL with the executable/script call stack.
3. Complete `native/windows/compare_production_parity.py` receipt files for each host, including an evidence ID and current observation timestamp per mandatory feature. Run the comparator. It refuses missing, stale, synthetic and mismatch records. Review referenced evidence independently; this comparator **cannot prove** that evidence IDs are genuine.
4. Verify negative controls: missing secrets do not leak; role A cannot retrieve role B memories; lean variants do not expose Ghost/Office code or routes; subscription metrics never include Freebuff or unattributed provider usage; CPU is per verified native process and not guessed from an arbitrary PID.
5. Release only after each option passes semantic parity, full source/installer reproducibility and native GUI acceptance. Do not substitute the existing Docker host's implementation as a Windows component.

## Rust migration policy

Prefer Rust for persistent Windows services, process ownership, IPC, credential boundary, memory ledger, graph processing and mutation transports. Keep only *thin unavoidable adapters* in the languages required by the third-party host (OpenCode JavaScript/TypeScript plugin API, Python/JS only where upstream interfaces demand it). This is **not** a claim that all of the current shared Python/Node implementations have been ported: a substantial Rust migration remains.

## Release gates, ordered

1. Real Windows Rust `cargo fmt`, `cargo clippy -D warnings`, unit tests and signed/hashed binaries; fix known supervisor containment race and validate named-pipe ACLs/stall handling.
2. Native Tencent and MemoryKnowledge backend/service bootstrap with no Docker/WSL, plus RepoQL 1.7.15 connector indexing and data-path proof.
3. Transactional per-user installation of both GUIs and all mandatory profile services, backup/upgrade/rollback/uninstall and reboot resilience.
4. Ghost/Office full variants plus real Agent Chat/Kanban and live memory graph; no synthetic dashboards.
5. Production-vs-Windows semantic fixture comparison, security, provenance/licence and full clean-machine acceptance.

**Verdict: NOT READY FOR PUBLIC RELEASE.** All changes in this milestone are source-only, additive and do not touch production state or GitHub main.
