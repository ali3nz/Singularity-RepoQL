# Skill: Minimal implementation (Ponytail-derived rule, ticket 191 §8)

One-page standing reminder. Ponytail itself is NOT installed (plan non-goal);
this captures its minimal-implementation semantics against our existing rules.

## The ladder
When multiple implementations correctly satisfy the requirement, prefer, in
order:
1. Existing project functionality (check before writing anything new).
2. Standard library functionality.
3. Native platform functionality.
4. Existing project dependency.
5. New dependency.
6. New custom abstraction.
Do not move further down the list without a concrete CURRENT need — never a
hypothetical future one.

## Standing prohibitions
- No hypothetical future functionality.
- No abstraction solely for possible future reuse.
- No unnecessary configuration.
- No duplicate functionality.
- No replacement of established project conventions without a real requirement.
- No unrelated refactoring ("every changed line must have a defensible
  connection to the task").

## Minimalism never compromises
Correctness, safety, validation, rollback, observability, maintainability.
Smaller is better only among implementations that satisfy the requirement —
never by skipping the verification that makes it trustworthy.

## Relationship to existing rules
This refines (does not replace) the standing "smallest sufficient change" rule:
it gives the preference ORDER among sufficient implementations, which the
standing rule left implicit.
