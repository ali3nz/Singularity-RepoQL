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
FORBIDDEN_REFS_REQUIRE_LOCAL=1 bash tests/scan-refs.sh  # release host: the gitignored overlay is REQUIRED
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

Order matters. Regenerate only after every other edit. Use a temporary
index so every path is hashed exactly as Git would store it.
This covers new untracked files, applies `.gitattributes` (including
`eol=crlf`), and never stages anything in the real index:

```bash
tmp_index="$(mktemp)"; rm -f "$tmp_index"
GIT_INDEX_FILE="$tmp_index" git add -A
{
  GIT_INDEX_FILE="$tmp_index" git ls-files | grep -v '^SHA256SUMS$' | sort |
  while IFS= read -r f; do
    h="$(GIT_INDEX_FILE="$tmp_index" git cat-file blob ":$f" | sha256sum | cut -d' ' -f1)"
    printf '%s  %s\n' "$h" "$f"
  done
} > SHA256SUMS
rm -f "$tmp_index"
bash tests/validate-manifest.sh  # must print DRIFT GATE OK
```

The gate uses the same temporary-index/blob method when `.git` is present. In a
zip/source checkout without `.git` it verifies the listed worktree files with
CRLF-to-LF normalisation for the patterns `.gitattributes` marks `eol=crlf`, so
a Windows checkout validates the same canonical manifest as the repository.

## Before the tag

- [ ] `bash tests/validate-local.sh` prints `VALIDATION OK` on a clean clone.
- [ ] `bash tests/validate-local.sh` includes the compose config check; a host
      without `docker compose` FAILS the gate instead of skipping it.
- [ ] `node bin/ai-orchestra selftest` exits 0 (one labelled `SKIP` is the
      fleet-only bridge pin; a `FAIL` is always a failure).
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
