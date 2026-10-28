# Skill: Archify — architecture visualization (local adaptation, ticket 191)

A visualization tool. NOT architecture authority, repository authority,
planner, coordinator, or runtime truth (plan §19).

## When this skill is active
Architecture, workflow, sequence, data-flow, or lifecycle diagrams are
requested or are the clearest way to communicate a design/evidence package.

## Method
1. **Derive from evidence**: every node and edge must come from verified
   source code, configuration, approved documentation, or verified RepoQL
   retrieval (plan §20). No invented components, no aspirational boxes, no
   "somewhere in the pipeline" arrows.
2. **Real names**: components carry their real names (container, service,
   file, queue) — correct terminology beats pretty abstraction.
3. **Choose the right diagram**: data flow (how information moves), sequence
   (ordering + interaction), lifecycle (states + transitions), architecture
   (structure + boundaries). Mixing all four into one diagram fails all four.
4. **Render + verify**: generate the diagram (SVG preferred: self-contained,
   diffable, no runtime deps), confirm it renders, then verify content
   against the evidence sources line by line.
5. **Sanitize**: no secrets, no credentials, no tokens, no internal IPs unless
   the diagram is explicitly for an internal evidence package that allows
   them (fleet doc rules; wiki gets redacted versions).

## Evidence duty (plan §21)
Record: what was rendered, the sources each element came from, and where the
artifact is kept. Do not retain throwaway artifacts unless they have lasting
documentation value — durable diagrams belong in the hub, not temp dirs.

## Boundary
If the diagram and the code disagree, THE CODE IS RIGHT — fix the diagram, then
investigate why the diagram was wrong (that investigation is often the real
finding).
