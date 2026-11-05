# Capability matrix — private reference vs this repository (rc8)

Baseline: `v0.1.0-rc7` (`7170225`). Reference: the three archives supplied by
the operator, read at file level — every row below was decided by reading the
named implementation, not by comparing file names or guessing from a module
directory.

Legend: **PRESENT** already satisfied and reused · **PARTIAL** implemented but
incomplete · **ADDED** implemented by this change · **MISSING** identified but
not implemented · **EXCLUDED** deliberately not ported, with the reason.

## Phase 1 — agent communication

| Capability | Reference (basename) | This repo | State |
| --- | --- | --- | --- |
| Durable local inboxes | relay (`orch-chat` in the reference) | `scripts/orch-chat` (`inbox/*.jsonl`) | PRESENT (reused) |
| Direct messaging | same | `orch-chat send/reply` | PRESENT (reused) |
| Session-specific addressing | `agentchat_sessions.py` | `scripts/orch_chat_sessions.py` | PRESENT (reused) |
| Replies and conversation identity | relay reply parsing | `reply`, local `threads.json` | PRESENT (reused) |
| Stable message ids | relay `nextId` | `state.json nextId` under flock | PRESENT (reused) |
| Persistent read cursors | relay cursors | `lastReadId` per role/session | PRESENT (reused) |
| Restart recovery | relay state reload | cold start, corrupt-state refusal | PRESENT (reused) |
| Duplicate delivery protection | relay dedupe | id-addressed cursors | PRESENT (reused) |
| Concurrent sender safety | relay flock | 8-process test | PRESENT (reused) |
| Status / inspection | relay commands | `status`, `presence`, `sessions` | PRESENT (reused) |
| No Discord dependency | relay required Discord | Discord strictly opt-in | PRESENT (reused) |
| **At-most-once dispatch** | `orchestrate.mjs` single-writer claim | per-message `O_EXCL` claim | **ADDED** |

The one genuine Phase 1 gap: two processes could both read `queued` and both
launch the same message. The claim is now a file, not a state read, and the
second dispatcher exits 23 without launching.

## Phase 2 — portable orchestration engine

| Capability | Reference (basename) | This repo | State |
| --- | --- | --- | --- |
| Persistent run and case identity | `run-registry.mjs`, `case-store.mjs` | `orchestration/state.mjs`, `runs.mjs` | **ADDED** |
| Explicit workflow states | `phase-driver.mjs` | `orchestration/stage-machine.mjs` | **ADDED** |
| Planning → implementation → validation → review → corrections → acceptance | `phase-driver.mjs` | transition table in `stage-machine.mjs` | **ADDED** |
| Pause / resume / stop | `orchestrate.mjs` | `orch-run pause\|resume\|stop` | **ADDED** |
| Restart recovery | `recovery/` | `recover()` marks the stage interrupted and blocks | **ADDED** |
| Bounded retries | `phase-driver.mjs` attempt caps | `maxAttemptsPerStage`, `maxCorrections` | **ADDED** |
| Durable per-stage records | `case-state.mjs` | append-only `history` per run | **ADDED** |
| Evidence-backed transitions | `evidence-pack.mjs`, `gate-parser.mjs` | `orchestration/evidence.mjs` + stage requirements | **ADDED** |
| Idempotent recovery of completed work | `run-registry.mjs` | per-attempt idempotency keys | **ADDED** |
| Attempt-scoped evidence | `phase-driver.mjs` attempt scoping | evidence stamped with stage + cycle; only the current stage and cycle count | **ADDED** |
| Stage execution (spawning agents) | `orchestrate.mjs` spawns workers | — | **EXCLUDED** — the portable layer owns identity, gating and routing but does not bundle an agent runtime, so the operator's coordinator performs the stage and records evidence |

## Phase 3 — execution modes

