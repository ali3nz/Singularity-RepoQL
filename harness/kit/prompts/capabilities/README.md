# Capability skills — task-scoped activation (ticket 191 Stage 2)

Injected into worker/coordinator context ONLY when the task matches the
activation trigger. Normal backend task: NONE of these inject (§58
context-efficiency rule). Each file is a self-contained methodology; activation
is the coordinator's/worker's judgment from the triggers below.

Provenance: local adaptations authored 2026-10-01 (Buffy) from the methodologies
named in the operator plan (impeccable / archify / Addy Osmani worker skills /
i-have-adhd presentation patterns). **NO upstream skill text was imported** —
`git ls-remote` to the upstream repos was unreachable from this surface at
implementation time, and no upstream commit pin could be honestly recorded
(§60). These are therefore original methodology write-ups named for the
practices they encode. Zero external scripts, zero install steps, zero network
calls, zero git operations — attack surface is empty by construction (§59).
Revisit upstream import when network access to the sources exists; do not
follow moving branches without a pin.

This dir is deliberately NOT `skills/`: that dir is the GENERATED harvested-skill
injection surface (INDEX.md is machine-regenerated; files there feed run
injection automatically). Capability skills must not leak into every run.

| File | Activates when | Never activates when |
|---|---|---|
| source-driven-development.md | external framework/API/config behaviour matters | RepoQL question about OUR repo |
| debugging-error-recovery.md | a failure needs systematic root-causing | routine verified step (§3 worker rules) |
| security-hardening.md | authn/z, tokens, secrets, input, webhooks, network boundaries | non-security infra work |
| impeccable.md | UI/UX/HTML/CSS/React/dashboards/a11y/responsive | unrelated infrastructure work |
| archify.md | architecture/sequence/data-flow/lifecycle diagrams | runtime decisions (diagrams are not authority) |
| camofox-browser-validation.md | browser-observable behaviour must be validated | non-browser validation |
| adhd-presentation.md | human-facing progress/failure communication | technical evidence surfaces (never compressed) |
| minimal-implementation.md | implementation-principle reminder (Ponytail-derived) | — (one-page standing reminder) |

Boundaries carried by every file: skills improve execution INSIDE existing
stages; none of them is a planner, coordinator, review authority, acceptance
authority, or lifecycle controller (§4 architectural principle).
