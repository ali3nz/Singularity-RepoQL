# Rust Wave 22: dashboard telemetry normalization

Wave 22 moves the dashboard's model usage accounting normalization to an
optional Rust binary while retaining the Python collector as storage, privacy
and ledger authority. The exact Python result must match for every metadata
row before a source batch is committed. The original collector continues to
operate when Rust is disabled.

Critical behavior: ChatGPT subscription review receipts are not outbound API
charges. Only explicitly transport-scoped sender metrics can contribute to
reported cost. In-memory records are batch-bounded, and the Rust binary gets
only a strict set of accounting fields rather than run contents or credentials.

The native differential suite has 609 synthetic Python reference cases and is
configured to repeat them using a compiled executable in Windows CI.
Source-only validation is not evidence of Rust execution. Live Windows
installation, release acceptance and service rollback remain pending.
See `native/windows/RUST_WAVE22_HANDOVER.md` for the verification commands.
