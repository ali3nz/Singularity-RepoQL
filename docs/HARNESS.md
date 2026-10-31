# Portable harness

The AI Orchestra harness, exported as a self-contained engine that runs on a host
that has nothing but Node and a POSIX shell. It answers one question: **can the
harness engine be installed next to an unrelated product and still be the only
thing that decides what a run is doing?**

Yes, with limits this document states plainly. The engine is the authority; the
launcher is a passthrough; anything the host cannot provide is reported
unavailable instead of guessed.

## What ships

| Path | What it is |
| --- | --- |
| `harness/kit/` | The engine: `orchestrate.mjs`, `lib/`, `prompts/`, `skills/`, `docs/`, `tests/`, `config.json`, `config/repoql-scopes.json`. No runtime directories. |
| `harness/kit/lib/kit-paths.mjs` | The only place that resolves a host path or an optional capability. |
| `harness/harness.config.json` | The declarative profile: container↔host mapping table, feature switches, authority state. |
| `bin/ai-orchestra` | Thin verb-preserving launcher (Node). |
| `harness/rust-authority/` | The Rust state authority, source only, **dormant**. Never built or started here. |
| `harness/openchamber-patches/` | The OpenChamber delta as a patch series with an apply/reverse script — not a tree copy. |
| `harness/NOTICES` | Licensing for every third-party component this contribution carries. |
| `harness/CHECKSUMS` | sha256 of the exported source sets and of `Cargo.lock`. |
| `tests/harness-*.test.mjs` | The portable gate: contract, authority, config schema, guards, resolved paths. |

Nothing in this directory writes to the repository root, installs a package,
starts a service or contacts a provider.

## Architecture decision this implements

- **The kit is the harness's single engine authority.** Run state, locks, gates
  and acceptance live in `harness/kit`; nothing else in the product may own them.
- **`bin/ai-orchestra` stays thin.** It resolves the engine home, runs
  `orchestrate.mjs` with the caller's argv untouched, inherits stdio and returns
  the engine's exit code. It adds no verbs and rewrites no arguments.
- **Rust ships dormant and opt-in.** The launcher never sets
  `ORCHESTRA_RUST_AUTHORITY`; `harness.config.json` records `mode: "dormant"`.
  The protocol env names are frozen and must not be renamed:
  `ORCHESTRA_RUST_AUTHORITY`, `_ROLLBACK`, `_TOKEN`, `_TOKEN_FILE`, `_LEASE_MS`
  (declared in `harness/kit/lib/rust-authority.mjs` as `AUTHORITY_ENV`). The
  JavaScript engine remains the run-state authority. The Rust tree is here for
  review and for a future operator decision, not for this installation.
- **No adapter-merge into product orchestration.** The product's own
  `orchestration/` and `scripts/orch-run` are untouched: a portable-harness run
  and an `orch-run` run are distinct lanes with distinct run ids, and neither
  reads the other's state.

## Running it

```bash
# from the repository root
node bin/ai-orchestra help
node bin/ai-orchestra status
node bin/ai-orchestra selftest
```

Requirements: Node **>= 22** recommended (the engine's entry gate uses
`import.meta.main`, which exists on Bun and Node >= 22.18). On older Node the
export falls back to an `argv[1]` comparison so the engine still runs instead of
exiting 0 silently, but 22.18+ is the tested profile. On Windows, run under
**WSL2** with a POSIX shell; native `cmd`/PowerShell is not supported.

`ORCHESTRA_KIT_HOME` runs an engine living somewhere else. The launcher refuses an `ORCH_STATE_DIR` inside the engine
home: the engine owns `<kit home>/runs`, and a second state root inside the kit
could hand out a run id that another lane already used.

## Configuration

Read `harness/harness.config.json`. Every entry resolves to a value or to `null`,
and `null` means *this host does not have it*:

- `features.consultFetch.sshHost` — an optional read-only SSH host used to fetch
  an `--open` file that is not present locally (`CONSULT_FETCH_HOST` overrides).
  `null` means no remote fetch: the brief reports the file unreadable instead of
  guessing a host.
- `mapping.table[]` — `id`, `container` (what the engine sees), `hostEnv`
  (override variable) and an optional `hostDefault`. With no host side, the
  translation functions are identity. That is why an unmapped host is harmless
  rather than a wrong path.
- `features.repoql` — external retrieval engine. Not bundled. Until `bin`/`cwd`
  point at a working `rql` host, retrieval-dependent stages degrade to
  `INSUFFICIENT` and the selftest probe reports `UNAVAILABLE`.
- `features.openchamberWatch` — live OpenChamber/HA narration. All of
  `sshHost`, `chatsRoot`, `opencodeDb` and `haConfig` must be set; otherwise the
  watch cycle emits nothing and reports why (`unavailableReason`).
