"""Private Ghost schedule drafts plus verified native scheduler operations.

Drafts remain an editable planning ledger. Native scheduler state is always
read from the authenticated Windows host; this module never stores an active
flag in a draft or treats a successful HTTP request as scheduler readback.
"""
from __future__ import annotations

from contextlib import contextmanager
from datetime import date, datetime
from zoneinfo import ZoneInfo, ZoneInfoNotFoundError
import hashlib
import json
import errno
import os
from pathlib import Path
import re
import secrets
import tempfile
import time
from file_lock import fcntl

MAX_PLANS = 100
MAX_RETIRED_REQUEST_IDS = 2048
REQUEST_RX = re.compile(r"^[A-Za-z0-9_-]{8,128}$")
ID_RX = re.compile(r"^[0-9a-f]{32}$")
DATE_RX = re.compile(r"^\d{4}-\d{2}-\d{2}$")
TIME_RX = re.compile(r"^(?:[01]\d|2[0-3]):[0-5]\d$")
RECUR = {"once", "daily", "weekly"}
SHA256_RX = re.compile(r"^[0-9a-f]{64}$")
SID_RX = re.compile(r"^S-1-(?:[0-9]+-)*[0-9]+$", re.IGNORECASE)
SCHEDULE_CAPABILITIES = ("register", "update", "cancel", "readback", "execute")
SCHEDULE_READBACK_FIELDS = (
    "jobId", "revision", "draftId", "draftRevision", "title", "date", "time",
    "timezone", "recurrence", "enabled", "status", "ownerSid",
    "executionIdentitySid", "principalSid", "promptRevision", "promptSha256",
    "missedRunPolicy",
)


class PlanError(ValueError):
    pass


class PlanBusy(PlanError):
    """A concurrent private draft update owns the lock; retry later."""


LOCK_WAIT_SECONDS = 5.0


def path_for_state() -> Path:
    state = os.environ.get("SINGULARITY_STATE_DIR", "")
    if not state:
        raise PlanError("plans_not_configured")
    root = Path(state)
    if not root.is_absolute() or root.is_symlink() or not root.is_dir():
        raise PlanError("plans_state_unavailable")
    return root / "ghost-task-plans.json"


@contextmanager
def locked(path: Path):
    if path.is_symlink() or path.parent.is_symlink():
        raise PlanError("plans_symlink_refused")
    lock = path.with_name(path.name + ".lock")
    if lock.is_symlink():
        raise PlanError("plans_lock_symlink_refused")
    with lock.open("a+b") as f:
        if lock.is_symlink():
            raise PlanError("plans_lock_symlink_refused")
        if not f.seek(0, os.SEEK_END):
            f.write(b"\0")
            f.flush()
            os.fsync(f.fileno())
        os.chmod(lock, 0o600)
        deadline = time.monotonic() + LOCK_WAIT_SECONDS
        while True:
            try:
                fcntl.flock(f.fileno(), fcntl.LOCK_EX | fcntl.LOCK_NB)
                break
            except OSError as exc:
                # Windows uses winerror 33 (sharing violation); POSIX normally
                # raises EAGAIN/EACCES. Other errors must never mean "unlocked".
                if exc.errno not in (errno.EAGAIN, errno.EACCES) and getattr(exc, "winerror", None) != 33:
                    raise PlanError("plans_lock_unavailable") from exc
                if time.monotonic() >= deadline:
                    raise PlanBusy("plans_lock_busy") from exc
                time.sleep(0.05)
        try:
            yield
        finally:
            fcntl.flock(f.fileno(), fcntl.LOCK_UN)


