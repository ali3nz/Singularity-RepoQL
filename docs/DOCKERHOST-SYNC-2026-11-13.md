# Native Windows memory synchronization — 2026-11-13

Last updated: 2026-11-13. Scope: reviewed source changes before Windows cutover;
not a production-memory migration or proof of live extraction quality.

## Carried across

- **fleet#1268:** pinned L1 extraction prompt for both chat/code modes. Engineering
  memories retain decisions/results, exact evidence and unresolved work, reject
  process narration and always return a JSON scene array. The manifest records
  the MIT upstream revision, preimage and override hashes. Native prepare applies
  it after the existing core patch; LF/CRLF normalize to the same pinned content.
- **Current canonical memory policy:** the existing mapped SubagentStart hook
  searches L1 first (at most five), falling back once to L0 (at most three) only
  for empty/unavailable L1. No extra capture, writer, identity or database.
- **fleet#1262 portable lessons:** scoped corrections, outcome-focused learning,
  approved-skill selection and honest persistence evidence are reflected in the
  contributor and installed runtime rules. Existing reconciled hooks retain
  capture ownership; no platform extension is copied.

## Already present; preserved

The candidate already contains fleet#1214 capture-time task binding and bounded
chronological recovery, fleet#1219 conditional semantic fallback and executor
binding, and fleet#1202 progressive retrieval, temporal truth and exact-identifier
ranking. Preserve its native adapters and exact-claim tombstone policy; copying
older deployed kit files would regress this product derivative.

## Deliberately not copied

Host-specific post-hoc task-link commands, capture-selector attribution work,
service/timer definitions, private registries, credentials and runtime data do
not belong in this native product. The current explicit-binding recovery stays
read-only; this sync introduces no unverified association writer or new pipeline.

## Verification and rollback

Use only the focused prompt-transform and memory-hook fixtures for these changes;
no live model request or broad regression is needed. See `NATIVE-MEMORY-STACK.md`
for prepare/rollback and mismatch handling. The retained pre-sync file manifest
provides rollback hashes. Existing prepared memory data and running processes
are not modified by this source synchronization. The exported derivative archive
must regenerate its own source manifest; frozen baseline manifests stay intact.