| Capability | Reference (basename) | This repo | State |
| --- | --- | --- | --- |
| solo / duo / quad | `roster.mjs`, `run-slots.mjs` | `orchestration/modes.mjs` | **ADDED** |
| super | `roster.mjs` | `mode: super` (coordinator may implement) | **ADDED** |
| custom | `roster.mjs` explicit seats | `mode: custom` requires explicit seats | **ADDED** |
| free-only | `free-role-router.mjs` | `free_only` mode + `--free-only` | **ADDED** |
| Seat assignment and worker roles | `roster.mjs` | `seatPlan()`, `implementers()` | **ADDED** |
| Coordinator authority | `orchestrate.mjs` | `advance()` role check; may not approve | **ADDED** |
| Stage ordering | `phase-driver.mjs` | transition table | **ADDED** |
| Reviewer independence | `review-evidence.mjs` | `validatePlan()` refuses self-review seats | **ADDED** |
| Model routing constraints | `free-role-router.mjs` | `orchestration/routing.mjs` | **ADDED** |
| Execution limits | `run-slots.mjs`, spend budget | attempt caps, bounded retries | PARTIAL — no per-session spend budget; there are no prepaid sessions to protect |
| Context handoff between stages | `context-pack.mjs` | — | **MISSING** |

## Phase 4 — authority, approval and safety

| Capability | Reference (basename) | This repo | State |
| --- | --- | --- | --- |
| Identity-bound approvals | `approval-artifact.mjs` | `orchestration/approvals.mjs`; approver must be a declared reviewer/operator seat | **ADDED** |
| Approval scope verification | `approval-artifact.mjs` | stage + run + role checks | **ADDED** |
| Evidence identity | `evidence-manifest.mjs` | `evidenceHash` bound to the pack | **ADDED** |
| Reviewed source revision binding | `gate-parser.mjs` | approval takes the run's revision; a caller-supplied revision is refused | **ADDED** |
| Stale approval rejection | TTL in `approval-artifact.mjs` | `expiresAt`, future-issue check | **ADDED** |
| Independent reviewer authority | `review-evidence.mjs` | implementer/coordinator cannot approve | **ADDED** |
| Worker ownership | `worker-lease.mjs` | seat identity on every history entry | PARTIAL — no per-seat liveness registry |
| Resource leases | `resource-lease.mjs` | `orchestration/leases.mjs` | **ADDED** |
| Collision prevention | `resource-lease.mjs` | conflicting acquire throws `LeaseConflict` | **ADDED** |
| Mutation authorization | `policy-identity.mjs` | role checks on transitions and approvals | **ADDED** |
| Explicit deploy intent | `deployment-intent.mjs` | — | **EXCLUDED** — this workflow does not manage deployments; adding deploy machinery would be speculative |
| Safe interruption / restart | `start-guard.mjs`, `recovery/` | interrupted stage blocks; `reconcile` clears it without advancing, and the step still needs its evidence | **ADDED** |

## Phase 5 — model and worker routing

| Capability | Reference (basename) | This repo | State |
| --- | --- | --- | --- |
| Role-based model selection | `engine-router.mjs` | `routing.selectRoute` | **ADDED** |
| Provider-independent contracts | `engine-router.mjs` | route = `{provider, model, roles, cost, pricing}` | **ADDED** |
| Worker availability | `run-slots.mjs` | leases + `health()` | PARTIAL — no live seat inventory |
| Structured invocation outcomes | `bridge-result.mjs` | `invokeRole()` result object | **ADDED** |
| Retry classification | `engine-router.mjs` | `classifyError` (retryable / terminal) | **ADDED** |
| Failure reporting | `narrator.mjs` | structured `error` + `attempts` | **ADDED** |
| Usage and cost telemetry | `invocation-telemetry.mjs` | `telemetry` per call; free routes pinned to zero | **ADDED** |
| Explicit fallback policy | `free-role-router.mjs` | free-only has no paid fallback | **ADDED** |
| Free-route enforcement | `free-model-registry.mjs` | `verifiedFree` needs zero pricing + verification | **ADDED** |
| Stage-sensitive model selection | kit stage router | — | **MISSING** — routing is role-based only |
| Separation from extraction routing | — | `scripts/extraction-failover.mjs` untouched | PRESENT (preserved) |

