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
node scripts/orch-run status            # prints the run id, stage, cycle and seat plan

node scripts/orch-run evidence <run> --kind plan --producer <coordinator-seat> --text "..."
node scripts/orch-run advance <run> --to implement --role coordinator

node scripts/orch-run begin <run>       # optional: mark the stage in flight
node scripts/orch-run evidence <run> --kind diff --producer <worker-seat> --file out.patch

# ... validate, review, then acceptance by the reviewer seat:
node scripts/orch-run approve <run> --approver <reviewer-seat>
node scripts/orch-run accept  <run> --approver <reviewer-seat>
```

`status`, `list`, `history`, `health`, `modes` and `verify` are read-only.
`advance`, `begin`, `reconcile`, `approve`, `accept`, `pause`, `resume`, `stop`
and `recover` are mutations, and every one is role checked.

## Workflow

Six stages, one direction, with two back-edges:

```
plan -> implement -> validate -> review -> accept -> done
                        ^          |
                        +----------+   (review -> correct -> implement -> validate)
```

| Transition | Who may perform it | Evidence required in the current cycle |
| --- | --- | --- |
| `plan -> implement` | coordinator | `plan` |
| `implement -> validate` | coordinator | `diff` |
| `validate -> review` | coordinator | `test-output` |
| `validate -> correct` | coordinator | `test-output` |
| `review -> accept` | reviewer | an approving `review-verdict` |
| `review -> correct` | reviewer | `review-verdict` |
| `correct -> implement` | coordinator | `diff` |
| `accept -> done` | coordinator | `review-verdict` + a valid recorded approval |

A stage is never marked complete by a timer, a process exit or a retry. A run
that was in flight when its process died is marked `interrupted` and blocks:
`advance` refuses until an operator runs `orch-run reconcile <run> --note ...`.
Reconciliation clears the interruption but changes no stage, so the next
transition still needs that stage's evidence.

### Cycles

Entering `correct` starts a new cycle. Evidence is stamped with the stage and
cycle it was produced in, and a transition only counts evidence from the current
cycle — after a correction, the previous diff and test output are history, not
proof of the corrected work.

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
`providerPolicy: free` the router has no paid fallback at all.

Seat ids look like `duo-reviewer-1-4c81dd` and are printed by `status`.

## Approvals and authority

An approval records the approver **seat id**, its role, the stage, the evidence
pack hash, the run's revision and a TTL. Acceptance requires all of:

- the approver is a declared `reviewer` or `operator` seat — a coordinator seat,
  a worker seat or an invented identity is refused;
- the approver did not implement the work;
- the approval's pack hash equals the current pack, so evidence added after
  review invalidates it;
- the approval's revision equals the run's own revision; a caller cannot choose
  the revision (`approve --revision` is refused, not ignored);
- the approval has not expired and was not issued in the future.

Authority comes from `run.approvals`, never from an evidence entry. The
`approval` evidence kind is reserved: `orch-run evidence --kind approval` exits
2, and `advance --to done` validates the stored approval itself. This is
identity de-confliction within a local trust boundary, not authentication:
whoever can write the state directory can edit the seats.

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
Selection is filtered by the run's provider policy before any call is made.

A route is usable under `free` only when **all** of these hold: it is declared
`verifiedFree`, `cost` is `free`, input **and** output pricing are both zero,
`verifiedAt` is a real date that is not in the future, and `evidence` names the
source that was read. A missing verification record is a refusal, not a
downgrade: a free-sounding model name is not evidence.

Invocation outcomes are structured: `{ ok, status, error, retryable, attempts,
telemetry }`. `classifyError` separates retryable (timeout, 429, 5xx) from
terminal (auth, 400, unknown model) failures, so a retry loop cannot spin on a
configuration error. Telemetry pins zero cost on verified-free routes and
refuses to report a cost for a route it cannot price.

This router is deliberately separate from `scripts/extraction-failover.mjs`,
which routes MemoryCore extraction. They are not connected and do not share
state.

## Supervision

`orch-run health` classifies a run as `RUNNING`, `STUCK`, `BLOCKED`, `PAUSED`,
`FAILED`, `COMPLETE` or `INVALID_EVIDENCE`:

- `STUCK` — the current stage has not moved within the stuck window
  (`--stuck-after-minutes`, default 30);
- `BLOCKED` — an unresolved interruption, or an exhausted retry budget;
- `FAILED` — stopped by an operator;
- `INVALID_EVIDENCE` — accepted, but a file-backed evidence entry no longer
  matches its digest, or the acceptance gate no longer holds.

Health returns a non-zero exit status for `STUCK`, `BLOCKED`, `FAILED` and
`INVALID_EVIDENCE`, so a monitor can use it directly. Classification is on
demand; there is no background watchdog process.

## Evidence

Every entry records `kind`, `producer`, `stage`, `cycle`, `revision`, `sha256`,
`bytes` and a timestamp, and pack content is hashed in a stable order.
`orch-run verify` re-reads **file-backed** entries from disk and reports any
entry whose bytes no longer match. Inline (`--text`) evidence is recorded and
structurally checked; it cannot be re-derived from a file, so "verifies" means
the file-backed entries are unchanged.

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
node --test orchestration/workflow.test.mjs orchestration/governance.test.mjs \
               orchestration/routing.test.mjs scripts/orch-run.test.mjs
python3 tests/test-orch-chat.py
bash tests/validate-local.sh     # everything above plus the repository gates
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
input and output pricing, a verification timestamp, and the source read), then
re-run the acceptance suite with `--free-only`.
