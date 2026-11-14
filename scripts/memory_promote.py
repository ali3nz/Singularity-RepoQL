#!/usr/bin/env python3
"""Cursor-based bounded promotion review over the memory store (zero model calls).

One authenticated POST /v3/conversation/query per run; prints at most 12
compact candidates within a 4000-char combined-excerpt budget. The reviewing
agent reads at most 2 records in full and submits through the existing gated
surfaces only:

  scripts/knowledge-promotion.py --propose / --promote   (operator truths)
  rql concept add                                        (workspace concepts)

The request authenticates exactly like scripts/knowledge-promotion.py: the
memory.json secrets (env MEMORY_SECRETS, default
data/opencode/config/product-secrets/memory.json) supply the Authorization
prefix+gatewayKey header and the x-tdai-service-id / x-tdai-user-key headers.

Concept promotions are recorded with `--promoted <id...> [--name <Name>]` and
are bounded: at most 3 per rolling 24h per workspace, and the same normalized
concept name may only be promoted once every 7 days.

Unresolved reviews and deferrals persist across scans: --advance-ts refuses
to move past an unresolved record's place in the stream until it is marked
resolved. Nothing is silently dropped from the review ledger. The memory plugin
remains the only automatic capture writer. Helpers assume a single agent
instance per workspace; state files under data/selflearn/ are plain
read-modify-write JSON and are not locked.

Response shapes vary across deployments: run `--probe` first on a fresh
install and check the raw page before trusting the default parser. Scopes can
be overridden with --team/--user/--agent or the MEMORY_SCOPE_* environment
variables (the capture side records under a per-project team id; the value is
visible in the plugin's on-save recall message, "[product-memory] Recalled
project memory (scope <team_id>:"); see docs/MEMORY-SETUP.md).
"""
import argparse
import calendar
import json
import os
import pathlib
import subprocess
import sys
import time
import urllib.error
import urllib.request

MAX_CANDIDATES = 12
MAX_CHARS = 4000
DAY = 24 * 3600
CONCEPTS_PER_24H = 3
REPEAT_CONCEPT_DAYS = 7
DEFAULT_SECRETS = "data/opencode/config/product-secrets/memory.json"


def base_url():
    return os.environ.get("MEMORY_CORE_BASE_URL", "http://127.0.0.1:8420").rstrip("/")


def auth_headers():
    """Authorization headers identical to scripts/knowledge-promotion.py."""
    secrets = pathlib.Path(os.environ.get("MEMORY_SECRETS", DEFAULT_SECRETS))
    if not secrets.is_file():
        print(
            "no memory.json secrets at", secrets,
            "- provision them or point MEMORY_SECRETS at the file first",
        )
        sys.exit(7)
    try:
        cfg = json.loads(secrets.read_text(encoding="utf-8"))
        return {
            "Authorization": cfg["authPrefix"] + cfg["gatewayKey"],
            "x-tdai-service-id": cfg["serviceId"],
            "x-tdai-user-key": cfg["userKey"],
        }
    except (KeyError, ValueError) as exc:
        print("memory.json at", secrets, "is missing keys or invalid:", exc)
        sys.exit(7)


def search(base, scope, limit):
    """One bounded probe query for the promotion scanner.

    Uses POST /v3/conversation/query (paginated listing). Do NOT use
    /v3/conversation/search here: that endpoint requires a `query` field and
    returns 400 without one, and this scanner must not depend on free-text
    search to discover candidates.
    """
    body = json.dumps(
        {
            # Strict isolation: /v3 requires team/user/agent on every call.
            "team_id": scope["team_id"],
            "user_id": scope["user_id"],
            "agent_id": scope["agent_id"],
            "offset": 0,
            "limit": max(limit, 1),
        }
    ).encode("utf-8")
    headers = {"Content-Type": "application/json"}
    headers.update(auth_headers())
    req = urllib.request.Request(
        base + "/v3/conversation/query",
        data=body,
        headers=headers,
        method="POST",
    )
    try:
        with urllib.request.urlopen(req, timeout=30) as resp:
            return json.loads(resp.read().decode("utf-8"))
    except urllib.error.HTTPError as exc:
        print("query failed:", exc.code, exc.reason, "- check scopes/auth (--probe re-runs)")
        sys.exit(7)
    except urllib.error.URLError as exc:
        print("query unreachable:", exc.reason, "- is the memory core at", base, "?")
        sys.exit(7)


