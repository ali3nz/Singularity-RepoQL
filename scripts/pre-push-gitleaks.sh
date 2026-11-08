#!/usr/bin/env bash
# Git pre-push hook: block the push if gitleaks finds a secret in the commits being pushed.
# Install: ln -sf ../../scripts/pre-push-gitleaks.sh .git/hooks/pre-push
set -euo pipefail
command -v gitleaks >/dev/null || { echo "pre-push: gitleaks not installed; refusing to push to a public repo" >&2; exit 1; }
root=$(git rev-parse --show-toplevel)
zero=0000000000000000000000000000000000000000
while read -r _ local_sha _ remote_sha; do
  [ "$local_sha" = "$zero" ] && continue
  range=$local_sha; [ "$remote_sha" != "$zero" ] && range="$remote_sha..$local_sha"
  gitleaks detect --source "$root" --config "$root/.gitleaks.toml" --redact --no-banner --log-opts="$range" \
    || { echo "pre-push: gitleaks found a possible secret in $range; push blocked" >&2; exit 1; }
done
