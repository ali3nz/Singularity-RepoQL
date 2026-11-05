---
name: Claude Office visual changes
description: Change and verify the Claude Office visualizer (geometry, sprite facings, furniture, persistent identities) with vision checks before claiming done
---

# Claude Office visual changes

## Purpose

Make a visual change to the Claude Office visualizer and prove it looks right with
your own eyes, instead of asserting success.

## Use when

A change affects what the office canvas renders: agent or desk geometry, sprite
facings, furniture or lounge, labels and chips, day-night room art, embed framing,
or the persistent identities.

## Hard-won rules (do not relearn these the painful way)

1. **Seats and furniture are two different orderings.** Seat N sits at
   `DESKS[SEAT_TO_DESK_INDEX[N-1]]`, never `DESKS[N-1]`. Getting this wrong puts
   desks on the wrong spots and leaves characters standing on bare floor beside
   "empty" desks.
2. **Standing-desk geometry:** `agent.x = desk.x`, `agent.y = desk.y + 40`
   (`STAND_DESK_FORWARD`), and the character uses a **REAR** facing sprite. Desk
   sprites are anchored bottom-centre with monitors in the upper half, so drawing
   the character at the desk anchor paints the desk across their body.
3. **Facing convention:** `front-*` faces the camera, `rear-*` has its back to the
   camera (looking into the scene). "Facing their computer" therefore reads as a
   REAR sprite. Photograph the four facings side by side before touching
   orientation maths.
4. **Z-order:** desks and agents must render inside the same `sortableChildren`
   container; anything outside it draws over everything. Furniture carries a
   negative z-bias so an occupant can never be covered.
5. **Visibility:** skip the floor-region test for agents that have a desk (it is
   for desk-less strays only), and render only OCCUPIED desks.
6. **Primitives do not blend with pixel art.** If custom furniture is unavoidable:
   rectangles only, hard edges, opaque fills, room palette, sized against known
   references (character 133px, desk ~180px).
7. **Persistent identities** must always render with the same seat and avatar:
   pinned seats, id-based idle-sweep exemption, deterministic avatar hash, plus
   the seeds and cache in `systems/persistentIdentities.ts`.

## Procedure

1. Read the current state: the office component under
   `frontend/src/components/game/` and the office notes in the project docs.
2. Make the change; run `npx tsc --noEmit` in `frontend/`.
3. Run the identity regression test if you touched identities.
4. Deploy the way the project's office compose file does; do not restart the
   primary application to apply an office change — they are separate containers.
5. **Vision check yourself:** open the office in a browser at 1280x800 and again
   at 390x844 (and `?embed=1` when the homepage card is affected), wait for the
   scene to settle, screenshot, and LOOK at it. Use a two-frame pixel or PSNR diff
   when timing or motion is the question. Close the browser session afterwards.
6. If the change is significant, get a second pair of eyes on the screenshot: hand
   the image plus the exact numbers and questions to a reviewer, and continue the
   same review session until it accepts or raises a defect. A reviewer that cannot
   return the artifact is recorded as unavailable, not as approval.
7. Close out: update the office notes, record the outcome, and close the work item.

## Do not

- Do not claim a visual fix without a screenshot you have actually looked at.
- Do not keep nudging layout after sign-off; freeze what was accepted.
- Do not leave browser tabs or sessions open.
- Do not describe a change as verified because the build passed; the build does
  not see the canvas.