## Phase 6 — context and memory parity

| Capability | Reference (basename) | This repo | State |
| --- | --- | --- | --- |
| Primary verified knowledge | RepoQL client | RepoQL MCP integration | PRESENT (reused) |
| Scoped experiential memory | `memorycore-client.mjs` | Tencent MemoryCore stack | PRESENT (reused) |
| Companion consolidation | Ghost | `ghost/` | PRESENT (reused) |
| Stage-specific context assembly | `context-pack.mjs` | — | **MISSING** |
| Retrieval ranking / fusion | `context-pack.mjs` | — | **MISSING** |
| Answerability assessment | `context-pack.mjs` | — | **MISSING** |
| Bounded context budgets | `payload-budget.mjs` | MemoryCore L0/L1 limits only | PARTIAL |
| Conflict / supersession / tombstone | `memory-tombstone.mjs`, `concept-conflict-gate.mjs` | `scripts/knowledge-promotion.py`, `skill-gate.mjs` | PARTIAL |
| Provenance and lineage | `memory-lineage.mjs` | capture provenance in MemoryCore | PARTIAL |
| Skill harvesting | `skill-harvest.mjs` | `scripts/selflearn-candidates.mjs` | PRESENT (reused) |
| Verified knowledge promotion | `concept-capture.mjs` | `scripts/knowledge-promotion.py` + gate | PRESENT (reused) |
| Run debrief and learning capture | `debrief.mjs` | — | **MISSING** |

No duplicate memory store, Ghost worker or knowledge authority was introduced.

## Phase 7 — supervision and recovery

| Capability | Reference (basename) | This repo | State |
| --- | --- | --- | --- |
| Operator-visible status | `coordinator-status.mjs` | `orch-run status`, `list`, `health` | **ADDED** |
| Stuck-run detection | `watchdog.mjs`, `run-health.mjs` | `health()` STUCK classification | **ADDED** |
| Explicit degraded / blocked states | `nanny.mjs` | `blocked` after interruption, `FAILED` after stop | **ADDED** |
| Safe cancellation | `orchestrate.mjs` | `stop` records a reason and refuses after acceptance | **ADDED** |
| Resource release | `resource-lease.mjs` | `release` / `reclaimExpired` | **ADDED** |
| Bounded retry handling | `watchdog.mjs` | attempt caps in the stage machine | **ADDED** |
| Persistent progress events | `observer-sink.mjs` | durable run `history` | PARTIAL — no event stream |
| Background liveness loop | `nanny.mjs`, `watchdog.mjs` | — | **MISSING** — classification is on demand |

## Phase 8 — capability and policy enforcement

| Capability | Reference (basename) | This repo | State |
| --- | --- | --- | --- |
| Per-agent capability profiles | `policy-identity.mjs` | `scripts/setup-agent-profiles.mjs` | PRESENT (reused) |
| Permission-aware tool execution | `openchamber-agent-guard.sh` | OpenChamber hooks and gates | PRESENT (reused) |
| Rules across supported agents | rules sync | `adapters/`, `openchamber/AGENTS.md` | PRESENT (reused) |
| A second rules authority | — | not introduced | EXCLUDED by design |

## Phase 9 — operator interface

`scripts/orch-run` provides start, status, list, history, evidence, advance,
approve, accept, pause, resume, stop, recover, verify, modes and health. Every
mutation is role checked, and no new web application was created.

## Phase 10–12 — documentation, testing, release

Documentation, changelog, manifest and checksums are updated in this release;
`docs/ORCHESTRATION.md` is the capability contract and `docs/RELEASE.md` the
release gate. Deterministic tests cover the state machine, modes, approvals,
leases, routing and the CLI. **No model-backed test was executed** — see the
blocker section of `docs/ORCHESTRATION.md`.
