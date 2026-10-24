# Portable orchestration

Singularity ships an **optional** orchestrated-run engine. It is a separate,
independently installable capability: it does not replace, reconfigure or take
authority from the production coordinator, and installing this repository
without it changes nothing about how your agents already run.

Nothing here needs Discord, a hosted service, a paid model or a network
connection. State is local JSON under `$ORCH_STATE_DIR` (default `./.orch`).

## Requirements

- Node.js 20 or newer (`node --test`, `fs` promises, `crypto`).
- No npm dependencies. No build step.
- `bash` only if you use the shell wrappers in `tests/`.

## Quick start

```bash
node scripts/orch-run modes
node scripts/orch-run start "add retry to the ingest worker" --mode duo --revision HEAD
node scripts/orch-run status
node scripts/orch-run evidence plan --kind plan --producer duo-coordinator-1-9f3a21 --text "..."
node scripts/orch-run advance --to plan --role coordinator --actor duo-coordinator-1-9f3a21
node scripts/orch-run accept --approver duo-reviewer-1-4c81dd
```

`status`, `list`, `history` and `health` are read-only. `advance`, `approve`,
`accept`, `pause`, `resume`, `stop` and `recover` are mutations and are role
checked.

## Workflow

Six stages, one direction, with two back-edges:

```
plan -> implement -> validate -> review -> accept -> done
                        ^          |
                        +----------+   (changes_requested -> correct -> validate)
```

| Transition | Who may perform it | Required evidence |
| --- | --- | --- |
| `plan` | coordinator | a `plan` entry |
| `implement` | coordinator | a `diff` or `implementation` entry |
| `validate` | coordinator | a `test` entry, and its `verdict` may not be `fail` |
| `review` | coordinator | any evidence plus a reviewer verdict |
| `correct` | coordinator | a review verdict of `changes_requested` |
| back to `validate` | coordinator | the corrective `diff` |
| `accept` | **reviewer or operator only** | a matching approval, bound to the pack |

A stage is never marked complete by a timer, a process exit or a retry. It moves
only on a recorded transition whose evidence requirements are satisfied, so an
interrupted stage stays `interrupted` until `orch-run recover` reconciles it.

## Execution modes

A mode is a **seat plan with authority**, not an alias for an agent name:

| Mode | Workers | Reviewer | Coordinator may implement | Provider policy |
| --- | --- | --- | --- | --- |
| `solo` | 1 | yes | no | any |
| `duo` | 2 | yes | no | any |
| `quad` | 4 | yes | no | any |
| `super` | 2 | yes | yes | any |
| `custom` | explicit | explicit | explicit | any |
| `free_only` | 1 | yes | no | **free only** |

Two invariants are enforced when the plan is built, not when it is used:
the reviewer is never an implementer, and the coordinator never holds the
reviewer seat. `custom` requires an explicit seat list and refuses to build an
empty team; every other mode refuses a seat list, so a typo cannot silently
produce a one-person run.

`--free-only` can be passed to any mode. It is not a preference: with
`providerPolicy: free` the router has no paid fallback at all, and an
unverified route is refused rather than downgraded.

## Approvals and authority

An approval records the approver identity, the role, the stage, the evidence
pack hash and a TTL. Acceptance requires all of:

- the approver holds `reviewer` or `operator` authority (a coordinator cannot
  approve its own run);
- the approval's pack hash equals the pack being accepted, so evidence added
  after review invalidates it;
- the approval is bound to the reviewed revision, when the run has one;
- the approval has not expired.

Adding evidence after an approval therefore requires a fresh review. That is
intentional: a green run with a stale pack is not a pass.

## Leases

`orchestration/leases.mjs` is a filesystem lease with an owner, a TTL and a
conflict check. Two seats cannot hold the same resource name at once
(`LeaseConflict`), a crashed holder's lease can be reclaimed after expiry, and
`release` is idempotent so a restart can safely re-run cleanup.

Use it for anything a second worker must not touch concurrently — a build
directory, a mutable fixture database, a deployment target.

## Routing

`orchestration/routing.mjs` selects a route by role from a provider-independent
table. A route carries `provider`, `model`, `roles`, `cost` and `pricing`.
Selection is filtered by the run's provider policy before any call is made, and
`verifiedFree` requires **both** declared zero pricing and an explicit
verification stamp — a free-sounding name is not evidence.

Invocation outcomes are structured: `{ ok, status, error, retryable, attempts,
telemetry }`. `classifyError` separates retryable (timeout, 429, 5xx) from
terminal (auth, 400, unknown model) failures, so a retry loop cannot spin on a
configuration error. Telemetry pins zero cost on free routes and refuses to
report a cost for a route it cannot price.

This router is deliberately separate from `scripts/extraction-failover.mjs`,
which routes MemoryCore extraction. They are not connected and do not share
state.

## Supervision

`orch-run health` classifies a run as `OK`, `STUCK`, `BLOCKED`, `FAILED`,
`PAUSED` or `DONE`:

- `STUCK` — the current stage has not moved within the stuck window
  (`--stuck-after-minutes`, default 30);
- `BLOCKED` — an interrupted stage, an exhausted retry budget, or a missing
  approval;
- `FAILED` — stopped by an operator.

Health returns a non-zero exit status for `STUCK`, `BLOCKED` and `FAILED`, so a
monitor can use it directly. Classification is on demand; there is no background
watchdog process.

## Evidence

Every entry records `kind`, `producer`, `revision`, `sha256`, `bytes` and a
timestamp, and pack content is hashed in a stable order. `orch-run verify`
re-reads the recorded material from disk and reports any entry whose bytes no
longer match, so a hand-edited log cannot masquerade as evidence.

## What is intentionally not included

- **Agent execution.** The engine owns identity, state, gating, routing and
  evidence; it does not bundle a runtime that spawns agents. The operator's
  coordinator performs the stage and records the evidence. This keeps the
  capability portable and keeps the production coordinator authoritative.
- **Deployment machinery.** This workflow does not deploy, so it has no deploy
  intent, canary or rollback stage. Adding one would be speculative.
- **Background watchdog.** Health is a query, not a daemon.
- **Stage-specific context assembly and run debrief.** See the capability
  matrix; those need the context-pack semantics that this release does not port.

## Testing

```bash
node --test tests/        # all deterministic suites, no network, no model calls
```

The orchestration suites use temp directories and fake clocks. They prove the
state machine, mode invariants, approval binding, lease collisions, routing
policy and the CLI contract. **They prove nothing about live model behaviour** —
no model-backed test was run for this release (see below).

### Model-backed testing status: BLOCKED

No live model call was made. The permitted providers are free OpenRouter and
free OpenCode Go/Zen routes; this host has no credential for either, and the
task forbids substituting a paid route, a Freebuff agent or a premium
subscription. Rather than run a test whose billing status could not be
verified, the live-execution acceptance items are recorded as **BLOCKED**, not
PASS. Deterministic coverage is unaffected.

To unblock, supply a verified free route in `orchestration/routing.mjs` (zero
input and output pricing, plus a verification stamp and the date it was
observed), then re-run the acceptance suite with `--free-only`.
