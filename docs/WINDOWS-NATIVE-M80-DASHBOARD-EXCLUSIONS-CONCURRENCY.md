# Milestone 80 — Dashboard exclusion ledger serialization

**Source only; production release BLOCKED.** The native Windows listener, Task Scheduler job, RepoQL binary and user ledger have not been used.

Before M80 the dashboard's exclusions ledger was protected only by a Python `threading.Lock` scoped to a single `ExclusionStore` instance. Two dashboard processes could each load the same snapshot and each atomically replace `exclusions.json`, silently losing the first writer's record. Atomic rename alone does not serialize a read-modify-write transaction.

M80 holds an OS advisory lock on a **persistent, separate `exclusions.json.lock` file** for the entire load/change/save transaction. The lockfile is never unlinked after release, avoiding an inode replacement race. All writers in the dashboard use the existing cross-platform `dashboard/file_lock.py` adapter, including `msvcrt.locking` on Windows. The lock is one byte long for native Windows compatibility. A symlinked lockfile is refused. Existing fail-closed malformed-ledger and pending-temp behavior is retained.

Focused test: `python -m unittest discover -s dashboard -p test_exclusion_store_contract.py` (8 cases; includes competing independent instances with a widened historical race). This does **not** prove actual multi-process contention on a Windows deployment. Windows release acceptance must run with two distinct non-production dashboard processes/instances, inspect ledger preservation, permissions and stale lock handling, and confirm no production exclusion rules were altered.
