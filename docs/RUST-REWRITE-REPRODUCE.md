# RUST-REWRITE-REPRODUCE — build and check this tree yourself

Everything here runs from the repository root of the delivered ZIP. No operator machine,
private path, credential or live service is required. Two environments are useful:
a Linux host for the packaging/static checks, and a clean Windows x64 VM for the native
crates and any install rehearsal.

## 1. Host prerequisites

| Tool | Version | Why |
|---|---|---|
| Git | any recent | checkout only |
| Python | 3.12 (3.13 for Office paths) | packaging, static checks, legacy oracle |
| Node.js | 24.22.2 (`native/windows/runtime-pins.json`) | legacy oracle, hook/doc tests |
| Rust | current stable, `x86_64-pc-windows-msvc` on Windows / host triple on Linux | 8 crates, edition 2021 |
| MSVC Build Tools + Windows SDK | VS 2022 build tools | Windows crates and the service wrapper |
| 7-Zip or `Expand-Archive` | any | only if you rebuild the ZIP |

The tree does not pin a Rust toolchain file; record `rustc -Vv` and `cargo -V` with your
build so the result is attributable. `Cargo.lock` is committed for every crate — always
build `--locked`.

## 2. Static package checks (any OS)

```bash
sha256sum -c SHA256SUMS
python3 native/windows/check_rust_lock_provenance.py          # expect 8/8 locked
python3 native/windows/verify_source_release.py               # packaging contract
python3 -m unittest discover -s native/windows -p 'test_windows_source_ci.py' -q
python3 native/windows/repoql_compat.py --help                # connector contract text
```

The first command verifies every file in the tree except `SHA256SUMS` itself. A single
mismatch means the tree was modified after delivery — stop and re-extract.

## 3. Build the Rust crates

Linux can build and test the portable crates; the Windows supervisor, desktop bridge and
setup front-end need Windows.

```bash
cargo test  --manifest-path harness/rust-authority/Cargo.toml --all-targets --locked
cargo test  --manifest-path native/windows/rc-stack-rust/Cargo.toml --all-targets --locked
cargo test  --manifest-path native/windows/release-evidence-rust/Cargo.toml --all-targets --locked
cargo test  --manifest-path native/windows/source-packager-rust/Cargo.toml --all-targets --locked
cargo test  --manifest-path native/windows/memory-parity-rust/Cargo.toml --all-targets --locked
cargo test  --manifest-path native/windows/unified-gateway-rust/Cargo.toml --all-targets --locked
```

Windows additionally:

```powershell
cargo build --manifest-path native/windows/rust-supervisor/Cargo.toml --release --locked
cargo test  --manifest-path native/windows/rust-supervisor/Cargo.toml --all-targets --locked
cargo test  --manifest-path native/desktop-bridge/Cargo.toml --all-targets --no-default-features
cargo test  --manifest-path native/desktop-bridge/Cargo.toml --all-targets --no-default-features --features office
cargo fmt   --manifest-path native/desktop-bridge/Cargo.toml --check
python native/windows/check_rust_lock_provenance.py
```

Expected outcomes: every `cargo test` exits `0`; the lock check prints one row per crate
with a lock SHA256 and exits `0`; `cargo fmt --check` prints nothing. If `cargo` asks for
the network, your cache is cold — that is expected on first build, not a failure of the
tree.

## 4. Legacy oracle tests (Node and Python)

The JavaScript/Python paths are still the reference behaviour while Rust is opt-in.
Run them in the same checkout:

```bash
node --test native/windows/refresh_installed_claude_rules.test.mjs
node --test harness/kit/lib/windows-portability.test.mjs
node --test tests/doc-ingest-parity.test.mjs
node --test tests/doc-ingest-rust-boundary.test.mjs
node --test adapters/claude-code/memory-hook.test.mjs
python3 -m unittest discover -s dashboard -p 'test_variant_features.py'
python3 -m unittest discover -s dashboard -p 'test_variant_http.py'
python3 -m unittest discover -s dashboard -p 'test_native_repoql_gate.py'
python3 -m unittest discover -s native/windows -p 'test_windows_memory_gateway_source.py' -q
python3 tests/test-memory-security.py --windows-source
python3 tests/test-memory-promote.py
python3 tests/test-memory-doc-ingest.py
```

## 5. Build and scan the source archive

```bash
python3 native/windows/build_source_variants.py --output-dir /tmp/singularity-src --variant 2
python3 native/windows/scan_source_archive.py \
  /tmp/singularity-src/singularity-native-windows-option2-SOURCE-ONLY.zip
```

The builder is deterministic (fixed ZIP timestamps) and refuses unclassified or retired
paths. The scanner enforces the no-binary/no-secret packaging policy. A clean build prints
the archive path and a scoped `SHA256SUMS`; a scan failure names the offending entry.

## 6. Optional: assemble on a Windows VM

On a clean Windows x64 VM, with this tree extracted somewhere writable:

```powershell
$env:LOCALAPPDATA                     # must exist
python native\windows\verify_source_release.py
powershell -ExecutionPolicy Bypass -File native\windows\install_claude_complete.ps1 -Mode Plan
```

`Plan` is read-only and prints what it would do. Do **not** run `Stage`, `Configure`,
`RegisterSupervisor` or `DashboardRegister` on a machine you care about: those mutate the
per-user install root, scheduled tasks and services. They are for the dedicated acceptance
VM (see [RUST-REWRITE-ACCEPTANCE.md](RUST-REWRITE-ACCEPTANCE.md)).

Optional pre-req for a rehearsal (separate installers, not in this ZIP):

- Node 24.22.2 from the pinned URL + SHA256 in `native/windows/runtime-pins.json`
- RepoQL 1.7.18 from the pinned installer + SHA256
- Python 3.12 (3.13 only for Office)
- Claude Code installed by the operator; the product does not redistribute it

## 7. What a successful reproduction looks like

| Step | Success signal |
|---|---|
| `sha256sum -c SHA256SUMS` | every line `OK`, no missing file |
| lock provenance | `8/8` crates, each with a lock digest |
| `cargo test --locked` (per crate) | exit 0, test counts in the output |
| legacy oracle suites | exit 0 |
| archive build + scan | archive path printed, scan exits 0 |
| `install_claude_complete.ps1 -Mode Plan` | read-only report, no mutation, exit 0 |

If a step fails, capture the full output, the command line and `rustc -Vv`/`node --version`/
`python --version`, then report it with the failing path. Do not patch the tree to make a
check pass; the checks are the specification for this handoff.
