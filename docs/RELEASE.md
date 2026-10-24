# Release gate

What has to be true before a commit is tagged. The gate is two-layered: public
CI must pass for every push, and a stricter operator run must pass before a tag
is created.

## Release identity

A release is three things that must agree:

1. `MANIFEST.json` `version` — for example `0.1.0-rc5`.
2. An annotated git tag — `v` plus that version, never moved or reused after it
   is pushed.
3. A GitHub release for that tag, marked **prerelease** while the capability gate
   still reports anything unverified.

`SHA256SUMS` covers every tracked file. The tag is the immutable reference; if a
defect is found after tagging, cut the next candidate rather than moving the tag.

## Layer 1 — public checks (CI)

Runs on every push to `main` and on every pull request:

```bash
bash tests/validate-manifest.sh   # SHA256SUMS covers every tracked file
bash tests/validate-local.sh      # syntax, unit suites, JSON, compose, ref scan
```

The internal-reference scan here uses the committed generic guard only. It must
pass on a clean clone with no local files present.

## Layer 2 — operator release run

Same suite, plus the private overlay that is deliberately not committed:

```bash
# tests/forbidden-refs.local.txt is gitignored; copy it beside a clean clone,
# run, then delete it again.
FORBIDDEN_REFS_REQUIRE_LOCAL=1 bash tests/scan-refs.sh
```

With `FORBIDDEN_REFS_REQUIRE_LOCAL=1` the scan fails if the overlay is missing,
empty or malformed, rather than silently degrading to the weaker public guard.
The scanner also fails closed on an unreadable pattern file and on a `grep`
error, so a broken guard can never report a clean tree.

## Image review

The text scan skips binary files on purpose: a screenshot cannot be judged by
`grep`. Review every shipped image by eye and by metadata before tagging:

- no hostnames, seat names, lane names, addresses, tokens or account handles;
- no EXIF/text chunks carrying a path or a username;
- nothing that identifies a private installation.

Two screenshots were removed from this repository for exactly this reason. Their
capability text is in `README.md` and `office/README.md`.

## Checksum procedure

Order matters. Add new files to the index first, then regenerate:

```bash
git add -A                       # new files must be TRACKED before summing
git ls-files | grep -v '^SHA256SUMS$' | sort | xargs sha256sum > SHA256SUMS
bash tests/validate-manifest.sh  # must print DRIFT GATE OK
```

Regenerating while a file is still untracked produces a manifest that omits it,
and the drift gate fails on the next clone. That is the gate doing its job.

## Before the tag

- [ ] `bash tests/validate-local.sh` prints `VALIDATION OK` on a clean clone.
- [ ] `FORBIDDEN_REFS_REQUIRE_LOCAL=1 bash tests/scan-refs.sh` is clean.
- [ ] CI passed for the exact commit being tagged.
- [ ] `MANIFEST.json` and `CHANGELOG.md` describe that commit.
- [ ] Images reviewed as above.
- [ ] Working tree clean: `git status --porcelain` prints nothing.

## After the tag

Record the CI run and the validation receipt on the release page, then leave the
tag alone.

## Known limitations of a release

- Git history is not rewritten by a release. Removing a file from `main` does not
  remove it from earlier commits, clones or caches.
- A `NOT_CONFIGURED` capability that belongs to the chosen installation option is
  a failure, not a pass. `node scripts/doctor.mjs` exits nonzero until every
  mandatory capability is verified by a real check.
