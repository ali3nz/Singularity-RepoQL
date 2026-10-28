#!/usr/bin/env python3
"""Build lifecycle.json from the real board and task answers saved under samples/.

The fixtures are the real answers, redacted: the broker's HMAC signatures and check receipts are replaced with
zero-filled stand-ins of the same shape, and one synthetic credential line is added to a description and to a
comment so that the scrubber is tested. Everything else (ids, titles, statuses, instants, columns, projects) is what
the board answered on 2026-10-28.
"""
import copy
import json
import pathlib
import re

HERE = pathlib.Path(__file__).resolve().parent
SAMPLES = HERE.parent / "samples" / "live-20261028"

ZERO64 = "0" * 64
ZERO32 = "0" * 32

CREDENTIAL_LINE = (
    "\n\nPasted from the runbook by mistake, ignore: API_KEY=Zx9Qw8Er7Ty6Ui5 "
    "and Authorization: Bearer sk-live-0123456789abcdefXYZ -- see also "
    "https://svc:hunter2secret@example.internal/board and ghp_0123456789abcdefghijABCDEFGHIJ012345."
)


def redact(value):
    """Replace the broker's signatures and receipts, keeping the shape of the envelope."""
    if isinstance(value, dict):
        return {key: redact(item) for key, item in value.items()}
    if isinstance(value, list):
        return [redact(item) for item in value]
    if isinstance(value, str):
        value = re.sub(r"hmac-sha256:[0-9a-f]{64}", "hmac-sha256:" + ZERO64, value)
        value = re.sub(r'"check_receipt":\s*"[0-9a-f]{32}"', '"check_receipt":"' + ZERO32 + '"', value)
        value = re.sub(r'"signature":\s*"hmac-sha256:[0-9a-f]{64}"', '"signature":"hmac-sha256:' + ZERO64 + '"', value)
        return value
    return value


def board():
    return json.loads((SAMPLES / "board.json").read_text())


def detail(task_id):
    return json.loads((SAMPLES / f"task-{task_id}.json").read_text())


def task(board_doc, task_id):
    for entry in board_doc["tasks"]:
        if entry["id"] == task_id:
            return entry
    raise SystemExit(f"task {task_id} is not in the sample")


def project(board_doc, slug):
    for entry in board_doc["projects"]:
        if entry["slug"] == slug:
            return entry
    raise SystemExit(f"project {slug} is not in the sample")


def board_doc(tasks, projects, changes, version="0.1.3", statuses=None, done_hidden=0):
    return {
        "changes": changes,
        "done_hidden": done_hidden,
        "projects": projects,
        "statuses": statuses or ["todo", "doing", "review", "done"],
        "tasks": tasks,
        "version": version,
    }


def counts(tasks, slug):
    listed = [entry for entry in tasks if entry["project"] == slug]
    open_cards = [entry for entry in listed if entry["status"] != "done"]
    return {"total": len(listed), "open": len(open_cards)}


def project_row(board_doc, slug, name=None):
    row = copy.deepcopy(project(board_doc, slug))
    cs = counts(board_doc["tasks"], slug)
    row["total"] = cs["total"]
    row["open"] = cs["open"]
    if name:
        row["name"] = name
    return row


