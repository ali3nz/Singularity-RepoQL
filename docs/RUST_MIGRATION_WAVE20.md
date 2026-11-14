# Wave 20: Read-only MemoryCore native transport

Status: **SOURCE ONLY, not compiled, not activated, not verified on Windows**.

This is the cumulative Wave 19 source plus a new Rust executable in the
already-dependency-locked `native/windows/unified-gateway-rust` crate. Cargo
automatically discovers `src/bin/singularity-memorycore-reader.rs`; no new
third-party dependencies or hand-written dependency lockfile are introduced.

## Operations

The binary accepts one bounded JSON object on stdin and writes one JSON value
on stdout. It has **no add, update, delete, publish or administration API**.

- The legacy local MemoryCore hub: `resolveBlocks`, `search`, `skillList`.
  Endpoints are fixed to `/api/v1/chat-memory/team-assets`,
  `/api/v1/chat-memory/search`, and `/api/v1/skill/list`.
- The Windows product's MemoryCore API: `v3Read`, with only
  `/v3/conversation/search`, `/v3/atomic/search`, `/v3/conversation/query`,
  and `/v3/atomic/query` accepted. All `/v3/*/add` and mutations stay with the
  existing JavaScript client.

Both modes require an explicit `http://127.0.0.1:<port>` origin; redirects and
cross-host targets are forbidden. The native process reads credentials directly
from a local key file or the installed `memory.json` configuration file.
The request, not a command-line argument, carries the query/identity payload.
The child is bounded by request, response and time limits. No auth, query or
memory records are included in diagnostic errors.

## Integration and safety

`SINGULARITY_RUST_MEMORYCORE_READER_BIN` is **unset by default**. Only in an
isolated engineering checkout after native acceptance should it be assigned an
absolute path to the compiled `singularity-memorycore-reader.exe`.

The existing Node clients compute the reference answer first. For explicitly
selected Rust read operations they then execute the native reader and accept
it only on an exact deep semantic match. A missing binary, non-local origin,
malformed output or disagreement rejects the read. The JavaScript path remains
unchanged with the flag disabled. The new Windows hook path is wired through
`scripts/memory-config-loader.mjs` and therefore reaches the actual `/v3`
conversation/atomic lookup calls. No Rust process owns credentials, Task
Scheduler, Kanzo authorization, active indexing, or a memory write.

Legacy hub results are capped by their configured byte budgets, with UTF-8
character-boundary truncation. This repairs the old JavaScript use of a UTF-16
substring length in a UTF-8 byte budget. HTTP redirects are now refused on the
legacy client too.

## Evidence from the authoring environment

- `node --test harness/kit/tests/native-memorycore-reader.test.mjs scripts/native-memorycore-v3.test.mjs`
- `python native/windows/unified-gateway-rust/tests/differential_memorycore_reader.py`
  runs 17 **reference-only** cases against a temporary local HTTP stub.
- `node --test adapters/claude-code/memory-hook.test.mjs adapters/claude-code/memory-hook-process.test.mjs`
  checks the existing hook behavior.
- `node harness/kit/v46-memory-retrieval-truth-test.mjs` checks memory retrieval
  regressions.

The actual compiled Rust comparison is **NOT_RUN** in this environment. The
Windows gate and CI use the same fixture with `--rust-cli` after compiling the
binary with its existing reviewed Cargo.lock. The 4 other missing lockfiles,
Tencent upstream source, Kanzo authorized agent operations, live memory behavior,
installer upgrade and rollback still block production acceptance.

This is a source candidate, **not** an installer or authorization to enable Rust
in an installed service. Keep third-party RepoQL, Tencent and Kanzo unchanged.

## Windows installer import closure

The native Claude Code installer verifies `scripts/native-memorycore-reader.mjs`
as part of the hook source closure. Any staged Windows source missing this new
sibling module fails the source verification gate. Existing installed staged
source must be upgraded as a complete project-owned source revision; replacing
only `memory-config-loader.mjs` would break module loading.
