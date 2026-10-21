# Memory capture and promotion — the bounded self-learning loop

This repository wires agent memory (the memory stack) and workspace code
intelligence (RepoQL) so that lessons actually stick, without burning tokens
on routine turns and without a second memory database.

Closure reporting (both clients): when a task ends, its knowledge step is
reported as one of `CAPTURED` (a lesson was captured through the surfaces
below), `NO_LESSON` (nothing durable — acceptable and normal) or `DEFERRED` (eligible
but held by a documented cap — never silently dropped). These token values are
part of the shared documentation closure assessment (`scripts/doc-policy.mjs
assess`); documentation ingestion for material runbook updates is a separate,
verified path (`scripts/memory-doc-ingest.py`, see `docs/DOC-INGESTION.md`).

## What runs automatically, what does not

- The memory plugin is the ONLY automatic capture writer: it posts completed
  turns to the memory stack, and the stack extracts and dedups distilled
  records asynchronously on its own budget.
- The lesson pipeline is event-driven, never a per-message service: it runs on
  the lifecycle completion event both clients already serve and can be resumed
  by the scheduler CLI. Nothing new was added to the hook framework, no second
  store and no background distiller ship.
- AUTOMATIC ASSESSMENT: every doc-policy `autoIngestChangedDocs` pass records
  an honest disposition in the session's assessment file: CAPTURED (only when
  THIS pass's ingestion evidence is DOC_INGEST_VERIFIED, or when the session's
  candidate was PROMOTED through the gated path), NO_LESSON (nothing material
  observed), or DEFERRED (material work, agent token unreported). An
  already-claimed assessment is never overwritten; each session owns its own
  record (concurrent passes are idempotent).
- DISCOVERY IS INDEPENDENT of that disposition: a CAPTURED session still gets
  its lesson opportunity evaluated. Only files that can change behaviour count
  as material — docs are documentation knowledge, and the runtime's own state
  (`data/selflearn`, `data/doc-policy`, `data/doc-index`, `.repoql`) is never
  task material.

## The automatic lesson pipeline

1. **Completion event.** The native lifecycle (Claude Code hooks or the
   OpenChamber plugin) runs the doc-policy pass; `recordAutomaticLearningAssessment`
   classifies the window and, when material files changed, writes a durable
   candidate (`scripts/selflearn-candidates.mjs`, `data/selflearn/pending/<id>.json`)
   BEFORE any model call. The record carries the contract: id, session, project
   and agent scope, timestamps, files, bounded evidence (diffstat, clipped diff,
   doc/test references), retry accounting and claim/lease fields.