def compact_records(doc):
    """Normalize a memory-store response page into compact candidate rows.

    The documented shape is {code, data: {messages: [...]}}; deployments vary,
    so list- and flat-key fallbacks stay. Records missing an id, timestamp or
    text are skipped rather than guessed.
    """
    rows = []
    if isinstance(doc, dict):
        if isinstance(doc.get("data"), dict) and isinstance(doc["data"].get("messages"), list):
            rows = doc["data"]["messages"]
        elif isinstance(doc.get("data"), list):
            rows = doc["data"]
        else:
            for key in ("records", "results", "conversations", "messages", "units"):
                if isinstance(doc.get(key), list):
                    rows = doc[key]
                    break
    elif isinstance(doc, list):
        rows = doc
    out = []
    for row in rows:
        if not isinstance(row, dict):
            continue
        rid = str(
            row.get("id")
            or row.get("record_id")
            or row.get("unit_id")
            or row.get("uuid")
            or ""
        )
        ts = row.get("created_at") or row.get("ts") or row.get("timestamp") or 0
        if isinstance(ts, str):
            try:
                ts = int(calendar.timegm(time.strptime(ts[:19], "%Y-%m-%dT%H:%M:%S")))
            except Exception:
                ts = 0
        text = row.get("summary") or row.get("content") or row.get("text") or ""
        out.append({"id": rid, "ts": int(ts or 0), "excerpt": str(text)[:300]})
    return out


def load_cursor(path):
    if not path.exists():
        return {"afterTs": 0, "doneIds": [], "deferred": {}, "promotions": {}}
    try:
        loaded = json.loads(path.read_text(encoding="utf-8"))
        if isinstance(loaded.get("promotions"), list):
            loaded["promotions"] = {}
        return loaded
    except Exception as exc:
        print("cursor state error in", path, ":", exc)
        sys.exit(6)


def save_cursor(path, cur):
    """Replace cursor atomically so interruption cannot erase review history.

    The helper remains single-writer, matching the existing agent contract.
    A same-directory temporary file ensures os.replace stays on one volume.
    """
    path.parent.mkdir(parents=True, exist_ok=True)
    temp = path.with_name(f".{path.name}.tmp")
    try:
        with open(temp, "w", encoding="utf-8") as stream:
            stream.write(json.dumps(cur, indent=2) + "\n")
            stream.flush()
            os.fsync(stream.fileno())
        os.replace(temp, path)
    finally:
        if temp.exists():
            temp.unlink()


def window_promotions(cur):
    cut = time.time() - DAY
    return [p for p in cur.get("promotions", {}).values() if p.get("ts", 0) >= cut]


def concept_repeat(cur, name):
    if not name:
        return None
    prior = cur.get("promotions", {}).get(name)
    if prior and (time.time() - prior.get("ts", 0)) < REPEAT_CONCEPT_DAYS * DAY:
        return prior
    return None



class PromotionPolicyError(RuntimeError):
    """A selected native decision was unavailable or contradicted the owner."""


def _native_checked(command, request, reference):
    """Optional Rust parity gate. Never sends secrets, URLs or excerpts to Rust.

    This is not an authorization API. The existing Python logic owns the
    answer, and a native mismatch aborts before any cursor/state write.
    """
    binary = os.environ.get("SINGULARITY_RUST_MEMORY_POLICY_BIN", "")
    if not binary:
        return reference
    candidate = pathlib.Path(binary)
    if not candidate.is_absolute() or not candidate.is_file() or candidate.is_symlink():
        raise PromotionPolicyError("native promotion policy binary is not an existing absolute regular file")
    payload = json.dumps(request, ensure_ascii=False, separators=(",", ":"))
    if len(payload.encode("utf-8")) > 256 * 1024:
        raise PromotionPolicyError("native promotion policy request exceeds input budget")
    try:
        result = subprocess.run([str(candidate), command], input=payload,
                                text=True, capture_output=True, timeout=3.5,
                                check=False, encoding="utf-8")
    except (OSError, subprocess.TimeoutExpired) as exc:
        raise PromotionPolicyError("native promotion policy executable failed") from exc
    if result.returncode or len(result.stdout.encode("utf-8")) > 1024 * 1024:
        raise PromotionPolicyError("native promotion policy rejected the request")
    try:
        actual = json.loads(result.stdout)
    except (ValueError, UnicodeError) as exc:
        raise PromotionPolicyError("native promotion policy response was invalid") from exc
    if actual != reference:
        raise PromotionPolicyError("native promotion policy result diverged from Python; no state written")
    return actual


