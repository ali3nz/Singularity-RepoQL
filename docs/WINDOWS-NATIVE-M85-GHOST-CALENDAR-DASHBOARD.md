# Milestone 85 — Ghost Control Center calendar and task-planning redesign

**Source-only checkpoint, not a Windows release.** This milestone includes the prior Milestone 84 RepoQL proxy redirect/error-boundary changes, which were present in the working source but not separately uploaded as a complete release checkpoint.

## Product behavior

- Professional, compact dark dashboard: real Ghost state, a seven-day Monday–Sunday calendar and selected-day agenda are prominent. Activity and sanitised provider logs sit in expandable sections instead of occupying the whole page. Runtime, memory and conversation metadata remain available, without displaying private reasoning.
- Previous week / Today / Next week controls always display all seven dates, including empty dates, in `Pacific/Auckland`. The day model uses UTC calendar arithmetic to avoid DST rollover errors.
- The agenda distinguishes **observed live scheduled entries** from **operator drafts**. `DRAFT ONLY` records are never conflated with active Ghost schedules or confirmed executions. Draft daily and weekly recurrence is shown as a preview on applicable days; the preview itself does not create timers.
- The planner lets an operator create, edit and delete a private task draft: title, date, time, recurrence and editable prompt. Clicking "Plan work for this day" preselects the day unless there is already an unfinished edit. All mutations require the existing authenticated, same-origin control headers and confirmation flag; edits/deletions include an expected revision. Reusing a create request ID returns the existing draft to prevent duplicates after a lost response.
- Existing real Ghost pause/resume and versioned prompt save/restore operations remain bound to the authoritative Ghost control service. Unsaved prompt text is protected from accidental tab-switch replacement.
- A new standalone `schedule_model.mjs` implements the calendar and is served as `application/javascript` with `nosniff`, including through the embedded shadow DOM route.

## Remaining operational limitation

Ghost has no approved scheduler registration operation exposed through this dashboard's private control contract. Consequently **Save draft does not activate an executable job**. Implementing a real create/reschedule action requires an owner-reviewed Ghost service API with safe task identity, ownership, scheduling, cancellation and execution semantics, followed by real Windows/host testing. Do not invent a new timer or write arbitrary systemd/Task Scheduler jobs from this browser UI. Existing live tasks can be paused/resumed and their prompts edited through Ghost's authenticated control endpoint.

## Targeted source checks

```text
node --check dashboard/static/ghost/dashboard.js
node --check dashboard/static/ghost/tasks.js
node --test dashboard/static/ghost/schedule_model.test.mjs
python -m unittest discover -s dashboard -p test_ghost_schedule_plans.py
python -m unittest discover -s dashboard -p test_variant_http.py
```

These do not prove actual browser layout, live Ghost state, mobile interaction, or scheduled execution. In a controlled Windows test environment, verify authenticated embedded and standalone views, calendar navigation, drafts at DST boundaries, private storage permissions, edits under concurrent sessions, and actual live pause/resume/prompt revision behavior. Capture screenshots from the real application only after those runs. Do not claim production acceptance from code-level tests.
