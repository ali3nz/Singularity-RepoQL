"""Focused dashboard orchestration tests for native Ghost schedules.

The host is stubbed here. These tests verify request shaping and the dashboard's
readback gate; they do not claim Windows Task Scheduler integration evidence.
"""
import hashlib
import tempfile
import unittest
from pathlib import Path

from ghost_schedule_plans import control, scheduler_control


OWNER = "S-1-5-21-101-202-303-1001"
EXECUTION = "S-1-5-18"


class FakeSchedulerHost:
    def __init__(self, ledger):
        self.ledger = ledger
        self.owner_sid = OWNER
        self.execution_sid = EXECUTION
        self.schedules = []
        self.calls = []
        self.requests = {}
        self.fail_next_get = False
        self.fail_get_after_post = False
        self.mismatch_prompt_hash = False
        self.capabilities = {"register": True, "update": True, "cancel": True,
                             "readback": True, "execute": True}

    def __call__(self, method, body=None):
        if method == "GET":
            if self.fail_next_get:
                self.fail_next_get = False
                return 503, {"ok": False, "error": "unavailable"}
            return 200, {
                "ok": True,
                "ownerSid": self.owner_sid,
                "executionIdentitySid": self.execution_sid,
                "capabilities": {"schedule": dict(self.capabilities)},
                "schedules": [dict(row) for row in self.schedules],
            }
        self.calls.append(dict(body))
        request_id = body["requestId"]
        fingerprint = tuple(sorted(body.items()))
        if request_id in self.requests:
            saved_fingerprint, saved_result = self.requests[request_id]
            if fingerprint != saved_fingerprint:
                return 409, {"ok": False, "error": "request_id_payload_conflict"}
            return 200, {**saved_result, "replayed": True}

        if body["action"] in ("register-schedule", "update-schedule"):
            plans = control("GET", path=self.ledger)[1]["plans"]
            plan = next((item for item in plans if item["id"] == body["draftId"]), None)
            if plan is None or plan["revision"] != body["expectedDraftRevision"]:
                return 409, {"ok": False, "error": "draft_changed_refresh_required"}
            prompt_hash = hashlib.sha256(plan["prompt"].encode("utf-8")).hexdigest()
            if body["action"] == "register-schedule":
                if any(item["draftId"] == plan["id"] for item in self.schedules):
                    return 409, {"ok": False, "error": "schedule_already_registered"}
                job_id, revision, prompt_revision = "a" * 32, 1, 1
            else:
                old = next((item for item in self.schedules if item["jobId"] == body["jobId"]), None)
                if old is None or old["revision"] != body["expectedRevision"]:
                    return 409, {"ok": False, "error": "stale_schedule_revision"}
                if old["draftId"] != plan["id"]:
                    return 409, {"ok": False, "error": "schedule_draft_mismatch"}
                job_id, revision = old["jobId"], old["revision"] + 1
                prompt_revision = old["promptRevision"] + (prompt_hash != old["promptSha256"])
            row = {
                "jobId": job_id,
                "revision": revision,
                "draftId": plan["id"],
                "draftRevision": plan["revision"],
                "title": plan["title"],
                "date": plan["date"],
                "time": plan["time"],
                "timezone": plan["timezone"],
                "recurrence": plan["recurrence"],
                "enabled": True,
                "status": "active",
                "ownerSid": self.owner_sid,
                "executionIdentitySid": self.execution_sid,
                "principalSid": self.execution_sid,
                "promptRevision": prompt_revision,
                "promptSha256": prompt_hash,
                "missedRunPolicy": "at-most-once",
                "lastReceipt": {"verified": True},
            }
            if self.mismatch_prompt_hash:
                row["promptSha256"] = "f" * 64
            if body["action"] == "register-schedule":
                self.schedules.append(row)
            else:
                self.schedules[self.schedules.index(old)] = row
            result = {"ok": True, "requestId": request_id, "jobId": job_id,
                      "revision": revision, "status": "active", "active": True,
                      "receipt": {"verified": True}}
        elif body["action"] == "cancel-schedule":
            old = next((item for item in self.schedules if item["jobId"] == body["jobId"]), None)
            if old is None or old["revision"] != body["expectedRevision"]:
                return 409, {"ok": False, "error": "stale_schedule_revision"}
            self.schedules.remove(old)
            result = {"ok": True, "requestId": request_id, "jobId": old["jobId"],
                      "active": False, "status": "cancelled", "receipt": {"verified": True}}
        else:
            return 400, {"ok": False, "error": "unknown_action"}
        self.requests[request_id] = (fingerprint, result)
        if self.fail_get_after_post:
            self.fail_next_get = True
        return 200, result


class SchedulerControlTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.path = Path(self.temp.name) / "plans.json"
        status, result = control("POST", {
            "action": "save-draft", "title": "Morning review", "prompt": "Review the current work",
            "date": "2099-01-05", "time": "10:30", "recurrence": "weekly",
            "confirm": True, "requestId": "create_plan_0001",
        }, path=self.path)
        self.assertEqual(status, 200)
        self.plan = result["plan"]
        self.host = FakeSchedulerHost(self.path)

    def preview_hash(self, plan=None):
        plan = plan or self.plan
        status, result = control("POST", {
            "action": "activation-preview", "id": plan["id"],
            "expectedRevision": plan["revision"], "confirm": True,
            "requestId": "preview_req_0001",
        }, path=self.path)
        self.assertEqual(status, 200)
        return result["preview"]["sha256"]

    def register(self, *, request_id="register_req_0001", preview_sha=None):
        return scheduler_control("POST", {
            "action": "register-schedule", "confirm": True, "requestId": request_id,
            "draftId": self.plan["id"], "expectedDraftRevision": self.plan["revision"],
            "previewSha256": preview_sha or self.preview_hash(),
        }, host_request=self.host, path=self.path)

    def test_register_uses_only_ids_and_returns_verified_scheduler_readback(self):
        status, result = self.register()
        self.assertEqual(status, 200)
        self.assertTrue(result["readbackVerified"])
        self.assertEqual(result["schedule"]["draftRevision"], 1)
        self.assertEqual(result["schedule"]["promptRevision"], 1)
        self.assertNotIn("ownerSid", result["schedule"])
        self.assertNotIn("principalSid", result["schedule"])
        self.assertNotIn("promptSha256", result["schedule"])
        self.assertEqual(set(self.host.calls[-1]), {
            "action", "confirm", "requestId", "draftId", "expectedDraftRevision",
        })
        self.assertNotIn("prompt", self.host.calls[-1])
        self.assertNotIn("ownerSid", self.host.calls[-1])
        self.assertNotIn("runner", self.host.calls[-1])
        self.assertEqual(control("GET", path=self.path)[1]["plans"][0]["active"], False)

    def test_update_checks_new_draft_revision_and_prompt_bytes(self):
        status, registered = self.register()
        self.assertEqual(status, 200)
        updated = control("POST", {
            "action": "save-draft", "id": self.plan["id"], "expectedRevision": 1,
            "title": "Morning review v2", "prompt": "Review the latest current work",
            "date": "2099-01-05", "time": "11:00", "recurrence": "weekly",
            "confirm": True, "requestId": "edit_plan_0001",
        }, path=self.path)[1]["plan"]
        self.plan = updated
        status, result = scheduler_control("POST", {
            "action": "update-schedule", "confirm": True, "requestId": "update_req_0001",
            "jobId": registered["jobId"], "expectedRevision": registered["revision"],
            "draftId": updated["id"], "expectedDraftRevision": updated["revision"],
            "previewSha256": self.preview_hash(updated),
        }, host_request=self.host, path=self.path)
        self.assertEqual(status, 200)
        self.assertEqual(result["revision"], 2)
        self.assertEqual(result["schedule"]["promptRevision"], 2)
        self.assertEqual(result["schedule"]["date"], "2099-01-05")

    def test_duplicate_request_id_replays_identically_for_update_and_cancel(self):
        status, registered = self.register()
        self.assertEqual(status, 200)
        updated = control("POST", {
            "action": "save-draft", "id": self.plan["id"], "expectedRevision": 1,
            "title": self.plan["title"], "prompt": "Changed prompt bytes",
            "date": self.plan["date"], "time": self.plan["time"], "recurrence": self.plan["recurrence"],
            "confirm": True, "requestId": "edit_plan_0002",
        }, path=self.path)[1]["plan"]
        self.plan = updated
        request = {
            "action": "update-schedule", "confirm": True, "requestId": "update_req_0002",
            "jobId": registered["jobId"], "expectedRevision": 1, "draftId": updated["id"],
            "expectedDraftRevision": updated["revision"], "previewSha256": self.preview_hash(updated),
        }
        first_status, first = scheduler_control("POST", request, host_request=self.host, path=self.path)
        replay_status, replay = scheduler_control("POST", request, host_request=self.host, path=self.path)
        self.assertEqual((first_status, replay_status), (200, 200))
        self.assertEqual(first["jobId"], replay["jobId"])
        self.assertEqual(first["revision"], replay["revision"])
        self.assertEqual(sum(call["requestId"] == "update_req_0002" for call in self.host.calls), 2)
        cancel = {"action": "cancel-schedule", "confirm": True, "requestId": "cancel_req_0001",
                  "jobId": first["jobId"], "expectedRevision": first["revision"]}
        cancelled_status, cancelled = scheduler_control("POST", cancel, host_request=self.host, path=self.path)
        replay_cancel_status, replay_cancel = scheduler_control("POST", cancel, host_request=self.host, path=self.path)
        self.assertEqual((cancelled_status, replay_cancel_status), (200, 200))
        self.assertFalse(cancelled["active"])
        self.assertFalse(replay_cancel["active"])
        self.assertEqual(self.host.schedules, [])

    def test_stale_draft_preview_is_rejected_before_host_action(self):
        old_preview = self.preview_hash()
        control("POST", {
            "action": "save-draft", "id": self.plan["id"], "expectedRevision": 1,
            "title": self.plan["title"], "prompt": "New revision", "date": self.plan["date"],
            "time": self.plan["time"], "recurrence": self.plan["recurrence"],
            "confirm": True, "requestId": "edit_plan_0003",
        }, path=self.path)
        status, result = self.register(preview_sha=old_preview)
        self.assertEqual((status, result["error"]), (409, "draft_changed_refresh_required"))
        self.assertEqual(self.host.calls, [])

    def test_invalid_extra_client_fields_and_cross_user_readback_fail_closed(self):
        request = {
            "action": "register-schedule", "confirm": True, "requestId": "register_req_0002",
            "draftId": self.plan["id"], "expectedDraftRevision": 1,
            "previewSha256": self.preview_hash(), "prompt": "Never send this to the host",
        }
        status, result = scheduler_control("POST", request, host_request=self.host, path=self.path)
        self.assertEqual((status, result["error"]), (400, "invalid_request_fields"))
        self.host.schedules.append({
            "jobId": "b" * 32, "revision": 1, "draftId": self.plan["id"], "draftRevision": 1,
            "title": self.plan["title"], "date": self.plan["date"], "time": self.plan["time"],
            "timezone": "Pacific/Auckland", "recurrence": "weekly", "enabled": True,
            "status": "active", "ownerSid": "S-1-5-21-foreign", "executionIdentitySid": EXECUTION,
            "principalSid": EXECUTION, "promptRevision": 1, "promptSha256": "0" * 64,
            "missedRunPolicy": "at-most-once",
        })
        status, result = self.register(request_id="register_req_0003")
        self.assertEqual((status, result["error"]), (503, "scheduler_readback_unverified"))
        self.assertEqual(self.host.calls, [])

    def test_host_success_without_matching_fresh_readback_is_not_claimed_active(self):
        self.host.mismatch_prompt_hash = True
        status, result = self.register()
        self.assertEqual((status, result["error"]), (503, "schedule_activation_readback_mismatch"))
        self.assertNotIn("active", result)

    def test_scheduler_unavailable_and_interrupted_readback_remain_uncertain(self):
        self.host.fail_get_after_post = True
        status, result = self.register()
        self.assertEqual((status, result["error"]), (503, "schedule_activation_readback_unverified"))
        self.assertNotIn("active", result)


if __name__ == "__main__":
    unittest.main()