def select_shortlist(records, cursor):
    """Deterministic bounded selection, preserving source record order.

    Rust sees only record IDs, timestamps and excerpt lengths. The source
    text and authenticated MemoryCore response stay in this process.
    """
    after = int(cursor.get("afterTs", 0))
    done = set(cursor.get("doneIds", []))
    indices = []
    budget = MAX_CHARS
    for idx, rec in enumerate(records):
        # Undated, unidentifiable or empty entries cannot safely participate
        # in a timestamp cursor. Preserve the source page for --probe.
        if not rec["id"] or rec["ts"] <= 0 or not rec["excerpt"].strip():
            continue
        if rec["id"] in done:
            continue
        if rec["ts"] and rec["ts"] <= after:
            continue
        need = len(rec["excerpt"]) + 8
        if need > budget or len(indices) >= MAX_CANDIDATES:
            break
        indices.append(idx)
        budget -= need
    return {"ok": True, "indices": indices,
            "newestTs": max((records[i]["ts"] for i in indices), default=0)}


def guarded_shortlist(records, cursor):
    expected = select_shortlist(records, cursor)
    request = {
        "records": [{"id": row["id"], "ts": row["ts"],
                     "excerptLen": len(row["excerpt"]), "hasText": bool(row["excerpt"].strip())}
                    for row in records],
        "doneIds": cursor.get("doneIds", []), "afterTs": int(cursor.get("afterTs", 0)),
    }
    selected = _native_checked("promotion-shortlist", request, expected)
    return [records[i] for i in selected["indices"]]


def advance_decision(cursor, requested):
    """Refuse cursor movement that would hide unresolved or deferred records.

    A caller cannot skip beyond the last actually presented shortlist. An
    absent shortlist cannot authorize forward movement. The cursor cannot
    move backwards and historical resolved entries do not block it.
    """
    after = int(cursor.get("afterTs", 0))
    target = int(requested)
    if target <= after:
        return {"ok": True, "allowed": True, "code": "NOOP", "blocked": [], "afterTs": after}
    shortlist = cursor.get("pendingReview", cursor.get("lastShortlist", {}))
    if not shortlist:
        return {"ok": True, "allowed": False, "code": "NO_SHORTLIST", "blocked": [], "afterTs": after}
    known = [int(v.get("ts") or 0) for v in shortlist.values()]
    presented = int(cursor.get("maxPresentedTs", max(known, default=0)))
    if target > presented:
        return {"ok": True, "allowed": False, "code": "BEYOND_SHORTLIST", "blocked": [], "afterTs": after}
    done = set(cursor.get("doneIds", []))
    deferred = cursor.get("deferred", {})
    blocked = set()
    for rid, rec in shortlist.items():
        ts = int(rec.get("ts") or 0)
        if ts <= target and rid not in done:
            blocked.add(rid)
    for rid, rec in deferred.items():
        ts = int(rec.get("rec_ts") or 0)
        if ts and ts <= target:
            blocked.add(rid)
    if blocked:
        return {"ok": True, "allowed": False, "code": "UNRESOLVED", "blocked": sorted(blocked), "afterTs": after}
    return {"ok": True, "allowed": True, "code": "ADVANCE", "blocked": [], "afterTs": target}


def guarded_advance(cursor, requested):
    expected = advance_decision(cursor, requested)
    request = {
        "afterTs": int(cursor.get("afterTs", 0)), "advanceTs": int(requested),
        "maxPresentedTs": int(cursor.get("maxPresentedTs", max((int(v.get("ts") or 0) for v in cursor.get("lastShortlist", {}).values()), default=0))),
        "pendingReview": [{"id": rid, "ts": int(v.get("ts") or 0)}
                          for rid, v in sorted(cursor.get("pendingReview", cursor.get("lastShortlist", {})).items())],
        "doneIds": cursor.get("doneIds", []),
        "deferred": [{"id": rid, "recTs": int(v.get("rec_ts") or 0)}
                     for rid, v in sorted(cursor.get("deferred", {}).items())],
    }
    return _native_checked("promotion-advance", request, expected)


