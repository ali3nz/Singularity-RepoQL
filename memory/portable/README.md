# Memory capture — portable single-writer runtime

This directory carries the **capture-only consumer** and the unit that runs it,
ported from the live fleet runtime. The consumer reads OpenChamber's session
database read-only and writes conversations into MemoryCore. It never runs
inside an agent, never blocks a turn, and never scans a workspace.

It exists because the product needs exactly **one** automatic writer. Two
writers produce duplicate conversations, double-charged extraction and a memory
store that cannot be reconciled. This page is the ownership contract; the
installer has to enforce it (see [Installer integration](#installer-integration)).

## What is here

| File | Role |
|---|---|
| `capture-consumer.mjs` | The consumer. Node 22 built-ins only (`node:sqlite`, `fetch`), no dependencies. Live version, ported with one comment edited to remove a fleet agent id. |
| `capture-consumer.env.example` | Every knob the consumer reads, with safe defaults and capture **off**. |
| `systemd/tencent-capture.service` | One-shot unit. Path-parameterised; capture is enabled only by an env file, never by the unit. |
| `systemd/tencent-capture.timer` | 15-minute cadence, `OnActiveSec` (not `OnBootSec`). |
| `systemd/singularity-capture-run.sh` | The runner the unit executes: fixed container name, own-container-only cleanup, read-only mounts. |

## Ownership contract

There is **one** supported automatic writer at a time. Choose one owner and
record the choice in the install receipt:

| Owner | When it applies | How it is enabled |
|---|---|---|
| **Host timer + consumer** (this directory) | Default. Host has a scheduler and a Docker socket, and capture should survive agent/UI restarts. | `CAPTURE_ENABLED=1` in the env file read by `tencent-capture.service`. Nothing else. |
| **Product-office plugin** (`openchamber/plugins/product-office`) | Only when the host has no scheduler and the UI plugin is the product's capture path. | The plugin's own enablement, with this unit **not installed**. |
| **None** | Capture deliberately off. | Neither enabled. The disabled consumer exits 0 and reads nothing. |

Rules that make the contract hold:

- **Capture is off unless an env file says otherwise.** `CAPTURE_ENABLED`
  defaults to `0` in the executable and in the unit; the unit's
  `EnvironmentFile` is optional (`-` prefix), so an un-installed host has a
  green, inert unit rather than a red failed one on every tick.
- **The consumer is a one-shot, not a daemon.** `Type=oneshot`, `Restart=no`.
  A MemoryCore outage cannot affect an agent turn, and a hung run cannot
  accumulate.
- **Concurrency is refused by the kernel, not by a lock file.** The runner uses
  a fixed `docker run --name`; a second run fails immediately instead of
  writing concurrently.
- **Cleanup is own-container-only.** Each run records its container id with
  `--cidfile` and removes only that id. Removing by name would let a failed run
  delete the container of the run that holds the name.
- **Identity is explicit.** `TEAM_ID` and `USER_ID` have no defaults in the
  runner and no defaults in the example env. A host that has not decided its
  memory identity does not capture.

## Running it by hand first

```bash
cd memory/portable
cp capture-consumer.env.example /etc/singularity/capture.env   # edit: TEAM_ID, USER_ID, DEST_URL, SRC_DIR
chmod 0600 /etc/singularity/capture.env
CAPTURE_ENABLED=0 sudo -E ./systemd/singularity-capture-run.sh   # dry by absence of the enabled flag
sudo systemctl start tencent-capture.service                     # one run
journalctl -u tencent-capture.service -n 50 --no-pager            # what it read and wrote
```

The consumer's own ledger (`LEDGER_PATH`) is the receipt: it records the cursor
per source session, the units sent, and their verification. A run that cannot
verify a write does not advance the cursor.

## Installer integration

The installer (owned elsewhere) has to do these things; this directory cannot
do them for it:

1. Create the config directory and write the env file `0600`, with
   `CAPTURE_ENABLED=0` first. Never write an identity or a destination that the
   operator has not chosen.
2. Install the two units and the runner; `systemctl daemon-reload`.
3. **Refuse to enable both owners.** If the product-office plugin is present and
   enabled as a capture writer, the installer must not enable this timer (and
   the reverse). The check belongs in the installer because only it sees both.
4. Record the chosen owner, the image tag, and the env file path in the install
   receipt, so a later reader can tell which writer is live.
5. Leave `CAPTURE_ENABLED=0` unless capture was explicitly selected.

## What is deliberately not ported

- The fleet's identity map (`AGENT_IDENTITY_MAP`) and task bindings: they name
  fleet agents and fleet task ids. `scripts/setup-agent-profiles.mjs` seeds the
  product's own identities; this file only reads them.
- The live ledger, production cursor and rollout evidence: runtime state.
- The live image tag in the runner is a default, not a pin — see
  `docs/RUNTIME-PARITY.md` for the tag the live host actually runs and the
  drift found between the compose file and the unit.

## Provenance

`capture-consumer.mjs` is the live consumer from
`~/docker/tencent-memory/consumer/capture-consumer.mjs`
(37,441 bytes at 2026-10-26 20:16 NZDT). One comment line that named a fleet
agent id was replaced with generic wording; no behaviour changed. The runner,
unit and env example are ports of the live ones with every host-specific path,
identity and image moved into a variable.

## Windows task-linked readback (fleet#1214 source-level port)

`task-recovery.mjs` provides a read-only, bounded adapter over this consumer's
existing capture ledger. It accepts only exact, `status=reconciled`, explicitly
bound units for the requested source agent and task ID, then requests L0 and L1
under the caller's registered MemoryCore identity. Each returned row is checked
again for the requested task, source session when present, and identity fields
when present. Results are sorted chronologically **after** bounded selection.

No Ghost service, registry, new writer, task database or remote access is added.
It cannot infer a Kanzo link from a session title or text. Legacy unbound units
remain unlinked and return `NO_TASK_LINKED_EVIDENCE`.

The existing optional `CAPTURE_TASK_BINDINGS` configuration supports logical
`task-...` identifiers and now additionally supports the native Windows
`kanzo:<positive integer>` form. For example, an explicit operator-authored
binding may map `agent-alpha:An actual session title` to `kanzo:1219`. This
only changes the DESTINATION `task_id` of newly captured units; it does not
rewrite previous captures, modify the Kanzo board or imply a claim.

Use `recoverBoundTask({ledgerPath,taskId,agent,identity,query,verifyTask,core})`
from a **trusted native caller**. `verifyTask` MUST independently check the
requester's authorization and native Kanzo task identity. The `core` function
MUST be the existing authenticated MemoryCore caller, with per-agent/team/user
push-down. Neither a claimed task id nor a caller-supplied agent label is
sufficient authorization. Without a verifier or a trusted binding, the helper
fails closed. The source helper is intentionally not registered as an MCP tool
or exposed as an unverified public endpoint.

`node --test memory/portable/task-recovery.test.mjs` runs hermetic tests for
trusted binding, chronology, scope isolation, server filter rechecks and
failure handling. Native Windows service integration and operator approval
remain separate from these source-level results.
