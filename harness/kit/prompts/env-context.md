# ENVIRONMENT & COMMAND CONTEXT (always applies)

This harness runs on the host you are already on. It knows nothing about any
other machine, address or mounting convention unless the harness configuration
says so (`harness/harness.config.json` → `mapping`).

Rules when reading a request:

- a path the task names is a path on **this** host; do not translate it to
  another machine's layout;
- if a task names a host, container or service this harness has no mapping for,
  say so explicitly and continue with what you can verify locally — never guess
  a remote address or invent an SSH target;
- capability that is not configured is reported unavailable, not simulated: no
  provider, retrieval host, browser stack or external service is implied by this
  document.

Verify live state on the machine you are on rather than trusting any document.
