#!/usr/bin/env python3
"""Cursor-based bounded promotion review over the memory store (zero model calls).

One authenticated POST /v3/conversation/search per run; prints at most 12
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

Deferrals persist with a reason and are re-offered later: --advance-ts refuses
to move past a deferred record's place in the stream until it is resolved or
re-deferred out of the way. Nothing is silently dropped. The memory plugin
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
    body = json.dumps(
        {
            "team_id": scope["team_id"],
            "user_id": scope["user_id"],
            "agent_id": scope["agent_id"],
            "limit": max(limit, 1),
        }
    ).encode("utf-8")
    headers = {"Content-Type": "application/json"}
    headers.update(auth_headers())
    req = urllib.request.Request(
        base + "/v3/conversation/search",
        data=body,
        headers=headers,
        method="POST",
    )
    try:
        with urllib.request.urlopen(req, timeout=30) as resp:
            return json.loads(resp.read().decode("utf-8"))
    except urllib.error.HTTPError as exc:
        print("search failed:", exc.code, exc.reason, "- check scopes/auth (--probe re-runs)")
        sys.exit(7)
    except urllib.error.URLError as exc:
        print("search unreachable:", exc.reason, "- is the memory core at", base, "?")
        sys.exit(7)


def compact_records(doc):
    rows = []
    if isinstance(doc, list):
        rows = doc
    elif isinstance(doc, dict):
        for key in ("records", "results", "conversations", "messages", "data", "units"):
            if isinstance(doc.get(key), list):
                rows = doc[key]
                break
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
    path.write_text(json.dumps(cur, indent=2) + "\n", encoding="utf-8")


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


def main():
    ap = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    ap.add_argument("--team", default=os.environ.get("MEMORY_SCOPE_TEAM", "knowledge"))
    ap.add_argument("--user", default=os.environ.get("MEMORY_SCOPE_USER", "operator"))
    ap.add_argument("--agent", default=os.environ.get("MEMORY_SCOPE_AGENT", "knowledge-promotion"))
    ap.add_argument("--state-dir", default="data/selflearn")
    ap.add_argument(
        "--probe", action="store_true",
        help="print the raw first search page and exit (schema reconnaissance)",
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
        wins = window_promotions(cur)
        if len(wins) >= CONCEPTS_PER_24H:
            print(
                "DEFERRED: concept cap reached ("
                + str(len(wins)) + "/" + str(CONCEPTS_PER_24H)
                + " in the last 24h) - submit this concept in a later window"
            )
            sys.exit(5)
        repeat = concept_repeat(cur, args.name)
        if repeat:
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
            blocked = [
                rid
                for rid, v in cur.get("deferred", {}).items()
                if v.get("rec_ts") and int(v["rec_ts"]) <= int(args.advance_ts)
            ]
            if blocked:
                print(
                    "ADVANCE BLOCKED: deferred record(s)",
                    ", ".join(sorted(blocked)),
                    "sit at or below the requested afterTs;",
                    "resolve them first (--mark-done) or keep the cursor in place",
                )
                print("deferred kept:", len(cur.get("deferred", {})), "(defer, never discard)")
                sys.exit(5)
            cur["afterTs"] = max(int(cur.get("afterTs", 0)), args.advance_ts)
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
    done = set(cur.get("doneIds", []))
    candidates = []
    budget = MAX_CHARS
    for rec in compact_records(doc):
        if rec["id"] and rec["id"] in done:
            continue
        if rec["ts"] and rec["ts"] <= after:
            continue
        need = len(rec["excerpt"]) + 8
        if need > budget or len(candidates) >= MAX_CANDIDATES:
            break
        candidates.append(rec)
        budget -= need

    if not candidates:
        print(
            "NO NEW CANDIDATES (cursor afterTs:",
            after,
            "; deferred still kept:",
            len(cur.get("deferred", {})),
            ")",
        )
        print("promotion cycle complete for this window (zero model calls spent)")
        sys.exit(0)

    newest = max(c["ts"] for c in candidates)
    print("SHORTLIST (" + str(len(candidates)) + " of <=12 within 4000 chars; review AT MOST 2 in full):")
    for i, c in enumerate(candidates, 1):
        when = time.strftime("%m-%dT%H:%M", time.gmtime(c["ts"])) if c["ts"] else "no-ts"
        print(" [" + str(i) + "]", "id", c["id"] or "(no id)", "ts", when)
        print("      ", c["excerpt"].replace("\n", " ")[:280])
    if candidates:
        cur["lastShortlist"] = {c["id"]: {"ts": c["ts"]} for c in candidates if c["id"]}
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
    main()
