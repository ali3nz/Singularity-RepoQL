# Wave 7 memory portability status

New complete source port: bounded self-learning lesson capture CLI
(`src/bin/memory-turn-capture.rs`), opt-in from the original Python CLI.
Source-equivalent behavior is tested with a Python legacy oracle; compiled
Rust comparison is pending a Windows Rust toolchain and reviewed lockfile.

The Rust `memory-impact-files` CLI rejects missing/unreadable sources. This
prevents apparently successful but incomplete staleness reviews. Compiled
negative testing is required before enabling native policy execution.

No changes were made to Kanzo authorization, MemoryCore writer, capture
consumer, orchestration routing or service ownership. Existing JavaScript
and Python paths remain authoritative until native validation succeeds.

See docs/WINDOWS_RUST_MEMORY_UPGRADE_WAVE7.md for release and rollback gates.
