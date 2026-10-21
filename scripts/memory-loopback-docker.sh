#!/usr/bin/env bash
# Scoped `docker` CLI shim for the Singularity memory stack startup only.
#
# WHY: the vendored Tencent quickstart (memory/upstream/*.sh) creates its
# containers with wildcard host publishing (e.g. `-p "${MEMORY_CORE_PORT}:8420"`),
# which Docker binds on 0.0.0.0 AND :: — every host interface. A fresh
# installation must not expose MemoryCore/panel/knowledge/proxy to the network
# as a side effect of startup: the loopback boundary has to hold at
# container-CREATION time, not merely be detected and undone afterwards.
#
# HOW: the upstream _lib.sh resolves the Docker CLI with find_docker(), which
# picks the first `docker` on PATH. start-memory-stack.sh therefore puts this
# shim — under the name `docker` — at the FRONT of PATH for the upstream
# startup invocation ONLY:
#   - the host's global Docker CLI is never replaced;
#   - interception is scoped to this one startup operation;
#   - the byte-exact vendored sources are untouched (PROVENANCE.md stays true).
#
# BEHAVIOUR
#   docker run ...
#     Every -p/--publish value whose HOST side is wildcard or empty is
#     re-bound to the loopback host before the real docker sees it:
#         8420:8420         → 127.0.0.1:8420:8420
#         8420:8420/udp     → 127.0.0.1:8420:8420/udp
#         8420              → 127.0.0.1::8420   (container-only publish)
#         0.0.0.0:8420:8420 / [::]:8420:8420 / ::8420:8420 → 127.0.0.1:8420:8420
#     Port ranges and protocols are preserved. An EXPLICIT non-wildcard host
#     IP (loopback or a deliberate interface address) passes through
#     untouched, as does every non-run subcommand (ps, inspect, logs, rm,
#     pull, network, port, stop, ...).
#     -P / --publish-all is refused before docker runs: it publishes wildcard
#     host bindings that no later step can narrow.
#
# ESCAPE HATCH: SINGULARITY_ALLOW_WIDE_MEMORY_PORTS=1 makes the shim pass
# every binding through unchanged (the caller owns that policy decision —
# see scripts/start-memory-stack.sh).
# Loopback host override: SINGULARITY_MEMORY_LOOPBACK_HOST (default 127.0.0.1).
#
# TESTABILITY: `--rewrite-spec <spec>` prints the rewritten publish spec and
# exits; tests/memory-loopback-docker.test.sh exercises that mode plus the
# full shim behavior against a stubbed real docker.
set -euo pipefail

LOOPBACK_HOST="${SINGULARITY_MEMORY_LOOPBACK_HOST:-127.0.0.1}"
ALLOW_WIDE="${SINGULARITY_ALLOW_WIDE_MEMORY_PORTS:-0}"
SHIM_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
SELF_PATH="$(readlink -f "${BASH_SOURCE[0]}" 2>/dev/null || printf '%s' "${BASH_SOURCE[0]}")"
SHIM_MARKER='Scoped `docker` CLI shim for the Singularity memory stack startup only.'

# Rewrite ONE publish spec iff its HOST side is wildcard/empty; otherwise pass
# it through verbatim.
rewrite_spec() {
  local spec="$1" host rest

  # Escape hatch: policy decided by the caller — pass everything through.
  if [[ "$ALLOW_WIDE" == "1" ]]; then printf '%s\n' "$spec"; return 0; fi

  case "$spec" in
    *:*) : ;;
    *)
      # No host side at all ("8420"): Docker publishes an ephemeral host port
      # on the wildcard. Pin the HOST side to loopback, keep an ephemeral port.
      printf '%s::%s\n' "$LOOPBACK_HOST" "$spec"; return 0 ;;
  esac

  # Bracketed IPv6 host: "[::]:8420:8420" or "[::1]:8420:8420".
  if [[ "$spec" == \[*\]*:* ]]; then
    host="${spec%%]*}]"
    rest="${spec#*]}"
    if [[ "$host" == "[::]" || "$host" == "[::0]" ]]; then
      printf '%s:%s\n' "$LOOPBACK_HOST" "${rest#:}"; return 0
    fi
    printf '%s\n' "$spec"; return 0   # explicit IPv6 host: deliberate, keep
  fi

  # Unbracketed ::-host form "::8420:8420" (unspecified IPv6 host).
  if [[ "$spec" == ::*:* ]]; then
    rest="${spec#::}"
    printf '%s:%s\n' "$LOOPBACK_HOST" "$rest"; return 0
  fi

  host="${spec%%:*}"
  rest="${spec#*:}"
  if [[ -z "$host" || "$host" == "0.0.0.0" || "$host" == "::" || "$host" == "::0" ]]; then
    # Explicit wildcard host side ("0.0.0.0:8420:8420", ":8420"): re-bind the
    # host side, keep the rest of the mapping intact.
    printf '%s:%s\n' "$LOOPBACK_HOST" "$rest"; return 0
  fi
  if [[ "$host" =~ ^[0-9]+(-[0-9]+)?$ ]]; then
    # Two-field spec ("8420:8420", "8300-8310:8300-8310") = implicit wildcard
    # host side: prepend the loopback host, keep both port fields.
    printf '%s:%s\n' "$LOOPBACK_HOST" "$spec"; return 0
  fi
  # Any other host side (loopback or an explicit interface address) is a
  # deliberate choice — keep it, unchanged.
  printf '%s\n' "$spec"
  return 0
}

