# Skill: Source-Driven Development (local adaptation, ticket 191)

Boundary (memorize): RepoQL answers "how does OUR repository currently work?"
Source-Driven Development answers "what does the upstream system currently
require?" Neither replaces the other.

## When this skill is active
Implementation depends on: framework behaviour, API behaviour, library
behaviour, configuration syntax, version-specific behaviour, deprecations, or
platform behaviour that you cannot verify from the local tree alone.

## Method
1. Pin the exact versions in play FIRST (compose file, lockfile, package
   metadata, running container version). Never reason about "the docs"
   abstractly.
2. Go to the authoritative source for THAT version: official docs for the
   pinned version, the upstream repo (CHANGELOG, release notes, migration
   guide), or the dependency's own source in the local checkout/node_modules.
3. Verify the specific behaviour you are about to rely on — the option name,
   the default, the error mode — not the general feature.
4. Record what you relied on in the implementation evidence (version + source),
   so a future reviewer can re-check the same anchor.
5. If the upstream contract conflicts with our current usage: surface the
   conflict explicitly (it is a compatibility finding, not something to paper
   over with a workaround).

## Anti-patterns
- Citing a blog post or tutorial when the official reference for the pinned
  version is reachable.
- Assuming behaviour from a newer/older version than the one deployed.
- Letting upstream "recommended" patterns override OUR conventions without an
  explicit, recorded decision.

## Never
- This skill never authorizes installs, version bumps, or config changes on
  fleet hosts — those stay governed by the existing Orchestra gates.
