"""Focused HTTP boundary checks; no live Ghost or scheduler is invoked."""
import unittest
from unittest.mock import patch
from io import BytesIO
from server import Handler

class Fake:
    request_origin_allowed = Handler.request_origin_allowed
    def __init__(self, headers):
        self.headers=headers
        self.status=None
        self.payload=None
        self.body_read=False
    def request_scheme(self): return 'https'
    def read_body(self):
        self.body_read=True
        return {'confirm': True, 'action':'activation-preview'}
    def send_json(self, status, payload):
        self.status=int(status); self.payload=payload

class PlanOriginTests(unittest.TestCase):
    def base(self):
        return {'Host':'dashboard.example.test', 'Origin':'https://dashboard.example.test',
                'X-Requested-With':'repoql-dashboard','X-Ghost-Control':'1',
                'Content-Type':'application/json; charset=utf-8','Sec-Fetch-Site':'same-origin'}
    def test_missing_or_forged_origin_and_content_type_refused(self):
        for key,value in [('Origin',None),('Origin','http://dashboard.example.test'),
                          ('Origin','https://foreign.test'),('Content-Type','text/plain'),
                          ('Sec-Fetch-Site','cross-site'),('X-Ghost-Control','0')]:
            with self.subTest(key=key,value=value):
                headers=self.base()
                if value is None:headers.pop(key)
                else:headers[key]=value
                fake=Fake(headers)
                Handler.serve_ghost_plans(fake,'POST')
                self.assertEqual(fake.status,403)
                self.assertFalse(fake.body_read)
    def test_valid_browser_origin_can_reach_draft_control(self):
        fake=Fake(self.base())
        with patch('ghost_schedule_plans.control',return_value=(200,{'ok':True,'executionAvailable':False})) as control:
            Handler.serve_ghost_plans(fake,'POST')
        self.assertEqual(fake.status,200)
        self.assertFalse(fake.payload['executionAvailable'])
        self.assertTrue(fake.body_read)
        control.assert_called_once()


class SchedulerOwnerBoundaryTests(unittest.TestCase):
    class Fake:
        scheduler_identity_bound = Handler.scheduler_identity_bound
        def __init__(self, peer, bearer, access=None):
            self.client_address = (peer, 1000)
            self._bearer = bearer
            self._access = access
            self.status = None
            self.payload = None
        def bearer_authorized(self): return self._bearer
        def access_identity(self): return self._access
        def send_json(self, status, payload):
            self.status = int(status)
            self.payload = payload

    def test_access_only_user_is_refused_and_does_not_inherit_process_sid(self):
        fake = self.Fake('203.0.113.25', False, {'email':'remote@example.test','sub':'access-sub'})
        Handler.serve_ghost_scheduler(fake, 'GET')
        self.assertEqual(fake.status, 403)
        self.assertEqual(fake.payload['error'], 'scheduler_owner_binding_required')

    def test_scheduler_requires_both_bearer_capability_and_loopback_peer(self):
        self.assertFalse(Handler.scheduler_identity_bound(self.Fake('127.0.0.1', False)))
        self.assertFalse(Handler.scheduler_identity_bound(self.Fake('203.0.113.25', True)))
        self.assertTrue(Handler.scheduler_identity_bound(self.Fake('127.0.0.1', True)))

    def test_scheduler_json_rejects_duplicate_keys(self):
        class Body:
            def __init__(self, raw):
                self.headers = {'Content-Length': str(len(raw))}
                self.rfile = BytesIO(raw)
        for raw in (b'{"action":"register-schedule","action":"cancel-schedule"}',
                    b'{"action":"register-schedule","details":{"jobId":"a","jobId":"b"}}'):
            with self.subTest(raw=raw), self.assertRaises(ValueError):
                Handler.read_scheduler_body(Body(raw))

if __name__=='__main__':unittest.main()