def read(path: Path, *, include_retired=False):
    if path.is_symlink():
        raise PlanError("plans_symlink_refused")
    try:
        raw = path.read_bytes()
    except FileNotFoundError:
        return ([], set()) if include_retired else []
    except OSError as exc:
        raise PlanError("plans_unreadable") from exc
    if len(raw) > 512 * 1024:
        raise PlanError("plans_too_large")
    try:
        data = json.loads(raw)
    except (ValueError, UnicodeError) as exc:
        raise PlanError("plans_invalid") from exc
    if not isinstance(data, dict) or data.get("schema") != 1 or not isinstance(data.get("plans"), list):
        raise PlanError("plans_invalid")
    rows = data["plans"]
    # Retired request IDs remain reserved after a draft is deleted. An old
    # creation response must not be reinterpreted as a fresh save on retry.
    retired = data.get("retiredRequestIds", [])
    if (not isinstance(retired, list) or len(retired) > MAX_RETIRED_REQUEST_IDS
            or any(not isinstance(item, str) or not REQUEST_RX.fullmatch(item) for item in retired)
            or len(set(retired)) != len(retired)):
        raise PlanError("plans_invalid")
    if len(rows) > MAX_PLANS or any(not isinstance(row, dict) or not ID_RX.fullmatch(str(row.get("id", ""))) for row in rows):
        raise PlanError("plans_invalid")
    if len({row["id"] for row in rows}) != len(rows):
        raise PlanError("plans_invalid")
    # Never deserialize a forged "active" flag as a legitimate scheduled job.
    # Invalid existing data must be preserved for inspection, not normalised
    # and overwritten by the next innocent dashboard edit.
    live_ids = set()
    for row in rows:
        if (row.get("active") is not False or row.get("status") != "draft"
                or row.get("timezone") != "Pacific/Auckland"
                or type(row.get("revision")) is not int or row["revision"] < 1
                or not isinstance(row.get("lastRequestId"), str)
                or not re.fullmatch(r"[A-Za-z0-9_-]{8,128}", row["lastRequestId"])):
            raise PlanError("plans_invalid")
        # Legacy ledgers have only lastRequestId. New records retain all IDs so
        # an old HTTP retry cannot become a second calendar draft after edits.
        history = row.get("requestIds", [row["lastRequestId"]])
        if (not isinstance(history, list) or not history
                or any(not isinstance(item, str) or not re.fullmatch(r"[A-Za-z0-9_-]{8,128}", item)
                       for item in history)
                or len(set(history)) != len(history)
                or history[-1] != row["lastRequestId"]
                or live_ids.intersection(history)):
            raise PlanError("plans_invalid")
        live_ids.update(history)
        try:
            validate(row)
        except PlanError as exc:
            raise PlanError("plans_invalid") from exc
    if live_ids.intersection(retired):
        raise PlanError("plans_invalid")
    return (rows, set(retired)) if include_retired else rows


def write(path: Path, rows, *, retired_request_ids=()):
    if path.is_symlink():
        raise PlanError("plans_symlink_refused")
    state = {"schema": 1, "plans": rows}
    if retired_request_ids:
        state["retiredRequestIds"] = sorted(retired_request_ids)
    content = json.dumps(state, ensure_ascii=False, sort_keys=True, separators=(",", ":")).encode()
    if len(content) > 512 * 1024:
        raise PlanError("plans_too_large")
    fd, name = tempfile.mkstemp(prefix=".ghost-plans-", dir=path.parent)
    try:
        os.chmod(name, 0o600)
        with os.fdopen(fd, "wb") as stream:
            stream.write(content)
            stream.flush()
            os.fsync(stream.fileno())
        if path.is_symlink():
            raise PlanError("plans_symlink_refused")
        os.replace(name, path)
    finally:
        if os.path.exists(name):
            os.unlink(name)


def validate(payload):
    title = payload.get("title")
    prompt = payload.get("prompt")
    day = payload.get("date")
    clock = payload.get("time")
    recurrence = payload.get("recurrence", "once")
    if not isinstance(title, str) or not 1 <= len(title.strip()) <= 90 or "\x00" in title:
        raise PlanError("invalid_title")
    if not isinstance(prompt, str) or not 1 <= len(prompt.strip()) <= 4000 or "\x00" in prompt:
        raise PlanError("invalid_prompt")
    if not isinstance(day, str) or not DATE_RX.fullmatch(day):
        raise PlanError("invalid_date")
    try:
        date.fromisoformat(day)
    except ValueError as exc:
        raise PlanError("invalid_date") from exc
    if not isinstance(clock, str) or not TIME_RX.fullmatch(clock):
        raise PlanError("invalid_time")
    if recurrence not in RECUR:
        raise PlanError("invalid_recurrence")
    return {"title": title.strip(), "prompt": prompt, "date": day, "time": clock,
            "recurrence": recurrence, "timezone": "Pacific/Auckland", "active": False,
            "status": "draft"}


