#!/usr/bin/env bash
# tests/memory-port-boundary.test.sh — stubbed-docker tests of the memory port
# boundary tool (§4.4): wildcard-intent detection for running AND stopped
# containers, refusal on wide bindings before start, enforcement that stops
# ONLY containers created by the current run, and pass-through for
# loopback-only deployments. Run: tests/memory-port-boundary.test.sh
set -u
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
BOUNDARY="$ROOT/scripts/memory-port-boundary.sh"

pass=0; fail=0
ok()  { pass=$((pass + 1)); echo "ok    - $1"; }
bad() { fail=$((fail + 1)); echo "NOT OK - $1"; }
assert_rc() { if [[ "$1" == "$2" ]]; then ok "$3 (rc=$2)"; else bad "$3 (want rc=$1, got rc=$2)"; fi; }
have_line() { if grep -qF -- "$2" "$1"; then ok "$3"; else bad "$3 — missing expected line: $2"; fi; }
no_line()   { if grep -qF -- "$2" "$1"; then bad "$3 — unexpected line: $2"; else ok "$3"; fi; }

# ---- docker stub -------------------------------------------------------------
# make_stub_dir <scenario> <stop-log>  → prints the stub dir (put on PATH).
# Scenarios:
#   clean        tdai-ok1, tdai-ok2 RUNNING, loopback-only ports
#   running-wide tdai-mcore RUNNING 0.0.0.0-wide; tdai-mok2 RUNNING loopback
#   stopped-wide tdai-old STOPPED with "" HostIp in PortBindings (wildcard intent)
#   enforce-wide tdai-new (wide, created after baseline) + tdai-pre (wide, pre-existing)
make_stub_dir() {
  local scenario="$1" log="$2" dir stub
  dir="$(mktemp -d "${TMPDIR:-/tmp}/boundary-stub.XXXXXX")"
  stub="$dir/docker"
  cat > "$stub" <<EOF
#!/usr/bin/env bash
SCENARIO="$scenario"
LOG="$log"
if [[ "\$2 \$3" == "-a --format" ]]; then
  case "\$SCENARIO" in
    clean)        printf 'tdai-ok1\ntdai-ok2\n' ;;
    running-wide) printf 'tdai-mcore\ntdai-mok2\n' ;;
    stopped-wide) echo 'tdai-old' ;;
    enforce-wide) printf 'tdai-new\ntdai-pre\n' ;;
  esac
  exit 0
fi
case "\$1 \$2" in
  "port tdai-mcore") echo '8420/tcp -> 0.0.0.0:8420'; exit 0 ;;
  "port tdai-mok2")  echo '8420/tcp -> 127.0.0.1:8420'; exit 0 ;;
  "port tdai-new")   echo '8096/tcp -> [::]:8096'; exit 0 ;;
  "port tdai-pre")   echo '8125/tcp -> 0.0.0.0:8125'; exit 0 ;;
  "port "*)          exit 0 ;;
esac
if [[ "\$1" == "stop" ]]; then echo "\$2" >> "\$LOG"; exit 0; fi
if [[ "\$1" == "inspect" ]]; then
  name="\$4"; fmt="\$3"
  case "\$fmt" in
    *State.Running*) case "\$name" in
        tdai-old) echo "false" ;;
        *) echo "true" ;;
      esac ;;
    *PortBindings*) if [[ "\$name" == "tdai-old" ]]; then
        echo '{"8420/tcp":[{"HostIp":"","HostPort":"8420"}]}'
      else
        echo '{}'
      fi ;;
  esac
  exit 0
fi
exit 0
EOF
  chmod +x "$stub"
  printf '%s\n' "$dir"
}

TMPLOG="$PWD/.docker-stop-log"

# --check on a loopback-only deployment passes.
d="$(make_stub_dir clean "$TMPLOG")"
out="$(PATH="$d:$PATH" "$BOUNDARY" --check 2>&1)"; rc=$?
assert_rc 0 "$rc" "--check passes with loopback-only bindings"
rm -rf "$d"

# --check refuses a RUNNING container publishing the wildcard.
d="$(make_stub_dir running-wide "$TMPLOG")"
out="$(PATH="$d:$PATH" "$BOUNDARY" --check 2>&1)"; rc=$?
assert_rc 1 "$rc" "--check refuses a running wide binding"
have_line <(echo "$out") "tdai-mcore:8420/tcp -> 0.0.0.0:8420" "offender reported with its binding"
rm -rf "$d"

# --check refuses a STOPPED container that would re-expose ports on start.
d="$(make_stub_dir stopped-wide "$TMPLOG")"
out="$(PATH="$d:$PATH" "$BOUNDARY" --check 2>&1)"; rc=$?
assert_rc 1 "$rc" "--check refuses a stopped container with wildcard publishing intent"
have_line <(echo "$out") "tdai-old:stopped-binding" "stopped wildcard intent reported"
rm -rf "$d"

# --enforce stops only containers created after the baseline.
# All scratch state lives in THIS case's own dir (never $PWD): stop log,
# baseline and stub share one tree so unrelated cwd/permissions can never
# influence the case, and tool stderr is retained for failure diagnostics.
ECASE="/tmp/boundary-enforce-$$"
mkdir -p "$ECASE"
: > "$ECASE/stops.log"
d="$(make_stub_dir enforce-wide "$ECASE/stops.log")"
printf 'tdai-old\ntdai-pre\n' > "$ECASE/baseline"
err="$(PATH="$d:$PATH" "$BOUNDARY" --enforce "$ECASE/baseline" 2>&1)"; rc=$?
assert_rc 1 "$rc" "--enforce reports when it had to stop something"
have_line "$ECASE/stops.log" "tdai-new" "the newly created wide container was stopped"
no_line "$ECASE/stops.log" "tdai-pre" "the pre-existing wide container was NOT touched"
no_line "$ECASE/stops.log" "tdai-old" "unrelated pre-existing container NOT touched"
if [[ "$fail" -ne 0 || "$rc" != 1 ]]; then
  echo "diagnostics: tool stderr: $err" >&2
  echo "diagnostics: stub: $(cat "$d/docker")" >&2
fi
rm -rf "$d" "$ECASE"

echo "pass=$pass failures=$fail"
[[ "$fail" -eq 0 ]] || exit 1
exit 0
