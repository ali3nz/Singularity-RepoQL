# Ghost — what this port covers, and what it deliberately does not

The live Ghost runtime is considerably larger than the product's `ghost/` tree.
This page says exactly which capabilities were ported, which stayed behind, and
why, so nobody reads "Ghost is in the product" as "the live fleet's Ghost is
here".

## Ported (generic, unit-tested in this repository)

| Capability | File | Notes |
|---|---|---|
| Versioned prompt store | `prompt-store/prompt_store.py` | Append-only revisions, `.audit.jsonl`, placeholder validation, atomic writes, `fcntl` lock, revert-writes-a-new-revision. Registry is the product's own task list; the live registry named fleet tasks and is not carried over. |
| Prompt store tests | `prompt-store/test_prompt_store.py` | Ported from the live suite; the one test that asserted equality with the fleet's `taskguard.TASKS` is replaced by a registry-uniqueness test (that module is fleet code). |
| Prompt reader for runners | `task-prompts.mjs` | Missing file means "use the in-code default"; an unknown placeholder is a loud error. Root is `GHOST_PROMPT_DIR`, default `/var/lib/ghost-control/prompts`. |
| Chain runner | `chain.mjs`, `chain.example.json` | One lock (`O_EXCL`), steps in order, per-step timeout, one JSON log per run, optional operator note. Steps come from config, not from compiled-in fleet commands. |
| Blank seeds | `prompt-store/seeds/`, `prompt-store/seeds.json` | Empty product defaults. Nothing personal, no schedule text, no operator instructions. |

## Not ported (and why)

| Capability | Live size | Why it is not here |
|---|---|---|
| Dream implementation | `dream.mjs`, 75,863 bytes | The live dream is bound to fleet facts: which memories to read, which issues and hub documents to cite, which operators approved what. The product already ships `ghost/dream.mjs` (42,070 bytes) with the checkpointed six-stage cycle; shipping the live one would import another install's context, and stripping it faithfully is a design change, not a port. |
| Daily sweep | `sweep/sweep.mjs` 88,635 B, `sweep/unified.mjs` 73,869 B | Same reason, plus the sweep prompts are the operator's own prose (news selection, standing orders, client names). Only the pure decision helpers (`sweep/decisions.mjs`, no I/O) are generic enough to port; they are described here rather than copied because they encode this operator's gate policy (O gate, H rotation). |
| Wake scheduler / block prompts | `wake-maintenance.mjs` 41,117 B, `wake-slot-prompts.mjs` 9,314 B | The slot prompts are personal instructions ("fix review with Sol", named people, named research topics). The scheduling *mechanism* is portable and is what the chain runner above provides; the prompts are not. |
| Control service + dashboard | `control.py` 33,958 B, `prompt_store.py` 11,451 B | Dashboard UI and its HTTP bridge are owned by another worker. The store's storage contract is ported here so that worker can build against it; the service is not duplicated. |
| Memory recall wrapper | `ghost-memory.mjs`, `ghost-memory` | Depends on the fleet's `agent-memory` CLI and its identities. The product's own recall path is `scripts/` and the OpenChamber plugin, untouched here. |

## Rule for a future port

Port the **mechanism** with its parameters exposed, not the **content** that
drove one operator's day. A feature that only works because a prompt says "ask
Sol about tonight's failed jobs" is not a product feature.
