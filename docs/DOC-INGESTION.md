# DOC-INGESTION.md — automatic documentation ingestion and the closure gate

Singularity treats documentation as part of the work. When an agent completes a
material change, the runbook/documentation it produced must be *ingested* into
the installation's Tencent memory stack, verified as genuinely searchable, and
kept revision-controlled — so a later agent retrieves the CURRENT procedure,
not a stale one. This page covers the shared engine (`scripts/memory-doc-ingest.py`),
the shared policy (`scripts/doc-policy.mjs`) and the per-client wiring
(OpenChamber runbook-nudge; Claude Code doc-hook). The same two modules serve
both clients; there is no second policy text and no second ingestion engine.

## Roles and source of truth

- **Filesystem / repository documentation** — the authoritative source. A
  memory record never overwrites the file.
- **Tencent MemoryCore (agent experience)** — what a specific agent
  encountered and learned (team/user/agent identity per agent).
- **Tencent MemoryCore (documentation knowledge)** — scoped identity
  `agent_id: docs-keeper` (team `singularity-docs` / user `shared` by default,
  overridable with `DOC_INDEX_TEAM` / `DOC_INDEX_USER`). Shared current
  documentation lives here so different agents retrieve the same procedure
  without sharing private experience.
- **RepoQL** — code intelligence and verified engineering concepts (undamaged).

## Ingestion pipeline

```
documentation completed
  → eligibility (Markdown, within --root allowlist, size caps, no secret filenames)
  → sensitive-content rejection (secret shapes/fences; reject, never silent redaction)
  → content hash (sha256) → ledger check
  → chunking by markdown headings (≤7000 chars/chunk, fences respected, no truncation)
  → chunk writes (deterministic task_id docs-<docid>-r<rev>-cNN; marker search → skip if present)
  → bounded retrieval verification (every chunk marker searchable, ≤30 s window)
  → supersession tombstone for the previous revision (idempotent)
  → atomic ledger activation (flock + os.replace)
```

Statuses (per document):

| Status | Meaning |
| --- | --- |
| `DOC_INGEST_INDEXED` | persisted AND every chunk verified searchable — the only success |
| `DOC_INGEST_UNCHANGED` | source hash equals the verified active revision; nothing written |
| `DOC_INGEST_PENDING` | written but not yet searchable (eventual indexing); retry works |
| `DOC_INGEST_FAILED` | write/verification failed; the previous verified revision stays active |
| `DOC_INGEST_BLOCKED` | eligibility/security/size refusal; nothing partial is claimed |

Only `DOC_INGEST_INDEXED` (or a verified `DOC_INGEST_UNCHANGED`) closes the
documentation requirement. A `PENDING`/`FAILED` state means the task is
incomplete even if the implementation itself succeeded.

## Commands

```bash
# ingest one document when it was just written/updated (the automatic path)
python3 scripts/memory-doc-ingest.py ingest --file docs/runbooks/example.md \
  --root <project-root>/docs --session <session-id>

# retry pending/failed (event-driven; the Claude Code Stop hook runs this)
python3 scripts/memory-doc-ingest.py retry --all --root <project-root>/docs

# inspect the ledger against current sources (stale_source = disk ahead of memory)
python3 scripts/memory-doc-ingest.py status --all --root <project-root>/docs

# bounded search of shared documentation knowledge (agents use this)
python3 scripts/memory-doc-ingest.py search "restart pump procedure"

# include superseded revisions for auditing only
python3 scripts/memory-doc-ingest.py search "restart pump" --stale
```

Environment: `KNOWLEDGE_INDEX_BASE_URL`, `MEMORY_SECRETS` (same as
knowledge-promotion), `SINGULARITY_DOC_DATA` (state dir, default `./data`),
`DOC_INDEX_TEAM`, `DOC_INDEX_USER`, `SINGULARITY_DOC_ROOTS` (extra allowlist
roots).

State lives in `data/doc-index/ledger.json` — product-local runtime data
(git-ignored): one active revision per document (`doc_id`, content hash, task
ids, chunk count, verification timestamp), protected by flock and written with
atomic replace. Concurrent ingests cannot corrupt each other, and a crash
never leaves a torn ledger.

## Revision management and supersession

- A document's logical ID and its revision come from stable hashes
  (`doc_id` = sha256 of the relative path, `rev` = sha256 of the content), so
  retries are idempotent and unchanged documents cost one cheap search.
- Updating a runbook ingests the NEW revision first, verifies every chunk, and
  only then records an idempotent tombstone
  (`[docs-superseded:<docid>:<old>-><new>]`) and flips the ledger's active
  revision. The normal retrieval path excludes superseded revisions; use
  `--stale` for audits.
