# Milestone 91 — Ghost deleted draft request retirement (SOURCE ONLY)

## Proven gap in M90

M90 retained request IDs only for surviving drafts. Creating a draft, editing it,
then deleting it discarded its complete request history. A later retry of the
original creation request produced a different draft ID and could be mistaken
for a new operator intention. Reusing the deletion request ID to create a draft
was also accepted.

## Correction

The existing private Ghost draft JSON ledger now optionally records a
`retiredRequestIds` array. On successful deletion it atomically reserves the
creation, edit and deletion request IDs; subsequent attempts to reuse those
IDs for a draft save or delete return `409 request_id_payload_conflict`.
The retirement set is not exposed through the GET API or copied into prompts.
The existing schema=1 format, read-only activation proposals, and legacy
ledgers without this field remain compatible.

The retirement set must be a well-formed, duplicate-free list with no
intersection with any surviving draft history. Duplicate request IDs spanning
two live draft rows are now also refused. Invalid ledgers remain unchanged.
A hard bound of 2048 retired IDs and the existing 512 KiB ledger limit are
intentional fail-closed limits. When the bound would be crossed, deletion is
refused without changing the draft or discarding previously retired IDs;
there is no automatic tombstone eviction, which would reintroduce stale replay.
The protected scope is the lifetime of this private ledger, not a claim of
replay prevention after operators deliberately destroy or restore its data.

## Verification and remaining work

Focused Python tests cover stale create/edit/delete replays, corruption,
legacy readback, cross-draft collisions and exhaustion. The wider dashboard,
Ghost model and gateway tests are exercised from this source checkout.

**No native Windows schedule registration or execution is provided.** The
existing active Ghost control host remains independent. Source tests are not
scheduler readback, actual task execution, Windows compilation, browser
acceptance, signed binaries, or installation acceptance.

**RELEASE BLOCKED / SOURCE ONLY.**