if [[ "${1:-}" == "--rewrite-spec" ]]; then
  if [[ $# -ne 2 ]]; then
    echo "usage: ${0##*/} --rewrite-spec <publish-spec>" >&2
    exit 2
  fi
  rewrite_spec "$2"
  exit 0
fi

# Resolve the real docker CLI from PATH, excluding this shim's own directory
# and any entry that IS this shim (a copy or a symlink into it), so the shim
# can never exec itself regardless of how the caller places it on PATH.
real_docker() {
  local p candidate resolved
  local IFS=':'
  for p in ${PATH-set}; do
    p="${p:-.}"
    [[ "$p" == "$SHIM_DIR" ]] && continue
    candidate="$p/docker"
    [[ -x "$candidate" ]] || continue
    if [[ -L "$candidate" ]]; then
      resolved="$(readlink -f "$candidate" 2>/dev/null || true)"
      # Never resolve back into the shim directory or onto the shim itself.
      [[ "$resolved" == "$SHIM_DIR"/ || "$resolved" == "$SHIM_DIR" || "$resolved" == "$SELF_PATH" || -z "$resolved" ]] && continue
    elif [[ "$(readlink -f "$candidate" 2>/dev/null || true)" == "$SELF_PATH" ]]; then
      continue
    fi
    # Content identity check: any other copy of THIS shim on PATH (the caller
    # may have shim dirs and copies coexisting) is not a real CLI. Without this
    # check two copies can exec each other forever.
    if head -c 8192 "$candidate" 2>/dev/null | grep -qF -- "$SHIM_MARKER"; then
      continue
    fi
    unset IFS
    printf '%s\n' "$candidate"
    return 0
  done
  unset IFS
  echo "FAILED: loopback docker shim cannot find a real docker CLI on PATH." >&2
  return 127
}

# ---- walk global flags until the docker subcommand -------------------------
# Global flags that take a SEPARATE value are kept together; every other
# dash-argument is skipped as another global flag token.
declare -a pre=()
subcmd=""
while (( $# > 0 )); do
  case "$1" in
    -H|--host|--config|--context|-l|--log-level|--log-driver|-e|--exec-opt)
      pre+=("$1" "$2"); shift 2 ;;
    -H*|--host*|--config*|--context*)
      pre+=("$1"); shift ;;
    -*)
      pre+=("$1"); shift ;;
    *)
      subcmd="$1"; shift
      break ;;
  esac
done
if [[ -z "$subcmd" ]]; then
  REAL="$(real_docker)" || exit $?
  exec "$REAL" "${pre[@]}"
fi

# ---- reshape ONLY `docker run` publish arguments ----------------------------
if [[ "$subcmd" == "run" && "$ALLOW_WIDE" != "1" ]]; then
  declare -a out=()
  out+=("run")
  while (( $# > 0 )); do
    case "$1" in
      -p|--publish)
        if (( $# < 2 )); then
          echo "FAILED: docker run: $1 without a value — the loopback shim cannot verify that binding." >&2
          exit 64
        fi
        out+=("$1" "$(rewrite_spec "$2")")
        shift 2 ;;
      -p*)
        out+=("-p" "$(rewrite_spec "${1#-p}")")
        shift ;;
      --publish=*)
        out+=("--publish=$(rewrite_spec "${1#*=}")")
        shift ;;
      --publish)
        if (( $# < 2 )); then
          echo "FAILED: docker run: --publish without a value — the loopback shim cannot verify that binding." >&2
          exit 64
        fi
        out+=("--publish" "$(rewrite_spec "$2")")
        shift 2 ;;
      -P|--publish-all)
        echo "FAILED: docker run: -P/--publish-all publishes wildcard host bindings the loopback shim cannot narrow. Spell the mappings explicitly or set SINGULARITY_ALLOW_WIDE_MEMORY_PORTS=1." >&2
        exit 64 ;;
      *)
        out+=("$1")
        shift ;;
    esac
  done
  REAL="$(real_docker)" || exit $?
  exec "$REAL" "${pre[@]}" "${out[@]}"
fi

# Anything else: hand everything through, unchanged.
REAL="$(real_docker)" || exit $?
exec "$REAL" "${pre[@]}" "$subcmd" "$@"
