# RepoQL issue report: a session-0 host blocks later interactive hosts with an unnamed "Access is denied"

- Version: `rql` 1.7.18 (pinned runtime copy); config pins 1.7.18.
- Environment: Windows 11 Pro 10.0.26300, native (no container). Plugin `repoql@repoql-plugins`, parse/fetch/render connector contract.
- Exact command: (1) a scheduled task running `rql serve --path <workspace>` under S4U logon with a boot trigger (session 0); (2) later, from a normal desktop session (session 2), any command that starts a host for another path, e.g. `rql read file:///README.md` from a repo directory.
- Expected: the second invocation either attaches to the running host, starts an independent host, or fails with a message naming the conflicting resource (port, pipe, mutex, lock file) and the owning session.
- Actual: the second invocation fails with `Win32Exception: Access is denied` raised inside a type initializer. No stack trace, resource name or owning process is printed, so the cause is not discoverable from the output. The Claude Code RepoQL MCP (which spawns a host from the repo cwd) failed the same way, so every tool call was unavailable.
- Reproduction:
  1. Register a task: S4U logon, boot trigger, action `rql serve --path <workspace A>`. Start it; confirm `rql` runs in session 0.
  2. From a desktop session, run `rql read file:///README.md` in a different directory B. Observe the error.
  3. Stop the task and kill `rql` processes; repeat step 2: it succeeds and the host runs in session 2.
  4. With the interactive host running, start the task again: it starts successfully. So order matters: session 0 first blocks session 2; session 2 first does not block session 0.
  5. Replacing the task with an interactive-logon one (same action) removes the failure.
  Scope: observed on 1.7.18 only; other versions present on the machine (1.7.14, 1.7.19) were not tested.
- Evidence: process listing showed the working case with `rql` in session 2; failing case had `rql` in session 0 only. Exit status non-zero with the single `Access is denied` message. No logs name a resource.
- Attribution: RepoQL defect (error reporting, and arguably host-selection). The harness only launched `rql`; the same failure occurs from a plain shell and from the MCP, and clearing the session-0 host fixes both. The cross-session denial itself may be an intentional isolation (a shared per-user object created in session 0 not openable from session 2), but RepoQL gives no diagnostic. Not a configuration error: the task definition was valid and ran as configured.
- Redaction: no credentials, tokens, private paths or account data included.
