# Orchestra Rust migration, Pass 13 — final agent handoff

**Development candidate, not a complete or tested Rust harness.** The original JavaScript harness remains production authority.

This cumulative package contains the prior Rust code, telemetry prototype and safety gates, plus Rust candidates for phase-driver timeout decisions and read-only nanny observations. Both are wired into the JSON differential testing CLI; 205 new golden outputs were generated from the pinned original JavaScript source.

Start with the original pass-13 package's `docs/FINAL_AGENT_HANDOFF.md` and `MIGRATION_STATUS.md`; those documents and `scripts/validate-source-bundle.sh` are not included in this public source export. On a host with Rust/Cargo, use the original package's source-bundle validator; it fails closed on archive/source hash mismatches and native parity failures.

No code in this package should be deployed to the existing Orchestra production service until independent acceptance.

## Source test suite

The support artifacts under `adapter/`, `fixtures/`, `scripts/` and `docs/` are
part of this candidate; their provenance is recorded in `PROVENANCE.md`. Run
the self-contained source contracts with:

```bash
node --test harness/rust-authority/tests/*.test.mjs
```

These tests exercise the JS-side fixtures and adapters, not a compiled Rust
binary. The JavaScript-authority checks default to the in-repo `harness/kit`;
set `ORCHESTRA_REFERENCE_KIT` to a pinned external extraction to compare
against a historical source. Native build and parity acceptance remain
a separate, explicit step (`scripts/validate-source-bundle.sh`).
