# fleet#1175: staged MemoryCore L1 idempotency overlay

This is the six-file Dockerhost fleet#1175 source diff staged as an **additional**
overlay for Windows Singularity's existing pinned Tencent `v2.0.2` deployment.
It adds deterministic L1 record IDs, replay-safe persistence and supersession
behavior. Its source is the accepted `six-file-v10.diff` from the Dockerhost
fleet#1175 evidence bundle, not a reconstructed implementation.

It is **not enabled in the Windows build**. The previous Singularity overlay
`core-v2.0.2-l1recordids` must be applied first. The fleet evidence shows a
working Dockerhost runtime, but this Windows source archive does not contain
Tencent's pinned upstream MemoryCore sources. Therefore this combined chain
cannot be declared applicable or compiled until the upstream source is supplied.

## Verification and build preparation

Acquire `TencentCloud/TencentDB-Agent-Memory` commit
`99a1a2c251741658917e3fa700bf8e337ad15a5f`, verify the pinned tarball
SHA256 `11dab534e0a11ce69de2f9eef309fa85d297b63fbfa63df20742a15d0a6267e0`,
and extract the `MemoryCore` subdirectory.

Run `python memory/patches/core-v2.0.2-l1idem2/validate-overlay.py --upstream <verified-MemoryCore-dir>`.
The command does not modify the supplied tree. It checks upstream source hashes,
applies the existing overlay inside a temporary directory, checks its resulting
hashes, then applies this fleet#1175 overlay and checks six final hashes against
the reported live Dockerhost deployed image. It fails closed on any discrepancy.
Use `--output` for a fresh verified source output directory if required.

There is no schema migration in the Dockerhost release. Windows still requires
its own backend typecheck, tests, runtime readback and deployment approval.
Do not change the installed image or copy over runtime data based solely on
this staging artifact.

Evidence source: `memoryhub-l1-idem-fleet1175-20261111T1050Z.tar.gz`, accepted
Sol consultation `2026-11-11T10-35-07-433-142239`.
