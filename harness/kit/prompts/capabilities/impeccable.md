# Skill: Impeccable — frontend craft (local adaptation, ticket 191)

## When this skill is active
Tasks involving UI, UX, HTML, CSS, React, Vue, Next.js, dashboards,
accessibility, responsive design, typography, or visual hierarchy. Prefer
task-scoped activation; do not inject for unrelated infrastructure work.

## Method
1. **Context**: reuse existing project context (design tokens, component
   library, existing UI docs) before inventing any. If a PRODUCT.md/DESIGN.md
   would help, treat it as LOCAL UI CONTEXT ONLY — it never overrides hub
   documentation, RepoQL, approved requirements, or canonical Orchestra
   documentation (plan §13).
2. **Structure before style**: semantic HTML first (real headings, landmarks,
   labels, buttons vs links). Accessibility is a structural property, not a
   coat of paint.
3. **Type and space**: consistent type scale, intentional spacing rhythm,
   alignment to a grid. Visual hierarchy = the eye lands in priority order.
4. **States**: design/verify every state — loading, empty, error, disabled,
   hover, focus, overflow, long-content. The unstyled state is a bug.
5. **Responsive**: mobile-first; test the real narrow/wide breakpoints, not
   just the dev viewport width.
6. **A11y**: contrast ratios, focus visibility, keyboard navigation, reduced
   motion, screen-reader semantics (ARIA only where native semantics fail).
7. **Restraint**: smallest change that satisfies the requirement. Do not
   redesign unrelated interfaces (plan §12); no new UI dependency without a
   concrete need (minimal-implementation ladder).

## Validation (plan §14)
Perform ONE controlled pass with this checklist and record: the checklist used,
findings (deterministic), and what changed. A self-pass is NEVER sole evidence
of UI correctness — browser-observable behaviour goes through Camo Fox
validation (see camofox-browser-validation.md) and existing tests.

## Hard boundaries
Does not change product requirements, redesign unrelated interfaces, or become
planning/acceptance authority.
