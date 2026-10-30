# Milestone 33: Claude Code Complete documentation ingestion backlog fix

Release state: **BLOCKED; source-only checkpoint**, based on the verified Milestone 32 full-source archive and prioritising Claude Code Complete (Option 2).

## Evidence-backed correction

The shared `autoIngestChangedDocs()` and native Claude Code `Stop` hook process at most eight changed documents per lifecycle pass. Previously, when the first eight succeeded and a ninth or later eligible document remained, both paths could refresh the entire session baseline. That made remaining changes disappear from subsequent discovery, even though Tencent ingestion had never run for those files. Retaining the old baseline wholesale would instead repeatedly select the already-successful first eight.

Both paths now call the same narrow acknowledgement helper to advance baseline entries only for explicitly resolved documents (`DOC_INGEST_INDEXED` or `DOC_INGEST_UNCHANGED`), keeping unresolved and unprocessed changes discoverable. When a full pass resolves every changed document, the existing complete-baseline refresh remains. The Claude hook reports the number of queued documents rather than silently closing the batch.

On Windows, `SINGULARITY_DOC_ROOTS` must be semicolon-delimited, not colon-delimited: `C:\\...` has a drive-letter colon. POSIX colon-delimited configuration remains unchanged. This fixes a Windows-specific root-discovery regression. Existing workspace allowlist, documentation content filters, Tencent credential policy, agent routing and RepoQL 1.7.18 ABI 1 pin are unchanged.

Two `repoql-feedback` files present in the verified complete Milestone 32 archive but absent from the narrow Option 2 source artifact are retained by rebuilding from the complete source. The portable-agent-bundle test requires the feedback template.

## Verification scope

New focused test: `scripts/doc-policy-batch.test.mjs` covers Windows drive-letter parsing, a ten-document ingestion backlog, one failed entry, incremental acknowledgement, and the next-pass completion path.

The full-source Node selection (Claude Code adapter, Windows Node tests, document ingestion, portable-agent bundle) passed 174/174 after final acknowledgement merge-hardening. The 82 Windows source Python tests passed. A broader dashboard test discovery was started, but exceeded the sandbox run limit and is **not an accepted test result**. These are local offline tests, not Windows live tests.

## Unresolved release blockers

The Milestone 32 live blockers remain: native GUI Code-tab hook and skill discovery, full main-session memory capture/recall, live Tencent agent identity seeding, independent Tencent and RepoQL current-revision readbacks for the same hub document, Office and Ghost native lifecycles, Win32 binaries, service registration and production-equivalent self-learning. Tencent-only `DOC_INGEST_INDEXED` does not certify RepoQL indexing. Do not enable a release or upgrade RepoQL solely from this checkpoint.