- `rustAuthority` — `mode: "dormant"`, `protocolVersion: 1`.
- `ORCH_LOCAL_CORPUS_PREFIXES` — semicolon-separated local-corpus URI prefixes
  for the confidential-workspace check, added to the portable defaults. The
  product ships no deployment-specific corpus names.
- `ORCH_SOURCE_REPO_MAP` — JSON object mapping `owner/repo` to an absolute local
  root for the direct-fetch fallback. An unmapped `github://` URI returns no
  bytes rather than reading a guessed mount.
- `ORCH_PRIOR_KNOWLEDGE_GLOB` — RepoQL URI glob for consult prior-knowledge
  retrieval. Default `**/*` (this repository); a deployment can point it at its
  own indexed knowledge mirror.

The engine's own `kit/config.json` keeps its schema (`schemaVersion: 3`) and its
exact top-level key set. Values that named a fleet — host paths, host names,
account ids, seat/model entitlements, project-board ids — are **removed**
(empty string or `null`), not replaced with invented ones. Provider *lane* names
(`openai-sol`, `opencode-muse-free`, `fcc-ghost-vision`, …) are part of the
engine's routing surface and stay; without credentials they fail honestly.

## Verifying it

```bash
node --test tests/harness-contract.test.mjs tests/harness-authority.test.mjs \
             tests/harness-config-schema.test.mjs tests/harness-guard.test.mjs \
             tests/harness-paths.test.mjs
bash tests/scan-refs.sh      # repository reference scan (owned by the integrator)
```

The suites are offline: no provider, model, RepoQL host, ssh target or network.
They assert the frozen contract (help text fixture, argv behaviour, authority
protocol 1, config schema), the guards (no run state in the shipped tree, no
state dir inside the engine home) and the resolved-path translation.

## Known gaps

Stated here rather than hidden behind a "parity" claim.

1. **`selftest` is green in the portable profile.** `node bin/ai-orchestra
   selftest` exits 0 with 635 checks passing and exactly one labelled `SKIP`:
   the Sol bridge gateway/rc-taxonomy pins, which read a fleet-only script that
   is not part of the export. Every check that can be decided without a fleet
   deployment asserts the portable contract instead of being dropped — for
   example, with no host map the brief must NOT claim it fetched a remote file,
   and free-seat path translation must be identity. Set
   `ORCHESTRA_SELFTEST_PROFILE=fleet` on a fleet host to run the skipped pins
   too; a `FAIL` is always a failure in either profile.
2. **Portability debt: 40 files (169 occurrences)** still name a fleet host in
   comments or in `ssh <host>` calls — the Discord/HA narration, session watcher
   and memory modules. Their verbs report unavailable or fail at the point of
   use. Absolute fleet **paths** are gone: every default now resolves from
   `harness.config.json`, and an unconfigured path root is `/opt/harness-unset/…`
   (a value that exists nowhere), so a feature reads "not configured" instead of
   a real host directory. `tests/harness-guard.test.mjs` fails if the documented
   count drifts from the tree.
   *Reference hygiene:* internal `issue NNN` references were normalised to
   `ticket NNN`, so the repository's public guard (`tests/scan-refs.sh`) passes
   on this contribution — it exits 0 with zero matches.

3. **No OpenChamber application delta.** Upstream `openchamber/openchamber`
   `v2.5.2` is `c4919abc1e7a0a3beeaa126666487806bf79cfe0`. The fleet build's
   5-commit delta (`9ad2a0200`, 32 files) is **not published**: the commit is
   absent from the upstream repository (GitHub API and `git cat-file` both
   negative) and the fleet checkout has no remote carrying it. The patch series
   is therefore recorded as a declared gap with an apply script that refuses to
   run without the objects. No source-parity claim is made: **the OpenChamber
   application delta is NOT shipped**. `harness/openchamber-patches/apply.sh`
   exits **3** when `series` holds no patches — the documented outcome today,
   and exit 3 is not success. The directory is a clean slot: on a host that has
   the objects, `git format-patch v2.5.2..9ad2a0200` fills `patches/`, `series`
   lists them, and `apply.sh --apply` is the only way they are applied.
4. **The runtime config bundle was not copied.** The running container's
   `~/.config/opencode` bundle (88 files, 29 plugins) includes back-ups, reviews,
   state and `node_modules`; only generic plugin *config shape* is relevant to a
   product and none of it is shipped here. The OpenCode runtime pin (v2.1.4 in
   the running container) is recorded in `harness/config/openchamber-runtime.json`
   as documentation, not as a dependency.
5. **No MemoryCore, Ghost, connector, dashboard or Office content** is part of
   this contribution; those are separate work packages with their own ownership.
