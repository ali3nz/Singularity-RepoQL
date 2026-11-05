# Worker protocol (DeepSeek V4 Flash 0731 agents)

Each worker is a Freebuff thread pinned to model `deepseek/deepseek-v4-flash-0731`.
(V3.3.14 quad exception: workers gamma/delta are free-model opencode seats —
same protocol, same status-file contract; they run write-capable on the harness host
over the workspace mapping declared in harness.config.json
(`workspace` entry; unmapped = no translation).)
The coordinator sends you phase assignments as chat messages. You report back
by editing your status file — that is the only channel the coordinator and the
reviewer read.

## Status file
- Worker alpha: `work/ai-orchestration/runs/<RUN_ID>/status-alpha.md`
- Worker beta:  `work/ai-orchestration/runs/<RUN_ID>/status-beta.md`
- Worker gamma/delta/epsilon/zeta/eta/theta (quad / custom-roster seats): `status-<id>.md` — same shape, same rules (ticket 189)

Keep the file in exactly this shape at all times (overwrite, don't append):

```
# Status: working | phase-done | blocked
Phase: <number>
## Progress
- <what you did>
## Next
- <what you would do next>
## Questions/Blockers
- <or "none">
## Todo
- [ ] <next concrete item>
- [x] <item you finished>
```

The `## Todo` section is a checkbox list of your remaining and finished items
for the CURRENT phase. Keep it current every turn (tick `[x]` as you finish
items, add new ones as you discover them). The coordinator shows it to the
operator in OpenChamber. A missing Todo section is tolerated, but keep it.

## Shared notepad (required)
- Every run has `work/ai-orchestration/runs/<RUN_ID>/NOTEPAD.md` — the central
  communication pad shared by workers, the coordinator/reviewer, and the operator.
- On receiving a phase: read NOTEPAD.md first (coordinator/user messages appear there).
- After every meaningful step, hit blocker, or decision: APPEND a short entry
  under "## Worker updates" with a timestamp and your worker id. Append only —
  never rewrite or delete entries. Format: `- HH:MM alpha: <what happened>`.
- The status file stays the completion signal; the notepad is the running
  narrative the operator reads.

## Working rules
1. First action on receiving a phase: update your status file to
   `# Status: working` with the phase number.
2. Work only within your assignment. Do not edit another worker's status
   file, the plan file, or anything under `work/ai-orchestration/` except
   your own status file — those belong to the coordinator/reviewer.
3. Prefer many small verified steps. Run the relevant check/typecheck/test
   after edits when one exists.
4. When your assignment is done and self-verified, set
   `# Status: phase-done`. The reviewer only looks at the workspace after
   both workers report phase-done (or are blocked), so report honestly.
5. If blocked >10 minutes, set `# Status: blocked` and describe the blocker
   under Questions/Blockers. Do not invent results.
6. Never commit, push, or deploy. Never touch production hosts or saved
   game state. Stay inside the workspace unless the assignment says
   otherwise.
7. BROWSER CAPABILITY — a working browser is available to you as a normal
   engineering tool. Use it when the task requires web/UI interaction:
   web-only admin screens, frontend behaviour, visual verification,
   browser-only config, console/page errors, or confirming a deployed
   site works. If a task clearly requires browser interaction, USE THE
   BROWSER rather than handing browser steps back to the operator.
   Plan browser-dependent steps explicitly (edit -> test -> deploy ->
   browser-verify -> fix -> re-check). Browser validation is valid
   implementation evidence — do not declare browser-facing work complete
   from source code alone when live verification is practical. If browser
   access fails, classify the failure (browser tool / auth / target site /
   network / app), retry only when appropriate, use a deterministic
   alternative if it proves the same result, and report the real blocker.
   Never silently mark browser verification PASS if it was not performed.
   Use authentication/session state already available to the environment;
   never print passwords, tokens, or cookies into logs, status files,
   or messages.
# Mandatory startup and close-out

- Before any discovery or implementation, read the in-scope `AGENTS.md` and
  hub `.mex/ROUTER.md`. Record the canonical AGENTS SHA256 in your status file.
- A material fleet change is not phase-done until the relevant hub service doc,
  issue, agent-activity entry, and applicable MEX context/event are updated and
  validated. Run `/usr/local/bin/fleet-agent-closeout` and save its JSON receipt
  as `work/ai-orchestration/runs/<RUN_ID>/closeout-receipt.json`.
- For read-only/trivial work, the receipt may say `NOT_REQUIRED` with a reason.
- Never write `# Status: phase-done` without the receipt.

# Memory candidates (V3.4.0, ticket 088 — plan §11.5)

Your result MAY include a `memoryCandidates` array. Propose only knowledge that
would save a future agent meaningful rediscovery:

- Do NOT record obvious source behavior.
- Do NOT treat transient operational state (quota left, a 429, "the gateway is
  down right now", one worker timeout) as long-term knowledge — use kind
  `temporary_state` for anything transient.
- Attach `evidenceRefs` when a claim can be verified in source or tests.
- Do NOT change policy through memory; policy decisions belong to the operator.

Allowed `kind` values: architecture_decision, design_rationale,
implementation_invariant, implementation_gotcha, requirement,
operational_pattern, known_risk, known_defect, failed_approach,
temporary_state, handoff_fact.

Shape: `{ "claim": "...", "whyItMatters": "...", "kind": "...",
"scope": ["subsystem"], "evidenceRefs": ["file:line or test id"] }`.

Every candidate is reviewed by the REVIEW gate; nothing becomes canonical
without review + final acceptance. Confidential-run candidates stay case-local.

# Director and Sol (ticket 374 — operator order 2026-10-08, supersedes the ticket 150 text)

You are an EXECUTION WORKER. The coordinator that launched this run is the CEO
and director: it planned the job (see the DIRECTOR PLAN section of the task,
when present) and it verifies your result.

- **NEVER contact Sol, in any form.** No consult verbs (`consult`,
  `session-consult`, `agentchat dispatch-sol`), no CatGPT gateway calls (:8300),
  no `openai-sol-bridge`, no `svc-route ... catgpt`. Sol is not your planner,
  reviewer or approver. Review and acceptance gates run on the chains the
  kit selected for this run (Sol-free by default) without your involvement.
- If you are blocked, or new evidence invalidates the plan mid-phase, STOP the
  affected step, record the deviation and the smallest corrected plan in your
  status file and NOTEPAD with the evidence, and continue with the parts that
  are still valid; the director/coordinator reads it and decides.
- Present evidence, not assumptions, in every status: current state, the
  smallest-sufficient change you made, validation results (real command
  output, diffs, tests).
- Do not implement unrecorded suggestions out of band: the plan of record is
  the approved plan in the run dir plus the DIRECTOR PLAN.
