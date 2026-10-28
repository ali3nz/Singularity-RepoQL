---
name: statusline-builder
description: "Compose a personalized status line from a menu of code-index-powered widgets — session cost, burn rate, cache hit ratio, context and rate-limit gauges, PR state, index health, live operations, git state. Shows the user what is possible, lets them pick, assembles and tests the script."
---

# Statusline Builder

A status line is a one-line dashboard the agent client renders under the prompt,
fed the live session as JSON on stdin. The RepoQL code-index supplies a menu of
widgets — session cost and burn rate, cache hits, context and rate-limit gauges,
PR state, index health, live operations, git state. This skill shows the user
what is possible, lets them pick, and assembles a tested, personalized script from
verified fragments.

## Prerequisite, and where the detail lives

The widget catalogue and the per-widget fragments are **supplied by the RepoQL
plugin**, which is a separately installed and licensed component. They are not
copied into this repository.

- If the RepoQL plugin is installed, its help tree carries this skill's full
  inventory. Browse it before assembling anything:

  ```
  read("help:///skills/statusline-builder/** => tree: headlines", 5000)
  ```

- If the plugin is not installed, this skill has no fragment inventory to work
  from. Say so plainly and stop; do not reconstruct the widgets from memory, and do
  not invent widget names or metrics.

## Working from the inventory

Skill files are irreducible — they cannot be summarised and still communicate what
they need to. Browse what is available, then read each file you need with
`=> content` to get the full text, never `=> structure`:

```
read("help:///skills/statusline-builder/SKILL.md => content", 10000)
```

Assemble the script from the fragments that exist in that inventory, keep the
user's chosen widgets only, and test the assembled script against a real session
payload before handing it over.