def build():
    real = board()
    base_tasks = [task(real, i) for i in (495, 141, 2, 100, 494)]
    base_tasks[4] = copy.deepcopy(base_tasks[4])
    base_tasks[4]["description"] = base_tasks[4]["description"] + CREDENTIAL_LINE

    # Generation 1: the whole board as it is, five cards and two projects.
    g1_tasks = base_tasks
    g1 = board_doc(copy.deepcopy(g1_tasks),
                   [project_row({"projects": real["projects"], "tasks": g1_tasks}, "bprobe"),
                    project_row({"projects": real["projects"], "tasks": g1_tasks}, "fleet")],
                   "1500-24028932")
    g1_detail = copy.deepcopy(detail(495))

    # Generation 2: a card edited, a card added, a comment added, a card gone from the listing.
    g2_tasks = copy.deepcopy(g1_tasks)
    for entry in g2_tasks:
        if entry["id"] == 495:
            entry["comments"] = 2
            entry["updated_at"] = "2026-10-28T11:00:00Z"
        if entry["id"] == 141:
            entry["title"] = "Kanzo work backfill and MCP-first coordination, revised"
            entry["updated_at"] = "2026-10-28T10:40:00Z"
    g2_tasks = [entry for entry in g2_tasks if entry["id"] != 100]
    added = copy.deepcopy(task(real, 494))
    added.update({"id": 496, "title": "A card created after the first sweep",
                  "description": "Created to show a card arriving between sweeps.",
                  "tags": ["kanzo-work"], "status": "todo", "comments": 0,
                  "created_at": "2026-10-28T10:50:00Z", "updated_at": "2026-10-28T10:50:00Z",
                  "position": 2.0})
    g2_tasks.append(added)
    g2 = board_doc(g2_tasks,
                   [project_row({"projects": real["projects"], "tasks": g2_tasks}, "bprobe"),
                    project_row({"projects": real["projects"], "tasks": g2_tasks}, "fleet")],
                   "1502-24028932")
    g2_detail = copy.deepcopy(g1_detail)
    g2_detail["task"]["comments"] = 2
    g2_detail["task"]["updated_at"] = "2026-10-28T11:00:00Z"
    g2_detail["comments"].append({
        "id": 3, "task_id": 495, "author": "super", "created_at": "2026-10-28T11:00:00Z",
        "body": "Second comment, with a token pasted by mistake.\n\n"
                "export KANZO_TOKEN=Zx9Qw8Er7Ty6Ui5\n"
                "curl -H 'Authorization: Bearer sk-live-0123456789abcdefXYZ' http://localhost:4242/api/board\n"
                "password: hunter2secret, and gh[p] token ghp_0123456789abcdefghijABCDEFGHIJ012345",
    })

    # Generation 3: the next full sweep. Two cards the board no longer lists are removed.
    g3_tasks = copy.deepcopy([entry for entry in g2_tasks if entry["id"] not in (100, 494)])
    g3 = board_doc(g3_tasks,
                   [project_row({"projects": real["projects"], "tasks": g3_tasks}, "bprobe"),
                    project_row({"projects": real["projects"], "tasks": g3_tasks}, "fleet")],
                   "1503-24028932")
    g3_detail = copy.deepcopy(g2_detail)

    # Generation 8: the project is renamed. Every card of it states the new name.
    g8 = copy.deepcopy(g3)
    g8["changes"] = "1509-24028932"
    g8["projects"] = [copy.deepcopy(row) for row in g3["projects"]]
    for row in g8["projects"]:
        if row["slug"] == "fleet":
            row["name"] = "Fleet board"

    # A listing that is not the whole board: no tasks, no statuses, no projects.
    broken = {"version": "0.1.3", "changes": "1504-24028932"}

    # The same card twice.
    twice = copy.deepcopy(g3)
    twice["changes"] = "1505-24028932"
    twice["tasks"] = twice["tasks"] + [copy.deepcopy(twice["tasks"][0])]
    twice["projects"] = [project_row({"projects": real["projects"], "tasks": twice["tasks"]}, "bprobe"),
                         project_row({"projects": real["projects"], "tasks": twice["tasks"]}, "fleet")]

    # A card in a project the answer does not list.
    ghost = copy.deepcopy(g3)
    ghost["changes"] = "1506-24028932"
    for entry in ghost["tasks"]:
        if entry["id"] == 2:
            entry["project"] = "ghost"

    # A column the answer does not list.
    column = copy.deepcopy(g3)
    column["changes"] = "1507-24028932"
    for entry in column["tasks"]:
        if entry["id"] == 2:
            entry["status"] = "archived"

    def listing(doc):
        return {"method": "GET", "url": "http://localhost:4242/api/board?done=all", "status": 200, "json": doc}

    def detail_interaction(doc):
        return {"method": "GET", "url": f"http://localhost:4242/api/tasks/{doc['task']['id']}", "status": 200,
                "json": doc}

    suite = {
        "description": (
            "The kanzo connector's suite. Every answer is the real board's answer of 2026-10-28, redacted: the "
            "broker's HMAC signatures and check receipts are zero-filled, and one synthetic credential line is "
            "added to a description and to a comment. Generation 1 is the first, full sweep: five cards, two "
            "projects, the card with a comment, and a card whose description carries a pasted credential. "
            "Generation 2 is incremental: a card edited, a card created, a second comment with a pasted token, and "
            "a card the listing no longer names (kept, because the sweep was not full). Generation 3 is the next "
            "full sweep: the two cards the board dropped are removed. Generations 4 to 7 are answers that must fail "
            "closed and leave the import standing: an incomplete listing, a card listed twice, a card in an unknown "
            "project, an unknown column. Generation 8 renames the project, which every card of it states. "
            "Generation 9 is the same board again: nothing is written."
        ),
        "import": "kanzo://board",
        "generations": [
            {"name": "first full sweep", "clock": "2026-10-28T10:00:00Z", "sweep": "full",
             "interactions": [listing(g1), detail_interaction(g1_detail)],
             "expect": {"written": 8, "removed": 0, "completed": True}},
            {"name": "an hour later: a card edited, one created, a comment added, one gone from the listing",
             "clock": "2026-10-28T11:10:00Z", "sweep": "incremental",
             "interactions": [listing(g2), detail_interaction(g2_detail)],
             "expect": {"written": 1, "changed": 4, "leftAlone": 3, "removed": 1, "completed": True}},
            {"name": "the next full sweep removes the two cards the board dropped",
             "clock": "2026-10-28T12:00:00Z", "sweep": "full",
             "interactions": [listing(g3), detail_interaction(g3_detail)],
             "expect": {"changed": 2, "leftAlone": 5, "removed": 1, "completed": True}},
            {"name": "an incomplete listing keeps the import as it is",
             "clock": "2026-10-28T12:15:00Z", "sweep": "incremental",
             "interactions": [listing(broken)],
             "expect": {"completed": False, "removed": 0, "written": 0, "changed": 0}},
            {"name": "a card listed twice fails closed",
             "clock": "2026-10-28T12:30:00Z", "sweep": "incremental",
             "interactions": [listing(twice)],
             "expect": {"completed": False, "removed": 0, "written": 0, "changed": 0}},
            {"name": "a card in an unknown project fails closed",
             "clock": "2026-10-28T12:45:00Z", "sweep": "incremental",
             "interactions": [listing(ghost)],
             "expect": {"completed": False, "removed": 0, "written": 0, "changed": 0}},
            {"name": "an unknown column fails closed",
             "clock": "2026-10-28T13:00:00Z", "sweep": "incremental",
             "interactions": [listing(column)],
             "expect": {"completed": False, "removed": 0, "written": 0, "changed": 0}},
            {"name": "the project is renamed, and every card of it states the new name",
             "clock": "2026-10-28T13:15:00Z", "sweep": "incremental",
             "interactions": [listing(g8), detail_interaction(g3_detail)],
             "expect": {"changed": 6, "leftAlone": 1, "removed": 0, "completed": True}},
            {"name": "the same board again changes nothing",
             "clock": "2026-10-28T13:30:00Z", "sweep": "incremental",
             "interactions": [listing(g8)],
             "expect": {"written": 0, "changed": 0, "removed": 0, "completed": True}},
        ],
    }
    # Pins, when they exist, are what a hand-judged run produced: a path's sha256, origin and modification time, or
    # its whole text. tools/pin.py writes them, and reviewing the files it read is part of accepting them.
    pins_file = HERE.parent / "pins.json"
    if pins_file.exists():
        pins = json.loads(pins_file.read_text())
        for index, paths in pins.items():
            suite["generations"][int(index)]["expect"].setdefault("paths", {}).update(paths)
    (HERE.parent / "lifecycle.json").write_text(json.dumps(redact(suite), indent=2, ensure_ascii=False) + "\n")
    print("wrote lifecycle.json", (HERE.parent / "lifecycle.json").stat().st_size, "bytes")


if __name__ == "__main__":
    build()
