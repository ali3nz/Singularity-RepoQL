# Memory capture and promotion — the bounded self-learning loop

This repository wires agent memory (the memory stack) and workspace code
intelligence (RepoQL) so that lessons actually stick, without burning tokens
on routine turns and without a second memory database.

## What runs automatically, what does not

- The memory plugin is the ONLY automatic capture writer: it posts completed
  turns to the memory stack, and the stack extracts and dedups distilled
  records asynchronously on its own budget.
- The agent-facing loop in this repo is deliberately event-driven, never a
  scheduled service: it runs at session closes and reviews, not per message.
- No new hook framework, no second store, no background distiller ships.

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

- `data/selflearn/pending/` — unconfirmed lesson scaffolds
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
