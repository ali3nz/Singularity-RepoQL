# Provenance — Claude Office fork pin

| Field | Value |
|---|---|
| Deployed fork | [ali3nz/claude-office](https://github.com/ali3nz/claude-office) — fork of [paulrobello/claude-office](https://github.com/paulrobello/claude-office) |
| Upstream license | MIT |
| **Pinned revision** | `95d8bdc5728b23bcf0fee4c371b35e071c44f642` — "Reject far-future shared layout timestamps and ignore poisoned cache clocks (#807)" |
| Deployed image tag (live host) | `local/claude-office:layout-clock-20261027` |
| Container | `claude-office` |

## Why this pin

The earlier product text named `4ce0d00` as the validated revision. That is no
longer what the live deployment runs: the fork has moved through the Focus /
seating work, the idle-sweep re-arm fix and #807 in four commits, and the
running container was built from this tree.

`95d8bdc` is the tip of the fork's `main` and the commit the live image was built
from. It adds:

| File | Change |
|---|---|
| `backend/app/api/routes/layout.py` | Reject a shared-layout timestamp far in the future; poisoned cache clocks cannot win |
| `backend/tests/test_layout.py` | Regression for that rejection |
| `frontend/src/stores/officeEditStore.ts` | Ignore a far-future cache clock on the client |
| `frontend/tests/layoutTimestampCache.test.ts` | Regression for the client cache |

The fork is a *source* dependency: this repository ships the deployment, never
the application source. Nothing of `claude-office` is redistributed here.

## Deployed override

The live deployment is not quite the plain `office/office.compose.yml`: the
container is started with an extra compose override that pins the built image,

```yaml
# work/office-dashboard-visual-20261027/future-layout/clock-guard-compose.yml
services:
  claude-office:
    image: local/claude-office:layout-clock-20261027
```

and the deployment's own compose project names the container `claude-office`
(not `singularity-office`). The override is one image tag; there is no behavioural
delta in the compose files beyond that. See
[`office.deployed.override.example.yml`](office.deployed.override.example.yml)
for the portable shape of it.

## Portability contract

What the live deployment proves and the product keeps:

- **Loopback only.** `127.0.0.1:3128:8000`. There is no public host, no tunnel
  rule, and **no Cloudflare Access tenant** in the product path: the visualizer
  is a local observer, not a published service. (The live fleet also has a
  same-origin embedding experiment behind Access; that is fleet, not product,
  and is deliberately not carried here.)
- **Local auth.** `CLAUDE_OFFICE_API_KEY` + `CLAUDE_OFFICE_INGEST_KEY` from a
  `0600` env file written by `scripts/provision-secrets.py`; the launch URL
  carries the key. No external identity provider.
- **Metadata-only ingest.** Session/tool names, statuses and project names.
  Prompts, assistant text and tool I/O are never forwarded.

## What is not carried

- Layout state, user names, seating arrangements, sprites chosen by the
  operator, and the SQLite database: those are runtime state.
- The deployed image itself and its build cache.
- The Access tenant, tunnel route and DNS records of the fleet experiment.

## Windows Ghost-only patch

The Windows product ships Claude Office with one persistent identity, Ghost
Protocol. The deviation from the pinned upstream revision is recorded as a patch
rather than a vendored tree: the repository ships the deployment, not the
application source.

| Field | Value |
|---|---|
| Patch | `office/patches/windows-ghost-only.patch` (unified diff, `-p1` from the Office repo root) |
| Applies to | `claude-office` fork pinned at `95d8bdc5728b23bcf0fee4c371b35e071c44f642` (MIT, © 2026 Paul Robello) |
| Files changed | 3 |
| Lines | 7 removed, 6 added (net -1) |
| Reason | Sol Docker (`gateway-dockerhost`) and Sol Webserver (`gateway-webserver`) must not be seeded, always-present or idle-swept desks in the Windows product |
| Behaviour change | identity seeding and filtering only; geometry, rooms and event rendering untouched |

### Files touched

| File | Change |
|---|---|
| `frontend/src/systems/persistentIdentities.ts` | remove both Sol seeds from `PERSISTENT_SEEDS`; filter `gateway-dockerhost` / `gateway-webserver` by id **and** name before stand-ins are built |
| `frontend/src/components/game/OfficeGame.tsx` | remove both Sol seeds from the component's seed list; the remaining fixed desk is Ghost Protocol (`ai-companion`) |
| `frontend/src/systems/idleSweep.ts` | drop `Sol Docker` / `Sol Webserver` from `ALWAYS_PRESENT`; `isRecentlyActive()` returns false for either gateway id or name |

### How to verify

```powershell
# 1. patch is syntactically valid against the pinned, unpatched tree
git -C <office-source> apply --check -p1 office\patches\windows-ghost-only.patch

# 2. apply the built frontend to the served static tree (read-only without -Apply)
native\windows\apply_office_static.ps1 -OfficeRoot <office-source> -Apply
#    the receipt shows one build id and identical index.html sha256 for out/ and static/

# 3. automated check: applied seeds and served build parity
$env:SINGULARITY_OFFICE_SOURCE = '<office-source>'
python native\windows\test_office_ghost_only_patch.py -v
```

Step 1 exits non-zero when the patch is already applied or the base has moved;
both are expected on the live tree and are not failures of the product build.

### Known gaps

- `office/patches/windows-ghost-only.patch` is still untracked in the candidate
  as of 2026-10-30; `SHA256SUMS` does not cover it.
- Desk and seat constants in `OfficeGame.tsx` (`PINNED_SEATS`, the Sol desk name
  mapping) still name Sol; only identity seeds, the merge filter and the idle
  sweep are patched. The served bundle contains no Sol seed objects, but those
  desk labels remain.
- Visual sign-off: the operator opened the Windows Office UI on 2026-10-30 and
  confirmed the Ghost-only identity list is correct.

## Windows B5 view and WebSocket fixes

Operator review of the first Windows Office build (2026-10-30) found three
defects: the floor rendered **no desks** (the desk layer only drew occupied
seats, and Ghost is the only identity), the UI did not open on the operator's
normal **"Ben" view**, and the header stayed **DISCONNECTED** with an empty
agent/event log. Root causes and fixes are recorded as three further patches on
top of the same pin.

| Patch | Files | Reason |
|---|---|---|
| `office/patches/ben-default-layout.patch` | `backend/app/api/routes/layout.py`, `backend/app/main.py` | Seed the saved `Ben` snapshot and the active `office_layout` from the bundled layout on first boot, only when the preference rows are absent; startup calls the seeder |
| `office/patches/desks-unconditional.patch` | `frontend/src/components/game/OfficeDesks.tsx` | Draw the full authored desk set whether occupied or not; occupancy only decides who sits where |
| `office/patches/ws-loopback-origin.patch` | `backend/app/api/websocket.py` | Accept loopback handshake origins on any port (the native build serves `http://127.0.0.1:18128`, which is not in `BACKEND_CORS_ORIGINS` and was rejected with close code 4003); non-loopback origins still go through the CORS/CIDR allowlist |

### Ben layout asset

`office/assets/ben-layout.json` is the exact layout bundled by the live Docker
deployment (`/app/app/assets/default_layout.json` in the `claude-office`
container), captured 2026-10-30:

| Field | Value |
|---|---|
| sha256 | `9fdb530511f4d3d10c2c7c2033fe7427c4fa03847f9d16d20061883b969d9364` |
| Size | 3,558 bytes |
| Content | 43 entity/desk overrides, 11 inserted sprites, `updatedAt` 1792282872151 |
| Use | `manage_claude_office.ps1` stages it over `backend/app/assets/default_layout.json`; first boot seeds it as the saved `Ben` view and the active layout |

### Behaviour change

- Identity seeding is unchanged: Ghost Protocol remains the only persistent
  identity; no Sol identities or avatars are introduced.
- First boot seeds the Ben view; an existing `office_layout` or
  `office_saved_layouts` preference is never overwritten.
- WebSocket loopback origins are accepted regardless of port; non-loopback
  origins still require the configured CORS origin or the HTTP CIDR allowlist.

### How to verify

```powershell
# applied sources, seeded layout, desk render, WS origin behaviour
$env:SINGULARITY_OFFICE_SOURCE = '<office-source>'
python native\windows\test_office_ghost_only_patch.py -v
```

The WebSocket fix was proven end to end on `.241`: a client connected to
`/ws/room/office` and `/ws/<session>`, one `session_start` event was posted
through `POST /api/v1/events` with the ingest key, the room client received
`state_update`, the session client received `event`, and
`GET /api/v1/sessions/<session>/replay` returned the event. Receipt:
`work/evidence/office/ws-event-proof-20261030T030536Z.json`
(sha256 `3842db03b26e75df454703965fab25e9fa184919969e66037cd8ee07f41b9849`).

### Known gaps

- The B5 patches are untracked in the candidate as of 2026-10-30; `SHA256SUMS`
  does not cover them and was not regenerated (operator deferred).
- Desk and seat constants in `OfficeGame.tsx` (`PINNED_SEATS`, the Sol desk name
  mapping) still name Sol; only identity seeds, the merge filter and the idle
  sweep are patched.
- Visual sign-off of the restored desk set and Ben view is with the operator;
  Ghost-only identity display was visually confirmed on 2026-10-30.

### B6 exact live seed (supersedes the layout row above)

The operator's live `Ben` view was exported read-only from the `claude-office`
container on 2026-10-30 and is now the release seed exactly as stored:

| Asset | sha256 | Bytes | Content |
|---|---|---|---|
| `office/assets/ben-layout.json` (active `office_layout`) | `4fc64eeab169901bd447fff63ac35d28986180d778a50d1252b9b4b671210d99` | 3,581 | 43 overrides, 11 inserted, `area` present |
| `office/assets/ben-saved-layouts.json` (`office_saved_layouts`, `Ben` key) | `6cce0cc278547071c75141de3af664cad94b121e12091d265ba158a3eac94005` | 3,624 | same layout wrapped with `savedAt` 1792282872217 |

Both were applied to `.241` `work\office-state\office.db` as the exact stored
values, and `manage_claude_office.ps1` stages `ben-layout.json` over
`backend/app/assets/default_layout.json`. The values are identical to the
previously bundled layout (only `updatedAt`/`area` differ), so desk geometry is
unchanged.

Desk rendering correction: `SolDesks` now draws the full pinned desk set
unconditionally (`desk-sol-webserver`, `desk-ghostreporting`) instead of only
when the owner identity is present. Desks are furniture; identity seeding stays
Ghost-only. Expected rendered desk ids: `desk-1`..`desk-10`, `boss-desk`,
`desk-ghostreporting`, `desk-sol-webserver`.

## Windows B8 boss-desk fix

Operator review of the B6/B7 build found one remaining desk missing against the
live Docker `Ben` view: the desk at the right-hand counter, beside the printer
and the cat. The desk id is `boss-desk` (a normal opened desk, not the Sol or
Ghost pinned desks); its saved layout override places it at `(1004, 740)`.

Root cause: `OfficeGame.tsx` rendered `<BossDesk />` only when the Sol Docker
identity was present (`presentPinned.has("Sol Docker") && <BossDesk />`). The
Windows product seeds Ghost Protocol only, so the boss desk never rendered. The
live deployment has Sol Docker present, which is why its view shows the desk.

| Field | Value |
|---|---|
| Patch | `office/patches/boss-desk-unconditional.patch` (unified diff, `-p1` from the Office repo root) |
| Applies to | `frontend/src/components/game/OfficeGame.tsx` at pin `95d8bdc5728b23bcf0fee4c371b35e071c44f642` |
| Change | replace the `presentPinned.has("Sol Docker") && <BossDesk />` gate with an unconditional `<BossDesk />`; identity seeding is untouched |
| Why | desks are furniture; a Ghost-only roster must still show the operator's full floor |

Verification on `.241`: source built with Next 16.3.5 (build id
`tnlvkQbMxQGcWEiOKRlMg`), applied with `apply_office_static.ps1`
(`applied=true, verified=true`), installed static served with
`index.html` sha256 `f16d2ea67a076c92c3d118e42e2b6942d429a4efeb0228ad4f83b4c38e7853a5`
(equal to `frontend/out`), `/health` 200. Before/after browser captures are in
`work/evidence/office/b8-live-local-before-boss.png` and
`b8-live-local.png`; the boss desk is present after the fix.

`test_office_ghost_only_patch.py` now checks the patch removes the owner gate and
that the applied `OfficeGame.tsx` renders `<BossDesk />` unconditionally.