def eligible_promotion(cursor, name, now):
    promotions = cursor.get("promotions", {})
    recent = [int(p.get("ts", 0)) for p in promotions.values()
              if int(p.get("ts", 0)) >= now - DAY]
    prior = promotions.get(name) if name else None
    duplicate = bool(prior and now - int(prior.get("ts", 0)) < REPEAT_CONCEPT_DAYS * DAY)
    return {"ok": True, "allowed": len(recent) < CONCEPTS_PER_24H and not duplicate,
            "code": "CAP_REACHED" if len(recent) >= CONCEPTS_PER_24H else
                    "REPEAT_CONCEPT" if duplicate else "ELIGIBLE",
            "recentCount": len(recent)}


def guarded_promotion_eligibility(cursor, name, now):
    expected = eligible_promotion(cursor, name, now)
    promotions = cursor.get("promotions", {})
    request = {
        "nowTs": int(now), "recentTs": [int(p.get("ts", 0)) for p in promotions.values()],
        "priorTs": int(promotions[name].get("ts", 0)) if name and name in promotions else None,
    }
    return _native_checked("promotion-eligibility", request, expected)

def main():
    ap = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    ap.add_argument("--team", default=os.environ.get("MEMORY_SCOPE_TEAM", "knowledge"))
    ap.add_argument("--user", default=os.environ.get("MEMORY_SCOPE_USER", "operator"))
    ap.add_argument("--agent", default=os.environ.get("MEMORY_SCOPE_AGENT", "knowledge-promotion"))
    ap.add_argument("--state-dir", default="data/selflearn")
    ap.add_argument(
        "--probe", action="store_true",
        help="print the raw first query page and exit (schema reconnaissance)",
    )
    ap.add_argument("--mark-done", nargs="*", default=[], help="record ids as resolved")
    ap.add_argument("--defer", nargs="*", default=[], help="record ids as kept for later")
    ap.add_argument("--defer-reason", default="review kept it for a later window")
    ap.add_argument(
        "--promoted", nargs="*", default=[],
        help="record that a concept promotion involving these record ids succeeded",
    )
    ap.add_argument(
        "--name", default="",
        help="normalized CamelCase concept name for --promoted (enables the 7-day duplicate rule)",
    )
    ap.add_argument(
        "--advance-ts", type=int, default=None,
        help="move afterTs past the newest shortlisted record (only once every id was resolved)",
    )
    args = ap.parse_args()

    state_dir = pathlib.Path(args.state_dir)
    state_dir.mkdir(parents=True, exist_ok=True)
    cursor_path = state_dir / "promotion-cursor.json"
    cur = load_cursor(cursor_path)

    shortlist = cur.get("lastShortlist", {})

    if args.promoted:
        now = int(time.time())
        eligibility = guarded_promotion_eligibility(cur, args.name, now)
        wins = window_promotions(cur)
        if eligibility["code"] == "CAP_REACHED":
            print(
                "DEFERRED: concept cap reached ("
                + str(len(wins)) + "/" + str(CONCEPTS_PER_24H)
                + " in the last 24h) - submit this concept in a later window"
            )
            sys.exit(5)
        if eligibility["code"] == "REPEAT_CONCEPT":
            print(
                "REFUSED: concept", args.name, "was promoted within the last",
                str(REPEAT_CONCEPT_DAYS), "days; find a new durable lesson instead",
            )
            sys.exit(6)
        entry = {"ts": now, "name": args.name or None, "ids": args.promoted}
        if args.name:
            cur.setdefault("promotions", {})[args.name] = entry
        else:
            cur.setdefault("promotions", {})["ts:" + str(now) + ":" + str(abs(hash(tuple(args.promoted))) % 10**8)] = entry
        cur["promotions"] = dict(
            sorted(cur["promotions"].items(), key=lambda kv: kv[1].get("ts", 0))[-100:]
        )
        save_cursor(cursor_path, cur)
        print("RECORDED promotion", args.name or "(unnamed)", "ids", args.promoted)
        print("promotions last 24h:", len(window_promotions(cur)), "/", CONCEPTS_PER_24H, "concepts per workspace")
        sys.exit(0)

    if args.mark_done or args.defer or args.advance_ts is not None:
        for rid in args.mark_done:
            cur.setdefault("doneIds", []).append(rid)
            cur.get("deferred", {}).pop(rid, None)
        cur["doneIds"] = cur["doneIds"][-200:]
        for rid in args.defer:
            seen = shortlist.get(rid, {})
            cur.setdefault("deferred", {})[rid] = {
                "ts": int(time.time()),
                "rec_ts": int(seen.get("ts") or 0),
                "reason": args.defer_reason,
            }
        if args.advance_ts is not None:
            verdict = guarded_advance(cur, args.advance_ts)
            if not verdict["allowed"]:
                print("ADVANCE BLOCKED:", verdict["code"],
                      ", ".join(verdict["blocked"]) or "no resolved eligible shortlist")
                print("deferred kept:", len(cur.get("deferred", {})), "(defer, never discard)")
                sys.exit(5)
            cur["afterTs"] = verdict["afterTs"]
            # Prune only entries at/below a verified advanced cursor. Any
            # deferred record blocks advance, so unresolved reviews survive.
            cur["pendingReview"] = {
                rid: entry for rid, entry in cur.get("pendingReview", cur.get("lastShortlist", {})).items()
                if int(entry.get("ts") or 0) > cur["afterTs"]
            }
        save_cursor(cursor_path, cur)
        print("STATE SAVED: done", len(args.mark_done), "deferred", len(args.defer), "afterTs", cur["afterTs"])
        print("promotions in last 24h:", len(window_promotions(cur)), "(cap: <=3 concepts per workspace)")
        sys.exit(0)

    scope = {"team_id": args.team, "user_id": args.user, "agent_id": args.agent}
    doc = search(base_url(), scope, MAX_CANDIDATES + 8)
    if args.probe:
        print("RAW FIRST PAGE (verify shapes before trusting the default parser):")
        print(json.dumps(doc, indent=2)[:4000])
        sys.exit(0)

    after = int(cur.get("afterTs", 0))
    records = compact_records(doc)
    candidates = guarded_shortlist(records, cur)
    if not candidates:
        pending_count = len(cur.get("pendingReview", cur.get("lastShortlist", {})))
        print(
            "NO NEW CANDIDATES (cursor afterTs:",
            after,
            "; deferred still kept:",
            len(cur.get("deferred", {})),
            "; review ledger entries:", pending_count,
            ")",
        )
        print("No new candidates shown. Resolve retained reviews before advancing the cursor.")
        sys.exit(0)

    newest = max(c["ts"] for c in candidates)
    print("SHORTLIST (" + str(len(candidates)) + " of <=12 within 4000 chars; review AT MOST 2 in full):")
    for i, c in enumerate(candidates, 1):
        when = time.strftime("%m-%dT%H:%M", time.gmtime(c["ts"])) if c["ts"] else "no-ts"
        print(" [" + str(i) + "]", "id", c["id"] or "(no id)", "ts", when)
        print("      ", c["excerpt"].replace("\n", " ")[:280])
    if candidates:
        latest = {c["id"]: {"ts": c["ts"]} for c in candidates if c["id"]}
        pending = dict(cur.get("pendingReview", cur.get("lastShortlist", {})))
        # Track even eligible rows hidden by this run's 12-row / 4k budget.
        # Otherwise advancing after a short page can discard unreviewed rows
        # that happened to have an older timestamp than the last shown item.
        done_ids = set(cur.get("doneIds", []))
        for record in records:
            if record["id"] and record["ts"] > cur.get("afterTs", 0) and record["excerpt"].strip() and record["id"] not in done_ids:
                pending[record["id"]] = {"ts": record["ts"]}
        pending.update(latest)
        if len(pending) > 2048:
            raise PromotionPolicyError("promotion review ledger exceeded bounded capacity")
        cur["lastShortlist"] = latest
        cur["maxPresentedTs"] = max(int(cur.get("maxPresentedTs", 0)), max((c["ts"] for c in candidates), default=0))
        cur["pendingReview"] = pending
        save_cursor(cursor_path, cur)
    print("RESOLUTION:")
    print("  resolved ids  : python3 scripts/memory_promote.py --mark-done <ids...>")
    print("  kept for later: python3 scripts/memory_promote.py --defer <ids...> --defer-reason ...")
    print("  concept emitted: python3 scripts/memory_promote.py --promoted <ids...> --name <CamelCase>")
    print(
        "  advance cursor: --advance-ts "
        + str(newest)
        + " only when every shortlisted id above was resolved or deferred"
    )
    print("promotions last 24h:", len(window_promotions(cur)), "/", CONCEPTS_PER_24H, "concepts per workspace")
    print("deferred kept:", len(cur.get("deferred", {})), "(defer, never discard)")
    sys.exit(0)


if __name__ == "__main__":
    try:
        main()
    except PromotionPolicyError as exc:
        print("REFUSED:", exc, "(no cursor write)")
        sys.exit(6)