2. **Bounded formulation.** One model call through the installation's existing
   processing lane (`SINGULARITY_SELFLEARN_LLM_*`, `product-secrets/selflearn.json`,
   MemoryCore's `MEMORY_LLM_*`, or the canonical lane key) turns the evidence
   into a strict `selflearn.lesson.v1` object (title, lesson, category,
   generalizability, confidence, `needsVerification`, `evidenceRefs`). The model
   formulates; it never establishes truth. A `noLesson` answer is recorded as
   NO_LESSON.
3. **Dedup and authority check.** `rql explore` plus workspace capsules are
   compared textually; an equivalent existing concept resolves the candidate as
   DUPLICATE (candidate bookkeeping only — no second authoritative record). A
   failed RepoQL check keeps the candidate but never makes it promotion-eligible.
4. **Verification.** Requirements are derived from the lesson, not from model
   confidence: `evidence-refs-resolve` (every ref must be a file the discovery
   recorded), `repoql-dedup-ran`, and `manual-verification` when the lesson
   asserts behaviour the evidence does not demonstrate. Any pending requirement
   leaves the candidate NEEDS_VERIFICATION.
5. **Gated promotion.** A fully verified candidate becomes AWAITING_APPROVAL
   with the exact existing surface printed in `promotion.command`
   (`rql concept add …`). Promotion is never automatic: the operator runs that
   command, then `selflearn-candidates.mjs mark-promoted --id <id> --concept-id
   <CapsuleName>`. The next lifecycle pass records the session as CAPTURED with
   the concept reference and keeps the candidate as provenance.

### Candidate lifecycle states

`DISCOVERED` → `EVALUATING` → (`CANDIDATE_READY`) → `DUPLICATE` | `NO_LESSON` |
`NEEDS_VERIFICATION` → `AWAITING_APPROVAL` → `PROMOTED`, plus `DEFERRED`
(retryable) and `FAILED` (retries exhausted). The states live in the ONE
candidate framework; the session assessment maps onto existing RepoQL concepts —
no second state system.

### Recovery, retries and concurrency

- A transient failure (provider unreachable, invalid model JSON) leaves the
  candidate DEFERRED with `retries`, `lastError` and a bounded `nextAttemptAt`
  (60 s base, doubling, 1 h cap). After 5 retries it is FAILED and visible in
  `doctor`, never silently dropped.
- Workers claim a candidate with a lease (`scripts/selflearn-candidates.mjs
  run --limit N`); a stale claim (10 min) is recoverable, a live one makes a
  second worker skip. Two concurrent sessions therefore evaluate their own
  records exactly once, and no record is corrupted by parallel writes.
- Resume after restart: `node scripts/selflearn-candidates.mjs run --root <project>`
  (installed as `systemd/selflearn-candidates.timer` where systemd exists). It
  resolves the same processing provider as the hooks, so a queued candidate is
  not stranded when the interactive session is gone.
- Queue size is capped (200 candidates); the oldest work is surfaced by
  `doctor`, and the caps table below still governs interactive captures.

### Observability

`node scripts/doctor.mjs` reports the selflearn store of the CURRENT project
(`SINGULARITY_REPO_ROOT` or cwd): pending, awaiting verification, awaiting
approval, duplicates, no-lesson, failed, promoted, oldest pending age and the
last promotion with its concept id. VERIFIED requires a real PROMOTED candidate;
a populated queue is INCOMPLETE, and an empty store is NOT_CONFIGURED.

## The loop

1. A session or review ends with ONE durable lesson worth keeping.
2. `python3 scripts/memory_turn_capture.py propose --lesson-file notes.md`
   checks the input cap (<= 8000 chars) and previews similar concepts with a
   local `rql explore` call; it writes a pending scaffold under
   `data/selflearn/pending/` or defers the lesson (nothing is discarded).
3. The agent runs ONE bounded model pass (<= ~200 output tokens) to phrase the
   lesson, then captures it on exactly one surface:
   `rql concept add ...` for code lessons (name uniqueness enforces dedup), or
   `scripts/knowledge-promotion.py --propose ... --promote ...` for operator
   truths with provenance.
4. `python3 scripts/memory_turn_capture.py confirm --file <pending path>`
   closes the loop and enforces the 24h cap (3 confirmations).
5. Between sessions: `python3 scripts/memory_promote.py` reads ONE scoped
   search page from the memory stack (<= 12 compact records within 4000
   chars), and the agent shortlists recurring failures for promotion through
   the same two surfaces. Cursors and deferrals persist under
   `data/selflearn/promotion-cursor.json`; deferred candidates stay queued.

## Caps (violating a cap means DEFER, never discard)

| cap | value | enforced by |
| --- | --- | --- |
| capture input | <= 8000 chars per propose | memory_turn_capture (exit 3) |
| model passes | <= 1 per eligible capture; zero on non-eligible turns | loop discipline (step 4) |
| capture output | <= ~200 tokens (one phrased lesson or concept) | loop discipline (step 4) |
| confirmed lessons | <= 3 per rolling 24h per workspace | memory_turn_capture (exit 5) |
| concept captures | <= 3 per rolling 24h per workspace | memory_promote --promoted (exit 5) |
| promotion batch | <= 12 records, <= 4000 chars combined excerpts | memory_promote fetch |
| full-record reads | <= 2 per promotion cycle | memory_promote instructions |
| duplicate concepts | >= 7 days apart per normalized name | memory_promote (exit 6) |

## Storage layout (git-ignored runtime state under `data/`)

- `data/selflearn/pending/` — the durable candidate store (discovery records,
  formulated lessons, verification state, promotions — same directory, one
  framework)
- `data/selflearn/confirmed/` — captured lessons (ledger copy)
- `data/selflearn/state.json` — capture ledger (memory_turn_capture)
- `data/selflearn/promotion-cursor.json` — {afterTs, doneIds, deferred, promotions}

## Failure handling and honest limits

- Every helper exits with a code instead of writing through a broken path.
- rql must be reachable for dedup previews; with `--skip-rql` the result is
  labelled unverified-dedup and the agent must note that in the capture.
- The search POST authenticates with the same credentials every other
  memory-stack client uses (`MEMORY_SECRETS`, default
  `data/opencode/config/product-secrets/memory.json`, carrying the Bearer
  header plus the two tdai service headers) — exit 7 reports missing or
  unreadable credentials rather than a traceback.
- The search endpoint response shape varies by deployment: run
  `python3 scripts/memory_promote.py --probe` first on a fresh install and
  adjust scopes with `--team/--user/--agent`. The capture side records under
  a per-project team id (`project-<hash>`, visible in the plugin's recall
  line "[product-memory] Recalled project memory (scope <team_id>)"); see
  docs/MEMORY-SETUP.md and docs/MEMORY-LOOP.md.
- Helpers are single-writer by assumption: run them from one session per
  workspace at a time; `state.json` and `promotion-cursor.json` are plain
  read-modify-write files with no lock.
- Promotion always goes through the existing gated flows; there is no
  auto-accepting promotion path in this repository.
