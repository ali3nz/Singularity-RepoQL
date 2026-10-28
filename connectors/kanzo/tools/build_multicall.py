#!/usr/bin/env python3
"""Build suite-multicall.json: a board with more commented cards than one call may read.

It proves two things the main suite cannot: a sweep that needs more than one call carries its place across calls (a
call makes at most 20 requests), and a call that fails part-way leaves the import standing — the files the earlier
call published stay, and nothing is removed.

The cards are synthetic: the real board has one card with a comment, and this needs twenty-five. Their shape is the
real answer's.
"""
import json
import pathlib

ROOT = pathlib.Path(__file__).resolve().parent.parent
BASE = "http://localhost:4242"
COUNT = 25

STATUSES = ["todo", "doing", "review", "done"]


def card(index):
    return {
        "id": 9000 + index,
        "project": "fleet",
        "title": f"Synthetic card {index} for the multi-call test",
        "description": "A card with one comment, made to fill two calls of one sweep.",
        "tags": ["kanzo-work"],
        "human": False,
        "status": "todo",
        "position": float(index),
        "created_at": "2026-10-28T09:00:00Z",
        "updated_at": "2026-10-28T09:00:00Z",
        "comments": 1,
    }


def detail(index):
    task = card(index)
    return {
        "task": task,
        "comments": [{"id": 800000 + index, "task_id": task["id"], "author": "super",
                      "created_at": "2026-10-28T09:05:00Z", "body": f"The only comment on card {index}."}],
        "images": [],
    }


def listing(changes):
    return {"changes": changes, "done_hidden": 0,
            "projects": [
                {"id": 1, "slug": "bprobe", "name": "Buffy probe", "repos": [], "color": None,
                 "created_at": "2026-10-27T12:38:53Z", "open": 0, "total": 0},
                {"id": 2, "slug": "fleet", "name": "Fleet", "repos": [], "color": None,
                 "created_at": "2026-10-27T20:32:46Z", "open": COUNT, "total": COUNT},
            ],
            "statuses": STATUSES,
            "tasks": [card(index) for index in range(1, COUNT + 1)],
            "version": "0.1.3"}


def board(changes):
    return {"method": "GET", "url": f"{BASE}/api/board?done=all", "status": 200, "json": listing(changes)}


def task_answer(index, status=200):
    answer = {"method": "GET", "url": f"{BASE}/api/tasks/{9000 + index}", "status": status}
    if status == 200:
        answer["json"] = detail(index)
    return answer


def main():
    first = [board("1600-1")] + [task_answer(index) for index in range(1, COUNT + 1)]
    second = [board("1601-1")] + [task_answer(index, 500 if index == COUNT else 200) for index in range(1, COUNT + 1)]
    suite = {
        "description": (
            "Twenty-five cards, each with one comment, so that one sweep needs two calls: the first reads nineteen "
            "task answers beside the listing, the second reads the rest. Generation 1 writes every card. Generation "
            "2 moves the board's change counter, so every card's comment is read again, and the last card's answer "
            "fails with HTTP 500: the call fails, and the import stands with the files the first call published."
        ),
        "import": "kanzo://board",
        "generations": [
            {"name": "one sweep, two calls, because a call makes twenty requests", "clock": "2026-10-28T14:00:00Z",
             "sweep": "full", "interactions": first,
             "expect": {"written": COUNT + 3, "removed": 0, "completed": True}},
            {"name": "a call that fails part-way leaves the import standing", "clock": "2026-10-28T14:15:00Z",
             "sweep": "incremental", "interactions": second,
             "expect": {"written": 0, "changed": 0, "removed": 0, "completed": False}},
        ],
    }
    (ROOT / "suite-multicall.json").write_text(json.dumps(suite, indent=2, ensure_ascii=False) + "\n")
    print("wrote suite-multicall.json", (ROOT / "suite-multicall.json").stat().st_size, "bytes")


if __name__ == "__main__":
    main()
