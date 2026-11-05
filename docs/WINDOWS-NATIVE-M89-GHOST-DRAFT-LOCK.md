# Milestone 89 — Bounded cross-process draft lock (SOURCE ONLY)

The private Ghost draft ledger has a durable inter-process file lock, but previously requested a blocking lock with no deadline. If another dashboard process remained alive while holding that lock, a request could remain blocked indefinitely. Draft reads and writes now use nonblocking lock acquisition with a bounded five-second retry deadline. A contention timeout returns HTTP 503 (`plans_lock_busy`), allowing the operator to refresh instead of assuming a save succeeded.

Unexpected OS lock failures return a distinct fail-closed error and perform no ledger mutation. This is an adapter-level change: real `msvcrt.locking()` behavior on the target Windows filesystem still requires acceptance. A lock timeout **never means a task was saved, scheduled or executed**.

**RELEASE BLOCKED** until Ghost native daemon/scheduler and Windows GUI acceptance.
