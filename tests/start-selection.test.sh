#!/usr/bin/env bash
# Unsupported or missing selections must stop before Docker or filesystem work.
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
T="$(mktemp -d)"
trap 'rm -rf "$T"' EXIT
mkdir -p "$T/bin" "$T/home"
cat > "$T/bin/docker" <<'SH'
#!/usr/bin/env bash
echo called >> "$DOCKER_SELECTION_MARKER"
exit 1
SH
chmod +x "$T/bin/docker"
for option in unset 1 2 5 invalid; do
  if [[ "$option" == unset ]]; then
    if env -u SINGULARITY_VARIANT PATH="$T/bin:$PATH" HOME="$T/home" DOCKER_SELECTION_MARKER="$T/docker-called" bash "$ROOT/scripts/start.sh" > "$T/output" 2>&1 </dev/null; then
      echo 'FAIL: missing selection accepted'; exit 1
    fi
  else
    if env SINGULARITY_VARIANT="$option" PATH="$T/bin:$PATH" HOME="$T/home" DOCKER_SELECTION_MARKER="$T/docker-called" bash "$ROOT/scripts/start.sh" > "$T/output" 2>&1 </dev/null; then
      echo 'FAIL: unsupported selection accepted'; exit 1
    fi
  fi
  grep -q 'No changes were made' "$T/output"
  test ! -e "$T/docker-called" || { echo 'FAIL: Docker called before option validation'; exit 1; }
done
echo 'START SELECTION OK — five invalid/missing selections stop before Docker'