def require_unambiguous_nz_schedule(plan):
    """Reject operator handoffs whose local time cannot safely map to an occurrence.

    Existing drafts remain readable/editable. This applies to a proposed
    *activation*, not the historical draft ledger or its display.
    """
    start = date.fromisoformat(plan["date"])
    hour, minute = (int(v) for v in plan["time"].split(":"))
    recurrence = plan["recurrence"]
    # NZ DST transitions take place on Sunday in the local 02:00 hour.
    # A daily 02:xx job, or weekly Sunday 02:xx job, needs an explicit
    # skip/repeat policy that the current external Ghost host does not expose.
    if recurrence == "daily" or (recurrence == "weekly" and start.weekday() == 6):
        if hour == 2:
            raise PlanError("dst_policy_required_for_recurring_02_hour")
    if recurrence == "once":
        local = datetime(start.year, start.month, start.day, hour, minute)
        try:
            nz = ZoneInfo("Pacific/Auckland")
        except ZoneInfoNotFoundError as exc:
            raise PlanError("nz_timezone_database_unavailable") from exc
        first = local.replace(tzinfo=nz, fold=0)
        second = local.replace(tzinfo=nz, fold=1)
        if first.utcoffset() != second.utcoffset():
            raise PlanError("nz_local_time_ambiguous_or_nonexistent")
        if first <= datetime.now(nz):
            raise PlanError("one_time_activation_in_the_past")


def activation_preview(plan):
    """Version-bound operator handoff. Never registers or executes anything.

    The checksum is an integrity hint for detecting a modified preview; it is
    not a signature or a substitute for scheduler ownership/readback.
    """
    require_unambiguous_nz_schedule(plan)
    request = {
        "schema": 1, "kind": "ghost-schedule-activation-proposal",
        "draftId": plan["id"], "expectedRevision": plan["revision"],
        "task": {key: plan[key] for key in ("title", "prompt", "date", "time", "recurrence", "timezone")},
        "executionAuthorized": False, "schedulerRegistered": False,
    }
    canonical = json.dumps(request, ensure_ascii=False, sort_keys=True, separators=(",", ":")).encode("utf-8")
    request["sha256"] = hashlib.sha256(canonical).hexdigest()
    return request


