#!/bin/bash
# lib/rate-reserve.sh — V3.3.35 D11 (ticket 085): ONE atomic cross-process
# rate/circuit reservation on the limit host. Replaces the bridge's separate
# pace_wait / pace_anchor / bump_429 read-modify-write round-trips, which two
# concurrent bridges could interleave (both read last=N, both anchor N+gap —
# the shared 10 s gap silently collapses).
#
# Contract: `rate-reserve.sh reserve <rate_file> <circuit_file> <min_gap> <window>`
#   - Takes an exclusive flock on "<circuit_file>.lock" (created next to the
#     circuit state so the lock lands on the same shared limit host).
#   - Inside the lock, atomically: reads the last-call anchor, computes the
#     remaining wait, anchors NOW as this caller's reservation, checks/decays
#     the 429 circuit, and prints ONE line:
#       "0 <wait>"                     — reserved, caller sleeps <wait> s
#       "1 <n>"                        — circuit OPEN (n recent 429s); NO
#                                        anchor written (caller must fail
#                                        fast rc45 and NOT touch the account)
#   - Any internal error prints "2 <msg>" and exits nonzero: callers treat
#     that as reservation-unavailable and FAIL SAFE (bridge policy: without a
#     reservation the call does not proceed).
#
# `rate-reserve.sh record429 <circuit_file> <window>` bumps the circuit under
# the same flock and prints the new count.
# `rate-reserve.sh release <rate_file>` is a no-op hook (anchor is the
# reservation itself — a crashed caller leaves a slightly-early anchor, which
# only ever widens the effective gap; it can never shrink it).
set -u
cmd="${1:-}"; shift || true
case "$cmd" in
  reserve)
    rf="$1"; cf="$2"; gap="$3"; win="$4"
    lock="${cf}.lock"
    exec 9>>"$lock" || { echo "2 lock-open-failed"; exit 1; }
    flock -w 30 9 || { echo "2 lock-timeout"; exit 1; }
    now=$(date +%s)
    # circuit check + decay (inside lock)
    ts=0; n=0
    if [ -f "$cf" ]; then read -r ts n < "$cf" 2>/dev/null || { ts=0; n=0; }; fi
    if [ $(( now - ts )) -ge "$win" ]; then n=0; fi
    if [ "${n:-0}" -ge 3 ]; then echo "1 $n"; exit 0; fi
    # rate anchor read-modify-write (inside the SAME lock — atomic)
    last=0
    if [ -f "$rf" ]; then read -r last < "$rf" 2>/dev/null || last=0; fi
    case "$last" in (*[!0-9]*|"") last=0 ;; esac
    wait=$(( last + gap - now )); [ "$wait" -lt 0 ] && wait=0
    echo "$now" > "$rf" 2>/dev/null || { echo "2 anchor-write-failed"; exit 1; }
    echo "0 $wait"
    exit 0 ;;
  record429)
    cf="$1"; win="$2"
    lock="${cf}.lock"
    exec 9>>"$lock" || { echo "2 lock-open-failed"; exit 1; }
    flock -w 30 9 || { echo "2 lock-timeout"; exit 1; }
    now=$(date +%s)
    ts=0; n=0
    if [ -f "$cf" ]; then read -r ts n < "$cf" 2>/dev/null || { ts=0; n=0; }; fi
    if [ $(( now - ts )) -ge "$win" ]; then n=0; fi
    n=$(( ${n:-0} + 1 ))
    echo "$now $n" > "$cf" 2>/dev/null || { echo "2 circuit-write-failed"; exit 1; }
    echo "$n"
    exit 0 ;;
  release)
    # reservation = anchor; nothing to undo. Present so the bridge's cleanup
    # path can call it unconditionally.
    exit 0 ;;
  *)
    echo "2 usage: rate-reserve.sh reserve|record429|release ..."; exit 1 ;;
esac
