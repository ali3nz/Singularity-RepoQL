# The memory loop

What "self-learning" means in Singularity: every conversation can become
durable, searchable memory, and relevant memory is fed back into later
sessions automatically. For curated knowledge there is an explicit promotion
path — nothing is promoted silently.

## 1. Capture

| Source | How |
|---|---|
| Claude Code / harnesses | every request through the proxy (`:8096`) is captured — for the NORMAL parent session this happens whenever Singularity proxy routing is enabled at install (`install --variant 1 --enable-main-memory`; see `docs/CLAUDE-CODE-SETUP.md`); no agent selection needed |
| Claude Code specialised agents | with `scripts/install-claude-code.mjs`: each finished `singularity-*` subagent contributes ONE bounded, redacted lesson via the SubagentStop hook, persisted under the agent's own MemoryCore identity through the reconciled write path (query-before-write → add → verify; stable task id, so retries do not duplicate) |
| OpenChamber | the `product-office` plugin captures completed turns (user/assistant pairs) for sessions under the capture roots |
| Anything | `POST /v3/conversation/add` with a scope (`team_id`, `user_id`, `agent_id`, `session_id`, `task_id`, `messages`) |

Adding a record is never equated with having learned it: the reconciled path
verifies persistence, trivial subagent output is never captured, and a failed
or degraded capture is reported instead of silently assumed.

Captured conversations land immediately as **L0 units** — raw, addressable,
and searchable right away.

## 2. Extraction (asynchronous)

memory-core's pipeline distills L0 units in the background using the
configured memory-group LLM:

- **L1** — extract / dedup / persona: facts and decisions pulled from
  conversations, near-duplicates collapsed.
- **L2 / L3** — higher-order layers built on L1 outputs (aggregation and
  longer-horizon insight). Each task runs with a bounded per-task budget; a
  hung provider call fails that task rather than stalling the pipeline.

Extraction needs the memory-group LLM reachable; when it is, the Panel's task
list shows extraction work progressing per scope.

## 3. Recall

- The proxy injects relevant memory (facts, skills, knowledge) into the
  agent's context at session start — your agent simply sees prior context.
- The OpenChamber plugin recalls per session and reconciles new turns back
  into the store.
- With the Claude Code integration, each `singularity-*` subagent starts with
  a bounded recall from its OWN identity (SubagentStart hook: ≤4 L0 + ≤4 L1
  items, clipped, clearly stamped advisory-only). Recalled context never
  overrides the current operator request or verified code, and a MemoryCore
  outage degrades the recall visibly without blocking the agent.
- Everything is also reachable on demand: `POST /v3/conversation/search` with
  a scope and query.

Recall is a read of already-extracted memory, so it does not depend on the
extraction LLM being available at that moment.

## 4. Curated knowledge — explicit promotion

For decisions you want as durable, reviewable truths, use
`scripts/knowledge-promotion.py`:

```bash
# 1. propose — records intent only; nothing enters the memory
python3 scripts/knowledge-promotion.py \
  --propose "Title" "Body text" /path/to/source-record

# 2. promote — verifies the source exists, writes a truth document with
#    provenance and fingerprints, archives any superseded truth, and indexes
#    the note into Memory Core as an L0 unit (content-hash dedup)
python3 scripts/knowledge-promotion.py \
  --promote data/knowledge-store/proposals/<file>.md --truth-name my-decision

# replacing an existing truth (old one archived, never silently dropped):
python3 scripts/knowledge-promotion.py --promote … --truth-name my-decision --supersede
```

State lives in `data/knowledge-store/` (`current-truth/`, `history/`,
`proposals/`, `sources/`); every promotion and supersede appends to
`history/promotions.jsonl`. Index scope defaults to team `knowledge` / user
`operator` / agent `knowledge-promotion`; override with `KNOWLEDGE_INDEX_TEAM`,
`KNOWLEDGE_INDEX_USER`, `KNOWLEDGE_INDEX_AGENT`, `KNOWLEDGE_INDEX_SESSION`,
`KNOWLEDGE_INDEX_BASE_URL`. The store directory and credentials default to the
installation layout (`data/knowledge-store`, the plugin's `memory.json`) and
can be overridden with `KNOWLEDGE_STORE` and `MEMORY_SECRETS`.

## 4a. Lessons — automatic formulation, gated promotion

The lifecycle completion event also runs the automatic lesson pipeline
(`scripts/selflearn-candidates.mjs`): material work creates a durable candidate,
ONE bounded model call through the installation's processing lane formulates a
`selflearn.lesson.v1` object, RepoQL dedup and requirement-based verification
run, and a fully verified lesson stops at `AWAITING_APPROVAL` with the exact
`rql concept add …` command. Promotion itself is never automatic. Full contract,
states, retry/resume and observability: [`memory-capture-promotion.md`](memory-capture-promotion.md).

## 4b. Documentation ingestion (shared engine; docs stay authoritative)

Runbooks and guides are ingested by the documentation engine
(`scripts/memory-doc-ingest.py`, full guide: `docs/DOC-INGESTION.md`):
eligibility → sensitive-content rejection → chunking by headings → idempotent
chunk writes → bounded retrieval verification → revision supersession → atomic
ledger update, under a dedicated shared scope (`agent: docs-keeper`, team
`singularity-docs`/user `shared`). Only `DOC_INGEST_INDEXED` (persisted AND
verified searchable) closes a documentation requirement; `PENDING`/`FAILED`
keep the previous verified revision active and retry later. The completion
gate (`scripts/doc-policy.mjs assess | check`) records and re-verifies the
documentation outcome (`DOC_UPDATED` / `DOC_NOT_REQUIRED` + reason /
`DOC_BLOCKED`) deterministically from both clients. Detection is automatic:
both clients keep a per-session documentation baseline and ingest every new or
changed eligible runbook at task close through this same engine — see
“Automatic document discovery” in `docs/DOC-INGESTION.md`.

## 5. Validation

`tests/validate-memory-loop.sh` exercises the machine-checkable chain against
a running stack: add → search (capture + retrieval), propose → promote →
index → searchable (knowledge path). The LLM-dependent half — extraction
quality and recall in a live session — has a scripted acceptance,
`node scripts/acceptance-ordinary-session.mjs run`, which drives two REAL
independent headless Claude sessions through the production proxy with a
unique per-run tag: session A states the fact (automatic capture), the record
must become searchable through the live service, and a genuinely NEW session
must recall the number WITHOUT the fact being in its prompt. It fails closed
(INCOMPLETE) whenever the live environment is absent and prints the supervised
steps; its evidence file (SINGULARITY_ORDINARY_SESSION_EVIDENCE) is what the
installation gate and `scripts/doctor.mjs` accept as ordinary-session recall
proof — never a manual checkbox:

1. Chat about something distinctive (e.g. name a fictional project).
2. Confirm the session appears in the Panel (`:8125`).
3. In a fresh session, reference the topic — the agent should already know it.
4. Optional: inspect extracted facts via search, and promote any decision you
   want kept to the curated store.

## 6. Knobs worth knowing

- `MEMORY_PROMPT_MODE=code|chat` — the extraction prompt family
  (engineering/team vs personal/episodic).
- Scopes — team/user/agent isolation is enforced on every call; use separate
  business users for separate projects or people.
- Extraction failover (`compose/extraction-failover.compose.yml`) — optional
  router in front of the extraction endpoint when you have multiple provider
  accounts or want transient-failure retries.
