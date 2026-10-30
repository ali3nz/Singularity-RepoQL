# Milestone 69 — rollback staging integrity

Before a previous Windows staging snapshot is restored, the generic stager now validates the version pin, complete file inventory against source-manifest SHA-256 hashes, and the bridge/supervisor binaries against receipt hashes and PE headers. Unrecorded supervisor binaries are refused. The Claude Code Complete installer additionally verifies the snapshot as owned/unchanged, including unexpected file detection. No snapshot files are moved until validation passes.

Source-level structural tests: four passed. The PowerShell code has not been executed in this Linux environment; native Windows validation, actual signature/provenance and end-to-end restore still required. `releaseReady:false`.