- If the memory stack cannot verify the new revision, the old revision stays
  active and the ledger records `PENDING`/`FAILED` — nothing false is claimed.

## The documentation closure gate (shared policy)

Both clients decide documentation the same way. A material task reports
exactly one outcome and records it for deterministic verification:

- `DOC_UPDATED` — docs were created/updated (list the files) AND each was
  ingested with `DOC_INGEST_INDEXED`/verified `DOC_INGEST_UNCHANGED`, AND the
  knowledge-capture step was reported (`CAPTURED` | `NO_LESSON` | `DEFERRED`).
- `DOC_NOT_REQUIRED` — only for genuinely non-material changes (formatting,
  typos, throwaway work) with a concrete reason. The validator refuses it
  when material files changed without a skip justification.
- `DOC_BLOCKED` — required but not completed; NEVER closes a task.

Material trigger list: features, material behaviour changes, API/integration
changes, deployment/infrastructure changes, auth/security changes,
operationally-relevant configuration changes, non-trivial bug fixes,
recurring incidents, new troubleshooting or recovery procedures, material
dependency/compatibility changes, installation/upgrade/rollback changes.

```bash
node scripts/doc-policy.mjs assess --session <session-id> \
  --files src/app.py compose/stack.yml \
  --doc-status DOC_UPDATED --docs docs/runbooks/new-procedure.md \
  --ingest-status DOC_INGEST_INDEXED --capture-status NO_LESSON

# re-check any task deterministically (CI can do the same)
node scripts/doc-policy.mjs check --session <session-id>
```

`data/doc-policy/<session>.json` holds the recorded assessment (git-ignored).
The `check` command exits 0 only for a complete closure and prints precise
findings otherwise — use it in review and release checks instead of trusting
prose claims.

## Client wiring

- **OpenChamber** — the `runbook-nudge` plugin's start reminder adds the
  shared-docs search (`memory-doc-ingest.py search`) and the closeout nudge
  requires the `DOC_*` outcome, the ingestion verification command and the
  recorded SINGDOC token. It remains a reminder plus instructions: OpenCode
  offers no documented stop-interception hook, so closure is enforced through
  the review closeout, the deterministic `doc-policy.mjs check` and CI/release
  validation — not a synthetic hard stop.
- **Claude Code** — `adapters/claude-code/doc-hook.mjs` (installed by
  `scripts/install-claude-code.mjs` alongside the memory hooks):
  - `SessionStart` → the same start-of-work guidance as OpenChamber's start
    reminder (bounded, advisory).
  - `Stop` → event-driven `memory-doc-ingest.py retry` for pending work, then
    the deterministic closeout check: a session that recorded an incomplete
    assessment (missing ingestion, `DOC_BLOCKED`, unreported capture status)
    is blocked with concrete remediation, bounded to 3 blocks per session
    (never an infinite loop), honouring `stop_hook_active`. Sessions that
    recorded no assessment (ordinary chat, read-only work) are never blocked.
- Specialist agents (implementation/general roles) carry the same closeout
  text in their definitions; the Code Reviewer verifies the stated
  documentation outcome instead of trusting it.

## Security boundaries

Ingestion only accepts Markdown files inside the configured allowlist roots;
symlink traversal, secret-shaped filenames (`.env`, keys, credentials) and
secret-shaped content are rejected before any write. Documents larger than
200 KB or needing more than 64 chunks are refused with `DOC_INGEST_BLOCKED`
rather than silently truncated. Provenance (source path, revision, content
hash, chunk index, scope, ingest timestamp) travels inside every memory
record, so any agent can verify a retrieved chunk against the canonical file.
Credentials stay in `memory.json` and are never printed. Note that TencentDB
Agent Memory extraction configurations may use external LLM providers — check
your installation's extraction provider/privacy settings even though storage
is self-hosted.

## Troubleshooting / recovery

| Symptom | Handling |
| --- | --- |
| `DOC_INGEST_PENDING` persists | Gateway down or eventual indexing lagging; `retry --all` after the stack is healthy. Idempotent — no duplicates. |
| `DOC_INGEST_FAILED (chunk write failed …)` | Fix the gateway, then `retry --file <doc> --root <root>`; the previous revision remained active meanwhile. |
| `DOC_INGEST_BLOCKED: sensitive assessment …` | Redact or restructure the document; the refusal is intentional and recorded. |
| Retrieve shows an OLD procedure | Should not happen through `search` (active-rev filter). If a stack outage blocked a supersession slot, `retry` completes it; audit with `search … --stale`. |
| Ledger lost/erased | Re-run `ingest` for the docs you care about; deterministic task ids dedup against what the stack still holds. |
| Hook says `recall degraded` | Memory hooks degrade open; never break the session. Fix `MEMORY_SECRETS`/gateway and retry. |

Last updated: 2026-10-20