def control(method, body=None, *, path=None):
    """API response tuple. Every write is unambiguously a *draft*, never activation."""
    try:
        path = Path(path) if path is not None else path_for_state()
        if method not in {"GET", "POST", "DELETE"}:
            return 405, {"ok": False, "error": "method_not_allowed"}
        with locked(path):
            rows, retired = read(path, include_retired=True)
            if method == "GET":
                return 200, {"ok": True, "plans": rows, "executionAvailable": False}
            if not isinstance(body, dict) or body.get("confirm") is not True:
                return 400, {"ok": False, "error": "confirmation_required"}
            request_id = body.get("requestId")
            if not isinstance(request_id, str) or not REQUEST_RX.fullmatch(request_id):
                return 400, {"ok": False, "error": "invalid_request_id"}
            action = body.get("action")
            ident = body.get("id")
            if action == "activation-preview" and method == "POST":
                if not isinstance(ident, str) or not ID_RX.fullmatch(ident):
                    raise PlanError("invalid_id")
                old = next((row for row in rows if row["id"] == ident), None)
                if old is None:
                    raise PlanError("unknown_plan")
                if type(body.get("expectedRevision")) is not int or body["expectedRevision"] != old["revision"]:
                    return 409, {"ok": False, "error": "draft_changed_refresh_required"}
                return 200, {
                    "ok": True, "preview": activation_preview(old), "executionAvailable": False,
                    "message": "Review-only activation proposal. No scheduler action was performed.",
                }
            if action == "save-draft" and method == "POST":
                if request_id in retired:
                    return 409, {"ok": False, "error": "request_id_payload_conflict"}
                record = validate(body)
                if ident is None:
                    # A lost HTTP response may prompt the operator to retry the
                    # same request. Return the original draft rather than creating
                    # a second scheduled-looking calendar entry.
                    previous = next((row for row in rows if request_id in row.get("requestIds", [row["lastRequestId"]])), None)
                    if previous is not None:
                        if (previous["lastRequestId"] != request_id
                                or any(previous.get(key) != record[key] for key in ("title", "prompt", "date", "time", "recurrence", "timezone"))):
                            return 409, {"ok": False, "error": "request_id_payload_conflict"}
                        return 200, {"ok": True, "plan": previous, "executionAvailable": False,
                                     "message": "Existing draft returned; no scheduled execution created."}
                    if len(rows) >= MAX_PLANS:
                        raise PlanError("plans_limit_reached")
                    record.update({"id": secrets.token_hex(16), "revision": 1,
                                   "lastRequestId": request_id, "requestIds": [request_id]})
                    rows.append(record)
                else:
                    if not isinstance(ident, str) or not ID_RX.fullmatch(ident):
                        raise PlanError("invalid_id")
                    old = next((row for row in rows if row["id"] == ident), None)
                    if old is None:
                        raise PlanError("unknown_plan")
                    previous = next((row for row in rows if request_id in row.get("requestIds", [row["lastRequestId"]])), None)
                    if previous is not None:
                        if (previous["id"] != ident or old["lastRequestId"] != request_id
                                or any(old.get(key) != record[key] for key in ("title", "prompt", "date", "time", "recurrence", "timezone"))):
                            return 409, {"ok": False, "error": "request_id_payload_conflict"}
                        return 200, {"ok": True, "plan": old, "executionAvailable": False}
                    if type(body.get("expectedRevision")) is not int or body["expectedRevision"] != old.get("revision"):
                        return 409, {"ok": False, "error": "draft_changed_refresh_required"}
                    record.update({"id": ident, "revision": old["revision"] + 1,
                                   "lastRequestId": request_id,
                                   "requestIds": old.get("requestIds", [old["lastRequestId"]]) + [request_id]})
                    rows[rows.index(old)] = record
                write(path, rows, retired_request_ids=retired)
                return 200, {"ok": True, "plan": record, "executionAvailable": False, "message": "Draft saved; no scheduled execution created."}
            if action == "delete-draft" and method == "DELETE":
                if request_id in retired or any(request_id in row.get("requestIds", [row["lastRequestId"]]) for row in rows):
                    return 409, {"ok": False, "error": "request_id_payload_conflict"}
                if not isinstance(ident, str) or not ID_RX.fullmatch(ident):
                    raise PlanError("invalid_id")
                old = next((row for row in rows if row["id"] == ident), None)
                if old is None:
                    raise PlanError("unknown_plan")
                if type(body.get("expectedRevision")) is not int or body["expectedRevision"] != old.get("revision"):
                    return 409, {"ok": False, "error": "draft_changed_refresh_required"}
                # Reserve both the delete request and every request associated
                # with the deleted draft. Refuse exhaustion without deleting it.
                reserved = retired | set(old.get("requestIds", [old["lastRequestId"]])) | {request_id}
                if len(reserved) > MAX_RETIRED_REQUEST_IDS:
                    raise PlanError("retired_request_ids_limit_reached")
                rows.remove(old)
                write(path, rows, retired_request_ids=reserved)
                return 200, {"ok": True, "executionAvailable": False, "message": "Draft removed."}
            return 400, {"ok": False, "error": "unknown_action"}
    except PlanBusy as exc:
        return 503, {"ok": False, "error": str(exc)}
    except PlanError as exc:
        return 400, {"ok": False, "error": str(exc)}
    except OSError:
        return 503, {"ok": False, "error": "plans_storage_unavailable"}


def _public_schedule(row):
    """Return scheduler metadata without exposing Windows identity SIDs."""
    return {key: row[key] for key in (
        "jobId", "revision", "draftId", "draftRevision", "title", "date", "time",
        "timezone", "recurrence", "enabled", "status", "promptRevision",
        "missedRunPolicy",
    )}


