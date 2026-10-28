# Skill: Camo Fox browser validation (ticket 191; capability discovery 2026-10-01)

Camo Fox is the fleet's existing preferred agent browser (camoufox 2.4.8,
container `camofox` on controller + webserver, REST API :9377, Bearer
CAMOFOX_API_KEY from the host .env — never print the key). Do NOT install
Chrome DevTools MCP or a second browser stack for convenience (plan §15);
browser-testing methodologies written for DevTools are adapted to this flow.

## Live-verified capability surface (2026-10-01, controller)
- `GET /` → status JSON: engine camoufox, version, browserConnected, poolSize,
  activeUserIds. Idle = browserConnected:false, poolSize:0.
- `GET /tabs` → 200, tab list (empty pool returns {"running":true,"tabs":[]}).
- `GET /snapshot` → 400 without a tab id — snapshots are per-tab.
- Documented per hub service-routing.md: tabs / snapshot / screenshot / act
  (act = drive interactions + evaluate JS in the page).

## Evidence flow (preferred order)
1. Open a tab (navigate to the target URL).
2. Interact via act (click, fill, press) — one step at a time, verify state
   between steps via snapshot.
3. **snapshot** → the accessibility tree with element handles: structure +
   a11y evidence in one call.
4. **screenshot** → visual/layout evidence (what the user sees).
5. act-evaluate for console errors, runtime JS failures, computed styles,
   and network evidence the page itself can report. Performance numbers the
   API does not expose are NOT claimed.
6. Close the tab and confirm the pool returns to its pre-task state —
   browser-stack hygiene rule 1: you break it, you bought it (proc/RAM caps
   are permanent; never leave sessions running).

## Evidence duty
Record: endpoint calls made, key snapshot/screenshot findings, console/runtime
errors observed, and the tab cleanup confirmation. If a required capability is
missing (plan §18 gap rule): name the exact gap, the acceptance criterion
needing it, prove Camo Fox cannot satisfy it, consult Sol — only then consider
another dependency.

## Hard boundaries
Never restart the camofox container yourself (idle-refresh is the central
timer's job); never run validation with a logged-out or broken browser session
silently — a 200 from /tabs does not mean a healthy browser for your task
(EXISTENCE IS NEVER LIVENESS).
