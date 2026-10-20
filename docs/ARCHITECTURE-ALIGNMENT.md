# Architecture alignment — reference design vs this package

The reference deployment (the operator's production installation) is the design
authority for the memory lifecycle; this package ships the public,
self-contained equivalents. This matrix records, per lifecycle mechanism:
what the reference does today (with evidence), what this package does, the
decision, and how correctness is demonstrated. Read the authority rules in
[`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md) first: RepoQL stays the primary
retrieval plane; MemoryCore is experiential memory and is advisory only.

Inspection of the reference deployment was **read-only**: file reads, git
history/listing and service-status checks only. No file, container, timer or
index on the reference host was modified by this review.

## Matrix

| Mechanism | Reference (evidence) | This package | Decision | Validation |
|---|---|---|---|---|
| Single-owner conversation capture | One capture consumer consumes scheduled/queued units and is the ONLY MemoryCore writer for conversations; model-proxy capture owns the Claude-Code path (capture timers + docs) | Proxy owns Agent-loop capture for routed traffic; lifecycle hooks own lesson capture per agent (`memory-hook.mjs`, per-agent `task_id` reconciliation); Ghost owns its own git-backed reflection store (`ghost/dream.mjs`), never a second MemoryCore writer for the same scope | Preserve (per-scope owners documented here) | `tests/validate-memory-loop.sh` codec loop; hook reconcile tests (stable id → duplicate-free retries) |
| Extraction L0→L3 | Asynchronous, provider-routed, restart-recoverable (extraction configs + quota ledgers) | Same upstream MemoryCore pipeline; `scripts/extraction-failover.mjs` + `memory-forwarder.mjs` add the provider ladder and budget ledger | Reuse | `scripts/extraction-failover.test.mjs` (ladder hops, budget, malformed-ledger fail-closed); live acceptance probe |
| Provider routing / failover | Ordered provider ladder with pinned vs default sources on the ghost lane | `makeLadderCallImpl` (dream) + `extraction-failover.mjs` ladder; 429/5xx/timeout advance, auth failures do not, every hop recorded | Adapt (public, provider-agnostic) | dream ladder test; failover unit tests; live failover on the test machine |
| Selective, bounded recall | Stage-gated context packs; L1 ≤ 5, L0 ≤ 3, ≈ 1500 tokens; implementation/review stages prefer source evidence over memory | `SessionStart` guidance hook (config, not memory), `SubagentStart` bounded recall per specialist identity, memory-proxy injection bounded by upstream config; agents continue fail-open when memory is unavailable | Adapt (no coordinator to gate stages in public harnesses) | memory-hook tests (recall request shape/bounds); fail-open behavior asserted on the live install |
| Verified knowledge promotion | Approval-gated `captureConcept`-style path; evidence + provenance required; category contract preserved | `scripts/knowledge-promotion.py` (+ `memory_promote.py`): propose → evidence check → dedup → promote → index → verify retrieval, all gated writes | Reuse | `tests/test-memory-promote.py`, `tests/test-memory-security.py` |
| Documentation lifecycle | Material-change gate: DOC_UPDATED / DOC_NOT_REQUIRED / DOC_BLOCKED, ledger-backed ingestion evidence (DOC_INGEST_*), supersession, recovery | `scripts/doc-policy.mjs` + `scripts/memory-doc-ingest.py` implementing the same statuses/evidence; Stop closeout check on Claude Code, plugin closeout on OpenChamber | Reuse | `tests/doc-policy.test.mjs` (incl. baseline-recovery state assertion), `tests/test-memory-doc-ingest.py`; live `validate-memory-loop.sh` |
| Ghost dream cycle | Checkpointed 6-step engine; one dream per period (exclusive `.dream.lock` with proven stale-takeover, resume from checkpointed journals — only a completed dream marks the day done); deadline/budget caps; retry classification (timeouts = unknown outcome, not re-sent); git-verified reflection persistence; consolidation via a bounded ghost turn; model ladder via the ghost gateway lane | Same engine semantics in `ghost/dream.mjs` (self-contained: fetch + env instead of the reference's shared modules), plus `GHOST_BACKEND=claude-code` so the complete Claude Code installation option needs no OpenChamber | Adapt | `ghost/dream.test.mjs` (checkpoint, ladder, escape audit, cleanErr, provenance), `ghost/ghost-gateway.test.mjs`, `ghost/gateway-backend.test.mjs`; live dream evidence on the test machine |
| Ghost identity & isolation | Ghost owns a dedicated memory profile; reflections git-backed; destructive restore requires verification | `ghost/setup-ghost.sh` seeds ONLY ghost's own profile; `assertOwnMemfs` blocks path escape and sibling references; unverified backups refuse restoration | Reuse | dream tests (`DREAM_ESCAPE`, `DREAM_CROSS_AGENT`), installer ledger verification tests |
| RepoQL authority + mirror discipline | RepoQL is primary; MemoryCore mirrors carry stable source ids and stay advisory; dedup prefers RepoQL by stable identity, never similarity alone | `memory_client.py`/promotion write provenance-stamped, deduplicated candidates; proxy injection is read-only; no index mirroring into MemoryCore | Preserve | promotion tests assert provenance + dedup; no public bulk-replay path exists |
| Orchestration coordinator | Private coordinator enforces review gates and stage order | Not packaged: the package integrates with the user's existing harness and gates (hooks + closeout statuses) without assuming or replacing any coordinator | Not required (explicitly out of scope) | n/a — absence is the requirement |

## Cascade of authority (unchanged)

1. Current source code and observed runtime evidence.
2. Current authoritative documentation.
3. Verified RepoQL concepts / curated knowledge.
4. Approved, provenance-backed promoted knowledge.
5. MemoryCore experiential memory (advisory).
6. Unverified model-generated suggestions.

An extracted memory never overrides newer source evidence; recall is bounded
and fails open; confidential or excluded sessions skip capture and recall.