def _schedule_row_valid(row, owner_sid, execution_sid):
    if not isinstance(row, dict) or any(key not in row for key in SCHEDULE_READBACK_FIELDS):
        return False
    if (not isinstance(row["jobId"], str) or not ID_RX.fullmatch(row["jobId"])
            or not isinstance(row["draftId"], str) or not ID_RX.fullmatch(row["draftId"])
            or type(row["revision"]) is not int or row["revision"] < 1
            or type(row["draftRevision"]) is not int or row["draftRevision"] < 1
            or type(row["promptRevision"]) is not int or row["promptRevision"] < 1
            or not isinstance(row["title"], str) or not 1 <= len(row["title"]) <= 90
            or not isinstance(row["date"], str) or not DATE_RX.fullmatch(row["date"])
            or not isinstance(row["time"], str) or not TIME_RX.fullmatch(row["time"])
            or not isinstance(row["recurrence"], str) or row["recurrence"] not in RECUR
            or row["timezone"] != "Pacific/Auckland"
            or type(row["enabled"]) is not bool
            or not isinstance(row["status"], str) or not row["status"]
            or not isinstance(row["missedRunPolicy"], str) or not row["missedRunPolicy"]
            or not isinstance(row["promptSha256"], str) or not SHA256_RX.fullmatch(row["promptSha256"])):
        return False
    try:
        date.fromisoformat(row["date"])
    except ValueError:
        return False
    identities = (row["ownerSid"], row["executionIdentitySid"], row["principalSid"])
    return (all(isinstance(sid, str) and SID_RX.fullmatch(sid) for sid in identities)
            and row["ownerSid"] == owner_sid
            and row["executionIdentitySid"] == execution_sid
            and row["principalSid"] == execution_sid)


def _scheduler_readback(host_request):
    """Read and validate the host's authoritative, current-user task inventory."""
    try:
        status, state = host_request("GET", None)
    except Exception:
        return 503, {"ok": False, "verified": False, "error": "scheduler_readback_unavailable", "schedules": []}, None
    if type(status) is not int or not isinstance(state, dict) or status != 200 or state.get("ok") is not True:
        return (status if type(status) is int and 400 <= status <= 599 else 503), {
            "ok": False, "verified": False, "error": "scheduler_readback_unavailable", "schedules": []
        }, None
    owner_sid = state.get("ownerSid")
    execution_sid = state.get("executionIdentitySid")
    capabilities = state.get("capabilities")
    schedule_caps = capabilities.get("schedule") if isinstance(capabilities, dict) else None
    if (not isinstance(owner_sid, str) or not SID_RX.fullmatch(owner_sid)
            or not isinstance(execution_sid, str) or not SID_RX.fullmatch(execution_sid)
            or not isinstance(schedule_caps, dict)
            or any(type(schedule_caps.get(name)) is not bool for name in SCHEDULE_CAPABILITIES)
            or schedule_caps.get("readback") is not True
            or not isinstance(state.get("schedules"), list)):
        return 503, {"ok": False, "verified": False, "error": "scheduler_readback_unverified", "schedules": []}, None

    schedules = state["schedules"]
    seen = set()
    seen_drafts = set()
    for row in schedules:
        if (not _schedule_row_valid(row, owner_sid, execution_sid)
                or row["jobId"] in seen or row["draftId"] in seen_drafts):
            # Do not leak another Windows identity or display an ambiguous job
            # list as if it belonged to the current dashboard user.
            return 503, {"ok": False, "verified": False, "error": "scheduler_readback_unverified", "schedules": []}, None
        seen.add(row["jobId"])
        seen_drafts.add(row["draftId"])
    public = {
        "ok": True,
        "verified": True,
        "ownerVerified": True,
        "capabilities": {"schedule": dict(schedule_caps)},
        "schedules": [_public_schedule(row) for row in schedules],
    }
    return 200, public, {"ownerSid": owner_sid, "executionIdentitySid": execution_sid,
                          "capabilities": schedule_caps, "schedules": schedules}


