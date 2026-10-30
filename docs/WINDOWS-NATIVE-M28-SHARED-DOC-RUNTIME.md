# Milestone 28 — attached OpenChamber documentation runtime closure

**Status: source-level repair tested; native Windows/runtime parity remains unverified.**

## Failure caught by repository-wide validation

`scripts/attach-openchamber.mjs` installed `doc-policy.mjs` and
`selflearn-candidates.mjs` into the foreign OpenChamber runtime, but omitted
`doc-ingest-node.mjs`. The policy directly imports that Node ingestion engine,
so the installed `runbook-nudge` plugin failed its shared-policy import and
returned `null`, disabling automatic documentation discovery for attached
installations even though the files looked installed.

## Repair

The attach installer now includes `doc-ingest-node.mjs` as the fifth
byte-identical shared runtime dependency. The same transactional attach
manifest/backup/rollback applies to it. The existing runtime test validates
all five installed files, imports the shared policy through the copied plugin,
and checks automatic discovery functions. A regression fails if the Node
engine is omitted again.

Only the source attach path changes; production services are not modified.
The Windows source variants remain source-only, with no native Office, Ghost,
Tencent/RepoQL or self-learning end-to-end acceptance receipts.

## Validation

Run `node --test scripts/attach-openchamber.test.mjs` and
`node --test openchamber/plugins/runbook-nudge/runbook-nudge.test.mjs`.
Do not claim release parity until Codex verifies the real Windows OpenChamber
plugin lifecycle, documentation ingestion, index readback and restart recovery.
