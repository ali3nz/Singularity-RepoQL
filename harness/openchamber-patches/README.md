# OpenChamber application delta

**Status: recorded, not reproduced.** This directory holds the *declared* delta
between upstream OpenChamber and the build the fleet runs — not a tree copy, and
not a parity claim.

## What is verified

| Fact | Value | How it was checked |
| --- | --- | --- |
| Upstream repository | `https://github.com/openchamber/openchamber` | GitHub API |
| Upstream tag | `v2.5.2` | `GET /repos/openchamber/openchamber/git/ref/tags/v2.5.2` |
| Upstream commit | `c4919abc1e7a0a3beeaa126666487806bf79cfe0` | same response (`object.type: commit`) |
| Fleet delta head | `9ad2a0200` | reported by the deployment record |
| Delta size | 5 commits, 32 files | reported by the deployment record |

## What is NOT verifiable from published sources

`git format-patch v2.5.2..9ad2a0200` cannot be produced here:

```
GET /repos/openchamber/openchamber/commits/9ad2a0200      -> 422 (not found)
git cat-file -t 9ad2a0200   (fleet checkout)             -> fatal: Not a valid object name
git remote -v               (fleet checkout)             -> no remotes configured
```

The fleet checkout that carries the delta publishes neither the commit nor a
remote that could supply it, and no local clone on the reference host contains the
object. Recording patches from a source we do not have would be fabrication, so
`series` is empty and `patches/` holds no files.

## Regenerating it (when the objects are available)

```bash
git clone https://github.com/openchamber/openchamber.git /tmp/oc-upstream
cd /tmp/oc-upstream
git fetch /path/to/fleet-checkout 9ad2a0200        # or: git remote add fleet <url> && git fetch fleet 9ad2a0200
git format-patch --no-signature --zero-commit --no-numbered \
    v2.5.2..9ad2a0200 -o /path/to/harness/openchamber-patches/patches
git rev-list --count v2.5.2..9ad2a0200             # expect 5
git diff --name-only v2.5.2..9ad2a0200 | wc -l     # expect 32
```

Then list the files in `series`, and update this table with the real counts.

## Applying it

`apply.sh` is safe by construction:

- it verifies every patch's base commit before touching anything;
- it refuses to run if `series` is empty (today's state) instead of pretending to
  have applied something;
- `--dry-run` (the default) only reports;
- `--reverse` unapplies in reverse order, leaving the checkout as it was;
- it never commits, tags or pushes.

```bash
bash harness/openchamber-patches/apply.sh --checkout /path/to/openchamber
bash harness/openchamber-patches/apply.sh --checkout /path/to/openchamber --apply
bash harness/openchamber-patches/apply.sh --checkout /path/to/openchamber --reverse
```

## Runtime pin (documentation only)

`harness/config/openchamber-runtime.json` records the OpenCode runtime version
observed in the running container and the shape of its config bundle. It is a
pin record for a human comparing deployments; this contribution does not consume
it, and no plugin, config back-up or `node_modules` tree is copied.