def _scheduler_request_error(status, error):
    return status, {"ok": False, "verified": False, "error": error}


def scheduler_control(method, body=None, *, host_request, path=None):
    """Coordinate a draft revision with the native host and verify live readback.

    The browser never sends prompt, owner, principal, or runner values to the
    host. The host independently reads the private draft ledger while holding
    its own lock. This function releases its preview read lock before any host
    request, so the two processes cannot deadlock on the ledger.
    """
    if method == "GET":
        status, state, _raw = _scheduler_readback(host_request)
        return status, state
    if method != "POST":
        return 405, {"ok": False, "error": "method_not_allowed"}
    if not isinstance(body, dict) or body.get("confirm") is not True:
        return 400, {"ok": False, "error": "confirmation_required"}

    action = body.get("action")
    expected_fields = {
        "register-schedule": {"action", "confirm", "requestId", "draftId", "expectedDraftRevision", "previewSha256"},
        "update-schedule": {"action", "confirm", "requestId", "jobId", "expectedRevision", "draftId", "expectedDraftRevision", "previewSha256"},
        "cancel-schedule": {"action", "confirm", "requestId", "jobId", "expectedRevision"},
    }
    if not isinstance(action, str) or action not in expected_fields:
        return 400, {"ok": False, "error": "unknown_action"}
    if set(body) != expected_fields[action]:
        return 400, {"ok": False, "error": "invalid_request_fields"}
    request_id = body.get("requestId")
    if not isinstance(request_id, str) or not REQUEST_RX.fullmatch(request_id):
        return 400, {"ok": False, "error": "invalid_request_id"}
    draft_id = body.get("draftId")
    if action in {"register-schedule", "update-schedule"}:
        if not isinstance(draft_id, str) or not ID_RX.fullmatch(draft_id):
            return 400, {"ok": False, "error": "invalid_id"}
        if (type(body.get("expectedDraftRevision")) is not int or body["expectedDraftRevision"] < 1
                or not isinstance(body.get("previewSha256"), str)
                or not SHA256_RX.fullmatch(body["previewSha256"])):
            return 400, {"ok": False, "error": "invalid_revision_or_preview"}
    if action in {"update-schedule", "cancel-schedule"}:
        if (not isinstance(body.get("jobId"), str) or not ID_RX.fullmatch(body["jobId"])
                or type(body.get("expectedRevision")) is not int or body["expectedRevision"] < 1):
            return 400, {"ok": False, "error": "invalid_job_revision"}

    read_status, before, raw_before = _scheduler_readback(host_request)
    if read_status != 200 or raw_before is None:
        return read_status, before
    needed_capability = {"register-schedule": "register", "update-schedule": "update", "cancel-schedule": "cancel"}[action]
    if raw_before["capabilities"].get(needed_capability) is not True:
        return _scheduler_request_error(503, "scheduler_action_unavailable")

    preview = None
    preview_task = None
    prompt_hash = None
    previous_job = None
    if action in {"register-schedule", "update-schedule"}:
        preview_body = {
            "action": "activation-preview", "id": draft_id,
            "expectedRevision": body["expectedDraftRevision"], "confirm": True,
            "requestId": secrets.token_urlsafe(18),
        }
        preview_status, preview_result = control("POST", preview_body, path=path)
        if preview_status != 200:
            return preview_status, {"ok": False, "error": preview_result.get("error", "draft_preview_refused")}
        preview = preview_result.get("preview")
        preview_task = preview.get("task") if isinstance(preview, dict) else None
        if (not isinstance(preview, dict) or not isinstance(preview_task, dict)
                or not isinstance(preview.get("sha256"), str)
                or preview.get("sha256") != body["previewSha256"]):
            return 409, {"ok": False, "error": "draft_preview_changed_refresh_required"}
        prompt_hash = hashlib.sha256(preview_task["prompt"].encode("utf-8")).hexdigest()
        if action == "update-schedule":
            previous_job = next((row for row in raw_before["schedules"] if row["jobId"] == body["jobId"]), None)
            if previous_job is None:
                return 404, {"ok": False, "error": "unknown_schedule"}
            if previous_job["draftId"] != draft_id:
                return 409, {"ok": False, "error": "schedule_draft_mismatch"}

    # Keep this host request intentionally minimal. The native process rereads
    # the private draft, derives prompt/schedule data, and chooses all SIDs.
    host_body = {key: body[key] for key in expected_fields[action]
                 if key in {"action", "confirm", "requestId", "draftId", "expectedDraftRevision", "jobId", "expectedRevision"}}
    host_body.pop("previewSha256", None)
    try:
        action_status, action_result = host_request("POST", host_body)
    except Exception:
        return 503, {"ok": False, "error": "scheduler_action_unconfirmed", "requestId": request_id}
    if (type(action_status) is not int or not isinstance(action_result, dict)
            or action_status < 200 or action_status >= 300 or action_result.get("ok") is not True):
        error = action_result.get("error") if isinstance(action_result, dict) else None
        if not isinstance(error, str) or not re.fullmatch(r"[a-z][a-z0-9_]{1,80}", error):
            error = "scheduler_action_refused"
        return (action_status if type(action_status) is int and 400 <= action_status <= 599 else 502), {
            "ok": False, "error": error, "requestId": request_id,
        }

    if action == "cancel-schedule":
        job_id = body["jobId"]
        if action_result.get("jobId") != job_id or action_result.get("active") is not False or action_result.get("status") != "cancelled":
            return 503, {"ok": False, "error": "schedule_cancel_unconfirmed", "requestId": request_id}
        after_status, after, raw_after = _scheduler_readback(host_request)
        if (after_status != 200 or raw_after is None
                or any(row["jobId"] == job_id for row in raw_after["schedules"])):
            return 503, {"ok": False, "error": "schedule_cancel_readback_unverified", "requestId": request_id}
        return 200, {"ok": True, "active": False, "status": "cancelled", "requestId": request_id,
                     "jobId": job_id, "revision": body["expectedRevision"], "readbackVerified": True,
                     "readback": after}

    job_id = action_result.get("jobId")
    result_revision = action_result.get("revision")
    if (not isinstance(job_id, str) or not ID_RX.fullmatch(job_id)
            or (action == "update-schedule" and job_id != body["jobId"])
            or type(result_revision) is not int or result_revision < 1
            or action_result.get("active") is not True or action_result.get("status") != "active"):
        return 503, {"ok": False, "error": "schedule_activation_unconfirmed", "requestId": request_id}

    after_status, after, raw_after = _scheduler_readback(host_request)
    if after_status != 200 or raw_after is None:
        return 503, {"ok": False, "error": "schedule_activation_readback_unverified", "requestId": request_id}
    row = next((item for item in raw_after["schedules"] if item["jobId"] == job_id), None)
    expected_prompt_revision = 1
    if action == "update-schedule":
        if prompt_hash != previous_job["promptSha256"]:
            expected_prompt_revision = previous_job["promptRevision"] + 1
        else:
            expected_prompt_revision = previous_job["promptRevision"]
    expected_scheduler_revision = 1 if action == "register-schedule" else body["expectedRevision"] + 1
    matches = bool(row and row["revision"] == result_revision == expected_scheduler_revision
                   and row["draftId"] == draft_id
                   and row["draftRevision"] == body["expectedDraftRevision"]
                   and row["title"] == preview_task["title"]
                   and row["date"] == preview_task["date"]
                   and row["time"] == preview_task["time"]
                   and row["timezone"] == preview_task["timezone"]
                   and row["recurrence"] == preview_task["recurrence"]
                   and row["enabled"] is True and row["status"] == "active"
                   and row["promptRevision"] == expected_prompt_revision
                   and row["promptSha256"] == prompt_hash)
    if not matches:
        return 503, {"ok": False, "error": "schedule_activation_readback_mismatch", "requestId": request_id}
    return 200, {"ok": True, "active": True, "status": "active", "requestId": request_id,
                 "jobId": job_id, "revision": result_revision, "readbackVerified": True,
                 "schedule": _public_schedule(row), "readback": after}
